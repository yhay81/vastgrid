import { ErrorCodes, type InfoResult, type ProtocolRequest } from "./protocol.js";
import { abortError, isEmptyQuery, SourceError, type TableSource } from "./source.js";
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
      this.queries.set(created.id, { query, preview });
      this.aliases.set(created.id, created.id);
    }
    return created;
  }

  /** The view's state on the server. A view the server forgot is created again under the same id. */
  async viewInfo(view: string, signal?: AbortSignal): Promise<ViewInfo> {
    const result = await this.call<ViewInfo>("status", { view } satisfies Operation<"status">, signal);
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

  async close() {
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
