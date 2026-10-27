---
title: Files on a server
description: Serve CSV, TSV, Parquet, JSON Lines and Excel files of any size from Node.js with the DuckDB engine of vastgrid-duckdb.
---

`vastgrid-duckdb` opens table files with DuckDB in Node.js and answers the grid's messages: rows, sorted and
filtered views, groups and pivots, summaries, find, writes, saves and exports. The page receives only the rows it
shows. It needs Node.js 20 or later, on the platforms that DuckDB's Node.js bindings support.

```bash
npm install vastgrid vastgrid-duckdb
```

## The engine and the handler

```ts
// server.ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
});

createServer(createHttpHandler(engine, { path: "/api/table" })).listen(8080);
```

Make one engine per process and share it: it keeps open tables, their views and DuckDB's database between
requests. Call `engine.dispose()` when the process stops; it closes DuckDB and deletes its files.

`createHttpHandler` returns a Node.js handler, `(request, response, next?)`. It is a listener for `node:http` and
middleware for Express, Connect and Vite's dev server, which pass other paths on to `next`. It is not a Fetch API
handler; for those, see below.

```ts
app.use(authenticate); // your own check comes first
app.use(createHttpHandler(engine, { path: "/api/table" }));
```

It answers `POST /api/table` (requests; rows come back as Arrow attached to the JSON), `GET /api/table/events`
(the engine's events, as Server-Sent Events) and `GET /api/table/exports/<name>` (export downloads). Its other
options are `events`, `exports`, `maxBody` (64 MiB) and `keepAlive` (15 s).

In the page, `httpTransport` posts the grid's messages:

```tsx
import { DataGrid, httpTransport } from "vastgrid";
import "vastgrid/styles.css";

const transport = httpTransport("/api/table", { events: "/api/table/events" });

export function Sales() {
  return <DataGrid transport={transport} table="sales/2025.parquet" style={{ height: 600 }} />;
}
```

`table` is the `ref` that the engine opens. `httpTransport(url, options)` takes `events`, `headers` (sent with
every request, such as an authorization), `fetch`, and `exports` (`<url>/exports/` by default). Give it the
events: through them the grid follows a file while it loads, a sort until it is complete, and files that change.
Aborting a request cancels its query: the grid aborts the reads of a view when a new plan replaces it.

### Fetch API frameworks

Next.js route handlers, Hono, Bun and Deno take a `Request`. Pass the message to `engine.handle` yourself:

```ts
// app/api/table/route.ts
import { ERROR_STATUS, type ErrorCode, toTextEncoding } from "vastgrid-spec";
import { engine } from "@/lib/engine"; // a module that makes one engine for the process

export async function POST(request: Request) {
  const message = await request.json().catch(() => null);
  const answer = await engine.handle(message, { signal: request.signal });
  if (answer === undefined) return new Response(null, { status: 204 });
  const error = answer.error as { code: ErrorCode } | undefined;
  if (error) return Response.json(answer, { status: ERROR_STATUS[error.code] });
  return Response.json(toTextEncoding(answer));
}
```

`vastgrid-spec` comes with `vastgrid-duckdb`; add it to your dependencies to import it. Blocks go as base64 in
the JSON, a third larger than the Node.js handler's Arrow. For events, stream `engine.subscribe(listener)` from a
`GET` route as Server-Sent Events; for exports, serve the file that `engine.exportFile(name)` points to.

### Server Functions

`serverFunctionTransport` carries the messages through a `"use server"` function:

```ts
// app/table-action.ts
"use server";
import type { RequestMessage } from "vastgrid/core";
import { engine } from "@/lib/engine";

export async function tableAction(request: RequestMessage) {
  // Check here that this person may use the grid.
  return engine.handle(request);
}
```

```tsx
"use client";
import { DataGrid, serverFunctionTransport } from "vastgrid";
import { tableAction } from "./table-action";

const transport = serverFunctionTransport(tableAction);

export function Sales() {
  return <DataGrid transport={transport} table="sales/2025.parquet" />;
}
```

The function receives whatever any client sends. `engine.handle` checks each request against the specification
(`checkRequest`) and refuses what `resolve` refuses. Server Functions carry no events, and frameworks may run
them one at a time, so `httpTransport` scrolls faster. For export downloads, add `exportUrl` to the transport and
a route that serves `engine.exportFile`.

## Options

| `DuckDBEngine.create` | Default | |
| --- | --- | --- |
| `allowedDirectories` | required | folders whose files may be opened; DuckDB reads no others |
| `tempDirectory` | required | the engine's database, spilled data and converted files, in a folder of its own |
| `resolve` | a path; relative ones in the first allowed folder | the file that a `ref` names; throw to refuse (`not_allowed`) |
| `resolveTarget` | none: exports are kept for download | the file that an export's `target` names |
| `memoryLimit` | a fifth of the memory, 1–4 GB | DuckDB's memory limit, such as `"4GB"` |
| `maxTempDirectorySize` | `"8GB"` | spill files at most |
| `threads` | CPUs − 1 | DuckDB's threads |
| `maxTables` | 4 | tables kept loaded with no handle, for opening again |
| `previewRows` | 1,000 | rows of a loading file readable at once |
| `textLimit` | 2,000 | the longest text a cell sends, unless the request asks otherwise |
| `saveFiles` | `false` | lets `save` write cells into CSV and TSV files |
| `watchFiles` | `true` | follows the files of open tables |
| `maxViews`, `materializeRows`, `viewPreviewMinRows`, `viewPreviewRows` | 8, 20M, 1M, 1,000 | views kept, and how sorts are kept and answered early (below) |
| `log` | none | problems that no request caused |

## Security

- DuckDB reads only files in `allowedDirectories`, by their real location with links followed, and loads no
  extensions. Requests hold no SQL and no paths: the engine writes the SQL, with every value as a parameter.
- Error messages leave out the server's folders and SQL.
- `resolve` runs for every `ref` that is opened, for every client alike. An engine trusts all its clients, and
  table ids (`t1`, `t2`, …) are not secrets. Share an engine among people who may see the same files, or check
  each `open` request's `ref` before `engine.handle`.
- A `rows` request reads at most 1,000,000 rows and 1,000,000 cells.

## Files and formats

| Format | Names |
| --- | --- |
| CSV | `.csv`, `.csv.gz`, `.csv.zst` |
| TSV | `.tsv`, `.tab`, `.tsv.gz`, `.tsv.zst` |
| Parquet | `.parquet`, `.pq` |
| JSON Lines | `.jsonl`, `.ndjson`, also `.gz` |
| JSON | `.json`, `.json.gz` |
| Excel | `.xlsx`, `.xlsm` |

`tableFormatOf(file)` gives a file's format by its name, or null. `findTableFiles(folders, limit)` lists the table
files of folders, two levels deep, without hidden ones: use it to offer a list of files.

- **Parquet** is read in place by row number: any block of a 100-million-row file reads in tens of milliseconds.
- **Delimited, JSON and Excel** files are loaded into the engine's database. The first `previewRows` rows are
  readable at once, and `progress` events follow the load. Encodings such as UTF-16, Shift_JIS and EUC-JP are
  found and converted; the table's `notes` say so (`encoding:shift_jis`).
- **Excel** opens at its first visible sheet. Choose another with the grid's `open` prop
  (`<DataGrid key={sheet} open={{ sheet }} … />`), which also takes `headerRow`, `keepEmptyRows` and
  `keepEmptyColumns`; it is read when the grid makes its store, hence the `key`.

## Progressive sorts

A sort of 1,000,000 rows or more answers first with its first 1,000 rows in their final order, and the grid
shows them while the rest is built; a `view` event says when it is ready. Views of up to 20 million rows keep a
sorted copy; larger ones keep only the order of rows. Measured on 2026-10-27 on an Apple M2 Pro with Node.js 24,
DuckDB 2.0, 8 threads and a 2 GB memory limit, the median of three runs
([the benchmark](https://github.com/yhay81/vastgrid/blob/main/docs/v2-views-benchmark.md)), reading 256 rows of
8 columns:

| File and plan | First rows | Later reads anywhere in the view (median) |
| --- | ---: | ---: |
| 100M-row Parquet (1.38 GB), sort | 953 ms | 700 ms |
| 100M-row Parquet, filter | 192 ms | 21 ms |
| 10M-row CSV (735 MB), sort | 55 ms | 4.0 ms |
| 10M-row CSV, filter | 124 ms | 3.0 ms |

The complete sorted view took another 3.0 s for the Parquet file and 0.9 s for the CSV file.

## Saving and following files

Written cells stay in the engine, apart from the file. With `saveFiles: true`, the grid's Save button (or ⌘S,
Ctrl+S) writes them into the CSV or TSV file they came from, changing only those fields: quoting, line breaks and
the encoding stay. The file is written under a temporary name and renamed over the old one; a file changed by
someone else since it was read is not overwritten (`file_changed`). Saving two cells took about 60 ms in a
200,000-row file and 0.3 s in a 2-million-row file on an Apple-silicon laptop.

With `watchFiles` (on by default) the engine watches the folders of open files. A changed file is loaded again
and the grid moves to it, keeping its sorts and filters. A table with written cells is kept instead, and the grid
tells the person that the file changed.

Exports (CSV, TSV, Parquet, JSON, xlsx) run on the server. Without `resolveTarget`, the engine keeps each file
for an hour and the grid downloads it from `<path>/exports/<name>`. A sorted view of a million rows of four
columns exported in 0.3 s as CSV and 2.2 s as xlsx on the same laptop.

## Deployment

- `@duckdb/node-api` is a native module: keep it out of server bundles and install it with your server. In
  Next.js:

  ```ts
  // next.config.ts
  export default {
    serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  };
  ```

- Ship the platform package, `@duckdb/node-bindings-<platform>`: about 110 MB on macOS for Apple silicon.
  Serverless platforms with small bundle limits may not fit it.
- Give `tempDirectory` room. Loaded files, sorted views and spilled data live there; `maxTempDirectorySize`
  bounds only the spill files.
- Run the engine in a long-lived process, since it keeps tables between requests.

## Server rendering

`readInitialView` from `vastgrid/server` reads the table, its view and first rows on the server, for the grid's
`initial` prop. Given as a promise, the page is sent at once and the rows stream when they are read:

```tsx
// app/sales/page.tsx (a Server Component)
import { localTransport } from "vastgrid/core";
import { readInitialView } from "vastgrid/server";
import { engine } from "@/lib/engine";
import { SalesGrid } from "./sales-grid";

export default function Page() {
  const initial = readInitialView(localTransport(engine), { table: "sales/2025.parquet", rows: 100 });
  return <SalesGrid initial={initial} />;
}
```

```tsx
// app/sales/sales-grid.tsx
"use client";
import { DataGrid, httpTransport, type InitialView } from "vastgrid";

const transport = httpTransport("/api/table", { events: "/api/table/events" });

export function SalesGrid({ initial }: { initial: Promise<InitialView> }) {
  return <DataGrid transport={transport} table="sales/2025.parquet" initial={initial} style={{ height: 600 }} />;
}
```

The server sends the first rows as an HTML table, and the canvas draws them in its first frame. `readInitialView`
also takes `document` and `open`: give the grid the same ones, so that both read the same view.
