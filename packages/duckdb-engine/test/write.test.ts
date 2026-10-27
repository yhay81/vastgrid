import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createGridStore, localTransport } from "vastgrid/core";
import { type Client, type Json, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;
const events: Json[] = [];

const people = ["id,name,age,joined", "1,Ann,31,2024-01-03", "2,Bob,45,2023-05-01", "3,Cy,,2022-11-20"].join("\n");

before(async () => {
  context = await setUp();
  client = context.client;
  workspace = context.workspace;
  context.engine.subscribe((event) => events.push(event));
});

after(async () => {
  await context.tearDown();
});

/** A CSV file of its own for a test, opened. */
async function opened(name: string, text = people): Promise<TableInfo> {
  await writeFile(path.join(workspace, name), text);
  return client.open(name);
}

function write(info: TableInfo, updates: Json[], members: Json = {}) {
  return { table: info.table, revision: info.revision, updates, ...members };
}

async function values(info: TableInfo, request: { plan?: Json; columns?: string[] } = {}) {
  return (await client.rows(info, request)).rows;
}

test("writes keep the file, change what every request reads, and count the cells (§7.2)", async () => {
  const info = await opened("write.csv");
  assert.equal((info.capabilities as Json).write, true);
  const before = await readFile(path.join(workspace, "write.csv"), "utf8");
  const result = await client.result("write", {
    ...write(info, [
      { key: { rowId: 1 }, column: "name", value: "Bea", previous: "Bob" },
      { key: { rowId: 2 }, column: "age", value: 7 },
      { key: { rowId: 2 }, column: "age", value: 8 },
      { key: { rowId: 0 }, column: "joined", value: null },
    ]),
  });
  assert.deepEqual(result, { updated: 4, edits: { version: 1, cells: 3 } });
  assert.equal(await readFile(path.join(workspace, "write.csv"), "utf8"), before, "the file stays as it was");
  assert.deepEqual(await values(info), [
    [1, "Ann", 31, null],
    [2, "Bea", 45, "2023-05-01"],
    [3, "Cy", 8, "2022-11-20"],
  ]);
  const changed = events.filter((event) => event.event === "changed" && event.table === info.table);
  assert.deepEqual(changed.at(-1), {
    v: 2,
    event: "changed",
    table: info.table,
    revision: info.revision,
    edits: { version: 1, cells: 3 },
  });
  assert.deepEqual(await client.result("changes", { table: info.table }), {
    revision: info.revision,
    edits: { version: 1, cells: 3 },
  });
  const again = await client.result<TableInfo & { edits: Json }>("info", { table: info.table });
  assert.deepEqual(again.edits, { version: 1, cells: 3 });

  // Plans, summaries and find read the written values.
  const sorted = { sort: [{ column: "age", direction: "asc" }] };
  assert.deepEqual(await values(info, { plan: sorted, columns: ["name"] }), [["Cy"], ["Ann"], ["Bea"]]);
  const filtered = { where: { fn: "eq", args: [{ col: "name" }, { lit: "Bea" }] } };
  assert.deepEqual(await values(info, { plan: filtered, columns: ["id"] }), [[2]]);
  const rows = await client.rows(info, { plan: sorted, columns: ["age"] });
  assert.deepEqual((rows.view as unknown as Json).edits, { version: 1, cells: 3 });
  const summary = await client.result<Json>("summarize", {
    table: info.table,
    revision: info.revision,
    plan: {},
    ranges: [[0, 3]],
    columns: ["age"],
  });
  assert.equal(summary.sum, 84);
  const found = await client.result("find", {
    table: info.table,
    revision: info.revision,
    plan: {},
    text: "bea",
    columns: ["name"],
    from: { row: 0, column: 0 },
    direction: 1,
  });
  assert.deepEqual(found, { row: 1, column: 0 });

  // A second write to a written column keeps the view and stores over the value.
  const second = await client.result("write", write(info, [{ key: { rowId: 1 }, column: "name", value: "Bo" }]));
  assert.deepEqual(second, { updated: 1, edits: { version: 2, cells: 3 } });
  assert.deepEqual(await values(info, { columns: ["name"] }), [["Ann"], ["Bo"], ["Cy"]]);
  assert.deepEqual(await values(info, { plan: filtered, columns: ["id"] }), []);
});

test("a write that fails changes nothing (§7.2)", async () => {
  const info = await opened("atomic.csv");
  const first = { key: { rowId: 0 }, column: "name", value: "Zed" };
  const failures: [Json[], Json, string][] = [
    [[first, { key: { rowId: 1 }, column: "age", value: "old" }], {}, "invalid_value"],
    [[first, { key: { rowId: 1 }, column: "joined", value: "2024-02-30" }], {}, "invalid_value"],
    [[first, { key: { rowId: 1 }, column: "nothing", value: 1 }], {}, "read_only"],
    [[first, { key: { rowId: 9 }, column: "age", value: 1 }], {}, "edit_conflict"],
    [[first, { key: { rowId: 1 }, column: "name", value: "B", previous: "Bobby" }], {}, "edit_conflict"],
    [[first, { key: { value: 99 }, column: "name", value: "B" }], { rowKey: "id" }, "edit_conflict"],
    [[first], { revision: "other" }, "revision_changed"],
  ];
  for (const [updates, members, code] of failures) {
    const error = await client.error("write", write(info, updates, members));
    assert.equal(error.code, code, JSON.stringify(updates));
  }
  const value = await client.error("write", write(info, [first, { key: { rowId: 1 }, column: "age", value: 1.5 }]));
  assert.deepEqual([value.path, value.reason], ["/updates/1/value", "type"]);
  const rowKey = await client.error("write", write(info, [first], { rowKey: "missing" }));
  assert.deepEqual([rowKey.code, rowKey.path], ["invalid_request", "/rowKey"]);
  assert.deepEqual(await values(info, { columns: ["name", "age"] }), [
    ["Ann", 31],
    ["Bob", 45],
    ["Cy", null],
  ]);
  assert.deepEqual(await client.result("changes", { table: info.table }), {
    revision: info.revision,
    edits: { version: 0, cells: 0 },
  });
});

test("writes by row key find the row by its value now, also after the key column is written (§5.3)", async () => {
  const info = await opened("keys.csv");
  await client.result(
    "write",
    write(
      info,
      [
        { key: { value: 2 }, column: "age", value: 46, previous: 45 },
        { key: { value: 3 }, column: "id", value: 30 },
      ],
      { rowKey: "id" },
    ),
  );
  await client.result("write", write(info, [{ key: { value: 30 }, column: "name", value: "Cyd" }], { rowKey: "id" }));
  assert.deepEqual(await values(info), [
    [1, "Ann", 31, "2024-01-03"],
    [2, "Bob", 46, "2023-05-01"],
    [30, "Cyd", null, "2022-11-20"],
  ]);
  const gone = await client.error(
    "write",
    write(info, [{ key: { value: 3 }, column: "age", value: 1 }], { rowKey: "id" }),
  );
  assert.equal(gone.code, "edit_conflict");
});

test("handles of a file share its written cells until the last one closes (§7.2)", async () => {
  const info = await opened("shared.csv");
  const other = await client.open("shared.csv");
  await client.result("write", write(info, [{ key: { rowId: 0 }, column: "name", value: "Anne" }]));
  assert.deepEqual(await values(other, { columns: ["name"] }), [["Anne"], ["Bob"], ["Cy"]]);
  await client.result("close", { table: info.table });
  assert.deepEqual(await values(other, { columns: ["name"] }), [["Anne"], ["Bob"], ["Cy"]]);
  await client.result("close", { table: other.table });
  const reopened = await client.open("shared.csv");
  assert.deepEqual(await values(reopened, { columns: ["name"] }), [["Ann"], ["Bob"], ["Cy"]]);
  assert.deepEqual(await client.result("changes", { table: reopened.table }), {
    revision: reopened.revision,
    edits: { version: 0, cells: 0 },
  });
});

test("a file changed by someone else opens as a new revision, without the cells written before (§8.3)", async () => {
  const info = await opened("outside.csv");
  await client.result("write", write(info, [{ key: { rowId: 0 }, column: "name", value: "Anne" }]));
  await writeFile(path.join(workspace, "outside.csv"), `${people}\n4,Dee,22,2021-01-01`);
  const fresh = await client.open("outside.csv");
  assert.notEqual(fresh.revision, info.revision);
  assert.deepEqual(await values(fresh, { columns: ["name"] }), [["Ann"], ["Bob"], ["Cy"], ["Dee"]]);
  // The handle opened before keeps reading and writing the table as it was read.
  assert.deepEqual(await values(info, { columns: ["name"] }), [["Anne"], ["Bob"], ["Cy"]]);
  await client.result("write", write(info, [{ key: { rowId: 1 }, column: "name", value: "Bo" }]));
  assert.deepEqual(await values(info, { columns: ["name"] }), [["Anne"], ["Bo"], ["Cy"]]);
});

test("cells of a Parquet file read in place are written by row ID, with exact types", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const file = path.join(workspace, "typed.parquet").replaceAll("'", "''");
  await connection.run(
    `COPY (SELECT i AS n, CAST(i AS DECIMAL(10,2)) AS price, CAST(i AS FLOAT) AS f, TIMESTAMP_NS '2024-01-01 00:00:00' AS t FROM range(200000) r(i)) TO '${file}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();
  const info = await client.open("typed.parquet");
  const updates = [
    { key: { rowId: 150_000 }, column: "price", value: "12.34" },
    { key: { rowId: 150_000 }, column: "f", value: 0.10000000149011612 },
    { key: { rowId: 150_001 }, column: "t", value: "2262-04-11 23:47:16.854775806" },
  ];
  await client.result("write", write(info, updates));
  const rows = await client.rows(info, { start: 150_000, end: 150_002 });
  assert.deepEqual(rows.rows, [
    [150000, "12.34", 0.10000000149011612, "2024-01-01 00:00:00"],
    [150001, "150001.00", 150001, "2262-04-11 23:47:16.854775806"],
  ]);
  const unrounded = await client.error("write", write(info, [{ key: { rowId: 0 }, column: "f", value: 0.1 }]));
  assert.equal(unrounded.code, "invalid_value");
  // DuckDB keeps the largest count for its infinity: §2.2 allows it, the engine's source does not.
  const beyond = await client.error(
    "write",
    write(info, [updates[0], { key: { rowId: 0 }, column: "t", value: "2262-04-11 23:47:16.854775807" }]),
  );
  assert.deepEqual([beyond.code, beyond.path], ["invalid_value", "/updates/1/value"]);
  const sorted = await client.rows(info, {
    plan: { sort: [{ column: "price", direction: "asc" }] },
    end: 2,
    columns: ["n"],
  });
  assert.deepEqual(sorted.rows, [[0], [1]]);
});

/** Waits for a condition that the store reaches after the engine answers. */
async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 500 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done());
}

test("the grid's store edits, pastes, undoes and redoes cells of a file through the engine (§7.4)", async () => {
  await writeFile(path.join(workspace, "grid.csv"), people);
  const store = createGridStore({ transport: localTransport(context.engine), table: "grid.csv" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "name", "age", "joined"] });
  await until(() => store.getSnapshot().view !== null && store.cell(2, "name") === "Cy");

  await store.dispatch({ command: "select", row: 1, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "" });
  store.dispatchSync({ command: "edit.change", text: "Bea" });
  assert.deepEqual(await store.dispatch({ command: "edit.commit", move: "down" }), { ok: true });
  await until(() => store.getSnapshot().table?.edits.version === 1 && store.getSnapshot().pending === null);
  assert.equal(store.cell(1, "name"), "Bea");

  await store.dispatch({ command: "select", row: 0, column: "age" });
  assert.equal((await store.dispatch({ command: "edit.paste" }, { clipboard: { text: "40\n41" } })).ok, true);
  await until(() => store.getSnapshot().pending === null && store.cell(1, "age") === 41);
  assert.equal(store.cell(0, "age"), 40);

  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "age") === 45);
  assert.equal(store.cell(0, "age"), 31);
  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "name") === "Bob");
  assert.deepEqual(await store.dispatch({ command: "history.redo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "name") === "Bea");

  // Another client changes the cell: undoing over it is a conflict, and the value stays.
  const table = store.getSnapshot().table;
  await client.result("write", {
    table: table?.table,
    revision: table?.revision,
    updates: [{ key: { rowId: 1 }, column: "name", value: "Other" }],
  });
  await until(() => store.cell(1, "name") === "Other");
  const undo = await store.dispatch({ command: "history.undo" });
  assert.equal(undo.ok, false);
  await until(() => store.getSnapshot().pending === null);
  assert.equal(store.cell(1, "name"), "Other");
  disconnect();
});

test("a write that fails is kept: Retry sends it again, Overwrite writes over a conflict, Discard forgets it", async () => {
  await writeFile(path.join(workspace, "retry.csv"), people);
  // A transport whose next write fails as a lost connection does.
  let failNext = false;
  const local = localTransport(context.engine);
  const transport = {
    ...local,
    send: (request: Parameters<typeof local.send>[0], options: Parameters<typeof local.send>[1]) => {
      if (request.op === "write" && failNext) {
        failNext = false;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return local.send(request, options);
    },
  };
  const store = createGridStore({ transport, table: "retry.csv" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "name", "age", "joined"] });
  await until(() => store.getSnapshot().view !== null && store.cell(2, "name") === "Cy");
  const settled = () => store.getSnapshot().pending === null;

  // Lost: the cell shows the engine's value, and Retry writes it with its history step.
  failNext = true;
  await store.dispatch({ command: "select", row: 0, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "Amy" });
  const lost = await store.dispatch({ command: "edit.commit", move: null });
  assert.equal(lost.ok, false);
  assert.equal(store.cell(0, "name"), "Ann");
  let failed = store.getSnapshot().failedWrite;
  assert.equal(failed?.retry, "retry");
  assert.equal(failed?.command, "edit.commit");
  assert.equal(failed?.error.code, "internal");
  assert.deepEqual(await store.retryWrite(), { ok: true });
  assert.equal(store.getSnapshot().failedWrite, null);
  await until(() => settled() && store.cell(0, "name") === "Amy");
  assert.equal(store.getSnapshot().session.history?.undo.length, 1);

  // Another client writes the cell under the person's edit: a conflict, which Overwrite writes over.
  const table = store.getSnapshot().table;
  const other = (value: string) =>
    client.result("write", {
      table: table?.table,
      revision: table?.revision,
      updates: [{ key: { rowId: 1 }, column: "name", value }],
    });
  await store.dispatch({ command: "select", row: 1, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "Bea" });
  await other("Other");
  const conflict = await store.dispatch({ command: "edit.commit", move: null });
  assert.equal(conflict.ok, false);
  failed = store.getSnapshot().failedWrite;
  assert.equal(failed?.retry, "overwrite");
  assert.equal(failed?.error.code, "edit_conflict");
  await until(() => settled() && store.cell(1, "name") === "Other");
  assert.deepEqual(await store.retryWrite(), { ok: true });
  await until(() => settled() && store.cell(1, "name") === "Bea");
  assert.equal(store.getSnapshot().session.history?.undo.length, 2);

  // An undo over a value written meanwhile is a conflict too; Overwrite moves its step onto redo.
  await other("Again");
  await until(() => settled() && store.cell(1, "name") === "Again");
  assert.equal((await store.dispatch({ command: "history.undo" })).ok, false);
  assert.equal(store.getSnapshot().failedWrite?.command, "history.undo");
  assert.deepEqual(await store.retryWrite(), { ok: true });
  await until(() => settled() && store.cell(1, "name") === "Bob");
  assert.equal(store.getSnapshot().session.history?.undo.length, 1);
  assert.equal(store.getSnapshot().session.history?.redo.length, 1);

  // Discard forgets a failed write, and the cell keeps the engine's value.
  failNext = true;
  await store.dispatch({ command: "select", row: 2, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "Cyd" });
  assert.equal((await store.dispatch({ command: "edit.commit", move: null })).ok, false);
  store.discardWrite();
  assert.equal(store.getSnapshot().failedWrite, null);
  assert.equal(store.cell(2, "name"), "Cy");
  assert.equal((await store.retryWrite()).ok, false);
  disconnect();
});

test("an undo pressed while a write is sent undoes that write", async () => {
  await writeFile(path.join(workspace, "quick.csv"), people);
  const store = createGridStore({ transport: localTransport(context.engine), table: "quick.csv" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "name", "age", "joined"] });
  await until(() => store.getSnapshot().view !== null && store.cell(2, "name") === "Cy");
  await store.dispatch({ command: "select", row: 0, column: "name" });
  assert.equal((await store.dispatch({ command: "edit.paste" }, { clipboard: { text: "Amy" } })).ok, true);
  await store.dispatch({ command: "select", row: 1, column: "name" });
  const clearing = store.dispatch({ command: "edit.clear" });
  const undoing = store.dispatch({ command: "history.undo" });
  assert.deepEqual(await clearing, { ok: true });
  assert.deepEqual(await undoing, { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "name") === "Bob");
  assert.equal(store.cell(0, "name"), "Amy");
  assert.equal(store.getSnapshot().session.history?.undo.length, 1);
  disconnect();
});

/** The bytes of the blocks in an answer (§8.4): what a transport carries of the rows. */
function blockBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + blockBytes(item), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((sum: number, item) => sum + blockBytes(item), 0);
  }
  return 0;
}

test("writing a few cells of a 2-million-row file reads again only the rows on screen", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const file = path.join(workspace, "large.parquet").replaceAll("'", "''");
  await connection.run(
    `COPY (SELECT i AS id, 'name ' || i AS name, i * 0.5 AS price FROM range(2000000) r(i)) TO '${file}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();
  const read = { rows: 0, bytes: 0 };
  const local = localTransport(context.engine);
  const transport = {
    ...local,
    send: async (request: Parameters<typeof local.send>[0], options: Parameters<typeof local.send>[1]) => {
      const response = await local.send(request, options);
      if (request.op === "rows") {
        read.rows += Math.max(0, Number(request.end) - Number(request.start));
        read.bytes += blockBytes(response);
      }
      return response;
    },
  };
  const store = createGridStore({ transport, table: "large.parquet" });
  const disconnect = store.connect();
  const settled = () => store.getSnapshot().pending === null && store.getSnapshot().view?.status !== "building";
  // The middle of the file is on screen: 40 rows.
  store.setViewport({ top: 1_000_000, rows: 40, columns: ["id", "name", "price"] });
  await until(() => store.getSnapshot().view !== null && store.cell(1_000_000, "name") === "name 1000000");

  const measure = async (paste: string, row: number, column: string, done: () => boolean) => {
    read.rows = 0;
    read.bytes = 0;
    await store.dispatch({ command: "select", row, column });
    assert.equal((await store.dispatch({ command: "edit.paste" }, { clipboard: { text: paste } })).ok, true);
    await until(() => settled() && done());
    return { ...read };
  };
  // Three cells in row ID order.
  const inOrder = await measure("a\na\na", 1_000_001, "name", () => store.cell(1_000_003, "name") === "a");
  // Three cells of the column that the view is sorted by: the engine sorts again, the grid reads the screen again.
  assert.equal(
    (await store.dispatch({ command: "sort.set", keys: [{ column: "price", direction: "desc" }] })).ok,
    true,
  );
  store.setViewport({ top: 1_000_000, rows: 40, columns: ["id", "name", "price"] });
  await until(() => settled() && store.cell(1_000_000, "id") === 999_999);
  // The rows written go to the end of the order, and the rows after them come up.
  const sorted = await measure("-1\n-1\n-1", 1_000_010, "price", () => store.cell(1_000_010, "id") === 999_986);
  for (const [name, result] of Object.entries({ inOrder, sorted })) {
    // The block on screen (256 rows, about 10 KB), never the file's 2,000,000 rows.
    assert.ok(result.rows <= 2 * 256, `${name}: ${result.rows} rows read again`);
    assert.ok(result.bytes < 64 * 1024, `${name}: ${result.bytes} bytes read again`);
  }
  disconnect();
});
