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
- **Sharing and cancellation.** The normalized plan, revision, source relation and edit version (currently 0)
  identify a cached view. Concurrent callers share its construction; cancelling one caller leaves others running.
  Switching plans or closing the last following handle stops an unfinished build once no request uses it.
- **Not yet.** Writing cells, saving, exporting and changes of files on disk are
  the next steps of the rebuild ([rebuild-decision.ja.md](../../docs/rebuild-decision.ja.md)).

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
