/**
 * An engine over tables in memory (docs/v2-spec.md §8): it answers the requests of §8.2 about tables that
 * its host gives it as arrays of typed JSON values (§2.2), as Arrow, as text files or as Parquet files, with views in
 * the order of §3.3.
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
  FUNCTIONS,
  type JsonValue,
  keyText,
  MEASURES,
  MESSAGE_LIMITS,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  planOptions,
  type RowKey,
  SpecError,
  sameCellValue,
  textOf,
} from "vastgrid-spec";
import { type ColumnRanks, type RankedKey, rankColumn, rankColumnPausing, sortRows } from "./order.js";
import type { ViewColumn, ViewShape } from "./plan.js";
import { Summary } from "./summary.js";
import {
  type ArrowTable,
  type CheckedTable,
  checkTable,
  type FileTable,
  isArrowTable,
  isFileTable,
  isParquetTable,
  type MemoryTable,
  type ParquetTable,
  shown,
  TableProblem,
  type Vector,
  valueChecker,
  vectorOf,
  vectorValue,
} from "./table.js";

/** A table that a host gives the engine: rows of typed JSON, Arrow, a text file or a Parquet file. */
type HostTable = MemoryTable | ArrowTable | FileTable | ParquetTable;

export interface MemoryEngineOptions {
  /**
   * The tables that `open` opens, by the `ref` that names them: rows of typed JSON, Arrow, text files or Parquet
   * files.
   */
  tables: Record<string, HostTable>;
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

/** The formats that `export` writes (§8.2), answered as the file's bytes. */
const EXPORT_FORMATS = Object.freeze(["csv", "tsv", "json", "xlsx"]) as unknown as string[];

/**
 * What the engine evaluates (§4.10): every plan of §4.1, with every function of §4.4 and every measure of §4.5;
 * `summarize`, `find`, `locate` and `export` of CSV, TSV, JSON and xlsx as data.
 */
export const MEMORY_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  plan: Object.freeze({
    derive: true,
    where: true,
    aggregate: true,
    pivot: true,
    having: true,
    sort: true,
    search: true,
  }),
  functions: Object.freeze([...FUNCTIONS]) as unknown as string[],
  measures: Object.freeze([...MEASURES]) as unknown as string[],
  summarize: true,
  find: true,
  locate: true,
  write: false,
  save: false,
  export: Object.freeze({ formats: EXPORT_FORMATS, delivery: "data" as const }),
  preview: false,
  partialViews: false,
  changes: "poll",
});

/** A copy of the capabilities, for a message; tables that the host makes editable are written (§7). */
function capabilities(write = false): Capabilities {
  return {
    ...MEMORY_CAPABILITIES,
    plan: { ...MEMORY_CAPABILITIES.plan },
    export: { formats: [...EXPORT_FORMATS], delivery: "data" },
    functions: [...FUNCTIONS],
    measures: [...MEASURES],
    write,
  };
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
  /** The host's rows, of a table given as rows; null for a table given as Arrow or as a file. */
  rows: readonly (readonly JsonValue[])[] | null;
  /** The typed columns of a table given as Arrow or as a file; null for a table given as rows. */
  vectors: Vector[] | null;
  /** The file of a table given as Parquet, whose columns are read when requests need them. */
  reader: import("./lazy.js").FileColumns | null;
  /** The module that reads the numbers of typed columns, for a table given as Arrow or as a file. */
  typed: typeof import("./numbers.js") | null;
  rowCount: number;
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
  /**
   * Each checked column's values by row ID, which ranks, summaries and expressions read: of a table given as rows,
   * an array of the engine's own, which writes change; of one given as Arrow or as a file, its typed column, with
   * the values written over it (`writtenVector`).
   */
  values: (Vector | undefined)[];
  /** The values written to each typed column by row ID, kept apart from the column, which is not copied. */
  overlays: (Map<number, JsonValue> | undefined)[];
  /** Views by plan hash, the most recently used last. */
  views: Map<string, View>;
  /** The table IDs open on it. */
  open: number;
}

/** A view of a table (§4.2): its rows in order. */
interface View {
  hash: string;
  columns: Column[];
  /** The derived columns by name; in a view of groups, every column of the view, by group number. */
  derived: Map<string, ViewColumn>;
  /** Whether the view's rows are groups (§4.2), which have no row IDs. */
  grouped: boolean;
  /** The rows of the table when the view was made; the groups of a view of groups. */
  tableRows: number;
  rowCount: number;
  /** The row ID (group number) at each position; null when the view is every row of the table (every group) in order. */
  order: Uint32Array | null;
  /** The position of each row ID, made when `locate` first needs it. */
  positions?: Uint32Array;
  /** For each column that `locate` looked values up in, by its name: the first position of each rank. */
  firsts: Map<string, Int32Array>;
}

/** A column that a request reads: a table's column at its index, or a derived column with its values. */
interface Source {
  name: string;
  column: Column;
  /** The index of a table's column; −1 for a derived column. */
  index: number;
  values: Vector | null;
}

/** A typed column with the values written to it (§7.2) over it; it reads as JSON, as the host's rows do. */
function writtenVector(base: Vector, written: Map<number, JsonValue>): Vector {
  return {
    length: base.length,
    at: (row) => {
      const value = written.get(row);
      return value === undefined ? base.at(row) : value;
    },
  };
}

/**
 * Adds the names of columns that a plan names (§4.1) to `names`: in expressions, keys, measures, pivots and sorts.
 * True when it searches (§3.5), which reads every column.
 */
function planNames(value: unknown, names: Set<string>): boolean {
  if (Array.isArray(value)) return value.reduce<boolean>((search, item) => planNames(item, names) || search, false);
  if (!isObject(value)) return false;
  let search = typeof value.search === "string";
  for (const [key, item] of Object.entries(value)) {
    if ((key === "col" || key === "column") && typeof item === "string") names.add(item);
    else if ((key === "keys" || key === "columns") && Array.isArray(item)) {
      for (const name of item) if (typeof name === "string") names.add(name);
    } else if (planNames(item, names)) search = true;
  }
  return search;
}

/** The position of a row that a view leaves out, in `View.positions`. */
const NO_POSITION = 0xffff_ffff;

/** A request being answered, which `cancel` marks. */
interface Running {
  cancelled: boolean;
  /** When the request last let other messages in (`performance.now()`). */
  yielded: number;
  /** Lets go of the columns that the request read whole (lazy.ts), when it ends. */
  releases: (() => void)[];
}

// The page, Web Workers and Node.js all have these; the package is typed without the DOM or Node.js.
declare const performance: { now(): number };
declare function setTimeout(callback: (value?: unknown) => void, delay: number): unknown;

/** The work that a request does before it lets other messages in, such as a `cancel` of it (§8.6), in ms. */
const SLICE = 40;

/**
 * Lets other messages in when the request has worked for a slice since it last did, and stops it when it was
 * cancelled (§8.6): a cancel that came in while the request waited for a file is seen at once. Requests that go
 * through many rows call it between batches of them.
 */
async function pause(running: Running): Promise<void> {
  if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
  if (performance.now() - running.yielded < SLICE) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  running.yielded = performance.now();
  if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
}

/** The names that a plan sorts or groups by, or counts the distinct values of; derived columns are left out. */
function rankedNames(plan: CheckedPlan["plan"]): string[] {
  const { aggregate } = plan;
  const names = aggregate
    ? [
        ...aggregate.keys,
        ...(aggregate.pivot?.columns ?? []),
        ...aggregate.measures.flatMap((measure) =>
          measure.fn === "count_distinct" && measure.column ? [measure.column] : [],
        ),
      ]
    : (plan.sort ?? []).map((key) => key.column);
  const derived = new Set((plan.derive ?? []).map((item) => item.name));
  return names.filter((name) => !derived.has(name));
}

// The revision of each table that hosts give: its data never changes, so neither does its revision.
const revisions = new WeakMap<object, string>();
let revisionCount = 0;

function revisionOf(table: HostTable): string {
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
  private readonly sources: Map<string, HostTable>;
  /** Tables by ref, while a table ID is open on them. */
  private readonly prepared = new Map<string, Table>();
  /** Files being read by ref, which every open of the file waits for. */
  private readonly reading = new Map<string, Promise<CheckedTable>>();
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
    const running: Running = { cancelled: false, yielded: performance.now(), releases: [] };
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
      if (error instanceof SpecError) return errorResponse(request.id, error.code as ErrorCode, error.message);
      return errorResponse(request.id, "internal", error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running.get(request.id) === running) this.running.delete(request.id);
      for (const release of running.releases) release();
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
        if (--table.open === 0 && table.written.size === 0) {
          this.prepared.delete(table.ref);
          table.reader?.close();
        }
        return null;
      }
      case "rows":
        return this.rows(request, running);
      case "summarize":
        return this.summarize(request, running);
      case "find":
        return this.find(request, running);
      case "locate":
        return this.locate(request, running);
      case "export":
        return this.export(request, running);
      case "write":
        return this.write(request, running);
      case "save":
        // A table in memory has no file to write back (§7.5).
        this.table(request);
        throw new Failure(
          "save_unsupported",
          "This engine keeps tables in memory and does not save them (capabilities.save is false).",
        );
      default:
        throw new Failure("invalid_request", `This engine does not offer ${request.op} (§4.10).`, {
          path: "/op",
          reason: "unknown_op",
        });
    }
  }

  private async open(ref: string) {
    if (!this.sources.has(ref)) throw new Failure("not_allowed", `The host does not open ${shown(ref)}.`);
    const source = this.sources.get(ref) as HostTable;
    // Arrow tables and files are read by modules of their own, loaded before the table is looked up so that two
    // opens of one table do not both make it.
    const arrow = isArrowTable(source) ? await import("./arrow.js") : null;
    const file = isFileTable(source);
    const parquet = isParquetTable(source);
    const typed = arrow || file || parquet ? await import("./numbers.js") : null;
    let table = this.prepared.get(ref);
    if (!table) {
      let checked: CheckedTable;
      try {
        checked = arrow
          ? arrow.checkArrow((source as ArrowTable).arrow)
          : file
            ? await this.readFile(ref, source as FileTable)
            : parquet
              ? await this.openParquet(ref, source as ParquetTable)
              : checkTable(source);
      } catch (error) {
        if (!(error instanceof TableProblem)) throw error;
        const at = error.path === "" ? "" : `at ${error.path}, `;
        throw new Failure(error.code, `The table ${shown(ref)} cannot be read: ${at}${error.message}`);
      }
      // Another open of the file may have made the table while the file was read.
      table = this.prepared.get(ref) ?? this.prepare(ref, source, checked, typed);
    }
    const id = `t${this.nextTable++}`;
    this.tables.set(id, table);
    table.open++;
    return this.info(id, table);
  }

  /** Reads a table given as a file, once for every open that waits for it (text.ts). */
  private readFile(ref: string, source: FileTable): Promise<CheckedTable> {
    let reading = this.reading.get(ref);
    if (!reading) {
      reading = import("./text.js").then((text) => text.readFile(source)).finally(() => this.reading.delete(ref));
      this.reading.set(ref, reading);
    }
    return reading;
  }

  /** Opens a table given as a Parquet file, once for every open that waits for it: reads its footer (parquet.ts). */
  private openParquet(ref: string, source: ParquetTable): Promise<CheckedTable> {
    let reading = this.reading.get(ref);
    if (!reading) {
      reading = import("./parquet.js")
        .then(async ({ ParquetFile }) => (await ParquetFile.open(source)).checked())
        .finally(() => this.reading.delete(ref));
      this.reading.set(ref, reading);
    }
    return reading;
  }

  /** A table that is opened from its host's table, checked or read. */
  private prepare(ref: string, source: HostTable, checked: CheckedTable, typed: Table["typed"]): Table {
    const { columns } = checked;
    const table: Table = {
      ref,
      columns,
      index: new Map(columns.map((column, index) => [column.name, index])),
      rows: checked.rows,
      vectors: checked.vectors,
      reader: checked.reader ?? null,
      typed,
      rowCount: checked.rowCount,
      revision: revisionOf(source),
      editable: source.editable === true,
      edits: { version: 0, cells: 0 },
      written: new Set(),
      keys: new Map(),
      ranks: columns.map(() => undefined),
      checkers: columns.map((column, index) => valueChecker(column, index)),
      values: columns.map(() => undefined),
      overlays: columns.map(() => undefined),
      views: new Map(),
      open: 0,
    };
    // What the engine made of a column of a file that is forgotten, it makes again when a request reads it whole.
    if (table.reader) {
      table.reader.forgotten = (index) => {
        table.values[index] = undefined;
      };
    }
    this.prepared.set(ref, table);
    return table;
  }

  /** TableInfo (§8.2). */
  private info(id: string, table: Table) {
    return {
      table: id,
      revision: table.revision,
      edits: { ...table.edits },
      status: "ready",
      progress: 1,
      rowCount: table.rowCount,
      readableRows: table.rowCount,
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
    throw new Failure(error.code, `The table ${shown(table.ref)} cannot be read: at ${error.path}, ${error.message}`);
  }

  /**
   * Checks every value of a column, once, before something reads all of it, and gives its values by row ID: of a
   * table given as rows, an array of the engine's own; of one given as Arrow or as a file, its column.
   */
  private valuesOf(table: Table, index: number): Vector {
    const made = table.values[index];
    if (made) return made;
    const check = table.checkers[index];
    let values: Vector;
    try {
      if (table.vectors) {
        values = table.vectors[index];
        const column = table.columns[index];
        // Numbers are checked as numbers; a value found wrong is then read, which fails as its JSON would.
        if (values.numbers && table.typed) {
          const row = table.typed.firstInvalid(column, values.numbers, values.validity ?? null);
          if (row >= 0) check(vectorValue(values, column, index, row), row);
        } else {
          for (let row = 0; row < table.rowCount; row++) check(vectorValue(values, column, index, row), row);
        }
      } else {
        const rows = table.rows as readonly (readonly JsonValue[])[];
        const array: JsonValue[] = new Array(rows.length);
        for (let row = 0; row < rows.length; row++) {
          const value = rows[row][index];
          check(value, row);
          array[row] = value;
        }
        values = vectorOf(array);
      }
    } catch (error) {
      if (error instanceof TableProblem) this.loadFailed(table, error);
      throw error;
    }
    const written = table.overlays[index];
    if (written) values = writtenVector(values, written);
    table.values[index] = values;
    return values;
  }

  /**
   * Reads whole the columns that a request reads whole, before it reads them, of a table whose file is read as
   * requests need it (lazy.ts); the other tables hold all their columns.
   */
  private async readColumns(table: Table, indexes: Iterable<number>, running: Running): Promise<void> {
    if (!table.reader) return;
    try {
      running.releases.push(await table.reader.read(indexes, () => pause(running)));
    } catch (error) {
      if (error instanceof TableProblem) this.loadFailed(table, error);
      throw error;
    }
  }

  /**
   * The values of a table's column at rows, in their order, checked when its column is not (§2.2): of a table whose
   * file is read as requests need it, read by the parts of the file that hold them unless the column was read whole.
   */
  private async cellsOf(table: Table, index: number, rows: ArrayLike<number>): Promise<JsonValue[]> {
    if (table.values[index] || !table.reader) return Array.from(rows, (row) => this.cell(table, row, index));
    let read: JsonValue[];
    try {
      read = await table.reader.cells(index, rows);
      const written = table.overlays[index];
      const check = table.checkers[index];
      return Array.from(rows, (row, at) => {
        const value = written?.get(row);
        if (value !== undefined) return value;
        check(read[at], row);
        return read[at];
      });
    } catch (error) {
      if (error instanceof TableProblem) this.loadFailed(table, error);
      throw error;
    }
  }

  /** The value of a table's column at a row as the table holds it, checked when its column is not (§2.2). */
  private cell(table: Table, row: number, index: number): JsonValue {
    const values = table.values[index];
    if (values) return values.at(row);
    const written = table.overlays[index]?.get(row);
    if (written !== undefined) return written;
    try {
      const value = table.vectors
        ? vectorValue(table.vectors[index], table.columns[index], index, row)
        : (table.rows as readonly (readonly JsonValue[])[])[row][index];
      table.checkers[index](value, row);
      return value;
    } catch (error) {
      if (error instanceof TableProblem) this.loadFailed(table, error);
      throw error;
    }
  }

  /**
   * Writes a cell: into the engine's own array of a column of a table given as rows, or over a typed column, which
   * stays as it was and is not copied.
   */
  private setCell(table: Table, row: number, index: number, value: JsonValue) {
    if (!table.vectors) {
      (this.valuesOf(table, index) as unknown as JsonValue[])[row] = value;
      return;
    }
    let written = table.overlays[index];
    if (!written) {
      written = new Map();
      table.overlays[index] = written;
      const made = table.values[index];
      if (made) table.values[index] = writtenVector(made, written);
    }
    written.set(row, value);
  }

  private ranksOf(table: Table, index: number): ColumnRanks {
    let ranks = table.ranks[index];
    if (!ranks) {
      const column = table.columns[index];
      const values = this.valuesOf(table, index);
      // A typed column is ranked from its numbers, until a write makes it an array.
      const write = values.numbers && table.typed ? table.typed.numberWriter(column, values.numbers) : null;
      ranks = rankColumn(column, values, write);
      table.ranks[index] = ranks;
    }
    return ranks;
  }

  /**
   * Ranks a column as `ranksOf` does, with pauses while text is ranked: the ranks of a write's column made while the
   * write came are not kept.
   */
  private async rankPausing(table: Table, index: number, running: Running): Promise<void> {
    if (table.ranks[index]) return;
    const { version } = table.edits;
    const column = table.columns[index];
    const values = this.valuesOf(table, index);
    const write = values.numbers && table.typed ? table.typed.numberWriter(column, values.numbers) : null;
    const ranks = await rankColumnPausing(column, values, write, () => pause(running));
    if (table.edits.version === version) table.ranks[index] ??= ranks;
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
    if (table.reader) {
      const names = new Set<string>();
      const every = planNames(checked.plan, names);
      const named = [...names].filter((name) => table.index.has(name));
      await this.readColumns(
        table,
        every ? table.columns.keys() : named.map((name) => table.index.get(name) as number),
        running,
      );
    }
    // The columns that the view sorts or groups by are ranked first, which a cancel stops.
    for (const name of rankedNames(checked.plan)) {
      const index = table.index.get(name);
      if (index !== undefined) await this.rankPausing(table, index, running);
    }
    const count = table.rowCount;
    const ranks = (name: string) => this.ranksOf(table, table.index.get(name) as number);
    let shape: ViewShape;
    if (checked.derive.length > 0 || checked.where || checked.aggregate) {
      const { planView } = await import("./plan.js");
      shape = planView(checked, {
        count,
        values: (name) => this.valuesOf(table, table.index.get(name) as number),
        ranks,
        rankColumn,
        sortRows,
        sortKeys: (ranksOf) => this.sortKeys(checked, ranksOf),
      });
    } else {
      shape = {
        columns: checked.columns,
        derived: new Map(),
        grouped: false,
        tableRows: count,
        rowCount: count,
        order: sortRows(count, this.sortKeys(checked, ranks), null),
      };
    }
    const view: View = { hash, ...shape, firsts: new Map() };
    table.views.set(hash, view);
    if (table.views.size > KEPT_VIEWS) table.views.delete(table.views.keys().next().value as string);
    // A view is made to its end, and kept; a cancel that came while it was made stops the request after it.
    await pause(running);
    return view;
  }

  /** The sort keys of a plan (§3.3); a key on a column that an earlier key sorted by cannot break a tie. */
  private sortKeys(checked: CheckedPlan, ranksOf: (name: string) => ColumnRanks): RankedKey[] {
    const used = new Set<string>();
    const keys: RankedKey[] = [];
    for (const key of checked.sort) {
      const name = key.column.name;
      if (used.has(name)) continue;
      used.add(name);
      keys.push({ ranks: ranksOf(name), descending: key.direction === "desc" });
    }
    return keys;
  }

  /**
   * The columns that a request names, which must be columns of the view: the index of a table's column, or the
   * values of a derived one or of a column of groups.
   */
  private columnsOf(table: Table, view: View, names: string[]): Source[] {
    return names.map((name, at) => {
      const derived = view.derived.get(name);
      if (derived) return { name, column: derived.column, index: -1, values: vectorOf(derived.values) };
      const index = table.index.get(name);
      if (index === undefined || !view.columns.some((column) => column.name === name)) {
        throw new Failure("invalid_request", `The view has no column ${shown(name)}.`, {
          path: `/columns/${at}`,
          reason: "syntax",
        });
      }
      return { name, column: table.columns[index], index, values: null };
    });
  }

  private async rows(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    const names = request.columns as string[];
    const sources = this.columnsOf(table, view, names);
    const start = request.start as number;
    const end = Math.max(start, Math.min(request.end as number, view.rowCount));
    const limit = (request.textLimit as number | undefined) ?? MESSAGE_LIMITS.textLimitDefault;
    const columns = sources.map((source) => source.column);
    const rowIds: number[] = [];
    for (let position = start; position < end; position++) rowIds.push(view.order ? view.order[position] : position);
    if (table.reader) {
      try {
        await table.reader.prepare(
          sources.flatMap((source) => (source.values ? [] : [source.index])),
          rowIds,
          () => pause(running),
        );
      } catch (error) {
        if (error instanceof TableProblem) this.loadFailed(table, error);
        throw error;
      }
    }
    // The values read are checked, of the table's columns not checked whole (§2.2).
    const cells = await Promise.all(
      sources.map((source) => (source.values ? null : this.cellsOf(table, source.index, rowIds))),
    );
    const values: JsonValue[][] = [];
    // By name in a Map: a column may be named "__proto__".
    const truncated = new Map<string, number[]>();
    for (let offset = 0; offset < rowIds.length; offset++) {
      const row = rowIds[offset];
      values.push(
        sources.map(({ values }, at) => {
          const value = values ? values.at(row) : (cells[at] as JsonValue[])[offset];
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
      rowIds: view.grouped ? null : rowIds,
      block: { bytes: encodeBlock(columns, values) },
      ...(truncated.size > 0 ? { truncated: Object.fromEntries(truncated) } : {}),
    };
  }

  private async summarize(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    // The cells of ranges × columns: each cell once, however the ranges overlap or a column repeats.
    const sources = new Map(this.columnsOf(table, view, request.columns as string[]).map((item) => [item.name, item]));
    const spans = mergeRanges(request.ranges as [number, number][], view.rowCount);
    const rows = new Uint32Array(spans.reduce((total, [start, end]) => total + end - start, 0));
    let at = 0;
    for (const [start, end] of spans) {
      for (let position = start; position < end; position++) rows[at++] = view.order ? view.order[position] : position;
    }
    await this.readColumns(
      table,
      [...sources.values()].filter((source) => !source.values).map((source) => source.index),
      running,
    );
    const summary = new Summary();
    for (const { column, index, values } of sources.values()) {
      summary.add(column, values ?? this.valuesOf(table, index), rows);
    }
    return summary.result();
  }

  /**
   * The next cell of the view whose text form contains `text` (§8.2): row by row, in a row in the order of
   * `columns`, from the cell after `from` (before it, with −1), wrapping around and ending with `from` itself.
   */
  private async find(request: Json, running: Running) {
    const table = this.table(request);
    const view = await this.view(table, request.plan, running);
    const sources = this.columnsOf(table, view, request.columns as string[]);
    const text = request.text as string;
    if (text === "" || view.rowCount === 0 || sources.length === 0) return null;
    const sensitive = request.caseSensitive === true;
    const { mapCase } = await import("./evaluate.js");
    const needle = sensitive ? text : mapCase(text, false);
    await this.readColumns(
      table,
      sources.filter((source) => !source.values).map((source) => source.index),
      running,
    );
    const values = sources.map((source) => source.values ?? this.valuesOf(table, source.index));
    const matches = (position: number, at: number) => {
      const value = values[at].at(view.order ? view.order[position] : position);
      if (value === null) return false;
      const column = sources[at].column;
      const form = column.type === "string" ? (value as string) : (textOf(value, column) as string);
      return (sensitive ? form : mapCase(form, false)).includes(needle);
    };
    const count = view.rowCount;
    const width = sources.length;
    const forward = request.direction === 1;
    const from = request.from as { row: number; column: number };
    const row = Math.min(from.row, count - 1);
    const column = Math.min(from.column, width);
    // The cells of the row of `from` after it (before it, with −1).
    if (forward) {
      for (let at = column + 1; at < width; at++) if (matches(row, at)) return { row, column: at };
    } else {
      for (let at = column - 1; at >= 0; at--) if (matches(row, at)) return { row, column: at };
    }
    // Then the other rows, in order, wrapping around at the end.
    for (let step = 1; step < count; step++) {
      if (step % 1_024 === 0) await pause(running);
      const position = forward ? (row + step) % count : (row - step + count) % count;
      if (forward) {
        for (let at = 0; at < width; at++) if (matches(position, at)) return { row: position, column: at };
      } else {
        for (let at = width - 1; at >= 0; at--) if (matches(position, at)) return { row: position, column: at };
      }
    }
    // Last, the cells of the row of `from` up to `from` itself.
    if (forward) {
      for (let at = 0; at <= Math.min(column, width - 1); at++) if (matches(row, at)) return { row, column: at };
    } else {
      for (let at = width - 1; at >= column; at--) if (matches(row, at)) return { row, column: at };
    }
    return null;
  }

  /**
   * The view's rows as a file (§8.2), answered as its bytes (`delivery` `data`): CSV, TSV and JSON as the DuckDB
   * engine writes them, and xlsx. The engine has no files, so a `target` is not allowed.
   */
  private async export(request: Json, running: Running) {
    const table = this.table(request);
    const format = request.format as string;
    if (!EXPORT_FORMATS.includes(format)) {
      throw new Failure("invalid_request", `This engine does not export ${format} (§4.10).`, {
        path: "/format",
        reason: "syntax",
      });
    }
    if (request.target !== undefined) {
      throw new Failure("not_allowed", "This engine answers exports as data and writes no files: leave out target.");
    }
    const view = await this.view(table, request.plan, running);
    const names = (request.columns as string[] | undefined) ?? view.columns.map((column) => column.name);
    const sources = this.columnsOf(table, view, names);
    await this.readColumns(
      table,
      sources.filter((source) => !source.values).map((source) => source.index),
      running,
    );
    const values = sources.map((source) => source.values ?? this.valuesOf(table, source.index));
    const { writeExport } = await import("./export.js");
    const bytes = await writeExport({
      format: format as "csv" | "tsv" | "json" | "xlsx",
      columns: sources.map((source) => source.column),
      headers: (request.headers as string[] | undefined) ?? names,
      numberFormats: (request.numberFormats as (string | null)[] | undefined) ?? null,
      rowCount: view.rowCount,
      row: (position) => {
        const row = view.order ? view.order[position] : position;
        return values.map((vector) => vector.at(row));
      },
      pause: () => pause(running),
    });
    return { target: null, rows: view.rowCount, data: { bytes } };
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
    const name = request.rowKey as string;
    // In a view of groups, values are looked up among the groups' keys; groups have no row IDs.
    const group = view.grouped ? view.derived.get(name) : undefined;
    if (column !== undefined && !group && keys.some((key) => "value" in key)) {
      await this.readColumns(table, [column], running);
    }
    let ranks: ColumnRanks | undefined;
    return {
      rows: keys.map((key) => {
        if ("rowId" in key) return view.grouped ? null : this.positionOf(view, key.rowId);
        if (view.grouped && !group) return null;
        // The first position in the view of a row whose value equals the key's (§3.1).
        ranks ??= group ? rankColumn(group.column, vectorOf(group.values)) : this.ranksOf(table, column as number);
        const rank = ranks.rankOf(key.value);
        if (rank < 0) return null;
        const first = this.firstsOf(view, name, ranks)[rank];
        return first < 0 ? null : first;
      }),
    };
  }

  /** The row ID of a row key (§5.3): `{ rowId }`, or `{ value }` of `rowKey`'s column; null when no row has it. */
  private rowOf(table: Table, key: RowKey, column: number | undefined): number | null {
    if ("rowId" in key) return Number.isSafeInteger(key.rowId) && key.rowId < table.rowCount ? key.rowId : null;
    if (column === undefined) return null;
    let byText = table.keys.get(column);
    if (!byText) {
      const values = this.valuesOf(table, column);
      byText = new Map();
      for (let row = values.length - 1; row >= 0; row--) {
        const value = values.at(row);
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
  private async write(request: Json, running: Running) {
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
    if (keyColumn !== undefined && updates.some((update) => "value" in update.key)) {
      await this.readColumns(table, [keyColumn], running);
    }
    const width = table.columns.length;
    const changes: { row: number; index: number; value: JsonValue }[] = [];
    for (const [at, update] of updates.entries()) {
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
      const [now] = await this.cellsOf(table, index, [row]);
      if (update.previous !== undefined && !sameCellValue(now, update.previous, column)) {
        throw new Failure("edit_conflict", "The cell holds another value now.", { details: { update: at } });
      }
      changes.push({ row, index, value: update.value });
    }
    if (changes.length === 0) return { updated: 0, edits: { ...table.edits } };
    // The host's rows, Arrow columns and files stay as they were: writes change the engine's own values.
    for (const { row, index, value } of changes) {
      this.setCell(table, row, index, value);
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
    if (rowId >= view.tableRows) return null;
    if (!view.order) return rowId;
    if (!view.positions) {
      // Rows that the view leaves out have no position.
      const positions = new Uint32Array(view.tableRows).fill(NO_POSITION);
      view.order.forEach((row, position) => {
        positions[row] = position;
      });
      view.positions = positions;
    }
    const position = view.positions[rowId];
    return position === NO_POSITION ? null : position;
  }

  /** The first position in a view of each rank of a column, −1 for ranks that no row of the view has. */
  private firstsOf(view: View, column: string, ranks: ColumnRanks): Int32Array {
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
