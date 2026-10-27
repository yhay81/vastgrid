/** The protocol and commands over the production DuckDB engine, including text and attached transports. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  applyCommand,
  type Column,
  type CommandContext,
  checkResponse,
  decodeBlock,
  frameAttached,
  type GridState,
  type JsonValue,
  type Operation,
  planHash,
  readAttached,
  toTextEncoding,
} from "vastgrid-spec";
import type { CorpusTable } from "vastgrid-spec/conformance";
import { type Json, setUp, writeParquet } from "./client.ts";

const ORDERS: CorpusTable = {
  columns: [
    { name: "id", type: "bigint" },
    { name: "region", type: "string" },
    { name: "qty", type: "integer" },
    { name: "price", type: "decimal", precision: 10, scale: 2 },
  ],
  rows: [
    ["9223372036854775807", "﻿Tokyo", 3, "12.50"],
    [2, "Osaka", 1, "8.00"],
    [3, "tokyo bay", null, null],
    [4, "", 5, "100.00"],
    [5, "Nagoya", 2, "3.25"],
  ],
};

let context: Awaited<ReturnType<typeof setUp>>;
let engine: Awaited<ReturnType<typeof setUp>>["engine"];
let revision: string | null;

before(async () => {
  context = await setUp();
  engine = context.engine;
  await writeParquet(path.join(context.workspace, "orders.parquet"), ORDERS);
  await writeFile(path.join(context.root, "outside.csv"), "id\n1\n");
  const info = await context.client.open("orders.parquet");
  assert.equal(info.status, "ready");
  revision = info.revision;
});
after(async () => context.tearDown());

/** Check the response after it crosses a JSON transport, as an MCP App receives it. */
async function send(op: Operation, members: Json = {}): Promise<Json> {
  const response = await context.client.send(op, members);
  const text = JSON.parse(JSON.stringify(toTextEncoding(response))) as Json;
  checkResponse(text, op);
  assert.equal(text.id, response.id);
  return text;
}

async function opened() {
  const response = await send("open", { ref: "orders.parquet" });
  return (response.result as { table: string }).table;
}

function rowsOf(response: Json) {
  const result = response.result as { block: { base64: string } };
  return decodeBlock(new Uint8Array(Buffer.from(result.block.base64, "base64")));
}

test("open gives TableInfo, and info and changes follow it", async () => {
  const response = await send("open", { ref: "orders.parquet" });
  const info = response.result as { table: string; columns: Column[]; rowCount: number };
  assert.deepEqual(
    info.columns.map(({ sourceType: _sourceType, ...column }) => column),
    ORDERS.columns,
  );
  assert.equal(info.rowCount, 5);
  assert.deepEqual((await send("info", { table: info.table })).result, info);
  assert.deepEqual((await send("changes", { table: info.table })).result, {
    revision,
    edits: { version: 0, cells: 0 },
  });
});

test("rows answers a plan's view with a block that keeps every value", async () => {
  const table = await opened();
  const plan = {
    where: { fn: "ge", args: [{ col: "qty" }, { lit: 2 }] },
    sort: [{ column: "price", direction: "desc" }],
  };
  const response = await send("rows", {
    table,
    revision,
    plan,
    start: 0,
    end: 10,
    columns: ["id", "region", "price"],
  });
  const result = response.result as { view: { hash: string; rowCount: number }; rowIds: number[]; end: number };
  assert.equal(result.view.hash, await planHash(plan));
  assert.equal(result.view.rowCount, 3);
  assert.equal(result.end, 3);
  assert.deepEqual(result.rowIds, [3, 0, 4]);
  const block = rowsOf(response);
  assert.deepEqual(
    block.columns.map(({ sourceType: _sourceType, ...column }) => column),
    [ORDERS.columns[0], ORDERS.columns[1], ORDERS.columns[3]],
  );
  assert.deepEqual(block.rows, [
    [4, "", "100.00"],
    ["9223372036854775807", "﻿Tokyo", "12.50"],
    [5, "Nagoya", "3.25"],
  ]);
});

test("rows of groups have no row IDs, and textLimit cuts long strings", async () => {
  const table = await opened();
  const groups = await send("rows", {
    table,
    revision,
    plan: {
      aggregate: { keys: ["region"], measures: [{ name: "n", fn: "count" }] },
      sort: [{ column: "region", direction: "asc" }],
    },
    start: 0,
    end: 2,
    columns: ["region", "n"],
    textLimit: 3,
  });
  const result = groups.result as { rowIds: null; truncated: Record<string, number[]> };
  assert.equal(result.rowIds, null);
  assert.deepEqual(rowsOf(groups).rows, [
    ["Nag", 1],
    ["Osa", 1],
  ]);
  assert.deepEqual(result.truncated, { region: [0, 1] });
});

test("the real engine's response travels in the attached encoding (§8.8)", async () => {
  const table = await opened();
  const response = (await engine.handle({
    v: 2,
    id: 99,
    op: "rows",
    table,
    revision,
    plan: {},
    start: 0,
    end: 1,
    columns: ["id"],
  })) as Json;
  const framed = frameAttached(response);
  const read = readAttached(framed) as { result: { block: { bytes: Uint8Array } } };
  assert.deepEqual(decodeBlock(read.result.block.bytes).rows, [["9223372036854775807"]]);
  const length = new DataView(framed.buffer).getUint32(0, true);
  checkResponse(JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))), "rows");
});

test("summarize counts the cells that are not blank, and sums the finite numbers", async () => {
  const table = await opened();
  const response = await send("summarize", {
    table,
    revision,
    plan: {},
    ranges: [
      [1, 3],
      [3, 5],
    ],
    columns: ["region", "qty"],
  });
  assert.deepEqual(response.result, { count: 6, numericCount: 3, sum: 8, min: 1, max: 5, average: 8 / 3 });
  const none = await send("summarize", { table, revision, plan: {}, ranges: [[3, 4]], columns: ["region"] });
  assert.deepEqual(none.result, { count: 0, numericCount: 0, sum: null, min: null, max: null, average: null });
});

test("find goes row by row from the cell after from, and wraps around", async () => {
  const table = await opened();
  const find = async (
    from: { row: number; column: number },
    direction: 1 | -1,
    text = "tokyo",
    caseSensitive = false,
  ) =>
    (
      await send("find", {
        table,
        revision,
        plan: {},
        text,
        columns: ["region", "qty"],
        from,
        direction,
        caseSensitive,
      })
    ).result;
  assert.deepEqual(await find({ row: 0, column: 0 }, 1), { row: 2, column: 0 });
  assert.deepEqual(await find({ row: 2, column: 0 }, 1), { row: 0, column: 0 });
  assert.deepEqual(await find({ row: 1, column: 1 }, -1), { row: 0, column: 0 });
  assert.deepEqual(await find({ row: 0, column: 0 }, 1, "Tokyo", true), { row: 0, column: 0 });
  assert.deepEqual(await find({ row: 0, column: 0 }, 1, "5"), { row: 3, column: 1 });
  assert.equal(await find({ row: 0, column: 0 }, 1, "zzz"), null);
  assert.equal(await find({ row: 0, column: 0 }, 1, ""), null);
});

test("errors carry their code of §8.7", async () => {
  const table = await opened();
  const error = async (members: Json) => ((await engine.handle({ v: 2, id: 1, ...members })) as { error: Json }).error;
  assert.equal(
    (await error({ op: "rows", table, revision: "r0", plan: {}, start: 0, end: 1, columns: ["id"] })).code,
    "revision_changed",
  );
  assert.deepEqual(
    await error({
      op: "rows",
      table,
      revision,
      plan: { sort: [{ column: "zzz", direction: "asc" }] },
      start: 0,
      end: 1,
      columns: ["id"],
    }),
    {
      code: "invalid_plan",
      message: 'There is no column "zzz" here.',
      path: "/sort/0/column",
      reason: "unknown_column",
    },
  );
  const unknown = await error({ op: "query", table });
  assert.deepEqual([unknown.code, unknown.reason, unknown.path], ["invalid_request", "unknown_op", "/op"]);
  const version = (await engine.handle({ v: 1, id: 5, op: "info", table })) as { id: number; error: Json };
  assert.deepEqual([version.id, version.error.reason], [5, "version"]);
  assert.equal((await error({ op: "open", ref: path.join(context.root, "outside.csv") })).code, "not_allowed");
  assert.equal(await engine.handle({ v: 2, id: 6, op: "cancel", request: 5 }), undefined);
  await send("close", { table });
  assert.equal((await error({ op: "info", table })).code, "table_not_found");
});

test("a core drives the engine with commands: sort, read, locate and view.update (§5.4)", async () => {
  const table = await opened();
  const columns = ORDERS.columns;
  let state: GridState = {
    document: { kind: "vastgrid/document", version: 2 },
    session: { kind: "vastgrid/session", version: 2 },
  };
  const context = async (plan: object): Promise<CommandContext> => {
    const response = await send("rows", {
      table,
      revision,
      plan,
      start: 0,
      end: 5,
      columns: columns.map((column) => column.name),
    });
    const result = response.result as { view: { columns: Column[]; rowCount: number }; rowIds: number[] };
    return {
      table: columns,
      revision,
      view: { columns: result.view.columns, rowCount: result.view.rowCount, rowIds: true },
      rows: [
        { start: 0, keys: result.rowIds.map((rowId) => ({ rowId })), values: rowsOf(response).rows as JsonValue[][] },
      ],
      page: 10,
    };
  };
  // The core reads the first view and selects the row of Nagoya (row ID 4), the cheapest.
  let current = await context({});
  state = applyCommand(state, { command: "view.update", hash: await planHash({}) }, current);
  state = applyCommand(state, { command: "select", row: 4, column: "region" }, current);
  assert.deepEqual(state.session.active, { row: 4, column: "region", key: { rowId: 4 } });
  // Sorting changes the plan only; the core then reads the new view and locates the active key.
  state = applyCommand(state, { command: "sort.toggle", column: "price" }, current);
  const plan = state.document.plan ?? {};
  current = await context(plan);
  const located = await send("locate", { table, revision, plan, keys: [{ rowId: 4 }] });
  const rows = (located.result as { rows: (number | null)[] }).rows;
  assert.deepEqual(rows, [0]);
  const result = applyCommand(
    state,
    { command: "view.update", hash: await planHash(plan), located: [{ key: { rowId: 4 }, row: rows[0] }] },
    current,
  );
  assert.deepEqual(result.session.active, { row: 0, column: "region", key: { rowId: 4 } });
  assert.deepEqual(result.session.scroll, { row: 0 });
  assert.equal(result.session.selection, undefined);
  // Copying the active cell reads it from the rows the core has.
  const copied = applyCommand(result, { command: "copy" }, current).output as { tsv: string };
  assert.equal(copied.tsv, "Nagoya");
});
