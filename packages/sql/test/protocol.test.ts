/**
 * The messages of docs/v2-spec.md §8 end to end: a reference engine over DuckDB answers requests with
 * blocks, and the reducer of §6 drives it as a core does.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  applyCommand,
  type Capabilities,
  type Column,
  type CommandContext,
  checkPlan,
  checkRequest,
  checkResponse,
  dateText,
  decodeBlock,
  encodeBlock,
  frameAttached,
  type GridState,
  intervalText,
  type JsonValue,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  planOptions,
  type RowKey,
  readAttached,
  timestampText,
  timeText,
} from "vastgrid-spec";
import type { CorpusTable } from "vastgrid-spec/conformance";
import { compileView, countQuery, quoteIdentifier, rowsQuery, type SqlView } from "../src/index.ts";
import { createTable, jsonOf, output, ROW_ID } from "./duckdb.ts";

type Json = Record<string, unknown>;

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

const CAPABILITIES: Capabilities = {
  plan: { derive: true, where: true, aggregate: true, pivot: false, having: true, sort: true, search: true },
  summarize: true,
  find: true,
  locate: true,
  write: false,
  save: false,
  preview: false,
  partialViews: false,
  changes: "poll",
};

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Json = {},
  ) {
    super(message);
  }
}

/** A reference engine for the tests: the operations of §8.2 that read a table, over DuckDB. */
class Engine {
  private readonly open = new Map<
    string,
    { ref: CorpusTable; relation: string; columns: Column[]; revision: string }
  >();
  private next = 1;

  constructor(
    private readonly connection: DuckDBConnection,
    private readonly refs: Record<string, CorpusTable>,
  ) {}

  /** Answers a message as JSON (§8.1); `cancel` has no answer. */
  async handle(message: unknown): Promise<Json | undefined> {
    let request: Json & { id: number; op: Operation };
    try {
      request = checkRequest(message);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const id = (message as { id?: unknown }).id;
      return {
        v: 2,
        id: typeof id === "number" ? id : 0,
        error: { code: error.code, message: error.message, path: error.path, reason: error.reason },
      };
    }
    if (request.op === "cancel") return undefined;
    try {
      return { v: 2, id: request.id, result: await this.answer(request) };
    } catch (error) {
      if (error instanceof Failure)
        return { v: 2, id: request.id, error: { code: error.code, message: error.message, ...error.extra } };
      if (error instanceof PlanError) {
        return {
          v: 2,
          id: request.id,
          error: { code: "invalid_plan", message: error.message, path: error.path, reason: error.reason },
        };
      }
      throw error;
    }
  }

  private table(request: Json) {
    const table = this.open.get(request.table as string);
    if (!table) throw new Failure("table_not_found", `There is no table ${request.table}.`);
    if ("revision" in request && request.revision !== table.revision) {
      throw new Failure("revision_changed", "The table has another revision.");
    }
    return table;
  }

  private async count(view: SqlView) {
    const query = countQuery(view);
    return Number((await this.connection.runAndReadAll(query.sql, query.params)).getRowsJS()[0][0]);
  }

  /** The values of rows `[start, end)` of a view, as typed JSON, with their row IDs. */
  private async read(view: SqlView, start: number, end: number, names: string[]) {
    const columns = names.map((name) => view.columns.find((column) => column.name === name) as Column);
    const query = rowsQuery(view, { start, end, columns: names }, output);
    const rows = (await this.connection.runAndReadAll(query.sql, query.params)).getRowsJS();
    return {
      columns,
      rows: rows.map((row) => columns.map((column, index) => jsonOf(row[index], column))),
      rowIds: view.rowIds ? rows.map((row) => Number(row[columns.length])) : null,
    };
  }

  private view(request: Json) {
    const table = this.table(request);
    const plan = checkPlan(request.plan, table.columns, planOptions(CAPABILITIES));
    if (plan.aggregate?.pivot)
      throw new Failure("invalid_plan", "This engine has no pivot.", {
        path: "/aggregate/pivot",
        reason: "unsupported",
      });
    const view = compileView(plan, { relation: table.relation, rowId: ROW_ID });
    for (const [index, name] of ((request.columns as string[] | undefined) ?? []).entries()) {
      if (!view.columns.some((column) => column.name === name)) {
        throw new Failure("invalid_request", `The view has no column "${name}".`, {
          path: `/columns/${index}`,
          reason: "syntax",
        });
      }
    }
    return view;
  }

  private info(id: string) {
    const table = this.open.get(id) as { ref: CorpusTable; columns: Column[]; revision: string };
    const ref = table.ref;
    return {
      table: id,
      revision: table.revision,
      edits: { version: 0, cells: 0 },
      status: "ready",
      progress: 1,
      rowCount: ref.rows.length,
      readableRows: ref.rows.length,
      columns: table.columns,
      capabilities: CAPABILITIES,
    };
  }

  private async answer(request: Json & { op: Operation }): Promise<unknown> {
    switch (request.op) {
      case "open": {
        const ref = this.refs[request.ref as string];
        if (!ref) throw new Failure("not_allowed", "The host does not open that.");
        const id = `t${this.next++}`;
        this.open.set(id, {
          ref,
          relation: quoteIdentifier(request.ref as string),
          columns: ref.columns,
          revision: "r1",
        });
        return this.info(id);
      }
      case "info":
        this.table(request);
        return this.info(request.table as string);
      case "changes":
        return { revision: this.table(request).revision, edits: { version: 0, cells: 0 } };
      case "close":
        this.table(request);
        this.open.delete(request.table as string);
        return null;
      case "rows": {
        const view = this.view(request);
        const rowCount = await this.count(view);
        const start = request.start as number;
        const end = Math.max(start, Math.min(request.end as number, rowCount));
        const read = await this.read(view, start, end, request.columns as string[]);
        const limit = (request.textLimit as number | undefined) ?? 2000;
        const truncated: Record<string, number[]> = {};
        const rows = read.rows.map((row, offset) =>
          row.map((value, index) => {
            if (typeof value !== "string" || read.columns[index].type !== "string" || [...value].length <= limit)
              return value;
            const name = read.columns[index].name;
            truncated[name] = [...(truncated[name] ?? []), offset];
            return [...value].slice(0, limit).join("");
          }),
        );
        const bytes = encodeBlock(read.columns, rows);
        return {
          view: {
            hash: await planHash(request.plan as never),
            status: "ready",
            rowCount,
            rowCountExact: true,
            readableRows: rowCount,
            columns: view.columns,
            edits: { version: 0, cells: 0 },
          },
          start,
          end,
          rowIds: read.rowIds,
          block: { bytes },
          ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
        };
      }
      case "summarize": {
        const view = this.view(request);
        let count = 0;
        const numbers: number[] = [];
        for (const [start, end] of request.ranges as [number, number][]) {
          const read = await this.read(view, start, end, request.columns as string[]);
          for (const row of read.rows) {
            row.forEach((value, index) => {
              const type = read.columns[index].type;
              if (value === null || (type === "string" && value === "")) return;
              count++;
              const number =
                ["integer", "bigint", "decimal", "float"].includes(type) && typeof value !== "boolean"
                  ? Number(value)
                  : Number.NaN;
              if (Number.isFinite(number)) numbers.push(number);
            });
          }
        }
        const sum = numbers.reduce((total, number) => total + number, 0);
        const float = (value: number) =>
          value === Number.POSITIVE_INFINITY ? "Infinity" : value === Number.NEGATIVE_INFINITY ? "-Infinity" : value;
        return numbers.length === 0
          ? { count, numericCount: 0, sum: null, min: null, max: null, average: null }
          : {
              count,
              numericCount: numbers.length,
              sum: float(sum),
              min: Math.min(...numbers),
              max: Math.max(...numbers),
              average: float(sum / numbers.length),
            };
      }
      case "find": {
        const view = this.view(request);
        const names = request.columns as string[];
        const text = request.text as string;
        if (text === "") return null;
        const rowCount = await this.count(view);
        // Matches by DuckDB's text forms and lower (§2.4, §3.4); the text is the parameter after the view's.
        const param = `$${view.params.length + 1}`;
        const needle = request.caseSensitive ? param : `lower(${param})`;
        const tests = names.map((name) => {
          const value = `CAST(${quoteIdentifier(name)} AS VARCHAR)`;
          return `coalesce(contains(${request.caseSensitive ? value : `lower(${value})`}, ${needle}), false)`;
        });
        const order = view.order.length > 0 ? ` ORDER BY ${view.order.join(", ")}` : "";
        const sql = `${view.with} SELECT ${tests.join(", ")} FROM vg_view${order}`;
        const matches = (await this.connection.runAndReadAll(sql, [...view.params, text])).getRowsJS();
        const width = names.length;
        const total = rowCount * width;
        const from = request.from as { row: number; column: number };
        let position = from.row * width + from.column;
        for (let step = 0; step < total; step++) {
          position = (position + (request.direction as number) + total) % total;
          if (matches[Math.floor(position / width)][position % width] === true) {
            return { row: Math.floor(position / width), column: position % width };
          }
        }
        return null;
      }
      case "locate": {
        const view = this.view(request);
        const keys = request.keys as RowKey[];
        const rowCount = await this.count(view);
        const read = await this.read(view, 0, rowCount, []);
        const positions = new Map((read.rowIds ?? []).map((id, position) => [id, position]));
        return { rows: keys.map((key) => ("rowId" in key ? (positions.get(key.rowId) ?? null) : null)) };
      }
      default:
        throw new Failure("internal", `This engine does not answer ${request.op}.`);
    }
  }
}

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let engine: Engine;
let ids = 0;

before(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await createTable(connection, "orders", ORDERS);
  engine = new Engine(connection, { orders: ORDERS });
});

after(() => {
  connection.closeSync();
  instance.closeSync();
});

/** Sends a request and checks the response as a client does (§8). */
async function send(op: Operation, members: Json = {}): Promise<Json> {
  const response = (await engine.handle({ v: 2, id: ++ids, op, ...members })) as Json;
  // Responses go over a text transport, as MCP Apps carry them (§8.8).
  const block = (response.result as { block?: { bytes: Uint8Array } } | null)?.block;
  const text = block
    ? JSON.parse(
        JSON.stringify({
          ...response,
          result: { ...(response.result as Json), block: { base64: Buffer.from(block.bytes).toString("base64") } },
        }),
      )
    : response;
  checkResponse(text, op);
  assert.equal(text.id, ids);
  return text;
}

async function opened() {
  const response = await send("open", { ref: "orders" });
  return (response.result as { table: string }).table;
}

function rowsOf(response: Json) {
  const result = response.result as { block: { base64: string } };
  return decodeBlock(new Uint8Array(Buffer.from(result.block.base64, "base64")));
}

test("open gives TableInfo, and info and changes follow it", async () => {
  const response = await send("open", { ref: "orders" });
  const info = response.result as { table: string; columns: Column[]; rowCount: number };
  assert.deepEqual(info.columns, ORDERS.columns);
  assert.equal(info.rowCount, 5);
  assert.deepEqual((await send("info", { table: info.table })).result, info);
  assert.deepEqual((await send("changes", { table: info.table })).result, {
    revision: "r1",
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
    revision: "r1",
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
  assert.deepEqual(block.columns, [ORDERS.columns[0], ORDERS.columns[1], ORDERS.columns[3]]);
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
    revision: "r1",
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

test("over HTTP, the block is attached after the JSON (§8.8)", async () => {
  const table = await opened();
  const response = (await engine.handle({
    v: 2,
    id: 99,
    op: "rows",
    table,
    revision: "r1",
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
    revision: "r1",
    plan: {},
    ranges: [
      [1, 3],
      [3, 5],
    ],
    columns: ["region", "qty"],
  });
  assert.deepEqual(response.result, { count: 6, numericCount: 3, sum: 8, min: 1, max: 5, average: 8 / 3 });
  const none = await send("summarize", { table, revision: "r1", plan: {}, ranges: [[3, 4]], columns: ["region"] });
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
        revision: "r1",
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
      revision: "r1",
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
  assert.equal((await error({ op: "open", ref: "/etc/passwd" })).code, "not_allowed");
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
      revision: "r1",
      plan,
      start: 0,
      end: 5,
      columns: columns.map((column) => column.name),
    });
    const result = response.result as { view: { columns: Column[]; rowCount: number }; rowIds: number[] };
    return {
      table: columns,
      revision: "r1",
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
  const located = await send("locate", { table, revision: "r1", plan, keys: [{ rowId: 4 }] });
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

test("text forms of dates, times, timestamps and intervals are DuckDB's (§2.4)", async () => {
  const one = async (sql: string) => (await connection.runAndReadAll(sql)).getRowsJS()[0];
  for (const text of ["1969-12-31 23:59:59.999999999", "2200-01-01 00:00:00.123456789", "2024-01-31 12:00:00.5"]) {
    const [cast, count] = await one(`SELECT CAST(TIMESTAMP_NS '${text}' AS VARCHAR), epoch_ns(TIMESTAMP_NS '${text}')`);
    assert.equal(timestampText(BigInt(count as bigint), "ns"), cast);
  }
  for (const text of ["0001-01-01 00:00:00", "1969-12-31 23:59:59.999999", "9999-12-31 23:59:59.25"]) {
    const [cast, count] = await one(`SELECT CAST(TIMESTAMP '${text}' AS VARCHAR), epoch_us(TIMESTAMP '${text}')`);
    assert.equal(timestampText(BigInt(count as bigint), "us"), cast);
  }
  const [ms, msCount] = await one(
    "SELECT CAST(TIMESTAMP_MS '1969-12-31 23:59:59.5' AS VARCHAR), epoch_ms(TIMESTAMP_MS '1969-12-31 23:59:59.5')",
  );
  assert.equal(timestampText(BigInt(msCount as bigint), "ms"), ms);
  const [s, sCount] = await one(
    "SELECT CAST(TIMESTAMP_S '1900-03-01 00:00:01' AS VARCHAR), CAST(epoch(TIMESTAMP_S '1900-03-01 00:00:01') AS BIGINT)",
  );
  assert.equal(timestampText(BigInt(s === null ? 0 : (sCount as bigint)), "s"), s);
  for (const text of ["0001-01-01", "1969-12-31", "2000-02-29", "9999-12-31"]) {
    const [cast, days] = await one(
      `SELECT CAST(DATE '${text}' AS VARCHAR), date_diff('day', DATE '1970-01-01', DATE '${text}')`,
    );
    assert.equal(dateText(Number(days)), cast);
  }
  for (const text of ["00:00:00", "23:59:59.999999", "12:00:00.25"]) {
    const [cast, micros] = await one(
      `SELECT CAST(TIME '${text}' AS VARCHAR), date_diff('microsecond', TIME '00:00:00', TIME '${text}')`,
    );
    assert.equal(timeText(BigInt(micros as bigint)), cast);
  }
  const intervals: [number, number, number][] = [
    [14, 3, 14_706_789_000],
    [0, 0, -5_400_000_000],
    [0, 0, 0],
    [0, 0, 129_600_000_000],
    [1, 1, 0],
    [-14, -1, 0],
    [12, 0, 1],
    [-1, 2, -1],
  ];
  for (const [months, days, micros] of intervals) {
    const [cast] = await one(
      `SELECT CAST(to_months(${months}) + to_days(${days}) + to_microseconds(${micros}) AS VARCHAR)`,
    );
    assert.equal(intervalText({ months, days, nanos: BigInt(micros) * 1000n }), cast, `${months} ${days} ${micros}`);
  }
});
