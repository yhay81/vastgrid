# The vastgrid table protocol

`RemoteSource` (in `vastgrid-core`) talks to a table server with this protocol, and
`createTableHandler` / `handleTableRequest` (in `vastgrid-duckdb`) implement it. Any server can speak
it; `parseProtocolRequest` in `vastgrid-core` validates incoming requests.

## Transport

Every request is a `POST` of a JSON object to one endpoint, with `content-type: application/json`.

- Success: status `200` and `{ "result": … }`.
- Failure: an error status and `{ "error": { "code": "…", "message": "…" } }`. `code` is stable and meant
  for programs; `message` is for people and may be localized by the host. Messages name files without
  the server's folders.

## Coordinates

- `row` is a position in a view (0-based). The table itself is the view `null`.
- `column` is an index into the table schema (`columns` of `info`), never a display position, so that
  hiding or reordering columns in the UI does not change what is asked for. A list of `columns` names
  each column at most once.
- Ranges are `[start, end)`.

## Handles

`info` returns a `table` handle; the other operations use it. `view` returns a view `id`. Servers may
forget both (restart, file changed, memory limits) and answer `table_not_found` or `view_not_found`;
`RemoteSource` then reopens the table with `info` and recreates the view with the same query. A file
that changed gets a new handle and a new `revision`.

## Watching for changes

`revision` answers the current revision of a table's data without reading it again. Once it differs from
the `revision` that `info` answered, the data changed, and the next `info` with the same `ref` opens the
new data (a new handle; views are created again). `RemoteSource` asks for it every 2 seconds while a grid
subscribes (`TableSource.subscribe`), and the grid then reads the table again with its query and column
settings. Only the whole table is reported, not which rows changed. A server that does not know the
request answers `invalid_request`, and `RemoteSource` stops asking. After failed requests (the server was
unreachable or restarted), the first answer is compared with the revision read last, so changes made
meanwhile are reported once.

`vastgrid-duckdb` builds the revision of a file from its size, its modification time and a hash of its
first 64 KiB, so that appended rows and a rewrite within the resolution of the modification time are both
seen. It answers `null` when the file is gone.

## Operations

| `op` | Fields | Result |
| --- | --- | --- |
| `info` | `ref` (what to open, in the host's terms), optional `table`, optional `read` | `TableInfo` plus `table` |
| `view` | `table`, `query`, optional `preview` | `ViewInfo`: `{ id, rowCount, query, status, readableRows, error? }` (`id: null` for an empty query) |
| `status` | `table`, `view` | `ViewInfo` of a view, for polling while it is `building` |
| `rows` | `table`, `view`, `start`, `end`, `columns`, optional `textLimit` | `{ start, end, columns: CellValue[][], rowIds }` |
| `stats` | `table`, `view`, `column` | `ColumnStats` |
| `distinct` | `table`, `view`, `column`, optional `search`, `limit` | `{ values: { value, count }[], truncated }` |
| `aggregate` | `table`, `view`, `ranges: { start, end, columns }[]` | `{ count, numericCount, sum, min, max, average }` |
| `find` | `table`, `view`, `text`, `columns`, `row`, `column`, `direction` (`1` or `-1`), optional `caseSensitive` | `{ row, column }` or `null` |
| `export` | `table`, `view`, `format` (`csv`, `tsv`, `parquet`, `json`, `xlsx`), optional `columns`, `headers`, `numberFormats`, `target` | `{ target, rows }` |
| `revision` | `table` | `{ revision: string \| null }`, the data's current revision (see [Watching for changes](#watching-for-changes)) |
| `close` | `table` | `null` |

A `rows` request reads at most 1,000,000 rows and 1,000,000 cells (rows × columns); read more in parts.
View requests on one table are built one at a time and never cancel each other. `distinct` counts
whole values and sends them whole (up to 1,000,000 characters), so that a value from its list works in
a `values` filter.

An `export` writes the rows of the view (`view: null` for the table) in the view's order: its filters,
search and sort apply. `columns` picks the schema columns and their order (default: all, in schema
order). `headers` (one string per written column) replaces the column names in the header row of `csv`,
`tsv` and `xlsx`; `parquet` and `json` keep the schema names. `numberFormats` (one Excel number format
code or `null` per column, at most 255 characters) applies to `xlsx` only. The server resolves `target`
to a new file in its allowed folders and writes it under a temporary name first, so a cancelled or failed
export leaves nothing behind. An export holds one revision of the file: when the server closes the table
(for example because the file changed and was opened again) or finds at the end that the file changed, it
deletes the partial file and answers `cancelled`. `xlsx` refuses more than 1,048,575 rows (one sheet with a header row) or
16,384 columns with `export_too_large`; see [Excel export rules](#excel-export-rules).

### `TableInfo`

```ts
{
  columns: { name: string; type: ColumnType; sourceType?: string }[];
  rowCount: number | null;     // null while loading
  readableRows: number;        // rows readable now (a preview of the beginning while loading)
  status: "loading" | "ready" | "error";
  progress?: number | null;    // 0..1 while loading
  error?: string;
  format?: string;             // csv, tsv, parquet, ndjson, xlsx, …
  byteSize?: number;
  revision?: string;           // changes when the data changes
  notes?: string[];            // encoding:shift_jis, all_varchar, invalid_utf8_replaced, merged_cells, formulas_without_values
  sheets?: { name: string; hidden?: boolean }[]; // workbooks: the sheets, in workbook order
  sheet?: string;              // workbooks: the sheet that was read
  capabilities: { sort, filter, search, stats, distinct, aggregate, find, export: boolean };
  exports?: { formats: ExportFormat[]; delivery: "file" | "data" }; // what export can write, when it can
}
```

`exports` lists the formats `export` writes. `delivery: "file"` means the server writes a file at the
resolved `target`; `"data"` is for in-process sources (such as `ArraySource`) that return the file in
`ExportResult.data`. A server without `exports` that has `capabilities.export` writes `csv`, `tsv`,
`parquet` and `json` files.

### `ReadOptions`

`read` in `info` chooses how to read a file that needs a choice; today only workbooks (`xlsx`) use it, and
servers ignore it for other formats. The same file read with other options is another table, with its own
handle.

```ts
{
  sheet?: string;              // the sheet's name; default: the first visible sheet
  headerRow?: number;          // 1-based row with the column names; 0: none (columns A, B, …); default: the first row with a value
  keepEmptyRows?: boolean;     // keep rows without values between data rows; default false
  keepEmptyColumns?: boolean;  // keep columns without values or names; default false
}
```

Workbooks list `sheets` from the first `info` answer, while the sheet still loads.

Clients poll `info` while `status` is `loading` and only read rows below `readableRows`. When the load
fails, `info` answers `status: "error"` with the reason in `error`; the `info` after that loads the file
again, so that clients can retry.

### `ViewInfo` and previews of sorts

```ts
{
  id: string | null;
  rowCount: number;            // rows in the view, also while it is building
  query: ViewQuery;
  status?: "building" | "ready" | "error";   // absent means ready
  readableRows?: number;       // rows readable now, from the start of the view; absent means rowCount
  error?: string;              // why the build failed, with status "error"
}
```

A `view` request waits until the view is ready. With `preview: true`, a server may answer a sort sooner,
with `status: "building"`: the first `readableRows` rows are known and already in their final order, and
the rest is built in the background. Rules:

- The rows of a view are in the order of `sort`, ties broken by the rows' positions in the table, so
  that a view of a query always has the same order, the rows of a preview are the first rows of the
  finished view, and a view recreated after the server forgot it has the same rows.
- Clients poll `status` (or send the same `view` request again) while `status` is `building`, and only
  read rows below `readableRows`. `rows` at or past `readableRows` answers `not_ready`; a range that
  starts below it ends there.
- While a view is building, `stats` and `distinct` work for a view that only sorts (it has the rows of
  the table) and answer `not_ready` for one that filters or searches; `aggregate` works for ranges below
  `readableRows`; `find` and `export` answer `not_ready`.
- A view that is ready keeps its `id`. A server may stop a build that nobody follows (no request for
  the view for a while) when another view of the table waits for its turn, and forget the view: `status`
  then answers `view_not_found`, and asking for the view again starts over. A build that fails gives
  `status: "error"`; the next `view` request for the query builds it again.
- `vastgrid-duckdb` previews sorts of tables with at least `viewPreviewMinRows` rows (1M by default) and
  makes the first `viewPreviewRows` rows (1,000) readable first. Servers that do not preview answer
  `view` requests with `preview` as before, once the view is ready.

### Values

A `CellValue` is `string | number | boolean | null`. Numbers that JSON cannot carry exactly (64-bit
integers beyond 2^53, decimals, `NaN`, `Infinity`) are strings. Dates and times are ISO-like strings
(`2024-01-31`, `2024-01-31 12:34:56`). Nested and binary values are their text representation. Text
longer than `textLimit` (default 2,000 characters) ends with `…`. Servers send at most 1,000,000
characters for a cell (`MAX_TEXT_LIMIT` in `vastgrid-core`); clients ask for that much to read whole
values.

### `ViewQuery`

```ts
{
  sort?: { column: number; direction: "asc" | "desc" }[];   // blanks last in both directions
  filters?: Filter[];                                       // all must match
  search?: string;                                          // any column contains it, case-insensitive
}

type Filter =
  | { type: "values"; column; values: CellValue[]; exclude?: boolean }  // null matches blanks
  | { type: "compare"; column; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; value }
  | { type: "between"; column; min?; max? }                           // inclusive
  | { type: "text"; column; op: "contains" | "notContains" | "startsWith" | "endsWith" | "equals" | "notEquals"; value: string; caseSensitive?: boolean }
  | { type: "blank"; column; blank: boolean };                        // blank: null or ""
```

## Error codes

`ErrorCodes` in `vastgrid-core` has a constant for each of these codes.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request does not match the protocol. |
| `method_not_allowed` | 405 | The request is not a `POST`. |
| `table_not_found` | 404 | Unknown table handle. Reopen with `info`. |
| `view_not_found` | 404 | Unknown view. Create it again. |
| `not_ready` | 409 | The table is still loading, or the view is still building and cannot answer this yet. |
| `cancelled` | 409 / 499 | The client went away, or the server closed the table while the request ran (for example because the file changed). |
| `load_failed` | 422 | The file could not be read; `message` explains why. |
| `query_failed` | 422 | A filter value does not fit the column (for example text compared with a number). |
| `unsupported_format` | 415 | Not a table file. |
| `not_found` | 404 | The file does not exist. |
| `not_file` | 400 | The path is not a file (for example a folder). |
| `not_allowed` | 403 | The file, or the folder of an export, is outside the folders the server may use (links are followed). |
| `export_disabled` | 403 | The host did not enable exports. |
| `export_too_large` | 413 | The rows or columns do not fit in the format (an Excel sheet), or the workbook would pass 4 GB. |
| `disposed` | 503 | The server closed its table engine (for example while it shuts down). |
| `internal_error` | 500 | Anything else. |

## Excel export rules

`xlsx` files have one sheet: a bold, frozen header row, then one row per table row. They are written
as a stream (one chunk of rows at a time), so the server's memory does not grow with the table.

| Value | Cell |
| --- | --- |
| Numbers | Number cells. Numeric text that a double cannot hold exactly (more than 15 significant digits, for example 64-bit IDs and long decimals) stays text, so no digit changes. `NaN` and `Infinity` are text. |
| Booleans | Boolean cells. |
| Dates, times, timestamps | Date serial numbers with the format `yyyy-mm-dd`, `hh:mm:ss` or `yyyy-mm-dd hh:mm:ss` (or the requested `numberFormats`). Timestamps with a time zone are written in UTC. Values Excel cannot show as dates (before 1900-03-01 or after 9999) stay text. |
| Text | Always text, never a formula, also when it starts with `=`, `+`, `-` or `@`. Text longer than 32,767 characters (Excel's limit) is cut and ends with `…`. Characters XML cannot hold are written as `_xHHHH_`. |
| Other types (intervals, UUIDs, lists, structs, binary) | Their text. |
| `null` | An empty cell. |

`csv` and `tsv` write values as they are: spreadsheet apps may read text that starts with `=` as a
formula when they open such files, so prefer `xlsx` for files that go to spreadsheet users.
