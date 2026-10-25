/**
 * The DuckDB engine of vastgrid v2 (docs/v2-spec.md §8): answers request messages with responses whose blocks are
 * bytes (the structured encoding of §8.8), and sends events (§8.5) to its subscribers.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  BlockValueError,
  checkRequest,
  type ErrorCode,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  SpecError,
} from "vastgrid-spec";
import { EngineError, errorMessage } from "./errors.js";
import { Session } from "./session.js";
import { fileRevision, LoadedTable, tableFormatOf } from "./table.js";
import { CAPABILITIES, type ViewOptions, Views } from "./view.js";
import type { ReadOptions } from "./xlsx.js";

export interface DuckDBEngineOptions extends ViewOptions {
  /** Folders whose files may be opened. DuckDB may read no other files, for good. */
  allowedDirectories: string[];
  /**
   * The file that a `ref` of `open` names (§8.2): where a host checks that the file may be opened, for example
   * that it is inside a workspace. Throw to refuse it (`not_allowed`). By default a `ref` is a path, relative ones
   * inside the first allowed folder.
   */
  resolve?: (ref: string) => string | Promise<string>;
  /**
   * Where the engine keeps its database file, data spilled from memory and converted files: a folder of its own
   * inside, deleted by `dispose`; folders left by processes that ended without it are deleted on the next start.
   */
  tempDirectory: string;
  /** DuckDB's memory limit, such as `"4GB"`. A fifth of the system's memory (1–4 GB) by default. */
  memoryLimit?: string;
  /** Maximum spill files, default 8 GB. Does not include the session database or source files. */
  maxTempDirectorySize?: string;
  /** DuckDB's threads. The number of CPUs minus one by default. */
  threads?: number;
  /** Tables kept loaded once no handle uses them, for opening them again; the least recently used go first. */
  maxTables?: number;
  /** Rows of a delimited or JSON file that are readable while it loads. 1,000 by default. */
  previewRows?: number;
  /** The longest text of a string that `rows` gives without `textLimit` (§8.2). 2,000 by default. */
  textLimit?: number;
  /** Receives problems that no request caused, for logs. */
  log?: (message: string, error?: unknown) => void;
}

type Json = Record<string, unknown>;
type Request = Json & { v: 2; id: number; op: Operation };

/** The options of `open` that change how a file of a format is read (only workbooks have any). */
function readOptionsOf(format: string, read: unknown): ReadOptions {
  if (format !== "xlsx" || read === undefined) return {};
  const { sheet, headerRow, keepEmptyRows, keepEmptyColumns } = read as ReadOptions;
  const options: ReadOptions = {};
  if (sheet !== undefined) options.sheet = sheet;
  if (headerRow !== undefined) options.headerRow = headerRow;
  if (keepEmptyRows) options.keepEmptyRows = true;
  if (keepEmptyColumns) options.keepEmptyColumns = true;
  return options;
}

/** The DuckDB engine: open files, their handles, and the views read from them. */
export class DuckDBEngine {
  private readonly tables = new Map<string, LoadedTable>();
  /** Tables of files that changed, which handles opened before the change still read. */
  private readonly retired = new Set<LoadedTable>();
  private readonly handles = new Map<string, LoadedTable>();
  private readonly listeners = new Set<(event: Json) => void>();
  private readonly running = new Map<number, AbortController>();
  /** What the last `view` event told of the view `{}` of each loading table. */
  private readonly told = new WeakMap<LoadedTable, string>();
  private readonly views: Views;
  private nextHandle = 1;
  private disposed = false;

  private constructor(
    private readonly session: Session,
    private readonly options: DuckDBEngineOptions,
    /** The hash of the plan `{}` (§4.8), the view of a table that is loading (§9). */
    private readonly tableHash: string,
  ) {
    this.views = new Views(session, options.textLimit ?? 2000, options, (table, view) => {
      for (const [id, item] of this.handles) {
        if (item !== table) continue;
        this.emit({
          v: 2,
          event: "view",
          table: id,
          hash: view.hash,
          status: "ready",
          readableRows: view.readableRows,
          rowCount: view.rowCount,
          rowCountExact: true,
        });
      }
    });
  }

  static async create(options: DuckDBEngineOptions): Promise<DuckDBEngine> {
    return new DuckDBEngine(await Session.create(options), options, await planHash({}));
  }

  /** Follows the events of the engine's tables (§8.5). */
  subscribe(listener: (event: Json) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: Json) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.options.log?.("A listener of the engine's events failed", error);
      }
    }
  }

  private changed(table: LoadedTable, change: "progress" | "revision") {
    // The view `{}` of a loading table holds its readable rows (§9): a `view` event tells when they change.
    const ready = table.status === "ready";
    const rows = table.relation?.rows;
    const view = rows === undefined || table.status === "error" ? null : `${ready}:${rows}`;
    const tell = change === "progress" && view !== null && this.told.get(table) !== view;
    if (tell && view !== null) this.told.set(table, view);
    for (const [id, item] of this.handles) {
      if (item !== table) continue;
      if (tell) {
        this.emit({
          v: 2,
          event: "view",
          table: id,
          hash: this.tableHash,
          status: ready ? "ready" : "building",
          readableRows: rows,
          rowCount: rows,
          rowCountExact: ready,
        });
      }
      if (change === "revision") {
        this.emit({ v: 2, event: "changed", table: id, revision: table.revision, edits: table.edits.state });
      } else {
        const ready = table.status === "ready";
        this.emit({
          v: 2,
          event: "progress",
          table: id,
          status: table.status,
          progress: ready ? 1 : table.progress,
          readableRows: table.status === "error" ? 0 : (table.relation?.rows ?? 0),
          rowCount: ready ? table.rowCount : null,
        });
      }
    }
  }

  /**
   * Answers a request message (§8.1): with a response, an error response, or nothing for `cancel`. `signal`
   * cancels the request as `cancel` does (§8.6), for transports that cancel by their own means.
   */
  async handle(message: unknown, options: { signal?: AbortSignal } = {}): Promise<Json | undefined> {
    let request: Request;
    try {
      request = checkRequest(message) as Request;
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const id = (message as { id?: unknown } | null)?.id;
      return {
        v: 2,
        id: typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : 0,
        error: { code: error.code, message: error.message, path: error.path, reason: error.reason },
      };
    }
    if (request.op === "cancel") {
      this.running.get(request.request as number)?.abort();
      return undefined;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.running.set(request.id, controller);
    try {
      const result = await this.answer(request, controller.signal);
      if (controller.signal.aborted) throw new EngineError("cancelled", "The request was cancelled.");
      return { v: 2, id: request.id, result };
    } catch (error) {
      return { v: 2, id: request.id, error: this.errorOf(error) };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.running.get(request.id) === controller) this.running.delete(request.id);
    }
  }

  private errorOf(error: unknown): Json {
    if (error instanceof BlockValueError)
      return { code: "invalid_value", message: error.message, path: error.path, reason: error.reason };
    if (error instanceof EngineError) return { code: error.code, message: error.message, ...error.members };
    if (error instanceof PlanError)
      return { code: "invalid_plan", message: error.message, path: error.path, reason: error.reason };
    if (error instanceof SpecError) return { code: error.code as ErrorCode, message: error.message };
    this.options.log?.("A request failed", error);
    return { code: "internal", message: this.session.clientMessage(errorMessage(error)) };
  }

  private table(request: Json): LoadedTable {
    const table = this.handles.get(request.table as string);
    if (!table) throw new EngineError("table_not_found", "The table is closed or unknown.");
    table.lastUsed = Date.now();
    if ("revision" in request && request.revision !== table.revision) {
      throw new EngineError("revision_changed", "The table has another revision: read its TableInfo again.");
    }
    return table;
  }

  private async answer(request: Request, signal: AbortSignal): Promise<unknown> {
    switch (request.op) {
      case "open":
        return this.open(request.ref as string, request.read);
      case "info":
        return this.info(request.table as string, this.table(request));
      case "changes": {
        const table = this.table(request);
        return { revision: table.revision, edits: table.edits.state };
      }
      case "close":
        await this.close(request.table as string);
        return null;
      case "rows":
        return this.views.rows(this.table(request), request, signal);
      case "locate":
        return this.views.locate(this.table(request), request, signal);
      case "summarize":
        return this.views.summarize(this.table(request), request, signal);
      case "find":
        return this.views.find(this.table(request), request, signal);
      case "write":
        return this.write(this.table(request), request, signal);
      case "save":
        this.table(request);
        throw new EngineError("save_unsupported", "This engine does not save files yet.");
      case "export":
        this.table(request);
        throw new EngineError("not_allowed", "This engine does not export yet.");
      default:
        throw new EngineError("internal", `The engine does not answer ${request.op}.`);
    }
  }

  /** Writes cells (§7.2), and tells every handle of the table that its data changed (§8.5). */
  private async write(table: LoadedTable, request: Json, signal: AbortSignal) {
    const result = await table.edits.write(request, signal);
    if (result.updated > 0) {
      for (const [id, item] of this.handles) {
        if (item === table) {
          this.emit({ v: 2, event: "changed", table: id, revision: table.revision, edits: result.edits });
        }
      }
    }
    return result;
  }

  private async resolve(ref: string): Promise<string> {
    if (this.options.resolve) {
      try {
        return path.resolve(await this.options.resolve(ref));
      } catch (error) {
        throw new EngineError("not_allowed", errorMessage(error) || "The host does not open this.");
      }
    }
    return path.resolve(this.options.allowedDirectories[0] ?? ".", ref);
  }

  /**
   * Opens a file (§8.2), or the table already loaded for it when the file has not changed and its load did not
   * fail, and gives a handle of its own. Only files whose real location (links followed) is inside the allowed
   * folders are opened.
   */
  private async open(ref: string, read: unknown) {
    if (this.disposed) throw new EngineError("internal", "The engine was closed.");
    const requested = await this.resolve(ref);
    const format = tableFormatOf(requested);
    if (!format) throw new EngineError("load_failed", "This file is not a table that the engine reads.");
    const notAllowed = () => new EngineError("not_allowed", "The file is outside the folders this engine may read.");
    if (!this.session.allows(requested)) throw notAllowed();
    // The engine reads some files itself (to find and convert their encoding), and a link can point anywhere.
    const file = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new EngineError("load_failed", "The file does not exist.") : error;
    });
    if (!this.session.allows(file)) throw notAllowed();
    const info = await stat(file);
    if (!info.isFile()) throw new EngineError("load_failed", "Only files are opened as tables.");
    const revision = await fileRevision(file);
    const options = readOptionsOf(format, read);
    const key = `${file}\u0000${JSON.stringify(options)}`;
    let table = this.tables.get(key);
    if (!table || table.fileState !== revision || table.status === "error") {
      if (table && table.handles === 0) await this.drop(key, table);
      else if (table) {
        this.tables.delete(key);
        this.retired.add(table);
      }
      table = new LoadedTable(this.session, file, format, revision, info.size, options, {
        previewRows: this.options.previewRows ?? 1000,
        onChange: (changed, change) => this.changed(changed, change),
        log: this.options.log,
      });
      this.tables.set(key, table);
      table.start();
    }
    table.handles++;
    table.lastUsed = Date.now();
    const id = `t${this.nextHandle++}`;
    this.handles.set(id, table);
    // The first answer has the columns and the first rows to read (or the error), and the sheets of a workbook.
    await table.whenReadable();
    await this.trim();
    return this.info(id, table);
  }

  private info(id: string, table: LoadedTable): Json {
    const ready = table.status === "ready";
    const info: Json = {
      table: id,
      revision: table.revision,
      edits: table.edits.state,
      status: table.status,
      progress: ready ? 1 : table.progress,
      rowCount: ready ? table.rowCount : null,
      readableRows: table.status === "error" ? 0 : (table.relation?.rows ?? 0),
      columns: table.columns,
      capabilities: CAPABILITIES,
      format: table.format,
      byteSize: table.byteSize,
    };
    if (table.notes.length > 0) info.notes = [...table.notes];
    if (table.sheets) info.sheets = table.sheets.map((sheet) => ({ ...sheet }));
    if (table.sheet !== undefined) info.sheet = table.sheet;
    if (table.error !== undefined) info.error = table.error;
    return info;
  }

  /** Takes a handle back (§8.2). The table stays loaded for a while, to be opened again without loading it. */
  private async close(id: string) {
    const table = this.handles.get(id);
    if (!table) throw new EngineError("table_not_found", "The table is closed or unknown.");
    this.views.unfollow(id);
    this.handles.delete(id);
    table.handles--;
    if (table.handles === 0 && (this.retired.delete(table) || table.edits.version > 0)) {
      // Written cells belong to the handles open on the table: once the last one closes, they are gone, and the
      // file is opened again as it is.
      for (const [key, item] of this.tables) if (item === table) this.tables.delete(key);
      await this.views.forget(table);
      await table.dispose();
    }
    await this.trim();
  }

  /** Drops the tables that no handle uses beyond `maxTables`, the least recently used first. */
  private async trim() {
    const idle = [...this.tables.entries()]
      .filter(([, table]) => table.handles === 0)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    const keep = this.options.maxTables ?? 4;
    while (idle.length > keep) {
      const [key, table] = idle.shift() as [string, LoadedTable];
      await this.drop(key, table);
    }
  }

  private async drop(key: string, table: LoadedTable) {
    if (this.tables.get(key) === table) this.tables.delete(key);
    await this.views.forget(table);
    await table.dispose();
  }

  /** Waits until the table of a handle has loaded, or failed to; for tests and hosts that need every row. */
  async whenLoaded(id: string): Promise<void> {
    await this.handles.get(id)?.whenReady();
  }

  /** Closes every table and the database, and deletes the engine's files. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.running.values()) controller.abort();
    await this.views.forget();
    for (const [key, table] of [...this.tables]) await this.drop(key, table);
    for (const table of this.retired) await table.dispose();
    this.retired.clear();
    this.handles.clear();
    this.listeners.clear();
    await this.session.dispose();
  }
}
