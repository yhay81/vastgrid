---
title: TableSource and types
description: The TableSource interface, ArraySource and RemoteSource, and the types they exchange with the grid.
---

These are in `vastgrid-core`, and `vastgrid` re-exports them.

Coordinates: `row` is a position in a view, from 0. `column` in requests is the index of the column in
the table's schema (`TableInfo.columns`), never a display position, so hiding and moving columns in the
grid does not change what a source is asked for. Ranges are `[start, end)`.

## `TableSource`

```ts
interface TableSource {
  /** Opens the table on the first call and returns its current state. Polled while `status` is `loading`. */
  info(signal?: AbortSignal): Promise<TableInfo>;
  /** Creates a sorted or filtered view. An empty query returns the table itself (`id: null`). */
  createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo>;
  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock>;
  columnStats?(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats>;
  distinctValues?(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues>;
  aggregate?(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary>;
  find?(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null>;
  exportView?(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
  /** Releases the table. The source must not be used afterwards. */
  close?(): void | Promise<void>;
}
```

[Your own TableSource](/guides/custom-source/) explains what the grid expects of each method.

## `ArraySource`

```ts
new ArraySource({
  columns: (string | ColumnSchema)[]; // names (types inferred) or schemas
  rows?: CellValue[][];               // row-major data, or
  columnData?: CellValue[][];         // column-major data, one array per column
});
```

Supports every capability but `export`. See [Data in memory](/guides/in-memory/).

## `RemoteSource`

```ts
new RemoteSource({
  endpoint: string;                    // URL that accepts the protocol requests (POST, JSON)
  ref: string;                         // what to open, in the server's terms
  read?: ReadOptions;                  // workbooks: sheet, headerRow, keepEmptyRows, keepEmptyColumns
  headers?: Record<string, string>;    // extra headers for every request
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
});
```

Speaks the [table protocol](/reference/protocol/). When the server forgets a table or a view (it
restarted, or the file changed), `RemoteSource` opens the table again and recreates the view with the same
query.

## Values and columns

```ts
type CellValue = string | number | boolean | null;

type ColumnType =
  | "integer" | "bigint" | "float" | "decimal" | "boolean" | "string"
  | "date" | "time" | "timestamp" | "timestamptz" | "interval" | "uuid"
  | "binary" | "list" | "struct" | "map" | "json" | "unknown";

interface ColumnSchema {
  name: string;
  type: ColumnType;
  /** The engine's own type name, for example `DECIMAL(10,2)`. */
  sourceType?: string;
}
```

Numbers that cannot be represented exactly (64-bit integers, decimals, `NaN`, `Infinity`) are strings.
Nested and binary values are their text representation.

## `TableInfo`

```ts
interface TableInfo {
  columns: ColumnSchema[];
  rowCount: number | null;      // null while the engine is still counting
  readableRows: number;         // rows readable now: a preview of the beginning while loading
  status: "loading" | "ready" | "error";
  progress?: number | null;     // 0..1 while loading, when known
  error?: string;
  format?: string;              // csv, tsv, parquet, ndjson, xlsx, …
  byteSize?: number;
  revision?: string;            // changes when the underlying data changes
  notes?: string[];             // encoding:<name>, all_varchar, invalid_utf8_replaced, merged_cells, formulas_without_values
  sheets?: { name: string; hidden?: boolean }[]; // workbooks: the sheets that can be read
  sheet?: string;               // workbooks: the sheet that was read
  capabilities: {
    sort: boolean;
    filter: boolean;
    search: boolean;
    stats: boolean;
    distinct: boolean;
    aggregate: boolean;
    find: boolean;
    export: boolean;
  };
}
```

## `ViewQuery`

```ts
interface ViewQuery {
  sort?: { column: number; direction: "asc" | "desc" }[]; // blanks last in both directions
  filters?: Filter[];                                     // all must match
  search?: string;                                        // any column contains it, ignoring case
}

type Filter =
  /** Rows whose value is one of `values` (none of them with `exclude`). `null` matches blanks. */
  | { type: "values"; column: number; values: CellValue[]; exclude?: boolean }
  | { type: "compare"; column: number; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; value: string | number | boolean }
  /** Inclusive; either bound may be left out. */
  | { type: "between"; column: number; min?: string | number | boolean; max?: string | number | boolean }
  | {
      type: "text";
      column: number;
      op: "contains" | "notContains" | "startsWith" | "endsWith" | "equals" | "notEquals";
      value: string;
      caseSensitive?: boolean;
    }
  /** Blank is `null` or an empty string. */
  | { type: "blank"; column: number; blank: boolean };

interface ViewInfo {
  id: string | null; // null: the table in its original order
  rowCount: number;
  query: ViewQuery;
}
```

## Rows

```ts
interface RowRequest {
  view: string | null;
  start: number;      // first row, inclusive
  end: number;        // last row, exclusive
  columns: number[];  // schema column indexes
  textLimit?: number; // longest text per cell; longer text ends with "…"
}

interface RowBlock {
  start: number;
  end: number;
  columns: CellValue[][];    // one array per requested column, in request order
  rowIds?: number[] | null;  // positions in the original table, for views
}
```

`MAX_TEXT_LIMIT` (1,000,000) is the `textLimit` that reads whole values, for copies and the cell
inspector.

## Statistics, values and the selection

`vastgrid-duckdb` excludes `NaN` and infinities from the mean, standard deviation, quartiles and histogram. The mean,
standard deviation and quartiles are `null` when no finite values exist; the histogram is omitted.
Row, null and distinct counts still describe the whole column.

```ts
interface ColumnStats {
  column: number;
  rows: number;
  nulls: number;
  distinct: number | null;
  distinctApproximate?: boolean;
  min?: CellValue;
  max?: CellValue;
  mean?: number | null;
  stddev?: number | null;
  quantiles?: CellValue[] | null;                       // 25th, 50th and 75th percentiles
  minLength?: number | null;
  maxLength?: number | null;
  histogram?: { start: number; end: number; count: number }[] | null;
  top?: { value: CellValue; count: number }[] | null;   // most common values
}

interface DistinctRequest { view: string | null; column: number; search?: string; limit?: number }
interface DistinctValues { values: { value: CellValue; count: number }[]; truncated: boolean }

interface AggregateRequest { view: string | null; ranges: { start: number; end: number; columns: number[] }[] }
interface SelectionSummary {
  count: number;         // non-blank cells
  numericCount: number;  // numeric cells
  sum: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
}
```

## Find and export

```ts
interface FindRequest {
  view: string | null;
  text: string;
  columns: number[];   // schema column indexes in display order; the search goes along each row through these
  row: number;         // start position: a row and an index into `columns`; the start cell is skipped
  column: number;
  direction: 1 | -1;
  caseSensitive?: boolean;
}
interface FindResult { row: number; column: number } // `column` is an index into `FindRequest.columns`

interface ExportRequest {
  view: string | null;
  format: "csv" | "tsv" | "parquet" | "json";
  columns?: number[];
  target: string;      // interpreted by the host, for example a path relative to a workspace
}
interface ExportResult { target: string; rows: number }
```

## Errors

```ts
class SourceError extends Error {
  constructor(code: string, message: string, status?: number);
  readonly code: string;   // stable, for programs
  readonly status: number; // HTTP status when sent by a server
}
```

`ErrorCodes` has a constant for every code of the protocol, such as `ErrorCodes.viewNotFound`
(`"view_not_found"`); the [protocol](/reference/protocol/#error-codes) lists them. `abortError()` creates
the error to reject with when a signal aborts, and `isAbortError(error)` recognizes it.

## Helpers

| Export | Description |
| --- | --- |
| `isEmptyQuery(query)` | Whether a query has no sort, filters or search. |
| `filtersRows(query)` | Whether a query leaves out rows (filters or a search), rather than only sorting. |
| `plainText(value)` | A value's text for the clipboard: no grouping, no truncation. |
| `numericValue(value, type)` | A value as a JavaScript number, or `null`. |
| `ValueFormatter` | Formats values for display in a locale, as the grid does. |
| `toTsv`, `toHtmlTable`, `toMarkdownTable` | Serialize rows of values as the grid's copies do. |
| `isNumericType(type)`, `isTemporalType(type)` | Group column types. |
| `parseProtocolRequest(body)` | Validates a protocol request, for servers. |
| `RowCache`, `ScrollAxis`, `SelectionModel`, `ColumnLayout` | The grid's building blocks, framework-free, for building another grid. |
