import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { zstdCompressSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { memoryEngine } from "vastgrid-js";
import { ARROW_MEDIA_TYPE, decodeBlock, readAttached } from "vastgrid-spec";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { zstdDecoder } from "../src/encoding.ts";
import { createHttpHandler, DuckDBEngine, tableFormatOf } from "../src/index.ts";
import { type Client, setUp, writeParquet } from "./client.ts";
import { cell, row, writeWorkbook } from "./xlsx-fixture.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;

beforeAll(async () => {
  context = await setUp({
    saveFiles: true,
    resolveTarget: (target) => path.join(workspace, target),
  });
  client = context.client;
  workspace = context.workspace;
});

afterAll(async () => {
  await context.tearDown();
});

test("recognizes compressed tab and JSON extensions", () => {
  assert.equal(tableFormatOf("rows.tab.gz"), "tsv");
  assert.equal(tableFormatOf("rows.tab.zst"), "tsv");
  assert.equal(tableFormatOf("rows.jsonl.zst"), "ndjson");
  assert.equal(tableFormatOf("rows.ndjson.zst"), "ndjson");
  assert.equal(tableFormatOf("rows.json.zst"), "json");
});

test("tempDirectory is never allowed for open or export targets, and empty allowedDirectories refuses open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vg-isolation-"));
  const temp = path.join(root, "temp");
  const allowed = path.join(root, "allowed");
  await mkdir(temp, { recursive: true });
  await mkdir(allowed, { recursive: true });
  const secret = path.join(temp, "secret.csv");
  await writeFile(secret, "a\n1\n");
  await writeFile(path.join(allowed, "ok.csv"), "a\n1\n");

  const engine = await DuckDBEngine.create({
    allowedDirectories: [allowed],
    tempDirectory: temp,
    resolve: (ref) => (ref === "secret" ? secret : path.join(allowed, ref)),
    resolveTarget: (target) => path.join(temp, target),
  });
  const local = new (client.constructor as typeof Client)(engine);
  try {
    const blockedOpen = await local.error("open", { ref: "secret" });
    assert.equal(blockedOpen.code, "not_allowed");
    const info = await local.open("ok.csv");
    const blockedExport = await local.error("export", {
      table: info.table,
      revision: info.revision,
      plan: {},
      format: "csv",
      target: "leak.csv",
    });
    assert.equal(blockedExport.code, "not_allowed");
  } finally {
    await engine.dispose();
  }

  const none = await DuckDBEngine.create({
    allowedDirectories: [],
    tempDirectory: temp,
  });
  try {
    const answer = await none.handle({ v: 2, id: 1, op: "open", ref: "ok.csv" });
    assert.equal((answer as { error: { code: string } }).error.code, "not_allowed");
  } finally {
    await none.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves leading U+FEFF in column names, database table names, pivots, writes and saves", async () => {
  await writeFile(path.join(workspace, "bom-cols.csv"), `"x","\uFEFFcol"\n1,"\uFEFFval"\n`);
  const info = await client.open("bom-cols.csv", { headerRow: 1 });
  assert.deepEqual(
    info.columns.map((column) => column.name),
    ["x", "\uFEFFcol"],
  );
  const pivoted = await client.rows(info, {
    plan: {
      aggregate: {
        keys: ["x"],
        measures: [{ name: "n", fn: "count" }],
        pivot: { columns: ["\uFEFFcol"] },
      },
    },
    columns: ["x", "\uFEFFval / n"],
  });
  assert.deepEqual(pivoted.view.columns[1].pivot, { values: ["\uFEFFval"], measure: "n" });
  assert.deepEqual(pivoted.rows, [[1, 1]]);

  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 0 }, column: "\uFEFFcol", value: "\uFEFFedited" }],
  });
  await client.result("save", { table: info.table });
  assert.equal(await readFile(path.join(workspace, "bom-cols.csv"), "utf8"), `"x","\uFEFFcol"\n1,\uFEFFedited\n`);

  const dbPath = path.join(workspace, "bom.duckdb");
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(`CREATE TABLE "\uFEFFitems" ("\uFEFFid" INTEGER); INSERT INTO "\uFEFFitems" VALUES (7)`);
  connection.closeSync();
  instance.closeSync();

  const dbInfo = await client.open("bom.duckdb");
  assert.equal(dbInfo.sheet, "\uFEFFitems");
  assert.deepEqual(dbInfo.sheets, [{ name: "\uFEFFitems" }]);
  assert.deepEqual(
    dbInfo.columns.map((column) => column.name),
    ["\uFEFFid"],
  );
  assert.deepEqual((await client.rows(dbInfo)).rows, [[7]]);
});

test("disambiguates columns whose names differ only in letter case across reads, plans, writes and exports", async () => {
  await writeWorkbook(path.join(workspace, "cased.xlsx"), {
    sharedStrings: ["a", "A"],
    sheets: [
      {
        name: "Sheet1",
        rows: [
          row(1, [cell("A1", { t: "s", v: 0 }), cell("B1", { t: "s", v: 1 })]),
          row(2, [cell("A2", { v: 10 }), cell("B2", { v: 20 })]),
          row(3, [cell("A3", { v: 30 }), cell("B3", { v: 40 })]),
        ],
      },
    ],
  });
  const xlsxInfo = await client.open("cased.xlsx");
  assert.deepEqual(
    xlsxInfo.columns.map((column) => column.name),
    ["a", "A"],
  );
  assert.deepEqual((await client.rows(xlsxInfo)).rows, [
    [10, 20],
    [30, 40],
  ]);

  const derived = await client.rows(xlsxInfo, {
    plan: {
      derive: [
        { name: "b", expr: { fn: "add", args: [{ col: "a" }, { lit: 1 }] } },
        { name: "B", expr: { fn: "add", args: [{ col: "A" }, { lit: 2 }] } },
      ],
      sort: [{ column: "B", direction: "desc" }],
    },
    columns: ["a", "A", "b", "B"],
  });
  assert.deepEqual(derived.rows, [
    [30, 40, 31, 42],
    [10, 20, 11, 22],
  ]);

  await client.result("write", {
    table: xlsxInfo.table,
    revision: xlsxInfo.revision,
    updates: [{ key: { rowId: 0 }, column: "A", value: 99, previous: 20 }],
  });
  assert.deepEqual((await client.rows(xlsxInfo)).rows, [
    [10, 99],
    [30, 40],
  ]);

  await client.result("export", {
    table: xlsxInfo.table,
    revision: xlsxInfo.revision,
    plan: {},
    format: "csv",
    target: "cased-out.csv",
  });
  assert.equal(await readFile(path.join(workspace, "cased-out.csv"), "utf8"), "a,A\n10,99\n30,40\n");

  const file = path.join(workspace, "cased-out.parquet");
  await client.result("export", {
    table: xlsxInfo.table,
    revision: xlsxInfo.revision,
    plan: {},
    format: "parquet",
    target: "cased-out.parquet",
  });
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    assert.deepEqual((await conn.runAndReadAll("SELECT name FROM parquet_schema($1)", [file])).getRowsJS().slice(1), [
      ["a"],
      ["A"],
    ]);
    assert.deepEqual((await conn.runAndReadAll("SELECT * FROM read_parquet($1)", [file])).getRowsJS(), [
      [10n, 99n],
      [30n, 40n],
    ]);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

test("validates locate rowKey, measure shadowing, export header lengths, non-rounding keys and -0 float writes", async () => {
  await writeParquet(path.join(workspace, "precise.parquet"), {
    columns: [
      { name: "d", type: "decimal", precision: 4, scale: 2 },
      { name: "f", type: "float", bits: 64 },
      { name: "k", type: "string" },
    ],
    rows: [
      ["1.23", 1, "x"],
      ["4.56", 2, "x"],
    ],
  });
  const info = await client.open("precise.parquet");

  const missingRowKey = await client.error("locate", {
    table: info.table,
    revision: info.revision,
    plan: {},
    keys: [{ value: "1.23" }],
  });
  assert.deepEqual([missingRowKey.code, missingRowKey.path], ["invalid_request", "/rowKey"]);

  const badRowKey = await client.error("locate", {
    table: info.table,
    revision: info.revision,
    plan: {},
    keys: [],
    rowKey: "unknown",
  });
  assert.deepEqual([badRowKey.code, badRowKey.path], ["invalid_request", "/rowKey"]);

  // "1.234" does not round to "1.23", while "1.230" equals "1.23" (§3.1).
  const located = await client.result<{ rows: (number | null)[] }>("locate", {
    table: info.table,
    revision: info.revision,
    plan: {},
    keys: [{ value: "1.234" }, { value: "1.230" }],
    rowKey: "d",
  });
  assert.deepEqual(located.rows, [null, 0]);

  // A measure reusing a non-key table column name must not be matched by rowKey in grouped views.
  const shadowed = await client.result<{ rows: (number | null)[] }>("locate", {
    table: info.table,
    revision: info.revision,
    plan: {
      aggregate: {
        keys: ["k"],
        measures: [{ name: "f", fn: "count" }],
      },
    },
    keys: [{ value: 2 }],
    rowKey: "f",
  });
  assert.deepEqual(shadowed.rows, [null]);

  const badHeaders = await client.error("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    format: "csv",
    headers: ["only-one"],
  });
  assert.deepEqual([badHeaders.code, badHeaders.path], ["invalid_request", "/headers"]);

  // Write rejects non-exact decimal rowKey ("1.234") without rounding, preserves -0.0, and checks updates in order.
  const conflictOrder = await client.error("write", {
    table: info.table,
    revision: info.revision,
    updates: [
      { key: { rowId: 0 }, column: "f", value: 10, previous: 999 },
      { key: { rowId: 99 }, column: "f", value: 20 },
    ],
  });
  assert.equal(conflictOrder.code, "edit_conflict");
  assert.deepEqual((conflictOrder as { details?: unknown }).details, { update: 0 });

  const nonExactWrite = await client.error("write", {
    table: info.table,
    revision: info.revision,
    rowKey: "d",
    updates: [{ key: { value: "1.234" }, column: "f", value: 10 }],
  });
  assert.equal(nonExactWrite.code, "edit_conflict");

  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 0 }, column: "f", value: -0 }],
  });
  const afterNegZero = await client.rows(info, { end: 1, columns: ["f"] });
  assert.ok(Object.is(afterNegZero.rows[0][0], -0));
});

test("saves CSV files with quotes in skipped header-preamble lines, leading spaces before quotes, and ISO infinity dates", async () => {
  const skipped = '# unclosed "quote in preamble\na,b\n1, "x,y"\n2,plain\n';
  await writeFile(path.join(workspace, "skipped.csv"), skipped);
  const info = await client.open("skipped.csv", { headerRow: 2 });
  assert.deepEqual((await client.rows(info)).rows, [
    [1, "x,y"],
    [2, "plain"],
  ]);
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 0 }, column: "a", value: 10 }],
  });
  await client.result("save", { table: info.table });
  assert.equal(
    await readFile(path.join(workspace, "skipped.csv"), "utf8"),
    '# unclosed "quote in preamble\na,b\n10, "x,y"\n2,plain\n',
  );

  await writeFile(path.join(workspace, "iso-dates.csv"), "id,d\n1,2024-01-02\n2,2024-03-04\n");
  const dateInfo = await client.open("iso-dates.csv");
  await client.result("write", {
    table: dateInfo.table,
    revision: dateInfo.revision,
    updates: [{ key: { rowId: 0 }, column: "d", value: "infinity" }],
  });
  await client.result("save", { table: dateInfo.table });
  const reopened = await client.open("iso-dates.csv");
  assert.equal(reopened.columns[1].type, "date");
  assert.deepEqual((await client.rows(reopened)).rows, [
    [1, "infinity"],
    [2, "2024-03-04"],
  ]);
});

test("HTTP handler rejects invalid UTF-8 with 400 and frames Arrow attached blocks without corrupting bytes", async () => {
  await writeFile(path.join(workspace, "http-check.csv"), "a,b\n1,hello\n");
  const info = await client.open("http-check.csv");
  const server = createServer(createHttpHandler(context.engine, { path: "/api" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const badUtf8 = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff, 0xfe]),
    });
    assert.equal(badUtf8.status, 400);
    const badJson = (await badUtf8.json()) as { id: null; error: { code: string } };
    assert.equal(badJson.id, null);
    assert.equal(badJson.error.code, "invalid_request");

    const arrowRes = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ARROW_MEDIA_TYPE },
      body: JSON.stringify({
        v: 2,
        id: 42,
        op: "rows",
        table: info.table,
        revision: info.revision,
        plan: {},
        start: 0,
        end: 1,
        columns: ["a", "b"],
      }),
    });
    assert.equal(arrowRes.status, 200);
    assert.equal(arrowRes.headers.get("content-type"), ARROW_MEDIA_TYPE);
    const decoded = readAttached(new Uint8Array(await arrowRes.arrayBuffer()));
    assert.equal(decoded.id, 42);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("memoryEngine Parquet reader matches DuckDB on BOM strings and nested LIST, STRUCT, MAP, DATE and DECIMAL", async () => {
  const file = path.join(workspace, "nested-bom.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (
      SELECT
        chr(65279) || 'bom' AS s,
        [DATE '2020-01-02', NULL] AS dates,
        [CAST(1.25 AS DECIMAL(6, 2)), CAST(-3.50 AS DECIMAL(6, 2))] AS decs,
        {a: 1, b: 'hi', c: 'x,y', d: CAST(NULL AS INTEGER)} AS st,
        MAP {'k': 10, 'x y': 20} AS mp,
        MAP {false: 10, true: 20} AS flags
    ) TO '${file.replaceAll("'", "''")}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();

  const duckdbInfo = await client.open("nested-bom.parquet");
  const duckdbRows = await client.rows(duckdbInfo);
  const mem = memoryEngine({ tables: { t: { parquet: new Blob([await readFile(file)]) } } });
  const openRes = (await mem.handle({ v: 2, id: 1, op: "open", ref: "t" })) as {
    result: { table: string; revision: string; columns: typeof duckdbInfo.columns };
  };
  assert.deepEqual(openRes.result.columns, duckdbInfo.columns);
  const rowsRes = (await mem.handle({
    v: 2,
    id: 2,
    op: "rows",
    table: openRes.result.table,
    revision: openRes.result.revision,
    plan: {},
    start: 0,
    end: 10,
    columns: openRes.result.columns.map((c) => c.name),
  })) as { result: { block: { bytes: Uint8Array } } };
  assert.deepEqual(decodeBlock(rowsRes.result.block.bytes).rows, duckdbRows.rows);
});

test("write stages in-batch updates sequentially, rejects { value } without rowKey, and preserves ragged all-null CSV rows on save", async () => {
  await writeFile(path.join(workspace, "batch-edit.csv"), "id,name\n1,Alice\n2,Bob\n");
  const info = await client.open("batch-edit.csv");

  const noRowKey = await client.error("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { value: 1 }, column: "name", value: "Eve" }],
  });
  assert.deepEqual([noRowKey.code, noRowKey.path], ["invalid_request", "/rowKey"]);

  const batch = await client.result("write", {
    table: info.table,
    revision: info.revision,
    rowKey: "id",
    updates: [
      { key: { value: 1 }, column: "name", value: "Alicia", previous: "Alice" },
      { key: { value: 1 }, column: "name", value: "Ally", previous: "Alicia" },
      { key: { value: 1 }, column: "id", value: 10, previous: 1 },
      { key: { value: 10 }, column: "name", value: "A.", previous: "Ally" },
    ],
  });
  assert.deepEqual(batch, { updated: 4, edits: { version: 1, cells: 2 } });
  assert.deepEqual((await client.rows(info)).rows[0], [10, "A."]);

  await writeFile(path.join(workspace, "ragged-null.csv"), "a,b\n1\n2,x\n");
  const ragged = await client.open("ragged-null.csv");
  await client.result("write", {
    table: ragged.table,
    revision: ragged.revision,
    updates: [{ key: { rowId: 0 }, column: "a", value: null }],
  });
  await client.result("save", { table: ragged.table });
  const reopened = await client.open("ragged-null.csv");
  assert.deepEqual((await client.rows(reopened)).rows, [
    [null, null],
    [2, "x"],
  ]);
});

test("export target rejects directories and symlinks escaping allowedDirectories", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "vg-outside-"));
  const sub = path.join(workspace, "existing-dir");
  await mkdir(sub, { recursive: true });
  const escapeLink = path.join(workspace, "escape-out.csv");
  await writeFile(path.join(outside, "victim.csv"), "secret\n");
  await symlink(path.join(outside, "victim.csv"), escapeLink);
  await writeFile(path.join(workspace, "src-export.csv"), "a\n1\n");
  try {
    const info = await client.open("src-export.csv");
    const dirErr = await client.error("export", {
      table: info.table,
      revision: info.revision,
      plan: {},
      format: "csv",
      target: "existing-dir",
    });
    assert.equal(dirErr.code, "not_allowed");

    const linkErr = await client.error("export", {
      table: info.table,
      revision: info.revision,
      plan: {},
      format: "csv",
      target: "escape-out.csv",
    });
    assert.equal(linkErr.code, "not_allowed");
    assert.equal(await readFile(path.join(outside, "victim.csv"), "utf8"), "secret\n");

    await symlink(path.join(outside, "missing.csv"), path.join(workspace, "dangling-out.csv"));
    const danglingErr = await client.error("export", {
      table: info.table,
      revision: info.revision,
      plan: {},
      format: "csv",
      target: "dangling-out.csv",
    });
    assert.equal(danglingErr.code, "not_allowed");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("fzstd fallback decodes zstd streams, Parquet with file_row_number loads cleanly, CSV custom-date saves work, and write checks uncached previous after key change", async () => {
  const payload = Buffer.from("id,name\n1,Alice\n2,Bob\n".repeat(100), "utf8");
  const compressed = zstdCompressSync(payload);
  const chunks: Buffer[] = [];
  const decoder = zstdDecoder(false);
  decoder.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await pipeline(Readable.from([compressed.subarray(0, 11), compressed.subarray(11)]), decoder);
  assert.equal(Buffer.concat(chunks).toString("utf8"), payload.toString("utf8"));
  await assert.rejects(pipeline(Readable.from([Buffer.from([1, 2, 3, 4])]), zstdDecoder(false)));

  await writeParquet(path.join(workspace, "with-row-num.parquet"), {
    columns: [
      { name: "file_row_number", type: "integer" },
      { name: "v", type: "string" },
    ],
    rows: [[7, "ok"]],
  });
  const pqInfo = await client.open("with-row-num.parquet");
  assert.deepEqual(
    pqInfo.columns.map((c) => c.name),
    ["file_row_number", "v"],
  );
  assert.deepEqual((await client.rows(pqInfo)).rows, [[7, "ok"]]);

  await writeFile(path.join(workspace, "dmy.csv"), "d,v\n31/01/2024,1\n29/02/2024,2\n");
  const dmyInfo = await client.open("dmy.csv");
  await client.result("write", {
    table: dmyInfo.table,
    revision: dmyInfo.revision,
    updates: [{ key: { rowId: 0 }, column: "d", value: "2025-03-15" }],
  });
  await client.result("save", { table: dmyInfo.table });
  assert.equal(await readFile(path.join(workspace, "dmy.csv"), "utf8"), "d,v\n15/03/2025,1\n29/02/2024,2\n");

  await writeFile(path.join(workspace, "key-then-prev.csv"), "id,name\n1,Alice\n2,Bob\n");
  const keyInfo = await client.open("key-then-prev.csv");
  const res = await client.result("write", {
    table: keyInfo.table,
    revision: keyInfo.revision,
    rowKey: "id",
    updates: [
      { key: { value: 1 }, column: "id", value: 10 },
      { key: { value: 10 }, column: "name", value: "Alicia", previous: "Alice" },
    ],
  });
  assert.deepEqual(res, { updated: 2, edits: { version: 1, cells: 2 } });
  assert.deepEqual((await client.rows(keyInfo)).rows[0], [10, "Alicia"]);

  // UTF-16BE with BOM, headerless CSV, CRLF skipped lines, and backslash escapes in rewriteCsv.
  const utf16beText = "10,alpha\r\n20,beta";
  const beBuf = Buffer.alloc(2 + utf16beText.length * 2);
  beBuf[0] = 0xfe;
  beBuf[1] = 0xff;
  for (let i = 0; i < utf16beText.length; i++) beBuf.writeUInt16BE(utf16beText.charCodeAt(i), 2 + i * 2);
  await writeFile(path.join(workspace, "be-nohdr.csv"), beBuf);
  const beInfo = await client.open("be-nohdr.csv", { headerRow: 0 });
  await client.result("write", {
    table: beInfo.table,
    revision: beInfo.revision,
    updates: [{ key: { rowId: 0 }, column: beInfo.columns[1].name, value: "gamma" }],
  });
  await client.result("save", { table: beInfo.table });
  const beReopened = await client.open("be-nohdr.csv", { headerRow: 0 });
  assert.deepEqual((await client.rows(beReopened)).rows, [
    [10, "gamma"],
    [20, "beta"],
  ]);

  await writeFile(path.join(workspace, "crlf-skip.csv"), 'skip line\r\na,b\r\n1,"he""llo"\r\n2,"plain"\r\n');
  const skipInfo = await client.open("crlf-skip.csv", { headerRow: 2 });
  await client.result("write", {
    table: skipInfo.table,
    revision: skipInfo.revision,
    updates: [{ key: { rowId: 1 }, column: "b", value: "edited" }],
  });
  await client.result("save", { table: skipInfo.table });
  const skipSaved = await readFile(path.join(workspace, "crlf-skip.csv"), "utf8");
  assert.ok(skipSaved.startsWith('skip line\r\na,b\r\n1,"he""llo"\r\n2,'));

  // Files with CSV comment lines refuse in-place save rather than miscounting rows.
  await writeFile(path.join(workspace, "commented.csv"), "# header note\na,b\n# middle note\n1,x\n2,y\n");
  const commentedInfo = await client.open("commented.csv");
  await client.result("write", {
    table: commentedInfo.table,
    revision: commentedInfo.revision,
    updates: [{ key: { rowId: 0 }, column: "b", value: "z" }],
  });
  const commentErr = await client.error("save", { table: commentedInfo.table });
  assert.equal(commentErr.code, "save_unsupported");

  // Windows-1252 / Latin-1 fallback when non-ASCII bytes are not Japanese, and UTF-16LE with BOM + quoted export headers.
  await writeFile(path.join(workspace, "latin1.csv"), Buffer.from("name,n\ncaf\xe9,1\nna\xefve,2\n", "latin1"));
  const latinInfo = await client.open("latin1.csv");
  assert.deepEqual((await client.rows(latinInfo)).rows, [
    ["café", 1],
    ["naïve", 2],
  ]);
  const exported = await client.result<{ target: string }>("export", {
    table: latinInfo.table,
    revision: latinInfo.revision,
    plan: {},
    format: "csv",
    headers: ["", 'n"1'],
  });
  assert.ok(exported.target);
});
