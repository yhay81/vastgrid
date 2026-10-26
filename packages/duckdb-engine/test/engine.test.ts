import assert from "node:assert/strict";
import { mkdir, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { planHash } from "vastgrid-spec";
import { DuckDBEngine, tableFormatOf } from "../src/index.ts";
import { type Client, type Json, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;
const events: Json[] = [];

const fruit = [
  "id,name,price,when,flag,note",
  '1,Apple,1.5,2024-01-03,true,"crisp, red"',
  '2,Banana,0.25,2024-01-01,false,"line one\nline two"',
  '3,"Cherry ""Bing""",12,2024-02-10,true,',
  "4,Durian,,2024-01-15,,smelly",
  "5,Elderberry,3.75,2023-12-31,false,dark",
].join("\n");

before(async () => {
  context = await setUp({ previewRows: 2 });
  client = context.client;
  workspace = context.workspace;
  context.engine.subscribe((event) => events.push(event));
  await writeFile(path.join(workspace, "fruit.csv"), fruit);
});

after(async () => {
  await context.tearDown();
});

/** Writes a Parquet file from a query, with an engine of its own. */
async function parquet(name: string, select: string, rowGroupSize = 122_880) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = path.join(workspace, name).replaceAll("'", "''");
    await connection.run(`COPY (${select}) TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE ${rowGroupSize})`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

const names = (info: TableInfo) => info.columns.map((column) => column.name);

test("table files are recognised by their extension", () => {
  assert.equal(tableFormatOf("a.csv.gz"), "csv");
  assert.equal(tableFormatOf("a.TAB"), "tsv");
  assert.equal(tableFormatOf("a.pq"), "parquet");
  assert.equal(tableFormatOf("a.ndjson"), "ndjson");
  assert.equal(tableFormatOf("a.json"), "json");
  assert.equal(tableFormatOf("a.txt"), null);
});

test("loads a CSV with types, quotes and line breaks (§2.1)", async () => {
  const info = await client.open("fruit.csv");
  assert.equal(info.status, "ready", info.error);
  assert.equal(info.rowCount, 5);
  assert.equal(info.readableRows, 5);
  assert.equal(info.format, "csv");
  assert.deepEqual(info.columns, [
    { name: "id", type: "bigint", sourceType: "BIGINT" },
    { name: "name", type: "string", sourceType: "VARCHAR" },
    { name: "price", type: "float", sourceType: "DOUBLE" },
    { name: "when", type: "date", sourceType: "DATE" },
    { name: "flag", type: "boolean", sourceType: "BOOLEAN" },
    { name: "note", type: "string", sourceType: "VARCHAR" },
  ]);
  const rows = await client.rows(info);
  assert.deepEqual(rows.rows, [
    [1, "Apple", 1.5, "2024-01-03", true, "crisp, red"],
    [2, "Banana", 0.25, "2024-01-01", false, "line one\nline two"],
    [3, 'Cherry "Bing"', 12, "2024-02-10", true, null],
    [4, "Durian", null, "2024-01-15", null, "smelly"],
    [5, "Elderberry", 3.75, "2023-12-31", false, "dark"],
  ]);
  assert.deepEqual(rows.rowIds, [0, 1, 2, 3, 4]);
  assert.equal(rows.view.hash, await planHash({}));
  assert.equal(rows.view.status, "ready");
  assert.equal(rows.view.rowCountExact, true);
});

test("reads BOM-marked UTF-16 CSV in either byte order", async () => {
  const text = "﻿名前,数\n東京,1\n大阪,2\n";
  for (const encoding of ["utf-16le", "utf-16be"] as const) {
    const bytes = Buffer.from(text, "utf16le");
    if (encoding === "utf-16be") bytes.swap16();
    await writeFile(path.join(workspace, `${encoding}.csv`), bytes);
    const info = await client.open(`${encoding}.csv`);
    assert.equal(info.status, "ready", info.error);
    assert.deepEqual(names(info), ["名前", "数"]);
    assert.deepEqual(info.notes, ["encoding:utf-16"]);
    assert.deepEqual((await client.rows(info)).rows, [
      ["東京", 1],
      ["大阪", 2],
    ]);
  }
});

test("converts Shift_JIS and reads TSV and JSON Lines, nested values as their text", async () => {
  await writeFile(
    path.join(workspace, "sjis.csv"),
    // "名前,数\n東京,1\n大阪,2\n" in Shift_JIS
    new Uint8Array([
      0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x90, 0x94, 0x0a, 0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x31, 0x0a, 0x91, 0xe5, 0x8d, 0xe3,
      0x2c, 0x32, 0x0a,
    ]),
  );
  const sjis = await client.open("sjis.csv");
  assert.deepEqual(sjis.notes, ["encoding:shift_jis"]);
  assert.deepEqual((await client.rows(sjis, { columns: ["名前"] })).rows, [["東京"], ["大阪"]]);

  await writeFile(path.join(workspace, "data.tsv"), "a\tb\n1\tx,y\n2\tz\n");
  const tsv = await client.open("data.tsv");
  assert.deepEqual((await client.rows(tsv, { columns: ["b"] })).rows, [["x,y"], ["z"]]);

  await writeFile(path.join(workspace, "events.jsonl"), '{"a":1,"b":{"c":[1,2]}}\n{"a":2,"b":{"c":[]}}\n');
  const json = await client.open("events.jsonl");
  assert.equal(json.rowCount, 2);
  // Structs and lists are strings holding DuckDB's text, and the engine does not write them (§2.1).
  assert.deepEqual(json.columns[1], { name: "b", type: "string", sourceType: "STRUCT(c BIGINT[])", readOnly: true });
  assert.deepEqual((await client.rows(json)).rows, [
    [1, "{'c': [1, 2]}"],
    [2, "{'c': []}"],
  ]);
});

test("reads Parquet in place, with every type as its logical type (§2.1)", async () => {
  await parquet(
    "numbers.parquet",
    `SELECT i AS n, 'row ' || i AS label, 12.34::DECIMAL(10,2) AS amount, 9007199254740993::BIGINT AS big,
      (i * 1000)::UBIGINT AS wide, (i % 100)::TINYINT AS tiny, i::UINTEGER AS uint, (i / 4)::FLOAT AS f32,
      TIMESTAMP_NS '2024-01-31 12:00:00.123456789' AS ns, TIMESTAMPTZ '2024-01-31 12:00:00+09' AS tz,
      INTERVAL 1 DAY AS span, gen_random_uuid() IS NOT NULL AS has, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::UUID AS id,
      '\\x00\\x5C'::BLOB AS bytes, [i, i + 1] AS list
    FROM range(100000) t(i)`,
    10_000,
  );
  const info = await client.open("numbers.parquet");
  assert.equal(info.status, "ready");
  assert.equal(info.rowCount, 100_000);
  assert.deepEqual(
    info.columns.map((column) => [column.name, column.type, column.sourceType]),
    [
      ["n", "bigint", "BIGINT"],
      ["label", "string", "VARCHAR"],
      ["amount", "decimal", "DECIMAL(10,2)"],
      ["big", "bigint", "BIGINT"],
      ["wide", "decimal", "UBIGINT"],
      ["tiny", "integer", "TINYINT"],
      ["uint", "bigint", "UINTEGER"],
      ["f32", "float", "FLOAT"],
      ["ns", "timestamp", "TIMESTAMP_NS"],
      ["tz", "timestamptz", "TIMESTAMP WITH TIME ZONE"],
      ["span", "interval", "INTERVAL"],
      ["has", "boolean", "BOOLEAN"],
      ["id", "uuid", "UUID"],
      ["bytes", "binary", "BLOB"],
      ["list", "string", "BIGINT[]"],
    ],
  );
  const rows = await client.rows(info, { start: 54_321, end: 54_323 });
  assert.deepEqual(rows.rowIds, [54_321, 54_322]);
  assert.deepEqual(rows.rows[0], [
    54_321,
    "row 54321",
    "12.34",
    "9007199254740993",
    "54321000",
    21,
    54_321,
    13_580.25,
    "2024-01-31 12:00:00.123456789",
    "2024-01-31 03:00:00+00",
    "1 day",
    true,
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "AFw=",
    "[54321, 54322]",
  ]);
});

test("reads the end of a large Parquet file by row IDs", async () => {
  await parquet("large.parquet", "SELECT i AS n, 'v' || i AS v FROM range(3000000) t(i)");
  const info = await client.open("large.parquet");
  const rows = await client.rows(info, { start: 2_999_998, end: 3_000_256 });
  assert.equal(rows.end, 3_000_000);
  assert.deepEqual(rows.rows, [
    [2_999_998, "v2999998"],
    [2_999_999, "v2999999"],
  ]);
  assert.deepEqual(rows.rowIds, [2_999_998, 2_999_999]);
});

test("rows stop at the row count, and a start beyond it gets no rows (§8.2)", async () => {
  const info = await client.open("fruit.csv");
  const tail = await client.rows(info, { start: 3, end: 256, columns: ["id"] });
  assert.deepEqual([tail.start, tail.end, tail.rowIds], [3, 5, [3, 4]]);
  for (const start of [5, 300]) {
    const none = await client.rows(info, { start, end: start + 256, columns: ["id", "name"] });
    assert.deepEqual([none.start, none.end, none.rowIds, none.rows], [start, start, [], []]);
  }
  const groups = await client.rows(info, {
    start: 10,
    end: 20,
    columns: ["flag"],
    plan: { aggregate: { keys: ["flag"], measures: [] } },
  });
  assert.deepEqual([groups.end, groups.rowIds], [10, null]);
});

test("rows read the plan's view: derived columns, conditions, sorts and groups (§4)", async () => {
  const info = await client.open("fruit.csv");
  const sorted = await client.rows(info, {
    columns: ["name", "double"],
    plan: {
      derive: [{ name: "double", expr: { fn: "mul", args: [{ col: "price" }, { lit: 2 }] } }],
      where: { fn: "gt", args: [{ col: "id" }, { lit: 1 }] },
      sort: [{ column: "double", direction: "desc" }],
    },
  });
  assert.deepEqual(sorted.rows, [
    ['Cherry "Bing"', 24],
    ["Elderberry", 7.5],
    ["Banana", 0.5],
    ["Durian", null],
  ]);
  assert.deepEqual(sorted.rowIds, [2, 4, 1, 3]);
  assert.equal(sorted.view.rowCount, 4);
  const derived = await client.rows(info, {
    start: 1,
    end: 3,
    columns: ["id", "label"],
    plan: { derive: [{ name: "label", expr: { fn: "concat", args: [{ col: "name" }, { lit: "!" }] } }] },
  });
  assert.deepEqual(derived.rows, [
    [2, "Banana!"],
    [3, 'Cherry "Bing"!'],
  ]);
  const groups = await client.rows(info, {
    columns: ["flag", "n"],
    plan: { aggregate: { keys: ["flag"], measures: [{ name: "n", fn: "count" }] } },
  });
  assert.deepEqual(groups.rows, [
    [false, 2],
    [true, 2],
    [null, 1],
  ]);
  assert.equal(groups.rowIds, null);
  const invalid = await client.error("rows", {
    table: info.table,
    revision: info.revision,
    plan: { sort: [{ column: "nope", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["id"],
  });
  assert.deepEqual([invalid.code, invalid.path, invalid.reason], ["invalid_plan", "/sort/0/column", "unknown_column"]);
  const column = await client.error("rows", {
    table: info.table,
    revision: info.revision,
    plan: {},
    start: 0,
    end: 1,
    columns: ["nope"],
  });
  assert.deepEqual([column.code, column.path], ["invalid_request", "/columns/0"]);
});

test("strings keep a U+FEFF at their start and are cut at textLimit (§8.4)", async () => {
  const long = "x".repeat(30);
  await writeFile(path.join(workspace, "texts.csv"), `s\nplain\n﻿marked\n${long}\n😀😀😀😀\n`);
  const info = await client.open("texts.csv");
  const rows = await client.rows(info, { textLimit: 3 });
  assert.deepEqual(rows.rows, [["pla"], ["﻿ma"], ["xxx"], ["😀😀😀"]]);
  assert.deepEqual(rows.truncated, { s: [0, 1, 2, 3] });
  const whole = await client.rows(info);
  assert.deepEqual(whole.rows, [["plain"], ["﻿marked"], [long], ["😀😀😀😀"]]);
  assert.equal(whole.truncated, undefined);
});

test("locate gives the positions of keys in a view (§8.2)", async () => {
  const info = await client.open("fruit.csv");
  const locate = async (plan: Json, keys: Json[], rowKey?: string) =>
    (
      await client.result<{ rows: (number | null)[] }>("locate", {
        table: info.table,
        revision: info.revision,
        plan,
        keys,
        ...(rowKey ? { rowKey } : {}),
      })
    ).rows;
  assert.deepEqual(await locate({}, [{ rowId: 3 }, { rowId: 9 }, { rowId: 0 }]), [3, null, 0]);
  const sort = { sort: [{ column: "price", direction: "asc" }] };
  assert.deepEqual(await locate(sort, [{ rowId: 3 }, { rowId: 1 }, { rowId: 2 }]), [4, 0, 3]);
  const where = { where: { fn: "eq", args: [{ col: "flag" }, { lit: true }] } };
  assert.deepEqual(await locate(where, [{ rowId: 2 }, { rowId: 1 }]), [1, null]);
  assert.deepEqual(await locate(sort, [{ value: 5 }, { value: "4" }, { value: 99 }], "id"), [2, 4, null]);
  const groups = { aggregate: { keys: ["flag"], measures: [] } };
  assert.deepEqual(await locate(groups, [{ rowId: 0 }, { value: true }], "flag"), [null, 1]);
});

test("summarize counts the cells that are not blank and sums the finite numbers (§8.2)", async () => {
  await writeFile(path.join(workspace, "sums.csv"), "s,x\na,1.5\n,nan\nb,inf\nc,\nd,2.5\n");
  const info = await client.open("sums.csv");
  const summarize = (ranges: number[][], columns: string[], plan: Json = {}) =>
    client.result("summarize", { table: info.table, revision: info.revision, plan, ranges, columns });
  assert.deepEqual(await summarize([[0, 5]], ["s", "x"]), {
    count: 8,
    numericCount: 2,
    sum: 4,
    min: 1.5,
    max: 2.5,
    average: 2,
  });
  assert.deepEqual(
    await summarize(
      [
        [1, 2],
        [3, 4],
      ],
      ["s"],
    ),
    { count: 1, numericCount: 0, sum: null, min: null, max: null, average: null },
  );
  const sorted = { sort: [{ column: "x", direction: "desc" }] };
  assert.deepEqual(await summarize([[0, 1]], ["x"], sorted), {
    count: 1,
    numericCount: 0,
    sum: null,
    min: null,
    max: null,
    average: null,
  });
  assert.deepEqual(await summarize([[2, 3]], ["x"], sorted), {
    count: 1,
    numericCount: 1,
    sum: 2.5,
    min: 2.5,
    max: 2.5,
    average: 2.5,
  });
});

test("find searches row by row from the cell after from, wrapping around (§8.2)", async () => {
  const info = await client.open("fruit.csv");
  const find = (from: Json, direction: 1 | -1, text: string, caseSensitive = false, plan: Json = {}) =>
    client.result("find", {
      table: info.table,
      revision: info.revision,
      plan,
      text,
      columns: ["name", "note"],
      from,
      direction,
      caseSensitive,
    });
  // Cells with an "e": (0, name), (0, note), (1, note), (2, name), (3, note), (4, name).
  assert.deepEqual(await find({ row: 0, column: 0 }, 1, "e"), { row: 0, column: 1 });
  assert.deepEqual(await find({ row: 0, column: 1 }, 1, "e"), { row: 1, column: 1 });
  assert.deepEqual(await find({ row: 1, column: 1 }, 1, "e"), { row: 2, column: 0 });
  assert.deepEqual(await find({ row: 4, column: 0 }, 1, "e"), { row: 0, column: 0 });
  assert.deepEqual(await find({ row: 0, column: 0 }, -1, "e"), { row: 4, column: 0 });
  assert.deepEqual(await find({ row: 2, column: 0 }, -1, "e"), { row: 1, column: 1 });
  assert.deepEqual(await find({ row: 0, column: 0 }, 1, "E", true), { row: 4, column: 0 });
  // The only match is the cell of from itself, which comes last.
  assert.deepEqual(await find({ row: 2, column: 0 }, 1, "bing"), { row: 2, column: 0 });
  assert.deepEqual(await find({ row: 2, column: 0 }, -1, "bing"), { row: 2, column: 0 });
  assert.equal(await find({ row: 0, column: 0 }, 1, "zzz"), null);
  assert.equal(await find({ row: 0, column: 0 }, 1, ""), null);
  const sorted = { sort: [{ column: "id", direction: "desc" }] };
  assert.deepEqual(await find({ row: 0, column: 1 }, 1, "red", false, sorted), { row: 4, column: 1 });
});

test("falls back when types change late or rows are irregular, and tells clients (§8.3)", async () => {
  const lines = ["value"];
  for (let index = 0; index < 30_000; index++) lines.push(String(index));
  lines.push("not a number");
  await writeFile(path.join(workspace, "late.csv"), lines.join("\n"));
  const opened = await client.result<TableInfo>("open", { ref: "late.csv" });
  await context.engine.whenLoaded(opened.table);
  const late = await client.result<TableInfo>("info", { table: opened.table });
  assert.equal(late.status, "ready", late.error);
  assert.equal(late.rowCount, 30_001);
  assert.deepEqual(late.columns, [{ name: "value", type: "string", sourceType: "VARCHAR" }]);
  assert.deepEqual((await client.rows(late, { start: 30_000, end: 30_001 })).rows, [["not a number"]]);
  if (opened.columns[0]?.type === "bigint") {
    // The preview read numbers: requests with its revision fail, and an event tells clients.
    assert.notEqual(late.revision, opened.revision);
    const old = await client.error("rows", {
      table: opened.table,
      revision: opened.revision,
      plan: {},
      start: 0,
      end: 1,
      columns: ["value"],
    });
    assert.equal(old.code, "revision_changed");
    assert.ok(
      events.some(
        (event) => event.event === "changed" && event.table === opened.table && event.revision === late.revision,
      ),
    );
  }

  await writeFile(path.join(workspace, "ragged.csv"), "a,b,c\n1,2,3\n4,5\n6,7,8,9\n");
  const ragged = await client.open("ragged.csv");
  assert.equal(ragged.status, "ready", ragged.error);
  assert.equal(ragged.rowCount, 3, "short and long rows are kept");
  assert.deepEqual(names(ragged), ["a", "b", "c", "column3"]);
});

test("serves the first rows while a file loads, and tells clients when it has (§9)", async () => {
  // Files load one at a time, so a small file waits behind a large one with its preview readable.
  await writeFile(
    path.join(workspace, "big.csv"),
    `n,s\n${Array.from({ length: 1_500_000 }, (_, i) => `${i},x${i}`).join("\n")}\n`,
  );
  await writeFile(path.join(workspace, "small.csv"), "x\n1\n2\n3\n");
  const big = await client.result<TableInfo>("open", { ref: "big.csv" });
  const small = await client.result<TableInfo>("open", { ref: "small.csv" });
  if (small.status === "loading") {
    assert.equal(small.rowCount, null);
    assert.equal(small.readableRows, 2);
    const preview = await client.rows(small, { end: 256 });
    assert.deepEqual(preview.rows, [[1], [2]]);
    assert.deepEqual([preview.view.status, preview.view.rowCountExact, preview.view.rowCount], ["building", false, 2]);
    const sorted = await client.error("rows", {
      table: small.table,
      revision: small.revision,
      plan: { sort: [{ column: "x", direction: "desc" }] },
      start: 0,
      end: 1,
      columns: ["x"],
    });
    assert.equal(sorted.code, "not_ready");
  }
  await context.engine.whenLoaded(small.table);
  const ready = await client.result<TableInfo>("info", { table: small.table });
  assert.deepEqual([ready.status, ready.rowCount, ready.readableRows, ready.progress], ["ready", 3, 3, 1]);
  assert.ok(
    events.some(
      (event) =>
        event.event === "progress" && event.table === small.table && event.status === "ready" && event.rowCount === 3,
    ),
  );
  // A view event tells that the view {} holds every row now (§8.5, §9).
  const views = events.filter((event) => event.event === "view" && event.table === small.table);
  assert.deepEqual(views.at(-1), {
    v: 2,
    event: "view",
    table: small.table,
    hash: await planHash({}),
    status: "ready",
    readableRows: 3,
    rowCount: 3,
    rowCountExact: true,
  });
  await context.engine.whenLoaded(big.table);
  assert.equal((await client.result<TableInfo>("info", { table: big.table })).rowCount, 1_500_000);
});

test("handles share a loaded table; a changed file is opened anew, and handles without written cells follow it (§7.6)", async () => {
  const file = path.join(workspace, "growing.csv");
  await writeFile(file, "x\n1\n2\n3\n");
  const first = await client.open("growing.csv");
  const again = await client.open("growing.csv");
  assert.notEqual(again.table, first.table);
  assert.equal(again.revision, first.revision);
  await writeFile(file, "x\n1\n2\n3\n4\n");
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const changed = await client.open("growing.csv");
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.rowCount, 4);
  // The handles opened before the change, without written cells, follow the file (§7.6).
  assert.equal(
    (
      await client.error("rows", {
        table: first.table,
        revision: first.revision,
        plan: {},
        start: 0,
        end: 10,
        columns: ["x"],
      })
    ).code,
    "revision_changed",
  );
  const followed = await client.result<TableInfo>("info", { table: first.table });
  assert.equal(followed.revision, changed.revision);
  assert.equal((await client.rows(followed)).rows.length, 4);
  await client.result("close", { table: first.table });
  assert.equal((await client.error("info", { table: first.table })).code, "table_not_found");
  assert.equal((await client.rows({ ...again, revision: changed.revision })).rows.length, 4);
  assert.deepEqual(await client.result("changes", { table: changed.table }), {
    revision: changed.revision,
    edits: { version: 0, cells: 0 },
  });
});

test("refuses files outside the allowed folders, also through links, and reports missing ones", async () => {
  const outside = path.join(context.root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.csv"), "secret\n42\n");
  // "名前,数\n東京,1\n" in Shift_JIS: the engine converts it itself, before DuckDB (which checks the folders) reads it.
  await writeFile(
    path.join(outside, "secret-sjis.csv"),
    new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x90, 0x94, 0x0a, 0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x31, 0x0a]),
  );
  await symlink(path.join(outside, "secret.csv"), path.join(workspace, "link.csv"));
  await symlink(path.join(outside, "secret-sjis.csv"), path.join(workspace, "link-sjis.csv"));
  for (const ref of [path.join(outside, "secret.csv"), "../outside/secret-sjis.csv", "link.csv", "link-sjis.csv"]) {
    assert.equal((await client.error("open", { ref })).code, "not_allowed", ref);
  }
  assert.deepEqual(await client.error("open", { ref: "missing.csv" }), {
    code: "load_failed",
    message: "The file does not exist.",
  });
  assert.equal((await client.error("open", { ref: "notes.txt" })).code, "load_failed");
  await mkdir(path.join(workspace, "folder.csv"));
  assert.equal((await client.error("open", { ref: "folder.csv" })).code, "load_failed");
});

test("a host's resolve decides what a ref names", async () => {
  const engine = await DuckDBEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(context.root, "temp-resolve"),
    threads: 1,
    resolve: (ref) => {
      if (ref.includes("..")) throw new Error("Refs stay inside the workspace.");
      return path.join(workspace, ref);
    },
  });
  try {
    const answer = (await engine.handle({ v: 2, id: 1, op: "open", ref: "../secret.csv" })) as { error: Json };
    assert.deepEqual(answer.error, { code: "not_allowed", message: "Refs stay inside the workspace." });
    const opened = (await engine.handle({ v: 2, id: 2, op: "open", ref: "fruit.csv" })) as { result: TableInfo };
    assert.equal(opened.result.status === "error", false);
  } finally {
    await engine.dispose();
  }
});

test("reports a failed load without the server's folders and SQL, and opens it again later", async () => {
  // A JSON Lines file whose last line was cut off, for example a log still being written.
  const lines = Array.from({ length: 30_000 }, (_, index) => `{"a": ${index}}`);
  await writeFile(path.join(workspace, "cut.jsonl"), `${lines.join("\n")}\n{"a": `);
  const info = await client.open("cut.jsonl");
  assert.equal(info.status, "error");
  assert.equal(info.readableRows, 0, "the preview is not offered once the load failed");
  const error = info.error ?? "";
  assert.match(error, /cut\.jsonl/);
  assert.ok(!error.includes(workspace), error);
  assert.doesNotMatch(error, /LINE \d+:|read_json/);
  const read = await client.error("rows", {
    table: info.table,
    revision: info.revision,
    plan: {},
    start: 0,
    end: 1,
    columns: ["a"],
  });
  assert.equal(read.code, "load_failed");
  const retry = await client.open("cut.jsonl");
  assert.notEqual(retry.table, info.table);
  assert.equal(retry.status, "error");
});

test("reads columns named like the ones the engine uses itself", async () => {
  await writeFile(
    path.join(workspace, "reserved.csv"),
    "rowid,vg_rowid,vg_row,name\n30,c,z,Cherry\n10,a,x,Apple\n20,b,y,Banana\n",
  );
  const info = await client.open("reserved.csv");
  assert.deepEqual(names(info), ["rowid", "vg_rowid", "vg_row", "name"]);
  assert.deepEqual((await client.rows(info)).rows, [
    [30, "c", "z", "Cherry"],
    [10, "a", "x", "Apple"],
    [20, "b", "y", "Banana"],
  ]);
  const sorted = await client.rows(info, {
    columns: ["rowid", "name"],
    plan: { sort: [{ column: "rowid", direction: "asc" }] },
  });
  assert.deepEqual(sorted.rows, [
    [10, "Apple"],
    [20, "Banana"],
    [30, "Cherry"],
  ]);
  assert.deepEqual(sorted.rowIds, [1, 2, 0]);
  // A Parquet file with a column named like DuckDB's row numbers of Parquet files is loaded as a table.
  await parquet(
    "reserved.parquet",
    "SELECT * FROM (VALUES (30, 'Cherry', 7), (10, 'Apple', 8)) t(rowid, name, file_row_number)",
  );
  const file = await client.open("reserved.parquet");
  assert.deepEqual((await client.rows(file)).rows, [
    [30, "Cherry", 7],
    [10, "Apple", 8],
  ]);
});

test("a request cancelled before it is answered is answered with cancelled (§8.6)", async () => {
  const info = await client.open("large.parquet");
  const request = {
    v: 2,
    id: 900,
    op: "rows",
    table: info.table,
    revision: info.revision,
    plan: { sort: [{ column: "v", direction: "desc" }] },
    start: 1_000_000,
    end: 1_000_256,
    columns: ["v"],
  };
  const answer = context.engine.handle(request);
  assert.equal(await context.engine.handle({ v: 2, id: 901, op: "cancel", request: 900 }), undefined);
  const cancelled = (await answer) as { id: number; error: { code: string } };
  assert.deepEqual([cancelled.id, cancelled.error.code], [900, "cancelled"]);
  const signal = AbortSignal.abort();
  const aborted = (await context.engine.handle({ ...request, id: 902 }, { signal })) as { error: { code: string } };
  assert.equal(aborted.error.code, "cancelled");
});

test("requests that do not follow §8 are answered with invalid_request", async () => {
  const answer = (message: unknown) => context.engine.handle(message) as Promise<{ id: number; error: Json }>;
  assert.deepEqual((await answer({ v: 2, id: 5, op: "query" })).error, {
    code: "invalid_request",
    message: 'There is no operation "query".',
    path: "/op",
    reason: "unknown_op",
  });
  assert.equal((await answer({ v: 1, id: 6, op: "info", table: "t1" })).error.reason, "version");
  const bad = await answer("rows");
  assert.deepEqual([bad.id, bad.error.reason], [0, "syntax"]);
  const info = await client.open("fruit.csv");
  assert.equal(
    (await client.error("rows", { table: info.table, revision: "r0", plan: {}, start: 0, end: 1, columns: ["id"] }))
      .code,
    "revision_changed",
  );
  assert.deepEqual(await client.result("write", { table: info.table, revision: info.revision, updates: [] }), {
    updated: 0,
    edits: { version: 0, cells: 0 },
  });
});

test("engines delete their session folders, also those that ended processes left", async () => {
  const base = path.join(context.root, "temp-sessions");
  await mkdir(path.join(base, "session-999999-deadbeef"), { recursive: true });
  const engine = await DuckDBEngine.create({ allowedDirectories: [workspace], tempDirectory: base, threads: 1 });
  const entries = await readdir(base);
  assert.equal(entries.includes("session-999999-deadbeef"), false, "the stale session is removed");
  assert.equal(entries.length, 1);
  await engine.dispose();
  assert.deepEqual(await readdir(base), []);
});
