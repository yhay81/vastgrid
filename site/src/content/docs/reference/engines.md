---
title: Engines
description: The memory engine of vastgrid-js and the DuckDB engine of vastgrid-duckdb, their options and what each offers.
---

An engine opens tables and answers the grid's messages
([§8 of the specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#8-messages)): it makes the
views of plans, reads blocks of rows, writes cells and exports files. The grid reaches it through a transport
([`vastgrid/core`](/reference/core/#transports)). Two engines come with vastgrid:

| | `vastgrid-js` | `vastgrid-duckdb` |
| --- | --- | --- |
| Runs | in the page, in a Web Worker or in Node.js | in Node.js |
| Tables | rows of typed JSON, Arrow, CSV, TSV, JSON Lines, Excel and Parquet files | CSV, TSV, JSON, JSON Lines and Parquet files, also compressed, and Excel workbooks |
| Size | within the memory of the page (`maxBytes`); Parquet read by row groups | any: DuckDB spills to disk, Parquet is read in place |
| Writes cells | tables given with `editable: true` | every file, kept apart from it |
| Saves into the file | no | CSV and TSV, with `saveFiles: true` |
| Exports | CSV, TSV, JSON, Excel, answered as the file's bytes | CSV, TSV, Parquet, JSON, Excel, written on the server |

Any object with `handle` (and, for events, `subscribe`) is an engine: see
[Your own engine](/guides/custom-engine/).

```ts
interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}
```

## Capabilities

`open` answers a `TableInfo` with the table's `capabilities`
([§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#410-capabilities)). The grid offers only
what they say: no Save button without `save`, no Group menu without `plan.aggregate`, the export formats of
`export.formats`.

| Member | Value | Meaning |
| --- | --- | --- |
| `plan` | `{ derive, where, aggregate, pivot, having, sort, search }`, booleans | the members of a plan the engine evaluates; absent ones are true |
| `functions`, `measures` | names | the functions (§4.4) and measures (§4.5) it evaluates; all when absent |
| `summarize`, `find`, `locate` | booleans | the selection's sum, the find bar, keeping the active row when the view changes |
| `write` | boolean | cells can be written (§7.2) |
| `save` | boolean | written cells can be saved into the table's file (§7.5) |
| `export` | `{ formats, delivery }` | the formats of `export`, and whether the file is written on the server (`file`) or answered as bytes (`data`) |
| `preview` | boolean | a large sort can show its first rows before it ends (§9) |
| `partialViews` | boolean | plans other than `{}` are read while the table loads |
| `changes` | `"push"` or `"poll"` | whether the engine sends events (§8.5) or the client asks with `changes` |

| Capability | Memory engine | DuckDB engine |
| --- | --- | --- |
| `plan` | every member | every member |
| `functions`, `measures` | all of §4.4 and §4.5 | all of §4.4 and §4.5 |
| `summarize`, `find`, `locate` | yes | yes |
| `write` | tables with `editable: true` | yes |
| `save` | no | with `saveFiles`, for CSV and TSV files that are not compressed |
| `export` | `csv`, `tsv`, `json`, `xlsx`; `data` | `csv`, `tsv`, `parquet`, `json`, `xlsx`; `file` |
| `preview` | no | yes, for sorts of 1,000,000 rows or more |
| `partialViews` | no | no |
| `changes` | `poll` (it also sends `changed` after a write) | `push` |

## The memory engine: `vastgrid-js`

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({
  tables: {
    people: {
      columns: [
        { name: "name", type: "string" },
        { name: "born", type: "integer" },
      ],
      rows: [
        ["Ada Lovelace", 1815],
        ["Grace Hopper", 1906],
      ],
      editable: true,
    },
    sales: { parquet: "https://example.com/sales.parquet" },
  },
});
```

`memoryEngine(options)` gives a `MemoryEngine`: `handle(message)` answers a request with its response or error and
never throws (`cancel` has no answer), and `subscribe(listener)` follows its events. Blocks are in the structured
encoding (`{ bytes }`), as `localTransport` and `workerTransport` carry them.

| Option | Type | Description |
| --- | --- | --- |
| `tables` | `Record<string, table>` | The tables that `open` opens, by the `ref` that names them. Each is one of the kinds below. |

### Rows: `MemoryTable`

| Member | Type | Description |
| --- | --- | --- |
| `columns` | `Column[]` | `{ name, type }` with the members of its type ([§2.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#21-logical-types)): `precision` and `scale` of a `decimal`, `bits` of a `float`, `unit` of a `timestamp`; optionally `sourceType` and `readOnly`. |
| `rows` | `JsonValue[][]` | One array per row, in row ID order, of typed JSON values ([§2.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json)): decimals as strings with their scale (`"12.50"`), bigints beyond 2^53 as strings, dates as `"2024-01-31"`, timestamps as `"2024-01-31 12:00:00"`. |
| `editable` | `boolean` | `write` writes the table's cells. Written values are kept apart from `rows`. |

The rows are used as they are, without a copy: they must not change afterwards. Their form is checked when the
table is first opened, and their values as they are read; a table that does not follow §2 is answered with
`load_failed` and the JSON Pointer of the place at fault.

### Apache Arrow: `ArrowTable`

| Member | Type | Description |
| --- | --- | --- |
| `arrow` | `Uint8Array` | The bytes of an Arrow IPC stream or file, of any number of record batches. |
| `editable` | `boolean` | As for rows. |

Columns get the logical types of their Arrow types and are kept as Arrow holds them: numbers, dates and times in
typed arrays, the others read from their buffers when they are asked for. Lists, structs and other types without a
logical type fail with `load_failed` at `/arrow`.

### Text files and workbooks: `FileTable`

| Member | Type | Default | Description |
| --- | --- | --- | --- |
| `file` | `TextFile` (a `Blob` or a `File`) | (required) | The file, read in slices without a copy of it whole. |
| `format` | `"csv" \| "tsv" \| "jsonl" \| "xlsx"` | from the name | `.csv`; `.tsv` or `.tab`; `.jsonl` or `.ndjson`; `.xlsx` or `.xlsm`. |
| `delimiter` | `string` | the one of `,`, tab, `;` and `\|` that splits the first line into the most fields | The separator of a CSV file, one character. |
| `header` | `boolean` | `true` | Whether the first line of a CSV or TSV file names the columns. |
| `maxBytes` | `number` | 1 GiB | The most memory the table's columns may take. A larger file is not kept: its rows are read by blocks of 1,024, and its columns whole as requests need them, within this. |
| `editable` | `boolean` | `false` | As for rows. |

A file is read when it is first opened, into typed columns: each column takes the first of `boolean`, `integer`,
`bigint`, `float`, `time`, `date`, `timestamp` and `timestamptz` that every value fits, and is a `string`
otherwise. A workbook's sheet is chosen by `open`'s `read` (`sheet`, `headerRow`, `keepEmptyRows`,
`keepEmptyColumns`), and `TableInfo` lists its `sheets`; its columns have the types the DuckDB engine gives them.
Text that is not UTF-8, a UTF-16 file, and an encrypted or `.xls` workbook fail with `load_failed`.

### Parquet files

| Member | Type | Default | Description |
| --- | --- | --- | --- |
| `parquet` | `TextFile \| string` | (required) | A `Blob` or a `File`, or the URL of a file whose server answers HTTP range requests. |
| `headers` | `Record<string, string>` | | Headers of every request for a URL, such as `Authorization`. |
| `fetch` | `(url, init) => Promise<response>` | the global `fetch` | A function that fetches as `fetch` does. |
| `maxBytes` | `number` | 1 GiB | About the most memory the columns read whole may take. |
| `editable` | `boolean` | `false` | As for rows. |

Opening reads the footer only. Rows are read by the row groups that hold them; a sort, a filter, a group or a
summary reads the columns it names whole. Columns have the types DuckDB reads them as, with DuckDB's names as
`sourceType`; lists, structs and maps are read-only strings of their JSON text. A server of another origin must
expose `Content-Length`, `Content-Range` and `ETag` by CORS, and a file whose `ETag` or `Last-Modified` changes
fails with `file_changed`. See [Large files in the browser](/guides/browser/).

### What it exports

`vastgrid-js` exports `memoryEngine`, `MEMORY_CAPABILITIES` and the types `MemoryEngine`, `MemoryEngineOptions`,
`MemoryTable`, `ArrowTable`, `FileTable`, `TextFile` and `TextFormat`.

- `save` fails with `save_unsupported`: the engine writes no file, and the `File` a table came from stays as it was.
- `export` answers the file's bytes (`delivery` `data`) and takes no `target`; the grid downloads them. Parquet
  exports fail with `invalid_request` at `/format`.
- A request that goes through many rows lets other messages in every 40 ms or so, so that a `cancel` stops it
  with `cancelled`.

## The DuckDB engine: `vastgrid-duckdb`

```ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });

createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

It needs Node.js 20 or later on a platform DuckDB ships a binary for (`@duckdb/node-api`): Linux (x64 or arm64,
glibc or musl), macOS (x64 or arm64) or Windows (x64 or arm64). See [Files on a server](/guides/server/).

### `DuckDBEngine.create(options)`

Returns a promise of the engine.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedDirectories` | `string[]` | (required) | Folders whose files may be opened. DuckDB reads no other files, by their real location, and this cannot change while it runs. |
| `tempDirectory` | `string` | (required) | Where the engine keeps its database, data spilled from memory and converted files, in a folder of its own that `dispose` deletes. Folders left by processes that ended without it are deleted on the next start. |
| `resolve` | `(ref) => string \| Promise<string>` | a path; relative ones inside the first allowed folder | The file that a `ref` of `open` names. Throw to refuse it (`not_allowed`). |
| `resolveTarget` | `(target) => string \| Promise<string>` | | The file that the `target` of `export` names, inside the allowed folders and not a file a table reads. Without it, exports name no target and the engine keeps them (`exportFile`). |
| `saveFiles` | `boolean` | `false` | Lets `save` write written cells into the CSV and TSV files they came from, keeping every byte that holds no edited field. Off, the engine never changes a file. |
| `watchFiles` | `boolean` | `true` | Follows the files of open tables: a file that changes on disk is read again, or reported with `fileChanged` when its table has written cells. |
| `memoryLimit` | `string` | a fifth of the system's memory, 1–4 GB | DuckDB's memory limit, such as `"4GB"`. |
| `maxTempDirectorySize` | `string` | `"8GB"` | The most that DuckDB's spill files may take (not the database or converted files). |
| `threads` | `number` | CPUs minus one | DuckDB's threads. |
| `maxTables` | `number` | `4` | Tables kept loaded once no handle uses them, for opening them again. |
| `previewRows` | `number` | `1000` | Rows of a delimited or JSON file readable while it loads. |
| `textLimit` | `number` | `2000` | The longest text of a string that `rows` gives without its own `textLimit`. |
| `maxViews` | `number` | `8` | Views kept per engine; requests reading a view keep it until they finish. |
| `materializeRows` | `number` | `20000000` | Input rows above which a view keeps only the row IDs in its order, not a sorted copy. |
| `viewPreviewMinRows` | `number` | `1000000` | Input rows from which a sort gives its first rows before it ends. |
| `viewPreviewRows` | `number` | `1000` | Rows of such a preview. |
| `log` | `(message, error?) => void` | | Receives problems that no request caused, for logs. |

### Methods

| Method | Description |
| --- | --- |
| `handle(message, { signal }?)` | Answers a request (§8.1) with its response or error response, or nothing for `cancel`; never throws for a bad message. `signal` cancels the request as `cancel` does. Blocks are in the structured encoding. |
| `subscribe(listener)` | Follows the events of the engine's tables (§8.5): `changed`, `progress` and `view`. Returns the function that stops. |
| `exportFile(name)` | The file of an export that named no target, by the name its answer gave: `{ path, fileName, mediaType, size }` (`KeptExport`), or null once it is gone. At most 16 are kept, for an hour. |
| `whenLoaded(id)` | Waits until the table of a handle (the `table` of `TableInfo`) has loaded, or failed to. |
| `dispose()` | Closes every table and the database, and deletes the engine's files. |

In the same process, `localTransport(engine)` of `vastgrid/core` carries the grid's messages to it.

### `createHttpHandler(engine, options?)`

Gives a handler of Node.js `http` requests, `(request, response, next?)`, which also works as Connect or Express
middleware: requests to other paths go to `next`, or get 404 without it.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"/"` | The path that requests are posted to. |
| `events` | `string` | `path` + `events` | The path of the Server-Sent Events. |
| `exports` | `string` | `path` + `exports/` | The path under which exports without a target are downloaded. |
| `maxBody` | `number` | 64 MiB | The largest body of a request; larger ones get 413. |
| `keepAlive` | `number` | 15,000 | Milliseconds between the comments that keep the stream of events open. |

| Route | Answer |
| --- | --- |
| `POST <path>` | The response to the JSON request in the body: JSON, or, for `rows` and `export` when the request accepts `application/vnd.vastgrid.v2+arrow`, the JSON with its block attached (§8.8). Errors are JSON with the HTTP status of [§8.7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#87-errors); `cancel` gets 204. A client that goes away cancels its request. |
| `GET <events>` | The engine's events as Server-Sent Events. |
| `GET <exports><name>` | The file of an export as a download named after the table, or 404. |

`httpTransport("/api", { events: "/api/events" })` is the grid's side of it.

### Formats

| Format | Files | Read |
| --- | --- | --- |
| CSV | `.csv`, `.csv.gz`, `.csv.zst` | into DuckDB; the first rows are readable at once while the rest loads |
| TSV | `.tsv`, `.tab`, `.tsv.gz`, `.tsv.zst` | as CSV |
| JSON Lines | `.jsonl`, `.ndjson`, `.jsonl.gz`, `.ndjson.gz` | into DuckDB |
| JSON | `.json`, `.json.gz` | into DuckDB |
| Parquet | `.parquet`, `.pq` | in place, by row numbers |
| Excel | `.xlsx`, `.xlsm` | a sheet into DuckDB; `open`'s `read` chooses `sheet`, `headerRow`, `keepEmptyRows` and `keepEmptyColumns` |

Text encodings (UTF-16, Shift_JIS, EUC-JP and others) are found and converted, and files whose types change late
fall back to wider types. Exports write CSV, TSV, Parquet, JSON and Excel; an Excel export holds at most
1,048,575 rows and 16,384 columns (`export_too_large`).

### Other exports

| Name | Description |
| --- | --- |
| `CAPABILITIES` | The engine's capabilities; `save` is true only for files that `saveFiles` lets it save. |
| `findTableFiles(folders, limit)` | The table files of folders, as full paths, two folders deep, without hidden files and folders, at most `limit`. |
| `tableFormatOf(file)` | The format of a file by its name (`TableFormat`: `csv`, `tsv`, `parquet`, `json`, `ndjson`, `xlsx`), or null. |
| `fileRevision(file)` | A file's revision: its size, modification time and a hash of its first 64 KiB. |
| `EXPORT_MEDIA_TYPES` | The media type of each export format (`ExportFormat`). |
| `EngineError` | The error of a failed request, with its `code` (§8.7). |
| `readExpression`, `readValue`, `sourceExpression`, `tableColumn` | How the engine reads DuckDB's columns as logical types, for hosts that read DuckDB themselves. |

The types `DuckDBEngineOptions`, `HttpHandlerOptions`, `KeptExport`, `ReadOptions` and `SheetInfo` are exported
too.

### Limits and cleanup

| Limit | Default | What it bounds |
| --- | ---: | --- |
| `maxViews` | 8 | Views kept; requests reading a view keep it until they finish. |
| `materializeRows` | 20,000,000 | Input rows above which a view keeps only row IDs. |
| `memoryLimit` | 1–4 GB | DuckDB's buffer memory. |
| `maxTempDirectorySize` | 8 GB | DuckDB's spill files; not the database or converted files. |

One view is built at a time. Cancelling, or a failed build, drops the tables it made. Closing the engine removes
its whole session folder, and the next start removes folders left by processes that died. The limits are not a
quota on the session folder: a host that needs one provisions a file system with a quota for `tempDirectory`.

## The specification as code

- **`vastgrid-spec`** holds the types, the checks of plans and messages (`checkPlan`, `checkRequest`,
  `checkResponse`, `checkEvent`), the commands (`applyCommand`), formulas (`compileFormula`, `formulaText`),
  `migrateGridState`, the encodings of blocks (`encodeBlock`, `decodeBlock`, `toStructuredEncoding`,
  `toTextEncoding`, `frameAttached`, `readAttached`), the JSON schemas (`vastgrid-spec/schema/*.schema.json`) and
  the conformance corpus that every engine runs (`vastgrid-spec/conformance`).
- **`vastgrid-sql`** compiles plans to DuckDB SQL with every value as a parameter (`compileView`, `rowsQuery`,
  `countQuery`, `pivotQuery`), the meaning of the specification in SQL. The DuckDB engine is built on it.

[Your own engine](/guides/custom-engine/) shows how to answer the messages and run the corpus.
