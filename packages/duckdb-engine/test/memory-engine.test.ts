/**
 * The memory engine of `vastgrid-js` against this engine (docs/spec.md §10): a generated table with the edges of
 * every type (NaN, the infinities, −0.0, bigints beyond 2^53, decimals of 38 digits, surrogate pairs, letters whose
 * case JavaScript maps otherwise, leap days), and generated plans that derive, filter, search, group, pivot and
 * sort. Both engines answer each plan, and their views, rows, row IDs and errors must be the same; floats may
 * differ within a relative tolerance, as conformance allows for sums (§3.8).
 *
 * The memory engine answers them twice: from the table as rows, and from the Parquet file that this engine reads.
 * Both engines also read the same Excel workbooks with the same read options (§8.2).
 *
 * The table and the plans come from `generated.ts`, from a seed, so that a run is repeatable. `VASTGRID_PLANS` sets how many (300 by
 * default) and `VASTGRID_SEED` the seed; a difference names the plan's seed and shows the plan.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { memoryEngine } from "vastgrid-js";
import { type Column, decodeBlock } from "vastgrid-spec";
import { setUp, type TableInfo, writeParquet } from "./client.ts";
import {
  answer,
  COLUMNS,
  differences,
  fieldValue,
  generateTable,
  generator,
  type Json,
  jsonRows,
  jsonValue,
  NEEDLES,
  Plans,
  records,
  type Send,
  same,
  sender,
  tablePool,
  unzip,
} from "./generated.ts";
import { cell, type FixtureWorkbook, row, writeWorkbook } from "./xlsx-fixture.ts";

const PLANS = Number(process.env.VASTGRID_PLANS ?? 300);
const SEED = Number(process.env.VASTGRID_SEED ?? 2026);

let context: Awaited<ReturnType<typeof setUp>>;
let duckdbTable: TableInfo;
let memorySend: Send;
let memoryTable: { table: string; revision: string };
let parquetSend: Send;
let parquetTable: { table: string; revision: string; columns: Column[] };

before(async () => {
  context = await setUp();
  const table = generateTable(generator(SEED));
  const file = path.join(context.workspace, "generated.parquet");
  await writeParquet(file, table);
  duckdbTable = await context.client.open(file);
  assert.equal(duckdbTable.status, "ready");
  memorySend = sender(memoryEngine({ tables: { generated: table } }));
  memoryTable = (await memorySend("open", { ref: "generated" })).result as { table: string; revision: string };
  parquetSend = sender(memoryEngine({ tables: { generated: { parquet: new Blob([await readFile(file)]) } } }));
  const opened = await parquetSend("open", { ref: "generated" });
  assert.ok(opened.result, JSON.stringify(opened.error));
  parquetTable = opened.result as typeof parquetTable;
});

after(async () => {
  await context.tearDown();
});

test("the generated table reads with the same columns and values in both engines", async () => {
  const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
  assert.deepEqual(duckdbTable.columns.map(strip), COLUMNS);
  const memory = await answer(memorySend, memoryTable, {});
  const duckdb = await answer((op, members) => context.client.send(op, members), duckdbTable, {});
  assert.deepEqual(differences(memory, duckdb), []);
  // The memory engine reads the Parquet file with the columns, source types included, that this engine reads.
  assert.deepEqual(parquetTable.columns, duckdbTable.columns);
  assert.deepEqual(differences(await answer(parquetSend, parquetTable, {}), duckdb), []);
});

test(`${PLANS} generated plans give the same answers in both engines (seed ${SEED})`, async (t) => {
  const failures: string[] = [];
  const outcomes = { rows: 0, errors: 0, known: 0 };
  const only = process.env.VASTGRID_ONLY;
  const seeds = only ? only.split(",").map(Number) : Array.from({ length: PLANS }, (_, index) => SEED * 1_000 + index);
  for (const seed of seeds) {
    const plan = new Plans(generator(seed), tablePool()).plan();
    const memory = await answer(memorySend, memoryTable, plan);
    const duckdb = await answer((op, members) => context.client.send(op, members), duckdbTable, plan);
    if (memory.error) {
      outcomes.errors++;
      if (process.env.VASTGRID_DEBUG) console.log(JSON.stringify(plan), JSON.stringify(memory.error));
    } else outcomes.rows++;
    const problems = differences(memory, duckdb);
    const parquet = differences(await answer(parquetSend, parquetTable, plan), duckdb);
    if (parquet.length > 0 && parquet[0] !== "known") problems.push(...parquet.map((problem) => `parquet: ${problem}`));
    if (only) t.diagnostic(JSON.stringify({ plan, memory, duckdb }));
    if (problems[0] === "known") outcomes.known++;
    else if (problems.length > 0) {
      failures.push(`plan ${seed}: ${JSON.stringify(plan)}\n  ${problems.join("\n  ")}`);
    }
  }
  t.diagnostic(
    `${outcomes.rows} plans answered with rows, ${outcomes.errors} with errors; ${outcomes.known} differ as KNOWN says`,
  );
  assert.equal(failures.length, 0, `${failures.length} plans differ:\n${failures.slice(0, 10).join("\n")}`);
  // The generator makes plans that run, not only plans that fail.
  if (!only) assert.ok(outcomes.rows > PLANS * 0.8, `${outcomes.rows} of ${PLANS} plans ran`);
});

// ----- find and export -----

/** The file of an export of this engine, which it keeps for the host to serve. */
async function keptFile(response: Json): Promise<Buffer> {
  assert.ok(response.result, JSON.stringify(response.error));
  const kept = context.engine.exportFile((response.result as { target: string }).target);
  assert.ok(kept);
  return readFile(kept.path);
}

test("generated plans find the same cells and export the same files in both engines", async () => {
  const duckdbSend: Send = (op, members) => context.client.send(op, members);
  const ours = { table: memoryTable.table, revision: memoryTable.revision };
  const theirs = { table: duckdbTable.table, revision: duckdbTable.revision };
  const table = new Set(COLUMNS.map((column) => column.name));
  const failures: string[] = [];
  let compared = 0;
  for (let index = 0; index < 60 && failures.length < 5; index++) {
    const seed = SEED * 1_000 + index;
    const random = generator(seed);
    const plan = new Plans(generator(seed), tablePool()).plan();
    const memory = await answer(memorySend, memoryTable, plan);
    if (memory.error || differences(memory, await answer(duckdbSend, duckdbTable, plan)).length > 0) continue;
    compared++;
    const columns = memory.columns as Column[];
    const count = memory.rowCount as number;
    // Finds in the table's own columns, whose text forms are the same in both engines; derived floats may differ
    // in their last digits.
    const own = columns.filter((column) => table.has(column.name)).map((column) => column.name);
    for (let find = 0; find < 6 && own.length > 0 && count > 0; find++) {
      const names = Array.from({ length: random.int(1, 4) }, () => random.pick(own));
      const members = {
        plan,
        text: random.pick(NEEDLES),
        columns: names,
        from: { row: random.int(0, count - 1), column: random.int(0, names.length - 1) },
        direction: random.chance(0.5) ? 1 : -1,
        ...(random.chance(0.3) ? { caseSensitive: true } : {}),
      };
      const found = await memorySend("find", { ...ours, ...members });
      const other = await duckdbSend("find", { ...theirs, ...members });
      if (JSON.stringify(found.result ?? found.error) !== JSON.stringify(other.result ?? other.error)) {
        failures.push(
          `plan ${seed}: find ${JSON.stringify(members)}\n  memory ${JSON.stringify(found.result ?? found.error)}; duckdb ${JSON.stringify(other.result ?? other.error)}`,
        );
      }
    }
    // Exports of every column of the view, which hold the same rows: CSV and TSV field by field, JSON value by value.
    for (const format of ["csv", "tsv", "json"] as const) {
      const exported = await memorySend("export", { ...ours, plan, format });
      const other = await duckdbSend("export", { ...theirs, plan, format });
      if (exported.error || other.error) {
        failures.push(`plan ${seed}: ${format}: ${JSON.stringify(exported.error ?? other.error)}`);
        continue;
      }
      const bytes = ((exported.result as Json).data as { bytes: Uint8Array }).bytes;
      const file = await keptFile(other);
      assert.equal((exported.result as Json).rows, count);
      if (format === "json") {
        const mine = jsonRows(bytes);
        const other = jsonRows(file);
        assert.equal(mine.length, other.length);
        mine.forEach((row, at) => {
          for (const column of columns) {
            const a = jsonValue(row[column.name], column);
            const b = jsonValue(other[at][column.name], column);
            if (failures.length < 5 && !same(a, b, column) && a !== b) {
              failures.push(
                `plan ${seed}: json row ${at}, ${column.name}: ${JSON.stringify(a)}; duckdb ${JSON.stringify(b)}`,
              );
            }
          }
        });
        continue;
      }
      const delimiter = format === "tsv" ? "\t" : ",";
      const mine = records(new TextDecoder().decode(bytes), delimiter);
      const lines = records(file.toString("utf8"), delimiter);
      assert.equal(mine.length, count + 1);
      assert.deepEqual(mine[0], lines[0]);
      for (let at = 1; at < mine.length && failures.length < 5; at++) {
        mine[at].forEach((text, field) => {
          const other = lines[at]?.[field];
          const column = columns[field];
          if (text !== other && !same(fieldValue(text, column), fieldValue(other ?? "", column), column)) {
            failures.push(
              `plan ${seed}: ${format} line ${at}, ${column.name}: ${JSON.stringify(text)}; duckdb ${JSON.stringify(other)}`,
            );
          }
        });
      }
    }
  }
  // Workbooks of the table: the same sheet, compressed by either engine's deflate.
  const workbook = await memorySend("export", { ...ours, plan: {}, format: "xlsx" });
  assert.ok(workbook.result, JSON.stringify(workbook.error));
  const written = await duckdbSend("export", { ...theirs, plan: {}, format: "xlsx" });
  const mine = unzip(((workbook.result as Json).data as { bytes: Uint8Array }).bytes);
  const other = unzip(await keptFile(written));
  assert.deepEqual([...mine.keys()], [...other.keys()]);
  for (const [name, text] of mine) assert.equal(text, other.get(name), name);
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(compared > 40, `${compared} plans compared`);
});

// ----- Parquet files by byte ranges -----

/** Rows `start` to `end` of a view: their row IDs and values. */
async function page(
  send: Send,
  table: { table: string; revision: string },
  plan: Json,
  start: number,
  end: number,
  columns: string[],
) {
  const response = await send("rows", { table: table.table, revision: table.revision, plan, start, end, columns });
  assert.ok(response.result, JSON.stringify(response.error));
  const result = response.result as { rowIds: number[] | null; block: { bytes: Uint8Array } };
  return { rowIds: result.rowIds, rows: decodeBlock(result.block.bytes).rows };
}

test("reads a Parquet file over HTTP by range requests, the row groups of the rows it shows", async (t) => {
  const file = path.join(context.workspace, "groups.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  // 20,000 rows in row groups of 2,048, with a column of text that does not compress.
  await connection.run(
    `COPY (SELECT i, 'w' || (i * 7919 % 1000) AS word, CAST(i % 97 AS DECIMAL(6, 2)) / 4 AS amount,
       DATE '2020-01-01' + CAST(i % 1500 AS INTEGER) AS day, CASE WHEN i % 11 = 0 THEN NULL ELSE i * 0.5 END AS half,
       md5(CAST(i AS VARCHAR)) AS padding FROM range(20000) AS t(i))
     TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 2048)`,
  );
  connection.closeSync();
  instance.closeSync();
  const bytes = await readFile(file);
  // A server of the file that answers range requests and counts the bytes it sends.
  let sent = 0;
  let etag = '"one"';
  const server = http.createServer((request, response) => {
    response.setHeader("etag", etag);
    if (request.method === "HEAD") {
      response.setHeader("content-length", bytes.length);
      response.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2]) + 1, bytes.length) : bytes.length;
    if (range) {
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end - 1}/${bytes.length}`);
    }
    sent += end - start;
    response.end(bytes.subarray(start, end));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/groups.parquet`;
  const send = sender(memoryEngine({ tables: { groups: { parquet: url, editable: true } } }));
  const opened = await send("open", { ref: "groups" });
  assert.ok(opened.result, JSON.stringify(opened.error));
  const memory = opened.result as { table: string; revision: string; columns: Column[]; rowCount: number };
  // Opening reads the footer only.
  assert.ok(sent < bytes.length / 8, `${sent} of ${bytes.length} bytes to open`);
  const duckdb = await context.client.open(file);
  assert.deepEqual(memory.columns, duckdb.columns);
  assert.equal(memory.rowCount, 20_000);
  const duckdbSend: Send = (op, members) => context.client.send(op, members);
  const shown = ["i", "word", "amount", "day", "half"];
  // Rows in the middle read the row group that holds them, of the columns they show.
  let before = sent;
  const middle = await page(send, memory, {}, 10_000, 10_100, shown);
  assert.deepEqual(middle, await page(duckdbSend, duckdb, {}, 10_000, 10_100, shown));
  assert.ok(sent - before < bytes.length / 8, `${sent - before} of ${bytes.length} bytes for 100 rows`);
  // A sort reads whole the columns it sorts by, and the rows it shows by their row groups.
  before = sent;
  const plan = {
    sort: [
      { column: "word", direction: "desc" },
      { column: "half", direction: "asc" },
    ],
  };
  for (const [start, end] of [
    [0, 100],
    [19_950, 20_000],
  ]) {
    assert.deepEqual(
      await page(send, memory, plan, start, end, shown),
      await page(duckdbSend, duckdb, plan, start, end, shown),
    );
  }
  assert.ok(sent - before < bytes.length / 2, `${sent - before} of ${bytes.length} bytes to sort`);
  const filter = {
    where: { fn: "gt", args: [{ col: "amount" }, { lit: 20 }] },
    sort: [{ column: "day", direction: "asc" }],
  };
  assert.deepEqual(
    await page(send, memory, filter, 0, 300, shown),
    await page(duckdbSend, duckdb, filter, 0, 300, shown),
  );
  // A write is kept over the file, which is not read whole for it.
  before = sent;
  const written = await send("write", {
    table: memory.table,
    revision: memory.revision,
    updates: [{ key: { rowId: 15_000 }, column: "word", value: "written", previous: "w0" }],
  });
  assert.ok(written.result, JSON.stringify(written.error));
  const after = await page(send, memory, plan, 0, 1, ["i", "word"]);
  assert.deepEqual(after.rows, [[15_000, "written"]]);
  assert.deepEqual((await page(send, memory, {}, 15_000, 15_001, ["word"])).rows, [["written"]]);
  // Columns read whole are limited by maxBytes; rows read by their row groups are not.
  const small = sender(memoryEngine({ tables: { groups: { parquet: url, maxBytes: 100_000 } } }));
  const limited = (await small("open", { ref: "groups" })).result as typeof memory;
  assert.equal((await page(small, limited, {}, 0, 3, ["padding"])).rows.length, 3);
  const refused = await small("rows", {
    table: limited.table,
    revision: limited.revision,
    plan: { sort: [{ column: "padding", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["i"],
  });
  assert.equal((refused.error as { code: string } | undefined)?.code, "load_failed");
  assert.match((refused.error as { message: string }).message, /maxBytes/);
  // Room for the integers (162,500 bytes) or the dates (82,500), not both: a column that no request reads is
  // forgotten when another request needs its room, and a request that reads both at once fails.
  const one = sender(memoryEngine({ tables: { groups: { parquet: url, maxBytes: 170_000 } } }));
  const single = (await one("open", { ref: "groups" })).result as typeof memory;
  for (const column of ["i", "day", "i"]) {
    const sort = { sort: [{ column, direction: "desc" }] };
    assert.deepEqual(
      await page(one, single, sort, 0, 5, ["i", "day"]),
      await page(duckdbSend, duckdb, sort, 0, 5, ["i", "day"]),
    );
  }
  const both = await one("rows", {
    table: single.table,
    revision: single.revision,
    plan: { sort: [{ column: "day", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["i"],
  });
  assert.ok(both.result, JSON.stringify(both.error));
  const together = await one("summarize", {
    table: single.table,
    revision: single.revision,
    plan: {},
    ranges: [[0, 20_000]],
    columns: ["i", "day"],
  });
  assert.equal((together.error as { code: string } | undefined)?.code, "load_failed");
  // A file that changes while it is open fails the reads of what was not read yet.
  etag = '"two"';
  const changed = await send("rows", {
    table: memory.table,
    revision: memory.revision,
    plan: {},
    start: 0,
    end: 10,
    columns: ["padding"],
  });
  assert.equal((changed.error as { code: string } | undefined)?.code, "file_changed");
});

/** Workbooks with every type of cell, sheets to choose, a layout that read options change, and notes. */
const WORKBOOKS: Record<string, FixtureWorkbook> = {
  "types.xlsx": {
    // Styles: 0 General, 1 date, 2 date and time, 3 time, 4 a Japanese date, 5 a percentage.
    numberFormats: [
      { id: 164, code: 'yyyy"年"m"月"d"日"' },
      { id: 165, code: "0.0%" },
    ],
    cellStyles: [0, 14, 22, 21, 164, 165],
    sharedStrings: [
      "id",
      "name",
      "price",
      "member",
      "day",
      "at",
      "time",
      "mixed",
      "formula",
      "jp",
      "rate",
      "東京",
      "x",
    ],
    sheets: [
      {
        name: "Data",
        rows: [
          row(
            1,
            Array.from({ length: 11 }, (_, index) => cell(`${String.fromCharCode(65 + index)}1`, { t: "s", v: index })),
          ),
          ...Array.from({ length: 40 }, (_, index) => {
            const at = index + 2;
            const cells = [
              cell(`A${at}`, { v: index % 7 === 3 ? 2 ** 53 + index : index }),
              cell(
                `B${at}`,
                index % 5 === 0 ? { t: "s", v: 11 + (index % 2) } : { t: "inlineStr", is: `name ${index}` },
              ),
              cell(`C${at}`, { v: index / 8 - 2 }),
              cell(`D${at}`, { t: "b", v: index % 2 }),
              cell(`E${at}`, { s: 1, v: 45306 + index * 31 }),
              cell(`F${at}`, { s: 2, v: 45306 + index / 24 }),
              cell(`G${at}`, { s: 3, v: (index % 24) / 24 }),
              cell(`H${at}`, index % 3 === 0 ? { t: "s", v: 12 } : { v: index }),
              cell(`I${at}`, index % 9 === 0 ? { f: "1/0", t: "e", v: "#DIV/0!" } : { f: `A${at}*2`, v: index * 2 }),
              cell(`J${at}`, { s: 4, v: 45306 - index }),
              cell(`K${at}`, { s: 5, v: index / 100 }),
            ];
            // Every sixth row has blank cells.
            return row(at, index % 6 === 5 ? cells.filter((_, column) => column % 2 === 0) : cells);
          }),
        ],
      },
    ],
  },
  "sheets.xlsx": {
    sharedStrings: ["name", "first", "second", "hidden"],
    chartSheet: "Chart",
    sheets: [
      {
        name: "Secret",
        state: "hidden",
        rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 3 })])],
      },
      { name: "First", rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 1 })])] },
      {
        name: "Second & more",
        rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 2 })])],
      },
    ],
  },
  "layout.xlsx": {
    sharedStrings: ["Report title", "name", "", "name", "value", "a", "b"],
    sheets: [
      {
        name: "S",
        merges: ["B1:D1"],
        rows: [
          row(1, [cell("B1", { t: "s", v: 0 })]),
          row(3, [
            cell("B3", { t: "s", v: 1 }),
            cell("C3", { t: "s", v: 2 }),
            cell("D3", { t: "s", v: 3 }),
            cell("F3", { t: "s", v: 4 }),
          ]),
          row(4, [cell("B4", { t: "s", v: 5 }), cell("D4", { v: 1 }), cell("F4", { f: "SUM(D:D)" })]),
          row(5, []),
          row(7, [cell("B7", { t: "s", v: 6 }), cell("C7", { v: 2 }), cell("F7", { v: 20 })]),
          row(9, [cell("A9", { s: 0 })]),
        ],
      },
    ],
  },
};

test("both engines read the same sheets of a workbook with the same read options", async () => {
  const cases: [string, Json | undefined][] = [
    ["types.xlsx", undefined],
    ["sheets.xlsx", undefined],
    ["sheets.xlsx", { sheet: "Second & more" }],
    ["sheets.xlsx", { sheet: "Secret", headerRow: 0 }],
    ["sheets.xlsx", { sheet: "Chart" }],
    ["layout.xlsx", undefined],
    ["layout.xlsx", { headerRow: 3 }],
    ["layout.xlsx", { headerRow: 3, keepEmptyRows: true, keepEmptyColumns: true }],
    ["layout.xlsx", { headerRow: 0, keepEmptyColumns: true }],
  ];
  const files = new Map<string, Uint8Array>();
  for (const [name, workbook] of Object.entries(WORKBOOKS)) {
    await writeWorkbook(path.join(context.workspace, name), workbook);
    files.set(name, await readFile(path.join(context.workspace, name)));
  }
  // A `File` is a workbook by its name; a `Blob` by the table's format.
  const send = sender(
    memoryEngine({
      tables: Object.fromEntries(
        [...files].map(([name, bytes], index) => [
          name,
          index % 2 === 0 ? { file: new File([bytes], name) } : { file: new Blob([bytes]), format: "xlsx" },
        ]),
      ),
    }),
  );
  for (const [name, read] of cases) {
    const label = `${name} ${JSON.stringify(read ?? {})}`;
    const duckdb = await context.client.open(name, read);
    const opened = await send("open", read === undefined ? { ref: name } : { ref: name, read });
    if (duckdb.status === "error") {
      // The memory engine reads a workbook before it answers, so a sheet it cannot read fails the open.
      const error = opened.error as { code: string; message: string };
      assert.equal(error.code, "load_failed", label);
      assert.ok(error.message.includes(duckdb.error as string), `${label}: ${error.message}`);
      continue;
    }
    assert.ok(opened.result, `${label}: ${JSON.stringify(opened.error)}`);
    const memory = opened.result as TableInfo;
    const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
    assert.deepEqual(memory.columns, duckdb.columns.map(strip), label);
    for (const member of ["sheets", "sheet", "notes"] as const) assert.deepEqual(memory[member], duckdb[member], label);
    const duckdbSend: Send = (op, members) => context.client.send(op, members);
    for (const plan of [{}, { sort: [{ column: duckdb.columns[0].name, direction: "desc" }] }]) {
      const differs = differences(await answer(send, memory, plan), await answer(duckdbSend, duckdb, plan));
      assert.deepEqual(differs, [], `${label} ${JSON.stringify(plan)}`);
    }
  }
  // Read options other than a workbook's are ignored, as before.
  const csv = sender(memoryEngine({ tables: { csv: { file: new File(["a\n1\n"], "a.csv") } } }));
  const plain = (await csv("open", { ref: "csv", read: { sheet: "Other" } })).result as TableInfo;
  assert.deepEqual(plain.columns, [{ name: "a", type: "integer" }]);
  assert.equal(plain.sheets, undefined);
});
