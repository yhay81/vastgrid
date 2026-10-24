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
| `export` | `table`, `view`, `format` (`csv`, `tsv`, `parquet`, `json`), optional `columns`, `target` | `{ target, rows }` |
| `revision` | `table` | `{ revision: string \| null }`, the data's current revision (see [Watching for changes](#watching-for-changes)) |
| `close` | `table` | `null` |

`rowIds` are the rows' positions in the table (0-based) for a view, and `null` without one (the
positions are then `start` to `end`). They must name the same records for as long as the table's
`revision` stays the same — a table whose data changed must report a new `revision` — because the grid
uses them as the keys of checked rows. A `rows` request with no `columns` reads only the positions.

A `rows` request reads at most 1,000,000 rows and 1,000,000 cells (rows × columns); read more in parts.
View requests on one table are built one at a time and never cancel each other. `distinct` counts
whole values and sends them whole (up to 1,000,000 characters), so that a value from its list works in
a `values` filter.

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
}
```

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
| `disposed` | 503 | The server closed its table engine (for example while it shuts down). |
| `internal_error` | 500 | Anything else. |
