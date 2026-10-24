import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { type CellValue, SourceError, XLSX_MAX_ROWS } from "vastgrid-core";
import { TableEngine } from "../src/engine.ts";
import { createTableHandler } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;

const csv = [
  "id,name,price,day,at,flag,big",
  "1,Apple,1.5,2024-01-03,2024-01-03 08:00:00,true,9007199254740993",
  '2,=HYPERLINK("http://x"),0.25,2024-01-01,2024-01-01 12:30:00,false,2',
  "3,Cherry,12,2024-02-10,2024-02-10 23:59:59,true,3",
  "4,Durian,,2024-01-15,,,4",
  "5,Elderberry,3.75,2023-12-31,2023-12-31 00:00:01,false,5",
].join("\n");

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-export-"));
  workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "out"), { recursive: true });
  await writeFile(path.join(workspace, "fruit.csv"), csv);
  await writeFile(
    path.join(workspace, "many.csv"),
    `n\n${Array.from({ length: XLSX_MAX_ROWS }, (_, index) => index).join("\n")}\n`,
  );
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function open(file: string) {
  const table = await engine.open(file);
  await table.whenReady();
  assert.equal(table.info().status, "ready", table.info().error);
  return table;
}

async function readAll(file: string) {
  const table = await open(file);
  const info = table.info();
  const block = await table.readRows({
    view: null,
    start: 0,
    end: info.rowCount ?? 0,
    columns: info.columns.map((_, index) => index),
  });
  const rows: CellValue[][] = [];
  for (let index = 0; index < (info.rowCount ?? 0); index++) rows.push(block.columns.map((values) => values[index]));
  return { columns: info.columns, rows };
}

/** One part of a ZIP archive, read by its central directory (independently of the writer). */
async function zipPart(file: string, name: string) {
  const data = await readFile(file);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = data.readUInt32LE(end + 16);
  for (let index = 0; index < data.readUInt16LE(end + 10); index++) {
    const nameLength = data.readUInt16LE(at + 28);
    const entry = data.toString("utf8", at + 46, at + 46 + nameLength);
    const offset = data.readUInt32LE(at + 42);
    const compressed = data.readUInt32LE(at + 20);
    if (entry === name) {
      const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
      const raw = data.subarray(start, start + compressed);
      return (data.readUInt16LE(at + 10) === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    }
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  throw new Error(`${name} is not in ${file}`);
}

test("exports a filtered, sorted view to xlsx that the workbook reader reads back", async () => {
  const table = await open(path.join(workspace, "fruit.csv"));
  const view = await table.createView({
    filters: [{ type: "compare", column: 0, op: "ne", value: 4 }],
    sort: [{ column: 2, direction: "desc" }],
  });
  const target = path.join(workspace, "out", "fruit.xlsx");
  const result = await table.exportView(
    {
      view: view.id,
      format: "xlsx",
      columns: [1, 2, 3, 4, 5, 6],
      headers: ["Name", "Price (USD)", "Day", "At", "Flag", "Big"],
      numberFormats: [null, '"$"#,##0.00', "yyyy/mm/dd", null, null, null],
      target: "out/fruit.xlsx",
    },
    target,
  );
  assert.deepEqual(result, { target: "out/fruit.xlsx", rows: 4 });
  const back = await readAll(target);
  assert.deepEqual(
    back.columns.map((column) => [column.name, column.type]),
    [
      ["Name", "string"],
      ["Price (USD)", "float"],
      ["Day", "date"],
      ["At", "timestamp"],
      ["Flag", "boolean"],
      // A 64-bit integer beyond 2^53 is written as text to keep its digits, so the column is text.
      ["Big", "string"],
    ],
  );
  assert.deepEqual(back.rows, [
    ["Cherry", 12, "2024-02-10", "2024-02-10 23:59:59", true, "3"],
    ["Elderberry", 3.75, "2023-12-31", "2023-12-31 00:00:01", false, "5"],
    ["Apple", 1.5, "2024-01-03", "2024-01-03 08:00:00", true, "9007199254740993"],
    // A formula-like string stays text.
    ['=HYPERLINK("http://x")', 0.25, "2024-01-01", "2024-01-01 12:30:00", false, "2"],
  ]);
  const styles = await zipPart(target, "xl/styles.xml");
  assert.ok(styles.includes('formatCode="&quot;$&quot;#,##0.00"'), styles);
  assert.ok(styles.includes('formatCode="yyyy/mm/dd"'));
  assert.ok(styles.includes('formatCode="yyyy-mm-dd hh:mm:ss"'));
  assert.doesNotMatch(await zipPart(target, "xl/worksheets/sheet1.xml"), /<f>/);
  // No temporary file is left next to it.
  assert.deepEqual(await readdir(path.join(workspace, "out")), ["fruit.xlsx"]);
});

test("writes the requested headers to CSV and keeps the names in Parquet", async () => {
  const table = await open(path.join(workspace, "fruit.csv"));
  const target = path.join(workspace, "out", "named.csv");
  await table.exportView(
    { view: null, format: "csv", columns: [1, 0], headers: ["Fruit", "Fruit"], target: "named.csv" },
    target,
  );
  // Repeated headers stay as they are, as ArraySource and xlsx write them, and the rows follow.
  const lines = (await readFile(target, "utf8")).split("\n");
  assert.equal(lines[0], "Fruit,Fruit");
  assert.equal(lines.length > 2 && !lines[1].startsWith("Fruit"), true);
  const tsv = path.join(workspace, "out", "named.tsv");
  await table.exportView(
    { view: null, format: "tsv", columns: [1, 0], headers: ["A, b", "A, b"], target: "named.tsv" },
    tsv,
  );
  assert.equal((await readFile(tsv, "utf8")).split("\n")[0], "A, b\tA, b");
  assert.deepEqual(
    (await readdir(path.join(workspace, "out"))).filter((name) => name.includes(".tmp")),
    [],
  );
  const parquet = path.join(workspace, "out", "named.parquet");
  await table.exportView({ view: null, format: "parquet", columns: [1], headers: ["Fruit"], target: "x" }, parquet);
  assert.equal((await open(parquet)).info().columns[0].name, "name");
});

test("refuses xlsx beyond the rows of a sheet, and exports a filtered view of the same table", async () => {
  const table = await open(path.join(workspace, "many.csv"));
  assert.equal(table.info().rowCount, XLSX_MAX_ROWS);
  const target = path.join(workspace, "out", "many.xlsx");
  await assert.rejects(
    table.exportView({ view: null, format: "xlsx", target: "many.xlsx" }, target),
    (error: unknown) => error instanceof SourceError && error.code === "export_too_large" && error.status === 413,
  );
  const view = await table.createView({ filters: [{ type: "compare", column: 0, op: "lt", value: 1000 }] });
  assert.equal((await table.exportView({ view: view.id, format: "xlsx", target: "many.xlsx" }, target)).rows, 1000);
  const back = await readAll(target);
  assert.equal(back.rows.length, 1000);
  assert.deepEqual(back.rows.at(-1), [999]);
});

test("cancelling an export stops it and leaves no file", async () => {
  const table = await open(path.join(workspace, "many.csv"));
  const view = await table.createView({ filters: [{ type: "compare", column: 0, op: "gt", value: 0 }] });
  const folder = path.join(workspace, "out", "cancel");
  await mkdir(folder);
  const controller = new AbortController();
  const running = table.exportView(
    { view: view.id, format: "xlsx", target: "cancel/big.xlsx" },
    path.join(folder, "big.xlsx"),
    controller.signal,
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, (error: unknown) => error instanceof SourceError && error.code === "cancelled");
  assert.deepEqual(await readdir(folder), []);
});

test("exports only inside the allowed folders", async () => {
  const table = await open(path.join(workspace, "fruit.csv"));
  await assert.rejects(
    table.exportView({ view: null, format: "xlsx", target: "x" }, path.join(root, "outside.xlsx")),
    (error: unknown) => error instanceof SourceError && error.code === "not_allowed",
  );
  assert.deepEqual((await readdir(root)).sort(), ["temp", "workspace"]);
});

test("the handler reports the export formats and passes headers and number formats", async () => {
  const options = {
    engine,
    resolve: (ref: string) => path.join(workspace, ref),
    resolveTarget: (target: string) => path.join(workspace, "out", path.basename(target)),
  };
  const post = async (handler: ReturnType<typeof createTableHandler>, body: unknown) => {
    const response = await handler(new Request("http://local/api", { method: "POST", body: JSON.stringify(body) }));
    return (await response.json()) as { result?: Record<string, unknown>; error?: { code: string } };
  };
  const handler = createTableHandler(options);
  let opened = await post(handler, { op: "info", ref: "fruit.csv" });
  await engine.get(opened.result?.table as string).whenReady();
  opened = await post(handler, { op: "info", ref: "fruit.csv" });
  assert.deepEqual(opened.result?.exports, { formats: ["csv", "tsv", "parquet", "json", "xlsx"], delivery: "file" });
  const exported = await post(handler, {
    op: "export",
    table: opened.result?.table,
    view: null,
    format: "xlsx",
    columns: [1],
    headers: ["Fruit"],
    numberFormats: [null],
    target: "../handler.xlsx",
  });
  assert.deepEqual(exported.result, { target: "../handler.xlsx", rows: 5 });
  assert.equal((await readAll(path.join(workspace, "out", "handler.xlsx"))).columns[0].name, "Fruit");
  const invalid = await post(handler, {
    op: "export",
    table: opened.result?.table,
    view: null,
    format: "xlsx",
    columns: [1],
    headers: ["a", "b"],
    target: "x.xlsx",
  });
  assert.equal(invalid.error?.code, "invalid_request");
  const closed = createTableHandler({ engine, resolve: options.resolve });
  const info = await post(closed, { op: "info", ref: "fruit.csv" });
  assert.equal((info.result?.capabilities as { export: boolean } | undefined)?.export, false);
  assert.equal(info.result?.exports, undefined);
});

test("an export of a file that changes is cancelled and leaves no file", async () => {
  const file = path.join(workspace, "changing.csv");
  await writeFile(file, csv);
  const folder = path.join(workspace, "out", "changing");
  await mkdir(folder);
  // Changed before the export ends: the export holds old data, so it is refused.
  let table = await open(file);
  await writeFile(file, `${csv}\n6,Fig,2,2024-03-01,2024-03-01 00:00:00,true,6`);
  await assert.rejects(
    table.exportView({ view: null, format: "xlsx", target: "a.xlsx" }, path.join(folder, "a.xlsx")),
    (error: unknown) => error instanceof SourceError && error.code === "cancelled" && /changed/.test(error.message),
  );
  assert.deepEqual(await readdir(folder), []);
  // Opened again while exporting (as a grid's reload does): the old table closes and stops its export.
  const big = path.join(workspace, "changing-many.csv");
  await writeFile(big, await readFile(path.join(workspace, "many.csv")));
  table = await open(big);
  const view = await table.createView({ filters: [{ type: "compare", column: 0, op: "gt", value: 0 }] });
  const running = table.exportView({ view: view.id, format: "xlsx", target: "b.xlsx" }, path.join(folder, "b.xlsx"));
  // It may end while the file is opened again below.
  const outcome = running.then(
    () => null,
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(big, "n\n1\n2\n");
  const reopened = await open(big);
  assert.equal(reopened.info().rowCount, 2);
  const error = await outcome;
  assert.ok(error instanceof SourceError && error.code === "cancelled" && /changed/.test(error.message), String(error));
  assert.deepEqual(await readdir(folder), []);
});
