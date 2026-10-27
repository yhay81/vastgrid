import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { createGridStore, localTransport } from "vastgrid/core";
import { XLSX_MAX_ROWS } from "vastgrid-spec/xlsx";
import { createHttpHandler } from "../src/index.ts";
import { type Client, type Json, setUp, type TableInfo, writeParquet } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;

const csv = [
  "id,name,price,day,at,flag,big",
  "1,Apple,1.5,2024-01-03,2024-01-03 08:00:00,true,9007199254740993",
  '2,=HYPERLINK("http://x"),0.25,2024-01-01,2024-01-01 12:30:00,false,2',
  "3,Cherry,12,2024-02-10,2024-02-10 23:59:59,true,3",
  "4,Durian,,2024-01-15,,,4",
  "5,Elderberry,3.75,2023-12-31,2023-12-31 00:00:01,false,5",
].join("\n");

before(async () => {
  context = await setUp({
    resolveTarget: (target) => {
      if (target.startsWith("refuse")) throw new Error("Not there.");
      return path.join(context.workspace, "out", target);
    },
  });
  client = context.client;
  workspace = context.workspace;
  await mkdir(path.join(workspace, "out"));
  await writeFile(path.join(workspace, "fruit.csv"), csv);
});

after(async () => {
  await context.tearDown();
});

/** One part of a ZIP archive, read by its central directory (independently of the writer). */
function zipPart(data: Buffer, name: string) {
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
  throw new Error(`${name} is not in the archive`);
}

function exported(info: TableInfo, members: Json) {
  return client.result<{ target: string; rows: number }>("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    ...members,
  });
}

const out = (name: string) => path.join(workspace, "out", name);

test("exports a filtered, sorted view to xlsx that the workbook reader reads back (§8.2)", async () => {
  const info = await client.open("fruit.csv");
  assert.deepEqual(info.capabilities.export, {
    formats: ["csv", "tsv", "parquet", "json", "xlsx"],
    delivery: "file",
  });
  const result = await exported(info, {
    plan: {
      where: { fn: "ne", args: [{ col: "id" }, { lit: 4 }] },
      sort: [{ column: "price", direction: "desc" }],
    },
    format: "xlsx",
    columns: ["name", "price", "day", "at", "flag", "big"],
    headers: ["Name", "Price (USD)", "Day", "At", "Flag", "Big"],
    numberFormats: [null, '"$"#,##0.00', "yyyy/mm/dd", null, null, null],
    target: "fruit.xlsx",
  });
  assert.deepEqual(result, { target: "fruit.xlsx", rows: 4 });
  const back = await client.open("out/fruit.xlsx");
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
  assert.deepEqual((await client.rows(back)).rows, [
    ["Cherry", 12, "2024-02-10", "2024-02-10 23:59:59", true, "3"],
    ["Elderberry", 3.75, "2023-12-31", "2023-12-31 00:00:01", false, "5"],
    ["Apple", 1.5, "2024-01-03", "2024-01-03 08:00:00", true, "9007199254740993"],
    // A formula-like string stays text.
    ['=HYPERLINK("http://x")', 0.25, "2024-01-01", "2024-01-01 12:30:00", false, "2"],
  ]);
  const file = await readFile(out("fruit.xlsx"));
  const styles = zipPart(file, "xl/styles.xml");
  assert.ok(styles.includes('formatCode="&quot;$&quot;#,##0.00"'), styles);
  assert.ok(styles.includes('formatCode="yyyy/mm/dd"'));
  assert.ok(styles.includes('formatCode="yyyy-mm-dd hh:mm:ss"'));
  assert.doesNotMatch(zipPart(file, "xl/worksheets/sheet1.xml"), /<f>/);
  assert.deepEqual(
    (await readdir(path.join(workspace, "out"))).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("writes numbers as their text forms: floats not finite, float32, and decimals with all their digits", async () => {
  const file = path.join(workspace, "numbers.parquet");
  await writeParquet(file, {
    columns: [
      { name: "f", type: "float" },
      { name: "f32", type: "float", bits: 32 },
      { name: "d", type: "decimal", precision: 10, scale: 2 },
      { name: "p", type: "decimal", precision: 2, scale: 2 },
      { name: "big", type: "decimal", precision: 38, scale: 4 },
    ],
    rows: [
      ["Infinity", 0.10000000149011612, "12.50", "-0.10", "1234567890123456789012345678901234.5670"],
      ["NaN", null, "-0.01", "0.05", null],
      [30, -2.5, "7.00", null, "-0.0001"],
    ],
  });
  const info = await client.open("numbers.parquet");
  await exported(info, { format: "json", target: "numbers.json" });
  // JSON has neither NaN nor Infinity, and every digit stays (DuckDB's own JSON writes NaN, 0.10000000149011612,
  // 12.5 and .05).
  assert.equal(
    await readFile(out("numbers.json"), "utf8"),
    '[\n\t{"f":"inf","f32":0.1,"d":12.50,"p":-0.10,"big":1234567890123456789012345678901234.5670},\n' +
      '\t{"f":"nan","f32":null,"d":-0.01,"p":0.05,"big":null},\n' +
      '\t{"f":30.0,"f32":-2.5,"d":7.00,"p":null,"big":-0.0001}\n]\n',
  );
  JSON.parse(await readFile(out("numbers.json"), "utf8"));
  await exported(info, { format: "csv", target: "numbers.csv" });
  assert.equal(
    await readFile(out("numbers.csv"), "utf8"),
    "f,f32,d,p,big\ninf,0.1,12.50,-0.10,1234567890123456789012345678901234.5670\nnan,,-0.01,0.05,\n30.0,-2.5,7.00,,-0.0001\n",
  );
});

test("writes the requested headers to CSV and TSV, keeps the names in Parquet and JSON, and exact values", async () => {
  const info = await client.open("fruit.csv");
  await exported(info, { format: "csv", columns: ["name", "id"], headers: ["Fruit", "Fruit"], target: "named.csv" });
  // Repeated headers stay as they are, and the rows follow.
  const lines = (await readFile(out("named.csv"), "utf8")).split("\n");
  assert.equal(lines[0], "Fruit,Fruit");
  assert.equal(lines[1], "Apple,1");
  await exported(info, { format: "tsv", columns: ["name", "id"], headers: ["A, b", "c"], target: "named.tsv" });
  assert.equal((await readFile(out("named.tsv"), "utf8")).split("\n")[0], "A, b\tc");
  await exported(info, { format: "parquet", columns: ["name"], headers: ["Fruit"], target: "named.parquet" });
  assert.equal((await client.open("out/named.parquet")).columns[0].name, "name");
  await exported(info, { format: "json", columns: ["id", "big"], target: "named.json" });
  const json = await readFile(out("named.json"), "utf8");
  assert.match(json, /"big":9007199254740993/, "the digits of a 64-bit integer stay");
  assert.deepEqual(
    (await readdir(path.join(workspace, "out"))).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("Parquet keeps intervals that compare equal as they are: 1 month is not 30 days (§2.2)", async () => {
  // DuckDB's dictionaries keep one of the values that compare equal, and intervals compare by their length
  // (§3.1): a column of both would read back as one of them.
  const spans = ["1 month", "30 days", "29 days", "1 day 02:00:00", "01:00:00", "1 year 2 months", null];
  const rows = Array.from({ length: 3_000 }, (_, row) => [row, spans[(row * 5) % spans.length], `n${row % 3}`]);
  await writeParquet(path.join(workspace, "spans.parquet"), {
    columns: [
      { name: "id", type: "integer" },
      { name: "span", type: "interval" },
      { name: "name", type: "string" },
    ],
    rows,
  });
  const info = await client.open("spans.parquet");
  for (const [index, plan] of [{}, { sort: [{ column: "name", direction: "desc" }] }].entries()) {
    await exported(info, { format: "parquet", plan, target: `spans-${index}.parquet` });
    const back = await client.open(`out/spans-${index}.parquet`);
    const read = await client.rows(back, { start: 0, end: rows.length, columns: ["id", "span"] });
    const byId = new Map(read.rows.map(([id, span]) => [id, span]));
    assert.equal(byId.size, rows.length);
    assert.deepEqual(
      rows.filter(([id, span]) => byId.get(id) !== span).slice(0, 3),
      [],
      `intervals of ${JSON.stringify(plan)} read back as written`,
    );
  }
});

test("exports read the written cells (§7.2)", async () => {
  await writeFile(path.join(workspace, "edited.csv"), "a,b\n1,x\n2,y\n");
  const info = await client.open("edited.csv");
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 1 }, column: "b", value: "changed" }],
  });
  await exported(info, { format: "csv", target: "edited.csv" });
  assert.equal(await readFile(out("edited.csv"), "utf8"), "a,b\n1,x\n2,changed\n");
  assert.equal(await readFile(path.join(workspace, "edited.csv"), "utf8"), "a,b\n1,x\n2,y\n", "the file stays");
});

test("an export of a table that is loading waits for every row (§9)", async () => {
  await writeFile(
    path.join(workspace, "loading.csv"),
    `n\n${Array.from({ length: 1_000_000 }, (_, i) => i).join("\n")}\n`,
  );
  const info = await client.result<TableInfo>("open", { ref: "loading.csv" });
  const done = await exported(info, { format: "csv", target: "loading.csv" });
  assert.equal(done.rows, 1_000_000);
  const text = await readFile(out("loading.csv"), "utf8");
  assert.equal(text.split("\n").length, 1_000_002);
  assert.ok(text.endsWith("\n999999\n"));
});

test("refuses xlsx beyond the rows of a sheet, and exports a filtered view of the same table", async () => {
  await writeFile(
    path.join(workspace, "many.csv"),
    `n\n${Array.from({ length: XLSX_MAX_ROWS }, (_, index) => index).join("\n")}\n`,
  );
  const info = await client.open("many.csv");
  assert.equal(info.rowCount, XLSX_MAX_ROWS);
  const error = await client.error("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    format: "xlsx",
    target: "many.xlsx",
  });
  assert.equal(error.code, "export_too_large");
  const where = { fn: "lt", args: [{ col: "n" }, { lit: 1000 }] };
  assert.equal((await exported(info, { plan: { where }, format: "xlsx", target: "many.xlsx" })).rows, 1000);
  const back = await client.open("out/many.xlsx");
  assert.equal(back.rowCount, 1000);

  // A cancelled export stops and leaves no file.
  const controller = new AbortController();
  const running = context.engine.handle(
    {
      v: 2,
      id: 9_001,
      op: "export",
      table: info.table,
      revision: info.revision,
      plan: { where: { fn: "gt", args: [{ col: "n" }, { lit: 0 }] } },
      format: "csv",
      target: "cancelled.csv",
    },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 5);
  assert.equal(((await running) as { error: Json }).error.code, "cancelled");
  assert.deepEqual(
    (await readdir(path.join(workspace, "out"))).filter((name) => name.includes("cancelled")),
    [],
  );
});

test("targets are where the host lets them be, never a file that a table reads", async () => {
  const info = await client.open("fruit.csv");
  for (const target of ["refuse.csv", "../fruit.csv", "../../outside.csv"]) {
    const error = await client.error("export", {
      table: info.table,
      revision: info.revision,
      plan: {},
      format: "csv",
      target,
    });
    assert.equal(error.code, "not_allowed", target);
  }
  assert.equal(await readFile(path.join(workspace, "fruit.csv"), "utf8"), csv);
});

test("without a target, the engine keeps the export, and the HTTP handler serves it", async () => {
  const kept = await setUp();
  const server = createServer(createHttpHandler(kept.engine, { path: "/api" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await writeFile(path.join(kept.workspace, "日本.csv"), "a,b\n1,x\n2,y\n");
    const info = await kept.client.open("日本.csv");
    assert.equal(
      (
        await kept.client.error("export", {
          table: info.table,
          revision: info.revision,
          plan: {},
          format: "csv",
          target: "x.csv",
        })
      ).code,
      "not_allowed",
      "an engine without resolveTarget writes no target",
    );
    const result = await kept.client.result<{ target: string; rows: number }>("export", {
      table: info.table,
      revision: info.revision,
      plan: { sort: [{ column: "a", direction: "desc" }] },
      format: "tsv",
    });
    assert.equal(result.rows, 2);
    assert.match(result.target, /^[0-9a-f]{24}\.tsv$/);
    assert.equal(kept.engine.exportFile(result.target)?.fileName, "日本.tsv");
    const response = await fetch(`http://127.0.0.1:${port}/api/exports/${result.target}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/tab-separated-values; charset=utf-8");
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="__.tsv"; filename*=UTF-8''${encodeURIComponent("日本.tsv")}`,
    );
    assert.equal(await response.text(), "a\tb\n2\ty\n1\tx\n");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/exports/missing.csv`)).status, 404);
  } finally {
    server.close();
    await kept.tearDown();
  }
});

test("the grid's export command sends the view, the labels and the formats, and the whole table", async () => {
  await writeFile(path.join(workspace, "grid.csv"), "id,price\n1,1.5\n2,0.25\n3,12\n");
  const store = createGridStore({
    transport: localTransport(context.engine),
    table: "grid.csv",
    document: {
      kind: "vastgrid/document",
      version: 2,
      plan: { where: { fn: "gt", args: [{ col: "price" }, { lit: 1 }] } },
      columns: [{ name: "price", format: { label: "Price", number: { fractionDigits: 2 } } }],
    },
  });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "price"] });
  for (let attempt = 0; attempt < 400 && store.getSnapshot().view?.rowCount !== 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const view = await store.dispatch({ command: "export", format: "xlsx", target: "grid-view.xlsx" });
  assert.deepEqual(view, { ok: true, output: { target: "grid-view.xlsx", rows: 2 } });
  const styles = zipPart(await readFile(out("grid-view.xlsx")), "xl/styles.xml");
  assert.ok(styles.includes('formatCode="#,##0.00"'), styles);
  assert.match(zipPart(await readFile(out("grid-view.xlsx")), "xl/worksheets/sheet1.xml"), />Price</);
  const table = await store.dispatch({ command: "export", format: "csv", rows: "table", target: "grid-table.csv" });
  assert.deepEqual(table, { ok: true, output: { target: "grid-table.csv", rows: 3 } });
  assert.equal(await readFile(out("grid-table.csv"), "utf8"), "Price,id\n1.5,1\n0.25,2\n12.0,3\n");
  disconnect();
});
