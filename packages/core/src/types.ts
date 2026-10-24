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
  /**
   * The source does not write this column, also when it can write cells (`capabilities.edit`), for
   * example a computed column or a type it cannot write (lists, structs, binary values).
   */
  readOnly?: boolean;
  /** Formula columns (see `ViewQuery.formulas`): the expression that computes the values. */
  expression?: string;
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
  /**
   * Evaluates condition trees (`ViewQuery.where`). Absent means false: sources written before condition
   * trees existed ignore them, so the grid sends them only to sources that report this.
   */
  conditions?: boolean;
  /**
   * Writes cells (`TableSource.updateCells`). Absent means false: the table is read-only, and the grid
   * offers no editing.
   */
  edit?: boolean;
  /**
   * Saves written cells into the file they came from (`TableSource.saveEdits`). Absent means false.
   */
  save?: boolean;
  /**
   * Evaluates formula columns (`ViewQuery.formulas`) for reading, sorting, filtering, statistics,
   * summaries, find and export. Absent means false.
   */
  formulas?: boolean;
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
  /**
   * Changes when the underlying data changes (for example the file was rewritten). Row positions
   * (`RowBlock.rowIds`) keep naming the same records while it stays the same, so a source whose data
   * can change must change it; without one, the data is taken to be unchanged.
   */
  revision?: string;
  /**
   * Notes about how the file was read, as stable codes: `encoding:<name>` (converted from that
   * encoding), `all_varchar` (columns read as text because types were inconsistent),
   * `invalid_utf8_replaced` (invalid bytes replaced), and for workbooks `merged_cells` (the sheet has
   * merged cells; their value is in the top-left cell only) and `formulas_without_values` (formulas
   * that were saved without a calculated value read as blank).
   */
  notes?: string[];
  /** What `exportView` can write, when `capabilities.export` is true (see `ExportSupport`). */
  exports?: ExportSupport;
  /** The cells written with `updateCells`, from sources that can write them (`capabilities.edit`). */
  edits?: TableEdits;
  /** Workbooks: the sheets that can be read, in workbook order. */
  sheets?: SheetInfo[];
  /** Workbooks: the name of the sheet that was read. */
  sheet?: string;
  capabilities: TableCapabilities;
}

/**
 * Cells written to a table (`TableSource.updateCells`). Writes keep row positions (`RowBlock.rowIds`)
 * and the `revision`: they change `version` instead, so that grids read the new values again without
 * losing their checked rows.
 */
export interface TableEdits {
  /** Increments with every write (and when written cells are saved or discarded). */
  version: number;
  /** Cells that hold a written value, for sources that keep them apart from the file (until it is saved). */
  cells: number;
}

/**
 * A new value for one cell. `row` is the row's position in the table (`RowBlock.rowIds`, or the view
 * position of the table itself), which names the same record for one `TableInfo.revision`.
 */
export interface CellUpdate {
  row: number;
  /** Schema column index. */
  column: number;
  /**
   * The new value, as values arrive: 64-bit integers and decimals as strings (exact digits), dates and
   * times as ISO-like text (see `parseCellInput`).
   */
  value: CellValue;
  /**
   * The value the change was made from. When it is given and the cell holds another value now, the
   * whole request is refused with `edit_conflict`, so that a change made meanwhile is not overwritten.
   */
  previous?: CellValue;
}

/** Writes cells at once: every update is written, or none of them (see `TableSource.updateCells`). */
export interface UpdateRequest {
  updates: CellUpdate[];
  /**
   * The `TableInfo.revision` the rows were read with. The request is refused with `revision_changed`
   * when the table has another revision now, since row positions then name other records.
   */
  revision?: string;
}

export interface SaveResult {
  /** Records of the file written anew (records with cells written since the last save). */
  records: number;
  /** The table's edits after the save: its cells count as saved (`cells` is 0). */
  edits: TableEdits;
}

export interface UpdateResult {
  /** Cells written. */
  updated: number;
  /** The table's edits after the write. */
  edits: TableEdits;
}

export interface SheetInfo {
  name: string;
  /** Hidden in the workbook (it can still be read). */
  hidden?: boolean;
}

/**
 * How to read a file, for formats that need a choice. Only workbooks (`.xlsx`, `.xlsm`) use these
 * options today; other formats ignore them.
 */
export interface ReadOptions {
  /** The sheet to read, by name. Defaults to the first visible sheet. */
  sheet?: string;
  /**
   * The 1-based row that holds the column names; rows above it are skipped. `0` reads without
   * names (columns are named by their letters `A`, `B`, …). Defaults to the first row with a value.
   */
  headerRow?: number;
  /** Keep rows without any value between the first and the last data row. Skipped by default. */
  keepEmptyRows?: boolean;
  /** Keep columns without any value (and no name) inside the used range. Skipped by default. */
  keepEmptyColumns?: boolean;
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

/**
 * Conditions combined with AND (every one matches) or OR (at least one matches). A group without
 * conditions is left out, as if it were not there. Groups nest up to `MAX_FILTER_DEPTH` levels.
 */
export interface FilterGroup {
  type: "and" | "or";
  filters: FilterNode[];
}

/** A condition tree: a filter on one column, or a group of conditions. */
export type FilterNode = Filter | FilterGroup;

/**
 * A column computed for each row from the row's other columns, by an expression (see `parseFormula` for the
 * language). Its name must differ from the table's columns and the other formulas.
 */
export interface FormulaColumn {
  name: string;
  expression: string;
}

export interface ViewQuery {
  /**
   * Formula columns of the view. Formula `i` is the column `TableInfo.columns.length + i` in the view's
   * requests (rows, sort, filters, statistics, export, …); requests without the view do not have them.
   * A formula may use the table's columns and the other formulas, by name. The search does not look in
   * formula columns.
   */
  formulas?: FormulaColumn[];
  sort?: SortKey[];
  /** Conditions that every kept row matches (AND). */
  filters?: Filter[];
  /**
   * A condition tree that kept rows also match, combined with `filters` by AND. It expresses OR,
   * nesting and several conditions on one column.
   */
  where?: FilterNode;
  /** Keep rows where any column contains this text (case-insensitive). */
  search?: string;
}

/**
 * `building`: the view is still being built and only its first `readableRows` rows can be read; they
 * are already in their final order. `ready`: every row can be read. `error`: the build failed (see
 * `error`); the first `readableRows` rows can still be read.
 */
export type ViewStatus = "building" | "ready" | "error";

/** A sorted or filtered view of a table. `id: null` is the table in its original order. */
export interface ViewInfo {
  id: string | null;
  /** Rows in the view, also while it is building. */
  rowCount: number;
  query: ViewQuery;
  /** Absent means `ready`. */
  status?: ViewStatus;
  /** Rows that can be read now, from the start of the view. Absent means `rowCount`. */
  readableRows?: number;
  /** Why the build failed, when `status` is `error`. */
  error?: string;
}

export interface ViewOptions {
  /**
   * Accept a view that is still building: the source may answer as soon as the first rows of the
   * view are known (`status: "building"`), and finish the view in the background. Without it the
   * answer waits until the view is ready.
   */
  preview?: boolean;
}

export interface RowRequest {
  view: string | null;
  /** First row (inclusive). */
  start: number;
  /** Last row (exclusive). */
  end: number;
  /** Schema column indexes to read. */
  columns: number[];
  /**
   * Longest text to return per cell; longer text ends with "…". Engines apply their own default and send
   * at most `MAX_TEXT_LIMIT` characters.
   */
  textLimit?: number;
}

export interface RowBlock {
  start: number;
  end: number;
  /** One array per requested column, in request order. */
  columns: CellValue[][];
  /**
   * Row positions in the original table (0-based), for views. They are stable for the table's
   * `revision`, so the grid uses them as row keys (see `RowSelection`).
   */
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
  /** Mean of finite numeric values. */
  mean?: number | null;
  /** Sample standard deviation of finite numeric values. */
  stddev?: number | null;
  /** 25th, 50th and 75th percentiles, when numeric or temporal; non-finite values are excluded. */
  quantiles?: CellValue[] | null;
  minLength?: number | null;
  maxLength?: number | null;
  /** Bins over finite numeric values (temporal columns use epoch seconds). */
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

export type ExportFormat = "csv" | "tsv" | "parquet" | "json" | "xlsx";

/**
 * What `exportView` can write, in `TableInfo.exports`. `delivery: "file"`: the source writes a new file
 * at `ExportRequest.target`, which the host resolves (for example a path on the server); the result
 * holds no data. `delivery: "data"`: the source returns the file's bytes in `ExportResult.data`, for
 * the app to download or save; `target` is only its name. Sources without `exports` that can export
 * write `csv`, `tsv`, `parquet` and `json` files (`delivery: "file"`).
 */
export interface ExportSupport {
  formats: ExportFormat[];
  delivery: "file" | "data";
}

/**
 * Writes the rows of a view (or of the table, `view: null`) in the view's order. Filters, the search
 * and the sort are those of the view; `columns` picks the columns and their order.
 */
export interface ExportRequest {
  view: string | null;
  format: ExportFormat;
  /** Schema column indexes in the order to write them. Defaults to every column in schema order. */
  columns?: number[];
  /**
   * The header of each written column, for `csv`, `tsv` and `xlsx` (for example the labels of
   * `columnFormats`). Defaults to the schema names. `parquet` and `json` keep the schema names.
   */
  headers?: string[];
  /**
   * `xlsx`: an Excel number format code for each written column (`null` for the default of its type),
   * for example made with `excelNumberFormat`. Other formats write the values as they are.
   */
  numberFormats?: (string | null)[];
  /** Destination, interpreted by the host (for example a path relative to a workspace), or the file name for `delivery: "data"`. */
  target: string;
}

export interface ExportResult {
  target: string;
  rows: number;
  /** The file, from sources whose `exports.delivery` is `data`. */
  data?: Blob;
}

/** Horizontal alignment of a column's cells. */
export type ColumnAlign = "left" | "center" | "right";

/**
 * How a column shows numbers. Values keep their exact digits: 64-bit integers and decimals that arrive
 * as strings are formatted from the string, never through a JS number. Maps onto `Intl.NumberFormat`.
 */
export interface NumberFormat {
  /** `percent` multiplies by 100 (0.125 → 12.5%). `currency` needs `currency`. Defaults to `decimal`. */
  style?: "decimal" | "percent" | "currency";
  /** ISO 4217 code, for example `USD` or `JPY`. */
  currency?: string;
  currencyDisplay?: "symbol" | "narrowSymbol" | "code" | "name";
  /** Exactly this many fraction digits (sets both the minimum and the maximum). */
  fractionDigits?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /** Group digits (1,234,567). Defaults to the grid's setting. */
  grouping?: boolean;
  notation?: "standard" | "scientific" | "engineering" | "compact";
  signDisplay?: "auto" | "always" | "exceptZero" | "negative" | "never";
  /** Text before and after the number, for example a unit. */
  prefix?: string;
  suffix?: string;
}

/**
 * How a column shows dates and times (ISO-like strings such as `2024-01-31 12:34:56`). Either a
 * `pattern` or `Intl.DateTimeFormat` options.
 */
export interface DateFormat {
  /**
   * `yyyy` `yy` year, `M` `MM` month, `MMM` `MMMM` month name, `d` `dd` day, `EEE` `EEEE` weekday,
   * `H` `HH` hour (0–23), `h` `hh` hour (1–12), `a` AM/PM, `m` `mm` minute, `s` `ss` second, `S`… fraction
   * digits. Text in single quotes is kept as it is (`''` is a quote). Example: `yyyy/MM/dd HH:mm`.
   */
  pattern?: string;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
  weekday?: "long" | "short" | "narrow";
  year?: "numeric" | "2-digit";
  month?: "numeric" | "2-digit" | "long" | "short" | "narrow";
  day?: "numeric" | "2-digit";
  hour?: "numeric" | "2-digit";
  minute?: "numeric" | "2-digit";
  second?: "numeric" | "2-digit";
  fractionalSecondDigits?: 1 | 2 | 3;
  hour12?: boolean;
  timeZoneName?: "short" | "long" | "shortOffset" | "longOffset";
  /**
   * IANA time zone that values with an offset (`timestamptz`) are shown in. Defaults to the runtime's.
   * Values without an offset are shown as they are, in no time zone.
   */
  timeZone?: string;
}

/**
 * How one cell looks, chosen by its value (conditional formatting). Colors are CSS colors. The cell is
 * drawn as usual otherwise: same text, alignment and font.
 */
export interface CellStyle {
  /** Text color. */
  color?: string;
  /** Background of the whole cell, under the selection. */
  background?: string;
  /**
   * What the colors mean, read by screen readers after the value of the active cell (colors alone are
   * not announced), for example "Over budget".
   */
  description?: string;
}

/** Text used when copying cells: the value itself, or the text the grid shows. */
export type CopyValues = "raw" | "formatted";

/**
 * Display settings of one column, given by the column's schema name. They change only how values are
 * shown: sorting, filters, search, statistics and exports work on the values themselves.
 */
export interface ColumnFormat {
  /** Shown in the header and the panels instead of the schema name. */
  label?: string;
  /** For numeric values (numbers, and numeric strings such as 64-bit integers and decimals). */
  number?: NumberFormat;
  /** For date and time values. */
  date?: DateFormat;
  /** Defaults to `right` for numeric columns and `left` otherwise. */
  align?: ColumnAlign;
  /**
   * Wraps the text onto as many lines as the grid's `maxLines` allows, breaking at spaces and between
   * CJK characters, with line breaks in the value starting new lines. Text that does not fit ends with
   * "…". Rows of the grid are all as high as the lines need while a visible column wraps.
   */
  wrap?: boolean;
  /**
   * Makes the text of a value. `text` is the text the other settings make. The result is shown in one
   * line (or wrapped, with `wrap`); keep the function stable (define it outside components or memoize it), since a new function
   * redraws the column.
   */
  format?: (value: CellValue, context: { column: ColumnSchema; text: string }) => string;
  /**
   * Colors of a cell by its value, for example red text for negative numbers; `null` or `undefined`
   * keeps the default. `text` is the shown text. It runs for loaded cells that are drawn, and its result
   * is kept with the rows like the text, so keep it fast and stable (like `format`).
   */
  style?: (value: CellValue, context: { column: ColumnSchema; text: string }) => CellStyle | null | undefined;
  /** Overrides the grid's `copyValues` for this column's cells. */
  copy?: CopyValues;
}

/**
 * A group of columns shown under one name in a header row above the column names (multi-row headers).
 * Groups only change the headers: the schema, the query, the selection and copies use the columns.
 */
export interface ColumnGroup {
  /** Shown in the group's header. */
  name: string;
  /**
   * The group's members: schema column names and nested groups, which add a header row below this one.
   * Names that the table does not have are ignored, so one definition can serve similar tables.
   */
  children: readonly (string | ColumnGroup)[];
}
