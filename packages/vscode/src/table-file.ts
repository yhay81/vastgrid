/**
 * A file that vastgrid's editors in VS Code show (docs/vscode.md): the DuckDB engine that reads it, in the
 * extension's process, and the webviews that show it, each a client of the engine with requests of its own. VS Code
 * saves, saves as and reverts the file here; the webviews read and write its cells. Nothing here uses VS Code's
 * API, so that the tests run it in Node.js.
 */
import { copyFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DuckDBEngine, type DuckDBEngineOptions, tableFormatOf } from "vastgrid-duckdb-engine";
import { type Handler, RequestIds } from "vastgrid-grid/core";
import type { HostMessage, ViewMessage } from "./messages.js";

type Json = Record<string, unknown>;

/** An export that the engine wrote and keeps: where it is and the name it suggests. */
export interface KeptFile {
  path: string;
  fileName: string;
}

export interface TableFileOptions {
  /** Where the engines of the file keep their files: a folder of their own inside, deleted when they close. */
  tempDirectory: string;
  /** Lets the file be edited and saved (CSV and TSV only): VS Code trusts the workspace. */
  editable: boolean;
  /**
   * Asks the person where an export of the grid goes and copies it there; false when they cancelled. Without it,
   * the grid offers no export.
   */
  exportTo?: (file: KeptFile) => Promise<boolean>;
  /** Options of the engine (memory, threads) besides those that the file sets. */
  engine?: Partial<DuckDBEngineOptions>;
  log?: (message: string, error?: unknown) => void;
}

/** Why a request of the extension to the engine failed: its code of §8.7 and message. */
export class TableFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TableFileError";
  }
}

/** The formats that `saveAs` writes, by the extension of the new file. */
const EXPORT_FORMATS: [RegExp, string][] = [
  [/\.csv$/i, "csv"],
  [/\.(tsv|tab)$/i, "tsv"],
  [/\.(parquet|pq)$/i, "parquet"],
  [/\.json$/i, "json"],
  [/\.xlsx$/i, "xlsx"],
];

/** Whether the engine saves the file's cells (§7.5): CSV and TSV files that are not compressed. */
export function isSavableFile(file: string): boolean {
  const format = tableFormatOf(file);
  return (format === "csv" || format === "tsv") && !/\.(gz|zst)$/i.test(file);
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(answer: unknown): TableFileError | null {
  if (!isObject(answer) || !isObject(answer.error)) return null;
  return new TableFileError(String(answer.error.code), String(answer.error.message));
}

/** A webview's connection to the file. */
export interface FileView {
  /** Takes a message of the webview: a request of §8 or a `ViewMessage`. */
  receive(message: unknown): void;
  /** Applies a command of §6 in the webview's grid, as its keys and menus do. */
  dispatch(command: unknown): Promise<unknown>;
  /** Closes the handles that the webview opened and stops its requests. */
  dispose(): void;
}

/** An engine of the file, and the client of the extension's own requests among its clients. */
interface Running {
  engine: DuckDBEngine;
  ids: RequestIds;
  own: Handler;
}

interface ViewState {
  /** The handles that the webview opened, in the engine that it uses, through its client of that engine. */
  tables: Set<string>;
  running: Running | null;
  client: Handler | null;
  stop: AbortController;
  post: (message: unknown) => void;
  calls: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  /** Whether the page's grid takes commands; those dispatched before it does wait. */
  listening: boolean;
  waiting: HostMessage[];
}

export class TableFile {
  /** The engine, made when it is first needed; a revert closes it, and the next request makes another. */
  private engine: Promise<Running> | null = null;
  private readonly views = new Set<ViewState>();
  private readonly writeListeners = new Set<() => void>();
  private readonly saveListeners = new Set<() => void>();
  private stopEvents: (() => void) | null = null;
  private nextId = 1;
  private nextCall = 1;
  /** Raised by each engine made and by each revert, which drops the engine being made. */
  private generation = 0;
  private disposed = false;
  /** The `ref` that the webviews open: the file's name, which they show. */
  readonly ref: string;

  constructor(
    /** The file's path, as VS Code names it. */
    readonly file: string,
    private readonly options: TableFileOptions,
  ) {
    this.ref = path.basename(file);
  }

  /** Whether cells of the file can be written and saved. */
  get editable(): boolean {
    return this.options.editable && isSavableFile(this.file);
  }

  /** Follows writes of cells that succeed, which make the file's editor dirty. */
  onWrite(listener: () => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  /** Follows the key that saves, pressed in a webview. */
  onSaveKey(listener: () => void): () => void {
    this.saveListeners.add(listener);
    return () => {
      this.saveListeners.delete(listener);
    };
  }

  /** Calls listeners of the editor, whose failures are logged: they never stop an answer. */
  private tell(listeners: Set<() => void>) {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.options.log?.(`A listener of ${this.ref} failed`, error);
      }
    }
  }

  private getEngine(): Promise<Running> {
    if (this.disposed) return Promise.reject(new TableFileError("internal", "The file was closed."));
    if (this.engine) return this.engine;
    const generation = ++this.generation;
    const made = (async () => {
      // The engine reads the file where it really is, and no other file.
      const file = await realpath(this.file);
      await mkdir(this.options.tempDirectory, { recursive: true });
      const engine = await DuckDBEngine.create({
        ...this.options.engine,
        allowedDirectories: [path.dirname(file)],
        tempDirectory: this.options.tempDirectory,
        saveFiles: this.editable,
        resolve: (ref) => {
          if (ref !== this.ref) throw new Error(`This editor opens ${this.ref} only.`);
          return file;
        },
        ...(this.options.log ? { log: this.options.log } : {}),
      });
      if (this.disposed || this.generation !== generation) {
        await engine.dispose();
        throw new TableFileError("cancelled", "The file was closed.");
      }
      const ids = new RequestIds(engine);
      const running: Running = { engine, ids, own: ids.client() };
      this.stopEvents = engine.subscribe((event) => {
        for (const view of this.views) if (view.running === running) view.post(event);
      });
      return running;
    })();
    this.engine = made;
    made.catch(() => {
      if (this.engine === made) this.engine = null;
    });
    return made;
  }

  /** Sends a request of the extension itself to the engine, and gives its result or throws its error. */
  private async request(running: Running, op: string, members: Json, signal?: AbortSignal): Promise<Json> {
    const answer = await running.own.handle({ v: 2, id: this.nextId++, op, ...members }, signal ? { signal } : {});
    const error = failure(answer);
    if (error) throw error;
    return ((answer as Json).result ?? {}) as Json;
  }

  /** Runs `run` on a handle of the file of its own, which it then closes. */
  private async withHandle<T>(run: (running: Running, info: Json) => Promise<T>, signal?: AbortSignal) {
    const running = await this.getEngine();
    const info = await this.request(running, "open", { ref: this.ref }, signal);
    try {
      return await run(running, info);
    } finally {
      await this.request(running, "close", { table: info.table }).catch(() => {});
    }
  }

  /** Saves the written cells into the file (§7.5); the records written anew. Nothing to save without an engine. */
  async save(signal?: AbortSignal): Promise<number> {
    if (!this.engine) return 0;
    if (!this.editable) throw new TableFileError("save_unsupported", `${this.ref} cannot be saved by vastgrid.`);
    return this.withHandle(async (running, info) => {
      const edits = info.edits as { cells: number };
      if (edits.cells === 0) return 0;
      const result = await this.request(running, "save", { table: info.table }, signal);
      return result.records as number;
    }, signal);
  }

  /**
   * Writes the whole table, with its written cells, into `target` in the format of its extension (CSV, TSV,
   * Parquet, JSON or Excel); the rows written.
   */
  async saveAs(target: string, signal?: AbortSignal): Promise<number> {
    const format = EXPORT_FORMATS.find(([pattern]) => pattern.test(target))?.[1];
    if (!format) {
      throw new TableFileError("invalid_request", "vastgrid saves as .csv, .tsv, .parquet, .json or .xlsx files.");
    }
    return this.withHandle(async (running, info) => {
      const result = await this.request(
        running,
        "export",
        { table: info.table, revision: info.revision, plan: {}, format },
        signal,
      );
      const kept = running.engine.exportFile(result.target as string);
      if (!kept) throw new TableFileError("internal", "The engine did not keep the export.");
      await copyFile(kept.path, target);
      return result.rows as number;
    }, signal);
  }

  /**
   * Drops the written cells: the engine closes, with its database and files, and the webviews open the file
   * anew. The next request starts another engine.
   */
  async revert(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.generation++;
    this.stopEvents?.();
    this.stopEvents = null;
    for (const view of this.views) {
      view.tables.clear();
      view.running = null;
      view.client = null;
    }
    if (engine) await (await engine.catch(() => null))?.engine.dispose();
    for (const view of this.views) view.post({ vastgrid: "restart" } satisfies HostMessage);
  }

  /** Connects a webview, which `post` sends messages to. */
  connect(post: (message: unknown) => void): FileView {
    const view: ViewState = {
      tables: new Set(),
      running: null,
      client: null,
      stop: new AbortController(),
      post,
      calls: new Map(),
      listening: false,
      waiting: [],
    };
    this.views.add(view);
    return {
      receive: (message) => void this.receive(view, message),
      dispatch: (command) =>
        new Promise((resolve, reject) => {
          const call = this.nextCall++;
          view.calls.set(call, { resolve, reject });
          const message: HostMessage = { vastgrid: "dispatch", call, command };
          if (view.listening) post(message);
          else view.waiting.push(message);
        }),
      dispose: () => this.disconnect(view),
    };
  }

  private disconnect(view: ViewState) {
    if (!this.views.delete(view)) return;
    view.stop.abort();
    for (const { reject } of view.calls.values()) reject(new TableFileError("cancelled", "The editor was closed."));
    view.calls.clear();
    this.closeHandles(view);
  }

  private closeHandles(view: ViewState) {
    const running = view.running;
    if (!running) return;
    for (const table of view.tables) void this.request(running, "close", { table }).catch(() => {});
    view.tables.clear();
  }

  private async receive(view: ViewState, message: unknown) {
    if (!isObject(message)) return;
    if (typeof message.vastgrid === "string") {
      this.receiveOwn(view, message as ViewMessage);
      return;
    }
    let running: Running;
    try {
      running = await this.getEngine();
    } catch (error) {
      if (typeof message.id === "number" && message.op !== "cancel") {
        const text = error instanceof Error ? error.message : String(error);
        const code = error instanceof TableFileError ? error.code : "load_failed";
        view.post({ v: 2, id: message.id, error: { code, message: text } });
      }
      return;
    }
    if (view.running !== running || !view.client) {
      view.tables.clear();
      view.running = running;
      view.client = running.ids.client();
    }
    let answer = (await view.client.handle(message, { signal: view.stop.signal })) as Json | undefined;
    if (answer === undefined || view.stop.signal.aborted || !this.views.has(view)) return;
    answer = await this.adapt(view, running, message, answer);
    if (view.running === running) view.post(answer);
  }

  private receiveOwn(view: ViewState, message: ViewMessage) {
    switch (message.vastgrid) {
      case "ready":
        // A page that loaded again opens its table anew: the handles of the page before are nobody's.
        view.listening = false;
        this.closeHandles(view);
        return;
      case "listening":
        view.listening = message.on;
        if (message.on) for (const waiting of view.waiting.splice(0)) view.post(waiting);
        return;
      case "error":
        this.options.log?.(`The page of ${this.ref} failed`, message.message);
        return;
      case "save":
        this.tell(this.saveListeners);
        return;
      case "answer": {
        const call = view.calls.get(message.call);
        view.calls.delete(message.call);
        if (!call) return;
        if (message.ok) call.resolve(message.output);
        else call.reject(new TableFileError(message.error?.code ?? "internal", message.error?.message ?? "Failed."));
        return;
      }
    }
  }

  /**
   * Fits an answer of the engine to the editor: the grid writes cells only where VS Code saves them, and saves
   * through VS Code (its key and its Save), not by itself; an export goes where the person chooses.
   */
  private async adapt(view: ViewState, running: Running, message: Json, answer: Json): Promise<Json> {
    const result = answer.result;
    if (!isObject(result) || answer.error !== undefined) return answer;
    switch (message.op) {
      case "open":
      case "reload":
      case "info": {
        if (message.op !== "info" && typeof result.table === "string") view.tables.add(result.table);
        const capabilities: Json = { ...(result.capabilities as Json), write: this.editable, save: false };
        if (!this.options.exportTo) delete capabilities.export;
        return { ...answer, result: { ...result, capabilities } };
      }
      case "close":
        view.tables.delete(message.table as string);
        return answer;
      case "write":
        if ((result.updated as number) > 0) this.tell(this.writeListeners);
        return answer;
      case "export": {
        const kept = typeof result.target === "string" ? running.engine.exportFile(result.target) : null;
        if (!kept || !this.options.exportTo) return answer;
        try {
          if (!(await this.options.exportTo({ path: kept.path, fileName: kept.fileName }))) {
            return { v: 2, id: answer.id, error: { code: "cancelled", message: "The export was cancelled." } };
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { v: 2, id: answer.id, error: { code: "internal", message: text } };
        }
        return { ...answer, result: { ...result, target: null } };
      }
      default:
        return answer;
    }
  }

  /** Closes the webviews' connections and the engine, with its database and files. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const view of [...this.views]) this.disconnect(view);
    this.disposed = true;
    const engine = this.engine;
    this.engine = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.writeListeners.clear();
    this.saveListeners.clear();
    if (engine) await (await engine.catch(() => null))?.engine.dispose();
  }
}
