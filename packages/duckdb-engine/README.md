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
  `where`, `aggregate` and `sort` is read by row IDs; other views are read in their order.
- **Isolation.** DuckDB reads only files inside the allowed folders, by their real location, and loads no
  extensions; errors sent to clients leave out the server's folders and SQL. `resolve` lets a host decide what
  a `ref` names.
- **Not yet.** Writing cells, saving, exporting, sorted copies of large views and changes of files on disk are
  the next steps of the rebuild ([rebuild-decision.ja.md](../../docs/rebuild-decision.ja.md)).

`node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/open.ts` measures opening and
reading the files of the benches; [`examples/files`](../../examples/files) shows them in v2's grid.
