import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { RemoteSource, type TableChange } from "vastgrid-core";
import { type OpenTable, TableEngine } from "../src/engine.ts";
import { createTableHandler, handleTableRequest } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;
let readOnly: TableEngine;

const csv = [
  "id,name,price,when,flag,big",
  "1,Apple,1.50,2024-01-03,true,9007199254740993",
  '2,Banana,0.25,2024-01-01,false,"2"',
  "3,Cherry,12.00,2024-02-10,true,3",
  "4,Durian,,2024-01-15,,4",
  "5,Elderberry,3.75,2023-12-31,false,5",
].join("\n");

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-edit-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  await writeFile(path.join(workspace, "fruit.csv"), csv);
  const options = { allowedDirectories: [workspace], memoryLimit: "1GB", threads: 2 };
  engine = await TableEngine.create({ ...options, tempDirectory: path.join(root, "temp"), editable: true });
  readOnly = await TableEngine.create({ ...options, tempDirectory: path.join(root, "temp-read") });
});

after(async () => {
  await engine.dispose();
  await readOnly.dispose();
  await rm(root, { recursive: true, force: true });
});

async function open(name: string, target = engine) {
  const table = await target.open(path.join(workspace, name));
  await table.whenReady();
  return table;
}

async function values(table: OpenTable, view: string | null, columns: number[]) {
  const info = view ? table.viewInfo(view) : table.info();
  const rows = "rowCount" in info ? (info.rowCount ?? 0) : 0;
  return (await table.readRows({ view, start: 0, end: rows, columns })).columns;
}

test("tables are read-only unless the engine is editable", async () => {
  const table = await open("fruit.csv", readOnly);
  const info = table.info();
  assert.equal(info.capabilities.edit, undefined);
  assert.equal(info.edits, undefined);
  assert.ok(info.columns.every((column) => column.readOnly === undefined));
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 1, value: "x" }] }), { code: "read_only" });
});

test("written cells show in rows, views, statistics, summaries, find and exports", async () => {
  const table = await open("fruit.csv");
  const info = table.info();
  assert.equal(info.capabilities.edit, true);
  assert.deepEqual(info.edits, { version: 0, cells: 0 });
  const sorted = await table.createView({ sort: [{ column: 2, direction: "asc" }] });
  const result = await table.updateCells({
    revision: info.revision,
    updates: [
      { row: 1, column: 1, value: "Blueberry", previous: "Banana" },
      { row: 0, column: 2, value: "99.5" },
      { row: 3, column: 2, value: 0.1 },
      { row: 2, column: 4, value: null },
      { row: 4, column: 3, value: "2025/02/03" },
      { row: 0, column: 5, value: "9007199254740995" },
    ],
  });
  assert.equal(result.updated, 6);
  assert.deepEqual(result.edits, { version: 1, cells: 6 });
  assert.deepEqual(table.info().edits, { version: 1, cells: 6 });
  assert.equal(table.info().revision, info.revision, "the revision stays");
  const [names, prices, when, flags, big] = await values(table, null, [1, 2, 3, 4, 5]);
  assert.deepEqual(names, ["Apple", "Blueberry", "Cherry", "Durian", "Elderberry"]);
  assert.deepEqual(prices, [99.5, 0.25, 12, 0.1, 3.75]);
  assert.equal(when[4], "2025-02-03");
  assert.deepEqual(flags, [true, false, null, null, false]);
  assert.equal(big[0], "9007199254740995", "64-bit integers keep their digits");
  // The sorted view depended on the price column: it was dropped, and a new one sorts by the new values.
  assert.throws(() => table.viewInfo(sorted.id), { code: "view_not_found" });
  const resorted = await table.createView({ sort: [{ column: 2, direction: "asc" }] });
  assert.deepEqual((await values(table, resorted.id, [1]))[0], [
    "Durian",
    "Blueberry",
    "Elderberry",
    "Cherry",
    "Apple",
  ]);
  const filtered = await table.createView({ filters: [{ type: "text", column: 1, op: "startsWith", value: "Blue" }] });
  assert.equal(filtered.rowCount, 1);
  const where = await table.createView({
    where: {
      type: "or",
      filters: [
        { type: "compare", column: 2, op: "gt", value: 50 },
        { type: "blank", column: 4, blank: true },
      ],
    },
  });
  assert.equal(where.rowCount, 3);
  const stats = await table.columnStats(null, 2);
  assert.equal(stats.max, 99.5);
  const summary = await table.aggregate({ view: null, ranges: [{ start: 0, end: 5, columns: [2] }] });
  assert.equal(summary.sum, 99.5 + 0.25 + 12 + 0.1 + 3.75);
  assert.deepEqual(await table.find({ view: null, text: "blueb", columns: [1], row: 0, column: 0, direction: 1 }), {
    row: 1,
    column: 0,
  });
  const distinct = await table.distinctValues({ view: null, column: 1 });
  assert.ok(distinct.values.some((item) => item.value === "Blueberry"));
  const target = path.join(workspace, "edited.csv");
  await table.exportView({ view: null, format: "csv", columns: [0, 1], target: "edited.csv" }, target);
  assert.match(await readFile(target, "utf8"), /2,Blueberry/);
  // The file itself is unchanged.
  assert.equal(await readFile(path.join(workspace, "fruit.csv"), "utf8"), csv);
});

test("a write is all or nothing, and conflicts and other revisions are refused", async () => {
  await writeFile(path.join(workspace, "atomic.csv"), csv);
  const table = await open("atomic.csv");
  await assert.rejects(
    table.updateCells({
      updates: [
        { row: 0, column: 1, value: "Avocado" },
        { row: 1, column: 2, value: "cheap" },
      ],
    }),
    { code: "invalid_value" },
  );
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 4, value: "maybe" }] }), {
    code: "invalid_value",
  });
  await assert.rejects(table.updateCells({ updates: [{ row: 9, column: 1, value: "x" }] }), {
    code: "invalid_request",
  });
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 9, value: "x" }] }), {
    code: "invalid_request",
  });
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 1, value: "x", previous: "Apricot" }] }), {
    code: "edit_conflict",
  });
  await assert.rejects(table.updateCells({ revision: "other", updates: [{ row: 0, column: 1, value: "x" }] }), {
    code: "revision_changed",
  });
  assert.deepEqual(table.info().edits, { version: 0, cells: 0 });
  assert.deepEqual((await values(table, null, [1]))[0], ["Apple", "Banana", "Cherry", "Durian", "Elderberry"]);
  // Writing a cell again replaces its written value; a blank is a value too.
  await table.updateCells({ updates: [{ row: 0, column: 1, value: "A1" }] });
  await table.updateCells({ updates: [{ row: 0, column: 1, value: null, previous: "A1" }] });
  assert.deepEqual(table.info().edits, { version: 2, cells: 1 });
  assert.equal((await values(table, null, [1]))[0][0], null);
});

test("views that do not depend on the written columns stay, and positions keep naming the same rows", async () => {
  await writeFile(path.join(workspace, "positions.csv"), csv);
  const small = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp-positions"),
    memoryLimit: "1GB",
    threads: 2,
    editable: true,
    materializeRows: 1,
  });
  try {
    const table = await open("positions.csv", small);
    const byId = await table.createView({ sort: [{ column: 0, direction: "desc" }] });
    await table.updateCells({ updates: [{ row: 4, column: 1, value: "Eggplant" }] });
    // A view of positions only joins the rows when it is read: it shows the new value.
    const rows = await table.readRows({ view: byId.id, start: 0, end: 2, columns: [1] });
    assert.deepEqual(rows.columns[0], ["Eggplant", "Durian"]);
    assert.deepEqual(rows.rowIds, [4, 3]);
  } finally {
    await small.dispose();
  }
});

test("Parquet files read in place can be written too", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const file = path.join(workspace, "numbers.parquet");
  await connection.run(
    `COPY (SELECT i AS n, (i * 1.5)::DECIMAL(10,2) AS d, [i] AS list FROM range(10) t(i)) TO '${file}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();
  const table = await open("numbers.parquet");
  const info = table.info();
  assert.equal(info.columns[2].readOnly, true, "lists are read-only");
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 2, value: "[1]" }] }), { code: "read_only" });
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 1, value: "1.234" }] }), {
    code: "invalid_value",
  });
  await table.updateCells({ updates: [{ row: 9, column: 1, value: "1.5" }] });
  const view = await table.createView({ sort: [{ column: 1, direction: "asc" }] });
  const rows = await table.readRows({ view: view.id, start: 0, end: 3, columns: [0, 1] });
  assert.deepEqual(rows.columns, [
    [0, 1, 9],
    ["0.00", "1.50", "1.50"],
  ]);
});

test("a table with written cells stays open when its file changes or other tables are opened", async () => {
  const file = path.join(workspace, "kept.csv");
  await writeFile(file, csv);
  const table = await open("kept.csv");
  await table.updateCells({ updates: [{ row: 0, column: 1, value: "Kept" }] });
  await writeFile(file, `${csv}\n6,Fig,1,2024-03-01,true,6`);
  const again = await engine.open(file);
  assert.equal(again, table);
  assert.notEqual(await table.currentRevision(), table.info().revision, "the change can be told");
  for (let index = 0; index < 5; index++) {
    await writeFile(path.join(workspace, `other-${index}.csv`), "a\n1");
    await open(`other-${index}.csv`);
  }
  assert.equal(engine.get(table.id), table);
});

test("the handler writes cells, and other clients learn of them", async () => {
  await writeFile(path.join(workspace, "shared.csv"), csv);
  const options = { engine: () => engine, resolve: (ref: string) => path.join(workspace, ref) };
  const handler = createTableHandler(options);
  const fetcher = (async (_url: string, init: RequestInit) =>
    handler(new Request("http://local/api", { method: "POST", body: init.body as string }))) as typeof fetch;
  const changes: TableChange[] = [];
  const checks: (() => Promise<boolean>)[] = [];
  const watcher = new RemoteSource({
    endpoint: "/api",
    ref: "shared.csv",
    fetch: fetcher,
    changes: {
      watch: (watch) => {
        checks.push(() => watch.check());
        return () => undefined;
      },
    },
  });
  const writer = new RemoteSource({ endpoint: "/api", ref: "shared.csv", fetch: fetcher, changes: false });
  for (let wait = 0; (await watcher.info()).status !== "ready" && wait < 200; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const info = await writer.info();
  assert.equal(info.capabilities.edit, true);
  watcher.subscribe((change) => changes.push(change));
  await assert.rejects(
    handleTableRequest({ op: "update", table: "x", updates: [{ row: 0, column: 0 }] }, options),
    /value is missing/,
  );
  const result = await writer.updateCells({
    revision: info.revision,
    updates: [{ row: 0, column: 1, value: "Apricot" }],
  });
  assert.equal(result.edits.version, 1);
  assert.equal(await checks[0](), true);
  assert.deepEqual(changes, [{ edits: 1 }]);
  assert.equal(await checks[0](), false, "reported once");
  const rows = await watcher.readRows({ view: null, start: 0, end: 1, columns: [1] });
  assert.deepEqual(rows.columns[0], ["Apricot"]);
  await assert.rejects(writer.updateCells({ updates: [{ row: 0, column: 2, value: "x" }] }), { code: "invalid_value" });
});
