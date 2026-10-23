---
title: Files on a server
description: Serve CSV, TSV, Parquet and JSON Lines files of any size, and Excel workbooks, from Node.js with vastgrid-duckdb.
---

`vastgrid-duckdb` opens table files with DuckDB and answers the grid's requests: windows of rows, sorted
and filtered views, column statistics, value lists, selection summaries, find and export. In the browser,
a `RemoteSource` sends those requests to it.

```bash
npm install vastgrid vastgrid-duckdb
```

## The engine and the handler

```ts
import path from "node:path";
import { createTableHandler, TableEngine, type TableHandlerOptions } from "vastgrid-duckdb";

const root = "/srv/data";
const engine = TableEngine.create({ allowedDirectories: [root], tempDirectory: "/tmp/vastgrid" });

export const options: TableHandlerOptions = {
  engine: () => engine,
  resolve: (ref) => {
    const file = path.resolve(root, ref);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Not allowed");
    return file;
  },
};

export const handler = createTableHandler(options);
```

`TableEngine.create` returns a promise; the handler waits for it. Create one engine per process and share
it between requests: it keeps the open tables, their views and a pool of DuckDB connections.

`createTableHandler` returns a function from a Fetch API `Request` to a `Response`, for Next.js route
handlers, Hono, Bun, Deno and anything else that has them. Pass requests with their `signal`, so that
requests the browser gives up (the grid scrolled away) stop their queries.

```tsx
import { DataGrid, RemoteSource } from "vastgrid";

const source = new RemoteSource({ endpoint: "/api/table", ref: "sales/2024.parquet" });
<DataGrid source={source} />;
```

`ref` is whatever your `resolve` understands: a path relative to a folder, an id in your database, a key
of an upload.

### Frameworks without Fetch API requests

`handleTableRequest(body, options, signal)` answers one parsed request and `errorBody(error)` turns an
error into the status and body to send. With Express:

```ts
import express from "express";
import { errorBody, handleTableRequest } from "vastgrid-duckdb";
import { options } from "./table.ts"; // the options above

const app = express();
app.post("/api/table", express.json({ limit: "1mb" }), async (request, response) => {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    const result = await handleTableRequest(request.body, options, controller.signal);
    response.json({ result });
  } catch (error) {
    const { status, body } = errorBody(error, console.error);
    response.status(status).json(body);
  }
});
```

## Options

### `TableEngine.create(options)`

| Option | Default | Description |
| --- | --- | --- |
| `allowedDirectories` | (required) | Directories DuckDB may read and export into. All other file access is disabled for good. |
| `tempDirectory` | (required) | Where the engine keeps its database file, data spilled from memory and converted files. Each engine uses its own folder inside and deletes it on `dispose()`; folders left by crashed processes are deleted on the next start. |
| `memoryLimit` | a fifth of the memory, 1–4 GB | DuckDB's memory limit, for example `"4GB"`. |
| `threads` | CPUs − 1 | DuckDB's worker threads. |
| `maxTables` | `4` | Tables kept open; the least recently used ones are closed beyond this. |
| `maxViews` | `2` | Sorted or filtered views kept per table. |
| `materializeRows` | `20000000` | Tables with more rows get views that hold only the order of the rows instead of a sorted copy (see below). |
| `viewPreviewMinRows` | `1000000` | Sorts of tables with at least this many rows show their first rows before the whole view is built (see below). |
| `viewPreviewRows` | `1000` | Rows of such a sort that are readable before the view is ready. |
| `abandonedViewTimeout` | `3000` | A background build stops when another view of the table waits and nobody asked for this one for this many milliseconds. |
| `previewRows` | `1000` | Rows readable while a delimited or JSON file is still loading. |
| `textLimit` | `2000` | Longest text sent for a cell by default. |
| `log` | | Receives problems that are not caused by a request, for your logs. |

### `createTableHandler(options)`

| Option | Description |
| --- | --- |
| `engine` | The engine, or a function that returns it or a promise of it. |
| `resolve(ref)` | Turns the `ref` of a request into an absolute file path. Throw to refuse. This is where you decide what a client may open. |
| `resolveTarget(target)` | Turns the target of an export (`source.exportView(…)`, called by your app) into an absolute path for a new file. Without it, exports are refused and `capabilities.export` is `false`. |
| `onError(error)` | Receives errors that are not caused by the request, for logging. |

## Security

- DuckDB can read only the `allowedDirectories` and its own temporary folder. The engine sets this when
  it starts and then disables changing it, so no request can reach other files, also not through SQL.
- Files are allowed by their real location, with links followed: a link inside an allowed folder to a
  file outside it is refused with `not_allowed`.
- SQL is generated by the engine and every value is a parameter. Clients send column indexes, never
  names or SQL.
- Error messages sent to clients name files without the server's folders and leave out the SQL that
  DuckDB quotes.
- `resolve` runs for every table that is opened. Check there that the user may open the file, as you
  would for a download.
- A `rows` request reads at most 1,000,000 rows and 1,000,000 cells. Limit the size of request bodies in
  your framework too.

## Files

The format is chosen by the file's extension:

| Format | Extensions |
| --- | --- |
| CSV | `.csv`, `.csv.gz`, `.csv.zst` |
| TSV | `.tsv`, `.tab`, `.tsv.gz`, `.tsv.zst` |
| Parquet | `.parquet`, `.pq` |
| JSON Lines | `.jsonl`, `.ndjson`, `.jsonl.gz`, `.ndjson.gz` |
| JSON | `.json`, `.json.gz` |
| Excel | `.xlsx`, `.xlsm` |

- **Delimited and JSON files** become DuckDB tables in the engine's database file. The first rows
  (`previewRows`) are readable at once; the grid shows them while the rest loads and enables sorting,
  filters and statistics when the load is done. A 735 MB CSV of 10 million rows shows its first rows
  in 0.15 s and is fully loaded in 5.3 s.
- **Parquet files** are read in place by row position, with no load: a 1.4 GB file of 100 million rows
  opens in 20 ms.
- **Encodings** including Shift_JIS, EUC-JP and BOM-marked UTF-16 (both byte orders) are detected and converted to UTF-8
  first. The table's `notes` then say `encoding:shift_jis`, and the grid's status bar shows it. Columns whose values do
  not fit one type are read as text (`all_varchar`), and invalid UTF-8 is replaced
  (`invalid_utf8_replaced`).
- **When a file changes** on disk (its size or modification time), the next `info` opens it again with a
  new `revision`. Change the grid's `reloadKey` to read it again, for example after your app saved it.

### Excel workbooks

`.xlsx` and `.xlsm` workbooks are read by the engine itself, with no extra package and no DuckDB extension
to download: the sheet is read as a stream and written to a CSV file with one type per column in the
engine's temporary folder, which DuckDB then loads like any delimited file. `info` lists the `sheets` (with
`hidden: true` for hidden ones) from its first answer, while the sheet still loads, and `sheet` names the one
that was read. Rows can be read once the whole sheet is loaded; `progress` grows meanwhile.

Choose how to read a workbook with `read`: the `read` option of `RemoteSource`, the `read` field of the
`info` request, or the third argument of `engine.open`. Each sheet, and each set of options, is a table of
its own.

```ts
new RemoteSource({ endpoint: "/api/table", ref: "sales.xlsx", read: { sheet: "2026", headerRow: 3 } });
```

| Option | Default | Description |
| --- | --- | --- |
| `sheet` | The first visible sheet | The sheet to read, by name. |
| `headerRow` | The first row with a value | The 1-based row with the column names; rows above it are skipped. `0`: no names, the columns are named by their letters (`A`, `B`, …). Empty names become the column's letters, and repeated names get a suffix (`name_2`). |
| `keepEmptyRows` | `false` | Keep rows without any value between the first and the last data row. |
| `keepEmptyColumns` | `false` | Keep columns without any value or name inside the used range. |

How cells are read:

- **Types.** Each column gets one type from its cells: whole numbers `BIGINT`, other numbers `DOUBLE`,
  `TRUE`/`FALSE` `BOOLEAN`, dates `DATE`, dates with a time `TIMESTAMP` and times of day `TIME`. A column
  with several kinds of values is text: numbers in their shortest form, booleans as `TRUE`/`FALSE`, dates as
  `2024-01-31` and `2024-01-31 12:00:00`.
- **Dates** are numbers with a date or time format, built in or custom (for example
  `yyyy"年"m"月"d"日"`), in the 1900 or the 1904 date system, rounded to milliseconds. A value with a time
  format below one day is a time of day. Serial number 60, the 29 February 1900 that Excel counts but that
  did not exist, reads as 1900-03-01.
- **Number formats** are not applied: `12.5%` reads as `0.125`, and currency and decimal places are not kept.
- **Formulas** show the value Excel saved when the workbook was last calculated; vastgrid never calculates
  them. A formula saved without a value is blank, and the table notes `formulas_without_values`. Errors such
  as `#DIV/0!` are text.
- **Blank cells** and empty text are blank (`null`).
- **Merged cells** keep their value in the top-left cell only; the other cells of the range are blank, and
  the table notes `merged_cells`.
- **Text**: rich text is read as plain text, without phonetic guides (furigana).
- **Not reproduced**: formatting, comments, images, charts, hidden rows and columns (they are read like the
  others), filters and data validation. Chart sheets are not listed.

Workbooks that cannot be read fail to load (`status: "error"`; later requests answer `load_failed`), with
a reason in `error`: not a ZIP archive, encrypted or in the old `.xls` format, a binary `.xlsb` workbook, a
missing part, compressed data that is damaged, rows or cells outside Excel's limits (1,048,576 rows and
16,384 columns), or no sheet with the requested name. Files named `.xls` or `.xlsb` are not table files
(`unsupported_format`).

The shared text of the workbook stays in memory while a sheet is read; the cells are streamed. A workbook of
1 million rows and 8 columns (64 MB) opens in about 8 s on an Apple M2 Pro, with at most about 130 MB of
JavaScript heap and 600–700 MB of resident memory for the whole process (DuckDB included). Measure your
own workbooks with `packages/duckdb/bench/xlsx.ts`.

## Sorted and filtered views

Sorting and filtering create a view. For tables up to `materializeRows` rows (20 million by default) the
view is a sorted copy of the table, so it scrolls as fast as the table: about 2 ms per block of rows. For
larger tables the view holds only the order of the rows; it is built an order of magnitude faster and
needs a fraction of the temporary space, and reading each block of rows from it takes 0.1–0.2 s for a
100M-row Parquet file. See [Performance](/about/performance/).

For tables of `viewPreviewMinRows` rows or more (1M by default), a sort requested by the grid answers as
soon as its first `viewPreviewRows` rows are known, with a top-N query that is far faster than ordering
every row; the rest of the view is built in the background. The grid shows those rows with "Sorting…" in
the toolbar, polls the view, and shows the remaining rows once it is ready. The first rows are in the order
of the finished view, ties broken by the position in the file, so nothing moves when it is done. Until
then, copies and selection summaries past the first rows, find, exports and the statistics of filtered
views wait. Builds run one at a time per table; a build that nobody polls any more stops when another
view waits (`abandonedViewTimeout`), so that changing the sort quickly does not queue up stale work.

## Deployment

- `@duckdb/node-api` is a native module. Keep it out of server bundles and install it with your server.
  For Next.js:

  ```ts
  // next.config.ts
  export default {
    serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  };
  ```

- Ship the platform package, `@duckdb/node-bindings-<platform>` (about 120 MB on macOS). Serverless
  platforms with small bundle limits may not fit it.
- Give `tempDirectory` room: loaded files, sorted views and data spilled from memory are kept there.
- The engine keeps tables between requests, so run it in a long-lived process. Call `dispose()` when the
  process shuts down to close DuckDB and delete the temporary files.
