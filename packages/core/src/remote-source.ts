import { ErrorCodes, type InfoResult, type ProtocolRequest, type RevisionResult } from "./protocol.js";
import { abortError, isEmptyQuery, SourceError, type TableChangeListener, type TableSource } from "./source.js";
import type {
  AggregateRequest,
  ColumnStats,
  DistinctRequest,
  DistinctValues,
  ExportRequest,
  ExportResult,
  FindRequest,
  FindResult,
  ReadOptions,
  RowBlock,
  RowRequest,
  SelectionSummary,
  TableInfo,
  UpdateRequest,
  UpdateResult,
  ViewInfo,
  ViewOptions,
  ViewQuery,
} from "./types.js";

export interface RemoteSourceOptions {
  /** URL that accepts the protocol requests (`POST`, JSON). */
  endpoint: string;
  /** What to open, in the server's terms (for example a path relative to a workspace). */
  ref: string;
  /** How to read the file, for formats that need a choice (for example the sheet of a workbook). */
  read?: ReadOptions;
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  /**
   * How the source learns that the table changed, while a grid subscribes to it (see
   * `TableSource.subscribe`): `pollChanges()` (the default, every 2 seconds), another transport, or
   * `false` for none.
   */
  changes?: ChangeTransport | false;
}

/** What a `ChangeTransport` is given to watch one table. */
export interface ChangeWatch {
  /** What the source opens (`RemoteSourceOptions.ref`). */
  readonly ref: string;
  /**
   * Asks the server for the table's current revision (the `revision` request) and reports a change
   * when it differs from the revision the source read last. Resolves whether it reported a change.
   * Rejects with the code `invalid_request` when the server does not know the request.
   */
  check(signal?: AbortSignal): Promise<boolean>;
  /**
   * Reports a change that the transport learnt by other means, for example a message the server
   * pushed. A revision the source already read or reported is not reported again.
   */
  changed(revision?: string | null): void;
}

/** How a `RemoteSource` learns that its table changed. */
export interface ChangeTransport {
  /** Starts watching while the source has subscribers. Returns a function that stops watching. */
  watch(watch: ChangeWatch): () => void;
}

/**
 * Asks the server for the table's revision every `interval` milliseconds (default 2,000, at least 100).
 * Failed requests are retried at the next interval, and the first answer after them catches up with
 * changes made meanwhile. Polling stops for good when the server does not know the request.
 */
export function pollChanges(options: { interval?: number } = {}): ChangeTransport {
  const interval = Math.max(100, options.interval ?? 2000);
  return {
    watch(watch) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        try {
          await watch.check(controller.signal);
        } catch (error) {
          if (error instanceof SourceError && error.code === ErrorCodes.invalidRequest) return;
          // Network errors and a server that restarts: ask again later.
        }
        if (!controller.signal.aborted) timer = setTimeout(tick, interval);
      };
      timer = setTimeout(tick, interval);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    },
  };
}

/** Waits for `promise`, but rejects with an AbortError as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type Operation<Op extends ProtocolRequest["op"]> = Omit<Extract<ProtocolRequest, { op: Op }>, "op" | "table">;

/**
 * A table served by a remote engine through the JSON protocol in `protocol.ts`.
 *
 * The server may forget tables (restart, file changed, memory limits) and views. The source
 * reopens the table and recreates views transparently, so a grid keeps working across those events.
 */
export class RemoteSource implements TableSource {
  private readonly options: RemoteSourceOptions;
  private readonly fetcher: typeof fetch;
  private table: string | null = null;
  private opening: Promise<InfoResult> | null = null;
  /** Queries of the views created so far, to recreate them after the server forgets them. */
  private readonly queries = new Map<string, { query: ViewQuery; preview: boolean }>();
  /** View ids issued to callers → current ids on the server. */
  private readonly aliases = new Map<string, string>();
  private readonly recreating = new Map<string, Promise<string>>();
  /** The revision of the table as `info` read it last, and the last revision reported to subscribers. */
  private revision: string | null | undefined;
  private reported: string | null | undefined;
  /** The `edits.version` read last (by `info` or a write), and the last one reported to subscribers. */
  private editVersion: number | undefined;
  private reportedEdits: number | undefined;
  private readonly listeners = new Set<TableChangeListener>();
  private stopWatching: (() => void) | null = null;

  constructor(options: RemoteSourceOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get ref() {
    return this.options.ref;
  }

  private async post<T>(body: ProtocolRequest, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      credentials: this.options.credentials,
      body: JSON.stringify(body),
      signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Not JSON: reported below with the HTTP status.
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new SourceError(
        error?.code ?? `http_${response.status}`,
        error?.message ?? `The table server answered ${response.status}.`,
        response.status,
      );
    }
    return (payload as { result: T }).result;
  }

  /**
   * Opens the table. Concurrent callers share one request, which is not tied to any caller's signal:
   * a caller that gives up (for example a component that unmounts) does not cancel it for the others.
   */
  private async open(signal?: AbortSignal): Promise<InfoResult> {
    if (!this.opening) {
      const request: ProtocolRequest = {
        op: "info",
        ref: this.options.ref,
        ...(this.table ? { table: this.table } : {}),
        ...(this.options.read ? { read: this.options.read } : {}),
      };
      this.opening = this.post<InfoResult>(request).finally(() => {
        this.opening = null;
      });
    }
    const result = await abortable(this.opening, signal);
    if (result.table !== this.table) {
      // A different handle means a new table on the server: its views are gone.
      this.aliases.clear();
    }
    this.table = result.table;
    this.revision = result.revision;
    this.editVersion = result.edits?.version;
    return result;
  }

  async info(signal?: AbortSignal): Promise<TableInfo> {
    const { table: _table, ...info } = await this.open(signal);
    return info;
  }

  private async tableHandle(signal?: AbortSignal) {
    if (this.table) return this.table;
    await this.open(signal);
    if (!this.table) throw new SourceError(ErrorCodes.tableNotFound, "The table could not be opened.", 404);
    return this.table;
  }

  private async serverView(view: string | null, signal?: AbortSignal): Promise<string | null> {
    if (view === null) return null;
    const alias = this.aliases.get(view);
    if (alias) return alias;
    return abortable(this.recreate(view), signal);
  }

  /**
   * Creates a view the server forgot again. Like `open`, concurrent callers share one request that is
   * not tied to any caller's signal: a block that scrolled away does not cancel it for the others.
   */
  private recreate(view: string): Promise<string> {
    let pending = this.recreating.get(view);
    if (!pending) {
      const known = this.queries.get(view);
      if (!known) return Promise.reject(new SourceError(ErrorCodes.viewNotFound, "The view no longer exists.", 404));
      const { query, preview } = known;
      pending = (async () => {
        const table = await this.tableHandle();
        const created = await this.post<ViewInfo>({ op: "view", table, query, ...(preview ? { preview } : {}) });
        if (created.id === null)
          throw new SourceError(ErrorCodes.viewNotFound, "The view could not be recreated.", 404);
        this.aliases.set(view, created.id);
        return created.id;
      })().finally(() => this.recreating.delete(view));
      this.recreating.set(view, pending);
    }
    return pending;
  }

  /**
   * Runs an operation on the table, reopening the table or recreating the view once when the
   * server no longer knows them.
   */
  private async call<T>(
    op: ProtocolRequest["op"],
    fields: Record<string, unknown> & { view?: string | null },
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const table = await this.tableHandle(signal);
      const view = "view" in fields ? await this.serverView(fields.view ?? null, signal) : undefined;
      try {
        const body = { ...fields, op, table, ...(view === undefined ? {} : { view }) } as ProtocolRequest;
        return await this.post<T>(body, signal);
      } catch (error) {
        if (attempt > 0 || !(error instanceof SourceError)) throw error;
        if (error.code === ErrorCodes.tableNotFound) {
          this.table = null;
          this.aliases.clear();
          continue;
        }
        if (error.code === ErrorCodes.viewNotFound && fields.view) {
          this.aliases.delete(fields.view);
          continue;
        }
        throw error;
      }
    }
  }

  async createView(query: ViewQuery, signal?: AbortSignal, options?: ViewOptions): Promise<ViewInfo> {
    if (isEmptyQuery(query)) {
      const info = await this.info(signal);
      return { id: null, rowCount: info.rowCount ?? info.readableRows, query: {} };
    }
    const preview = options?.preview === true;
    const fields: Operation<"view"> = { query, ...(preview ? { preview } : {}) };
    const created = await this.call<ViewInfo>("view", fields, signal);
    if (created.id !== null) {
      // Only a view that is still building is recreated as a preview: one the grid already follows as
      // ready must come back ready, or rows past the preview would fail with `not_ready`.
      this.queries.set(created.id, { query, preview: preview && created.status === "building" });
      this.aliases.set(created.id, created.id);
    }
    return created;
  }

  /** The view's state on the server. A view the server forgot is created again under the same id. */
  async viewInfo(view: string, signal?: AbortSignal): Promise<ViewInfo> {
    const result = await this.call<ViewInfo>("status", { view } satisfies Operation<"status">, signal);
    const known = this.queries.get(view);
    if (known && result.status !== "building") known.preview = false;
    return { ...result, id: view };
  }

  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock> {
    return this.call<RowBlock>("rows", { ...request } satisfies Operation<"rows">, signal);
  }

  columnStats(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats> {
    return this.call<ColumnStats>("stats", { view, column } satisfies Operation<"stats">, signal);
  }

  distinctValues(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues> {
    return this.call<DistinctValues>("distinct", { ...request } satisfies Operation<"distinct">, signal);
  }

  aggregate(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary> {
    return this.call<SelectionSummary>("aggregate", { ...request } satisfies Operation<"aggregate">, signal);
  }

  find(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null> {
    return this.call<FindResult | null>("find", { ...request } satisfies Operation<"find">, signal);
  }

  exportView(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult> {
    return this.call<ExportResult>("export", { ...request } satisfies Operation<"export">, signal);
  }

  /**
   * Writes cells on the server (see `TableSource.updateCells`), which must report `capabilities.edit`.
   * The source's own writes are not reported to its subscribers.
   */
  async updateCells(request: UpdateRequest, signal?: AbortSignal): Promise<UpdateResult> {
    const fields: Operation<"update"> = {
      updates: request.updates,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    };
    const result = await this.call<UpdateResult>("update", fields, signal);
    this.editVersion = result.edits.version;
    return result;
  }

  /**
   * Calls `listener` when the table changed, as the `changes` transport learns it (by default by asking
   * the server every 2 seconds). Watching runs while there are listeners.
   */
  subscribe(listener: TableChangeListener): () => void {
    this.listeners.add(listener);
    const transport = this.options.changes ?? pollChanges();
    if (!this.stopWatching && transport) {
      this.stopWatching = transport.watch({
        ref: this.options.ref,
        check: (signal) => this.checkRevision(signal),
        changed: (revision) => this.changed(revision),
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.unwatch();
    };
  }

  private unwatch() {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async checkRevision(signal?: AbortSignal) {
    const known = this.revision;
    const knownEdits = this.editVersion;
    const result = await this.call<RevisionResult>("revision", {} satisfies Operation<"revision">, signal);
    // Before the first `info` there is nothing to compare with. A table reopened by the request (the
    // server restarted) set `revision` anew: the comparison is with the revision from before.
    if (known === undefined) return false;
    if (result.revision !== known && result.revision !== this.reported) {
      this.report(result.revision);
      return true;
    }
    // Cells written by another client of the same table.
    const edits = result.edits;
    if (edits === undefined || edits === knownEdits || edits === this.editVersion || edits === this.reportedEdits) {
      return false;
    }
    this.reportedEdits = edits;
    for (const listener of [...this.listeners]) listener({ edits });
    return true;
  }

  private changed(revision?: string | null) {
    if (revision !== undefined && (revision === this.revision || revision === this.reported)) return;
    this.report(revision);
  }

  private report(revision: string | null | undefined) {
    this.reported = revision;
    for (const listener of [...this.listeners]) listener(revision === undefined ? {} : { revision });
  }

  async close() {
    this.unwatch();
    this.listeners.clear();
    const table = this.table;
    this.table = null;
    this.queries.clear();
    this.aliases.clear();
    if (!table) return;
    try {
      await this.post({ op: "close", table });
    } catch {
      // The server may already have forgotten the table.
    }
  }
}
