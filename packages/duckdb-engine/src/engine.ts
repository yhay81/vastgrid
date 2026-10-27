/**
 * The DuckDB engine of vastgrid v2 (docs/v2-spec.md §8): answers request messages with responses whose blocks are
 * bytes (the structured encoding of §8.8), and sends events (§8.5) to its subscribers.
 */
import { randomBytes } from "node:crypto";
import { realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  answerId,
  BlockValueError,
  checkRequest,
  type ErrorCode,
  errorResponse,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  SpecError,
} from "vastgrid-spec";
import { EngineError, errorMessage } from "./errors.js";
import { type ExportFormat, ExportStore, type KeptExport, writeExport } from "./export.js";
import { isSavable, saveTable } from "./save.js";
import { Session } from "./session.js";
import { fileRevision, LoadedTable, type TableFormat, tableFormatOf } from "./table.js";
import { CAPABILITIES, type ViewOptions, Views } from "./view.js";
import { FileWatcher } from "./watch.js";
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
   * The file that the `target` of `export` names (§8.2), where the host lets exports be written: a path inside the
   * allowed folders, which is not a file that a table was read from. Throw to refuse it (`not_allowed`). Without
   * it, exports name no target: the engine keeps each one for the host to serve (`exportFile`).
   */
  resolveTarget?: (target: string) => string | Promise<string>;
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
  /**
   * Lets `save` write the written cells into the CSV and TSV files they came from (§7.5), keeping every byte that
   * holds no edited field. Off by default: the engine then never changes a file, and `capabilities.save` is false.
   */
  saveFiles?: boolean;
  /**
   * Follows the files of open tables (§7.6): a file that changes on disk is read again, or, when its table has
   * written cells, reported with `fileChanged`. On by default; without it, files are checked on `changes` and
   * `open` only.
   */
  watchFiles?: boolean;
  /** Receives problems that no request caused, for logs. */
  log?: (message: string, error?: unknown) => void;
}

type Json = Record<string, unknown>;
type Request = Json & { v: 2; id: number; op: Operation };

/** How long a file must stay unchanged before the engine reads it again, in milliseconds. */
const WATCH_DELAY = 100;

/** The size of a file, or null when it is not there. */
function fileSize(file: string): Promise<number | null> {
  return stat(file).then(
    (info) => info.size,
    () => null,
  );
}

/** The key of the tables of a file read with some options. */
function tableKey(file: string, options: ReadOptions) {
  return `${file}\u0000${JSON.stringify(options)}`;
}

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
  private readonly watcher: FileWatcher;
  private readonly exports: ExportStore;
  /** Stops watching the file of each table. */
  private readonly unwatch = new Map<LoadedTable, () => void>();
  private nextHandle = 1;
  private disposed = false;

  private constructor(
    private readonly session: Session,
    private readonly options: DuckDBEngineOptions,
    /** The hash of the plan `{}` (§4.8), the view of a table that is loading (§9). */
    private readonly tableHash: string,
  ) {
    this.watcher = new FileWatcher(WATCH_DELAY, options.log);
    this.exports = new ExportStore((name) => session.file(name));
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

  /** The `changed` event of a handle (§8.5), with `fileChanged` for a table whose file changed on disk (§7.6). */
  private changedEvent(id: string, table: LoadedTable): Json {
    const event: Json = { v: 2, event: "changed", table: id, revision: table.revision, edits: table.edits.state };
    if (table.fileChanged) event.fileChanged = true;
    return event;
  }

  /** Sends `changed` to every handle of a table. */
  private tellChanged(table: LoadedTable) {
    for (const [id, item] of this.handles) if (item === table) this.emit(this.changedEvent(id, table));
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
        this.emit(this.changedEvent(id, table));
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
      return errorResponse(answerId(message), "invalid_request", error.message, {
        path: error.path,
        reason: error.reason,
      });
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
      const { code, message, ...extra } = this.errorOf(error);
      return errorResponse(request.id, code as ErrorCode, message as string, extra);
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

  /**
   * The table of a request that reads every row of its view (`summarize`, `find`, `export`): one that is loading is
   * read once it has loaded (§9), as a write is; until then its view holds the rows read so far.
   */
  private async loaded(request: Json, signal: AbortSignal): Promise<LoadedTable> {
    const table = this.table(request);
    if (table.status !== "loading") return table;
    const revision = table.revision;
    await untilReady(table, signal);
    if (table.revision !== revision) {
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
        // Clients without events poll `changes` (§8.5): the file is checked then too (§7.6).
        await this.follow(this.table(request));
        const table = this.table(request);
        return table.fileChanged
          ? { revision: table.revision, edits: table.edits.state, fileChanged: true }
          : { revision: table.revision, edits: table.edits.state };
      }
      case "reload":
        return this.reload(request.table as string);
      case "close":
        await this.close(request.table as string);
        return null;
      case "rows":
        return this.views.rows(this.table(request), request, signal);
      case "locate":
        return this.views.locate(this.table(request), request, signal);
      case "summarize":
        return this.views.summarize(await this.loaded(request, signal), request, signal);
      case "find":
        return this.views.find(await this.loaded(request, signal), request, signal);
      case "write":
        return this.write(this.table(request), request, signal);
      case "save":
        return this.save(this.table(request), signal);
      case "export":
        return this.exportView(await this.loaded(request, signal), request, signal);
      default:
        throw new EngineError("internal", `The engine does not answer ${request.op}.`);
    }
  }

  /** Writes cells (§7.2), and tells every handle of the table that its data changed (§8.5). */
  private async write(table: LoadedTable, request: Json, signal: AbortSignal) {
    const result = await table.edits.write(request, signal);
    if (result.updated > 0) this.tellChanged(table);
    return result;
  }

  /** Saves the written cells into the file (§7.5), and tells every handle of the table that its edits changed. */
  private async save(table: LoadedTable, signal: AbortSignal) {
    if (!this.options.saveFiles) {
      throw new EngineError("save_unsupported", "This engine does not save files (saveFiles is off).");
    }
    const version = table.edits.version;
    const result = await saveTable(this.session, table, signal);
    if (result.edits.version !== version) this.tellChanged(table);
    return result;
  }

  /**
   * Writes the view of a request (§8.2) into the host's `target`, or, without one, into a file that the engine
   * keeps (`exportFile`), whose name the answer gives as its `target`. The file is written under a temporary name
   * and renamed once complete, so that a failed or cancelled export leaves nothing behind.
   */
  private async exportView(table: LoadedTable, request: Json, signal: AbortSignal) {
    const format = request.format as ExportFormat;
    const destination = request.target === undefined ? null : await this.resolveTarget(request.target as string);
    const kept = destination === null ? this.exports.reserve(format) : null;
    const file = destination ?? (kept as { path: string }).path;
    const temporary =
      destination === null
        ? file
        : path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const rows = await this.views.export(table, request, signal, async (view, columns) => {
        await this.session.withConnection(signal, (connection) =>
          writeExport(
            connection,
            {
              view,
              format,
              columns,
              headers: (request.headers as string[] | undefined) ?? columns.map((column) => column.name),
              numberFormats: request.numberFormats as (string | null)[] | undefined,
              signal,
            },
            temporary,
          ),
        );
        return view.rowCount;
      });
      if (signal.aborted) throw new EngineError("cancelled", "The request was cancelled.");
      if (table.replaced) {
        throw new EngineError("revision_changed", "The file changed while it was exported: export it again.");
      }
      if (destination !== null) {
        await rename(temporary, destination);
        return { target: request.target, rows };
      }
      const { name } = kept as { name: string };
      const base = path.basename(table.path).replace(/\.[^.]+(\.(gz|zst))?$/i, "");
      await this.exports.keep(name, file, `${base}.${format}`, format);
      return { target: name, rows };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** The file of an `export` that named no target (§8.2), by the name its answer gave; null when it is gone. */
  exportFile(name: string): KeptExport | null {
    return this.exports.get(name);
  }

  /** Where the host lets an export's `target` be written: inside the allowed folders, and no table's file. */
  private async resolveTarget(target: string): Promise<string> {
    const refuse = (message: string) => new EngineError("not_allowed", message);
    if (!this.options.resolveTarget) {
      throw refuse("This engine keeps exports for the host to serve: leave out the target.");
    }
    let file: string;
    try {
      file = path.resolve(await this.options.resolveTarget(target));
    } catch (error) {
      throw refuse(errorMessage(error) || "The host does not write exports there.");
    }
    // The folder may be a link: the file is written at its real location, which must be allowed.
    const folder = await realpath(path.dirname(file)).catch(() => {
      throw refuse("The folder of the target does not exist.");
    });
    const destination = path.join(folder, path.basename(file));
    if (!this.session.allows(destination)) throw refuse("The target is outside the folders this engine may write.");
    const real = await realpath(destination).catch(() => destination);
    const tables = [...this.tables.values(), ...this.retired];
    if (tables.some((table) => table.path === real)) throw refuse("An export does not replace a file that is open.");
    return destination;
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
    const key = tableKey(file, options);
    const loaded = this.tables.get(key);
    // The handles of a table whose file changed follow it first (§7.6), so that all of them read the same table.
    if (loaded && loaded.fileState !== revision && loaded.handles > 0) await this.follow(loaded);
    const table = await this.tableOf(key, file, format, revision, info.size, options);
    table.handles++;
    table.lastUsed = Date.now();
    const id = `t${this.nextHandle++}`;
    this.handles.set(id, table);
    // The first answer has the columns and the first rows to read (or the error), and the sheets of a workbook.
    await table.whenReadable();
    await this.trim();
    return this.info(id, table);
  }

  /**
   * The table of a file as it is now (`revision`): the one loaded for it, or a new one when the file changed or its
   * load failed. A table it replaces is dropped, or, while handles use it, kept apart for them.
   */
  private async tableOf(
    key: string,
    file: string,
    format: TableFormat,
    revision: string,
    size: number,
    options: ReadOptions,
  ): Promise<LoadedTable> {
    const loaded = this.tables.get(key);
    if (loaded && loaded.fileState === revision && loaded.status !== "error") return loaded;
    if (loaded && loaded.handles === 0) await this.drop(key, loaded);
    else if (loaded) {
      this.tables.delete(key);
      this.retired.add(loaded);
    }
    const table = new LoadedTable(this.session, file, format, revision, size, options, {
      previewRows: this.options.previewRows ?? 1000,
      onChange: (changed, change) => this.changed(changed, change),
      log: this.options.log,
    });
    this.tables.set(key, table);
    table.start();
    if (this.options.watchFiles !== false) {
      const follow = () =>
        void this.follow(table).catch((error: unknown) => this.options.log?.(`Could not follow ${file}`, error));
      this.unwatch.set(table, this.watcher.watch(file, follow));
    }
    return table;
  }

  /**
   * Follows the file of a table that handles use when it changed on disk (§7.6): a table without written cells is
   * read again, and its handles move to the new table once it has loaded; one with written cells stays, with
   * `fileChanged`, and so does one whose file cannot be read now (removed, or half written). The checks run between
   * writes and saves, so that a save of the engine itself is not a change.
   */
  private async follow(table: LoadedTable): Promise<void> {
    const key = tableKey(table.path, table.read);
    const told = () => {
      if (table.fileChanged) return null;
      table.fileChanged = true;
      return "told" as const;
    };
    const checked = await this.unlessLeft(table, async () => {
      const revision = await fileRevision(table.path).catch(() => null);
      if (revision === table.fileState) {
        // A file that came back as it was read.
        if (!table.fileChanged) return null;
        table.fileChanged = false;
        return "told" as const;
      }
      const size = revision === null ? null : await fileSize(table.path);
      if (revision === null || size === null || table.edits.state.cells > 0) return told();
      return { revision, size };
    });
    if (checked === null) return;
    if (checked === "told") {
      this.tellChanged(table);
      return;
    }
    // The handles read the table as it was until the new one has loaded.
    const fresh = await this.tableOf(key, table.path, table.format, checked.revision, checked.size, table.read);
    await this.untilLoaded(fresh);
    const moved = await this.unlessLeft(table, async () => {
      // A newer change made another table, which its own follow moves the handles to.
      if (this.tables.get(key) !== fresh) return null;
      if (fresh.status === "error" || table.edits.state.cells > 0) return told();
      return this.move(table, fresh, null);
    });
    if (moved === null) return;
    if (moved === "told") {
      this.tellChanged(table);
      return;
    }
    await this.leave(table);
    for (const id of moved) this.emit(this.changedEvent(id, fresh));
  }

  /** Runs a check between the writes of a table, unless its handles have left it. */
  private unlessLeft<T>(table: LoadedTable, check: () => Promise<T>): Promise<T | null> {
    const left = () => this.disposed || table.handles === 0 || table.replaced;
    if (left()) return Promise.resolve(null);
    return table.edits.exclusive(async () => (left() ? null : check()));
  }

  /** Moves a handle (or, with null, every handle) of a table to another table. Gives the handles moved. */
  private move(table: LoadedTable, fresh: LoadedTable, only: string | null): string[] {
    const moved: string[] = [];
    for (const [id, item] of this.handles) {
      if (item !== table || (only !== null && id !== only)) continue;
      this.views.unfollow(id);
      this.handles.set(id, fresh);
      fresh.handles++;
      table.handles--;
      moved.push(id);
    }
    if (table.handles === 0) table.replaced = true;
    return moved;
  }

  /** Drops a table that its last handle left. */
  private async leave(table: LoadedTable) {
    if (table.handles > 0) return;
    this.retired.delete(table);
    for (const [key, item] of this.tables) if (item === table) this.tables.delete(key);
    await this.release(table);
  }

  /**
   * Moves a handle to its file as it is now (`reload`, §7.6), once it has loaded: with a new revision and without
   * the written cells, which stay with the other handles of the table it leaves. A handle whose file has not
   * changed stays.
   */
  private async reload(id: string) {
    const table = this.table({ table: id });
    await this.follow(table);
    const current = this.handles.get(id) as LoadedTable;
    if (current !== table || (!table.fileChanged && table.status !== "error")) return this.info(id, current);
    const revision = await fileRevision(table.path).catch(() => null);
    const size = revision === null ? null : await fileSize(table.path);
    if (revision === null || size === null) throw new EngineError("load_failed", "The file does not exist.");
    const key = tableKey(table.path, table.read);
    const fresh = await this.tableOf(key, table.path, table.format, revision, size, table.read);
    await this.untilLoaded(fresh);
    if (fresh.status === "error") throw new EngineError("load_failed", fresh.error ?? "The file could not be read.");
    if (this.handles.get(id) === table && fresh !== table) {
      this.move(table, fresh, id);
      await this.leave(table);
    }
    const now = this.handles.get(id) as LoadedTable;
    this.emit(this.changedEvent(id, now));
    return this.info(id, now);
  }

  /** Waits until a table that handles are about to move to has loaded; it counts as used meanwhile, for `trim`. */
  private async untilLoaded(table: LoadedTable) {
    table.handles++;
    try {
      await table.whenReady();
    } finally {
      table.handles--;
    }
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
      capabilities: { ...CAPABILITIES, save: this.options.saveFiles === true && isSavable(table) },
      format: table.format,
      byteSize: table.byteSize,
    };
    if (table.notes.length > 0) info.notes = [...table.notes];
    if (table.sheets) info.sheets = table.sheets.map((sheet) => ({ ...sheet }));
    if (table.sheet !== undefined) info.sheet = table.sheet;
    if (table.error !== undefined) info.error = table.error;
    if (table.fileChanged) info.fileChanged = true;
    return info;
  }

  /** Takes a handle back (§8.2). The table stays loaded for a while, to be opened again without loading it. */
  private async close(id: string) {
    const table = this.handles.get(id);
    if (!table) throw new EngineError("table_not_found", "The table is closed or unknown.");
    this.views.unfollow(id);
    this.handles.delete(id);
    table.handles--;
    if (table.handles === 0 && (this.retired.delete(table) || table.edits.version > 0 || table.fileChanged)) {
      // Written cells belong to the handles open on the table: once the last one closes, they are gone, and the
      // file is opened again as it is.
      for (const [key, item] of this.tables) if (item === table) this.tables.delete(key);
      await this.release(table);
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
    await this.release(table);
  }

  /** Stops watching a table's file, and deletes its views and what it made. */
  private async release(table: LoadedTable) {
    this.unwatch.get(table)?.();
    this.unwatch.delete(table);
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
    for (const table of this.retired) await this.release(table);
    this.retired.clear();
    this.watcher.dispose();
    this.handles.clear();
    this.listeners.clear();
    await this.session.dispose();
  }
}

/** Waits until a table has loaded (or failed to), or until the request is cancelled. */
function untilReady(table: LoadedTable, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new EngineError("cancelled", "The request was cancelled."));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    table
      .whenReady()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
