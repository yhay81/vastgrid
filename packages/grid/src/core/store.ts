import {
  applyCommand,
  type CheckedPlan,
  type Column,
  type CommandContext,
  CommandError,
  type CommandRequest,
  type CommandResult,
  canonicalJson,
  checkPlan,
  decodeBlock,
  displayedColumns,
  type ErrorCode,
  emptyDocument,
  emptySession,
  type GridCommand,
  type GridDocument,
  type GridSession,
  type JsonValue,
  keyText,
  type LoadedRow,
  type Measure,
  normalizePlan,
  type Operation,
  type Plan,
  PlanError,
  planOptions,
  type RowKey,
  repairDocument,
} from "vastgrid-spec";
import { BLOCK_ROWS, type Read, ViewCache } from "./cache.js";
import { GridClient, type Transport } from "./client.js";
import { valuesPlan } from "./filters.js";
import { measuresPlan, totalMeasures } from "./measures.js";
import { now, track } from "./trace.js";
import {
  type CommandOutcome,
  type FailedWrite,
  GridError,
  type GridSnapshot,
  type InitialView,
  type OpenOptions,
  type RowsResult,
  type TableInfo,
  type ViewInfo,
  type WriteUpdate,
} from "./types.js";

/** Bytes of rows that a store keeps for the view on screen, by default. */
export const CACHE_BYTES = 64 * 1024 * 1024;

/** Failures of a write that the same write may not meet when it is sent again. */
const RETRIED = new Set<ErrorCode>(["internal", "cancelled", "not_ready", "table_not_found"]);

export interface GridStoreOptions {
  /** Where the engine is. */
  transport: Transport;
  /** The `ref` of the table to open (§8.2). */
  table: string;
  /** The `read` options of `open`. */
  open?: OpenOptions;
  /** The document to start with (§5.1); the empty document by default. */
  document?: GridDocument;
  /** The session to start with (§5.2). */
  session?: GridSession;
  /** Rows read on a server, shown before the first read (§7 of v2-react.md). */
  initial?: InitialView;
  /** Bytes of rows to keep (`CACHE_BYTES` by default). */
  cacheBytes?: number;
}

export interface DispatchOptions {
  /** What `edit.paste` pastes. */
  clipboard?: { text?: string; html?: string };
}

/** Where the canvas is: its first row, how many rows it shows and the columns it draws. */
export interface Viewport {
  top: number;
  rows: number;
  columns: readonly string[];
}

/** A view of the document's plan, being read or on screen. */
interface View {
  readonly key: string;
  readonly plan: Plan;
  readonly checked: CheckedPlan;
  /** The table's revision and edits version that the view's rows belong to. */
  readonly revision: string | null;
  readonly edits: number;
  info: ViewInfo | null;
  readonly cache: ViewCache;
  readonly abort: AbortController;
}

type Part = "document" | "session";

/** A command applied, or why it was not. */
type Applied =
  | { kind: "applied"; result: CommandResult; table: TableInfo }
  | { kind: "failed"; error: CommandError | GridError; view: View | null };

interface Events {
  document: GridDocument;
  session: GridSession;
  error: GridError;
}

function isCancelled(error: unknown) {
  return error instanceof GridError && error.code === "cancelled";
}

function asGridError(error: unknown): GridError {
  if (error instanceof GridError) return error;
  if (error instanceof PlanError) {
    return new GridError("invalid_plan", error.message, { reason: error.reason, path: error.path });
  }
  return new GridError("internal", error instanceof Error ? error.message : String(error));
}

function planKey(plan: Plan): string {
  return canonicalJson(normalizePlan(plan));
}

/** Whether two lists of columns have the same names and types. */
function sameColumns(a: readonly Column[], b: readonly Column[]) {
  return a.length === b.length && a.every((column, index) => canonicalJson(column) === canonicalJson(b[index]));
}

/**
 * The grid without a screen (§4 of v2-react.md): the state of the specification as immutable snapshots, the
 * commands that change it, and the rows of the view on screen, read through a transport. Making a store has
 * no side effects; `connect` opens the table and starts reading.
 */
export class GridStore {
  private snapshot: GridSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly rowListeners = new Set<() => void>();
  private readonly events: { [K in keyof Events]: Set<(value: Events[K]) => void> } = {
    document: new Set(),
    session: new Set(),
    error: new Set(),
  };
  private readonly controlled = { document: false, session: false };
  /** What a command made of a controlled part, until the host passes it back (§5.2 of v2-react.md). */
  private readonly proposed: { document?: GridDocument; session?: GridSession } = {};
  private client: GridClient | null = null;
  /** Counts connections, so that answers to an earlier one are dropped. */
  private connection = 0;
  /** Whether the table is open for the current connection. */
  private opened = false;
  private current: View | null = null;
  private next: View | null = null;
  private viewport: Viewport = { top: 0, rows: 0, columns: [] };
  /**
   * Values of writes (§7.2) that the rows read do not hold yet, by the key text of their row and by column, with
   * the write that gave them: the grid shows them at once, and drops them when the write fails or once the view
   * of its edits version is on screen.
   */
  private readonly written = new Map<string, Map<string, { value: JsonValue; write: number }>>();
  private writes = 0;
  /** The edits version that each write that succeeded made. */
  private readonly writeVersions = new Map<number, number>();
  /** Settles once the writes sent so far are answered and their steps are in the history. */
  private writing: Promise<void> = Promise.resolve();
  private readScheduled = false;
  private totalsKey = "";
  private totalsAbort: AbortController | null = null;
  private rowsVersion = 0;
  private readonly budget: number;

  constructor(private readonly options: GridStoreOptions) {
    this.budget = options.cacheBytes ?? CACHE_BYTES;
    this.snapshot = {
      document: options.document ?? emptyDocument(),
      session: options.session ?? emptySession(),
      table: null,
      view: null,
      displayed: [],
      pending: null,
      status: "idle",
      error: null,
      failedWrite: null,
      totals: null,
    };
    if (options.initial) this.seed(options.initial);
  }

  // ----- reading the state -----

  getSnapshot = (): GridSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follows changes of the document or the session (reported also when they are controlled), and errors. */
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    const set = this.events[event] as Set<(value: Events[K]) => void>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const listener of this.events[event] as Set<(value: Events[K]) => void>) listener(value);
  }

  private publish(changes: Partial<{ -readonly [K in keyof GridSnapshot]: GridSnapshot[K] }>) {
    const previous = this.snapshot;
    const next = { ...previous, ...changes };
    if (next.view && previous.view && sameColumns(next.view.columns, previous.view.columns)) {
      // Views read again keep their columns' identity, which displayed columns and commands key on.
      if (next.view.columns !== previous.view.columns) next.view = { ...next.view, columns: previous.view.columns };
    }
    const keep = next.document.columns === previous.document.columns && next.view?.columns === previous.view?.columns;
    next.displayed = keep ? previous.displayed : this.displayedOf(next);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
    this.followTotals();
  }

  /** Reads the totals row again when the view on screen, its edits or the totals change. */
  private followTotals() {
    const view = this.current;
    const measures = totalMeasures(this.snapshot.displayed);
    // A view that is being made is totalled once it is ready.
    if (view && measures.length > 0 && this.snapshot.view?.status !== "ready") return;
    const plan = view && measures.length > 0 ? measuresPlan(view.plan, measures) : null;
    const key = view && plan ? `${view.revision}\u0000${view.edits}\u0000${canonicalJson(plan)}` : "";
    if (key === this.totalsKey) return;
    this.totalsKey = key;
    this.totalsAbort?.abort();
    this.totalsAbort = null;
    if (!view || !plan) {
      if (this.snapshot.totals) this.publish({ totals: null });
      return;
    }
    const abort = new AbortController();
    this.totalsAbort = abort;
    // The totals on screen stay until the new ones come.
    this.measure(plan, view.revision, abort.signal)
      .then((totals) => {
        if (!abort.signal.aborted) this.publish({ totals });
      })
      .catch(() => {});
  }

  /** Reads the one row of a plan that aggregates without keys: its values and their types, by column name. */
  private async measure(plan: Plan, revision: string | null, signal?: AbortSignal) {
    const table = this.snapshot.table;
    const client = this.client;
    if (!table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    const names = plan.aggregate?.measures.map((measure) => measure.name) ?? [];
    const result = await client.request<RowsResult>(
      "rows",
      { table: table.table, revision, plan, start: 0, end: 1, columns: names },
      signal,
    );
    const block = decodeBlock(result.block.bytes);
    const values: Record<string, JsonValue> = {};
    const columns: Record<string, Column> = {};
    block.columns.forEach((column, index) => {
      values[column.name] = block.rows[0]?.[index] ?? null;
      columns[column.name] = column;
    });
    return { values, columns };
  }

  /**
   * Measures (§4.5) over the rows of the document's plan, for the column statistics: an `aggregate` without keys
   * (`measuresPlan`). Fails for a plan that groups rows.
   */
  async aggregate(
    measures: Measure[],
    signal?: AbortSignal,
  ): Promise<{ values: Record<string, JsonValue>; columns: Record<string, Column> }> {
    const plan = measuresPlan(this.base("document").plan ?? {}, measures);
    if (!plan) throw new GridError("invalid_plan", "The measures of a grouped view are not read.");
    return this.measure(plan, this.current?.revision ?? this.snapshot.table?.revision ?? null, signal);
  }

  private displayedOf(snapshot: GridSnapshot) {
    return snapshot.view ? displayedColumns(snapshot.document, snapshot.view.columns) : [];
  }

  /** The state that commands apply to: what was proposed for controlled parts, or what is shown. */
  private base<P extends Part>(part: P): GridSnapshot[P] {
    return (this.proposed[part] ?? this.snapshot[part]) as GridSnapshot[P];
  }

  // ----- rows -----

  /** The value of a cell of the view on screen; undefined while it is not read. */
  cell(row: number, column: string): JsonValue | undefined {
    const view = this.current;
    const value = view?.cache.value(row, column);
    if (!view || this.written.size === 0) return value;
    const key = view.cache.loaded(row, this.base("document").rowKey)?.key;
    const entry = key === undefined ? undefined : this.written.get(keyText(key))?.get(column);
    return entry === undefined ? value : entry.value;
  }

  /** Whether the engine cut a cell's value to the text limit (§8.4). */
  isCut(row: number, column: string) {
    return this.current?.cache.isCut(row, column) ?? false;
  }

  /** The key of a row of the view on screen (§5.3); undefined while it is not read. */
  rowKey(row: number): RowKey | undefined {
    return this.current?.cache.loaded(row, this.base("document").rowKey)?.key;
  }

  /** The row ID of a row of the view on screen. */
  rowId(row: number) {
    return this.current?.cache.rowId(row);
  }

  /** Changes whenever rows of the view on screen arrive or leave. */
  getRowsVersion = (): number => this.rowsVersion;

  /** Follows the arrival of rows (the snapshot does not change when rows arrive). */
  subscribeRows = (listener: () => void): (() => void) => {
    this.rowListeners.add(listener);
    return () => {
      this.rowListeners.delete(listener);
    };
  };

  private emitRows() {
    this.rowsVersion++;
    for (const listener of this.rowListeners) listener();
  }

  /** Tells the store what the canvas shows, so that it reads those rows and a page around them. */
  setViewport(viewport: Viewport) {
    const before = this.viewport;
    if (
      before.top === viewport.top &&
      before.rows === viewport.rows &&
      before.columns.length === viewport.columns.length &&
      before.columns.every((column, index) => column === viewport.columns[index])
    ) {
      return;
    }
    this.viewport = viewport;
    this.scheduleReads();
  }

  /** Reads rows `[start, end)` of `columns` of the view on screen if they are not read, for cells React renders. */
  ensure(start: number, end: number, columns: readonly string[]) {
    const view = this.current;
    if (!view?.info || !this.opened || this.next || view.abort.signal.aborted) return;
    for (const read of view.cache.reads(start, end, this.withKey(columns), view.info.rowCount)) {
      void this.read(view, read).catch(() => {});
    }
  }

  private scheduleReads() {
    if (this.readScheduled) return;
    this.readScheduled = true;
    queueMicrotask(() => {
      this.readScheduled = false;
      this.readVisible();
    });
  }

  /** The columns to read: those asked for, and the row key column (§5.3), which commands need. */
  private withKey(columns: readonly string[]): string[] {
    const key = this.base("document").rowKey;
    const view = this.current?.info?.columns ?? [];
    if (key === undefined || columns.includes(key) || !view.some((column) => column.name === key)) {
      return [...columns];
    }
    return [...columns, key];
  }

  private readVisible() {
    const view = this.current;
    if (!view?.info || !this.opened || this.next || view.abort.signal.aborted) return;
    const { top, rows, columns } = this.viewport;
    if (columns.length === 0) return;
    const margin = Math.max(rows, 32);
    const start = Math.max(0, top - margin);
    const readable = view.info.status === "building" ? view.info.readableRows : view.info.rowCount;
    const end = Math.min(readable, top + rows + margin);
    view.cache.touch(top, top + rows);
    for (const read of view.cache.reads(start, end, this.withKey(columns), readable)) {
      void this.read(view, read).catch(() => {});
    }
    view.cache.evict(this.budget, start, end);
  }

  /** Reads rows of a view into its cache. */
  private async read(view: View, read: Read): Promise<void> {
    const client = this.client;
    const table = this.snapshot.table;
    if (!client || !table) return;
    view.cache.reading(read, true);
    try {
      const result = await client.request<RowsResult>(
        "rows",
        {
          table: table.table,
          revision: view.revision,
          plan: view.plan,
          start: read.start,
          end: read.end,
          columns: read.columns,
          // A keyed selection needs locate on the complete view before its position can change.
          ...(!view.info && table.capabilities.preview && !this.base("session").active?.key ? { preview: true } : {}),
        },
        view.abort.signal,
      );
      if (view !== this.current && view !== this.next) return;
      const block = decodeBlock(result.block.bytes);
      view.cache.receive(
        result.start,
        result.rowIds,
        block.columns.map((column) => column.name),
        block.rows,
        result.truncated,
      );
      const info = result.view;
      view.cache.reading(read, false);
      // A ready event can arrive before the response containing the preview.
      if (
        !(view.info?.status === "ready" && info.status === "building") &&
        (!view.info ||
          view.info.rowCount !== info.rowCount ||
          view.info.status !== info.status ||
          view.info.readableRows !== info.readableRows)
      ) {
        view.info =
          view.info && sameColumns(view.info.columns, info.columns) ? { ...info, columns: view.info.columns } : info;
        if (view === this.current) this.publish({ view: view.info });
      }
      if (view === this.current) this.emitRows();
    } catch (error) {
      view.cache.reading(read, false);
      if (!isCancelled(error) && (view === this.current || view === this.next)) this.fail(asGridError(error));
      throw error;
    }
  }

  // ----- connecting -----

  /**
   * Opens the table, follows its events and reads the view of the document's plan. Gives the function that
   * undoes all of it; connecting again afterwards works (Strict Mode does it, §4.3 of v2-react.md).
   */
  connect(): () => void {
    const connection = ++this.connection;
    const client = new GridClient(this.options.transport);
    this.client = client;
    this.opened = false;
    const stopEvents = client.subscribe((event) => this.onEvent(event, connection));
    if (this.snapshot.status === "idle" || this.snapshot.status === "error") this.publish({ status: "opening" });
    let tableId: string | null = null;
    let connected = true;
    const close = (id: string) => void client.request("close", { table: id }).catch(() => {});
    void (async () => {
      try {
        // Not cancelled: an engine may open the table all the same, which is then closed.
        const info = await client.request<TableInfo>("open", {
          ref: this.options.table,
          ...(this.options.open ? { read: this.options.open } : {}),
        });
        if (!connected) {
          close(info.table);
          return;
        }
        tableId = info.table;
        this.opened = true;
        this.opening(info);
      } catch (error) {
        if (connected && !isCancelled(error)) {
          this.publish({ status: "error" });
          this.fail(asGridError(error));
        }
      }
    })();
    return () => {
      if (!connected) return;
      connected = false;
      stopEvents();
      if (tableId !== null) close(tableId);
      if (connection !== this.connection) return;
      this.connection++;
      this.opened = false;
      this.current?.abort.abort();
      this.next?.abort.abort();
      this.next = null;
      if (this.current) this.current = { ...this.current, abort: new AbortController() };
      this.client = null;
    };
  }

  /** The table is open: repairs the document for it and reads the view (§5.5). */
  private opening(info: TableInfo) {
    const document = this.base("document");
    const repaired = repairDocument(document, info.columns, planOptions(info.capabilities));
    const seeded = this.current;
    // Rows read on a server stay when they belong to the same revision and plan.
    if (seeded && (seeded.revision !== info.revision || seeded.edits !== info.edits.version)) this.current = null;
    else if (seeded) this.current = { ...seeded, abort: new AbortController() };
    this.publish({ table: info, status: info.status === "error" ? "error" : "ready" });
    if (repaired.removed.length > 0) this.change(repaired.document, this.base("session"));
    this.showPlan(this.base("document").plan ?? {});
    this.scheduleReads();
  }

  private onEvent(event: Record<string, unknown>, connection: number) {
    if (connection !== this.connection) return;
    const table = this.snapshot.table;
    if (!table || event.table !== table.table) return;
    if (event.event === "changed") {
      const revision = event.revision as string | null;
      const edits = event.edits as TableInfo["edits"];
      const fileChanged = event.fileChanged === true;
      if (revision === table.revision) {
        if (edits.version === table.edits.version && fileChanged === (table.fileChanged === true)) return;
        const { fileChanged: _, ...rest } = table;
        this.publish({ table: fileChanged ? { ...rest, edits, fileChanged } : { ...rest, edits } });
        this.showPlan(this.base("document").plan ?? {});
        return;
      }
      // Another revision may have other columns: the table is read again, then the view (§5.4).
      const client = this.client;
      void client
        ?.request<TableInfo>("info", { table: table.table })
        .then((info) => {
          if (connection === this.connection) this.adopt(info);
        })
        .catch((error: unknown) => {
          if (connection === this.connection && !isCancelled(error)) this.fail(asGridError(error));
        });
    } else if (event.event === "progress") {
      this.publish({
        table: {
          ...table,
          status: event.status as TableInfo["status"],
          progress: event.progress as number | null,
          readableRows: event.readableRows as number,
          rowCount: event.rowCount as number | null,
        },
      });
      if (event.status === "ready") this.showPlan(this.base("document").plan ?? {});
      // A view still being made reads its rows again once the table is read, also without `view` events (§9).
      const view = this.current;
      if (event.status === "ready" && view?.info && view.info.status !== "ready") {
        const columns = this.withKeyFor(view, this.viewport.columns);
        void this.read(view, this.around(this.viewport.top, null, columns)).then(
          () => this.scheduleReads(),
          () => {},
        );
      }
    } else if (event.event === "view") {
      const view = [this.next, this.current].find(
        (item) => item?.info?.hash === event.hash && item?.revision === table.revision,
      );
      if (view?.info) {
        view.info = {
          ...view.info,
          status: event.status as ViewInfo["status"],
          readableRows: event.readableRows as number,
          rowCount: event.rowCount as number,
          rowCountExact: event.rowCountExact as boolean,
        };
        if (view === this.current) this.publish({ view: view.info });
        this.scheduleReads();
      }
    }
  }

  private fail(error: GridError) {
    this.publish({ error });
    this.emit("error", error);
  }

  /** Shows rows read on a server before the table is open. */
  private seed(initial: InitialView) {
    const { table, plan, rows } = initial;
    if (planKey(plan) !== planKey(this.snapshot.document.plan ?? {})) return;
    try {
      const view: View = {
        key: planKey(plan),
        plan,
        checked: checkPlan(plan, table.columns, planOptions(table.capabilities)),
        revision: table.revision,
        edits: rows.view.edits.version,
        info: rows.view,
        cache: new ViewCache(),
        abort: new AbortController(),
      };
      const block = decodeBlock(rows.block.bytes);
      view.cache.receive(
        rows.start,
        rows.rowIds,
        block.columns.map((column) => column.name),
        block.rows,
        rows.truncated,
      );
      this.current = view;
      this.snapshot = { ...this.snapshot, table, view: rows.view };
      this.snapshot = { ...this.snapshot, displayed: this.displayedOf(this.snapshot) };
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
    }
  }

  // ----- views -----

  /**
   * Reads the view of a plan while the view on screen stays, and shows it when its first rows arrive, with the
   * session moved by `view.update` (§5.4; §4.2 of v2-react.md).
   */
  private showPlan(plan: Plan) {
    const table = this.snapshot.table;
    if (!table || !this.client || !this.opened) return;
    const key = planKey(plan);
    if (table.status === "loading" && !table.capabilities.partialViews && key !== planKey({})) {
      this.next?.abort.abort();
      this.next = null;
      this.publish({ pending: { plan } });
      return;
    }
    const fresh = (view: View | null) =>
      view !== null &&
      !view.abort.signal.aborted &&
      view.key === key &&
      view.revision === table.revision &&
      view.edits === table.edits.version;
    if (this.next && !fresh(this.next)) {
      this.next.abort.abort();
      this.next = null;
    }
    if (fresh(this.current)) {
      if (this.snapshot.pending) this.publish({ pending: null });
      return;
    }
    if (this.next) return;
    if (this.current?.info?.status === "building") this.current.abort.abort();
    let checked: CheckedPlan;
    try {
      checked = checkPlan(plan, table.columns, planOptions(table.capabilities));
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      if (this.snapshot.pending) this.publish({ pending: null });
      this.fail(asGridError(error));
      return;
    }
    const view: View = {
      key,
      plan,
      checked,
      revision: table.revision,
      edits: table.edits.version,
      info: null,
      cache: new ViewCache(),
      abort: new AbortController(),
    };
    this.next = view;
    if (this.current) this.publish({ pending: { plan } });
    void this.prepare(view, this.connection);
  }

  private live(view: View, connection: number) {
    return connection === this.connection && view === this.next;
  }

  /** The rows from `row` for a viewport, in whole blocks. */
  private around(row: number, rowCount: number | null, columns: readonly string[]): Read {
    const start = Math.floor(row / BLOCK_ROWS) * BLOCK_ROWS;
    const rows = Math.max(this.viewport.rows, 1);
    let end = Math.ceil((row + rows) / BLOCK_ROWS) * BLOCK_ROWS;
    if (rowCount !== null) end = Math.min(end, Math.max(rowCount, start + 1));
    return { start, end: Math.max(end, start + 1), columns: [...columns] };
  }

  private async prepare(view: View, connection: number) {
    const table = this.snapshot.table as TableInfo;
    const client = this.client as GridClient;
    const columns = this.withKeyFor(view, this.viewport.columns);
    try {
      const top = this.current ? this.viewport.top : (this.base("session").scroll?.row ?? 0);
      await this.read(view, this.around(top, null, columns));
      if (!this.live(view, connection) || !view.info) return;
      let info: ViewInfo = view.info;
      if (top >= info.rowCount && info.rowCount > 0) {
        await this.read(view, this.around(info.rowCount - 1, info.rowCount, columns));
        if (!this.live(view, connection) || !view.info) return;
        info = view.info;
      }
      // The session as it is now: the person may have moved while the rows were read.
      const session = this.base("session");
      const document = this.base("document");
      const key = session.active?.key;
      const located: { key: RowKey; row: number | null }[] = [];
      if (key && session.view !== info.hash && table.capabilities.locate) {
        const result = await client.request<{ rows: (number | null)[] }>(
          "locate",
          {
            table: table.table,
            revision: view.revision,
            plan: view.plan,
            keys: [key],
            ...(document.rowKey === undefined ? {} : { rowKey: document.rowKey }),
          },
          view.abort.signal,
        );
        if (!this.live(view, connection)) return;
        located.push({ key, row: result.rows[0] ?? null });
      }
      const state = { document: this.base("document"), session: this.base("session") };
      const updated = applyCommand(
        state,
        { command: "view.update", hash: info.hash, located },
        this.contextFor(view, table, info),
      );
      const scroll = updated.session.scroll;
      const target = scroll && scroll !== state.session.scroll ? scroll.row : Math.min(top, info.rowCount - 1);
      if (
        info.status === "ready" &&
        target >= 0 &&
        view.cache.value(target, columns[0] ?? "") === undefined &&
        columns.length > 0
      ) {
        await this.read(view, this.around(target, info.rowCount, columns));
        if (!this.live(view, connection)) return;
      }
      const previous = this.current;
      previous?.abort.abort();
      this.current = view;
      this.next = null;
      // The rows, the view and the session's new positions are shown in one step.
      // A view that comes on screen ends the failure of the one before (a pivot with too many columns).
      this.change(updated.document, updated.session, { view: view.info ?? info, pending: null, error: null });
      // The snapshot keeps the columns of the view before when they are the same, for commands to key on.
      view.info = this.snapshot.view;
      // Values of writes that the new rows hold are no longer needed.
      this.dropWritten((write) => (this.writeVersions.get(write) ?? Number.POSITIVE_INFINITY) <= view.edits);
      this.emitRows();
      this.scheduleReads();
      // A normal read waits for completion, also when there is no event channel or the ready event raced
      // the preview. It reports a failed build and is cancelled when the plan or connection changes.
      if (view.info?.status === "building" && table.status === "ready") {
        void this.read(view, this.around(Math.max(0, target), null, columns)).then(
          () => this.scheduleReads(),
          () => {},
        );
      }
    } catch (error) {
      if (view === this.next) {
        this.next = null;
        if (this.snapshot.pending) this.publish({ pending: null });
      }
      if (connection === this.connection && !isCancelled(error)) this.fail(asGridError(error));
    }
  }

  private withKeyFor(view: View, columns: readonly string[]): string[] {
    const names = new Set(view.checked.columns.map((column) => column.name));
    const wanted = columns.filter((column) => names.has(column));
    const key = this.base("document").rowKey;
    if (key !== undefined && names.has(key) && !wanted.includes(key)) wanted.push(key);
    if (wanted.length === 0 && view.checked.columns.length > 0) wanted.push(view.checked.columns[0].name);
    return wanted;
  }

  private contextFor(view: View, table: TableInfo, info: ViewInfo | null = view.info): CommandContext {
    const rowKey = this.base("document").rowKey;
    return {
      table: table.columns,
      revision: view.revision,
      view: {
        columns: info?.columns ?? view.checked.columns,
        rowCount: info?.rowCount ?? 0,
        rowIds: view.checked.rowIds,
      },
      lookup: (row) => this.withWritten(view.cache.loaded(row, rowKey)),
      page: Math.max(1, this.viewport.rows - 1),
      capabilities: table.capabilities,
    };
  }

  // ----- changing the state -----

  /** A row as commands read it, with the values of writes that its rows do not hold yet. */
  private withWritten(row: LoadedRow | undefined): LoadedRow | undefined {
    if (!row?.key || this.written.size === 0) return row;
    const values = this.written.get(keyText(row.key));
    if (!values) return row;
    return {
      key: row.key,
      has: (column) => values.has(column) || row.has(column),
      get: (column) => {
        const entry = values.get(column);
        return entry === undefined ? row.get(column) : entry.value;
      },
    };
  }

  /** Shows the values of a write until it is answered (§7.2). */
  private markWritten(write: number, updates: readonly { key: RowKey; column: string; value: JsonValue }[]) {
    for (const update of updates) {
      const text = keyText(update.key);
      let values = this.written.get(text);
      if (!values) {
        values = new Map();
        this.written.set(text, values);
      }
      values.set(update.column, { value: update.value, write });
    }
    this.emitRows();
  }

  /** Forgets the values of writes: one that failed, or those that the rows on screen now hold. */
  private dropWritten(done: (write: number) => boolean) {
    let dropped = false;
    for (const [text, values] of this.written) {
      for (const [column, entry] of values) {
        if (!done(entry.write)) continue;
        values.delete(column);
        dropped = true;
      }
      if (values.size === 0) this.written.delete(text);
    }
    if (dropped) this.emitRows();
  }

  /** Makes a part controlled: commands report what they make of it, and only `setDocument`/`setSession` show it. */
  control(part: Part, controlled: boolean) {
    this.controlled[part] = controlled;
    if (!controlled) delete this.proposed[part];
  }

  /** Shows a document given by the host (a controlled prop, a saved view, an agent). */
  setDocument(document: GridDocument) {
    delete this.proposed.document;
    const previous = this.snapshot.document;
    if (document === previous) return;
    this.publish({ document });
    if (document.plan !== previous.plan) this.showPlan(document.plan ?? {});
    this.scheduleReads();
  }

  /** Shows a session given by the host. */
  setSession(session: GridSession) {
    delete this.proposed.session;
    if (session === this.snapshot.session) return;
    this.publish({ session });
  }

  /**
   * Applies a new state from a command: shows what is not controlled, with `extra` members of the snapshot in the
   * same step, and reports both parts that changed.
   */
  private change(
    document: GridDocument,
    session: GridSession,
    extra: Partial<{ -readonly [K in keyof GridSnapshot]: GridSnapshot[K] }> = {},
  ) {
    const shown: Partial<{ -readonly [K in keyof GridSnapshot]: GridSnapshot[K] }> = { ...extra };
    const previous = this.snapshot.document;
    const reports: (["document", GridDocument] | ["session", GridSession])[] = [];
    if (document !== this.base("document")) {
      if (this.controlled.document) this.proposed.document = document;
      else shown.document = document;
      reports.push(["document", document]);
    }
    if (session !== this.base("session")) {
      if (this.controlled.session) this.proposed.session = session;
      else shown.session = session;
      reports.push(["session", session]);
    }
    if (Object.keys(shown).length > 0) this.publish(shown);
    for (const [part, value] of reports) {
      if (part === "document") this.emit("document", value);
      else this.emit("session", value);
    }
    if (shown.document && shown.document.plan !== previous.plan) this.showPlan(shown.document.plan ?? {});
  }

  /** Applies a command now, or tells why it cannot be applied (rows to read first included). */
  private applyNow(command: GridCommand, options: DispatchOptions): Applied {
    const view = this.current;
    const table = this.snapshot.table;
    if (!view?.info || !table) {
      return { kind: "failed", error: new GridError("not_ready", "The table is not open yet."), view: null };
    }
    const context = this.contextFor(view, table);
    if (options.clipboard) context.clipboard = options.clipboard;
    const started = now();
    try {
      const result = applyCommand({ document: this.base("document"), session: this.base("session") }, command, context);
      track(command.command, started, "commands");
      this.change(result.document, result.session);
      return { kind: "applied", result, table };
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      track(command.command, started, "commands", "error");
      return { kind: "failed", error, view };
    }
  }

  /**
   * Applies a command (§4.2 of v2-react.md). The state changes at once when the command has what it needs;
   * a command that needs rows that are not read reads them first. Resolves once the command's requests are
   * answered, and never rejects. The same function for the life of the store.
   */
  readonly dispatch = async (command: GridCommand, options: DispatchOptions = {}): Promise<CommandOutcome> => {
    // The state never shares objects with a command that its caller may change later.
    const given = structuredClone(command);
    // An undo or a redo takes the last step once the writes sent before it are in the history.
    if (given.command === "history.undo" || given.command === "history.redo") await this.writing;
    let applied = this.applyNow(given, options);
    for (
      let tries = 0;
      tries < 3 &&
      applied.kind === "failed" &&
      applied.view &&
      applied.error instanceof CommandError &&
      applied.error.reason === "not_loaded" &&
      applied.error.details;
      tries++
    ) {
      const view = applied.view;
      try {
        await this.load(view, applied.error.details as { rows: [number, number][]; columns: string[] });
      } catch (failure) {
        // A view that another replaced while its rows were read (a write, or the file read again) is cancelled:
        // the command applies to the new one.
        if (!isCancelled(failure) || view === this.current) return { ok: false, error: asGridError(failure) };
      }
      applied = this.applyNow(given, options);
    }
    if (applied.kind === "failed") return { ok: false, error: applied.error };
    try {
      const output = await this.send(given.command, applied.result.requests, applied.table);
      const value = output ?? applied.result.output;
      return value === undefined ? { ok: true } : { ok: true, output: value };
    } catch (error) {
      return { ok: false, error: asGridError(error) };
    }
  };

  /**
   * Applies a command synchronously, as a `copy` event needs (its clipboard is written before the handler
   * returns). A command that needs rows that are not read fails with `not_loaded`; its requests are sent.
   */
  dispatchSync(command: GridCommand, options: DispatchOptions = {}): CommandOutcome {
    const given = structuredClone(command);
    const applied = this.applyNow(given, options);
    if (applied.kind === "failed") return { ok: false, error: applied.error };
    if (applied.result.requests.length > 0) {
      void this.send(given.command, applied.result.requests, applied.table).catch((error: unknown) => {
        this.fail(asGridError(error));
      });
    }
    return applied.result.output === undefined ? { ok: true } : { ok: true, output: applied.result.output };
  }

  /**
   * Sends the failed write again (§6.6 of v2-react.md): the same updates, or after an `edit_conflict` without their
   * `previous`, so that they write over what the cells hold now. It succeeds as its command would have: the history
   * gets its step, or an undo or a redo whose step is still the last moves it. Resolves as `dispatch` does.
   */
  readonly retryWrite = async (): Promise<CommandOutcome> => {
    const failed = this.snapshot.failedWrite;
    const table = this.snapshot.table;
    if (!failed) return { ok: false, error: new GridError("invalid_request", "No write failed.") };
    if (failed.retry === null || !table || table.revision !== failed.revision) {
      return { ok: false, error: new GridError("revision_changed", "The write cannot be sent again.") };
    }
    this.publish({ failedWrite: null });
    const request: CommandRequest = { op: "write", revision: failed.revision, updates: failed.updates };
    if (failed.rowKey !== undefined) request.rowKey = failed.rowKey;
    const command = this.stillLast(failed) ? failed.command : "write";
    try {
      await this.send(command, [request], table, failed.retry === "overwrite");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asGridError(error) };
    }
  };

  /** Forgets the failed write: its cells show what the engine holds. */
  discardWrite() {
    if (this.snapshot.failedWrite) this.publish({ failedWrite: null });
  }

  /** Keeps a write that failed, for `retryWrite` and `discardWrite`. */
  private failWrite(command: string, request: CommandRequest, error: GridError) {
    const failed: FailedWrite = {
      command,
      updates: request.updates as WriteUpdate[],
      revision: (request.revision as string | null | undefined) ?? null,
      ...(request.rowKey === undefined ? {} : { rowKey: request.rowKey as string | string[] }),
      error,
      retry: error.code === "edit_conflict" ? "overwrite" : RETRIED.has(error.code) ? "retry" : null,
    };
    this.publish({ failedWrite: failed });
  }

  /** Whether a failed undo or redo has its step still last in its list, where its write then moves it from. */
  private stillLast(failed: FailedWrite) {
    const list = failed.command === "history.undo" ? "undo" : failed.command === "history.redo" ? "redo" : null;
    if (!list) return true;
    const step = this.base("session").history?.[list].at(-1);
    if (!step) return false;
    const written = step.updates.map((update) => ({
      key: update.key,
      column: update.column,
      value: list === "undo" ? update.before : update.after,
      previous: list === "undo" ? update.after : update.before,
    }));
    const sent = failed.updates.map(({ key, column, value, previous }) => ({ key, column, value, previous }));
    return canonicalJson(written) === canonicalJson(sent);
  }

  /** Where the file of an `export` without a target can be downloaded (`Transport.exportUrl`), or null. */
  exportUrl(target: string): string | null {
    return this.options.transport.exportUrl?.(target) ?? null;
  }

  /**
   * Reads the table's file as it is now (`reload`, §7.6), without the cells written into the table as it was read:
   * for a file that changed on disk while the table had written cells (`fileChanged` of the table).
   */
  async reload(): Promise<void> {
    const table = this.snapshot.table;
    const client = this.client;
    const connection = this.connection;
    if (!table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    const info = await client.request<TableInfo>("reload", { table: table.table });
    if (connection === this.connection) this.adopt(info);
  }

  /** Another revision of the table (§5.4): the document is repaired for its columns (§5.5), and the view read. */
  private adopt(info: TableInfo) {
    const current = this.snapshot.table;
    if (
      current &&
      current.revision === info.revision &&
      current.edits.version === info.edits.version &&
      current.fileChanged === info.fileChanged &&
      current.status === info.status
    ) {
      return;
    }
    const repaired = repairDocument(this.base("document"), info.columns, planOptions(info.capabilities));
    this.publish({ table: info, status: info.status === "error" ? "error" : "ready" });
    if (repaired.removed.length > 0) this.change(repaired.document, this.base("session"));
    this.showPlan(this.base("document").plan ?? {});
    this.scheduleReads();
  }

  /** Counts and sums the cells of ranges of the view on screen (`summarize`, §8.2). */
  async summarize(
    ranges: [number, number][],
    columns: string[],
    signal?: AbortSignal,
  ): Promise<{ count: number; numericCount: number; sum: unknown; min: unknown; max: unknown; average: unknown }> {
    const view = this.current;
    const table = this.snapshot.table;
    const client = this.client;
    if (!view || !table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    return client.request(
      "summarize",
      { table: table.table, revision: view.revision, plan: view.plan, ranges, columns },
      signal,
    );
  }

  /**
   * The values of a column with how many rows have each, the most common first, for the column menu's list: the
   * rows of the document's plan without the column's own conditions, and those whose text contains `search`
   * (`valuesPlan`). At most `limit` of them; `truncated` when there are more.
   */
  async values(
    column: string,
    { search = "", limit = 1_000 }: { search?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ values: { value: JsonValue; count: number }[]; truncated: boolean }> {
    const table = this.snapshot.table;
    const client = this.client;
    if (!table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    const made = valuesPlan(this.base("document").plan ?? {}, column, search);
    if (!made) throw new GridError("invalid_plan", "The values of a grouped view are not listed.");
    const result = await client.request<RowsResult>(
      "rows",
      {
        table: table.table,
        revision: this.current?.revision ?? table.revision,
        plan: made.plan,
        start: 0,
        end: limit + 1,
        columns: [column, made.count],
      },
      signal,
    );
    const rows = decodeBlock(result.block.bytes).rows;
    return {
      values: rows.slice(0, limit).map(([value, count]) => ({ value, count: Number(count) })),
      truncated: rows.length > limit,
    };
  }

  /**
   * Finds the next cell of the view on screen after `from` (before it with `direction` −1) whose text contains
   * `text` (`find`, §8.2), among the displayed columns in display order, wrapping around; null when none does.
   */
  async find(
    text: string,
    {
      from,
      direction = 1,
      caseSensitive = false,
    }: { from: { row: number; column: string }; direction?: 1 | -1; caseSensitive?: boolean },
    signal?: AbortSignal,
  ): Promise<{ row: number; column: string } | null> {
    const view = this.current;
    const table = this.snapshot.table;
    const client = this.client;
    if (!view || !table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    const columns = this.snapshot.displayed.map((item) => item.column.name);
    const column = Math.max(0, columns.indexOf(from.column));
    const found = await client.request<{ row: number; column: number } | null>(
      "find",
      {
        table: table.table,
        revision: view.revision,
        plan: view.plan,
        text,
        columns,
        from: { row: from.row, column },
        direction,
        ...(caseSensitive ? { caseSensitive: true } : {}),
      },
      signal,
    );
    return found ? { row: found.row, column: columns[found.column] } : null;
  }

  /** The whole value of a cell of the view on screen, also when the engine cut its text (§8.4), and its type. */
  async fullValue(row: number, column: string, signal?: AbortSignal): Promise<{ value: JsonValue; column: Column }> {
    const view = this.current;
    const table = this.snapshot.table;
    const client = this.client;
    if (!view || !table || !client || !this.opened) throw new GridError("not_ready", "The table is not open yet.");
    const result = await client.request<RowsResult>(
      "rows",
      {
        table: table.table,
        revision: view.revision,
        plan: view.plan,
        start: row,
        end: row + 1,
        columns: [column],
        textLimit: 1_000_000,
      },
      signal,
    );
    const block = decodeBlock(result.block.bytes);
    return { value: block.rows[0]?.[0] ?? null, column: block.columns[0] };
  }

  /** Reads the rows that a command needs (`not_loaded`, §6.1), in whole blocks. */
  private async load(view: View, details: { rows: [number, number][]; columns: string[] }) {
    const rowCount = view.info?.rowCount ?? 0;
    const columns = this.withKeyFor(view, details.columns);
    const reads: Promise<void>[] = [];
    for (const [start, end] of details.rows) {
      const first = Math.floor(start / BLOCK_ROWS) * BLOCK_ROWS;
      const last = Math.min(rowCount, Math.ceil(end / BLOCK_ROWS) * BLOCK_ROWS);
      for (let at = first; at < last; at += BLOCK_ROWS * 16) {
        reads.push(this.read(view, { start: at, end: Math.min(last, at + BLOCK_ROWS * 16), columns }));
      }
    }
    await Promise.all(reads);
  }

  /** Sends the requests of a command and applies the commands of §6.7 that their answers call for. */
  private async send(name: string, requests: CommandRequest[], table: TableInfo, overwrite = false): Promise<unknown> {
    if (!requests.some((request) => request.op === "write")) return this.sendNow(name, requests, table, overwrite);
    let done = () => {};
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.writing = this.writing.then(() => finished);
    try {
      return await this.sendNow(name, requests, table, overwrite);
    } finally {
      done();
    }
  }

  private async sendNow(name: string, requests: CommandRequest[], table: TableInfo, overwrite: boolean) {
    const client = this.client;
    let output: unknown;
    for (const request of requests) {
      if (!client) throw new GridError("not_ready", "The grid is not connected.");
      const { op, ...members } = request;
      const updates = (op === "write" ? members.updates : []) as WriteUpdate[];
      const write = op === "write" ? ++this.writes : 0;
      if (write) this.markWritten(write, updates);
      // An overwrite checks no `previous`; the history keeps them all the same, as the values the person wrote over.
      const sent = overwrite ? { ...members, updates: updates.map(({ previous: _, ...update }) => update) } : members;
      let result: Record<string, unknown>;
      try {
        result = await client.request<Record<string, unknown>>(op as Operation, { table: table.table, ...sent });
      } catch (error) {
        if (write) {
          this.dropWritten((other) => other === write);
          if (client === this.client) this.failWrite(name, request, asGridError(error));
        }
        throw error;
      }
      if (op === "write") {
        const core =
          name === "history.undo"
            ? { command: "history.undone" as const }
            : name === "history.redo"
              ? { command: "history.redone" as const }
              : {
                  command: "history.push" as const,
                  updates: updates.map((update) => ({
                    key: update.key,
                    column: update.column,
                    before: update.previous ?? null,
                    after: update.value,
                  })),
                };
        const state = { document: this.base("document"), session: this.base("session") };
        const view = this.current;
        if (view) {
          const applied = applyCommand(state, core as GridCommand, this.contextFor(view, table));
          this.change(applied.document, applied.session);
        }
        const edits = result.edits as TableInfo["edits"];
        this.writeVersions.set(write, edits.version);
        // The engine's event may have brought the view of this version on screen before the answer came.
        if (this.current && this.current.edits >= edits.version) this.dropWritten((other) => other === write);
        const current = this.snapshot.table;
        if (current) this.publish({ table: { ...current, edits } });
        this.showPlan(this.base("document").plan ?? {});
      } else {
        output = result;
      }
    }
    return output;
  }
}

/** Makes a store (§4 of v2-react.md). */
export function createGridStore(options: GridStoreOptions): GridStore {
  return new GridStore(options);
}
