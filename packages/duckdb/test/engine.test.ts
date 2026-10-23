import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CellValue } from "vastgrid-core";
import { TableEngine } from "../src/engine.ts";
import { createTableHandler } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;

const csv = [
  "id,name,price,when,flag,note",
  '1,Apple,1.5,2024-01-03,true,"crisp, red"',
  '2,Banana,0.25,2024-01-01,false,"line one\nline two"',
  '3,"Cherry ""Bing""",12,2024-02-10,true,',
  "4,Durian,,2024-01-15,,smelly",
  "5,Elderberry,3.75,2023-12-31,false,dark",
].join("\n");

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-engine-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  await writeFile(path.join(workspace, "fruit.csv"), csv);
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
    previewRows: 2,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function open(name: string) {
  const table = await engine.open(path.join(workspace, name));
  await table.whenReady();
  return table;
}

function column(values: CellValue[][], index: number) {
  return values[index];
}

test("loads a CSV with types, quotes and line breaks", async () => {
  const table = await open("fruit.csv");
  const info = table.info();
  assert.equal(info.status, "ready", info.error);
  assert.equal(info.rowCount, 5);
  assert.deepEqual(
    info.columns.map((item) => [item.name, item.type]),
    [
      ["id", "bigint"],
      ["name", "string"],
      ["price", "float"],
      ["when", "date"],
      ["flag", "boolean"],
      ["note", "string"],
    ],
  );
  const rows = await table.readRows({ view: null, start: 0, end: 10, columns: [0, 1, 2, 3, 4, 5] });
  assert.equal(rows.end, 5);
  assert.deepEqual(column(rows.columns, 0), [1, 2, 3, 4, 5]);
  assert.deepEqual(column(rows.columns, 1), ["Apple", "Banana", 'Cherry "Bing"', "Durian", "Elderberry"]);
  assert.deepEqual(column(rows.columns, 2), [1.5, 0.25, 12, null, 3.75]);
  assert.deepEqual(column(rows.columns, 3), ["2024-01-03", "2024-01-01", "2024-02-10", "2024-01-15", "2023-12-31"]);
  assert.deepEqual(column(rows.columns, 4), [true, false, true, null, false]);
  assert.equal(column(rows.columns, 5)[1], "line one\nline two");
  assert.equal(rows.rowIds, null);
});

test("sorts with blanks last and reports original rows", async () => {
  const table = await open("fruit.csv");
  const view = await table.createView({ sort: [{ column: 2, direction: "desc" }] });
  assert.equal(view.rowCount, 5);
  assert.ok(view.id);
  const rows = await table.readRows({ view: view.id, start: 0, end: 5, columns: [1, 2] });
  assert.deepEqual(column(rows.columns, 0), ['Cherry "Bing"', "Elderberry", "Apple", "Banana", "Durian"]);
  assert.deepEqual(column(rows.columns, 1), [12, 3.75, 1.5, 0.25, null]);
  assert.deepEqual(rows.rowIds, [2, 4, 0, 1, 3]);
  const again = await table.createView({ sort: [{ column: 2, direction: "desc" }] });
  assert.equal(again.id, view.id, "the same query reuses the view");
  const window = await table.readRows({ view: view.id, start: 1, end: 3, columns: [0] });
  assert.deepEqual(column(window.columns, 0), [5, 1]);
});

test("filters by values, comparisons, text, ranges and blanks", async () => {
  const table = await open("fruit.csv");
  const count = async (query: Parameters<typeof table.createView>[0]) => (await table.createView(query)).rowCount;
  assert.equal(await count({ filters: [{ type: "values", column: 1, values: ["Apple", "Durian"] }] }), 2);
  assert.equal(await count({ filters: [{ type: "values", column: 2, values: [12, null] }] }), 2);
  assert.equal(await count({ filters: [{ type: "values", column: 2, values: [12], exclude: true }] }), 4);
  assert.equal(await count({ filters: [{ type: "compare", column: 2, op: "gt", value: 1 }] }), 3);
  assert.equal(await count({ filters: [{ type: "compare", column: 0, op: "lt", value: 2.5 }] }), 2);
  assert.equal(await count({ filters: [{ type: "between", column: 3, min: "2024-01-01", max: "2024-01-31" }] }), 3);
  assert.equal(await count({ filters: [{ type: "text", column: 1, op: "contains", value: "ERR" }] }), 2);
  assert.equal(
    await count({ filters: [{ type: "text", column: 1, op: "contains", value: "ERR", caseSensitive: true }] }),
    0,
  );
  assert.equal(await count({ filters: [{ type: "text", column: 5, op: "notContains", value: "r" }] }), 3);
  assert.equal(await count({ filters: [{ type: "blank", column: 2, blank: true }] }), 1);
  assert.equal(await count({ filters: [{ type: "values", column: 4, values: [true] }] }), 2);
  assert.equal(await count({ search: "LINE TWO" }), 1);
  assert.equal(await count({ search: "2024-02" }), 1);
  await assert.rejects(
    table.createView({ filters: [{ type: "compare", column: 2, op: "gt", value: "abc" }] }),
    /Conversion/,
  );
});

test("computes statistics, distinct values, selection summaries and finds text", async () => {
  const table = await open("fruit.csv");
  const price = await table.columnStats(null, 2);
  assert.equal(price.rows, 5);
  assert.equal(price.nulls, 1);
  assert.equal(price.distinct, 4);
  assert.equal(price.min, 0.25);
  assert.equal(price.max, 12);
  assert.equal(price.mean, 4.375);
  assert.equal(
    price.histogram?.reduce((sum, bin) => sum + bin.count, 0),
    4,
  );
  const names = await table.columnStats(null, 1);
  assert.equal(names.minLength, 5);
  assert.equal(names.top?.length, 5);
  const dates = await table.columnStats(null, 3);
  assert.equal(dates.min, "2023-12-31");
  assert.equal(
    dates.histogram?.reduce((sum, bin) => sum + bin.count, 0),
    5,
  );
  const distinct = await table.distinctValues({ view: null, column: 4 });
  assert.deepEqual(
    distinct.values.map((item) => [item.value, item.count]),
    [
      [false, 2],
      [true, 2],
      [null, 1],
    ],
  );
  const searched = await table.distinctValues({ view: null, column: 1, search: "rr", limit: 1 });
  assert.equal(searched.values.length, 1);
  assert.equal(searched.truncated, true);
  const summary = await table.aggregate({ view: null, ranges: [{ start: 0, end: 3, columns: [1, 2] }] });
  assert.deepEqual(summary, { count: 6, numericCount: 3, sum: 13.75, min: 0.25, max: 12, average: 13.75 / 3 });
  const columns = [1, 5];
  assert.deepEqual(await table.find({ view: null, text: "r", columns, row: 0, column: 0, direction: 1 }), {
    row: 0,
    column: 1,
  });
  assert.deepEqual(await table.find({ view: null, text: "r", columns, row: 0, column: 1, direction: 1 }), {
    row: 2,
    column: 0,
  });
  assert.deepEqual(await table.find({ view: null, text: "apple", columns, row: 3, column: 0, direction: 1 }), {
    row: 0,
    column: 0,
  });
  assert.deepEqual(await table.find({ view: null, text: "dark", columns, row: 0, column: 0, direction: -1 }), {
    row: 4,
    column: 1,
  });
  assert.equal(await table.find({ view: null, text: "zzz", columns, row: 0, column: 0, direction: 1 }), null);
});

test("exports views inside the allowed directories only", async () => {
  const table = await open("fruit.csv");
  const view = await table.createView({ filters: [{ type: "compare", column: 2, op: "ge", value: 1 }] });
  const target = path.join(workspace, "expensive.csv");
  const result = await table.exportView(
    { view: view.id, format: "csv", columns: [1, 2], target: "expensive.csv" },
    target,
  );
  assert.equal(result.rows, 3);
  assert.equal(await readFile(target, "utf8"), 'name,price\nApple,1.5\n"Cherry ""Bing""",12.0\nElderberry,3.75\n');
  const tsv = path.join(workspace, "all.tsv");
  await table.exportView({ view: null, format: "tsv", target: "all.tsv" }, tsv);
  assert.match(await readFile(tsv, "utf8"), /^id\tname\tprice/);
  const parquet = path.join(workspace, "all.parquet");
  await table.exportView({ view: null, format: "parquet", target: "all.parquet" }, parquet);
  const copy = await open("all.parquet");
  assert.equal(copy.info().rowCount, 5);
  await assert.rejects(
    table.exportView({ view: null, format: "csv", target: "x" }, path.join(root, "outside.csv")),
    /Permission|access/i,
  );
});

test("reads Parquet in place and sorts it", async () => {
  const file = path.join(workspace, "numbers.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (SELECT i AS n, i % 7 AS bucket, 'row ' || i AS label, 12.34::DECIMAL(10,2) AS amount, 9007199254740993::BIGINT AS big FROM range(100000) t(i)) TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 10000)`,
  );
  connection.closeSync();
  instance.closeSync();
  const table = await open("numbers.parquet");
  const info = table.info();
  assert.equal(info.status, "ready");
  assert.equal(info.rowCount, 100_000);
  const rows = await table.readRows({ view: null, start: 54_321, end: 54_324, columns: [0, 2, 3, 4] });
  assert.deepEqual(column(rows.columns, 0), [54_321, 54_322, 54_323]);
  assert.deepEqual(column(rows.columns, 1), ["row 54321", "row 54322", "row 54323"]);
  assert.deepEqual(column(rows.columns, 2), ["12.34", "12.34", "12.34"]);
  assert.deepEqual(column(rows.columns, 3), ["9007199254740993", "9007199254740993", "9007199254740993"]);
  const view = await table.createView({
    sort: [
      { column: 1, direction: "desc" },
      { column: 0, direction: "asc" },
    ],
    filters: [{ type: "compare", column: 0, op: "lt", value: 20 }],
  });
  const sorted = await table.readRows({ view: view.id, start: 0, end: 4, columns: [0, 1] });
  assert.deepEqual(column(sorted.columns, 0), [6, 13, 5, 12]);
  assert.deepEqual(sorted.rowIds, [6, 13, 5, 12]);
  const big = await table.columnStats(null, 4);
  assert.equal(big.distinct, 1);
});

test("converts Shift_JIS and reads TSV and NDJSON", async () => {
  const encoded = Buffer.from(
    new Uint8Array([
      // "名前,数\n東京,1\n大阪,2\n" in Shift_JIS
      0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x90, 0x94, 0x0a, 0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x31, 0x0a, 0x91, 0xe5, 0x8d, 0xe3,
      0x2c, 0x32, 0x0a,
    ]),
  );
  await writeFile(path.join(workspace, "sjis.csv"), encoded);
  const table = await open("sjis.csv");
  const info = table.info();
  assert.equal(info.status, "ready", info.error);
  assert.deepEqual(info.notes, ["encoding:shift_jis"]);
  assert.deepEqual(
    info.columns.map((item) => item.name),
    ["名前", "数"],
  );
  const rows = await table.readRows({ view: null, start: 0, end: 2, columns: [0, 1] });
  assert.deepEqual(column(rows.columns, 0), ["東京", "大阪"]);

  await writeFile(path.join(workspace, "data.tsv"), "a\tb\n1\tx,y\n2\tz\n");
  const tsv = await open("data.tsv");
  assert.deepEqual(
    tsv.info().columns.map((item) => item.name),
    ["a", "b"],
  );
  assert.deepEqual(column((await tsv.readRows({ view: null, start: 0, end: 2, columns: [1] })).columns, 0), [
    "x,y",
    "z",
  ]);

  await writeFile(path.join(workspace, "events.jsonl"), '{"a":1,"b":{"c":[1,2]}}\n{"a":2,"b":{"c":[]}}\n');
  const json = await open("events.jsonl");
  assert.equal(json.info().rowCount, 2);
  const values = await json.readRows({ view: null, start: 0, end: 2, columns: [0, 1] });
  assert.deepEqual(column(values.columns, 0), [1, 2]);
  assert.equal(json.info().columns[1].type, "struct");
  assert.match(String(column(values.columns, 1)[0]), /c/);
});

test("falls back when types change late or rows are irregular", async () => {
  const rows = ["value"];
  for (let index = 0; index < 30_000; index++) rows.push(String(index));
  rows.push("not a number");
  await writeFile(path.join(workspace, "late.csv"), rows.join("\n"));
  const late = await open("late.csv");
  assert.equal(late.info().status, "ready", late.info().error);
  assert.equal(late.info().rowCount, 30_001);
  assert.equal(
    column((await late.readRows({ view: null, start: 30_000, end: 30_001, columns: [0] })).columns, 0)[0],
    "not a number",
  );

  await writeFile(path.join(workspace, "ragged.csv"), "a,b,c\n1,2,3\n4,5\n6,7,8,9\n");
  const ragged = await open("ragged.csv");
  assert.equal(ragged.info().status, "ready", ragged.info().error);
  assert.equal(ragged.info().rowCount, 3, "short and long rows are kept");
  assert.deepEqual(
    ragged.info().columns.map((item) => item.name),
    ["a", "b", "c", "column3"],
  );
});

test("serves a preview while loading and reopens changed files", async () => {
  const file = path.join(workspace, "growing.csv");
  await writeFile(file, "x\n1\n2\n3\n");
  const first = await engine.open(file);
  const early = first.info();
  if (early.status === "loading") {
    assert.ok(early.readableRows <= 2);
  }
  await first.whenReady();
  assert.equal(first.info().rowCount, 3);
  assert.equal((await engine.open(file)).id, first.id, "unchanged files reuse the table");
  await writeFile(file, "x\n1\n2\n3\n4\n");
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const second = await engine.open(file);
  await second.whenReady();
  assert.notEqual(second.id, first.id);
  assert.equal(second.info().rowCount, 4);
  assert.throws(() => engine.get(first.id), /no longer open/);
});

test("refuses files outside the allowed directories", async () => {
  const outside = path.join(root, "secret.csv");
  await writeFile(outside, "a\n1\n");
  const table = await engine.open(outside);
  await table.whenReady();
  assert.equal(table.info().status, "error");
  assert.match(table.info().error ?? "", /Permission|access/i);
});

test("the HTTP handler validates requests and maps errors", async () => {
  const handler = createTableHandler({
    engine,
    resolve: (ref) => {
      if (ref.includes("..")) throw new Error("refused");
      return path.join(workspace, ref);
    },
  });
  const post = async (body: unknown) => {
    const response = await handler(new Request("http://local/api", { method: "POST", body: JSON.stringify(body) }));
    return {
      status: response.status,
      body: (await response.json()) as { result?: Record<string, unknown>; error?: { code: string } },
    };
  };
  const opened = await post({ op: "info", ref: "fruit.csv" });
  assert.equal(opened.status, 200);
  const handle = opened.body.result?.table as string;
  await engine.get(handle).whenReady();
  assert.equal((opened.body.result?.capabilities as { export: boolean } | undefined)?.export, false);
  const rows = await post({ op: "rows", table: handle, view: null, start: 0, end: 1, columns: [1] });
  assert.deepEqual(rows.body.result?.columns, [["Apple"]]);
  assert.equal(
    (await post({ op: "rows", table: "nope", view: null, start: 0, end: 1, columns: [0] })).body.error?.code,
    "table_not_found",
  );
  assert.equal((await post({ op: "rows", table: handle, view: null, start: 0, end: 1, columns: [99] })).status, 400);
  assert.equal(
    (await post({ op: "view", table: handle, query: { filters: [{ type: "raw", column: 0 }] } })).status,
    400,
  );
  assert.equal((await post({ op: "export", table: handle, view: null, format: "csv", target: "x.csv" })).status, 403);
  assert.equal(
    (await post({ op: "rows", table: handle, view: "v-missing", start: 0, end: 1, columns: [0] })).body.error?.code,
    "view_not_found",
  );
  const notJson = await handler(new Request("http://local/api", { method: "POST", body: "{" }));
  assert.equal(notJson.status, 400);
  assert.equal((await handler(new Request("http://local/api"))).status, 405);
});

test("views of large tables keep only positions and still answer everything", async () => {
  const small = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp-positions"),
    memoryLimit: "1GB",
    threads: 2,
    materializeRows: 3,
  });
  try {
    const table = await small.open(path.join(workspace, "fruit.csv"));
    await table.whenReady();
    const sorted = await table.createView({ sort: [{ column: 2, direction: "desc" }] });
    const rows = await table.readRows({ view: sorted.id, start: 0, end: 5, columns: [1, 2] });
    assert.deepEqual(column(rows.columns, 0), ['Cherry "Bing"', "Elderberry", "Apple", "Banana", "Durian"]);
    assert.deepEqual(column(rows.columns, 1), [12, 3.75, 1.5, 0.25, null]);
    assert.deepEqual(rows.rowIds, [2, 4, 0, 1, 3]);
    const window = await table.readRows({ view: sorted.id, start: 1, end: 3, columns: [0] });
    assert.deepEqual(column(window.columns, 0), [5, 1]);
    const filtered = await table.createView({
      filters: [{ type: "compare", column: 2, op: "ge", value: 1 }],
      sort: [{ column: 1, direction: "asc" }],
    });
    assert.equal(filtered.rowCount, 3);
    const names = await table.readRows({ view: filtered.id, start: 0, end: 3, columns: [1] });
    assert.deepEqual(column(names.columns, 0), ["Apple", 'Cherry "Bing"', "Elderberry"]);
    const stats = await table.columnStats(filtered.id, 2);
    assert.equal(stats.rows, 3);
    assert.equal(stats.min, 1.5);
    const summary = await table.aggregate({ view: filtered.id, ranges: [{ start: 1, end: 3, columns: [2] }] });
    assert.deepEqual(summary, { count: 2, numericCount: 2, sum: 15.75, min: 3.75, max: 12, average: 7.875 });
    assert.deepEqual(
      await table.find({ view: filtered.id, text: "elder", columns: [1], row: 0, column: 0, direction: 1 }),
      {
        row: 2,
        column: 0,
      },
    );
    const target = path.join(workspace, "positions.csv");
    await table.exportView({ view: filtered.id, format: "csv", columns: [1], target: "positions.csv" }, target);
    assert.equal(await readFile(target, "utf8"), 'name\nApple\n"Cherry ""Bing"""\nElderberry\n');
  } finally {
    await small.dispose();
  }
});

test("engines delete their session files, also those left by ended processes", async () => {
  const base = path.join(root, "temp-sessions");
  const stale = path.join(base, "session-999999-deadbeef");
  await import("node:fs/promises").then((fs) => fs.mkdir(stale, { recursive: true }));
  const instance = await TableEngine.create({ allowedDirectories: [workspace], tempDirectory: base, threads: 1 });
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(base);
  assert.equal(entries.includes("session-999999-deadbeef"), false, "the stale session is removed");
  assert.equal(entries.length, 1);
  await instance.dispose();
  assert.deepEqual(await fs.readdir(base), []);
});

test("reports a failed load to clients polling it before loading the file again", async () => {
  // A JSON Lines file whose last line was cut off, for example a log still being written. Its beginning
  // reads well, so a preview is served while it loads.
  const file = path.join(workspace, "cut.jsonl");
  const lines = Array.from({ length: 30_000 }, (_, index) => `{"a": ${index}}`);
  await writeFile(file, `${lines.join("\n")}\n{"a": `);
  // Clients poll `info` while a table loads, and every `info` opens the file.
  let table = await engine.open(file);
  const first = table.id;
  for (let poll = 0; poll < 100 && table.info().status === "loading"; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    table = await engine.open(file);
  }
  assert.equal(table.info().status, "error");
  assert.equal(table.id, first, "polling does not load the file again");
  assert.equal(table.info().readableRows, 0, "the preview is not offered once the load failed");
  await assert.rejects(
    table.readRows({ view: null, start: 0, end: 1, columns: [0] }),
    (error: Error & { code?: string }) => error.code === "load_failed",
  );
  // The error names the file but not the server's folders, nor the SQL that read it.
  const error = table.info().error ?? "";
  assert.match(error, /cut\.jsonl/);
  assert.ok(!error.includes(workspace), error);
  assert.doesNotMatch(error, /LINE \d+:|read_json/);
  // Once the failure has been reported, opening the file again retries it.
  const retry = await engine.open(file);
  assert.notEqual(retry.id, first);
  await retry.whenReady();
  assert.equal(retry.info().status, "error");
});

test("errors sent to clients leave out the server's folders and SQL", async () => {
  const handler = createTableHandler({
    engine,
    resolve: (ref) => path.join(workspace, ref),
    resolveTarget: (target) => path.join(workspace, target),
  });
  const post = async (body: unknown) => {
    const response = await handler(new Request("http://local/api", { method: "POST", body: JSON.stringify(body) }));
    const { error } = (await response.json()) as { error?: { code: string; message: string } };
    return { status: response.status, code: error?.code, message: error?.message ?? "" };
  };
  const table = (await open("fruit.csv")).id;
  const notANumber = await post({
    op: "view",
    table,
    query: { filters: [{ type: "compare", column: 2, op: "gt", value: "abc" }] },
  });
  assert.equal(notANumber.status, 422);
  assert.equal(notANumber.code, "query_failed");
  assert.match(notANumber.message, /^Conversion Error: Could not convert string 'abc'/);
  assert.doesNotMatch(notANumber.message, /LINE \d+:|SELECT/);
  const missingFolder = await post({ op: "export", table, view: null, format: "csv", target: "missing/out.csv" });
  assert.equal(missingFolder.code, "query_failed");
  assert.match(missingFolder.message, /"missing\//);
  assert.ok(!missingFolder.message.includes(workspace), missingFolder.message);
});

test("view requests on one table do not cancel each other", async () => {
  const table = await open("fruit.csv");
  // Two grids, or two people, ask for different views of the same file at the same time.
  const [byName, byPrice] = await Promise.all([
    table.createView({ sort: [{ column: 1, direction: "desc" }] }),
    table.createView({ sort: [{ column: 2, direction: "desc" }] }),
  ]);
  assert.ok(byName.id && byPrice.id);
  assert.notEqual(byName.id, byPrice.id);
  // A request that waited behind a build of the same query gets that view.
  const query = { filters: [{ type: "blank" as const, column: 5, blank: false }] };
  const [first, second] = await Promise.all([table.createView(query), table.createView(query)]);
  assert.equal(first.id, second.id);
  assert.equal(first.rowCount, 4);
});

test("a view request cancelled while it waits for its turn builds nothing", async () => {
  const table = await open("fruit.csv");
  // Two long operations hold the slots for building views and statistics.
  let release = () => {};
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holders = [engine.work.run(() => busy), engine.work.run(() => busy)];
  const request = new AbortController();
  const cancelled = assert.rejects(
    table.createView({ filters: [{ type: "text", column: 1, op: "contains", value: "an" }] }, request.signal),
    (error: Error & { code?: string }) => error.code === "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  request.abort();
  release();
  await Promise.all([...holders, cancelled]);
});

test("a request cancelled while it waits for a connection runs nothing", async () => {
  // Six requests hold every pooled connection.
  let release = () => {};
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holders = Array.from({ length: 6 }, () => engine.withConnection(undefined, () => busy));
  const request = new AbortController();
  let ran = false;
  const waiting = assert.rejects(
    engine.withConnection(request.signal, async () => {
      ran = true;
    }),
    (error: Error & { code?: string }) => error.code === "cancelled",
  );
  request.abort();
  release();
  await Promise.all([...holders, waiting]);
  assert.equal(ran, false);
});

test("limits the cells one rows request reads", async () => {
  const table = await open("fruit.csv");
  await assert.rejects(
    table.readRows({ view: null, start: 0, end: 500_001, columns: [0, 1] }),
    (error: Error & { code?: string }) => error.code === "invalid_request" && /cells/.test(error.message),
  );
  const rows = await table.readRows({ view: null, start: 0, end: 500_000, columns: [0, 1] });
  assert.equal(rows.end, 5);
});

test("requests that open a changed file at the same time share one new table", async () => {
  const file = path.join(workspace, "shared.csv");
  await writeFile(file, "x\n1\n");
  const old = await open("shared.csv");
  await writeFile(file, "x\n1\n2\n");
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const [first, second] = await Promise.all([engine.open(file), engine.open(file)]);
  assert.notEqual(first.id, old.id);
  assert.equal(first.id, second.id);
  await first.whenReady();
  assert.equal(first.info().rowCount, 2);
});
