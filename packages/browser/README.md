# vastgrid-browser

Table sources for [vastgrid](https://github.com/yhay81/vastgrid) that read huge files in a Web Worker, with
no server: local Parquet, CSV, TSV and JSON Lines files (`File` or `Blob`), and Parquet files at a URL,
read in parts with HTTP `Range` requests.

```tsx
import { DataGrid } from "vastgrid";
import { BrowserSource } from "vastgrid-browser";

const source = new BrowserSource({ file }); // or { url: "https://example.com/data.parquet" }
<DataGrid source={source} />;
// source.close() ends the worker when the table is no longer shown.
```

- Local files are sorted, filtered and summarized in the worker, with the same results as `ArraySource`
  and `vastgrid-duckdb`. For URLs, operations that read the whole table are off unless `fullScan: true`.
- Handles servers that ignore `Range`, refuse `HEAD` or need `Authorization`, files whose size is unknown,
  and files replaced while open (`ETag`). Cross-origin files need CORS that exposes `Content-Length`,
  `Content-Range` and `ETag`.
- Parquet is read with [hyparquet](https://github.com/hyparam/hyparquet): 107 KB gzip for the whole worker,
  and no special headers (COOP/COEP).

Options, serving Parquet, measurements and limits: https://vastgrid.yhay81.com/guides/browser/
