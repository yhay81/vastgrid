import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  type AggregateRequest,
  type CellValue,
  type ColumnStats,
  type DistinctRequest,
  type DistinctValues,
  ErrorCodes,
  type ExportRequest,
  type ExportResult,
  type FindRequest,
  type FindResult,
  filtersRows,
  isEmptyQuery,
  isNumericType,
  isTemporalType,
  MAX_TEXT_LIMIT,
  type RowBlock,
  type RowRequest,
  type SelectionSummary,
  SourceError,
  type TableInfo,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid-core";
import { convertToUtf8, detectEncoding } from "./encoding.js";
import {
  columnTypeOf,
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

export type TableFormat = "csv" | "tsv" | "parquet" | "json" | "ndjson";

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
  /** Rows read for display while a delimited or JSON file is still loading. */
  previewRows?: number;
  /** Longest text sent for a cell by default. */
  textLimit?: number;
  /** Reports problems that are not caused by a request (for logs). */
  log?: (message: string, error?: unknown) => void;
}

const extensions: [RegExp, TableFormat][] = [
  [/\.(csv|csv\.gz|csv\.zst)$/i, "csv"],
  [/\.(tsv|tab|tsv\.gz|tsv\.zst)$/i, "tsv"],
  [/\.(parquet|pq)$/i, "parquet"],
  [/\.(jsonl|ndjson|jsonl\.gz|ndjson\.gz)$/i, "ndjson"],
  [/\.(json|json\.gz)$/i, "json"],
];

/** The format of a file judged by its name, or `null` when it is not a table file. */
export function tableFormatOf(filePath: string): TableFormat | null {
  for (const [pattern, format] of extensions) if (pattern.test(filePath)) return format;
  return null;
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
      previewRows: options.previewRows ?? 1000,
      textLimit: options.textLimit ?? 2000,
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
   * that changed (size or modification time) is opened again as a new table, and so is a file whose
   * load failed once `info()` has reported the failure (a retry). Only files whose real location
   * (after following links) is inside the allowed directories are opened.
   */
  async open(filePath: string, format?: TableFormat): Promise<OpenTable> {
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
    const revision = `${info.size}:${Math.round(info.mtimeMs)}`;
    // Until its failure is reported, a failed table is returned as it is: reopening it right away would
    // answer every poll of a loading table with a new load, so clients would never see the error.
    const reusable = (table: OpenTable) => table.revision === revision && !table.failureReported;
    let existing = this.byPath.get(absolute);
    if (existing && !reusable(existing)) {
      await this.close(existing.id);
      // Another request may have opened the file again while the old table was closing.
      existing = this.byPath.get(absolute);
    }
    if (existing && reusable(existing)) {
      existing.touch();
      return existing;
    }
    const table = new OpenTable(this, this.createId("t"), absolute, fileFormat, revision, info.size);
    this.tables.set(table.id, table);
    this.byPath.set(absolute, table);
    table.start();
    await this.trim();
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
    if (this.byPath.get(table.path) === table) this.byPath.delete(table.path);
    await table.dispose();
  }

  private async trim() {
    const open = [...this.tables.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    while (open.length > this.options.maxTables) {
      const table = open.shift();
      if (table) await this.close(table.id);
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

interface View {
  id: string;
  name: string;
  rowCount: number;
  query: ViewQuery;
  used: number;
  /** `rows`: the view's table holds every column in view order. `positions`: only the rows' positions in the table. */
  kind: "rows" | "positions";
}

interface Preview {
  columns: SqlColumn[];
  values: CellValue[][];
  rows: number;
}

const ROW_COLUMN = "__vg_row";
const POSITION_COLUMN = "__vg_position";
/** Positions looked up per query when reading a view that holds only positions. */
const LOOKUP_BATCH = 2048;
/** Cells (rows × columns) one `rows` request may read: the answer is built in memory. */
const MAX_CELLS = 1_000_000;
/** Names the engine uses in its queries; a file's column with one of them gets another name in SQL. */
const RESERVED_NAMES = new Set(["rowid", ROW_COLUMN, POSITION_COLUMN]);

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
  private readonly tempFiles: string[] = [];
  private readonly objects: string[] = [];
  private clock = 0;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: TableEngine,
    readonly id: string,
    readonly path: string,
    readonly format: TableFormat,
    readonly revision: string,
    readonly byteSize: number,
  ) {}

  touch() {
    this.lastUsed = Date.now();
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

  info(): TableInfo {
    const ready = this.status === "ready";
    if (this.status === "error") this.failureReported = true;
    return {
      columns: this.columns.map((column) => ({
        name: column.label ?? column.name,
        type: column.type,
        sourceType: column.sqlType,
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
      capabilities: {
        sort: ready,
        filter: ready,
        search: ready,
        stats: ready,
        distinct: ready,
        aggregate: ready,
        find: ready,
        export: ready,
      },
    };
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
      if (encoding !== "utf-8") {
        source = await this.convert(encoding);
      }
    }
    await this.loadPreview(source);
    await engine.loads.run(async () => {
      if (this.disposed) return;
      let lastError: unknown = null;
      const attempts = this.format === "csv" || this.format === "tsv" ? 3 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await this.loadTable(source, attempt);
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
    if (encoding !== "utf-8") this.notes.push(`encoding:${encoding}`);
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
        if (percentage >= 0) this.progress = Math.min(0.99, percentage / 100);
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
    return view;
  }

  /**
   * The rows of a view (or the table) as a relation, with a column `position` that gives each row's
   * place in the view. Views that hold only positions are joined back to the table.
   */
  private relationOf(view: View | null): { from: string; position: string } {
    if (!view) return { from: this.relation, position: this.position };
    if (view.kind === "rows") return { from: quoteIdentifier(view.name), position: "rowid" };
    return {
      from: `(SELECT w.rowid AS ${POSITION_COLUMN}, b.* FROM ${quoteIdentifier(view.name)} w JOIN ${this.relation} b ON b.${this.position} = w.${quoteIdentifier(ROW_COLUMN)})`,
      position: POSITION_COLUMN,
    };
  }

  /** The rows of a view in any order, for statistics. */
  private unorderedRelation(view: View | null): string {
    if (!view || view.kind === "rows") return this.relationOf(view).from;
    // A view that only sorts has the same rows as the table.
    if (!filtersRows(view.query)) return this.relation;
    return `(SELECT b.* FROM ${this.relation} b SEMI JOIN ${quoteIdentifier(view.name)} w ON b.${this.position} = w.${quoteIdentifier(ROW_COLUMN)})`;
  }

  /** Rows `[$1, $2)` of a view, in any order, for selection summaries. */
  private rangeRelation(view: View | null): string {
    if (!view) return `(SELECT * FROM ${this.relation} WHERE ${this.position} >= $1 AND ${this.position} < $2)`;
    if (view.kind === "rows") return `(SELECT * FROM ${quoteIdentifier(view.name)} WHERE rowid >= $1 AND rowid < $2)`;
    return `(SELECT b.* FROM ${this.relation} b WHERE b.${this.position} IN (SELECT ${quoteIdentifier(ROW_COLUMN)} FROM ${quoteIdentifier(view.name)} WHERE rowid >= $1 AND rowid < $2))`;
  }

  private column(index: number) {
    const column = this.columns[index];
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
    const end = Math.min(request.end, total);
    const start = Math.min(request.start, end);
    if (request.end - request.start > 1_000_000) {
      throw new SourceError(ErrorCodes.invalidRequest, "Read at most a million rows at a time.", 400);
    }
    const columns = request.columns.map((index) => this.column(index));
    if (end === start) return { start, end, columns: columns.map(() => []), rowIds: view ? [] : null };
    if (view?.kind === "positions") return this.readPositions(view, start, end, columns, limit, signal);
    const { from, position } = this.relationOf(view);
    const expressions = columns.map((column) => selectExpression(column, limit));
    if (view) expressions.push(quoteIdentifier(ROW_COLUMN));
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
          `SELECT ${this.position}${expressions.length > 0 ? `, ${expressions.join(", ")}` : ""} FROM ${this.relation} WHERE ${this.position} IN (${batch.join(", ")})`,
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

  /** Builds the WHERE clause of a query. */
  private where(query: ViewQuery, params: Parameters) {
    const parts = (query.filters ?? []).map((filter) => filterExpression(filter, this.columns, params));
    if (query.search?.trim()) parts.push(searchExpression(query.search.trim(), this.columns, params));
    return parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  }

  /**
   * Creates a sorted or filtered view, or returns the view of the same query. Views are built one at a
   * time per table. Requests never cancel each other, since several grids or people may share the
   * table: a request is cancelled by its own signal (its caller then receives `cancelled`).
   */
  async createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    this.requireReady();
    if (isEmptyQuery(query)) return { id: null, rowCount: this.rowCount ?? 0, query: {} };
    const same = this.sameView(query);
    if (same) return same;
    // A request that waited behind a build of the same query gets that view.
    const run = this.viewQueue.then(() => this.sameView(query) ?? this.buildView(query, signal));
    this.viewQueue = run.catch(() => undefined);
    return run;
  }

  private sameView(query: ViewQuery): ViewInfo | null {
    const key = JSON.stringify(query);
    const view = [...this.views.values()].find((item) => JSON.stringify(item.query) === key);
    if (!view) return null;
    view.used = ++this.clock;
    return { id: view.id, rowCount: view.rowCount, query: view.query };
  }

  private async buildView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    const engine = this.engine;
    return engine.work.run(async () => {
      const params = new Parameters();
      const where = this.where(query, params);
      const order = [...orderTerms(query.sort ?? [], this.columns), this.position];
      const name = engine.createId("vg_v");
      // Large tables keep only the order: sorting every column of 100M rows takes minutes and gigabytes.
      const kind: View["kind"] = (this.rowCount ?? 0) > engine.options.materializeRows ? "positions" : "rows";
      const selected = kind === "rows" ? this.columns.map((column) => quoteIdentifier(column.name)).join(", ") : "";
      const sql = `CREATE TABLE ${quoteIdentifier(name)} AS SELECT ${this.position} AS ${quoteIdentifier(ROW_COLUMN)}${selected ? `, ${selected}` : ""} FROM ${this.relation} ${where} ORDER BY ${order.join(", ")}`;
      const connection = await engine.connect();
      this.viewConnection = connection;
      const interrupt = () => connection.interrupt();
      signal?.addEventListener("abort", interrupt, { once: true });
      try {
        // A request cancelled while it waited for its turn builds nothing.
        if (this.disposed || signal?.aborted)
          throw new SourceError(ErrorCodes.cancelled, "The view request was cancelled.", 409);
        await connection.run(sql, params.values);
        const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
        const rowCount = Number(count.getRowsJS()[0][0]);
        if (this.disposed) {
          await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
          throw new SourceError(ErrorCodes.cancelled, "The view request was cancelled.", 409);
        }
        const id = engine.createId("v");
        this.views.set(id, { id, name, rowCount, query, used: ++this.clock, kind });
        await this.trimViews(connection);
        return { id, rowCount, query };
      } catch (error) {
        await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined);
        if (isInterrupt(error)) throw new SourceError(ErrorCodes.cancelled, "The view request was cancelled.", 409);
        throw error;
      } finally {
        signal?.removeEventListener("abort", interrupt);
        this.viewConnection = null;
        connection.closeSync();
      }
    });
  }

  private async trimViews(connection: DuckDBConnection) {
    const views = [...this.views.values()].sort((a, b) => a.used - b.used);
    while (views.length > this.engine.options.maxViews) {
      const view = views.shift();
      if (!view) break;
      this.views.delete(view.id);
      await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(view.name)}`);
    }
  }

  async columnStats(viewId: string | null, columnIndex: number, signal?: AbortSignal): Promise<ColumnStats> {
    this.requireReady();
    const view = this.view(viewId);
    const column = this.column(columnIndex);
    const from = this.unorderedRelation(view);
    const id = quoteIdentifier(column.name);
    const rows = view ? view.rowCount : (this.rowCount ?? 0);
    const exact = rows <= 2_000_000;
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        const numeric = isNumericType(column.type);
        const temporal = isTemporalType(column.type) && column.type !== "time";
        const value = numeric ? `CAST(${id} AS DOUBLE)` : temporal ? `epoch(${id})` : null;
        const parts = [
          "count(*)",
          `count(*) - count(${id})`,
          exact ? `count(DISTINCT ${id})` : `approx_count_distinct(${id})`,
          `CAST(min(${id}) AS VARCHAR)`,
          `CAST(max(${id}) AS VARCHAR)`,
        ];
        if (value) {
          parts.push(
            `avg(${value})`,
            `stddev_samp(${value})`,
            `CAST(approx_quantile(${id}, [0.25, 0.5, 0.75]) AS VARCHAR[])`,
          );
          parts.push(`min(${value})`, `max(${value})`);
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
    const column = this.column(request.column);
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
    const from = this.rangeRelation(view);
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        for (const range of request.ranges) {
          const columns = [...new Set(range.columns)].map((index) => this.column(index));
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
    const { from, position } = this.relationOf(view);
    const columns = request.columns.map((index) => this.column(index));
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

  /** Writes the view (or the table) to `target`, an absolute path inside the allowed directories. */
  async exportView(request: ExportRequest, target: string, signal?: AbortSignal): Promise<ExportResult> {
    this.requireReady();
    const view = this.view(request.view);
    const { from, position } = this.relationOf(view);
    const columns = (request.columns ?? this.columns.map((_, index) => index)).map((index) => this.column(index));
    // Columns read under another name are written under the file's own.
    const selected = columns
      .map((column) =>
        column.label === undefined
          ? quoteIdentifier(column.name)
          : `${quoteIdentifier(column.name)} AS ${quoteIdentifier(column.label)}`,
      )
      .join(", ");
    const options = {
      csv: "FORMAT csv, HEADER true",
      tsv: "FORMAT csv, HEADER true, DELIMITER '\\t'",
      parquet: "FORMAT parquet, COMPRESSION zstd",
      json: "FORMAT json, ARRAY true",
    }[request.format];
    // The folder may be a link: the file is written to its real location, which must be allowed.
    const folder = await realpath(path.dirname(target)).catch(() => path.dirname(target));
    const destination = path.join(folder, path.basename(target));
    if (!this.engine.allows(destination)) throw notAllowed();
    const temporary = path.join(folder, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    return this.engine.work.run(() =>
      this.engine.withConnection(signal, async (connection) => {
        try {
          await connection.run(
            `COPY (SELECT ${selected || "*"} FROM ${from} ORDER BY ${position}) TO ${quoteLiteral(temporary)} (${options})`,
          );
          await rename(temporary, destination);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        return { target: request.target, rows: view ? view.rowCount : (this.rowCount ?? 0) };
      }),
    );
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Loads and view builds notice `disposed` and drop what they create after this point.
    this.loadConnection?.interrupt();
    this.viewConnection?.interrupt();
    const names = [...[...this.views.values()].map((view) => `TABLE ${quoteIdentifier(view.name)}`), ...this.objects];
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

function wireNumber(value: unknown): CellValue {
  const wire = wireValue(value);
  if (typeof wire === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(wire)) {
    const number = Number(wire);
    return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : wire;
  }
  return wire;
}
