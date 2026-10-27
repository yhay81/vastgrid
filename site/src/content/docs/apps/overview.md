---
title: Where vastgrid opens files
description: The six places vastgrid opens CSV, TSV, Parquet, JSON Lines and Excel files and DataFrames, and what each reads, edits, saves and exports.
---

vastgrid opens huge CSV, TSV, Parquet, JSON Lines and Excel files, and DataFrames, in six places. Each shows the
same grid, `DataGrid` of `vastgrid`, with the same document, session and commands, and talks to its engine with
the same messages. What differs is the engine, how the messages travel, and what the host does with the cells you
write.

- To look at a file now: the [command line](/apps/cli/), or [Open a file](/open/) on this site with nothing to
  install.
- To work in your editor: [VS Code](/apps/vscode/).
- To work on a table with an agent: the [MCP App](/apps/mcp/).
- With DataFrames: the [notebook](/apps/notebook/).
- In your own app: the React component, from [Getting started](/getting-started/).

## The entries

| Entry | Get it | Where the data is read | Engine | Messages travel |
| --- | --- | --- | --- | --- |
| Browser page | [/open/](/open/) on this site | in the browser, in a Web Worker | `vastgrid-js` | `workerTransport` |
| React component | `npm install vastgrid` and an engine | where the app puts its engine | `vastgrid-js`, `vastgrid-duckdb` or [your own](/guides/custom-engine/) | `localTransport`, `workerTransport`, `httpTransport` or `serverFunctionTransport` |
| [Command line](/apps/cli/) | `npx vastgrid-cli <file>` | DuckDB, in the command (Node.js) | `vastgrid-duckdb` | `httpTransport` |
| [VS Code](/apps/vscode/) | the extension `vastgrid-vscode` | DuckDB, in the extension (Node.js) | `vastgrid-duckdb` | `workerTransport` over the webview's messages |
| [MCP App](/apps/mcp/) | `npx vastgrid-mcp <folder>` | DuckDB, in the MCP server (Node.js) | `vastgrid-duckdb` | the App's tool calls |
| [Notebook](/apps/notebook/) | `pip install vastgrid` | DuckDB, in the kernel (Python) | `vastgrid` (Python) | `workerTransport` over the widget's messages |

## Formats

| Entry | CSV, TSV | JSON Lines | JSON | Parquet | Excel | DataFrames |
| --- | --- | --- | --- | --- | --- | --- |
| Browser page | yes | yes | | yes | `.xlsx`, `.xlsm` | |
| React component | as its engine reads | | | | | |
| Command line | yes, also compressed | yes | yes | yes | `.xlsx`, `.xlsm` | |
| VS Code | yes, also compressed | yes | | yes | `.xlsx`, `.xlsm` | |
| MCP App | yes, also compressed | yes | yes | yes | `.xlsx`, `.xlsm` | |
| Notebook | yes, also compressed | yes | yes | yes | `.xlsx` | pandas, Polars, PyArrow, DuckDB relations |

Every entry opens the sheets of a workbook, hidden ones marked, and a file of any size. Parquet files are read in
place, a row range at a time; the others are read into DuckDB, or into the memory engine within its memory limit
(`maxBytes`, see [Large files in the browser](/guides/browser/)).

## Editing, saving and exporting

| Entry | Edits cells | Saves into the file | Exports |
| --- | --- | --- | --- |
| Browser page | yes | no: the file stays in the browser | CSV, TSV, JSON, Excel, downloaded |
| React component | when the engine writes | when the engine saves (`capabilities.save`) | the engine's formats |
| Command line | yes | CSV and TSV, with `--save` (⌘S or Ctrl+S) | CSV, TSV, Parquet, JSON, Excel, downloaded |
| VS Code | yes, with undo and redo on VS Code's stack | CSV and TSV, with VS Code's Save; Save As writes any format | CSV, TSV, Parquet, JSON, Excel, where a save dialog says |
| MCP App | yes, the person and the agent alike | CSV and TSV, with `--save` | CSV, TSV, Parquet, JSON, Excel, written on the server |
| Notebook | yes | no: the notebook reads the written cells (`grid.to_pandas()`) | CSV, TSV, Parquet, JSON, Excel, downloaded or by `grid.export` |

A save writes only the edited fields of a CSV or TSV file and keeps every other byte: the byte order mark, the
quoting, the delimiters, the line breaks and the encoding. A file that changed on disk since it was read is not
saved over. Written cells that are not saved stay with the engine until it stops. [Editing cells](/guides/editing/)
covers both.

## One grid in every entry

Each entry makes a store with `createGridStore` (`vastgrid/core`) over its transport and shows it with
`<DataGrid store={store}>`; nothing in the grid knows which entry it is in.

- **Transports.** `workerTransport` takes anything with `postMessage` and message events, not only a Web Worker:
  VS Code's webview and the notebook's widget carry the messages over their own channels with it. The command
  line uses `httpTransport`, and the MCP App implements `Transport` over its tools. See
  [The store and transports](/reference/core/).
- **Capabilities.** The grid offers what the engine answers it can do: the Save button and ⌘S only with
  `capabilities.save`, exports in the formats of `capabilities.export`. VS Code saves by itself, so its webview's
  engine answers `save` false and the editor's dirty state follows the file.
- **The document.** `onDocumentChange` gives the host the view: the MCP App keeps the agent's grid in step with
  it, and the notebook reads it as `grid.plan`.
- **Keys and themes.** The grid's keys work where the host leaves them to it: VS Code acts on its own keys of
  saving, Undo and Redo and gives them to the grid as commands, and a notebook skips its keys while the grid has
  the focus. The grid follows the host's theme, light or dark.

[entries.md](https://github.com/yhay81/vastgrid/blob/main/docs/entries.md) on GitHub has the same comparison
and how each entry is tested.
