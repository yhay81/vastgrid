# vastgrid

A canvas data grid for React that opens CSV, TSV, Parquet and JSON Lines files of any size —
gigabytes, hundreds of millions of rows — and works like a spreadsheet: range selection and Excel's
keyboard shortcuts, copy, multi-column sort, filters, search, column statistics and a selection summary.

```sh
npm install vastgrid
```

```tsx
import { ArraySource, DataGrid, RemoteSource } from "vastgrid";
import "vastgrid/styles.css";

// Files served by vastgrid-duckdb (Node.js + DuckDB):
const source = new RemoteSource({ endpoint: "/api/table", ref: "sales.parquet" });
// …or data already in memory:
// const source = new ArraySource({ columns: ["name", "age"], rows: [["Ada", 36]] });

<div style={{ height: 600 }}>
  <DataGrid source={source} />
</div>;
```

Documentation, benchmarks and the server setup: https://github.com/yhay81/vastgrid
