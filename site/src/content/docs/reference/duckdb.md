---
title: vastgrid-duckdb
description: TableEngine, the request handlers and the helpers of vastgrid-duckdb.
---

```ts
import { createTableHandler, TableEngine } from "vastgrid-duckdb";
```

[Files on a server](/guides/server/) shows how the pieces fit together.

## `TableEngine`

```ts
const engine = await TableEngine.create(options: TableEngineOptions);
```

Opens table files with DuckDB and answers the protocol for them. One engine serves any number of
clients and files; create one per process.

| Option | Default | Description |
| --- | --- | --- |
| `allowedDirectories` | (required) | Directories DuckDB may read and export into. All other file access is disabled for good. |
| `tempDirectory` | (required) | Where the engine keeps its database file, data spilled from memory and converted files, in a folder of its own that `dispose()` deletes. |
| `memoryLimit` | a fifth of the memory, 1–4 GB | DuckDB's memory limit, for example `"4GB"`. |
| `threads` | CPUs − 1 | DuckDB's worker threads. |
| `maxTables` | `4` | Tables kept open; the least recently used ones are closed beyond this. |
| `maxViews` | `2` | Sorted or filtered views kept per table. |
| `materializeRows` | `20000000` | Above this many rows, views hold the order of the rows instead of a sorted copy. |
| `viewPreviewMinRows` | `1000000` | Sorts of tables with at least this many rows show their first rows before the whole view is built (see below). |
| `viewPreviewRows` | `1000` | Rows of such a sort that are readable before the view is ready. |
| `abandonedViewTimeout` | `3000` | A background build stops when another view of the table waits and nobody asked for this one for this many milliseconds. |
| `previewRows` | `1000` | Rows readable while a delimited or JSON file is still loading. |
| `textLimit` | `2000` | Longest text sent for a cell by default. |
| `log` | | `(message, error?) => void`, for problems that are not caused by a request. |

| Method | Description |
| --- | --- |
| `open(path, format?)` | Opens a file, or returns the table already open for it, and starts loading it. Returns an `OpenTable`. The path must be inside the allowed directories, links followed. |
| `get(id)` | The open table with this handle, or a `table_not_found` error. |
| `close(id)` | Closes a table and its views. |
| `allows(path)` | Whether an absolute path, as written, is inside the allowed directories. `open` also checks the real location. |
| `dispose()` | Closes every table and the database, and deletes the engine's temporary files. |

An `OpenTable` has the methods of a `TableSource` (`info`, `createView`, `readRows`, `columnStats`,
`distinctValues`, `aggregate`, `find`, and `exportView(request, target)`), its `id`, and `whenReady()`, a
promise for the end of the load. The handlers below call them; use them directly to work with tables on
the server.

## `createTableHandler(options)`

Returns `(request: Request) => Promise<Response>`, a Fetch API handler for the protocol: it accepts
`POST` requests with a JSON body and answers `{ result }` or `{ error: { code, message } }` with the
matching status.

| Option | Description |
| --- | --- |
| `engine` | `TableEngine \| (() => TableEngine \| Promise<TableEngine>)`. |
| `resolve(ref)` | Returns the absolute path of the file a request names, or a promise of it. Throw to refuse. |
| `resolveTarget(target)` | Returns the absolute path of a new file for an export. Without it, exports are refused. |
| `onError(error)` | Receives errors that are not caused by the request, for logging. |

## `handleTableRequest(body, options, signal?)`

Answers one request whose JSON body is already parsed, with the same options. Returns the `result`, or
throws. `errorBody(error, onError?)` turns what it throws into `{ status, body }` to send, so that
frameworks without Fetch API requests answer exactly as `createTableHandler` does.

## Helpers

| Export | Description |
| --- | --- |
| `tableFormatOf(path)` | The format of a file judged by its extension (`csv`, `tsv`, `parquet`, `ndjson`, `json`), or `null`. Use it to list the files a user can open. |
| `detectEncoding(path)` | Detects the text encoding of a delimited file from its first megabytes: `utf-8`, `utf-16`, `shift_jis`, `euc-jp` or `latin-1`. |
| `convertToUtf8(source, target, encoding, signal?)` | Converts a file to UTF-8, replacing invalid bytes. |
| `columnTypeOf(sqlType)` | The `ColumnType` of a DuckDB type name. |
| `quoteIdentifier(name)` | Quotes a name for DuckDB SQL. |
