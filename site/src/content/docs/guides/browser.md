---
title: Large files in the browser
description: Open CSV, TSV, JSON Lines, Excel and Parquet files, and Parquet over HTTP, with the memory engine in a Web Worker. No server and no upload.
---

The memory engine of `vastgrid-js` reads files as well as rows. Run it in a Web Worker: the worker reads, sorts,
groups and exports while the page keeps drawing and scrolling, and the file never leaves the browser.

```bash
npm install vastgrid vastgrid-js
```

## The worker and the page

In the worker, make the engine and answer the page with `serveEngine`. A worker imports from `vastgrid/core`,
which has no React:

```ts
// engine-worker.ts
/// <reference lib="webworker" />
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

// The page posts the file first; the engine answers every message after it.
self.addEventListener("message", function start(event: MessageEvent<{ file: File }>) {
  self.removeEventListener("message", start);
  const { file } = event.data;
  const table = /\.(parquet|pq)$/i.test(file.name) ? { parquet: file } : { file, editable: true };
  serveEngine(memoryEngine({ tables: { [file.name]: table } }), self as unknown as WorkerLike);
});
```

In the page, start a worker for each file and talk to it with `workerTransport`:

```tsx
import { useState } from "react";
import { DataGrid, type Transport, workerTransport } from "vastgrid";
import "vastgrid/styles.css";

interface Opened {
  name: string;
  worker: Worker;
  transport: Transport;
}

export function FileGrid() {
  const [opened, setOpened] = useState<Opened>();

  function open(file: File) {
    opened?.worker.terminate();
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ file });
    setOpened({ name: file.name, worker, transport: workerTransport(worker) });
  }

  return (
    <>
      <input type="file" onChange={(event) => event.target.files?.[0] && open(event.target.files[0])} />
      {opened && <DataGrid transport={opened.transport} table={opened.name} style={{ height: 600 }} />}
    </>
  );
}
```

- The grid's `table` is the name the worker gave the table, here the file's name.
- Start the worker in the event handler, not in an effect. Ending the worker frees all of the file's memory:
  end the old one when another file opens, and when the component unmounts.
- Posting a `File` does not read it. The engine reads it in slices, in the worker.
- Blocks of rows come back as bytes whose buffers are transferred to the page, without a copy.

## Files

`{ file }` takes a `File` or `Blob` of CSV, TSV, JSON Lines or an Excel workbook. The format comes from the
file's name, or from `format`:

| Format | Names | `format` |
| --- | --- | --- |
| CSV | `.csv` | `"csv"` |
| TSV | `.tsv`, `.tab` | `"tsv"` |
| JSON Lines | `.jsonl`, `.ndjson` | `"jsonl"` |
| Excel | `.xlsx`, `.xlsm` | `"xlsx"` |

| Option | Default | |
| --- | --- | --- |
| `delimiter` | the one of `,`, tab, `;` and `\|` that splits the first line into the most fields | CSV's separator, one character |
| `header` | `true` | whether the first line of CSV or TSV names the columns |
| `maxBytes` | 1 GiB | the most memory that the table's columns may take (below) |
| `editable` | `false` | lets the grid write cells |

Each column gets the first type that all its values fit: `boolean`, `integer`, `bigint`, `float`, `time`,
`date`, `timestamp`, `timestamptz`, and `string` otherwise. Text that is almost a value (`24:00:00`, ` 1`,
`2023-02-29`) makes a string column, which keeps every value as written. An empty field is null, and a quoted
empty field (`""`) is an empty string. In JSON Lines, each key is a column; a column of objects and lists is
their JSON text, read-only.

Files must be UTF-8. A file in UTF-16, text that is not UTF-8, and a line of JSON Lines that is not an object
fail with `load_failed`. Compressed files (`.csv.gz`) are not read in the browser.

### Excel sheets

A workbook opens at its first visible sheet. The table's info lists the workbook's `sheets` and the `sheet` read.
Choose another with the grid's `open` prop, which is read when the grid makes its store, so give the grid a `key`
too:

```tsx
<DataGrid key={sheet} transport={transport} table={name} open={{ sheet }} />
```

`open` also takes `headerRow` (the 1-based row of the column names; `0` for none) and `keepEmptyRows` and
`keepEmptyColumns`. Encrypted workbooks and the old `.xls` format fail with `load_failed`.

## Parquet

`{ parquet }` takes a `File` or `Blob`, or the URL of a file whose server answers HTTP range requests:

```ts
memoryEngine({ tables: { sales: { parquet: "https://data.example.com/sales.parquet" } } });
```

| Option | Default | |
| --- | --- | --- |
| `headers` | none | headers sent with every request for a URL, such as `Authorization` |
| `fetch` | the global `fetch` | a function to use instead |
| `maxBytes` | 1 GiB | about the most memory that columns read whole may take |
| `editable` | `false` | lets the grid write cells |

Opening reads the file's footer only. Rows on screen read the row groups that hold them. A sort, filter, group
or summary reads the columns it names whole, into typed arrays. Columns get the types that DuckDB reads them as;
lists, structs and maps become read-only strings of their JSON.

For a URL on another origin, the server must allow it by CORS and expose `Content-Length`, `Content-Range` and
`ETag` (`Access-Control-Expose-Headers`). The first answer gives the file's size and its `ETag` or
`Last-Modified`, and every later answer must match: a file that changed fails with `file_changed`. Ranges read
are kept in a cache of 32 MiB. A server that ignores `Range` sends the whole file, which is kept when it is at
most 16 MiB and fails with `load_failed` otherwise.

## Memory and `maxBytes`

`maxBytes` (1 GiB by default) bounds the columns that the engine keeps whole. A text file whose columns would
take more is not kept: the engine notes where every 1,024th row starts and reads rows by those blocks. A sort,
filter, group, summary, find or export then reads the columns it needs whole while they fit, and the least
recently used are forgotten when another needs the room. A request that needs more at once fails with
`load_failed` at `/maxBytes`, and the table stays open.

Requests use memory beyond `maxBytes`: about 4 bytes a row for each sorted column and each view, the groups of a
group, and 32 MiB of cached blocks. When a table does not fit, give a larger `maxBytes` or open the file on a
server ([Files on a server](/guides/server/)), where DuckDB spills to disk.

## Exports and edits

The memory engine exports CSV, TSV, JSON and xlsx as data: it makes the file in memory and answers its bytes,
and the grid saves them as a download ([Export](/guides/export/)). The engine writes no file, and the `File` the
table was read from is never changed. With `editable: true` the grid writes cells, which last as long as the
worker; an export keeps them.

## How fast

Measured on 2026-10-27 on an Apple M2 Pro with Node.js 24, through the engine's messages without a worker or a
page ([the benchmark](https://github.com/yhay81/vastgrid/blob/main/docs/v2-memory-engine-benchmark.md)). The
files have 8 columns; times are of one run.

| | 1M rows, CSV (69 MB) | 1M rows, Parquet (13 MB) | 10M rows, CSV (701 MB) | 10M rows, Parquet (132 MB) |
| --- | ---: | ---: | ---: | ---: |
| Open | 1.06 s | 26 ms | 10.5 s | 38 ms |
| First 256 rows | 9 ms | 201 ms | 7 ms | 206 ms |
| Sort by a float | 91 ms | 1.08 s | 0.88 s | 8.7 s |
| Sort by a string | 0.48 s | 0.25 s | 5.0 s | 2.9 s |
| Filter, then sort by a timestamp | 0.19 s | 0.10 s | 2.5 s | 1.8 s |
| Group with sum, average and count | 0.41 s | 0.32 s | 5.0 s | 3.5 s |
| Export every row as CSV | 1.45 s | 1.32 s | 14.8 s | 13.7 s |
| Memory after opening | 58 MB | 1 MB | 590 MB | 2 MB |
| Memory after all of the above | 107 MB | 129 MB | 1,020 MB | 1,264 MB |

A Parquet file opens at once and pays when a request first reads a column whole; a text file pays when it opens.
With `maxBytes` of 256 MiB, the 10M-row CSV opens in 4.7 s into no memory, and a summary or export of every
column fails with `load_failed`. In Chromium, with the engine in a worker, the page has no long task while a
million rows sort and its heap holds none of the table (10 MB).

## The /open/ page

[Open a file](/open/) is this guide at work. It starts the memory engine in a worker for each file you drop or
choose, makes the table editable, reads a `.txt` file as CSV, and adds a sheet chooser for workbooks. Its worker
is [site/src/components/open/engine-worker.ts](https://github.com/yhay81/vastgrid/blob/main/site/src/components/open/engine-worker.ts).

## Limits

- The whole file is read before the first rows show: the 10M-row CSV above takes 10 seconds. Showing rows while
  a file loads is a later step.
- A cancel is read every 40 ms or so; parts of a view (ranking numbers, sorting by ranks) run to their end first.
- The engine does not save into the file. Export to keep edits.
- The tab's memory is the limit. Past it, use the DuckDB engine on a server.

## Bundlers

`new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" })` is the form that Vite and
webpack 5 find and bundle; Vite needs no plugin or setting for it. No special headers are needed: the engine
uses no `SharedArrayBuffer`, so the page needs no cross-origin isolation (COOP/COEP). Module workers need Chrome
and Edge 80, Firefox 114 or Safari 15 or later.
