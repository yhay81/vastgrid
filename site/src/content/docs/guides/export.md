---
title: Exporting
description: The export panel, where files go, and how Excel files are written.
---

The toolbar's **Export** button opens a panel where the user chooses what to write and in which format.
It is shown when the source can export (`capabilities.export` and `exportView`), and offers the formats
of `info().exports`:

| Source | Formats | Where the file goes |
| --- | --- | --- |
| `RemoteSource` + `vastgrid-duckdb` | CSV, TSV, Parquet, JSON, Excel (`.xlsx`) | The server writes a new file (`delivery: "file"`), only when the handler has `resolveTarget`. |
| `ArraySource` | CSV, TSV, JSON, Excel | The browser downloads the file (`delivery: "data"`). |
| `BrowserSource` (`vastgrid-browser`) | None | Not offered yet: see [below](#vastgrid-browser). |

## What is written

- **Rows**: the current view, with its filters, search and sort as shown, or the whole table in its
  original order. A view that is still being sorted can be exported once it is ready.
- **Columns**: the shown columns in display order, or every column in schema order.
- **Column settings**: by default, the labels of `columnFormats` become the headers of CSV, TSV and Excel
  files, and Excel cells get the columns' number and date formats (`excelNumberFormat` maps them; a
  `format` function, compact notation and `Intl` date options fall back to the type's default). Parquet
  and JSON keep the schema names. Values are never replaced by their shown text.
- **File name**: the user's, with the format's extension.

The panel shows the progress, and **Cancel** (or closing the panel) stops the export: the server
interrupts the query and deletes the partial file. Errors are shown in the panel; Excel's limits are
checked before anything runs.

## Where files go

`exportOptions` connects the panel to your app. Each callback gets an `ExportContext`: the user's
`choice`, the `request` for `exportView`, the `delivery`, the `rowCount` and a `signal`.

```tsx
<DataGrid
  source={source}
  exportOptions={{
    fileName: "orders",                 // suggested name, without extension
    formats: ["xlsx", "csv"],           // offer only these (among the source's)
    // Decide the target: a path for a server, the download name for data. Return null to cancel.
    target: ({ request, delivery }) => (delivery === "file" ? `exports/${request.target}` : request.target),
    // Called when the file is done. Without it, returned data is downloaded and server files are reported.
    onExported: (result, { delivery }) => {
      if (delivery === "file") window.location.assign(`/downloads/${encodeURIComponent(result.target)}`);
    },
  }}
/>
```

### Saving on the server and downloading

A server source writes the file next to the data and returns only `{ target, rows }`, so large results
never pass through the browser. The server decides where `target` goes in `resolveTarget`, which must keep
it inside the folders the engine may use:

```ts
createTableHandler({
  engine,
  resolve: (ref) => resolveInside(dataRoot, ref),
  // Exports go to their own folder, under the name the user chose.
  resolveTarget: (target) => path.join(exportRoot, path.basename(target)),
});
```

To hand the file to the user's browser, serve that folder from your app and open its URL in `onExported`,
as above. The playground in the repository does this with `/data/exports/`.

### Downloading data from the browser

`ArraySource` returns the file as a `Blob` in `result.data`. Without `onExported`, the grid downloads it
(`downloadBlob`). With `onExported`, you get it to store elsewhere, for example with the File System
Access API or an upload.

### Without the panel

`exportOptions={false}` hides the panel. `ref.current.openExport()` opens it, also when the toolbar is
hidden. To build your own UI, `runExport(controller, choice, options, signal)` runs an export like the
panel, and `exportRequest(controller, choice)` builds only the request; or call `source.exportView(request)`
yourself.

## Excel files

Excel files are written without dependencies (a ZIP archive with SpreadsheetML), as a stream: the DuckDB
engine reads a chunk of rows at a time and compresses it as it goes, so the server's memory does not grow
with the table. A million rows of eight columns take about 7 seconds and 58 MB.

- One sheet, with a bold header row that stays in view when scrolling.
- Numbers are number cells. Numeric text that a double cannot hold exactly (64-bit IDs beyond 2^53,
  decimals with more than 15 significant digits) stays text, so that no digit changes.
- Dates, times and timestamps are Excel dates with a date format. Timestamps with a time zone are written
  in UTC. Dates before 1900-03-01 stay text.
- Text is always text, never a formula, also when it starts with `=`, `+`, `-` or `@`. Text longer than
  Excel's 32,767 characters is cut.
- `null` is an empty cell; booleans are TRUE and FALSE.
- More than 1,048,575 rows or 16,384 columns do not fit in a sheet: the panel says so and the source
  refuses with `export_too_large`. Filter the rows, or export CSV or Parquet. Splitting into several
  sheets is not done, since such files are hard to use in Excel.

The [protocol](/reference/protocol/#excel-export-rules) has the full rules. CSV and TSV files hold the
values as they are, so a spreadsheet app may read text that starts with `=` as a formula when it opens
them: prefer Excel files for spreadsheet users.

## vastgrid-browser

`BrowserSource` does not export yet (`capabilities.export` is `false`). An export there would read every
row in the worker and either hold the whole file in memory or write it through the File System Access API,
which only some browsers have. The plan is to write from the worker with `writeTableFile` into a stream the
app provides, so that the file never has to fit in memory; until then, export with a server or from an
`ArraySource`.
