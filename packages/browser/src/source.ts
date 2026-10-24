import {
  type AggregateRequest,
  abortError,
  type ColumnStats,
  type DistinctRequest,
  type DistinctValues,
  ErrorCodes,
  type FindRequest,
  type FindResult,
  type GroupRequest,
  type GroupResult,
  type RowBlock,
  type RowRequest,
  type SelectionSummary,
  SourceError,
  type TableChangeListener,
  type TableInfo,
  type TableSource,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid-core";
import type { Transfer } from "./bytes.js";
import { errorMessage } from "./errors.js";
import type { TableMethod, WorkerLike, WorkerResponse } from "./messages.js";
import type { BrowserTableOptions, TableInput } from "./table.js";

export type BrowserSourceOptions = TableInput &
  BrowserTableOptions & {
    /**
     * Creates the worker that reads the file. By default `new Worker(new URL("./worker.js", import.meta.url),
     * { type: "module" })`, which Vite, webpack and other bundlers understand. Pass your own when the
     * bundler needs another form, for example `() => new BrowserWorker()` with
     * `import BrowserWorker from "vastgrid-browser/worker?worker"` in Vite.
     */
    worker?: () => WorkerLike;
    /**
     * Files at a URL: how often a subscribed grid asks the server whether the file changed (a `HEAD`
     * request comparing `ETag`, `Last-Modified` or the size), in milliseconds. Default 5,000, at least
     * 500; `0` turns it off. Local files cannot be watched.
     */
    changeInterval?: number;
  };

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "vastgrid-browser" });
}

/**
 * A table read in a Web Worker, with no server: a local file (`File` or `Blob`) of Parquet, CSV, TSV or
 * JSON Lines, or a Parquet file at a URL read with HTTP `Range` requests. The page's thread only sends
 * requests and receives the rows to draw; reading, sorting and filtering happen in the worker.
 *
 * ```ts
 * const source = new BrowserSource({ file: input.files[0] });
 * const remote = new BrowserSource({ url: "https://example.com/data.parquet" });
 * ```
 *
 * Call `close()` when the table is no longer shown: it ends the worker and frees its memory.
 */
export class BrowserSource implements TableSource {
  private readonly options: BrowserSourceOptions;
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: SourceError | null = null;
  private closed = false;
  private readonly listeners = new Set<TableChangeListener>();
  private stopWatching: (() => void) | null = null;

  constructor(options: BrowserSourceOptions) {
    this.options = options;
  }

  private connect() {
    if (this.worker) return this.worker;
    const { worker: create = defaultWorker, changeInterval: _interval, ...rest } = this.options;
    const input: TableInput =
      "url" in rest ? { url: rest.url } : { file: rest.file, name: rest.name ?? (rest.file as Partial<File>).name };
    const { url: _url, file: _file, name: _name, ...options } = rest as Record<string, unknown>;
    const worker = create();
    worker.addEventListener("message", (event: MessageEvent) => this.receive(event.data as WorkerResponse));
    worker.addEventListener("error", (event: Event) => {
      const message = (event as ErrorEvent).message || "the worker could not start or stopped";
      this.fail(new SourceError(ErrorCodes.loadFailed, `The file reader failed: ${message}.`, 500));
    });
    worker.start?.();
    this.worker = worker;
    try {
      worker.postMessage({ type: "open", input, options });
    } catch (error) {
      // For example a DataCloneError: the file or an option cannot be sent to the worker.
      this.stop();
      throw new SourceError(
        ErrorCodes.loadFailed,
        `The file cannot be sent to the worker: ${errorMessage(error)}`,
        422,
      );
    }
    return worker;
  }

  private receive(response: WorkerResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.type === "result") {
      pending.resolve(response.result);
      return;
    }
    const { name, code, message, status } = response.error;
    if (name === "AbortError") pending.reject(abortError());
    else if (code) pending.reject(new SourceError(code, message, status));
    else pending.reject(new Error(message));
  }

  private fail(error: SourceError) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private call<T>(method: TableMethod, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new SourceError(ErrorCodes.tableNotFound, "The source is closed.", 404));
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(abortError());
    let worker: WorkerLike;
    try {
      worker = this.connect();
    } catch (error) {
      if (error instanceof SourceError) this.failure = error;
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        worker.postMessage({ type: "cancel", id });
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      worker.postMessage({ type: "call", id, method, args });
    });
  }

  info(signal?: AbortSignal): Promise<TableInfo> {
    return this.call("info", [], signal);
  }

  createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    return this.call("createView", [query], signal);
  }

  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock> {
    return this.call("readRows", [request], signal);
  }

  columnStats(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats> {
    return this.call("columnStats", [view, column], signal);
  }

  distinctValues(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues> {
    return this.call("distinctValues", [request], signal);
  }

  aggregate(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary> {
    return this.call("aggregate", [request], signal);
  }

  find(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null> {
    return this.call("find", [request], signal);
  }

  /** Groups and aggregates in the worker, which reads the whole file (only with `fullScan`). */
  group(request: GroupRequest, signal?: AbortSignal): Promise<GroupResult> {
    return this.call("group", [request], signal);
  }

  /**
   * Files at a URL: calls `listener` when the file on the server changed, checked every
   * `changeInterval` milliseconds while there are listeners. The next `info()` reads the new file.
   */
  subscribe(listener: TableChangeListener): () => void {
    this.listeners.add(listener);
    if (!this.stopWatching) this.stopWatching = this.watch();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.unwatch();
    };
  }

  private watch() {
    const interval = this.options.changeInterval ?? 5000;
    if (!("url" in this.options) || interval <= 0) return () => undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        // Only an open file is compared; `info()` opens it.
        if (this.worker && (await this.call<boolean>("checkChanges", [], controller.signal))) {
          for (const listener of [...this.listeners]) listener({});
        }
      } catch {
        // Ask again at the next interval; errors reach the grid through its own requests.
      }
      if (!controller.signal.aborted && !this.closed) timer = setTimeout(tick, Math.max(500, interval));
    };
    timer = setTimeout(tick, Math.max(500, interval));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }

  private unwatch() {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  /** Bytes read from the file or the network so far, and how many reads (HTTP requests) it took. */
  transfer(signal?: AbortSignal): Promise<Transfer> {
    return this.call("transfer", [], signal);
  }

  /** Ends the worker. Requests still waiting fail; the source must not be used afterwards. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unwatch();
    this.listeners.clear();
    const error = new SourceError(ErrorCodes.cancelled, "The source was closed.", 499);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.postMessage({ type: "close" });
    this.stop();
  }

  private stop() {
    this.worker?.terminate?.();
    this.worker?.close?.();
    this.worker = null;
  }
}
