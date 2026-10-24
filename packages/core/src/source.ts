import { pruneFilterNode } from "./filter-tree.js";
import type {
  AggregateRequest,
  ColumnStats,
  DistinctRequest,
  DistinctValues,
  ExportRequest,
  ExportResult,
  FindRequest,
  FindResult,
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
 * value, the selection summary, find, export).
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
  exportView?(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
  /** Releases the table. The source must not be used afterwards. */
  close?(): void | Promise<void>;
}

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

/** Whether a query leaves the table as it is: no sort, filters, condition tree or search. */
export function isEmptyQuery(query: ViewQuery) {
  return !query.sort?.length && !filtersRows(query);
}

/** Whether a query leaves out rows (with filters or a search) rather than only sorting them. */
export function filtersRows(query: ViewQuery) {
  return Boolean(query.filters?.length || pruneFilterNode(query.where) || query.search?.trim());
}
