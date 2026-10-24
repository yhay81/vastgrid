import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open as openFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline, Readable } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
import zlib, { createDeflateRaw } from "node:zlib";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  type AggregateRequest,
  type CellValue,
  type ColumnStats,
  checkXlsxSize,
  type DistinctRequest,
  type DistinctValues,
  ErrorCodes,
  type ExportRequest,
  type ExportResult,
  editableType,
  type FindRequest,
  type FindResult,
  filterLeaves,
  filtersRows,
  isEmptyQuery,
  isNumericType,
  isTemporalType,
  MAX_TEXT_LIMIT,
  MAX_UPDATE_CELLS,
  normalizeCellValue,
  queryFormulas,
  type ReadOptions,
  type RowBlock,
  type RowRequest,
  type SaveResult,
  type SelectionSummary,
  type SheetInfo,
  SourceError,
  sameCellValue,
  type TableEdits,
  type TableInfo,
  type UpdateRequest,
  type UpdateResult,
  type ViewInfo,
  type ViewOptions,
  type ViewQuery,
  type ViewStatus,
  writeXlsx,
  XLSX_MAX_TEXT,
} from "vastgrid-core";
import { type CsvDialect, CsvSaveError, rewriteCsv } from "./csv-save.js";
import { convertToUtf8, detectEncoding, type TextEncoding } from "./encoding.js";
import { formulaSelect } from "./formula.js";
import {
  columnTypeOf,
  conditionExpression,
  filterExpression,
  orderTerms,
  Parameters,
  quoteIdentifier,
  quoteLiteral,
  type SqlColumn,
  searchExpression,
  selectExpression,
  textExpression,
  wireValue,
} from "./sql.js";
import { convertSheet, readWorkbook, sheetList, WorkbookError } from "./xlsx.js";

/**
 * Compression of exported workbooks. Compressing takes most of the time: level 3 writes a million rows
 * about twice as fast as the default level 6, in a file about 10% larger.
 */
const DEFLATE_LEVEL = 3;

export type TableFormat = "csv" | "tsv" | "parquet" | "json" | "ndjson" | "xlsx";

export interface TableEngineOptions {
  /** Directories DuckDB may read and export into. All other file access is disabled for good. */
  allowedDirectories: string[];
  /**
   * Where the engine keeps its database file, data spilled from memory and converted files. Each
   * engine uses its own folder inside and deletes it on `dispose`; folders left by crashed processes
   * are deleted on the next start.
   */
  tempDirectory: string;
  /** DuckDB memory limit, for example `"4GB"`. Defaults to a fifth of the system memory (1–4 GB). */
  memoryLimit?: string;
  /** DuckDB worker threads. Defaults to the number of CPUs minus one. */
  threads?: number;
  /** Tables kept open; the least recently used ones are closed beyond this. */
  maxTables?: number;
  /** Sorted or filtered views kept per table. */
  maxViews?: number;
  /**
   * Tables with more rows than this get views that hold only the order of the rows (their positions
   * in the table) instead of a sorted copy of every column. Building them is an order of magnitude
   * faster and needs far less temporary space; scrolling them reads each block of rows from the table
   * (about 0.1–0.2 s per block for a 100M-row Parquet file instead of 10–20 ms). Defaults to 20M.
   */
  materializeRows?: number;
  /**
   * Sorts of tables with at least this many rows answer requests that accept a preview
   * (`ViewOptions.preview`) as soon as the first `viewPreviewRows` rows of the view are known, and
   * build the rest in the background. Defaults to 1M.
   */
  viewPreviewMinRows?: number;
  /** Rows of a sorted view that are readable before the view is ready. Defaults to 1000. */
  viewPreviewRows?: number;
  /**
   * A background build is stopped when another view of the table waits for its turn and no request
   * asked for this view (its status, rows or anything else) for this many milliseconds, so that
   * views nobody follows any more do not hold up the next one. Defaults to 3000.
   */
  abandonedViewTimeout?: number;
  /** Rows read for display while a delimited or JSON file is still loading. */
  previewRows?: number;
  /** Longest text sent for a cell by default. */
  textLimit?: number;
  /**
   * Lets clients write cells (the `update` request, `TableSource.updateCells`). Written values are kept
   * in the engine, apart from the file, and every request reads them: rows, views, statistics,
   * summaries, find and exports. The file itself is not changed. A table with written cells stays open
   * (it is not closed to keep `maxTables`, nor opened again when its file changes) until it is closed
   * or the engine is disposed, which discards them. Defaults to `false`.
   */
  editable?: boolean;
  /**
   * Lets clients save written cells into the CSV or TSV file they came from (the `save` request,
   * `TableSource.saveEdits`), with `editable`. Only the records with written cells are written anew; every
   * other byte of the file stays as it was (see `rewriteCsv`). Defaults to `false`.
   */
  saveFiles?: boolean;
  /** Reports problems that are not caused by a request (for logs). */
  log?: (message: string, error?: unknown) => void;
}

const extensions: [RegExp, TableFormat][] = [
  [/\.(csv|csv\.gz|csv\.zst)$/i, "csv"],
  [/\.(tsv|tab|tsv\.gz|tsv\.zst)$/i, "tsv"],
  [/\.(parquet|pq)$/i, "parquet"],
  [/\.(jsonl|ndjson|jsonl\.gz|ndjson\.gz)$/i, "ndjson"],
  [/\.(json|json\.gz)$/i, "json"],
  [/\.(xlsx|xlsm)$/i, "xlsx"],
];

/** The format of a file judged by its name, or `null` when it is not a table file. */
export function tableFormatOf(filePath: string): TableFormat | null {
  for (const [pattern, format] of extensions) if (pattern.test(filePath)) return format;
  return null;
}

/** The options that change how a file of `format` is read (only workbooks have any), without defaults. */
function readOptionsOf(format: TableFormat, read: ReadOptions | undefined): ReadOptions {
  if (format !== "xlsx" || !read) return {};
  return {
    ...(read.sheet === undefined ? {} : { sheet: read.sheet }),
    ...(read.headerRow === undefined ? {} : { headerRow: read.headerRow }),
    ...(read.keepEmptyRows ? { keepEmptyRows: true } : {}),
    ...(read.keepEmptyColumns ? { keepEmptyColumns: true } : {}),
  };
}

/** Tables are shared by file and by how it is read: another sheet of a workbook is another table. */
function tableKey(file: string, read: ReadOptions) {
  return Object.keys(read).length === 0 ? file : `${file}\n${JSON.stringify(read)}`;
}

/** Limits how many long operations (loading, sorting, statistics) run at the same time. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function notAllowed() {
  return new SourceError(ErrorCodes.notAllowed, "The path is outside the folders this server may use.", 403);
}

function isInterrupt(error: unknown) {
  return /interrupt/i.test(errorMessage(error));
}

function defaultMemoryLimit() {
  const fifth = os.totalmem() / 5 / 1024 ** 3;
  return `${Math.max(1, Math.min(4, Math.floor(fifth)))}GB`;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Deletes the session folders of engines whose process ended without cleaning up (for example a crash). */
async function removeStaleSessions(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = /^session-(\d+)-/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    await rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

/**
 * Opens table files with DuckDB and answers the vastgrid protocol for them.
 *
 * Delimited and JSON files are loaded into DuckDB tables in a database file of the session (inside
 * `tempDirectory`, deleted by `dispose`); the first rows are readable right away while the rest loads. Parquet
 * files are read in place. Sorting and filtering create views as tables in the requested order, so
 * scrolling a sorted view is as fast as scrolling the table.
 */
export class TableEngine {
  private readonly instance: DuckDBInstance;
  readonly options: Required<Omit<TableEngineOptions, "log" | "memoryLimit" | "threads">> &
    Pick<TableEngineOptions, "log">;
  private readonly tables = new Map<string, OpenTable>();
  private readonly byPath = new Map<string, OpenTable>();
  private readonly pool: DuckDBConnection[] = [];
  private connections = 0;
  private readonly poolWaiters: ((connection: DuckDBConnection) => void)[] = [];
  /** Loading files. */
  readonly loads = new Gate(1);
  /** Building views and computing statistics. */
  readonly work = new Gate(2);
  private nextId = 1;
  private disposed = false;

  private constructor(instance: DuckDBInstance, options: TableEngine["options"]) {
    this.instance = instance;
    this.options = options;
  }

  static async create(options: TableEngineOptions): Promise<TableEngine> {
    const tempDirectory = path.resolve(options.tempDirectory);
    await mkdir(tempDirectory, { recursive: true });
    await removeStaleSessions(tempDirectory);
    // Tables live in a database file of this session: DuckDB compresses them there, which takes a
    // fraction of the memory and temporary disk space that in-memory tables need once they spill.
    const session = path.join(tempDirectory, `session-${process.pid}-${randomBytes(4).toString("hex")}`);
    await mkdir(session, { recursive: true });
    const threads = options.threads ?? Math.max(1, os.availableParallelism() - 1);
    const instance = await DuckDBInstance.create(path.join(session, "tables.duckdb"), {
      threads: String(threads),
      memory_limit: options.memoryLimit ?? defaultMemoryLimit(),
      temp_directory: path.join(session, "spill"),
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
    });
    const resolved = [...options.allowedDirectories.map((directory) => path.resolve(directory)), tempDirectory];
    // Files are opened by their real location (links followed), so the directories are allowed by theirs too.
    const real = await Promise.all(resolved.map((directory) => realpath(directory).catch(() => directory)));
    const directories = [...new Set([...resolved, ...real])];
    const connection = await instance.connect();
    try {
      const list = directories.map((directory) =>
        quoteLiteral(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`),
      );
      // Once external access is disabled it cannot be enabled again, and the allowed directories
      // cannot change, so generated SQL can never reach other files.
      await connection.run(`SET allowed_directories = [${list.join(", ")}]`);
      await connection.run("SET enable_external_access = false");
    } finally {
      connection.closeSync();
    }
    return new TableEngine(instance, {
      allowedDirectories: directories,
      tempDirectory: session,
      maxTables: options.maxTables ?? 4,
      maxViews: options.maxViews ?? 2,
      materializeRows: options.materializeRows ?? 20_000_000,
      viewPreviewMinRows: options.viewPreviewMinRows ?? 1_000_000,
      viewPreviewRows: Math.max(1, Math.floor(options.viewPreviewRows ?? 1000)),
      abandonedViewTimeout: options.abandonedViewTimeout ?? 3000,
      previewRows: options.previewRows ?? 1000,
      textLimit: options.textLimit ?? 2000,
      editable: options.editable === true,
      saveFiles: options.saveFiles === true,
      log: options.log,
    });
  }

  /** A connection for short queries. Waits when all are busy. */
  async acquire(): Promise<DuckDBConnection> {
    const free = this.pool.pop();
    if (free) return free;
    if (this.connections < 6) {
      this.connections++;
      return this.instance.connect();
    }
    return new Promise((resolve) => this.poolWaiters.push(resolve));
  }

  release(connection: DuckDBConnection) {
    const waiter = this.poolWaiters.shift();
    if (waiter) waiter(connection);
    else this.pool.push(connection);
  }

  /** Runs `task` on a pooled connection, interrupting the query when `signal` aborts. */
  async withConnection<T>(
    signal: AbortSignal | undefined,
    task: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new SourceError(ErrorCodes.cancelled, "The request was cancelled.", 499);
    const connection = await this.acquire();
    if (signal?.aborted) {
      // Cancelled while it waited for a connection: an abort listener added now would never fire.
      this.release(connection);
      throw new SourceError(ErrorCodes.cancelled, "The request was cancelled.", 499);
    }
    const interrupt = () => connection.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      return await task(connection);
    } catch (error) {
      if (signal?.aborted && isInterrupt(error))
        throw new SourceError(ErrorCodes.cancelled, "The request was cancelled.", 499);
      throw error;
    } finally {
      signal?.removeEventListener("abort", interrupt);
      this.release(connection);
    }
  }

  /** A dedicated connection (for loading and building views), closed by the caller. */
  connect() {
    return this.instance.connect();
  }

  createId(prefix: string) {
    return `${prefix}${this.nextId++}_${randomBytes(4).toString("hex")}`;
  }

  /** Whether an absolute path is inside one of the allowed directories. */
  allows(file: string) {
    return this.options.allowedDirectories.some((directory) =>
      file.startsWith(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`),
    );
  }

  /**
   * Opens a file, or returns the table already open for it when the file has not changed. A file
   * that changed (see `fileRevision`) is opened again as a new table, and so is a file whose
   * load failed once `info()` has reported the failure (a retry). Only files whose real location
   * (after following links) is inside the allowed directories are opened. `read` chooses the sheet
   * of a workbook and how its rows are read; each choice is a table of its own.
   */
  async open(filePath: string, format?: TableFormat, read?: ReadOptions): Promise<OpenTable> {
    if (this.disposed) throw new SourceError(ErrorCodes.disposed, "The table engine was closed.", 503);
    const requested = path.resolve(filePath);
    const fileFormat = format ?? tableFormatOf(requested);
    if (!fileFormat)
      throw new SourceError(ErrorCodes.unsupportedFormat, "This file is not a supported table format.", 415);
    // The engine reads some files itself (to detect and convert their encoding), and a link can point
    // anywhere: the file is opened by its real location, which must be inside the allowed directories.
    if (!this.allows(requested)) throw notAllowed();
    const absolute = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new SourceError(ErrorCodes.notFound, "The file does not exist.", 404) : error;
    });
    if (!this.allows(absolute)) throw notAllowed();
    const info = await stat(absolute);
    if (!info.isFile()) throw new SourceError(ErrorCodes.notFile, "Only files can be opened as tables.", 400);
    const revision = await fileRevision(absolute);
    // Until its failure is reported, a failed table is returned as it is: reopening it right away would
    // answer every poll of a loading table with a new load, so clients would never see the error.
    // A table with written cells keeps them: it is not opened again from the changed file.
    const reusable = (table: OpenTable) =>
      (table.readsFile(revision) && !table.failureReported) || table.editedCells > 0;
    const options = readOptionsOf(fileFormat, read);
    const key = tableKey(absolute, options);
    let existing = this.byPath.get(key);
    if (existing && !reusable(existing)) {
      await this.close(existing.id);
      // Another request may have opened the file again while the old table was closing.
      existing = this.byPath.get(key);
    }
    if (existing && reusable(existing)) {
      existing.touch();
      return existing;
    }
    const table = new OpenTable(this, this.createId("t"), absolute, fileFormat, revision, info.size, options);
    this.tables.set(table.id, table);
    this.byPath.set(key, table);
    table.start();
    await this.trim(table);
    // Clients can offer the other sheets of a workbook from the first answer on.
    if (fileFormat === "xlsx") await table.whenListed();
    return table;
  }

  get(id: string): OpenTable {
    const table = this.tables.get(id);
    if (!table) throw new SourceError(ErrorCodes.tableNotFound, "The table is no longer open.", 404);
    table.touch();
    return table;
  }

  async close(id: string) {
    const table = this.tables.get(id);
    if (!table) return;
    this.tables.delete(id);
    const key = tableKey(table.path, table.read);
    if (this.byPath.get(key) === table) this.byPath.delete(key);
    await table.dispose();
  }

  /** Closes the least recently used tables beyond `maxTables`, other than `opened`. */
  private async trim(opened: OpenTable) {
    // Tables with written cells are not closed: closing them would discard the cells.
    const open = [...this.tables.values()].filter((table) => table.editedCells === 0 && table !== opened);
    open.sort((a, b) => a.lastUsed - b.lastUsed);
    let count = this.tables.size;
    while (count > this.options.maxTables && open.length > 0) {
      const table = open.shift();
      if (table) await this.close(table.id);
      count--;
    }
  }

  /** Closes every table and the database, and deletes the session's files. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.tables.keys()]) await this.close(id);
    for (const connection of this.pool) connection.closeSync();
    this.pool.length = 0;
    this.instance.closeSync();
    await rm(this.options.tempDirectory, { recursive: true, force: true });
  }

  /** A path for a temporary file inside the engine's temp directory. */
  tempPath(name: string) {
    return path.join(this.options.tempDirectory, name);
  }

  /**
   * The text of an error for clients: without the SQL that DuckDB quotes (`LINE 1: …`), and with the
   * engine's folders left out of paths, so that responses do not show how the server is laid out.
   */
  clientMessage(error: unknown) {
    const folders = [this.options.tempDirectory, ...this.options.allowedDirectories]
      .map((folder) => (folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`))
      .filter((folder) => folder !== path.parse(folder).root)
      .sort((a, b) => b.length - a.length);
    let message = errorMessage(error).replace(/\n\s*LINE \d+:[\s\S]*$/, "");
    for (const folder of folders) message = message.replaceAll(folder, "");
    return message.trim();
  }
}

/**
 * The rows a view reads from: the table's relation, or the table with the formula columns of the view's
 * query computed over it.
 */
interface Scope {
  /** The table's columns, then the formula columns. */
  columns: SqlColumn[];
  relation: string;
  /** The column giving each row's position in the table. */
  position: string;
  /** The formula columns over a relation of the table's rows (that has `position`); the relation itself without formulas. */
  over: (from: string) => string;
  /** Tables to drop with the view (the formulas' constants). */
  tables: string[];
}

interface View {
  id: string;
  /** The table that reads go to. While building, it holds the first `readable` rows with every column. */
  name: string;
  rowCount: number;
  query: ViewQuery;
  scope: Scope;
  used: number;
  /**
   * `rows`: the view's table holds every column in view order. `positions`: only the rows' positions in the
   * table. `table`: formula columns over the table in its own order, without a table of the view's own.
   */
  kind: "rows" | "positions" | "table";
  status: ViewStatus;
  /** Rows that can be read, from the start of the view. */
  readable: number;
  error?: string;
  /** When a request last asked for the view (`Date.now()`). */
  touched: number;
  /** Requests waiting until the view is ready. */
  waiters: number;
  /** Settles when the view is ready, failed or was dropped. */
  done: Promise<void>;
  settle: (error?: unknown) => void;
  /** Tables to drop with the view. */
  tables: string[];
  dropped: boolean;
  /** Stops the running build. */
  interrupt: (() => void) | null;
}

function cancelledView() {
  return new SourceError(ErrorCodes.cancelled, "The view request was cancelled.", 409);
}

/** Waits for `promise`, but rejects with `cancelled` (and calls `onCancel`) as soon as `signal` aborts. */
function settledOrCancelled<T>(promise: Promise<T>, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      onCancel?.();
      reject(cancelledView());
    };
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", cancel));
  });
}

interface Preview {
  columns: SqlColumn[];
  values: CellValue[][];
  rows: number;
}

const ROW_COLUMN = "__vg_row";
const POSITION_COLUMN = "__vg_position";
/** The position of a row in the relation that shows written cells over the file's rows. */
const ID_COLUMN = "__vg_id";
/** Positions looked up per query when reading a view that holds only positions. */
const LOOKUP_BATCH = 2048;
/** Cells (rows × columns) one `rows` request may read: the answer is built in memory. */
const MAX_CELLS = 1_000_000;
/** Names the engine uses in its queries; a file's column with one of them gets another name in SQL. */
const RESERVED_NAMES = new Set(["rowid", ROW_COLUMN, POSITION_COLUMN, ID_COLUMN]);
/** Cells written per statement. */
const WRITE_BATCH = 500;

/** Whether the engine writes a column: its type can be written and its DuckDB type is a plain name. */
function writable(column: SqlColumn) {
  return editableType(column.type) && /^[A-Za-z0-9_ (),]+$/.test(column.sqlType);
}

/** Whether a query depends on the values of any of these columns. */
function usesColumns(query: ViewQuery, columns: Set<number>) {
  if (query.search?.trim()) return true;
  const used = [
    ...(query.sort ?? []).map((key) => key.column),
    ...(query.filters ?? []).map((filter) => filter.column),
    ...filterLeaves(query.where).map((filter) => filter.column),
  ];
  return used.some((column) => columns.has(column));
}

/**
 * The columns under the names used in SQL: a column whose name the engine needs itself (compared
 * without case, as SQL does) is given a free name, and keeps its own as `label`.
 */
function safeColumns(columns: SqlColumn[]): SqlColumn[] {
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  return columns.map((column) => {
    if (!RESERVED_NAMES.has(column.name.toLowerCase())) return column;
    let suffix = 1;
    while (taken.has(`${column.name}_${suffix}`.toLowerCase())) suffix++;
    const name = `${column.name}_${suffix}`;
    taken.add(name.toLowerCase());
    return { ...column, name, label: column.name };
  });
}

/** One open file. Created by `TableEngine.open`. */
export class OpenTable {
  status: TableInfo["status"] = "loading";
  progress: number | null = null;
  error: string | undefined;
  /** Set once `info()` has reported a failed load: `TableEngine.open` then loads the file again. */
  failureReported = false;
  readonly notes: string[] = [];
  /** Workbooks: the sheets, and the one that was read. */
  sheets: SheetInfo[] | undefined;
  sheet: string | undefined;
  /** Workbooks: what `readerFunction` reads the converted sheet with. */
  private workbookReader = "";
  columns: SqlColumn[] = [];
  rowCount: number | null = null;
  lastUsed = Date.now();
  private preview: Preview | null = null;
  /** The relation queries read from: a loaded table, or a view over the Parquet file. */
  private relation = "";
  /** The column giving each row's position in `relation`. */
  private position = "rowid";
  private readonly views = new Map<string, View>();
  private loadConnection: DuckDBConnection | null = null;
  private viewConnection: DuckDBConnection | null = null;
  private viewQueue: Promise<unknown> = Promise.resolve();
  /** Requests and builds waiting for their turn in `viewQueue`. */
  private queuedBuilds = 0;
  /** Previews being computed, by query, so that the same request at the same time shares one. */
  private readonly previews = new Map<
    string,
    { promise: Promise<View>; controller: AbortController; waiting: number }
  >();
  private readonly tempFiles: string[] = [];
  private readonly objects: string[] = [];
  private clock = 0;
  private disposed = false;
  /** Running exports, stopped when the table closes (for example because its file changed). */
  private readonly exports = new Set<AbortController>();
  /** Tables of written cells by schema column: the value (`v`) of each written row (`__vg_row`). */
  private readonly editTables = new Map<number, string>();
  /** The view that shows the written cells over the file's rows, once cells were written. */
  private overlay: string | null = null;
  /** The relation and position of the file's rows, before cells were written. */
  private base: { relation: string; position: string } | null = null;
  private editVersion = 0;
  /** Cells that hold a written value. */
  editedCells = 0;
  /** Writes and saves run one at a time. */
  private writes: Promise<unknown> = Promise.resolve();
  /** The revision of the file as the table holds it: the one it was read from, or the one it saved. */
  private fileState: string;
  /** Delimited files: the encoding of the file, the file DuckDB read (converted to UTF-8) and how. */
  private encoding: TextEncoding = "utf-8";
  private loadedSource = "";
  private loadAttempt = 0;
  private ready: Promise<void> = Promise.resolve();
  private listed: () => void = () => undefined;
  private readonly sheetsKnown = new Promise<void>((resolve) => {
    this.listed = resolve;
  });

  constructor(
    private readonly engine: TableEngine,
    readonly id: string,
    readonly path: string,
    readonly format: TableFormat,
    readonly revision: string,
    readonly byteSize: number,
    readonly read: ReadOptions = {},
  ) {
    this.fileState = revision;
  }

  /** Whether the table holds the file with this revision (also after saving into it). */
  readsFile(revision: string) {
    return revision === this.fileState;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  /**
   * The file's current revision (see `fileRevision`), or null when it is gone. It differs from
   * `info().revision` once the file changed; opening the file again then reads the new data.
   */
  async currentRevision(): Promise<string | null> {
    try {
      const revision = await fileRevision(this.path);
      // A file the table saved into holds the table's data: the table's revision stays.
      return revision === this.fileState ? this.revision : revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  start() {
    this.ready = this.load().catch((error: unknown) => {
      if (this.disposed) return;
      this.status = "error";
      // Clients see the file's name only; converted copies of the file stand for the file itself.
      let message = errorMessage(error);
      for (const file of [...this.tempFiles, this.path]) message = message.replaceAll(file, path.basename(this.path));
      this.error = this.engine.clientMessage(message);
      this.engine.options.log?.(`Could not open ${this.path}`, error);
    });
  }

  /** Waits until the table has finished loading (or failed). */
  whenReady() {
    return this.ready;
  }

  /** The rows of the table without formula columns. */
  private tableScope(): Scope {
    return {
      columns: this.columns,
      relation: this.relation,
      position: this.position,
      over: (from) => from,
      tables: [],
    };
  }

  /**
   * The rows of the table with the query's formula columns. Their literals go into a table of constants
   * (one row, filled with parameters), so that the queries reading the scope need no parameters of their own.
   */
  private async scopeOf(query: ViewQuery, signal?: AbortSignal): Promise<Scope> {
    const table = this.tableScope();
    const compiled = queryFormulas(this.info().columns, query);
    if (compiled.length === 0) return table;
    const select = formulaSelect(compiled, this.columns);
    let constants = "";
    if (select.constants.length > 0) {
      const name = this.engine.createId("vg_k");
      const params = new Parameters();
      const values = select.constants.map(
        // Numbers go as text, which reads back exactly: a whole JS number would be bound as a 64-bit integer.
        (item, index) =>
          `CAST(${params.add(typeof item.value === "number" ? String(item.value) : item.value)} AS ${item.sqlType}) AS ${quoteIdentifier(`c${index}`)}`,
      );
      await this.engine.withConnection(signal, (connection) =>
        connection.run(`CREATE TABLE ${quoteIdentifier(name)} AS SELECT ${values.join(", ")}`, params.values),
      );
      constants = `, ${quoteIdentifier(name)} k`;
      table.tables = [name];
    }
    const over = (from: string) =>
      select.layers.reduce(
        (relation, layer) =>
          layer.length === 0 ? relation : `(SELECT f.*, ${layer.join(", ")} FROM ${relation} f${constants})`,
        from,
      );
    // A table's positions are its `rowid`, which a subquery has only when it selects it.
    const rows = this.position === "rowid" ? `(SELECT b.rowid AS rowid, b.* FROM ${this.relation} b)` : this.relation;
    return { ...table, columns: [...this.columns, ...select.columns], relation: over(rows), over };
  }

  /** Workbooks: waits until the sheets are known (or the load failed before). */
  whenListed() {
    return Promise.race([this.sheetsKnown, this.ready]);
  }

  info(): TableInfo {
    const ready = this.status === "ready";
    const editable = this.engine.options.editable;
    if (this.status === "error") this.failureReported = true;
    return {
      columns: this.columns.map((column) => ({
        name: column.label ?? column.name,
        type: column.type,
        sourceType: column.sqlType,
        ...(editable && !writable(column) ? { readOnly: true } : {}),
      })),
      rowCount: ready ? this.rowCount : null,
      // The preview is served while loading only: a table that failed has no rows to read.
      readableRows: ready ? (this.rowCount ?? 0) : this.status === "loading" ? (this.preview?.rows ?? 0) : 0,
      status: this.status,
      progress: this.progress,
      ...(this.error ? { error: this.error } : {}),
      format: this.format,
      byteSize: this.byteSize,
      revision: this.revision,
      ...(this.notes.length > 0 ? { notes: [...this.notes] } : {}),
      ...(this.sheets ? { sheets: this.sheets.map((sheet) => ({ ...sheet })) } : {}),
      ...(this.sheet === undefined ? {} : { sheet: this.sheet }),
      capabilities: {
        sort: ready,
        filter: ready,
        search: ready,
        stats: ready,
        distinct: ready,
        aggregate: ready,
        find: ready,
        export: ready,
        conditions: ready,
        formulas: ready,
        ...(editable ? { edit: ready } : {}),
        ...(editable && this.engine.options.saveFiles ? { save: ready && this.savable() } : {}),
      },
      ...(ready ? { exports: { formats: ["csv", "tsv", "parquet", "json", "xlsx"], delivery: "file" } } : {}),
      ...(editable && ready ? { edits: this.edits() } : {}),
    };
  }

  edits(): TableEdits {
    return { version: this.editVersion, cells: this.editedCells };
  }

  /**
   * Writes cells (see `TableSource.updateCells`): every update, or none. Values are checked with
   * `normalizeCellValue` and converted to the column's DuckDB type. They are kept in a table per column,
   * which a view joins to the file's rows: once cells were written, every request reads that view.
   * Views whose rows or order may depend on the written columns are dropped (clients create them again).
   */
  async updateCells(request: UpdateRequest, signal?: AbortSignal): Promise<UpdateResult> {
    this.requireReady();
    if (!this.engine.options.editable) throw new SourceError(ErrorCodes.readOnly, "Editing is not enabled.", 403);
    if (request.updates.length > MAX_UPDATE_CELLS) {
      throw new SourceError(ErrorCodes.invalidRequest, `Write at most ${MAX_UPDATE_CELLS} cells at a time.`, 400);
    }
    if (request.revision !== undefined && request.revision !== this.revision) {
      throw new SourceError(
        ErrorCodes.revisionChanged,
        "The file was read again; its rows may be other records now.",
        409,
      );
    }
    const total = this.rowCount ?? 0;
    /** By column, then by row; a later update of the same cell wins. */
    const columns = new Map<number, Map<number, { value: CellValue; previous?: CellValue }>>();
    for (const update of request.updates) {
      const column = this.column(update.column);
      if (update.row >= total)
        throw new SourceError(ErrorCodes.invalidRequest, `Row ${update.row} does not exist.`, 400);
      const label = column.label ?? column.name;
      if (!writable(column)) throw new SourceError(ErrorCodes.readOnly, `The column ${label} is read-only.`, 403);
      const normalized = normalizeCellValue(update.value, {
        name: label,
        type: column.type,
        sourceType: column.sqlType,
      });
      if (!normalized.ok) {
        throw new SourceError(
          ErrorCodes.invalidValue,
          `Row ${update.row + 1}: the value does not fit the column ${label} (${normalized.error}).`,
          422,
        );
      }
      let rows = columns.get(update.column);
      if (!rows) {
        rows = new Map();
        columns.set(update.column, rows);
      }
      const earlier = rows.get(update.row);
      rows.set(update.row, {
        value: normalized.value,
        ...(earlier?.previous !== undefined
          ? { previous: earlier.previous }
          : update.previous !== undefined
            ? { previous: update.previous }
            : {}),
      });
    }
    const run = this.writes.then(() => this.write(columns, signal));
    this.writes = run.catch(() => undefined);
    const updated = await run;
    return { updated, edits: this.edits() };
  }

  private async write(
    columns: Map<number, Map<number, { value: CellValue; previous?: CellValue }>>,
    signal: AbortSignal | undefined,
  ) {
    const engine = this.engine;
    return engine.withConnection(signal, async (connection) => {
      if (this.disposed) throw new SourceError(ErrorCodes.cancelled, "The table was closed.", 409);
      // Cells changed since the client read them are not overwritten.
      for (const [index, rows] of columns) {
        const checked = [...rows].filter(([, update]) => update.previous !== undefined);
        const column = this.column(index);
        for (let from = 0; from < checked.length; from += LOOKUP_BATCH) {
          const batch = checked.slice(from, from + LOOKUP_BATCH);
          // The positions are validated integers, so listing them inline is safe.
          const result = await connection.runAndReadAll(
            `SELECT ${this.position}, ${selectExpression(column, MAX_TEXT_LIMIT)} FROM ${this.relation} WHERE ${this.position} IN (${batch.map(([row]) => row).join(", ")})`,
          );
          const current = new Map(result.getRowsJS().map((row) => [Number(row[0]), wireValue(row[1])]));
          for (const [row, update] of batch) {
            if (!sameCellValue(current.get(row) ?? null, update.previous)) {
              throw new SourceError(
                ErrorCodes.editConflict,
                `Row ${row + 1} of ${column.label ?? column.name} was changed meanwhile.`,
                409,
              );
            }
          }
        }
      }
      const created = new Map<number, string>();
      /** The first write: requests read the written cells through a new relation from now on. */
      let switched = false;
      let updated = 0;
      await connection.run("BEGIN TRANSACTION");
      try {
        for (const [index, rows] of columns) {
          const column = this.column(index);
          let table = this.editTables.get(index);
          if (!table) {
            table = engine.createId("vg_e");
            // `saved`: the value is in the file too (see `saveEdits`).
            await connection.run(
              `CREATE TABLE ${quoteIdentifier(table)} (${ROW_COLUMN} BIGINT, v ${column.sqlType}, saved BOOLEAN)`,
            );
            created.set(index, table);
          }
          const list = [...rows];
          for (let from = 0; from < list.length; from += WRITE_BATCH) {
            const batch = list.slice(from, from + WRITE_BATCH);
            await connection.run(
              `DELETE FROM ${quoteIdentifier(table)} WHERE ${ROW_COLUMN} IN (${batch.map(([row]) => row).join(", ")})`,
            );
            const params = new Parameters();
            const values = batch.map(
              ([row, update]) => `(${row}, CAST(${params.add(update.value)} AS ${column.sqlType}), false)`,
            );
            await connection.run(`INSERT INTO ${quoteIdentifier(table)} VALUES ${values.join(", ")}`, params.values);
          }
          updated += rows.size;
        }
        const overlay =
          created.size > 0 ? await this.createOverlay(connection, new Map([...this.editTables, ...created])) : null;
        await connection.run("COMMIT");
        if (overlay) {
          this.base ??= { relation: this.relation, position: this.position };
          switched = this.overlay === null;
          if (!this.overlay) this.objects.unshift(`VIEW ${quoteIdentifier(overlay)}`);
          this.overlay = overlay;
          this.relation = quoteIdentifier(overlay);
          this.position = ID_COLUMN;
        }
      } catch (error) {
        await connection.run("ROLLBACK").catch(() => undefined);
        if (error instanceof SourceError) throw error;
        // A value DuckDB cannot convert to the column's type (for example a date out of its range).
        if (/^(Conversion|Invalid Input|Out of Range) Error/.test(errorMessage(error))) {
          throw new SourceError(ErrorCodes.invalidValue, engine.clientMessage(error), 422);
        }
        throw error;
      }
      for (const [index, table] of created) {
        this.editTables.set(index, table);
        this.objects.push(`TABLE ${quoteIdentifier(table)}`);
      }
      this.editedCells = await this.countEdits(connection);
      this.editVersion++;
      // Views copy the rows (kind `rows`), or hold an order and rows that may depend on the new values. Views
      // keep the relation they were made over (`scope`), so after the first write, which reads the written
      // cells through a new relation, none is kept; nor views with formula columns, which may use the cells.
      const touched = new Set(columns.keys());
      for (const preview of this.previews.values()) preview.controller.abort();
      await this.dropViews(
        [...this.views.values()].filter(
          (view) =>
            switched ||
            view.kind !== "positions" ||
            view.status !== "ready" ||
            Boolean(view.query.formulas?.length) ||
            usesColumns(view.query, touched),
        ),
      );
      return updated;
    });
  }

  /** Cells with a written value that is not saved into the file yet. */
  private async countEdits(connection: DuckDBConnection) {
    const counts = [...this.editTables.values()].map(
      (table) => `(SELECT count(*) FROM ${quoteIdentifier(table)} WHERE NOT saved)`,
    );
    if (counts.length === 0) return 0;
    return Number((await connection.runAndReadAll(`SELECT ${counts.join(" + ")}`)).getRowsJS()[0][0]);
  }

  /**
   * Whether written cells can be saved into the file: a delimited file that is not compressed and was read
   * with its types (not as irregular text, whose records DuckDB may have read loosely).
   */
  private savable() {
    return (this.format === "csv" || this.format === "tsv") && !/\.(gz|zst)$/i.test(this.path) && this.loadAttempt < 2;
  }

  /**
   * Saves the written cells into the file (see `rewriteCsv`): only the records with cells written since
   * the last save are written anew, and every other byte stays as it was. The file is written under a
   * temporary name next to it and renamed over it once complete, so that a failed or cancelled save leaves
   * it as it was. A file changed by someone else since it was read (or saved) is not saved
   * (`file_changed`). The table keeps its revision and row positions; written cells count as saved.
   */
  async saveEdits(signal?: AbortSignal): Promise<SaveResult> {
    this.requireReady();
    if (!this.engine.options.editable || !this.engine.options.saveFiles) {
      throw new SourceError(ErrorCodes.readOnly, "Saving files is not enabled.", 403);
    }
    if (!this.savable()) {
      throw new SourceError(
        ErrorCodes.saveUnsupported,
        "Only CSV and TSV files that are not compressed, and were read with their types, can be saved.",
        422,
      );
    }
    const run = this.writes.then(() => this.save(signal));
    this.writes = run.catch(() => undefined);
    const records = await run;
    return { records, edits: this.edits() };
  }

  private async save(signal?: AbortSignal) {
    const engine = this.engine;
    if (this.disposed) throw new SourceError(ErrorCodes.cancelled, "The table was closed.", 409);
    // The file must still be the one the table read, at its real location inside the allowed folders.
    const real = await realpath(this.path).catch(() => null);
    if (real !== this.path || !engine.allows(real)) throw notAllowed();
    const changed = () =>
      new SourceError(ErrorCodes.fileChanged, "The file was changed by someone else since it was read.", 409);
    if ((await fileRevision(this.path)) !== this.fileState) throw changed();
    const { edits, dialect } = await engine.withConnection(signal, async (connection) => {
      const edits = new Map<number, Map<number, string | null>>();
      for (const [index, table] of this.editTables) {
        // DuckDB's own text of each value, which it reads back as the same value.
        const result = await connection.runAndReadAll(
          `SELECT ${ROW_COLUMN}, CAST(v AS VARCHAR) FROM ${quoteIdentifier(table)} WHERE NOT saved`,
        );
        for (const [row, value] of result.getRowsJS()) {
          let fields = edits.get(Number(row));
          if (!fields) {
            fields = new Map();
            edits.set(Number(row), fields);
          }
          fields.set(index, value === null ? null : String(value));
        }
      }
      return { edits, dialect: edits.size > 0 ? await this.dialect(connection) : null };
    });
    if (!dialect || edits.size === 0) return 0;
    const temporary = path.join(
      path.dirname(this.path),
      `.${path.basename(this.path)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let records: number;
    try {
      ({ records } = await rewriteCsv({
        source: this.path,
        target: temporary,
        encoding: this.encoding,
        dialect,
        columns: this.columns.length,
        rows: this.rowCount ?? 0,
        edits,
        signal,
      }));
      signal?.throwIfAborted();
      // Changed while it was written: the new file would lose that change.
      if ((await fileRevision(this.path)) !== this.fileState) throw changed();
      await chmod(temporary, (await stat(this.path)).mode);
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      if (signal?.aborted) throw new SourceError(ErrorCodes.cancelled, "The save was cancelled.", 499);
      if (error instanceof CsvSaveError) {
        throw new SourceError(
          error.code === "encoding" ? ErrorCodes.invalidValue : ErrorCodes.saveUnsupported,
          error.message,
          422,
        );
      }
      throw error;
    }
    this.fileState = await fileRevision(this.path);
    await engine.withConnection(undefined, async (connection) => {
      for (const table of this.editTables.values())
        await connection.run(`UPDATE ${quoteIdentifier(table)} SET saved = true`);
      this.editedCells = await this.countEdits(connection);
    });
    this.editVersion++;
    return records;
  }

  /** How DuckDB read the file's records: its delimiter, quote, escape, header and skipped lines. */
  private async dialect(connection: DuckDBConnection): Promise<CsvDialect> {
    const options = `${this.format === "tsv" ? ", delim='\\t'" : ""}, null_padding=true${this.loadAttempt === 1 ? ", sample_size=-1" : ""}`;
    const row = (
      await connection.runAndReadAll(
        `SELECT Delimiter, Quote, Escape, Comment, SkipRows, HasHeader FROM sniff_csv($1${options})`,
        [this.loadedSource],
      )
    ).getRowsJS()[0];
    const text = (value: unknown) => (value === null || value === "(empty)" ? "" : String(value));
    if (text(row[3])) throw new CsvSaveError("unsupported", "Files with comment lines cannot be saved.");
    const quote = text(row[1]) || '"';
    return {
      delimiter: text(row[0]) || (this.format === "tsv" ? "\t" : ","),
      quote,
      escape: text(row[2]) || quote,
      skipRows: Number(row[4] ?? 0),
      header: row[5] === true,
    };
  }

  /** Creates (or replaces) the view that reads the written cells over the file's rows. Returns its name. */
  private async createOverlay(connection: DuckDBConnection, tables: Map<number, string>) {
    const base = this.base ?? { relation: this.relation, position: this.position };
    const name = this.overlay ?? this.engine.createId("vg_x");
    const joins: string[] = [];
    const selected = this.columns.map((column, index) => {
      const id = quoteIdentifier(column.name);
      const table = tables.get(index);
      if (!table) return `b.${id}`;
      const alias = `e${index}`;
      joins.push(`LEFT JOIN ${quoteIdentifier(table)} ${alias} ON ${alias}.${ROW_COLUMN} = b.${base.position}`);
      return `CASE WHEN ${alias}.${ROW_COLUMN} IS NULL THEN b.${id} ELSE ${alias}.v END AS ${id}`;
    });
    await connection.run(
      `CREATE OR REPLACE VIEW ${quoteIdentifier(name)} AS SELECT b.${base.position} AS ${ID_COLUMN}, ${selected.join(", ")} FROM ${base.relation} b ${joins.join(" ")}`,
    );
    return name;
  }

  private async describe(connection: DuckDBConnection, sql: string, values: string[] = []) {
    const reader = await connection.runAndReadAll(`DESCRIBE ${sql}`, values);
    return reader.getRowsJS().map((row) => {
      const name = String(row[0]);
      const sqlType = String(row[1]);
      return { name, sqlType, type: columnTypeOf(sqlType) } satisfies SqlColumn;
    });
  }

  /** Renames the columns of a table this engine created whose names it needs itself (see `safeColumns`). */
  private async renameReserved(connection: DuckDBConnection, table: string, columns: SqlColumn[]) {
    const safe = safeColumns(columns);
    for (const column of safe) {
      if (column.label === undefined) continue;
      await connection.run(
        `ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(column.label)} TO ${quoteIdentifier(column.name)}`,
      );
    }
    return safe;
  }

  private readerFunction(format: TableFormat, attempt: number) {
    if (format === "xlsx") return this.workbookReader;
    if (format === "json") return attempt === 0 ? "read_json_auto($1)" : "read_json_auto($1, sample_size=-1)";
    if (format === "ndjson") {
      return attempt === 0
        ? "read_json_auto($1, format='newline_delimited')"
        : "read_json_auto($1, format='newline_delimited', sample_size=-1)";
    }
    // Without null_padding, DuckDB's sniffer may settle on the last consistent part of a file whose
    // rows have different numbers of fields and silently skip the rest.
    const options = `${format === "tsv" ? ", delim='\\t'" : ""}, null_padding=true`;
    switch (attempt) {
      case 0:
        return `read_csv($1${options})`;
      case 1:
        // Types sniffed from the beginning did not hold for the whole file: sniff all rows.
        return `read_csv($1${options}, sample_size=-1)`;
      default:
        // Irregular files: read every column as text and tolerate quotes and long lines.
        return `read_csv($1${options}, all_varchar=true, strict_mode=false, max_line_size=67108864)`;
    }
  }

  private async load() {
    const engine = this.engine;
    if (this.format === "parquet") {
      await engine.withConnection(undefined, async (connection) => {
        const columns = await this.describe(connection, "SELECT * FROM read_parquet($1)", [this.path]);
        const name = engine.createId("vg_p");
        let safe: SqlColumn[];
        if (columns.some((column) => column.name.toLowerCase() === "file_row_number")) {
          // The file already has a column with this name: load it as a table instead.
          await connection.run(`CREATE TABLE ${quoteIdentifier(name)} AS SELECT * FROM read_parquet($1)`, [this.path]);
          this.objects.push(`TABLE ${quoteIdentifier(name)}`);
          this.position = "rowid";
          safe = await this.renameReserved(connection, name, columns);
        } else {
          safe = safeColumns(columns);
          const selected = safe.map((column) =>
            column.label === undefined
              ? quoteIdentifier(column.name)
              : `${quoteIdentifier(column.label)} AS ${quoteIdentifier(column.name)}`,
          );
          await connection.run(
            `CREATE VIEW ${quoteIdentifier(name)} AS SELECT ${[...selected, "file_row_number"].join(", ")} FROM read_parquet(${quoteLiteral(this.path)}, file_row_number=true)`,
          );
          this.objects.push(`VIEW ${quoteIdentifier(name)}`);
          this.position = "file_row_number";
        }
        const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
        if (this.disposed) {
          const object = this.objects.pop() ?? "";
          await connection.run(`DROP ${object.split(" ")[0]} IF EXISTS ${quoteIdentifier(name)}`);
          return;
        }
        this.columns = safe;
        this.relation = quoteIdentifier(name);
        this.rowCount = Number(count.getRowsJS()[0][0]);
        this.status = "ready";
        this.progress = 1;
      });
      return;
    }
    let source = this.path;
    if (this.format === "csv" || this.format === "tsv") {
      const encoding = await detectEncoding(this.path);
      this.encoding = encoding;
      if (encoding !== "utf-8") {
        source = await this.convert(encoding);
      }
    }
    if (this.format === "xlsx") source = await this.convertWorkbook();
    if (this.disposed) return;
    await this.loadPreview(source);
    await engine.loads.run(async () => {
      if (this.disposed) return;
      let lastError: unknown = null;
      // A converted sheet has one type per column already: nothing to retry.
      const attempts = this.format === "csv" || this.format === "tsv" ? 3 : this.format === "xlsx" ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await this.loadTable(source, attempt);
          this.loadedSource = source;
          this.loadAttempt = attempt;
          if (attempt === 2) this.notes.push("all_varchar");
          return;
        } catch (error) {
          if (this.disposed) return;
          lastError = error;
          engine.options.log?.(`Loading ${this.path} failed (attempt ${attempt + 1})`, error);
          if (/unicode|utf-?8/i.test(errorMessage(error)) && source === this.path) {
            // The sample was valid UTF-8 but a later part is not: convert with replacement characters.
            source = await this.convert("utf-8");
            this.notes.push("invalid_utf8_replaced");
          }
        }
      }
      throw lastError;
    });
  }

  private async convert(encoding: string) {
    const target = this.engine.tempPath(`${this.engine.createId("convert")}.csv`);
    this.tempFiles.push(target);
    await convertToUtf8(this.path, target, encoding);
    if (encoding !== "utf-8") this.notes.push(`encoding:${encoding.startsWith("utf-16") ? "utf-16" : encoding}`);
    return target;
  }

  /** Converts the chosen sheet to a CSV file with a type per column (see `xlsx.ts`), which is then loaded. */
  private async convertWorkbook() {
    const target = this.engine.tempPath(`${this.engine.createId("sheet")}.csv`);
    this.tempFiles.push(target);
    try {
      const workbook = await readWorkbook(this.path);
      this.sheets = sheetList(workbook);
      this.listed();
      const sheet = await this.engine.loads.run(() =>
        convertSheet(this.path, target, {
          ...this.read,
          workbook,
          // Reading the sheet takes most of the time; DuckDB loading the converted file takes the rest.
          onProgress: (share) => {
            this.progress = share * 0.9;
          },
          cancelled: () => this.disposed,
        }),
      );
      this.sheet = sheet.sheet;
      this.notes.push(...sheet.notes);
      this.workbookReader = sheet.reader;
    } catch (error) {
      if (error instanceof WorkbookError) throw new SourceError(ErrorCodes.loadFailed, error.message, 422);
      throw error;
    }
    return target;
  }

  private async loadPreview(source: string) {
    const engine = this.engine;
    try {
      await engine.withConnection(undefined, async (connection) => {
        const reader = this.readerFunction(this.format, 0);
        const columns = await this.describe(connection, `SELECT * FROM ${reader}`, [source]);
        const expressions = columns.map((column) => selectExpression(column, engine.options.textLimit));
        const result = await connection.runAndReadAll(
          `SELECT ${expressions.join(", ")} FROM ${reader} LIMIT ${engine.options.previewRows}`,
          [source],
        );
        const values = result.getColumnsJS().map((column) => column.map(wireValue));
        if (this.status === "loading") {
          this.columns = columns;
          this.preview = { columns, values, rows: result.currentRowCount };
        }
      });
    } catch (error) {
      // The full load reports the error; the preview is only a head start.
      engine.options.log?.(`Preview of ${this.path} failed`, error);
    }
  }

  private async loadTable(source: string, attempt: number) {
    const engine = this.engine;
    const connection = await engine.connect();
    this.loadConnection = connection;
    const name = engine.createId("vg_t");
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await connection.run("SET enable_progress_bar = true; SET enable_progress_bar_print = false");
      timer = setInterval(() => {
        const percentage = connection.progress.percentage;
        if (percentage >= 0) this.progress = Math.max(this.progress ?? 0, Math.min(0.99, percentage / 100));
      }, 200);
      const reader = this.readerFunction(this.format, attempt);
      await connection.run(`CREATE TABLE ${quoteIdentifier(name)} AS SELECT * FROM ${reader}`, [source]);
      if (this.disposed) {
        await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
        return;
      }
      this.objects.push(`TABLE ${quoteIdentifier(name)}`);
      const columns = await this.renameReserved(
        connection,
        name,
        await this.describe(connection, `SELECT * FROM ${quoteIdentifier(name)}`),
      );
      const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
      this.columns = columns;
      this.relation = quoteIdentifier(name);
      this.position = "rowid";
      this.rowCount = Number(count.getRowsJS()[0][0]);
      this.preview = null;
      this.status = "ready";
      this.progress = 1;
    } catch (error) {
      await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      this.loadConnection = null;
      connection.closeSync();
    }
  }

  private requireReady() {
    if (this.status === "error")
      throw new SourceError(ErrorCodes.loadFailed, this.error ?? "The file could not be read.", 422);
    if (this.status !== "ready") throw new SourceError(ErrorCodes.notReady, "The table is still loading.", 409);
  }

  private view(id: string | null): View | null {
    if (id === null) return null;
    const view = this.views.get(id);
    if (!view) throw new SourceError(ErrorCodes.viewNotFound, "The view no longer exists.", 404);
    view.used = ++this.clock;
    view.touched = Date.now();
    return view;
  }

  /** Refuses operations that need every row of a view while it is not ready. */
  private requireBuilt(view: View | null) {
    if (view && view.status !== "ready")
      throw new SourceError(ErrorCodes.notReady, "The view is still being built.", 409);
  }

  /**
   * The rows of a view (or the table) as a relation, with a column `position` that gives each row's
   * place in the view. Views that hold only positions are joined back to the table.
   */
  private relationOf(view: View | null): { from: string; position: string } {
    if (!view) return { from: this.relation, position: this.position };
    if (view.kind === "rows") return { from: quoteIdentifier(view.name), position: "rowid" };
    if (view.kind === "table") return { from: view.scope.relation, position: view.scope.position };
    return {
      from: `(SELECT w.rowid AS ${POSITION_COLUMN}, b.* FROM ${quoteIdentifier(view.name)} w JOIN ${view.scope.relation} b ON b.${this.position} = w.${quoteIdentifier(ROW_COLUMN)})`,
      position: POSITION_COLUMN,
    };
  }

  /** The table's rows (`b`) of a view that holds positions, with the formula columns, under a condition on them. */
  private positionRows(view: View, condition: string) {
    if (view.scope.tables.length === 0 && view.scope.columns.length === this.columns.length) {
      return `(SELECT b.* FROM ${this.relation} b ${condition})`;
    }
    const position = this.position === "rowid" ? "b.rowid AS rowid, " : "";
    return view.scope.over(`(SELECT ${position}b.* FROM ${this.relation} b ${condition})`);
  }

  /** The rows of a view in any order, for statistics. */
  private unorderedRelation(view: View | null): string {
    // A view that only sorts has the same rows as the table, also while it is building.
    if (view && !filtersRows(view.query)) return view.scope.relation;
    this.requireBuilt(view);
    if (view?.kind !== "positions") return this.relationOf(view).from;
    return this.positionRows(
      view,
      `SEMI JOIN ${quoteIdentifier(view.name)} w ON b.${this.position} = w.${quoteIdentifier(ROW_COLUMN)}`,
    );
  }

  /** Rows `[$1, $2)` of a view, in any order, for selection summaries. */
  private rangeRelation(view: View | null): string {
    if (!view) return `(SELECT * FROM ${this.relation} WHERE ${this.position} >= $1 AND ${this.position} < $2)`;
    if (view.kind === "rows") return `(SELECT * FROM ${quoteIdentifier(view.name)} WHERE rowid >= $1 AND rowid < $2)`;
    if (view.kind === "table") {
      return `(SELECT * FROM ${view.scope.relation} WHERE ${view.scope.position} >= $1 AND ${view.scope.position} < $2)`;
    }
    return this.positionRows(
      view,
      `WHERE b.${this.position} IN (SELECT ${quoteIdentifier(ROW_COLUMN)} FROM ${quoteIdentifier(view.name)} WHERE rowid >= $1 AND rowid < $2)`,
    );
  }

  /** A column of the table, or of a view with formula columns. */
  private column(index: number, view: View | null = null) {
    const column = (view?.scope.columns ?? this.columns)[index];
    if (!column) throw new SourceError(ErrorCodes.invalidRequest, `Column ${index} does not exist.`, 400);
    return column;
  }

  async readRows(request: RowRequest & { textLimit?: number }, signal?: AbortSignal): Promise<RowBlock> {
    if ((request.end - request.start) * request.columns.length > MAX_CELLS) {
      throw new SourceError(ErrorCodes.invalidRequest, "Read at most a million cells at a time.", 400);
    }
    const limit = Math.min(Math.max(1, request.textLimit ?? this.engine.options.textLimit), MAX_TEXT_LIMIT);
    if (this.status === "loading") {
      // While loading, the beginning of the file is served from the preview.
      const preview = this.preview;
      if (!preview || request.start >= preview.rows) {
        throw new SourceError(ErrorCodes.notReady, "These rows are still loading.", 409);
      }
      const end = Math.min(request.end, preview.rows);
      const start = Math.min(request.start, end);
      return {
        start,
        end,
        columns: request.columns.map((index) => {
          const values = preview.values[index];
          if (!values) throw new SourceError(ErrorCodes.invalidRequest, `Column ${index} does not exist.`, 400);
          return values.slice(start, end);
        }),
        rowIds: null,
      };
    }
    this.requireReady();
    const view = this.view(request.view);
    const total = view ? view.rowCount : (this.rowCount ?? 0);
    // A view that is building serves its first rows only, like a table that is loading.
    if (view && request.start >= view.readable && request.start < total) {
      throw new SourceError(ErrorCodes.notReady, "These rows of the view are still being sorted.", 409);
    }
    const end = Math.min(request.end, view ? view.readable : total);
    const start = Math.min(request.start, end);
    if (request.end - request.start > 1_000_000) {
      throw new SourceError(ErrorCodes.invalidRequest, "Read at most a million rows at a time.", 400);
    }
    const columns = request.columns.map((index) => this.column(index, view));
    if (end === start) return { start, end, columns: columns.map(() => []), rowIds: view ? [] : null };
    if (view?.kind === "positions") return this.readPositions(view, start, end, columns, limit, signal);
    const { from, position } = this.relationOf(view);
    const expressions = columns.map((column) => selectExpression(column, limit));
    if (view) expressions.push(view.kind === "table" ? position : quoteIdentifier(ROW_COLUMN));
    const sql = `SELECT ${expressions.length > 0 ? expressions.join(", ") : "1"} FROM ${from} WHERE ${position} >= $1 AND ${position} < $2 ORDER BY ${position}`;
    return this.engine.withConnection(signal, async (connection) => {
      const result = await connection.runAndReadAll(sql, [start, end]);
      const data = result.getColumnsJS();
      const values = columns.map((_, index) => (data[index] ?? []).map(wireValue));
      const rowIds = view ? (data[columns.length] ?? []).map((value) => Number(value)) : null;
      return { start, end, columns: values, rowIds };
    });
  }

  /** Reads rows of a view that holds only positions: looks the positions up in the table, then restores the view's order. */
  private readPositions(
    view: View,
    start: number,
    end: number,
    columns: SqlColumn[],
    limit: number,
    signal?: AbortSignal,
  ) {
    const expressions = columns.map((column) => selectExpression(column, limit));
    return this.engine.withConnection(signal, async (connection) => {
      const ids = (
        await connection.runAndReadAll(
          `SELECT ${quoteIdentifier(ROW_COLUMN)} FROM ${quoteIdentifier(view.name)} WHERE rowid >= $1 AND rowid < $2 ORDER BY rowid`,
          [start, end],
        )
      )
        .getColumnsJS()[0]
        .map((value) => Number(value));
      const values: CellValue[][] = columns.map(() => new Array<CellValue>(ids.length).fill(null));
      for (let from = 0; from < ids.length; from += LOOKUP_BATCH) {
        const batch = ids.slice(from, from + LOOKUP_BATCH);
        // The positions are integers read from DuckDB, so listing them inline is safe.
        const result = await connection.runAndReadAll(
          `SELECT ${view.scope.position}${expressions.length > 0 ? `, ${expressions.join(", ")}` : ""} FROM ${view.scope.relation} WHERE ${view.scope.position} IN (${batch.join(", ")})`,
        );
        const data = result.getColumnsJS();
        const place = new Map<number, number>();
        for (const [offset, id] of batch.entries()) place.set(id, from + offset);
        (data[0] ?? []).forEach((position, row) => {
          const at = place.get(Number(position));
          if (at === undefined) return;
          columns.forEach((_, index) => {
            values[index][at] = wireValue(data[index + 1]?.[row]);
          });
        });
      }
      return { start, end: start + ids.length, columns: values, rowIds: ids };
    });
  }

  /** Builds the WHERE clause of a query, over the scope's columns. The search looks in the table's columns only. */
  private where(query: ViewQuery, params: Parameters, scope: Scope) {
    const parts = (query.filters ?? []).map((filter) => filterExpression(filter, scope.columns, params));
    const condition = conditionExpression(query.where, scope.columns, params);
    if (condition) parts.push(condition);
    if (query.search?.trim()) parts.push(searchExpression(query.search.trim(), this.columns, params));
    return parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  }

  /**
   * Creates a sorted or filtered view, or returns the view of the same query. Views are built one at a
   * time per table. Requests never cancel each other, since several grids or people may share the
   * table: a request is cancelled by its own signal (its caller then receives `cancelled`).
   *
   * With `options.preview`, a sort of a large table answers once its first rows are known (in the
   * order of the finished view: ties are broken by the position in the table), with
   * `status: "building"`; the view is finished in the background, and `viewInfo` tells when it is ready.
   */
  async createView(query: ViewQuery, signal?: AbortSignal, options?: ViewOptions): Promise<ViewInfo> {
    this.requireReady();
    if (isEmptyQuery(query)) return { id: null, rowCount: this.rowCount ?? 0, query: {} };
    const key = JSON.stringify(query);
    const preview =
      options?.preview === true &&
      Boolean(query.sort?.length) &&
      (this.rowCount ?? 0) >= this.engine.options.viewPreviewMinRows;
    let view = this.sameView(key);
    // Formula columns alone need no table of the view's own.
    if (!view && !query.sort?.length && !filtersRows(query)) view = await this.formulaView(query, signal);
    if (!view && preview) view = await this.startPreview(query, key, signal);
    if (!view) {
      // A request that waited behind a build of the same query gets that view.
      this.queuedBuilds++;
      const run = this.viewQueue.then(() => {
        this.queuedBuilds--;
        return this.sameView(key) ?? this.buildView(query, signal);
      });
      this.viewQueue = run.catch(() => undefined);
      view = await run;
    }
    if (options?.preview) return this.infoOf(view);
    return this.whenBuilt(view, signal);
  }

  /** A view of the table in its own order with formula columns. */
  private async formulaView(query: ViewQuery, signal?: AbortSignal): Promise<View> {
    const scope = await this.scopeOf(query, signal);
    const rowCount = this.rowCount ?? 0;
    const view = this.newView(this.engine.createId("v"), query, {
      name: "",
      kind: "table",
      scope,
      rowCount,
      readable: rowCount,
    });
    view.settle();
    if (this.disposed) {
      await this.dropViews([view]);
      throw cancelledView();
    }
    this.views.set(view.id, view);
    await this.trimViews();
    return view;
  }

  /** The state of a view, for clients that poll a view while it is building. */
  viewInfo(id: string | null): ViewInfo {
    this.requireReady();
    const view = this.view(id);
    return view ? this.infoOf(view) : { id: null, rowCount: this.rowCount ?? 0, query: {} };
  }

  private infoOf(view: View): ViewInfo {
    return {
      id: view.id,
      rowCount: view.rowCount,
      query: view.query,
      status: view.status,
      readableRows: view.readable,
      ...(view.error ? { error: view.error } : {}),
    };
  }

  /** The view of the same query. A view whose build failed is dropped, so that the query is built again. */
  private sameView(key: string): View | null {
    const view = [...this.views.values()].find((item) => JSON.stringify(item.query) === key);
    if (!view) return null;
    if (view.status === "error") {
      void this.dropViews([view]);
      return null;
    }
    view.used = ++this.clock;
    view.touched = Date.now();
    return view;
  }

  /** Waits until a view is ready. */
  private async whenBuilt(view: View, signal?: AbortSignal): Promise<ViewInfo> {
    if (view.status === "building") {
      view.waiters++;
      try {
        await settledOrCancelled(view.done, signal);
      } finally {
        view.waiters--;
        view.touched = Date.now();
      }
    }
    return this.infoOf(view);
  }

  private newView(
    id: string,
    query: ViewQuery,
    fields: Pick<View, "name" | "kind" | "scope" | "rowCount" | "readable">,
  ): View {
    let settle: View["settle"] = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = (error?: unknown) => (error === undefined ? resolve() : reject(error));
    });
    // Nobody may be waiting for the build.
    done.catch(() => undefined);
    return {
      id,
      query,
      ...fields,
      used: ++this.clock,
      status: fields.readable < fields.rowCount ? "building" : "ready",
      touched: Date.now(),
      waiters: 0,
      done,
      settle,
      tables: [...(fields.name ? [fields.name] : []), ...fields.scope.tables],
      dropped: false,
      interrupt: null,
    };
  }

  private async buildView(query: ViewQuery, signal?: AbortSignal): Promise<View> {
    return this.engine.work.run(async () => {
      const scope = await this.scopeOf(query, signal);
      let built: Awaited<ReturnType<OpenTable["materialize"]>>;
      try {
        built = await this.materialize(query, signal, null, scope);
      } catch (error) {
        await this.dropTables(scope.tables);
        throw error;
      }
      const view = this.newView(this.engine.createId("v"), query, { ...built, scope, readable: built.rowCount });
      view.settle();
      if (this.disposed) {
        await this.dropViews([view]);
        throw cancelledView();
      }
      this.views.set(view.id, view);
      await this.trimViews();
      return view;
    });
  }

  /**
   * Builds the view's table: the rows in view order, ties broken by the position in the table, with
   * every column or (for large tables) only the positions. `watch` is a view whose background build
   * this is: dropping or abandoning it stops the build.
   */
  private async materialize(query: ViewQuery, signal: AbortSignal | undefined, watch: View | null, scope: Scope) {
    const engine = this.engine;
    const params = new Parameters();
    const where = this.where(query, params, scope);
    const order = [...orderTerms(query.sort ?? [], scope.columns), scope.position];
    const name = engine.createId("vg_v");
    // Large tables keep only the order: sorting every column of 100M rows takes minutes and gigabytes.
    const kind: View["kind"] = (this.rowCount ?? 0) > engine.options.materializeRows ? "positions" : "rows";
    const selected = kind === "rows" ? scope.columns.map((column) => quoteIdentifier(column.name)).join(", ") : "";
    const sql = `CREATE TABLE ${quoteIdentifier(name)} AS SELECT ${scope.position} AS ${quoteIdentifier(ROW_COLUMN)}${selected ? `, ${selected}` : ""} FROM ${scope.relation} ${where} ORDER BY ${order.join(", ")}`;
    const connection = await engine.connect();
    this.viewConnection = connection;
    const interrupt = () => connection.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (watch) {
      watch.interrupt = () => {
        stopped = true;
        interrupt();
      };
      timer = setInterval(() => {
        if (this.abandoned(watch)) watch.interrupt?.();
      }, 250);
    }
    try {
      // A request cancelled while it waited for its turn builds nothing.
      if (this.disposed || signal?.aborted || watch?.dropped || (watch && this.abandoned(watch))) throw cancelledView();
      await connection.run(sql, params.values);
      const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
      const rowCount = Number(count.getRowsJS()[0][0]);
      if (this.disposed || stopped || watch?.dropped) throw cancelledView();
      return { name, kind, rowCount };
    } catch (error) {
      await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined);
      if (stopped || isInterrupt(error)) throw cancelledView();
      throw error;
    } finally {
      clearInterval(timer);
      if (watch) watch.interrupt = null;
      signal?.removeEventListener("abort", interrupt);
      this.viewConnection = null;
      connection.closeSync();
    }
  }

  /** Whether nobody follows a view that is building while another view of the table waits for its turn. */
  private abandoned(view: View) {
    return (
      view.waiters === 0 &&
      this.queuedBuilds > 0 &&
      Date.now() - view.touched > this.engine.options.abandonedViewTimeout
    );
  }

  /**
   * Reads the first rows of a sort into a small table (a top-N query, far faster than the sort of
   * every row) and registers the view as building; the rest is built in the background, in turn with
   * the other builds of the table.
   */
  private async dropTables(tables: string[]) {
    if (tables.length === 0) return;
    await this.engine
      .withConnection(undefined, async (connection) => {
        for (const table of tables) await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
      })
      .catch(() => undefined);
  }

  private startPreview(query: ViewQuery, key: string, signal?: AbortSignal): Promise<View> {
    let shared = this.previews.get(key);
    if (!shared) {
      // Not tied to one request's signal: it stops only when every request waiting for it is cancelled.
      const controller = new AbortController();
      const promise = this.buildPreview(query, controller.signal).finally(() => this.previews.delete(key));
      shared = { promise, controller, waiting: 0 };
      this.previews.set(key, shared);
    }
    const entry = shared;
    entry.waiting++;
    return settledOrCancelled(entry.promise, signal, () => {
      if (--entry.waiting === 0) entry.controller.abort();
    });
  }

  private async buildPreview(query: ViewQuery, signal?: AbortSignal): Promise<View> {
    const engine = this.engine;
    const scope = await this.scopeOf(query, signal);
    const params = new Parameters();
    const where = this.where(query, params, scope);
    // The same order as the finished view, so that the first rows are the view's first rows.
    const order = [...orderTerms(query.sort ?? [], scope.columns), scope.position];
    const name = engine.createId("vg_p");
    const selected = scope.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const limit = params.add(engine.options.viewPreviewRows);
    const sql = `CREATE TABLE ${quoteIdentifier(name)} AS SELECT ${scope.position} AS ${quoteIdentifier(ROW_COLUMN)}${selected ? `, ${selected}` : ""} FROM ${scope.relation} ${where} ORDER BY ${order.join(", ")} LIMIT ${limit}`;
    const view = await engine
      .withConnection(signal, async (connection) => {
        if (this.disposed) throw cancelledView();
        await connection.run(sql, params.values);
        try {
          const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
          const readable = Number(count.getRowsJS()[0][0]);
          let rowCount = readable;
          if (readable >= engine.options.viewPreviewRows) {
            if (!filtersRows(query)) rowCount = this.rowCount ?? 0;
            else {
              const counting = new Parameters();
              const filtered = `SELECT count(*) FROM ${scope.relation} ${this.where(query, counting, scope)}`;
              rowCount = Number((await connection.runAndReadAll(filtered, counting.values)).getRowsJS()[0][0]);
            }
          }
          if (this.disposed) throw cancelledView();
          return this.newView(engine.createId("v"), query, { name, kind: "rows", scope, rowCount, readable });
        } catch (error) {
          await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined);
          throw error;
        }
      })
      .catch(async (error: unknown) => {
        await this.dropTables(scope.tables);
        throw error;
      });
    if (view.status === "ready") view.settle();
    this.views.set(view.id, view);
    await this.trimViews();
    if (view.status === "building") {
      this.queuedBuilds++;
      this.viewQueue = this.viewQueue.then(() => this.finish(view)).catch(() => undefined);
    }
    return view;
  }

  /** Builds the rest of a view that is building, unless it was dropped or nobody follows it any more. */
  private async finish(view: View) {
    this.queuedBuilds--;
    if (view.dropped || this.disposed) return;
    if (this.abandoned(view)) {
      await this.dropViews([view]);
      return;
    }
    try {
      const built = await this.engine.work.run(() => this.materialize(view.query, undefined, view, view.scope));
      view.name = built.name;
      view.kind = built.kind;
      view.rowCount = built.rowCount;
      view.readable = built.rowCount;
      view.tables.push(built.name);
      view.status = "ready";
      view.settle();
    } catch (error) {
      if (view.dropped || this.disposed) return;
      if (error instanceof SourceError && error.code === ErrorCodes.cancelled) {
        // Abandoned: the next request for the query starts over.
        await this.dropViews([view]);
        return;
      }
      view.status = "error";
      view.error = this.engine.clientMessage(error);
      view.settle(error);
      this.engine.options.log?.(`Building a view of ${this.path} failed`, error);
    }
  }

  /** Forgets views, stops their builds and drops their tables. */
  private async dropViews(views: View[]) {
    const tables: string[] = [];
    for (const view of views) {
      if (this.views.get(view.id) === view) this.views.delete(view.id);
      if (view.dropped) continue;
      view.dropped = true;
      view.interrupt?.();
      view.settle(cancelledView());
      tables.push(...view.tables);
    }
    if (tables.length === 0) return;
    await this.engine.withConnection(undefined, async (connection) => {
      for (const table of tables) await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    });
  }

  private async trimViews() {
    const views = [...this.views.values()].sort((a, b) => a.used - b.used);
    await this.dropViews(views.slice(0, Math.max(0, views.length - this.engine.options.maxViews)));
  }

  async columnStats(viewId: string | null, columnIndex: number, signal?: AbortSignal): Promise<ColumnStats> {
    this.requireReady();
    const view = this.view(viewId);
    const column = this.column(columnIndex, view);
    const from = this.unorderedRelation(view);
    const id = quoteIdentifier(column.name);
    const rows = view ? view.rowCount : (this.rowCount ?? 0);
    const exact = rows <= 2_000_000;
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        const numeric = isNumericType(column.type);
        const temporal = isTemporalType(column.type) && column.type !== "time";
        const value = numeric ? `CAST(${id} AS DOUBLE)` : temporal ? `epoch(${id})` : null;
        const finite = value ? ` FILTER (WHERE isfinite(${value}))` : "";
        const parts = [
          "count(*)",
          `count(*) - count(${id})`,
          exact ? `count(DISTINCT ${id})` : `approx_count_distinct(${id})`,
          `CAST(min(${id}) AS VARCHAR)`,
          `CAST(max(${id}) AS VARCHAR)`,
        ];
        if (value) {
          parts.push(
            `avg(${value})${finite}`,
            `stddev_samp(${value})${finite}`,
            `CAST(approx_quantile(${id}, [0.25, 0.5, 0.75])${finite} AS VARCHAR[])`,
          );
          parts.push(`min(${value})${finite}`, `max(${value})${finite}`);
        } else if (column.type === "string") {
          parts.push(`min(length(${id}))`, `max(length(${id}))`);
        }
        const summary = (await connection.runAndReadAll(`SELECT ${parts.join(", ")} FROM ${from}`)).getRowsJS()[0];
        const stats: ColumnStats = {
          column: columnIndex,
          rows: Number(summary[0]),
          nulls: Number(summary[1]),
          distinct: Number(summary[2]),
          distinctApproximate: !exact,
          min: summary[3] === null ? null : numeric ? wireNumber(summary[3]) : String(summary[3]),
          max: summary[4] === null ? null : numeric ? wireNumber(summary[4]) : String(summary[4]),
        };
        if (value) {
          stats.mean = summary[5] === null ? null : Number(summary[5]);
          stats.stddev = summary[6] === null ? null : Number(summary[6]);
          const quantiles = summary[7] as unknown[] | null;
          stats.quantiles = quantiles ? quantiles.map((item) => (numeric ? wireNumber(item) : String(item))) : null;
          const low = summary[8] === null ? null : Number(summary[8]);
          const high = summary[9] === null ? null : Number(summary[9]);
          if (low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high)) {
            const bins = low === high ? 1 : 24;
            const width = (high - low) / bins || 1;
            const histogram = await connection.runAndReadAll(
              `SELECT least(CAST(floor((${value} - $1) / $2) AS INTEGER), ${bins - 1}) AS bin, count(*) FROM ${from} WHERE ${value} IS NOT NULL AND isfinite(${value}) GROUP BY 1 ORDER BY 1`,
              [low, width],
            );
            const counts = new Map(histogram.getRowsJS().map((row) => [Number(row[0]), Number(row[1])]));
            stats.histogram = Array.from({ length: bins }, (_, bin) => ({
              start: low + bin * width,
              end: bin === bins - 1 ? high : low + (bin + 1) * width,
              count: counts.get(bin) ?? 0,
            }));
          }
        } else if (column.type === "string") {
          stats.minLength = summary[5] === null ? null : Number(summary[5]);
          stats.maxLength = summary[6] === null ? null : Number(summary[6]);
        }
        if (!value || (stats.distinct !== null && stats.distinct <= 24)) {
          const top = await connection.runAndReadAll(
            // Counted by whole values; long text is shortened only for display.
            `SELECT ${selectExpression(column, 500)} AS value, count(*) AS n FROM ${from} WHERE ${id} IS NOT NULL GROUP BY ${id} ORDER BY n DESC, value LIMIT 10`,
          );
          stats.top = top.getRowsJS().map((row) => ({ value: wireValue(row[0]), count: Number(row[1]) }));
        }
        return stats;
      }),
    );
  }

  async distinctValues(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues> {
    this.requireReady();
    const view = this.view(request.view);
    const column = this.column(request.column, view);
    const from = this.unorderedRelation(view);
    const limit = Math.min(request.limit ?? 1000, 100_000);
    const params = new Parameters();
    const search = request.search?.trim();
    const where = search
      ? `WHERE coalesce(contains(lower(${textExpression(column)}), ${params.add(search.toLowerCase())}), FALSE)`
      : "";
    // Values are counted and sent whole (up to the longest text of a cell), so that a value picked from
    // the list as a filter matches its rows.
    const expression = selectExpression(column, MAX_TEXT_LIMIT);
    const sql = `SELECT ${expression} AS value, count(*) AS n FROM ${from} ${where} GROUP BY ${quoteIdentifier(column.name)} ORDER BY n DESC, value NULLS FIRST LIMIT ${limit + 1}`;
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        const rows = (await connection.runAndReadAll(sql, params.values)).getRowsJS();
        return {
          values: rows.slice(0, limit).map((row) => ({ value: wireValue(row[0]), count: Number(row[1]) })),
          truncated: rows.length > limit,
        };
      }),
    );
  }

  async aggregate(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary> {
    this.requireReady();
    const view = this.view(request.view);
    if (view && request.ranges.some((range) => range.end > view.readable && range.end > range.start))
      this.requireBuilt(view);
    const from = this.rangeRelation(view);
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        for (const range of request.ranges) {
          const columns = [...new Set(range.columns)].map((index) => this.column(index, view));
          if (columns.length === 0 || range.end <= range.start) continue;
          const parts: string[] = [];
          for (const column of columns) {
            const id = quoteIdentifier(column.name);
            parts.push(column.type === "string" ? `count_if(${id} <> '')` : `count(${id})`);
            if (isNumericType(column.type)) {
              parts.push(
                `count(${id})`,
                `sum(CAST(${id} AS DOUBLE))`,
                `min(CAST(${id} AS DOUBLE))`,
                `max(CAST(${id} AS DOUBLE))`,
              );
            }
          }
          const row = (
            await connection.runAndReadAll(`SELECT ${parts.join(", ")} FROM ${from}`, [range.start, range.end])
          ).getRowsJS()[0];
          let at = 0;
          for (const column of columns) {
            count += Number(row[at++] ?? 0);
            if (!isNumericType(column.type)) continue;
            const numbers = Number(row[at++] ?? 0);
            const total = row[at++];
            const low = row[at++];
            const high = row[at++];
            if (numbers === 0) continue;
            numericCount += numbers;
            sum += Number(total);
            min = Math.min(min, Number(low));
            max = Math.max(max, Number(high));
          }
        }
        return {
          count,
          numericCount,
          sum: numericCount > 0 ? sum : null,
          min: numericCount > 0 ? min : null,
          max: numericCount > 0 ? max : null,
          average: numericCount > 0 ? sum / numericCount : null,
        };
      }),
    );
  }

  /**
   * Finds the next cell containing the text after (or before) a position, walking rows in view
   * order and columns in the requested order, wrapping around at the ends.
   */
  async find(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null> {
    this.requireReady();
    const view = this.view(request.view);
    this.requireBuilt(view);
    const { from, position } = this.relationOf(view);
    const columns = request.columns.map((index) => this.column(index, view));
    const text = request.text;
    if (!text || columns.length === 0) return null;
    const params = new Parameters();
    const needle = params.add(request.caseSensitive ? text : text.toLowerCase());
    const matches = columns.map((column) => {
      const value = request.caseSensitive ? textExpression(column) : `lower(${textExpression(column)})`;
      return `coalesce(contains(${value}, ${needle}), FALSE)`;
    });
    const list = `[${matches.join(", ")}]`;
    const any = `(${matches.join(" OR ")})`;
    const forward = request.direction === 1;
    const pick = (flags: unknown[], after: number | null) => {
      if (forward) {
        for (let index = after === null ? 0 : after + 1; index < flags.length; index++) if (flags[index]) return index;
      } else {
        for (let index = after === null ? flags.length - 1 : after - 1; index >= 0; index--)
          if (flags[index]) return index;
      }
      return -1;
    };
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        const rowParam = `$${params.values.length + 1}`;
        const current = (
          await connection.runAndReadAll(`SELECT ${list} FROM ${from} WHERE ${position} = ${rowParam}`, [
            ...params.values,
            request.row,
          ])
        ).getRowsJS()[0];
        if (current) {
          const index = pick(current[0] as unknown[], request.column);
          if (index >= 0) return { row: request.row, column: index };
        }
        const search = async (condition: string) => {
          const sql = `SELECT ${position}, ${list} FROM ${from} WHERE ${condition} AND ${any} ORDER BY ${position} ${forward ? "ASC" : "DESC"} LIMIT 1`;
          const row = (await connection.runAndReadAll(sql, [...params.values, request.row])).getRowsJS()[0];
          if (!row) return null;
          const index = pick(row[1] as unknown[], null);
          return index >= 0 ? { row: Number(row[0]), column: index } : null;
        };
        const ahead = await search(`${position} ${forward ? ">" : "<"} ${rowParam}`);
        if (ahead) return ahead;
        const wrapped = await search(`${position} ${forward ? "<" : ">"} ${rowParam}`);
        if (wrapped) return wrapped;
        // The only matches may be earlier (later) in the start row itself.
        if (current) {
          const index = pick(current[0] as unknown[], null);
          if (index >= 0 && index !== request.column) return { row: request.row, column: index };
        }
        return null;
      }),
    );
  }

  /**
   * Writes the view (or the table) to `target`, an absolute path inside the allowed directories. The
   * file is written next to it under a temporary name and renamed when complete, so a cancelled or
   * failed export leaves nothing behind.
   */
  async exportView(request: ExportRequest, target: string, signal?: AbortSignal): Promise<ExportResult> {
    this.requireReady();
    const view = this.view(request.view);
    this.requireBuilt(view);
    const rows = view ? view.rowCount : (this.rowCount ?? 0);
    const { from, position } = this.relationOf(view);
    const columns = (request.columns ?? (view?.scope.columns ?? this.columns).map((_, index) => index)).map((index) =>
      this.column(index, view),
    );
    if (request.format === "xlsx") checkXlsxSize(rows, columns.length);
    // Columns are written under their name in the file, or the requested header.
    const headers = columns.map(
      (column, index) =>
        (request.format === "parquet" || request.format === "json" ? undefined : request.headers?.[index]) ??
        column.label ??
        column.name,
    );
    // The folder may be a link: the file is written to its real location, which must be allowed.
    const folder = await realpath(path.dirname(target)).catch(() => path.dirname(target));
    const destination = path.join(folder, path.basename(target));
    if (!this.engine.allows(destination)) throw notAllowed();
    const temporary = path.join(folder, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    // An export holds the data of one revision of the file: closing the table (also because the file
    // changed and was opened again) stops it, and so does a change found when it ends.
    const stop = new AbortController();
    const forward = () => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener("abort", forward, { once: true });
    this.exports.add(stop);
    const changed = () =>
      new SourceError(
        ErrorCodes.cancelled,
        "The file changed or was closed while it was exported; export it again.",
        409,
      );
    try {
      return await this.engine.work.run(() =>
        this.engine.withConnection(stop.signal, async (connection) => {
          if (this.disposed) throw changed();
          try {
            if (request.format === "xlsx") {
              await this.writeWorkbook(connection, from, position, columns, headers, request, temporary, stop.signal);
            } else {
              // DuckDB renames repeated names in a header ("x", "x_1"); a CSV or TSV file with repeated
              // headers gets its header line written here instead, as ArraySource and xlsx write it.
              const delimited = request.format === "csv" || request.format === "tsv";
              const ownHeader = delimited && new Set(headers).size !== headers.length;
              const selected = columns
                .map((column, index) =>
                  ownHeader || headers[index] === column.name
                    ? quoteIdentifier(column.name)
                    : `${quoteIdentifier(column.name)} AS ${quoteIdentifier(headers[index])}`,
                )
                .join(", ");
              const header = ownHeader ? "false" : "true";
              const options = {
                csv: `FORMAT csv, HEADER ${header}`,
                tsv: `FORMAT csv, HEADER ${header}, DELIMITER '\\t'`,
                parquet: "FORMAT parquet, COMPRESSION zstd",
                json: "FORMAT json, ARRAY true",
              }[request.format];
              const body = ownHeader ? `${temporary}.body` : temporary;
              try {
                await connection.run(
                  `COPY (SELECT ${selected || "*"} FROM ${from} ORDER BY ${position}) TO ${quoteLiteral(body)} (${options})`,
                );
                if (ownHeader) await writeWithHeader(body, temporary, headers, request.format === "tsv" ? "\t" : ",");
              } finally {
                if (ownHeader) await rm(body, { force: true });
              }
            }
            if (this.disposed || (await this.currentRevision()) !== this.revision) throw changed();
            await rename(temporary, destination);
          } catch (error) {
            await rm(temporary, { force: true });
            if (signal?.aborted) throw new SourceError(ErrorCodes.cancelled, "The request was cancelled.", 499);
            if (this.disposed) throw changed();
            throw error;
          }
          return { target: request.target, rows };
        }),
      );
    } catch (error) {
      if (!signal?.aborted && this.disposed) throw changed();
      throw error;
    } finally {
      this.exports.delete(stop);
      signal?.removeEventListener("abort", forward);
    }
  }

  /** Streams the rows into a workbook (see `writeXlsx`): one chunk of rows from DuckDB at a time. */
  private async writeWorkbook(
    connection: DuckDBConnection,
    from: string,
    position: string,
    columns: SqlColumn[],
    headers: string[],
    request: ExportRequest,
    file: string,
    signal?: AbortSignal,
  ) {
    // Text is cut to Excel's limit in DuckDB; the cut text ends with "…".
    const expressions = columns.map((column) => selectExpression(column, XLSX_MAX_TEXT - 1));
    const result = await connection.stream(
      `SELECT ${expressions.length > 0 ? expressions.join(", ") : "1"} FROM ${from} ORDER BY ${position}`,
    );
    async function* batches() {
      for await (const rows of result.yieldRowsJs()) yield rows.map((row) => row.map(wireValue));
    }
    const workbook = writeXlsx(
      columns.map((column, index) => ({
        name: headers[index],
        type: column.type,
        numberFormat: request.numberFormats?.[index] ?? null,
      })),
      batches(),
      {
        deflate: (chunks) => pipeline(Readable.from(chunks), createDeflateRaw({ level: DEFLATE_LEVEL }), () => {}),
        // Node.js 20.15 and later.
        ...(typeof zlib.crc32 === "function" ? { crc32: zlib.crc32 } : {}),
        signal,
      },
    );
    await pipelinePromise(Readable.from(workbook), createWriteStream(file, { flags: "wx" }));
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Loads and view builds notice `disposed` and drop what they create after this point.
    for (const running of this.exports) running.abort();
    this.loadConnection?.interrupt();
    this.viewConnection?.interrupt();
    const names = [
      ...[...this.views.values()].flatMap((view) => {
        view.dropped = true;
        view.interrupt?.();
        view.settle(cancelledView());
        return view.tables.map((table) => `TABLE ${quoteIdentifier(table)}`);
      }),
      ...this.objects,
    ];
    this.views.clear();
    if (names.length > 0) {
      await this.engine
        .withConnection(undefined, async (connection) => {
          for (const name of names)
            await connection.run(`DROP ${name.split(" ")[0]} IF EXISTS ${name.slice(name.indexOf(" ") + 1)}`);
        })
        .catch((error: unknown) => this.engine.options.log?.(`Dropping ${this.path} failed`, error));
    }
    for (const file of this.tempFiles) await rm(file, { force: true });
  }
}

/** Bytes at the start of a file that its revision covers. */
const REVISION_HEAD_BYTES = 64 * 1024;

/**
 * A file's revision: its size, its modification time and a hash of its first 64 KiB, so that a file
 * rewritten with the same size within the resolution of its modification time still counts as changed.
 */
export async function fileRevision(file: string): Promise<string> {
  const handle = await openFile(file, "r");
  try {
    const info = await handle.stat();
    const head = Buffer.alloc(Math.min(info.size, REVISION_HEAD_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const hash = createHash("sha1").update(head.subarray(0, bytesRead)).digest("hex").slice(0, 16);
    return `${info.size}:${Math.round(info.mtimeMs)}:${hash}`;
  } finally {
    await handle.close();
  }
}

function wireNumber(value: unknown): CellValue {
  const wire = wireValue(value);
  if (typeof wire === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(wire)) {
    const number = Number(wire);
    return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : wire;
  }
  return wire;
}

/** Writes a header line, quoted as DuckDB quotes CSV fields, followed by the rows of `body`. */
async function writeWithHeader(body: string, target: string, headers: string[], delimiter: string) {
  const quote = (text: string) =>
    text === "" || /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  const output = createWriteStream(target, { flags: "wx" });
  await pipelinePromise(async function* () {
    yield `${headers.map(quote).join(delimiter)}\n`;
    yield* createReadStream(body);
  }, output);
}
