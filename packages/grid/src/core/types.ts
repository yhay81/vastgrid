import type {
  Capabilities,
  Column,
  CommandError,
  DisplayedColumn,
  ErrorCode,
  GridDocument,
  GridSession,
  JsonValue,
  Operation,
  Plan,
} from "vastgrid-spec";

/** The table's edits version and the number of cells written so far (§8.2 of the specification). */
export interface Edits {
  version: number;
  cells: number;
}

/** What `open` and `info` give (§8.2). */
export interface TableInfo {
  /** The engine's id of the open table, for later requests. */
  table: string;
  revision: string | null;
  edits: Edits;
  status: "loading" | "ready" | "error";
  progress: number | null;
  /** Null while the table loads. */
  rowCount: number | null;
  readableRows: number;
  columns: Column[];
  capabilities: Capabilities;
  format?: string;
  byteSize?: number;
  notes?: string[];
  sheets?: { name: string; hidden?: boolean }[];
  sheet?: string;
  error?: string;
  /** The file changed on disk since the table, which has written cells, was read (§7.6); `reload` reads it again. */
  fileChanged?: boolean;
}

/** A view as `rows` reports it (§8.2, §9). */
export interface ViewInfo {
  hash: string;
  status: "building" | "ready";
  rowCount: number;
  rowCountExact: boolean;
  readableRows: number;
  columns: Column[];
  edits: Edits;
  partial?: boolean;
}

/** The result of `rows` (§8.2), with its block in the structured encoding. */
export interface RowsResult {
  view: ViewInfo;
  start: number;
  end: number;
  rowIds: number[] | null;
  block: { bytes: Uint8Array };
  truncated?: Record<string, number[]>;
}

/** The `read` options of `open` (§8.2). */
export interface OpenOptions {
  sheet?: string;
  headerRow?: number;
  keepEmptyRows?: boolean;
  keepEmptyColumns?: boolean;
}

/** A request (§8.1). */
export interface RequestMessage {
  v: 2;
  id: number;
  op: Operation;
  [member: string]: unknown;
}

/**
 * Rows read on a server for the first render (§7 of v2-react.md): the table, the plan they were read for, and
 * the answer of `rows`. A store given them shows these rows before it reads any.
 */
export interface InitialView {
  table: TableInfo;
  plan: Plan;
  rows: RowsResult;
}

/** A failed request (§8.7), or a response that does not follow §8 (`internal`). */
export class GridError extends Error {
  readonly code: ErrorCode;
  readonly reason?: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
  /** The operation of the request that failed. */
  readonly op?: Operation;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { reason?: string; path?: string; details?: Record<string, unknown>; op?: Operation } = {},
  ) {
    super(message);
    this.name = "GridError";
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.path !== undefined) this.path = extra.path;
    if (extra.details !== undefined) this.details = extra.details;
    if (extra.op !== undefined) this.op = extra.op;
  }
}

/** What a dispatched command came to: its output, or why it failed (§4.2 of v2-react.md). */
export type CommandOutcome = { ok: true; output?: unknown } | { ok: false; error: CommandError | GridError };

/** What the grid shows. A snapshot is never changed: the store makes a new one for every change. */
export interface GridSnapshot {
  readonly document: GridDocument;
  readonly session: GridSession;
  /** Null until the table is open. */
  readonly table: TableInfo | null;
  /** The view on screen; null until its first rows are read. */
  readonly view: ViewInfo | null;
  /** The displayed columns of the view on screen (§5.1.1), in display order. */
  readonly displayed: readonly DisplayedColumn[];
  /** A plan whose view is being read to replace the one on screen. */
  readonly pending: { readonly plan: Plan } | null;
  readonly status: "idle" | "opening" | "ready" | "error";
  /** The last failure that belongs to no command. */
  readonly error: GridError | null;
  /**
   * The totals row (§5.1): the total of each displayed column that has one, over the whole view on screen, with
   * the types of the values; null without totals, or for a view that groups rows.
   */
  readonly totals: {
    readonly values: Readonly<Record<string, JsonValue>>;
    readonly columns: Readonly<Record<string, Column>>;
  } | null;
}
