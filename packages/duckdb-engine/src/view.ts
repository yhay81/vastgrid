/**
 * The views of a table (docs/v2-spec.md §4, §8.2): a plan compiled to SQL by `vastgrid-sql` over the table's
 * relation, and what `rows`, `locate`, `summarize` and `find` read from it.
 *
 * A view without `where`, `aggregate` and `sort` holds every row in row ID order, so its positions are the row IDs:
 * it is read by them, which DuckDB looks up without reading the rows before them, at any depth of the file. Other
 * views store their total order once and read position ranges from that storage.
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
  type SqlSource,
  type SqlView,
} from "vastgrid-sql";
import { readExpression, readValue, valueExpression } from "./columns.js";
import { cancelled, EngineError } from "./errors.js";
import { Gate, type Session } from "./session.js";
import type { LoadedTable } from "./table.js";
import { type Build, ViewCache } from "./view-cache.js";

/** What the engine evaluates (§4.10): every plan member, function and measure that `vastgrid-sql` compiles. */
export const CAPABILITIES: Capabilities = {
  plan: { derive: true, where: true, aggregate: true, pivot: true, having: true, sort: true, search: true },
  summarize: true,
  find: true,
  locate: true,
  write: true,
  save: false,
  preview: true,
  partialViews: false,
  changes: "push",
};

export interface ViewOptions {
  /** Cached views per engine, excluding requests currently reading them. Default 8. */
  maxViews?: number;
  /** Above this input size keep only row IDs in view order. Default 20 million. */
  materializeRows?: number;
  /** Input rows above which a sort can give its first rows before it finishes. Default 1 million. */
  viewPreviewMinRows?: number;
  /** Rows held by a sort's preview. Default 1,000. */
  viewPreviewRows?: number;
}

export interface View {
  plan: CheckedPlan;
  sql: SqlView;
  source: SqlSource;
  /** Every row in row ID order: positions are row IDs. */
  positional: boolean;
  rowCount: number;
  readableRows: number;
  ready: boolean;
  /** The saved position, or the row ID of a view in source order. */
  position: string;
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
  return { with: view.sql.with, from: "vg_view", position: view.position };
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
  private readonly cache: ViewCache<View>;
  private readonly builds = new Gate(1);

  constructor(
    private readonly session: Session,
    private readonly textLimit: number,
    private readonly options: ViewOptions = {},
    private readonly changed: (table: LoadedTable, view: View) => void = () => {},
  ) {
    this.cache = new ViewCache(options.maxViews ?? 8);
  }

  private async use<T>(
    table: LoadedTable,
    request: Json,
    signal: AbortSignal | undefined,
    read: (view: View) => Promise<T>,
  ) {
    const relation = table.requireRelation();
    const checked = checkPlan(request.plan, table.columns, planOptions(CAPABILITIES));
    const normal = normalizePlan(checked.plan);
    if (table.status !== "ready" && Object.keys(normal).length > 0) {
      throw new EngineError("not_ready", "The table is still loading: until it has, only its rows are read (§9).");
    }
    // Views hold the values of one edits version (§8.3). A new relation replaces a file-loading preview.
    const key = `${table.revision}\u0000${relation.sql}\u0000${table.edits.version}\u0000${canonicalJson(normal)}`;
    return this.cache.use(
      table,
      key,
      request.table as string,
      request.preview === true,
      signal,
      (signal) => this.make(table, checked, relation, request.preview === true, signal),
      read,
    );
  }

  private make(
    table: LoadedTable,
    plan: CheckedPlan,
    relation: { sql: string; rowId: string; rows: number },
    preview: boolean,
    signal: AbortSignal,
  ): Build<View> {
    const objects: string[] = [];
    let resolveFirst!: (view: View) => void;
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<View>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const done = this.builds.run(async () => {
      if (signal.aborted) throw cancelled();
      const source = { relation: relation.sql, rowId: relation.rowId };
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
      const hash = await planHash(plan.plan);
      const position = freeName("vg_position", sql.columns);
      let rowCount = relation.rows;
      if (plan.where || plan.aggregate) {
        const query = countQuery(sql);
        const read = await this.session.withConnection(signal, (connection) =>
          connection.runAndReadAll(query.sql, query.params as never),
        );
        rowCount = Number(read.getRowsJS()[0][0]);
      }
      const base: View = {
        plan,
        sql,
        source,
        positional,
        hash,
        position: positional ? (sql.rowId as string) : position,
        rowCount,
        readableRows: rowCount,
        ready: true,
      };
      if (positional) {
        resolveFirst(base);
        return base;
      }
      const canPreview =
        preview && plan.sort.length > 0 && relation.rows >= (this.options.viewPreviewMinRows ?? 1_000_000);
      if (canPreview) {
        const head = await this.materialize(base, objects, false, this.options.viewPreviewRows ?? 1000, signal);
        head.ready = head.readableRows === rowCount;
        resolveFirst(head);
        if (head.ready) return head;
      }
      const orderOnly = sql.rowIds && relation.rows > (this.options.materializeRows ?? 20_000_000);
      const result = await this.materialize(base, objects, orderOnly, undefined, signal);
      if (signal.aborted) throw cancelled();
      resolveFirst(result);
      if (canPreview) this.changed(table, result);
      return result;
    });
    void done.catch(rejectFirst);
    return {
      first,
      done,
      dispose: () =>
        this.session.withConnection(undefined, async (connection) => {
          for (const name of objects) await connection.run(`DROP TABLE IF EXISTS ${name}`);
        }),
    };
  }

  /** Stores the total order once. Internal columns have fixed names, so even a user column `rowid` is safe. */
  private async materialize(
    view: View,
    objects: string[],
    orderOnly: boolean,
    limit: number | undefined,
    signal: AbortSignal,
  ): Promise<View> {
    const name = quoteIdentifier(this.session.createName("vg_order"));
    objects.push(name);
    const sql = view.sql;
    const outputs = orderOnly ? [] : sql.columns.map((column, index) => `${quoteIdentifier(column.name)} AS c${index}`);
    if (sql.rowId) outputs.push(`${sql.rowId} AS source_id`);
    const order = sql.order.length ? ` ORDER BY ${sql.order.join(", ")}` : "";
    const suffix = limit === undefined ? "" : ` LIMIT ${limit}`;
    await this.session.withConnection(signal, (connection) =>
      connection.run(
        `CREATE TABLE ${name} AS ${sql.with} SELECT ${outputs.join(", ")} FROM vg_view${order}${suffix}`,
        sql.params as never,
      ),
    );
    if (signal.aborted) throw cancelled();
    const position = view.position;
    let saved: SqlView;
    if (orderOnly) {
      // Derived columns are evaluated only for the rows being read. The filter and sort were already applied.
      const plain = compileView(checkPlan({ derive: view.plan.plan.derive }, view.plan.table), view.source);
      const selected = sql.columns.map((column) => `s.${quoteIdentifier(column.name)}`);
      saved = {
        ...sql,
        with: `WITH vg_view AS (SELECT ${[...selected, `s.${plain.rowId} AS ${sql.rowId}`, `o.rowid AS ${position}`].join(", ")} FROM ${name} o JOIN (${plain.with} SELECT * FROM vg_view) s ON o.source_id = s.${plain.rowId})`,
        params: plain.params,
        order: [position],
      };
    } else {
      const selected = sql.columns.map((column, index) => `c${index} AS ${quoteIdentifier(column.name)}`);
      if (sql.rowId) selected.push(`source_id AS ${sql.rowId}`);
      selected.push(`rowid AS ${position}`);
      saved = {
        ...sql,
        with: `WITH vg_view AS (SELECT ${selected.join(", ")} FROM ${name})`,
        params: [],
        order: [position],
      };
    }
    return {
      ...view,
      sql: saved,
      readableRows: Math.min(view.rowCount, limit ?? view.rowCount),
    };
  }

  unfollow(handle: string) {
    this.cache.unfollow(handle);
  }

  forget(table?: LoadedTable) {
    return this.cache.forget(table);
  }

  /** The answer of `rows` (§8.2): positions `[start, end)` of the view, cut at its row count, as a block (§8.4). */
  async rows(table: LoadedTable, request: Json, signal?: AbortSignal): Promise<Json> {
    return this.use(table, request, signal, (view) => this.rowsOf(table, view, request, signal));
  }

  private async rowsOf(table: LoadedTable, view: View, request: Json, signal?: AbortSignal): Promise<Json> {
    const names = request.columns as string[];
    const columns = columnsOf(view, names);
    const start = request.start as number;
    const end = Math.max(start, Math.min(request.end as number, view.readableRows));
    const limit = (request.textLimit as number | undefined) ?? this.textLimit;
    const read =
      end > start
        ? await this.session.withConnection(signal, (connection) =>
            this.read(connection, view, columns, start, end, limit),
          )
        : { rows: [], rowIds: view.sql.rowIds ? [] : null, truncated: {} };
    const ready = table.status === "ready" && view.ready;
    const result: Json = {
      view: {
        hash: view.hash,
        status: ready ? "ready" : "building",
        rowCount: view.rowCount,
        rowCountExact: table.status === "ready",
        readableRows: view.readableRows,
        columns: view.sql.columns,
        edits: table.edits.state,
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
    const outputs = columns.map((column) => select(column, quoteIdentifier(column.name)));
    if (view.sql.rowId) outputs.push(view.sql.rowId);
    if (outputs.length === 0) outputs.push("NULL");
    const params = [...view.sql.params, start, end];
    const query = {
      sql: `${view.sql.with} SELECT ${outputs.join(", ")} FROM vg_view WHERE ${view.position} >= $${params.length - 1} AND ${view.position} < $${params.length} ORDER BY ${view.position}`,
      params,
    };
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
    return this.use(table, request, signal, (view) => this.locateOf(view, request, signal));
  }

  private async locateOf(view: View, request: Json, signal?: AbortSignal): Promise<Json> {
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
    return this.use(table, request, signal, (view) => this.summarizeOf(view, request, signal));
  }

  private async summarizeOf(view: View, request: Json, signal?: AbortSignal): Promise<Json> {
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
    return this.use(table, request, signal, (view) => this.findOf(view, request, signal));
  }

  private async findOf(view: View, request: Json, signal?: AbortSignal): Promise<Json | null> {
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
