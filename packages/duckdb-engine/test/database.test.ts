import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { fileRevision, tableFormatOf } from "../src/index.ts";
import { type Client, type Json, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;

beforeAll(async () => {
  context = await setUp();
  client = context.client;
  workspace = context.workspace;
});

afterAll(async () => {
  await context.tearDown();
});

/** Writes a DuckDB database with its own instance, closed afterwards (which checkpoints it). */
async function database(name: string, statements: string[]) {
  const instance = await DuckDBInstance.create(path.join(workspace, name));
  const connection = await instance.connect();
  try {
    for (const statement of statements) await connection.run(statement);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return name;
}

async function readAll(ref: string, read?: Json) {
  const info = await client.open(ref, read);
  assert.equal(info.status, "ready", info.error);
  return { info, rows: (await client.rows(info)).rows };
}

async function until(done: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Waited in vain for ${what}.`);
}

/** Another process that opens a database to write it, and keeps it open until it is stopped. */
async function writer(file: string): Promise<ChildProcess> {
  const code = `import { DuckDBInstance } from "@duckdb/node-api";
// Held by a global: an instance that is collected closes, and its lock with it.
globalThis.instance = await DuckDBInstance.create(process.argv[1]);
await (await globalThis.instance.connect()).run("SELECT 1");
process.stdout.write("open\\n");
process.stdin.resume();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, file], {
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", (status) => reject(new Error(`The writer stopped (${status}).`)));
  });
  return child;
}

async function stop(child: ChildProcess) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

test("DuckDB databases are recognised by their extension", () => {
  assert.equal(tableFormatOf("shop.duckdb"), "duckdb");
  assert.equal(tableFormatOf("Shop.DDB"), "duckdb");
  // Other programs' databases use .db too.
  assert.equal(tableFormatOf("shop.db"), null);
});

test("the tables and views of a database are its sheets; the first is read and others can be chosen", async () => {
  const file = await database("shop.duckdb", [
    "CREATE TABLE cities (id INTEGER, name VARCHAR, population BIGINT, founded DATE)",
    "INSERT INTO cities VALUES (1, 'Tokyo', 14000000, '1457-01-01'), (2, 'Osaka', 2700000, NULL), (3, 'Nara', 360000, '0710-01-01'), (4, 'Kobe', 1500000, NULL)",
    // Deleted rows leave gaps in DuckDB's rowid; the row IDs of the table are its positions (§1).
    "DELETE FROM cities WHERE id = 2",
    "CREATE VIEW big_cities AS SELECT name FROM cities WHERE population > 1000000",
    "CREATE SCHEMA sales",
    "CREATE TABLE sales.orders (city VARCHAR, total DECIMAL(10, 2), detail STRUCT(n INTEGER))",
    "INSERT INTO sales.orders VALUES ('Tokyo', 12.50, {n: 1})",
    'CREATE TABLE "rowid" ("rowid" INTEGER)',
    'INSERT INTO "rowid" VALUES (7)',
  ]);
  const first = await readAll(file);
  assert.equal(first.info.format, "duckdb");
  assert.deepEqual(first.info.sheets, [
    { name: "big_cities" },
    { name: "cities" },
    { name: "rowid" },
    { name: "sales.orders" },
  ]);
  assert.equal(first.info.sheet, "big_cities");
  assert.deepEqual(first.rows, [["Tokyo"], ["Kobe"]]);
  assert.equal((first.info.capabilities as Json).save, false);

  const cities = await readAll(file, { sheet: "cities" });
  assert.equal(cities.info.sheet, "cities");
  assert.deepEqual(
    cities.info.columns.map((column) => [column.name, column.type]),
    [
      ["id", "integer"],
      ["name", "string"],
      ["population", "bigint"],
      ["founded", "date"],
    ],
  );
  const read = await client.rows(cities.info);
  assert.deepEqual(read.rows, [
    [1, "Tokyo", 14000000, "1457-01-01"],
    [3, "Nara", 360000, "0710-01-01"],
    [4, "Kobe", 1500000, null],
  ]);
  assert.deepEqual(read.rowIds, [0, 1, 2]);

  const orders = await readAll(file, { sheet: "sales.orders" });
  assert.deepEqual(orders.rows, [["Tokyo", "12.50", "{'n': 1}"]]);
  assert.equal(orders.info.columns[2].readOnly, true);
  // A column named like DuckDB's own row numbers is a column like any other.
  assert.deepEqual((await readAll(file, { sheet: "rowid" })).rows, [[7]]);

  const missing = await client.open(file, { sheet: "nowhere" });
  assert.equal(missing.status, "error");
  assert.equal(missing.error, 'The database has no table named "nowhere".');
  assert.equal(missing.sheets?.length, 4);
});

test("cells of a database's table are written in memory; the file is not saved (§7.2)", async () => {
  const file = await database("notes.duckdb", ["CREATE TABLE notes AS SELECT 1 AS id, 'draft' AS body"]);
  const { info } = await readAll(file);
  const before = await fileRevision(path.join(workspace, file));
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 0 }, column: "body", value: "final" }],
  });
  assert.deepEqual((await client.rows(info)).rows, [[1, "final"]]);
  assert.equal((await client.error("save", { table: info.table })).code, "save_unsupported");
  assert.equal(await fileRevision(path.join(workspace, file)), before);
});

test("databases without tables, and files that are not databases, fail to open", async () => {
  const empty = await client.open(await database("empty.duckdb", ["CREATE SCHEMA unused"]));
  assert.equal(empty.status, "error");
  assert.equal(empty.error, "The database has no tables.");
  assert.deepEqual(empty.sheets, []);
  await writeFile(path.join(workspace, "fake.duckdb"), "id,name\n1,a\n".repeat(1000));
  const fake = await client.open("fake.duckdb");
  assert.equal(fake.status, "error");
  assert.equal(fake.error, "The file is not a DuckDB database.");
});

test("a view that reads a file outside the allowed folders fails like any read of it", async () => {
  const secret = path.join(context.root, "secret.csv");
  await writeFile(secret, "word\nhidden\n");
  const file = await database("leak.duckdb", [
    `CREATE VIEW leak AS SELECT * FROM read_csv('${secret.replaceAll("'", "''")}')`,
  ]);
  const info = await client.open(file);
  assert.equal(info.status, "error");
  assert.match(info.error ?? "", /Permission Error/);
  assert.doesNotMatch(info.error ?? "", /hidden/);
});

test("changes in the write-ahead log are read, and count in the file's revision", async () => {
  const file = await database("logged.duckdb", [
    "PRAGMA disable_checkpoint_on_shutdown",
    "SET checkpoint_threshold = '1GB'",
    "CREATE TABLE logged AS SELECT range AS n FROM range(5)",
  ]);
  // The rows are in the log only.
  assert.ok((await stat(path.join(workspace, `${file}.wal`))).size > 0);
  assert.deepEqual((await readAll(file)).rows, [[0], [1], [2], [3], [4]]);
  const other = path.join(workspace, await database("revision.duckdb", ["CREATE TABLE r AS SELECT 1 AS n"]));
  const before = await fileRevision(other);
  await writeFile(`${other}.wal`, "log");
  assert.notEqual(await fileRevision(other), before);
  await rm(`${other}.wal`);
  assert.equal(await fileRevision(other), before);
});

test("the database is free once its table has loaded, and one that another program writes is refused", async () => {
  const file = await database("busy.duckdb", ["CREATE TABLE busy AS SELECT 1 AS n"]);
  const full = path.join(workspace, file);
  await readAll(file);
  // A program that writes the database can open it while the grid shows its table.
  await stop(await writer(full));
  const held = await writer(full);
  try {
    const refused = await client.open(file, { sheet: "busy" });
    assert.equal(refused.status, "error");
    assert.equal(refused.error, "Another program has the database open to write it; close it there first.");
  } finally {
    await stop(held);
  }
  // Once the program has closed it, the table opens again.
  assert.deepEqual((await readAll(file, { sheet: "busy" })).rows, [[1]]);
});

test("a table follows its database when another program changes it (§7.6)", async () => {
  const file = await database("follow.duckdb", ["CREATE TABLE items AS SELECT 1 AS n"]);
  const first = await readAll(file);
  await database(file, ["INSERT INTO items VALUES (2)"]);
  let now: TableInfo = first.info;
  await until(async () => {
    now = await client.result<TableInfo>("info", { table: first.info.table });
    return now.revision !== first.info.revision && now.status === "ready";
  }, "the new revision");
  await context.engine.whenLoaded(first.info.table);
  now = await client.result<TableInfo>("info", { table: first.info.table });
  assert.deepEqual((await client.rows(now)).rows, [[1], [2]]);
});
