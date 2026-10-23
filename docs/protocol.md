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

## Operations

| `op` | Fields | Result |
| --- | --- | --- |
| `info` | `ref` (what to open, in the host's terms), optional `table` | `TableInfo` plus `table` |
| `view` | `table`, `query` | `{ id, rowCount, query }` (`id: null` for an empty query) |
| `rows` | `table`, `view`, `start`, `end`, `columns`, optional `textLimit` | `{ start, end, columns: CellValue[][], rowIds }` |
| `stats` | `table`, `view`, `column` | `ColumnStats` |
| `distinct` | `table`, `view`, `column`, optional `search`, `limit` | `{ values: { value, count }[], truncated }` |
| `aggregate` | `table`, `view`, `ranges: { start, end, columns }[]` | `{ count, numericCount, sum, min, max, average }` |
| `find` | `table`, `view`, `text`, `columns`, `row`, `column`, `direction` (`1` or `-1`), optional `caseSensitive` | `{ row, column }` or `null` |
| `export` | `table`, `view`, `format` (`csv`, `tsv`, `parquet`, `json`), optional `columns`, `target` | `{ target, rows }` |
| `close` | `table` | `null` |

A `rows` request reads at most 1,000,000 rows and 1,000,000 cells (rows × columns); read more in parts.
View requests on one table are answered one at a time and never cancel each other. `distinct` counts
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
  format?: string;             // csv, tsv, parquet, ndjson, …
  byteSize?: number;
  revision?: string;           // changes when the data changes
  notes?: string[];            // encoding:shift_jis, all_varchar, invalid_utf8_replaced
  capabilities: { sort, filter, search, stats, distinct, aggregate, find, export: boolean };
}
```

Clients poll `info` while `status` is `loading` and only read rows below `readableRows`. When the load
fails, `info` answers `status: "error"` with the reason in `error`; the `info` after that loads the file
again, so that clients can retry.

### Values

A `CellValue` is `string | number | boolean | null`. Numbers that JSON cannot carry exactly (64-bit
integers beyond 2^53, decimals, `NaN`, `Infinity`) are strings. Dates and times are ISO-like strings
(`2024-01-31`, `2024-01-31 12:34:56`). Nested and binary values are their text representation. Text
longer than `textLimit` (default 2,000 characters) ends with `…`.

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

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request does not match the protocol. |
| `table_not_found` | 404 | Unknown table handle. Reopen with `info`. |
| `view_not_found` | 404 | Unknown view. Create it again. |
| `not_ready` | 409 | The table is still loading. |
| `cancelled` | 409 / 499 | The client went away, or the server closed the table while the request ran (for example because the file changed). |
| `load_failed` | 422 | The file could not be read; `message` explains why. |
| `query_failed` | 422 | A filter value does not fit the column (for example text compared with a number). |
| `unsupported_format` | 415 | Not a table file. |
| `not_found` | 404 | The file does not exist. |
| `not_allowed` | 403 | The file, or the folder of an export, is outside the folders the server may use (links are followed). |
| `export_disabled` | 403 | The host did not enable exports. |
| `internal_error` | 500 | Anything else. |
