/**
 * The grids that an MCP server shows (docs/mcp-app.md): each one a store without a screen (§4 of v2-react.md) on a
 * table of the engine, which the agent reads and changes with commands, and which the Apps that show it follow.
 * An App reads rows through the engine itself (`message`), and keeps its document and session in step with the
 * grid's (`sync`): what the person does reaches the grid, and what the agent does reaches the person.
 */

import {
  GridClient,
  GridError,
  type GridSnapshot,
  GridStore,
  type Handler,
  localTransport,
  RequestIds,
} from "vastgrid/core";
import {
  type CommandError,
  checkDocument,
  checkSession,
  decodeBlock,
  type GridCommand,
  type GridDocument,
  type GridSession,
  type JsonValue,
} from "vastgrid-spec";

type Json = Record<string, unknown>;

/** The engine that the grids read: its requests and its events (§8), as `DuckDBEngine` has them. */
export interface GridEngine extends Handler {
  subscribe(listener: (event: Json) => void): () => void;
}

export interface GridsOptions {
  engine: GridEngine;
  /** Milliseconds that `sync` waits for a change before it answers that there is none. 20 seconds by default. */
  wait?: number;
  /** Grids kept at most; the one used least recently goes first. 16 by default. */
  maxGrids?: number;
  /** Milliseconds after which an App that stopped asking is forgotten and its tables closed. 5 minutes by default. */
  idle?: number;
}

/** Why a tool of the server failed, for the agent or the App: a code of §8.7, `grid_not_found` or `invalid_command`. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Json = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** The commands that only the core applies (§6.7): an agent sending them would break the history and the view. */
const CORE_COMMANDS = new Set(["view.update", "history.push", "history.undone", "history.redone"]);

/** Rows that `rows` reads at most at once, and code points of the strings it gives. */
export const ROWS_LIMIT = 500;
const TEXT_LIMIT = 1000;

/** Milliseconds after which an App that stopped asking is forgotten, with its events and tables. */
const CLIENT_IDLE = 5 * 60_000;

/** Events kept for an App at most, and the members by which a newer event replaces an older one. */
const EVENTS_LIMIT = 256;

function eventKey(event: Json) {
  return `${String(event.event)}\u0000${String(event.table)}\u0000${String(event.hash ?? "")}`;
}

/**
 * An App that shows a grid: the engine under the App's own request ids, the tables it opened through the engine,
 * and the events of those tables.
 */
interface Client {
  readonly engine: Handler;
  readonly tables: Set<string>;
  readonly events: Map<string, Json>;
  lastSeen: number;
  wake: (() => void) | null;
}

/** The state of a grid for an App: its version, the parts changed since the App's version, and events. */
export interface SyncAnswer {
  version: number;
  document?: GridDocument;
  session?: GridSession;
  events: Json[];
}

/** What a tool tells of a grid: its state and what the person sees of it. */
export interface GridState {
  grid: string;
  file: string;
  version: number;
  status: GridSnapshot["status"];
  table: { rowCount: number | null; status: string; edits: number; fileChanged: boolean } | null;
  view: { rowCount: number; rowCountExact: boolean } | null;
  columns: { name: string; type: string; label?: string }[];
  document: GridDocument;
  session: GridSession;
}

export class Grid {
  /** The version of the state, raised by every change of the document or the session. */
  version = 0;
  private readonly changed = {
    document: { version: 0, by: "" },
    session: { version: 0, by: "" },
  };
  private readonly clients = new Map<string, Client>();
  private readonly disconnect: () => void;
  private readonly stopEvents: Array<() => void> = [];
  /** Commands of the agent being applied. */
  private agent = 0;
  lastUsed = Date.now();

  constructor(
    readonly id: string,
    readonly file: string,
    readonly store: GridStore,
    private readonly ids: RequestIds,
    private readonly wait: number,
    private readonly idle = CLIENT_IDLE,
  ) {
    this.disconnect = store.connect();
    // The agent's commands change the state that the Apps then follow. The store also applies commands of its own
    // (§6.7, when it reads a view), as the store of each App does: those are not sent, nor do they win over the
    // person's changes.
    this.stopEvents.push(store.on("document", () => this.bump("document", this.agent > 0 ? "agent" : "")));
    this.stopEvents.push(store.on("session", () => this.bump("session", this.agent > 0 ? "agent" : "")));
  }

  private bump(part: "document" | "session", by: string) {
    if (by === "") return;
    this.version++;
    this.changed[part] = { version: this.version, by };
    this.wakeAll();
  }

  private wakeAll() {
    for (const client of this.clients.values()) client.wake?.();
  }

  private client(id: string): Client {
    let client = this.clients.get(id);
    if (!client) {
      client = { engine: this.ids.client(), tables: new Set(), events: new Map(), lastSeen: Date.now(), wake: null };
      this.clients.set(id, client);
    }
    client.lastSeen = Date.now();
    const idle = Date.now() - this.idle;
    for (const [other, value] of this.clients) {
      if (value.lastSeen >= idle) continue;
      this.clients.delete(other);
      release(value);
    }
    return client;
  }

  /** Keeps an event of the engine for the Apps that read its table. */
  receive(event: Json) {
    for (const client of this.clients.values()) {
      if (!client.tables.has(event.table as string)) continue;
      const key = eventKey(event);
      client.events.delete(key);
      client.events.set(key, event);
      if (client.events.size > EVENTS_LIMIT) client.events.delete(client.events.keys().next().value as string);
      client.wake?.();
    }
  }

  /** Waits until the table is open and the view of the document is read, or fails as the store did. */
  async settled(signal?: AbortSignal): Promise<GridSnapshot> {
    const ready = (snapshot: GridSnapshot) => snapshot.status === "ready" && snapshot.view && !snapshot.pending;
    // A table that could not be read; a failed open publishes its error right after the status.
    const failed = (snapshot: GridSnapshot) => {
      if (snapshot.status !== "error") return null;
      if (snapshot.error) return snapshot.error;
      const table = snapshot.table;
      return table?.status === "error"
        ? new GridError("load_failed", table.error ?? "The table could not be read.")
        : null;
    };
    const now = this.store.getSnapshot();
    if (ready(now)) return now;
    const error = failed(now);
    if (error) throw error;
    return new Promise((resolve, reject) => {
      const stop = this.store.subscribe(() => {
        const snapshot = this.store.getSnapshot();
        const error = failed(snapshot);
        if (ready(snapshot)) finish(() => resolve(snapshot));
        else if (error) finish(() => reject(error));
      });
      const abort = () => finish(() => reject(new GridError("cancelled", "The request was cancelled.")));
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (end: () => void) => {
        stop();
        signal?.removeEventListener("abort", abort);
        end();
      };
    });
  }

  state(): GridState {
    const snapshot = this.store.getSnapshot();
    const table = snapshot.table;
    return {
      grid: this.id,
      file: this.file,
      version: this.version,
      status: snapshot.status,
      table: table && {
        rowCount: table.rowCount,
        status: table.status,
        edits: table.edits.cells,
        fileChanged: table.fileChanged === true,
      },
      view: snapshot.view && { rowCount: snapshot.view.rowCount, rowCountExact: snapshot.view.rowCountExact },
      columns: snapshot.displayed.map(({ column, setting }) => ({
        name: column.name,
        type: column.type,
        ...(setting.format?.label ? { label: setting.format.label } : {}),
      })),
      document: snapshot.document,
      session: snapshot.session,
    };
  }

  /** Applies a command of the agent (§6), as the grid on screen would. */
  async command(command: unknown, signal?: AbortSignal): Promise<unknown> {
    if (command === null || typeof command !== "object" || Array.isArray(command)) {
      throw new ToolError("invalid_command", "A command is an object: { command, …arguments } (§6.1).");
    }
    const name = (command as Json).command;
    if (typeof name === "string" && CORE_COMMANDS.has(name)) {
      throw new ToolError("invalid_command", `${name} is applied by the grid itself (§6.7).`, {
        reason: "unknown_command",
        path: "/command",
      });
    }
    await this.settled(signal);
    this.agent++;
    let outcome: Awaited<ReturnType<GridStore["dispatch"]>>;
    try {
      outcome = await this.store.dispatch(command as GridCommand);
    } finally {
      this.agent--;
    }
    if (!outcome.ok) {
      const error = outcome.error as CommandError | GridError;
      const details: Json = { ...(error.details ?? {}) };
      if ("reason" in error && error.reason !== undefined) details.reason = error.reason;
      if ("path" in error && error.path !== undefined) details.path = error.path;
      throw new ToolError(error.code, error.message, details);
    }
    return outcome.output;
  }

  /** Rows of the view the person sees, as JSON values (§2.2), with the written cells. */
  async rows(options: { start?: number; count?: number; columns?: string[] }, signal?: AbortSignal) {
    const snapshot = await this.settled(signal);
    const table = snapshot.table as NonNullable<GridSnapshot["table"]>;
    const start = options.start ?? 0;
    const count = Math.min(options.count ?? 50, ROWS_LIMIT);
    const columns = options.columns ?? snapshot.displayed.map(({ column }) => column.name);
    const client = new GridClient(localTransport(this.ids.client()));
    const answer = await client.request<{
      start: number;
      end: number;
      rowIds: number[] | null;
      block: { bytes: Uint8Array };
      view: { rowCount: number; rowCountExact: boolean };
      truncated?: Record<string, number[]>;
    }>(
      "rows",
      {
        table: table.table,
        revision: table.revision,
        plan: snapshot.document.plan ?? {},
        start,
        end: start + count,
        columns,
        textLimit: TEXT_LIMIT,
      },
      signal,
    );
    const rows: JsonValue[][] = columns.length > 0 ? decodeBlock(answer.block.bytes).rows : [];
    return {
      start: answer.start,
      end: answer.end,
      rowCount: answer.view.rowCount,
      rowCountExact: answer.view.rowCountExact,
      columns,
      rows,
      ...(answer.rowIds ? { rowIds: answer.rowIds } : {}),
      ...(answer.truncated ? { truncated: answer.truncated } : {}),
    };
  }

  /** Answers a request message of an App (§8), and keeps the tables it opens for their events. */
  async message(clientId: string, message: unknown, signal?: AbortSignal): Promise<unknown> {
    const client = this.client(clientId);
    const answer = (await client.engine.handle(message, { signal })) as Json;
    const op = (message as Json | null)?.op;
    const result = answer?.result as Json | undefined;
    if ((op === "open" || op === "reload") && typeof result?.table === "string") client.tables.add(result.table);
    if (op === "close" && answer?.error === undefined) client.tables.delete((message as Json).table as string);
    return answer;
  }

  /**
   * Keeps an App in step (`grid_sync`): takes the parts that the person changed, unless the agent or another App
   * changed them since the App's `version` (those win and come back), and waits for a change or an event when
   * there is nothing to take.
   */
  async sync(
    clientId: string,
    input: { version: number; document?: unknown; session?: unknown },
    signal?: AbortSignal,
  ): Promise<SyncAnswer> {
    const client = this.client(clientId);
    const document = input.document === undefined ? undefined : checkDocument(input.document);
    const session = input.session === undefined ? undefined : checkSession(input.session);
    const newer = (part: "document" | "session") =>
      this.changed[part].version > input.version && this.changed[part].by !== clientId;
    const gave = document !== undefined || session !== undefined;
    if (document && !newer("document")) {
      this.store.setDocument(document);
      this.bump("document", clientId);
    }
    if (session && !newer("session")) {
      this.store.setSession(session);
      this.bump("session", clientId);
    }
    if (!gave && !newer("document") && !newer("session") && client.events.size === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          if (client.wake === done) client.wake = null;
          resolve();
        };
        const timer = setTimeout(done, this.wait);
        signal?.addEventListener("abort", done, { once: true });
        client.wake?.();
        client.wake = done;
      });
    }
    client.lastSeen = Date.now();
    const snapshot = this.store.getSnapshot();
    const answer: SyncAnswer = { version: this.version, events: [...client.events.values()] };
    client.events.clear();
    if (newer("document")) answer.document = snapshot.document;
    if (newer("session")) answer.session = snapshot.session;
    return answer;
  }

  close() {
    for (const stop of this.stopEvents) stop();
    for (const client of this.clients.values()) {
      client.wake?.();
      release(client);
    }
    this.clients.clear();
    this.disconnect();
  }
}

/** Closes the tables that an App opened and left open: one that the server forgets, or whose grid closes. */
function release(client: Client) {
  client.wake?.();
  for (const table of client.tables) {
    void client.engine.handle({ v: 2, id: 0, op: "close", table }).catch(() => {});
  }
  client.tables.clear();
  client.events.clear();
}

/** The grids of a server, by id. */
export class Grids {
  private readonly grids = new Map<string, Grid>();
  private readonly ids: RequestIds;
  private readonly stopEvents: () => void;
  private next = 1;

  constructor(private readonly options: GridsOptions) {
    this.ids = new RequestIds(options.engine);
    this.stopEvents = options.engine.subscribe((event) => {
      for (const grid of this.grids.values()) grid.receive(event);
    });
  }

  /** Opens a file in a new grid, with a document to start with, once its first view is read. */
  async open(file: string, options: { document?: unknown; sheet?: string } = {}, signal?: AbortSignal) {
    const document = options.document === undefined ? undefined : checkDocument(options.document);
    const id = `g${this.next++}-${Math.random().toString(36).slice(2, 8)}`;
    // The grid follows the engine's events, so that it reads what an App wrote as the App does.
    const engine = this.options.engine;
    const store = new GridStore({
      transport: localTransport({ ...this.ids.client(), subscribe: (listener) => engine.subscribe(listener) }),
      table: file,
      ...(options.sheet === undefined ? {} : { open: { sheet: options.sheet } }),
      ...(document ? { document } : {}),
    });
    const grid = new Grid(id, file, store, this.ids, this.options.wait ?? 20_000, this.options.idle);
    try {
      await grid.settled(signal);
    } catch (error) {
      grid.close();
      throw error;
    }
    this.grids.set(id, grid);
    const max = this.options.maxGrids ?? 16;
    while (this.grids.size > max) {
      const oldest = [...this.grids.values()].reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
      this.close(oldest.id);
    }
    return grid;
  }

  get(id: string): Grid {
    const grid = this.grids.get(id);
    if (!grid) {
      throw new ToolError(
        "grid_not_found",
        `There is no grid ${JSON.stringify(id.slice(0, 40))}: open the file again.`,
      );
    }
    grid.lastUsed = Date.now();
    return grid;
  }

  close(id: string) {
    this.grids.get(id)?.close();
    this.grids.delete(id);
  }

  dispose() {
    this.stopEvents();
    for (const id of [...this.grids.keys()]) this.close(id);
  }
}
