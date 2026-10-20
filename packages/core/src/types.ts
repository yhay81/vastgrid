/**
 * Types shared by every table engine and by the grid.
 *
 * Coordinates: `row` is a position in a view (0-based). `column` in requests is the index of the
 * column in the table schema (`TableInfo.columns`), never a display position, so that hiding and
 * reordering columns in the UI does not change what the engine is asked for.
 */

/** Logical column types. Engines map their native types onto these. */
export type ColumnType =
  | "integer"
  | "bigint"
  | "float"
  | "decimal"
  | "boolean"
  | "string"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "interval"
  | "uuid"
  | "binary"
  | "list"
  | "struct"
  | "map"
  | "json"
  | "unknown";

/**
 * A cell value on the wire. Numbers that cannot be represented exactly (64-bit integers, decimals,
 * NaN, Infinity) arrive as strings. Nested and binary values arrive as their text representation.
 */
export type CellValue = string | number | boolean | null;

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  /** The engine's own type name, for example `DECIMAL(10,2)`. */
  sourceType?: string;
}

export interface TableCapabilities {
  sort: boolean;
  filter: boolean;
  search: boolean;
  stats: boolean;
  distinct: boolean;
  aggregate: boolean;
  find: boolean;
  export: boolean;
}

export type TableStatus = "loading" | "ready" | "error";

export interface TableInfo {
  columns: ColumnSchema[];
  /** Rows in the table. `null` while the engine is still counting (loading). */
  rowCount: number | null;
  /** Rows that can already be read. Equals `rowCount` once ready; a preview of the beginning while loading. */
  readableRows: number;
  status: TableStatus;
  /** Loading progress between 0 and 1, when known. */
  progress?: number | null;
  error?: string;
  /** File format, for example `csv`, `tsv`, `parquet` or `json`. */
  format?: string;
  /** Size of the underlying file in bytes, when known. */
  byteSize?: number;
  /** Changes when the underlying data changes (for example the file was rewritten). */
  revision?: string;
  /**
   * Notes about how the file was read, as stable codes: `encoding:<name>` (converted from that
   * encoding), `all_varchar` (columns read as text because types were inconsistent),
   * `invalid_utf8_replaced` (invalid bytes replaced).
   */
  notes?: string[];
  capabilities: TableCapabilities;
}

export type SortDirection = "asc" | "desc";

export interface SortKey {
  column: number;
  direction: SortDirection;
}

export type TextOperator = "contains" | "notContains" | "startsWith" | "endsWith" | "equals" | "notEquals";
export type CompareOperator = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
export type Comparable = string | number | boolean;

export type Filter =
  /** Keep rows whose value is one of `values` (or none of them when `exclude`). `null` matches blanks. */
  | { type: "values"; column: number; values: CellValue[]; exclude?: boolean }
  | { type: "compare"; column: number; op: CompareOperator; value: Comparable }
  /** Inclusive range. Either bound may be omitted. */
  | { type: "between"; column: number; min?: Comparable; max?: Comparable }
  | { type: "text"; column: number; op: TextOperator; value: string; caseSensitive?: boolean }
  /** Blank means `null` or an empty string. */
  | { type: "blank"; column: number; blank: boolean };

export interface ViewQuery {
  sort?: SortKey[];
  filters?: Filter[];
  /** Keep rows where any column contains this text (case-insensitive). */
  search?: string;
}

/** A sorted or filtered view of a table. `id: null` is the table in its original order. */
export interface ViewInfo {
  id: string | null;
  rowCount: number;
  query: ViewQuery;
}

export interface RowRequest {
  view: string | null;
  /** First row (inclusive). */
  start: number;
  /** Last row (exclusive). */
  end: number;
  /** Schema column indexes to read. */
  columns: number[];
  /** Longest text to return per cell; longer text ends with "…". Engines apply their own default. */
  textLimit?: number;
}

export interface RowBlock {
  start: number;
  end: number;
  /** One array per requested column, in request order. */
  columns: CellValue[][];
  /** Row positions in the original table (0-based), for views. */
  rowIds?: number[] | null;
}

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

export interface ColumnStats {
  column: number;
  rows: number;
  nulls: number;
  distinct: number | null;
  distinctApproximate?: boolean;
  min?: CellValue;
  max?: CellValue;
  mean?: number | null;
  stddev?: number | null;
  /** 25th, 50th and 75th percentiles, when numeric or temporal. */
  quantiles?: CellValue[] | null;
  minLength?: number | null;
  maxLength?: number | null;
  /** Bins over the numeric value (temporal columns use epoch seconds). */
  histogram?: HistogramBin[] | null;
  /** Most common values. */
  top?: { value: CellValue; count: number }[] | null;
}

export interface DistinctRequest {
  view: string | null;
  column: number;
  search?: string;
  limit?: number;
}

export interface DistinctValues {
  values: { value: CellValue; count: number }[];
  /** More values exist than were returned. */
  truncated: boolean;
}

export interface AggregateRange {
  start: number;
  end: number;
  columns: number[];
}

export interface AggregateRequest {
  view: string | null;
  ranges: AggregateRange[];
}

export interface SelectionSummary {
  /** Non-blank cells. */
  count: number;
  /** Numeric cells. */
  numericCount: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
}

export interface FindRequest {
  view: string | null;
  text: string;
  /** Schema column indexes in display order. The search walks rows, then these columns. */
  columns: number[];
  /** Start position: the row and the index into `columns`. The start cell itself is skipped. */
  row: number;
  column: number;
  direction: 1 | -1;
  caseSensitive?: boolean;
}

export interface FindResult {
  row: number;
  /** Index into `FindRequest.columns`. */
  column: number;
}

export type ExportFormat = "csv" | "tsv" | "parquet" | "json";

export interface ExportRequest {
  view: string | null;
  format: ExportFormat;
  columns?: number[];
  /** Destination, interpreted by the host (for example a path relative to a workspace). */
  target: string;
}

export interface ExportResult {
  target: string;
  rows: number;
}
