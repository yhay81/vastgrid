---
title: Exporting
description: The Export menu, what is written in each format, where the file goes, and exporting from code.
---

The toolbar's **Export** menu writes the grid's rows into a file. It is shown when the engine exports
(`capabilities.export`), with a button for each format the engine offers (`capabilities.export.formats`).

| Engine | Formats | Where the file goes (`capabilities.export.delivery`) |
| --- | --- | --- |
| Memory engine (`vastgrid-js`) | CSV, TSV, JSON, Excel | `data`: the engine answers the file's bytes, and the browser saves them |
| DuckDB engine (`vastgrid-duckdb`) | CSV, TSV, Parquet, JSON, Excel | `file`: the engine writes the file on the server, and the browser downloads it |

## What is written

- **Rows**: "Rows of the view" (the default) writes the view as the grid shows it, with its filters, search,
  sort, formula columns and groups. "Whole table" writes every row of the table in its own order, without them.
- **Columns**: the displayed columns in display order. "Hidden columns too" adds the others after them.
- **Headers**: the columns' labels (set with Format…, or the names) head CSV, TSV and Excel files. Parquet and JSON
  files keep the names.
- **Values**: the values, not the text on screen, including the cells written in the grid
  ([Editing](/guides/editing/)). Excel cells get the columns' number and date formats.
- **File name**: the table's name with the format's extension: `orders.csv` exports as `orders.xlsx`.

While the export runs, the button says "Exporting…"; when it is done, the grid announces "Exported 12,345 rows". A
file is complete or not there at all: a failed export leaves nothing behind. A table that is still loading is
exported once it has loaded.

## Formats

| Format | Written as | Limits |
| --- | --- | --- |
| CSV, TSV | A header line, then the values as text, quoted when they need it | None |
| Parquet | The columns under their names, with their types | None |
| JSON | An array of objects by column name; numbers with all their digits (`"nan"` and `"inf"` as text), booleans as such, other values as text | None |
| Excel (`.xlsx`) | One sheet with a bold, frozen header row; numbers, booleans and dates as such cells, with the columns' formats; text always as text, never a formula; numbers that a double cannot hold exactly as text | 1,048,575 rows and 16,384 columns (`export_too_large`); 32,767 characters a cell, longer text cut; 4 GB |

In Excel files, a column's number format (decimal places, digit grouping, percent, currency) and date pattern
from Format… become the cells' format codes, so the workbook shows the numbers as the grid does. The rules are in
[§8.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#82-operations) of the specification.

## Where the file goes

### Memory engine: in the page

The engine answers the file's bytes (`delivery: "data"`), and the grid saves them as a file made in the page.
Nothing leaves the browser, also when the engine runs in a Web Worker.

### DuckDB engine: on the server

The engine writes the file into its temporary folder (`delivery: "file"`) and answers a name for it as `target`. It
keeps the 16 latest exports for an hour. `createHttpHandler` serves them at `GET <path>/exports/<name>`, with the
file's name, and `httpTransport` gives the grid that URL (`exportUrl`), which the browser downloads:

```ts
import http from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });
http.createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

```tsx
import { DataGrid, httpTransport } from "vastgrid";

const transport = httpTransport("/api"); // downloads from /api/exports/<name>

export const Orders = () => <DataGrid transport={transport} table="orders.parquet" />;
```

When the files are served from elsewhere, `httpTransport(url, { exports })` and the handler's `exports` option
move the download path.

To write exports where the host chooses instead, give the engine `resolveTarget`: it maps an export's `target` to
a path inside the allowed folders, or throws to refuse it (`not_allowed`). The engine then writes the file there,
under a temporary name that it renames once the file is complete, and keeps nothing. The Export menu names no
target; code does (below). Without `resolveTarget`, an export that names a target is refused.

The [apps](/apps/overview/) handle exports their own way: the command line's browser downloads them, VS Code
writes them where a save dialog says, a notebook's grid saves the bytes in the browser, and an MCP App cannot
download them yet.

## Exporting from code

The Export menu dispatches the `export` command, which an app can dispatch too:

```ts
const store = grid.current!.store; // a DataGrid's handle, or useGridStore() under a GridProvider
const outcome = await store.dispatch({ command: "export", format: "csv", rows: "view", columns: "displayed" });
if (outcome.ok) {
  const { target, rows, data } = outcome.output as { target: string | null; rows: number; data?: { bytes: Uint8Array } };
  if (data) {
    // The memory engine: the file's bytes, named like the menu names them.
    const file = new File([data.bytes], store.exportName("csv"));
  } else if (target !== null) {
    // The DuckDB engine: where the file can be downloaded, or null when the transport does not say.
    const url = store.exportUrl(target);
  }
}
```

| Argument | Values |
| --- | --- |
| `format` | One of `capabilities.export.formats`; another fails with `unsupported` |
| `rows` | `"view"` (default) or `"table"` |
| `columns` | `"displayed"` (default) or `"all"` |
| `target` | Where the DuckDB engine writes the file, through its `resolveTarget` |

`rows` in the output is the number of rows written. The headers and Excel formats come from the document's column
settings, as in the menu.
