# vastgrid-duckdb

A table server for [vastgrid](https://github.com/yhay81/vastgrid) backed by DuckDB. It opens huge CSV,
TSV, Parquet and JSON Lines files and Excel workbooks in Node.js and answers the vastgrid protocol:
windows of rows, sorted and filtered views, column statistics, distinct values, selection summaries,
find and export.

```ts
import { createTableHandler, TableEngine } from "vastgrid-duckdb";

const engine = TableEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });
export const POST = createTableHandler({ engine: () => engine, resolve: (ref) => safePathInside("/srv/data", ref) });
```

- DuckDB can only read the allowed directories (and its own temporary folder); this cannot be changed
  while the engine runs. `resolve` is where you check what a client may open.
- `@duckdb/node-api` is a native module: keep it out of server bundles and ship its platform package.

Setup, options and security: https://vastgrid.yhay81.com/guides/server/
