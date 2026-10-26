# vastgrid-duckdb-engine

The DuckDB engine of vastgrid v2 for Node.js: it opens huge CSV, TSV, Parquet and JSON Lines files and Excel
workbooks, and answers the messages of the [v2 specification](../../docs/v2-spec.md) (§8) with Arrow blocks. It is
a draft and is not published yet; when v1 is removed, it becomes `vastgrid-duckdb`.

```ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb-engine";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/data"], tempDirectory: "/tmp/vastgrid" });

// In the same process, as `localTransport(engine)` of vastgrid-grid does:
const answer = await engine.handle({ v: 2, id: 1, op: "open", ref: "sales.parquet" });

// Over HTTP: requests are POSTs at /api, events are Server-Sent Events at /api/events (§8.8).
createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

- **Opening.** Parquet files are read in place, by their row numbers, so that any block of a 100-million-row file
  reads in tens of milliseconds. Delimited and JSON files and the sheets of workbooks are loaded into a database
  of the engine's session; the first rows are readable at once while the rest loads (§9), and `progress` and
  `view` events tell when the table has loaded. Text encodings (UTF-16, Shift_JIS, EUC-JP and others) are found
  and converted, and files whose types change late fall back to wider types.
- **Reading.** `rows`, `locate`, `summarize` and `find` read the views of plans that
  [`vastgrid-sql`](../sql) compiles. Every column is read as its logical type (§2.1), and a view without
  `where`, `aggregate` and `sort` is read by row IDs. Other views save their total order once and read ranges of
  positions, including for selection summaries, finding and locating rows. Small inputs keep all output columns;
  inputs above 20 million rows keep only source row IDs in view order (aggregates always keep their output).
- **Isolation.** DuckDB reads only files inside the allowed folders, by their real location, and loads no
  extensions; errors sent to clients leave out the server's folders and SQL. `resolve` lets a host decide what
  a `ref` names.
- **Progressive sorts.** With `preview: true`, a sort over at least a million input rows first gives up to 1,000
  rows in the final order, including the same tie breakers. Its `status` is `building`, `readableRows` is the
  prefix size and `rowCount` is exact. A normal read waits for completion; a `view` event also announces it.
  While a file itself loads, only the empty plan is supported (`partialViews: false`).
- **Writing.** `write` (§7.2) keeps the written cells apart from the file, in a table of the session for each
  written column, and reads the table through a view that puts them over the file's values, so that rows, plans,
  summaries and find all see them. A write is atomic, checks `previous` (`edit_conflict`) and the revision, and
  waits for a file that is still loading. Handles of one file share its written cells; once the last one closes,
  they are gone. A file changed on disk opens as a new revision without them, while the handles opened before keep
  theirs. A view in row ID order reads as fast after a write (about 5 ms for 100 rows at any depth of a
  20-million-row file); views that save their order are built again for the new edits version.
- **Sharing and cancellation.** The normalized plan, revision, source relation and edits version identify a cached
  view. Concurrent callers share its construction; cancelling one caller leaves others running.
  Switching plans or closing the last following handle stops an unfinished build once no request uses it.
- **Saving.** With `saveFiles: true`, `save` (§7.5) writes the written cells into the CSV or TSV file they came
  from, and only the fields that changed: every other byte (byte order mark, quoting, delimiters, line breaks, the
  encoding, Shift_JIS and UTF-16 included) stays. The file is written next to itself under a temporary name and
  renamed over it once complete, so that a failed or cancelled save leaves it as it was; a file changed by someone
  else since it was read is refused (`file_changed`). Afterwards the table reads the saved values as the file's
  own, with the same revision and row IDs. Saving two cells takes about 60 ms in a 200,000-row file (6 MB) and 0.3 s in a 2-million-row file (65 MB) on an Apple-silicon laptop.
- **Following files.** The folders of open files are watched (`watchFiles`, on by default), and `changes` and
  `open` check the file too (§7.6). A file that changes on disk is loaded again, and the handles move to the new
  revision once it has loaded, reading the table as it was meanwhile. A table with written cells is kept instead,
  with `fileChanged: true` in `info`, `changes` and the `changed` event; `reload` moves a handle to the file as it
  is now, without them. A file that is removed, or cannot be read while it is being written, keeps its table the
  same way until it can be read again.
- **Exporting.** `export` (§8.2) writes the whole view, with the written cells, as CSV, TSV, Parquet, JSON or an
  Excel workbook, on the server: DuckDB writes the first four (`COPY`), and workbooks are streamed one chunk of
  rows at a time. Files are written under a temporary name and renamed once complete. With `resolveTarget`, an
  export may name a `target` where the host lets it be written (inside the allowed folders, never a file that a
  table reads). Without a target, the engine keeps the file (at most 16, for an hour) and answers its name, which
  `exportFile(name)` and the HTTP handler (`GET <path>/exports/<name>`, as a download named after the table)
  serve, so that no row goes through the browser. On an Apple-silicon laptop, a sorted view of a million rows of
  four columns exports in 0.3 s as CSV (39 MB, with the sort), 0.1 s as Parquet, 0.2 s as JSON and 2.2 s as a
  workbook (27 MB).

| Format | Limits |
| --- | --- |
| CSV, TSV | none; repeated headers are written as they are |
| Parquet, JSON | none; columns keep their names (headers are not used) |
| Excel (`.xlsx`) | 1,048,575 rows and 16,384 columns (`export_too_large`), 32,767 characters a cell, 4 GB; text is never written as a formula |

`node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/open.ts` measures opening and
reading the files of the benches; [`examples/files`](../../examples/files) shows them in v2's grid.

## Limits and cleanup

| Option | Default | What it bounds |
| --- | ---: | --- |
| `maxViews` | 8 | Views retained per engine; requests actively reading a view pin it until they finish. |
| `materializeRows` | 20,000,000 | Input rows above which non-aggregate views store only row IDs. |
| `viewPreviewMinRows` | 1,000,000 | Minimum input size for a sort preview. |
| `viewPreviewRows` | 1,000 | Rows in a sort preview. |
| `memoryLimit` | 1–4 GB | DuckDB's buffer memory limit (a fifth of system RAM, capped at 4 GB). |
| `maxTempDirectorySize` | 8 GB | DuckDB spill files; excludes the database and converted input files. |

One view build runs at a time. LRU eviction drops its tables after readers finish; cancellation and failed
construction drop partial tables too. A preview stays pinned with its full result until eviction. Closing the
engine removes its entire session folder, and the next start removes folders left by dead processes. Dropped
database blocks can be reused; the database file does not necessarily shrink. The view count and spill limits
are not a byte quota on the whole session folder; hosts that require one should provision a filesystem quota.

The repeatable sort/filter benchmark is [`bench/views.ts`](bench/views.ts); its before/after results and resource
measurements are in [v2-views-benchmark.md](../../docs/v2-views-benchmark.md).
