---
title: Open large CSV and Parquet files
description: View, sort and filter large CSV and Parquet files with vastgrid in your browser, VS Code or terminal. Try one million rows without installing anything or uploading data.
---

Use vastgrid when you want to inspect a large table with spreadsheet controls: scroll through rows, sort a
column, filter records, or select cells to see their sum. It is free and MIT licensed.

**[Try 1,000,000 rows now](/open/?sample=1)** — no account, install or file upload.

## Choose where to open your file

| What you need | Start here | Where the data goes |
| --- | --- | --- |
| Inspect a file without installing anything | [Open in the browser](/open/) | Stays in your browser; no upload |
| Work with files that exceed browser memory | `npx vastgrid-cli sales.parquet` | DuckDB on your computer |
| Stay in your editor | [Install the VS Code extension](/apps/vscode/) | DuckDB in the extension |
| Add the grid to your own app | [React quick start](/getting-started/) | Your choice of browser or server engine |

The browser also reads TSV, JSON Lines and Excel (`.xlsx`, `.xlsm`). DuckDB databases open through the CLI,
VS Code and the other DuckDB-backed apps. See the [format and save comparison](/apps/overview/).

## Start with the browser sample

1. [Open the sample](/open/?sample=1) and wait for the status bar to show **1,000,000 rows**.
2. Open the `unit_price` column menu (▾) and choose **Sort descending**.
3. Drag across a range of prices. The status bar shows the selection's count, sum and average.
4. Use **Open another file** to try your own CSV or Parquet file.

The sample generates a CSV in a Web Worker and reads it with `vastgrid-js`, the memory engine.
It does not download a million-row dataset. The [200,000-row orders demo](/demo/) is another way to explore
editing, grouping and formulas.

Files opened here are not uploaded. Edits stay in the page until you export them; closing or reloading the
page loses unsaved edits. Use the toolbar to export CSV, TSV, JSON or Excel. The browser does not overwrite
your original file.

## Open a large local file with one command

With Node.js 22.18 or later installed, run:

```sh
npx vastgrid-cli sales.parquet
```

Replace `sales.parquet` with your file's path. For example:

```sh
npx vastgrid-cli ./data/orders.csv
```

The command opens the grid in your browser while DuckDB reads the file on your computer. For a filename with
spaces, put the path in quotes. See the [CLI guide](/apps/cli/) for options, exports and saving CSV/TSV edits.

If you already use VS Code, [install vastgrid](/apps/vscode/) and open your file in its grid editor.

## How large is large?

The two engines have different limits:

- **Browser:** memory and operation costs depend on the file, columns, device and browser. Parquet reads row
  groups on demand; sorting or grouping can still need more memory than browsing. If an operation exceeds the
  memory limit, use the CLI or VS Code. See [browser engine limits](/guides/browser/).
- **DuckDB:** can use temporary disk space for larger workloads. In the published M2 Pro benchmark, a
  100-million-row Parquet file (1.38 GB) returned its first sorted rows in **953 ms**, with the rest of the view
  built **3 seconds later**. These are engine timings, excluding HTTP and rendering; they are not a promise
  for every file or device.

The million-row browser sample and the 100-million-row DuckDB benchmark are different workloads.
[Measurements and reproduction steps](/about/performance/) document both engines.

## Keep it handy or help improve it

If vastgrid is useful for your next data task, [star it on GitHub](https://github.com/yhay81/vastgrid) to find it
again. If a file does not open, [report its format, size and the error](https://github.com/yhay81/vastgrid/issues/new?template=bug_report.yml).
Use a small synthetic example when the original data is private.
