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
  /**
   * Creates a sorted or filtered view. An empty query returns the table itself (`id: null`). With
   * `options.preview`, the view may still be building (`status: "building"`).
   */
  createView(query: ViewQuery, signal?: AbortSignal, options?: { preview?: boolean }): Promise<ViewInfo>;
  /** The current state of a view, polled while its `status` is `building`. */
  viewInfo?(view: string, signal?: AbortSignal): Promise<ViewInfo>;
  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock>;
  columnStats?(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats>;
  distinctValues?(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues>;
  aggregate?(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary>;
  find?(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null>;
  exportView?(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
  /** Groups the rows of a view and aggregates them, or totals them without keys. */
  group?(request: GroupRequest, signal?: AbortSignal): Promise<GroupResult>;
  /** Writes cells, all or none, for sources that report `capabilities.edit` (see below). */
  updateCells?(request: UpdateRequest, signal?: AbortSignal): Promise<UpdateResult>;
  /** Saves the written cells into the table's file, for sources that report `capabilities.save`. */
  saveEdits?(signal?: AbortSignal): Promise<{ records: number; edits: TableEdits }>;
  /** Calls `listener` when the whole table changed, until the returned function is called. */
  subscribe?(listener: (change: { revision?: string | null; edits?: number }) => void): () => void;
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
  editable?: boolean;                 // write cells with updateCells (default false)
});
```

Supports every capability. `exportView` writes `csv`, `tsv`, `json` and `xlsx` (not `parquet`) and returns the file as a `Blob` in `ExportResult.data` (`exports.delivery` is `"data"`). See [Data in memory](/guides/in-memory/) and [Exporting](/guides/export/).

## `RemoteSource`

```ts
new RemoteSource({
  endpoint: string;                    // URL that accepts the protocol requests (POST, JSON)
  ref: string;                         // what to open, in the server's terms
  read?: ReadOptions;                  // workbooks: sheet, headerRow, keepEmptyRows, keepEmptyColumns
  headers?: Record<string, string>;    // extra headers for every request
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  changes?: ChangeTransport | false;   // how to learn that the table changed; default pollChanges()
});
```

Speaks the [table protocol](/reference/protocol/). When the server forgets a table or a view (it
restarted, or the file changed), `RemoteSource` opens the table again and recreates the view with the same
query.

While a grid subscribes, `RemoteSource` watches the table with its `changes` transport. The default,
`pollChanges({ interval: 2000 })`, sends a `revision` request every `interval` milliseconds and reports a
revision that differs from the one `info` read last, once; after failed requests the next answer catches
up. It stops for good when the server does not know the request. A transport of your own receives
`{ ref, check(signal?), changed(revision?) }`: call `changed` when the server pushes a change (for example
over server-sent events), or `check` to ask. `changes: false` turns watching off.

```ts
const pushed: ChangeTransport = {
  watch({ ref, changed }) {
    const events = new EventSource(`/api/changes?ref=${encodeURIComponent(ref)}`);
    events.onmessage = (event) => changed(event.data);
    return () => events.close();
  },
};
```

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
    conditions?: boolean; // evaluates `ViewQuery.where`; absent means false
    group?: boolean;      // answers `group`; absent means false
    pivot?: boolean;      // answers `group` with `pivot`; absent means false
    formulas?: boolean;   // evaluates `ViewQuery.formulas`; absent means false
  };
  exports?: { formats: ExportFormat[]; delivery: "file" | "data" }; // what exportView writes, when it can
}
```

`exports.delivery` tells the grid how the file reaches the user: `"file"` sources write a new file at the
request's `target` (a server), `"data"` sources return its bytes (`ExportResult.data`). A source with
`capabilities.export` and no `exports` writes `csv`, `tsv`, `parquet` and `json` files.

## `ViewQuery`

```ts
interface ViewQuery {
  formulas?: { name: string; expression: string }[];      // formula columns, after the table's columns
  sort?: { column: number; direction: "asc" | "desc" }[]; // blanks last in both directions
  filters?: Filter[];                                     // all must match
  where?: FilterNode;                                     // a condition tree, combined with filters by AND
  search?: string;                                        // any table column contains it, ignoring case
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

/** `and`: every condition matches; `or`: at least one does. A group without conditions is left out. */
type FilterNode = Filter | { type: "and" | "or"; filters: FilterNode[] };

interface ViewInfo {
  id: string | null;      // null: the table in its original order
  rowCount: number;       // also while the view is building
  query: ViewQuery;
  status?: "building" | "ready" | "error"; // absent: ready
  readableRows?: number;  // rows readable now, from the start; absent: rowCount
  error?: string;         // why the build failed
}
```

The grid asks for views with `{ preview: true }`. A source may then answer a sort before every row is
ordered: `status: "building"` with the first `readableRows` rows, which must already be the first rows of
the finished view (break ties by the position in the table). The grid shows them right away, polls
`viewInfo` (or, without it, calls `createView` once more without the option, which waits), and makes the
rest readable once the view is `ready`. Until then, rows past `readableRows` show as loading; selecting and
scrolling work on every row, but copies and selection summaries that reach past them, find, and the
statistics of a view that filters wait. A source that ignores the option answers once the view is ready.

`where` adds what `filters` cannot express: OR across columns, nested groups and several conditions on
one column. "(region is Tokyo or sales over 100,000) and status is not cancelled":

```ts
const query: ViewQuery = {
  filters: [{ type: "values", column: 2, values: ["cancelled"], exclude: true }],
  where: {
    type: "or",
    filters: [
      { type: "values", column: 0, values: ["Tokyo"] },
      { type: "compare", column: 1, op: "gt", value: 100_000 },
    ],
  },
};
```

Each condition means what it means in `filters`. A source that evaluates `where` reports
`capabilities.conditions`; the grid sends condition trees only to such sources, so sources written before
condition trees existed keep working. A source can evaluate a tree with `matchesFilterNode(where, test)`,
where `test` is its own check of one filter, as `ArraySource` does; the
[protocol](/reference/protocol/#viewquery) has the limits on a tree's size.

`formulas` adds columns computed per row by an expression. Formula `i` is column `columns.length + i` of
the view, for every request that names the view; requests without a view do not have them, so a query
with only formulas makes a view in the table's order. A source that evaluates them reports
`capabilities.formulas`, checks them with `queryFormulas(info.columns, query)` (which throws
`invalid_request` for an unknown column, a type error or a cycle) and evaluates the checked trees, for
example with `formulaEvaluator`; see [Formula columns](/guides/formulas/#custom-sources).

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

## Groups and totals

```ts
type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

interface GroupRequest {
  view: string | null;          // the view's filters, condition tree and search decide the rows
  keys: number[];               // schema columns to group by; none: one row of totals
  aggregates: { fn: AggregateFunction; column?: number }[]; // `count` without `column` counts rows
  sort?: SortKey[];             // result columns; default: the keys ascending
  limit?: number;               // 1..100,000 groups, default 1,000
  pivot?: { columns: number[]; maxColumns?: number }; // cross tabulation: values of `columns` become columns
}
interface GroupResult {
  columns: ColumnSchema[];      // the keys, then `fn(column)` per aggregate (`count(*)` for rows)
  rows: CellValue[][];          // one array per group
  groups: number;               // all groups, also those past `limit`
  truncated: boolean;
  pivot?: { column: number; values: CellValue[]; aggregate: number }[]; // the generated columns
}
```

`GroupAccumulator` computes a result from batches of values, as `ArraySource` and `vastgrid-browser`
do; `checkGroupRequest`, `groupColumns`, `aggregateApplies` and `isGroupableType` check requests and
name results the same way. `GroupedSource` shows a result as a table of its own. [Grouping and
totals](/guides/grouping/) explains what keys, order, nulls and types mean.

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

type ExportFormat = "csv" | "tsv" | "parquet" | "json" | "xlsx";

interface ExportRequest {
  view: string | null;          // the view's filters, search and sort apply; null is the table
  format: ExportFormat;
  columns?: number[];           // schema column indexes, in the order to write them
  headers?: string[];           // header per column for csv, tsv and xlsx (parquet and json keep the names)
  numberFormats?: (string | null)[]; // xlsx: Excel number format code per column, null for the default
  target: string;               // interpreted by the host, or the file name for "data" sources
}
interface ExportResult { target: string; rows: number; data?: Blob }
```

The [protocol](/reference/protocol/#excel-export-rules) defines how `xlsx` writes numbers, dates, text
(never formulas) and `null`, and refuses more rows or columns than an Excel sheet holds with
`export_too_large`.

## Writing cells

```ts
interface UpdateRequest {
  updates: { row: number; column: number; value: CellValue; previous?: CellValue }[]; // at most MAX_UPDATE_CELLS (100,000)
  revision?: string; // the TableInfo.revision the rows were read with
}
interface UpdateResult {
  updated: number;
  edits: { version: number; cells: number }; // TableInfo.edits after the write
}
```

Sources that report `capabilities.edit` write cells with `updateCells`. `row` is the row's position in
the table (`RowBlock.rowIds`), `column` the schema index. The request is atomic: every update is written,
or none is and it rejects with a `SourceError` — `read_only` (the source or a column is not written),
`invalid_value` (a value does not fit its column), `edit_conflict` (a cell no longer holds its
`previous` value), `revision_changed` (the table has another `revision`) or `invalid_request`.

Writes keep row positions and the `revision`; they change `TableInfo.edits.version` instead, and sources
that report changes call their `subscribe` listeners with `{ edits }`. Every later request reads the new
values; views made before may keep their old rows and order, so the grid creates its view again when its
query uses a written column. Columns the source does not write have `readOnly: true` in their schema.

Sources that report `capabilities.save` also save the written cells into the file they read with
`saveEdits` (the DuckDB server with `saveFiles`). It rejects with `file_changed` when the file was changed
by someone else since it was read, and `save_unsupported` when the file cannot be written back; the
table keeps its revision and row positions, and its cells count as saved (`edits.cells` is 0).

`parseCellInput(text, column)` reads typed text as a column's type, and `normalizeCellValue(value,
column)` checks a value written by a program the same way; both keep 64-bit integers and decimals as
text. `editableType(type)`, `editableColumn(schema)`, `editText(value)` and `sameCellValue(a, b)` help
sources and editors. See [Editing cells](/guides/editing/).

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
| `isEmptyQuery(query)` | Whether a query has no sort, filters, condition tree or search. |
| `filtersRows(query)` | Whether a query leaves out rows (filters, a condition tree or a search), rather than only sorting. |
| `matchesFilterNode(node, test)` | Whether a condition tree holds, given a check of one filter. |
| `pruneFilterNode(node)`, `mapFilterNode(node, map)` | A tree without empty groups; a tree with its filters replaced or removed. |
| `filterLeaves(node)`, `queryFilters(query)`, `queryCondition(query)` | The filters of a tree or a query; a query's `filters` and `where` as one tree. |
| `isFilterGroup(node)` | Whether a node is an `and` or `or` group. |
| `plainText(value)` | A value's text for the clipboard: no grouping, no truncation. |
| `numericValue(value, type)` | A value as a JavaScript number, or `null`. |
| `ValueFormatter` | Formats values for display in a locale, as the grid does. |
| `toTsv`, `toHtmlTable`, `toMarkdownTable` | Serialize rows of values as the grid's copies do. |
| `parseTsv(text)`, `parseHtmlTable(html)` | Read rows of cells from the clipboard: tab-separated values as spreadsheets copy them (quoted fields with tabs and line breaks), and the first HTML table (`colspan` and `rowspan` filled), without a DOM. |
| `copyLayout(ranges)` | The rows and columns that a copy of several ranges writes, or null when they cannot be copied together. |
| `isNumericType(type)`, `isTemporalType(type)` | Group column types. |
| `parseProtocolRequest(body)` | Validates a protocol request, for servers. |
| `writeTableFile(format, columns, rows, options?)` | Writes `csv`, `tsv`, `json` or `xlsx` from batches of rows as a stream of bytes, for sources that export themselves. |
| `writeXlsx(columns, rows, options?)` | Writes an Excel workbook as a stream, without dependencies. `options.deflate` compresses (`browserDeflate()` uses `CompressionStream`). |
| `excelNumberFormat(schema, format, options?)` | The Excel number format code for a column's `ColumnFormat`, or `null`. |
| `checkXlsxSize(rows, columns)`, `XLSX_MAX_ROWS`, `XLSX_MAX_COLUMNS`, `XLSX_MAX_TEXT` | Excel's limits. |
| `EXPORT_EXTENSIONS`, `EXPORT_MEDIA_TYPES` | File extension and media type of each export format. |
| `RowCache`, `ScrollAxis`, `SelectionModel`, `ColumnLayout` | The grid's building blocks, framework-free, for building another grid. |
