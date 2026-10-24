---
title: Files in the browser
description: Open local Parquet, CSV, TSV and JSON Lines files, and Parquet URLs, in a Web Worker with vastgrid-browser — no server.
---

`vastgrid-browser` reads table files in a Web Worker, with no server and no upload: files the user picks
(`File` or `Blob`) and Parquet files at a URL, read in parts with HTTP `Range` requests. The page's thread
only sends the grid's requests and receives the rows it draws.

```bash
npm install vastgrid vastgrid-browser
```

```tsx
import { DataGrid } from "vastgrid";
import { BrowserSource } from "vastgrid-browser";
import { useEffect, useState } from "react";

export function Table({ file }: { file: File }) {
  const [source, setSource] = useState<BrowserSource | null>(null);
  useEffect(() => {
    const next = new BrowserSource({ file });
    setSource(next);
    return () => next.close();
  }, [file]);
  return <div style={{ height: 600 }}>{source && <DataGrid source={source} />}</div>;
}
```

For a Parquet file on a web server, pass `url` instead of `file`:

```ts
const source = new BrowserSource({ url: "https://data.example.com/sales.parquet" });
```

Each `BrowserSource` runs its own worker. `close()` ends it and frees its memory; create the source in an
effect, as above, so that it is closed when the file changes or the grid unmounts.

## What it can do

| | Local file | Parquet URL |
| --- | --- | --- |
| Formats | Parquet, CSV, TSV, JSON Lines | Parquet |
| Opening | Parquet: reads the footer. Text: counts the rows once, in 4 MiB chunks; the first rows show while it counts. | `HEAD` for the size, then the footer |
| Rows | The row groups or blocks of 1,024 lines the grid shows | The byte ranges of the row groups and columns the grid shows |
| Sort, filters, search, statistics, value lists, find | Yes, in the worker | Off: they would download the whole file. `fullScan: true` turns them on. |
| Selection summary | Yes | No (a whole column would download the whole file) |
| Export | No (see [Exporting](/guides/export/#vastgrid-browser)) | No |

The grid enables only what `info().capabilities` says, so with a URL the sort and filter menus stay off.
Capabilities are all off while a text file is still being counted, as with the DuckDB engine.

Sorting and filtering use the same comparisons as `ArraySource` and match the DuckDB engine: numbers by
value (also integers beyond 2^53 and decimals, which arrive as text), blanks last in both directions,
dates and times as their ISO text. Values arrive as DuckDB sends them: `DECIMAL` as exact text
(`"2.50"`), `TIMESTAMP` as `2024-01-03 10:00:00.5`, `TIMESTAMP WITH TIME ZONE` in the browser's time zone
(`2024-01-01 09:00:00+09`), lists and structs as `[1, 2]` and `{'a': 1}`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `file` / `url` | | What to open: a `File` or `Blob`, or the URL of a Parquet file. |
| `name` | `file.name` | The file name, used to tell the format of a `Blob`. |
| `format` | from the name or the content | `"parquet"`, `"csv"`, `"tsv"` or `"json"` (JSON Lines). |
| `delimiter` | detected | Field separator of CSV (`,`, `;`, `\|` or a tab). |
| `header` | `true` | Whether the first line of a CSV or TSV holds the column names. |
| `fullScan` | `true` for files, `false` for URLs | Offer the operations that read the whole table. |
| `headers` | | Headers for every HTTP request, for example `Authorization`. |
| `credentials` | | `fetch` credentials mode, for cookies on another origin. |
| `maxDownloadBytes` | 16 MiB | When a server ignores `Range`, download files up to this size whole; larger ones fail. |
| `cacheBytes` | 32 MiB | Bytes of HTTP ranges kept for reading again. |
| `textLimit` | 2000 | Longest text sent for a cell unless the grid asks for more. |
| `worker` | the bundled worker | A function that creates the worker (see below). |
| `changeInterval` | 5000 | URLs: how often (ms) a grid asks the server whether the file changed, by its `ETag`, `Last-Modified` or size (a `HEAD` request). At least 500; `0` turns it off. |

`transfer()` resolves to the bytes and reads (HTTP requests) used so far, for showing or checking how
little was read.

## The worker and your bundler

By default the source starts its worker with
`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, which Vite, webpack 5,
Rollup and esbuild-based tools recognize. If your setup needs another form, pass `worker`. With Vite:

```ts
import BrowserWorker from "vastgrid-browser/worker?worker";

const source = new BrowserSource({ file, worker: () => new BrowserWorker() });
```

Vite pre-bundles dependencies; if the default worker URL is not found in development, add
`optimizeDeps: { exclude: ["vastgrid-browser"] }` or use the `?worker` import above. To run the table in a
worker of your own, call `serveTable(self)` from `vastgrid-browser` in it; `BrowserTable` is the same
engine without a worker (for tests and Node.js).

No special headers are needed: the engine is plain JavaScript, so it works without `SharedArrayBuffer`
and without cross-origin isolation (COOP/COEP). Module workers need Chrome and Edge 80, Firefox 114 or
Safari 15 or later.

## Serving Parquet for URLs

The server must answer `Range: bytes=start-end` with `206 Partial Content`; static file servers, object
storage (S3, R2, GCS) and CDNs do. For a file on another origin, allow it with CORS:

```http
Access-Control-Allow-Origin: https://your-app.example
Access-Control-Expose-Headers: Content-Length, Content-Range, ETag
```

A single byte range is a CORS-safelisted header, so plain reads make no preflight request. Headers such as
`Authorization` do: allow them with `Access-Control-Allow-Headers: Authorization, Range`. Answers to `HEAD`
must not be compressed (`Content-Encoding`), or their `Content-Length` is not the file's size.

| Situation | What happens |
| --- | --- |
| The server ignores `Range` and sends the whole file | Files up to `maxDownloadBytes` are downloaded once and read from memory; larger ones fail with `range_not_supported`. |
| `HEAD` is refused | The size comes from the `Content-Range` of a one-byte range. |
| The size cannot be read (no `Content-Length`, or `Content-Range` not exposed) | `size_unknown` |
| The file changes while it is open (another `ETag` or `Last-Modified`, or a shorter file) | The read fails with `file_changed`; the next `info()` opens the file again, with its new `revision`. The grid's reload does this. |
| 401, 403, 404 | `http_error`, with the status in the message |
| The request fails, or CORS blocks the answer | `network_error` |

Every answer is checked against the first `ETag` (or `Last-Modified`), so a file replaced while it is open
is never read half old and half new. A cross-origin server must expose `ETag` for this check.

## Measurements

The playground's sample files on an Apple M2 Pro, `npm run bench -w vastgrid-browser` (Node.js 24,
the worker's code without the worker), and in Chrome through the playground (Engine: Browser worker). The
Parquet file has 82 row groups of 122,880 rows, compressed with zstd, and no page index.

| | Time | Read |
| --- | ---: | ---: |
| Parquet 132 MB, 10M rows, over HTTP Range: open | 40 ms (Chrome 41 ms) | 0.1 MB in 2 requests |
| Parquet URL: first 100 rows × 8 columns | 0.3–0.7 s | 1.7 MB |
| Parquet URL: 100 rows at 5 random positions | 150–270 ms each in Chrome | 1.7 MB each; 10.3 MB in all (7.8% of the file) |
| Parquet local file: sort 10M rows by a number | 13.6 s | the column once |
| Parquet local file: first window of that sort | 12 s | every row group that holds a shown row |
| CSV 71 MB, 1M rows, local file: count the rows | 0.15 s (Chrome 0.22 s) | the file once |
| CSV: rows at a random position | 1–3 ms | a block of 1,024 lines |
| CSV: sort 1M rows by a number / first sorted window | 1.1 s / 54 ms (Chrome 1.07 s / 61 ms) | |
| CSV: filter and sort in Chrome — longest pause of the page's thread | 11 ms | |

The worker held about 40 MB for the CSV (the index takes 8 bytes per 1,024 rows; views take 4 bytes per
row) and about 110–135 MB for the Parquet file, most of it decoded row groups and HTTP ranges kept for
scrolling back (4M cells and 32 MiB at most). The worker bundle is 210 KB minified (107 KB gzip),
including hyparquet and the zstd, gzip, brotli, lz4 and snappy decoders; the page's part is 3 KB.

## Limits

- Text files must be UTF-8 (a BOM is fine). Convert Shift_JIS and UTF-16 files first, or use
  `vastgrid-duckdb`.
- Column types of CSV and TSV come from the first 2,048 rows. A later value that does not fit stays text;
  in a number column it then sorts with the blanks.
- A sorted or filtered view of a Parquet file reads, for each screen, every row group that holds one of the
  rows shown. Files without a page index are decoded a row group at a time, so the first screen of a sort of
  millions of rows takes seconds. For that, serve the file with `vastgrid-duckdb`.
- Sorting runs in the worker on the values of the sort columns; tens of millions of rows need hundreds of
  megabytes of memory in the worker.
- Changes are seen for files at a URL only. A local `File` is a snapshot: once the file changes on disk the
  browser refuses to read it, so open it again (for example from the file picker). For URLs, servers on
  another origin must list `ETag` (or `Last-Modified`) in `Access-Control-Expose-Headers`.

## Why hyparquet, not DuckDB-WASM

| | hyparquet (chosen) | DuckDB-WASM |
| --- | --- | --- |
| Size | 107 KB gzip for the whole worker | about 35–40 MB of WebAssembly per build (several MB compressed), plus its worker |
| Serving | Any static host; no special headers | Works without COOP/COEP in its single-thread build; threads need cross-origin isolation |
| Formats | Parquet; CSV, TSV and JSON Lines with this package's reader | Parquet, CSV, JSON and more, with SQL |
| Sort, filter, statistics | In JavaScript, with the same comparisons as `ArraySource` | SQL, much faster on tens of millions of rows |
| HTTP Range | Ranges it asks for, cached; ETag checked here | Built-in HTTP file system |

The grid's typical use in a browser — open a file, look at it, sort and filter up to a few million rows — is
well served by a small engine that loads at once from any host. Work on hundreds of millions of rows belongs
on a server with `vastgrid-duckdb`, which the grid reaches through the same `TableSource` interface.
