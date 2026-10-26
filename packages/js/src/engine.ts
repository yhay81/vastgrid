/**
 * An engine over tables in memory (docs/v2-spec.md §8): it answers the requests of §8.2 about tables that
 * its host gives it as arrays of typed JSON values (§2.2), with views in the order of §3.3.
 */
import {
  answerId,
  type Capabilities,
  type CheckedPlan,
  type Column,
  checkPlan,
  checkRequest,
  type ErrorCode,
  encodeBlock,
  errorResponse,
  type JsonValue,
  keyText,
  MESSAGE_LIMITS,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  planOptions,
  type RowKey,
  sameCellValue,
} from "vastgrid-spec";
import { type ColumnRanks, rankColumn, sortRows } from "./order.js";
import { Summary } from "./summary.js";
import { checkTable, type MemoryTable, shown, TableProblem, valueChecker } from "./table.js";

export interface MemoryEngineOptions {
  /** The tables that `open` opens, by the `ref` that names them. */
  tables: Record<string, MemoryTable>;
}

export interface MemoryEngine {
  /**
   * Answers a request (§8.1) with its response or error, with blocks in the structured encoding (§8.8);
   * `cancel` has no answer. Never throws: a message that does not follow §8 is answered with
   * `invalid_request`.
   */
  handle(message: unknown): Promise<Record<string, unknown> | undefined>;
  /** Listens to the events of §8.5, until the function it gives is called. This engine sends none yet. */
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
}

/** What the engine evaluates (§4.10): plans that only sort, `summarize` and `locate`. */
export const MEMORY_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  plan: Object.freeze({
    derive: false,
    where: false,
    aggregate: false,
    pivot: false,
    having: false,
    sort: true,
    search: false,
  }),
  functions: [],
  measures: [],
  summarize: true,
  find: false,
  locate: true,
  write: false,
  save: false,
  preview: false,
  partialViews: false,
  changes: "poll",
});

/** A copy of the capabilities, for a message; tables that the host makes editable are written (§7). */
function capabilities(write = false): Capabilities {
  return { ...MEMORY_CAPABILITIES, plan: { ...MEMORY_CAPABILITIES.plan }, functions: [], measures: [], write };
}

const PLAN_OPTIONS = planOptions(capabilities());

/** Views that a table keeps, the least recently used forgotten first (§8.3). */
const KEPT_VIEWS = 8;

type Json = Record<string, unknown>;
type Request = Json & { v: 2; id: number; op: Operation };

/** An error of §8.7 that a request is answered with. */
class Failure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { path?: string; reason?: string; details?: Json } = {},
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** A table that is open: its checked columns, its rows, and what the engine computed of them. */
interface Table {
  ref: string;
  columns: Column[];
  /** The index of each column by name. */
  index: Map<string, number>;
  /** The rows as the engine reads them: the host's, with copies of the rows that writes changed. */
  rows: readonly (readonly JsonValue[])[];
  revision: string;
  editable: boolean;
  /** The edits version and the cells written so far (§8.2). */
  edits: { version: number; cells: number };
  /** Cells written, as `row * columns + column`. */
  written: Set<number>;
  /** Row IDs by the key text of a value of a column, made when `write` or `locate` first needs them. */
  keys: Map<number, Map<string, number>>;
  /** The ranks of each column, made when a view first needs them. */
  ranks: (ColumnRanks | undefined)[];
  /** Checks of each column's values (§2.2); a column is checked whole before anything reads all of it. */
  checkers: ((value: unknown, row: number) => void)[];
  /** The columns whose values are all checked. */
  checked: boolean[];
  /** Views by plan hash, the most recently used last. */
  views: Map<string, View>;
  /** The table IDs open on it. */
  open: number;
}

/** A view of a table (§4.2): its rows in order. */
interface View {
  hash: string;
  columns: Column[];
  rowCount: number;
  /** The row ID at each position; null when the view is in row ID order. */
  order: Uint32Array | null;
  /** The position of each row ID, made when `locate` first needs it. */
  positions?: Uint32Array;
  /** For each column that `locate` looked values up in, by its index: the first position of each rank. */
  firsts: Map<number, Int32Array>;
}

/** A request being answered, which `cancel` marks. */
interface Running {
  cancelled: boolean;
}

// The revision of each table that hosts give: its data never changes, so neither does its revision.
const revisions = new WeakMap<object, string>();
let revisionCount = 0;

function revisionOf(table: MemoryTable): string {
  let revision = revisions.get(table);
  if (revision === undefined) {
    revision = `memory-${++revisionCount}`;
    revisions.set(table, revision);
  }
  return revision;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The string cut to `limit` code points, or null when it has no more than that (§8.4). A string of no more
 * UTF-16 units than the limit has no more code points either.
 */
function cut(text: string, limit: number): string | null {
  if (text.length <= limit) return null;
  let units = 0;
  for (let points = 0; points < limit && units < text.length; points++) {
    units += (text.codePointAt(units) as number) > 0xffff ? 2 : 1;
  }
  return units < text.length ? text.slice(0, units) : null;
}

/** `[start, end)` spans within `[0, count)`, sorted, with those that overlap or touch merged. */
function mergeRanges(ranges: readonly (readonly [number, number])[], count: number): [number, number][] {
  const spans = ranges
    .map(([start, end]): [number, number] => [Math.min(start, count), Math.min(end, count)])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

class Engine implements MemoryEngine {
  private readonly sources: Map<string, MemoryTable>;
  /** Tables by ref, while a table ID is open on them. */
  private readonly prepared = new Map<string, Table>();
  /** Tables by table ID. */
  private readonly tables = new Map<string, Table>();
  private readonly running = new Map<number, Running>();
  private readonly listeners = new Set<(event: Json) => void>();
  private nextTable = 1;

  constructor(options: MemoryEngineOptions) {
    if (!isObject(options) || !isObject(options.tables)) {
      throw new TypeError("memoryEngine takes { tables }, the tables that open opens by ref.");
    }
    this.sources = new Map(Object.entries(options.tables));
  }

  subscribe(listener: (event: Json) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async handle(message: unknown): Promise<Json | undefined> {
    let request: Request;
    try {
      request = checkRequest(message);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return errorResponse(answerId(message), "invalid_request", error.message, {
          path: error.path,
          reason: error.reason,
        });
      }
      return errorResponse(answerId(message), "internal", String(error));
    }
    if (request.op === "cancel") {
      const running = this.running.get(request.request as number);
      if (running) running.cancelled = true;
      return undefined;
    }
    const running: Running = { cancelled: false };
    this.running.set(request.id, running);
    try {
      return { v: 2, id: request.id, result: await this.answer(request, running) };
    } catch (error) {
      if (error instanceof Failure) return errorResponse(request.id, error.code, error.message, error.extra);
      if (error instanceof PlanError) {
        return errorResponse(request.id, "invalid_plan", error.message, { path: error.path, reason: error.reason });
      }
      if (error instanceof ProtocolError) {
        return errorResponse(request.id, "invalid_request", error.message, { path: error.path, reason: error.reason });
      }
      return errorResponse(request.id, "internal", error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running.get(request.id) === running) this.running.delete(request.id);
    }
  }

  private async answer(request: Request, running: Running): Promise<unknown> {
    switch (request.op) {
      case "open":
        return this.open(request.ref as string);
      case "info": {
        const id = request.table as string;
        return this.info(id, this.table(request));
      }
      case "changes":
        return { revision: this.table(request).revision, edits: { ...this.table(request).edits } };
      case "reload": {
        // Tables in memory have no file that changes (§7.6): the table is as it is.
        const id = request.table as string;
        return this.info(id, this.table(request));
      }
      case "close": {
        const table = this.table(request);
        this.tables.delete(request.table as string);
        // A table that no ID names any more forgets its ranks and views, unless it holds written values, which
        // every later request sees (§7.2); opening it again checks it again.
        if (--table.open === 0 && table.written.size === 0) this.prepared.delete(table.ref);
        return null;
      }
      case "rows":
        return this.rows(request, running);
      case "summarize":
        return this.summarize(request, running);
      case "locate":
        return this.locate(request, running);
      case "write":
        return this.write(request);
      case "save":
        // A table in memory has no file to write back (§7.5).
        this.table(request);
        throw new Failure(
          "save_unsupported",
          "This engine keeps tables in memory and does not save them (capabilities.save is false).",
        );
      default:
        // find and export: operations that this engine does not offer (§4.10).
        throw new Failure("invalid_request", `This engine does not offer ${request.op} (§4.10).`, {
          path: "/op",
          reason: "unknown_op",
        });
    }
  }

  private open(ref: string) {
    if (!this.sources.has(ref)) throw new Failure("not_allowed", `The host does not open ${shown(ref)}.`);
    const source = this.sources.get(ref) as MemoryTable;
    let table = this.prepared.get(ref);
    if (!table) {
      let columns: Column[];
      try {
        columns = checkTable(source);
      } catch (error) {
        if (!(error instanceof TableProblem)) throw error;
        const at = error.path === "" ? "" : `at ${error.path}, `;
        throw new Failure("load_failed", `The table ${shown(ref)} cannot be read: ${at}${error.message}`);
      }
      table = {
        ref,
        columns,
        index: new Map(columns.map((column, index) => [column.name, index])),
        rows: source.rows,
        revision: revisionOf(source),
        editable: source.editable === true,
        edits: { version: 0, cells: 0 },
        written: new Set(),
        keys: new Map(),
        ranks: columns.map(() => undefined),
        checkers: columns.map((column, index) => valueChecker(column, index)),
        checked: columns.map(() => false),
        views: new Map(),
        open: 0,
      };
      this.prepared.set(ref, table);
    }
    const id = `t${this.nextTable++}`;
    this.tables.set(id, table);
    table.open++;
    return this.info(id, table);
  }

  /** TableInfo (§8.2). */
  private info(id: string, table: Table) {
    return {
      table: id,
      revision: table.revision,
      edits: { ...table.edits },
      status: "ready",
      progress: 1,
      rowCount: table.rows.length,
      readableRows: table.rows.length,
      columns: table.columns.map((column) => ({ ...column })),
      capabilities: capabilities(table.editable),
    };
  }

  /** The table a request names, at the revision it names when it names one (§8.3). */
  private table(request: Json): Table {
    const table = this.tables.get(request.table as string);
    if (!table) throw new Failure("table_not_found", `There is no open table ${shown(request.table)}.`);
    if ("revision" in request && request.revision !== table.revision) {
      throw new Failure("revision_changed", `The table's revision is ${table.revision}; read info again.`);
    }
    return table;
  }

  /** Answers `load_failed` for a value that does not follow §2.2, at its JSON Pointer in the table. */
  private loadFailed(table: Table, error: TableProblem): never {
    throw new Failure(
      "load_failed",
      `The table ${shown(table.ref)} cannot be read: at ${error.path}, ${error.message}`,
    );
  }

  /** Checks every value of a column, once, before something reads all of it. */
  private checkColumn(table: Table, index: number) {
    if (table.checked[index]) return;
    const check = table.checkers[index];
    try {
      for (let row = 0; row < table.rows.length; row++) check(table.rows[row][index], row);
    } catch (error) {
      if (error instanceof TableProblem) this.loadFailed(table, error);
      throw error;
    }
    table.checked[index] = true;
  }

  private ranksOf(table: Table, index: number): ColumnRanks {
    let ranks = table.ranks[index];
    if (!ranks) {
      this.checkColumn(table, index);
      ranks = rankColumn(table.columns[index], table.rows, index);
      table.ranks[index] = ranks;
    }
    return ranks;
  }

  /** The view of a request's plan (§4.7, §8.3): checked against the table, kept by its hash. */
  private async view(table: Table, plan: unknown, running: Running): Promise<View> {
    const checked: CheckedPlan = checkPlan(plan, table.columns, PLAN_OPTIONS);
    const hash = await planHash(checked.plan);
    if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
    const kept = table.views.get(hash);
    if (kept) {
      table.views.delete(hash);
      table.views.set(hash, kept);
      return kept;
    }
    // A key on a column that an earlier key has already sorted by cannot break a tie.
    const used = new Set<number>();
    const keys = [];
    for (const key of checked.sort) {
      const index = table.index.get(key.column.name) as number;
      if (used.has(index)) continue;
      used.add(index);
      keys.push({ ranks: this.ranksOf(table, index), descending: key.direction === "desc" });
    }
    const view: View = {
      hash,
      columns: checked.columns,
      rowCount: table.rows.length,
      order: sortRows(table.rows.length, keys),
      firsts: new Map(),
    };
    table.views.set(hash, view);
    if (table.views.size > KEPT_VIEWS) table.views.delete(table.views.keys().next().value as string);
    return view;
  }

  /** The indexes in the table of columns that a request names, which must be columns of the view. */
  private columnsOf(table: Table, view: View, names: string[]): number[] {
    return names.map((name, at) => {
      const index = table.index.get(name);
      if (index === undefined || !view.columns.some((column) => column.name === name)) {
        throw new Failure("invalid_request", `The view has no column ${shown(name)}.`, {
          path: `/columns/${at}`,
          reason: "syntax",
        });
      }
      return index;
    });
  }

  private async rows(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    const names = request.columns as string[];
    const indexes = this.columnsOf(table, view, names);
    const start = request.start as number;
    const end = Math.max(start, Math.min(request.end as number, view.rowCount));
    const limit = (request.textLimit as number | undefined) ?? MESSAGE_LIMITS.textLimitDefault;
    const columns = indexes.map((index) => table.columns[index]);
    // The values read are checked, of the columns not checked whole (§2.2).
    const checks = indexes.map((index) => (table.checked[index] ? null : table.checkers[index]));
    const rowIds: number[] = [];
    const values: JsonValue[][] = [];
    // By name in a Map: a column may be named "__proto__".
    const truncated = new Map<string, number[]>();
    for (let position = start; position < end; position++) {
      const row = view.order ? view.order[position] : position;
      const source = table.rows[row];
      const offset = position - start;
      rowIds.push(row);
      values.push(
        indexes.map((index, at) => {
          const value = source[index];
          const check = checks[at];
          if (check) {
            try {
              check(value, row);
            } catch (error) {
              if (error instanceof TableProblem) this.loadFailed(table, error);
              throw error;
            }
          }
          if (typeof value !== "string" || columns[at].type !== "string") return value;
          const shorter = cut(value, limit);
          if (shorter === null) return value;
          const offsets = truncated.get(names[at]);
          if (!offsets) truncated.set(names[at], [offset]);
          else if (offsets[offsets.length - 1] !== offset) offsets.push(offset);
          return shorter;
        }),
      );
    }
    return {
      view: {
        hash: view.hash,
        status: "ready",
        rowCount: view.rowCount,
        rowCountExact: true,
        readableRows: view.rowCount,
        columns: view.columns.map((column) => ({ ...column })),
        edits: { ...table.edits },
      },
      start,
      end,
      rowIds,
      block: { bytes: encodeBlock(columns, values) },
      ...(truncated.size > 0 ? { truncated: Object.fromEntries(truncated) } : {}),
    };
  }

  private async summarize(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    // The cells of ranges × columns: each cell once, however the ranges overlap or a column repeats.
    const indexes = [...new Set(this.columnsOf(table, view, request.columns as string[]))];
    const spans = mergeRanges(request.ranges as [number, number][], view.rowCount);
    const rows = new Uint32Array(spans.reduce((total, [start, end]) => total + end - start, 0));
    let at = 0;
    for (const [start, end] of spans) {
      for (let position = start; position < end; position++) rows[at++] = view.order ? view.order[position] : position;
    }
    const summary = new Summary();
    for (const index of indexes) {
      this.checkColumn(table, index);
      summary.add(table.columns[index], table.rows, index, rows);
    }
    return summary.result();
  }

  private async locate(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    const keys = request.keys as RowKey[];
    let column: number | undefined;
    if (request.rowKey !== undefined) {
      column = table.index.get(request.rowKey as string);
      if (column === undefined) {
        throw new Failure("invalid_request", `The table has no column ${shown(request.rowKey)}.`, {
          path: "/rowKey",
          reason: "syntax",
        });
      }
    } else if (keys.some((key) => "value" in key)) {
      throw new Failure("invalid_request", "Keys by value need rowKey, the column of their values (§5.3).", {
        path: "/rowKey",
        reason: "syntax",
      });
    }
    return {
      rows: keys.map((key) => {
        if ("rowId" in key) return this.positionOf(view, key.rowId);
        // The first position in the view of a row whose value equals the key's (§3.1).
        const ranks = this.ranksOf(table, column as number);
        const rank = ranks.rankOf(key.value);
        if (rank < 0) return null;
        const first = this.firstsOf(view, column as number, ranks)[rank];
        return first < 0 ? null : first;
      }),
    };
  }

  /** The row ID of a row key (§5.3): `{ rowId }`, or `{ value }` of `rowKey`'s column; null when no row has it. */
  private rowOf(table: Table, key: RowKey, column: number | undefined): number | null {
    if ("rowId" in key) return Number.isSafeInteger(key.rowId) && key.rowId < table.rows.length ? key.rowId : null;
    if (column === undefined) return null;
    let byText = table.keys.get(column);
    if (!byText) {
      this.checkColumn(table, column);
      byText = new Map();
      for (let row = table.rows.length - 1; row >= 0; row--) {
        const value = table.rows[row][column];
        if (value !== null) byText.set(keyText({ value }), row);
      }
      table.keys.set(column, byText);
    }
    return byText.get(keyText(key)) ?? null;
  }

  /**
   * Writes cells (§7.2): every update or none. Values are checked as their column's type, `previous` against the
   * cell's value now, and the written rows replace the host's rows in the engine's own list of rows.
   */
  private write(request: Json) {
    const table = this.table(request);
    const updates = request.updates as { key: RowKey; column: string; value: JsonValue; previous?: JsonValue }[];
    let keyColumn: number | undefined;
    if (request.rowKey !== undefined) {
      keyColumn = table.index.get(request.rowKey as string);
      if (keyColumn === undefined) {
        throw new Failure("invalid_request", `The table has no column ${shown(request.rowKey)}.`, {
          path: "/rowKey",
          reason: "syntax",
        });
      }
    }
    const width = table.columns.length;
    const changes = updates.map((update, at) => {
      const index = table.index.get(update.column);
      const column = index === undefined ? undefined : table.columns[index];
      if (
        index === undefined ||
        !column ||
        !table.editable ||
        column.readOnly ||
        column.type === "interval" ||
        column.type === "binary"
      ) {
        throw new Failure("read_only", `The cells of ${shown(update.column)} are not written (§7.1).`, {
          details: { column: update.column },
        });
      }
      const row = this.rowOf(table, update.key, keyColumn);
      if (row === null) {
        throw new Failure("edit_conflict", "No row has this key now.", { details: { update: at } });
      }
      try {
        table.checkers[index](update.value, row);
      } catch (error) {
        if (!(error instanceof TableProblem)) throw error;
        throw new Failure("invalid_value", `${shown(update.value)} is not a value of ${shown(update.column)}.`, {
          path: `/updates/${at}/value`,
          reason: "type",
          details: { update: at },
        });
      }
      const now = table.rows[row][index];
      if (update.previous !== undefined && !sameCellValue(now, update.previous, column)) {
        throw new Failure("edit_conflict", "The cell holds another value now.", { details: { update: at } });
      }
      return { row, index, value: update.value };
    });
    if (changes.length === 0) return { updated: 0, edits: { ...table.edits } };
    // The host's rows stay as they were: the engine reads its own list, with copies of the rows it wrote.
    if (table.written.size === 0) table.rows = [...table.rows];
    const rows = table.rows as JsonValue[][];
    const copied = new Set<number>();
    for (const { row, index, value } of changes) {
      if (!copied.has(row)) {
        rows[row] = [...rows[row]];
        copied.add(row);
      }
      rows[row][index] = value;
      table.written.add(row * width + index);
      table.ranks[index] = undefined;
      table.keys.delete(index);
    }
    table.views.clear();
    table.edits = { version: table.edits.version + 1, cells: table.written.size };
    for (const [id, open] of this.tables) {
      if (open !== table) continue;
      this.emit({ v: 2, event: "changed", table: id, revision: table.revision, edits: { ...table.edits } });
    }
    return { updated: changes.length, edits: { ...table.edits } };
  }

  private emit(event: Json) {
    for (const listener of this.listeners) listener(event);
  }

  /** The position of a row in a view, or null when the view does not have it. */
  private positionOf(view: View, rowId: number): number | null {
    if (rowId >= view.rowCount) return null;
    if (!view.order) return rowId;
    if (!view.positions) {
      const positions = new Uint32Array(view.rowCount);
      view.order.forEach((row, position) => {
        positions[row] = position;
      });
      view.positions = positions;
    }
    return view.positions[rowId];
  }

  /** The first position in a view of each rank of a column, −1 for ranks that no row of the view has. */
  private firstsOf(view: View, column: number, ranks: ColumnRanks): Int32Array {
    let firsts = view.firsts.get(column);
    if (!firsts) {
      firsts = new Int32Array(ranks.distinct + 2).fill(-1);
      for (let position = 0; position < view.rowCount; position++) {
        const rank = ranks.ranks[view.order ? view.order[position] : position];
        if (firsts[rank] < 0) firsts[rank] = position;
      }
      view.firsts.set(column, firsts);
    }
    return firsts;
  }
}

/**
 * An engine over tables in memory. The host gives the tables by the `ref` that `open` takes; the engine checks
 * the form of a table against §2 when it is first opened, and its values as it reads them (a column whole before
 * it sorts or sums it), answering `load_failed` with the JSON Pointer of a value that does not follow §2.2. It
 * reads the rows as they are, without copying them, so they must not change afterwards.
 */
export function memoryEngine(options: MemoryEngineOptions): MemoryEngine {
  return new Engine(options);
}
