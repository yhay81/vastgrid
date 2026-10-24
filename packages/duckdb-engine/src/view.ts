/**
 * The views of a table (docs/v2-spec.md §4, §8.2): a plan compiled to SQL by `vastgrid-sql` over the table's
 * relation, and what `rows`, `locate`, `summarize` and `find` read from it.
 *
 * A view without `where`, `aggregate` and `sort` holds every row in row ID order, so its positions are the row IDs:
 * it is read by them, which DuckDB looks up without reading the rows before them, at any depth of the file. Other
 * views are read in their order with offsets.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  type Capabilities,
  type CheckedPlan,
  type Column,
  canonicalJson,
  checkPlan,
  encodeBlock,
  floatJson,
  type JsonValue,
  normalizePlan,
  planHash,
  planOptions,
  type RowKey,
} from "vastgrid-spec";
import {
  compileView,
  countQuery,
  type PivotCombinations,
  pivotQuery,
  quoteIdentifier,
  rowsQuery,
  type SqlView,
} from "vastgrid-sql";
import { readExpression, readValue, valueExpression } from "./columns.js";
import { EngineError } from "./errors.js";
import type { Session } from "./session.js";
import type { LoadedTable } from "./table.js";

/** What the engine evaluates (§4.10): every plan member, function and measure that `vastgrid-sql` compiles. */
export const CAPABILITIES: Capabilities = {
  plan: { derive: true, where: true, aggregate: true, pivot: true, having: true, sort: true, search: true },
  summarize: true,
  find: true,
  locate: true,
  write: false,
  save: false,
  preview: false,
  partialViews: false,
  changes: "push",
};

/** Views kept per table, the least recently used dropped first. */
const VIEWS = 16;

export interface View {
  plan: CheckedPlan;
  sql: SqlView;
  /** Every row in row ID order: positions are row IDs. */
  positional: boolean;
  rowCount: number;
  hash: string;
}

type Json = Record<string, unknown>;

const NUMERIC = new Set(["integer", "bigint", "decimal", "float"]);

/** A name that no column of the view has, for a column that a query adds. */
function freeName(base: string, columns: readonly Column[]) {
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  let name = base;
  while (names.has(name)) name = `${name}_`;
  return quoteIdentifier(name);
}

/** The view's rows with their positions: `from` is a relation with a column `position`. */
function positioned(view: View): { with: string; from: string; position: string } {
  if (view.positional) return { with: view.sql.with, from: "vg_view", position: view.sql.rowId as string };
  const position = freeName("vg_position", view.sql.columns);
  return {
    with: `${view.sql.with}, vg_positioned AS (SELECT *, row_number() OVER (ORDER BY ${view.sql.order.join(", ")}) - 1 AS ${position} FROM vg_view)`,
    from: "vg_positioned",
    position,
  };
}

function columnsOf(view: View, names: readonly string[]): Column[] {
  return names.map((name, index) => {
    const column = view.sql.columns.find((item) => item.name === name);
    if (!column) {
      throw new EngineError("invalid_request", `The view has no column "${name}".`, {
        path: `/columns/${index}`,
        reason: "syntax",
      });
    }
    return column;
  });
}

/** The views of the open tables of an engine, kept by table, relation and plan. */
export class Views {
  private readonly views = new Map<string, Promise<View>>();

  constructor(
    private readonly session: Session,
    private readonly textLimit: number,
  ) {}

  /** The view of a plan over a table (§4.7, §9); throws `PlanError` for a plan that does not validate. */
  async view(table: LoadedTable, plan: unknown, signal?: AbortSignal): Promise<View> {
    const relation = table.requireRelation();
    const checked = checkPlan(plan, table.columns, planOptions(CAPABILITIES));
    const normal = normalizePlan(checked.plan);
    if (table.status !== "ready" && Object.keys(normal).length > 0) {
      throw new EngineError("not_ready", "The table is still loading: until it has, only its rows are read (§9).");
    }
    const key = `${table.revision}\u0000${relation.sql}\u0000${canonicalJson(normal)}`;
    const cached = this.views.get(key);
    if (cached) {
      this.views.delete(key);
      this.views.set(key, cached);
      return cached;
    }
    const made = this.make(checked, relation.sql, relation.rowId, relation.rows, signal);
    this.views.set(key, made);
    made.catch(() => this.views.delete(key));
    while (this.views.size > VIEWS) this.views.delete(this.views.keys().next().value as string);
    return made;
  }

  private async make(
    plan: CheckedPlan,
    relation: string,
    rowId: string,
    rows: number,
    signal?: AbortSignal,
  ): Promise<View> {
    const source = { relation, rowId };
    let combinations: PivotCombinations | undefined;
    if (plan.aggregate?.pivot) {
      const query = pivotQuery(plan, source);
      const read = await this.session.withConnection(signal, (connection) =>
        connection.runAndReadAll(query.sql, query.params as never),
      );
      combinations = read.getRowsJS().map((row) => row.map((value) => (value === null ? null : String(value))));
    }
    const sql = compileView(plan, source, combinations);
    const positional = !plan.where && !plan.aggregate && plan.sort.length === 0;
    let rowCount = rows;
    if (!positional) {
      const query = countQuery(sql);
      const read = await this.session.withConnection(signal, (connection) =>
        connection.runAndReadAll(query.sql, query.params as never),
      );
      rowCount = Number(read.getRowsJS()[0][0]);
    }
    return { plan, sql, positional, rowCount, hash: await planHash(plan.plan) };
  }

  /** Forgets the views of a table, once it is closed. */
  forget(table: LoadedTable) {
    const prefix = `${table.revision}\u0000${table.relation?.sql ?? ""}\u0000`;
    for (const key of [...this.views.keys()]) if (key.startsWith(prefix)) this.views.delete(key);
  }

  /** The answer of `rows` (§8.2): positions `[start, end)` of the view, cut at its row count, as a block (§8.4). */
  async rows(table: LoadedTable, request: Json, signal?: AbortSignal): Promise<Json> {
    const view = await this.view(table, request.plan, signal);
    const names = request.columns as string[];
    const columns = columnsOf(view, names);
    const start = request.start as number;
    const end = Math.max(start, Math.min(request.end as number, view.rowCount));
    const limit = (request.textLimit as number | undefined) ?? this.textLimit;
    const read =
      end > start
        ? await this.session.withConnection(signal, (connection) =>
            this.read(connection, view, columns, start, end, limit),
          )
        : { rows: [], rowIds: view.sql.rowIds ? [] : null, truncated: {} };
    const ready = table.status === "ready";
    const result: Json = {
      view: {
        hash: view.hash,
        status: ready ? "ready" : "building",
        rowCount: view.rowCount,
        rowCountExact: ready,
        readableRows: view.rowCount,
        columns: view.sql.columns,
        edits: { version: 0, cells: 0 },
      },
      start,
      end: start + read.rows.length,
      rowIds: read.rowIds,
      block: { bytes: encodeBlock(columns, read.rows) },
    };
    if (Object.keys(read.truncated).length > 0) result.truncated = read.truncated;
    return result;
  }

  private async read(
    connection: DuckDBConnection,
    view: View,
    columns: Column[],
    start: number,
    end: number,
    limit: number,
  ) {
    const select = (column: Column, sql: string) => readExpression(column, sql, limit);
    let query: { sql: string; params: unknown[] };
    if (view.positional) {
      const rowId = view.sql.rowId as string;
      const outputs = columns.map((column) => select(column, quoteIdentifier(column.name)));
      const params = [...view.sql.params, start, end];
      query = {
        sql: `${view.sql.with} SELECT ${[...outputs, rowId].join(", ")} FROM vg_view WHERE ${rowId} >= $${params.length - 1} AND ${rowId} < $${params.length} ORDER BY ${rowId}`,
        params,
      };
    } else {
      query = rowsQuery(view.sql, { start, end, columns: columns.map((column) => column.name) }, select);
    }
    const data = (await connection.runAndReadAll(query.sql, query.params as never)).getColumnsJS();
    const count = data[0]?.length ?? 0;
    const truncated: Record<string, number[]> = {};
    const rows: JsonValue[][] = Array.from({ length: count }, () => new Array<JsonValue>(columns.length));
    columns.forEach((column, index) => {
      const values = data[index] ?? [];
      const cuts: number[] = [];
      for (let row = 0; row < count; row++) {
        const { value, cut } = readValue(column, values[row]);
        rows[row][index] = value;
        if (cut) cuts.push(row);
      }
      if (cuts.length > 0) truncated[column.name] = cuts;
    });
    const rowIds = view.sql.rowIds ? (data[columns.length] ?? []).map((value) => Number(value)) : null;
    return { rows, rowIds, truncated };
  }

  /** The answer of `locate` (§8.2): the positions of rows by key, null for keys that the view does not have. */
  async locate(table: LoadedTable, request: Json, signal?: AbortSignal): Promise<Json> {
    const view = await this.view(table, request.plan, signal);
    const keys = request.keys as RowKey[];
    const rows: (number | null)[] = keys.map(() => null);
    const byRowId = keys.flatMap((key, index) => ("rowId" in key ? [{ index, value: key.rowId as JsonValue }] : []));
    const byValue = keys.flatMap((key, index) => ("value" in key ? [{ index, value: key.value }] : []));
    if (view.positional) {
      for (const { index, value } of byRowId)
        rows[index] = (value as number) < view.rowCount ? (value as number) : null;
    } else if (view.sql.rowIds) {
      await this.positionsOf(view, byRowId, view.sql.rowId as string, { type: "bigint" }, rows, signal);
    }
    const rowKey = request.rowKey as string | undefined;
    const column = rowKey === undefined ? undefined : view.sql.columns.find((item) => item.name === rowKey);
    if (column && byValue.length > 0)
      await this.positionsOf(view, byValue, quoteIdentifier(column.name), column, rows, signal);
    return { rows };
  }

  /** Puts the first position of each value of a column into `rows`. */
  private async positionsOf(
    view: View,
    keys: { index: number; value: JsonValue }[],
    sql: string,
    type: Column | { type: "bigint" },
    rows: (number | null)[],
    signal?: AbortSignal,
  ) {
    if (keys.length === 0) return;
    const { with: entries, from, position } = positioned(view);
    const params: unknown[] = [...view.sql.params];
    const values = keys.map(({ index, value }) => `(${index}, ${valueExpression(value, type as Column, params)})`);
    const query = `${entries}, vg_keys(i, v) AS (VALUES ${values.join(", ")}) SELECT vg_keys.i, min(${from}.${position}) FROM vg_keys JOIN ${from} ON ${from}.${sql} = vg_keys.v GROUP BY vg_keys.i`;
    const read = await this.session.withConnection(signal, (connection) =>
      connection.runAndReadAll(query, params as never),
    );
    for (const [index, found] of read.getRowsJS()) rows[Number(index)] = found === null ? null : Number(found);
  }

  /** The answer of `summarize` (§8.2): the cells of ranges × columns that are not blank, and their finite numbers. */
  async summarize(table: LoadedTable, request: Json, signal?: AbortSignal): Promise<Json> {
    const view = await this.view(table, request.plan, signal);
    const columns = columnsOf(view, request.columns as string[]);
    const ranges = request.ranges as [number, number][];
    const empty = { count: 0, numericCount: 0, sum: null, min: null, max: null, average: null };
    if (ranges.every(([start, end]) => end <= start)) return empty;
    const { with: entries, from, position } = positioned(view);
    // Positions are integers that the request was checked to hold (§8.1), so they are written into the query.
    const within = ranges.map(([start, end]) => `(${position} >= ${start} AND ${position} < ${end})`).join(" OR ");
    const aggregates = columns.flatMap((column) => {
      const sql = quoteIdentifier(column.name);
      const blank = column.type === "string" ? `(${sql} IS NULL OR ${sql} = '')` : `${sql} IS NULL`;
      const parts = [`count(*) FILTER (WHERE NOT ${blank})`];
      if (NUMERIC.has(column.type)) {
        const number = `CAST(${sql} AS DOUBLE)`;
        const finite = `FILTER (WHERE isfinite(${number}))`;
        parts.push(
          `count(*) ${finite}`,
          `sum(${number}) ${finite}`,
          `min(${number}) ${finite}`,
          `max(${number}) ${finite}`,
        );
      }
      return parts;
    });
    const query = `${entries} SELECT ${aggregates.join(", ")} FROM ${from} WHERE ${within}`;
    const read = await this.session.withConnection(signal, (connection) =>
      connection.runAndReadAll(query, view.sql.params as never),
    );
    const values = read.getRowsJS()[0] ?? [];
    let at = 0;
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const column of columns) {
      count += Number(values[at++]);
      if (!NUMERIC.has(column.type)) continue;
      const numbers = Number(values[at++]);
      const [total, low, high] = [values[at++], values[at++], values[at++]];
      if (numbers === 0) continue;
      numericCount += numbers;
      sum += Number(total);
      min = Math.min(min, Number(low));
      max = Math.max(max, Number(high));
    }
    if (numericCount === 0) return { ...empty, count };
    return { count, numericCount, sum: floatJson(sum), min, max, average: floatJson(sum / numericCount) };
  }

  /**
   * The answer of `find` (§8.2): the first cell after `from` (before it, with −1), row by row and in a row in the
   * order of `columns`, whose text form contains the text, wrapping around and ending with `from` itself.
   */
  async find(table: LoadedTable, request: Json, signal?: AbortSignal): Promise<Json | null> {
    const view = await this.view(table, request.plan, signal);
    const columns = columnsOf(view, request.columns as string[]);
    const text = request.text as string;
    if (text === "" || view.rowCount === 0) return null;
    const forward = request.direction === 1;
    const sensitive = request.caseSensitive === true;
    const from = request.from as { row: number; column: number };
    const row = Math.min(from.row, view.rowCount - 1);
    const { with: entries, from: relation, position } = positioned(view);
    const params: unknown[] = [...view.sql.params, text];
    const needle = sensitive ? `$${params.length}` : `lower($${params.length})`;
    const tests = columns.map((column) => {
      const value = `CAST(${quoteIdentifier(column.name)} AS VARCHAR)`;
      return `coalesce(contains(${sensitive ? value : `lower(${value})`}, ${needle}), false)`;
    });
    return this.session.withConnection(signal, async (connection) => {
      const flags = async (condition: string, order: "ASC" | "DESC") => {
        const query = `${entries} SELECT ${position}, ${tests.join(", ")} FROM ${relation} WHERE ${condition} ORDER BY ${position} ${order} LIMIT 1`;
        const found = (await connection.runAndReadAll(query, params as never)).getRowsJS()[0];
        return found ? { row: Number(found[0]), matches: found.slice(1).map((value) => value === true) } : null;
      };
      const any = `(${tests.join(" OR ")})`;
      const first = (matches: boolean[], after: number) => {
        if (forward) return matches.findIndex((match, index) => match && index > after);
        for (let index = Math.min(after, matches.length) - 1; index >= 0; index--) if (matches[index]) return index;
        return -1;
      };
      const own = await flags(`${position} = ${row}`, "ASC");
      const column = from.column;
      // The cells of the row of `from` after it (before it, with −1).
      if (own) {
        const index = first(own.matches, column);
        if (index >= 0) return { row, column: index };
      }
      // Then the other rows, in order, wrapping around at the end.
      const next = forward
        ? ((await flags(`${position} > ${row} AND ${any}`, "ASC")) ??
          (await flags(`${position} < ${row} AND ${any}`, "ASC")))
        : ((await flags(`${position} < ${row} AND ${any}`, "DESC")) ??
          (await flags(`${position} > ${row} AND ${any}`, "DESC")));
      if (next) {
        const index = forward ? next.matches.indexOf(true) : next.matches.lastIndexOf(true);
        return { row: next.row, column: index };
      }
      // Last, the cells of the row of `from` up to `from` itself.
      if (own) {
        if (forward) {
          const index = own.matches.findIndex((match, at) => match && at <= column);
          if (index >= 0) return { row, column: index };
        } else {
          for (let index = own.matches.length - 1; index >= column; index--)
            if (own.matches[index]) return { row, column: index };
        }
      }
      return null;
    });
  }
}
