/**
 * A small engine for the store's tests: one table in memory, plans `{}` and `sort` by one number or string
 * column, the count of each value of a column (an `aggregate` of one key and `count`, by count then value), and
 * requests that wait until the test lets them through. `vastgrid-js` is the real engine.
 */
import {
  type Capabilities,
  type Column,
  checkPlan,
  checkRequest,
  encodeBlock,
  type JsonValue,
  type Plan,
  ProtocolError,
  planHash,
  planOptions,
} from "vastgrid-spec";
import type { Engine } from "../src/core.ts";

export interface FakeTable {
  columns: Column[];
  rows: JsonValue[][];
}

type Json = Record<string, unknown>;

export interface FakeEngine extends Engine {
  /** Requests received, in order. */
  readonly requests: Json[];
  /** Holds the answers of `rows` until `release` (all of them, or those of a plan). */
  hold(): void;
  release(): void;
  /** Sends an event to the subscribers. */
  send(event: Json): void;
  /** Tables open now. */
  readonly open: Set<string>;
}

export const CAPABILITIES: Capabilities = {
  plan: { derive: false, where: false, aggregate: false, pivot: false, having: false, sort: true, search: false },
  functions: [],
  measures: [],
  summarize: true,
  find: false,
  locate: true,
  write: false,
  save: false,
  preview: false,
  partialViews: false,
  changes: "push",
};

export function fakeEngine(table: FakeTable, capabilities: Capabilities = CAPABILITIES): FakeEngine {
  const requests: Json[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const open = new Set<string>();
  let held = false;
  let waiting: (() => void)[] = [];
  let next = 1;
  const revision = "r1";

  const order = (plan: Plan): number[] => {
    const ids = table.rows.map((_, index) => index);
    const key = plan.sort?.[0];
    if (!key) return ids;
    const index = table.columns.findIndex((column) => column.name === key.column);
    const sign = key.direction === "asc" ? 1 : -1;
    return ids.sort((a, b) => {
      const x = table.rows[a][index];
      const y = table.rows[b][index];
      if (x === y) return a - b;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sign;
    });
  };

  /** An aggregate without keys: `count`, `sum`, `min` and `max` over every row, as floats but for counts. */
  const measures = async (plan: Plan) => {
    const list = plan.aggregate?.measures ?? [];
    const row = list.map((measure): JsonValue => {
      const index = table.columns.findIndex((column) => column.name === measure.column);
      const values = table.rows.map((item) => (index < 0 ? 1 : item[index])).filter((value) => value !== null);
      if (measure.fn === "count") return values.length;
      const numbers = values.map(Number);
      if (numbers.length === 0) return null;
      if (measure.fn === "sum") return numbers.reduce((a, b) => a + b, 0);
      return measure.fn === "min" ? Math.min(...numbers) : Math.max(...numbers);
    });
    const columns: Column[] = list.map((measure) =>
      measure.fn === "count" ? { name: measure.name, type: "bigint" } : { name: measure.name, type: "float", bits: 64 },
    );
    return {
      view: {
        hash: await planHash(plan),
        status: "ready",
        rowCount: 1,
        rowCountExact: true,
        readableRows: 1,
        columns,
        edits: { version: 0, cells: 0 },
      },
      start: 0,
      end: 1,
      rowIds: null,
      block: { bytes: encodeBlock(columns, [row]) },
    };
  };

  const counts = async (plan: Plan, start: number, end: number) => {
    if (plan.aggregate?.keys.length === 0) return measures(plan);
    const [key] = plan.aggregate?.keys ?? [];
    const measure = plan.aggregate?.measures[0]?.name ?? "count";
    const index = table.columns.findIndex((column) => column.name === key);
    const counted = new Map<JsonValue, number>();
    for (const row of table.rows) counted.set(row[index], (counted.get(row[index]) ?? 0) + 1);
    const groups = [...counted].sort(
      ([x, a], [y, b]) => b - a || (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1),
    );
    const columns: Column[] = [table.columns[index], { name: measure, type: "bigint" }];
    const slice = groups.slice(start, Math.max(start, end));
    return {
      view: {
        hash: await planHash(plan),
        status: "ready",
        rowCount: groups.length,
        rowCountExact: true,
        readableRows: groups.length,
        columns,
        edits: { version: 0, cells: 0 },
      },
      start,
      end: start + slice.length,
      rowIds: null,
      block: { bytes: encodeBlock(columns, slice) },
    };
  };

  const answer = async (request: Json & { op: string }): Promise<unknown> => {
    switch (request.op) {
      case "open": {
        const id = `t${next++}`;
        open.add(id);
        return info(id);
      }
      case "info":
        return info(request.table as string);
      case "close":
        open.delete(request.table as string);
        return null;
      case "rows": {
        if (held) await new Promise<void>((resolve) => waiting.push(resolve));
        const plan = request.plan as Plan;
        checkPlan(plan, table.columns, planOptions(capabilities));
        if (plan.aggregate) return counts(plan, request.start as number, request.end as number);
        const ids = order(plan);
        const start = request.start as number;
        const end = Math.min(request.end as number, ids.length);
        const names = request.columns as string[];
        const columns = names.map((name) => table.columns.find((column) => column.name === name) as Column);
        const slice = ids.slice(start, Math.max(start, end));
        const rows = slice.map((id) =>
          names.map((name) => table.rows[id][table.columns.findIndex((c) => c.name === name)]),
        );
        return {
          view: {
            hash: await planHash(plan),
            status: "ready",
            rowCount: ids.length,
            rowCountExact: true,
            readableRows: ids.length,
            columns: table.columns,
            edits: { version: 0, cells: 0 },
          },
          start,
          end: start + slice.length,
          rowIds: slice,
          block: { bytes: encodeBlock(columns, rows) },
        };
      }
      case "locate": {
        const ids = order(request.plan as Plan);
        return {
          rows: (request.keys as { rowId?: number }[]).map((key) => {
            const at = ids.indexOf(key.rowId ?? -1);
            return at < 0 ? null : at;
          }),
        };
      }
      case "summarize":
        return { count: 0, numericCount: 0, sum: null, min: null, max: null, average: null };
      default:
        throw Object.assign(new Error(`${request.op} is not offered.`), { code: "internal" });
    }
  };

  const info = (id: string) => ({
    table: id,
    revision,
    edits: { version: 0, cells: 0 },
    status: "ready",
    progress: 1,
    rowCount: table.rows.length,
    readableRows: table.rows.length,
    columns: table.columns,
    capabilities,
  });

  return {
    requests,
    open,
    async handle(message: unknown) {
      let request: Json & { id: number; op: string };
      try {
        request = checkRequest(message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return {
          v: 2,
          id: 0,
          error: { code: error.code, message: error.message, path: error.path, reason: error.reason },
        };
      }
      requests.push(request);
      if (request.op === "cancel") return undefined;
      try {
        return { v: 2, id: request.id, result: await answer(request) };
      } catch (error) {
        const code = (error as { code?: string }).code ?? "invalid_plan";
        return { v: 2, id: request.id, error: { code, message: (error as Error).message } };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      const resolve = waiting;
      waiting = [];
      for (const go of resolve) go();
    },
    send(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

/** A table of `count` rows: an integer `id`, a string `name` and a float `score`. */
export function numbers(count: number): FakeTable {
  return {
    columns: [
      { name: "id", type: "integer" },
      { name: "name", type: "string" },
      { name: "score", type: "float", bits: 64 },
    ],
    rows: Array.from({ length: count }, (_, index) => [index, `name ${index}`, (index * 7919) % 1000]),
  };
}

/** Waits until the store's promises and timers of this turn have run. */
export function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
