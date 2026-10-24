import { pruneFilterNode } from "./filter-tree.js";
import { type CompiledFormula, compileFormulas } from "./formula.js";
import { ErrorCodes } from "./protocol.js";
import type {
  AggregateRequest,
  ColumnSchema,
  ColumnStats,
  DistinctRequest,
  DistinctValues,
  ExportRequest,
  ExportResult,
  FindRequest,
  FindResult,
  GroupRequest,
  GroupResult,
  RowBlock,
  RowRequest,
  SelectionSummary,
  TableInfo,
  ViewInfo,
  ViewOptions,
  ViewQuery,
} from "./types.js";

/**
 * A table the grid can display. Implementations decide where the data lives: in memory, in a
 * worker, or behind a server (see `RemoteSource`). Only `info`, `createView` and `readRows` are
 * required; optional methods enable the matching features in the grid (statistics, filters by
 * value, the selection summary, find, export, grouping and totals).
 */
export interface TableSource {
  /** Opens the table on the first call and returns its current state. Poll while `status` is `loading`. */
  info(signal?: AbortSignal): Promise<TableInfo>;
  /**
   * Creates a sorted or filtered view. An empty query returns the table itself (`id: null`). With
   * `options.preview`, the view may still be building (see `ViewInfo.status`); poll `viewInfo` then.
   */
  createView(query: ViewQuery, signal?: AbortSignal, options?: ViewOptions): Promise<ViewInfo>;
  /** The current state of a view, for polling while its `status` is `building`. */
  viewInfo?(view: string, signal?: AbortSignal): Promise<ViewInfo>;
  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock>;
  columnStats?(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats>;
  distinctValues?(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues>;
  aggregate?(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary>;
  find?(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null>;
  /**
   * Groups the rows of a view and computes aggregates over them (see `GroupRequest`), or the totals of
   * the view without keys. Offered when `capabilities.group` is true. The answer holds at most
   * `limit` groups, so a source never sends more than a small table.
   */
  group?(request: GroupRequest, signal?: AbortSignal): Promise<GroupResult>;
  exportView?(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
  /**
   * Calls `listener` when the table as a whole changed (for example rows were appended to its file),
   * until the returned function is called. The listener learns only that the table changed, not which
   * rows: it reads the table again with `info`, which reports the new state. Sources call it after
   * the change is visible to `info`, may call it once for several changes, and may call it again for
   * a change already reported. Sources whose data does not change leave this out.
   */
  subscribe?(listener: TableChangeListener): () => void;
  /** Releases the table. The source must not be used afterwards. */
  close?(): void | Promise<void>;
}

/** A change of a whole table, reported by `TableSource.subscribe`. */
export interface TableChange {
  /** The table's new `revision` (see `TableInfo.revision`) when the source knows it; null when the table is gone. */
  revision?: string | null;
}

export type TableChangeListener = (change: TableChange) => void;

/**
 * A `textLimit` that reads whole values, for copies and the cell inspector. Engines send at most this
 * many characters for a cell, also when a request asks for more.
 */
export const MAX_TEXT_LIMIT = 1_000_000;

/** An error reported by a table source. `code` is stable and meant for programs; `message` is for people. */
export class SourceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.status = status;
  }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Whether a query leaves the table as it is: no formula columns, sort, filters, condition tree or search. */
export function isEmptyQuery(query: ViewQuery) {
  return !query.formulas?.length && !query.sort?.length && !filtersRows(query);
}

/** Whether a query leaves out rows (with filters or a search) rather than only sorting them. */
export function filtersRows(query: ViewQuery) {
  return Boolean(query.filters?.length || pruneFilterNode(query.where) || query.search?.trim());
}

/**
 * Checks a query's formula columns against the table's columns (see `compileFormulas`), for sources that
 * evaluate them. Throws `invalid_request` for the first formula with an error.
 */
export function queryFormulas(columns: readonly ColumnSchema[], query: ViewQuery): CompiledFormula[] {
  const compiled = compileFormulas(columns, query.formulas ?? []);
  const failed = compiled.find((formula) => formula.error);
  if (failed?.error) {
    throw new SourceError(ErrorCodes.invalidRequest, `Formula column "${failed.name}": ${failed.error.message}`, 400);
  }
  return compiled;
}
