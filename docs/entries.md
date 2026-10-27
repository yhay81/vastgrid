# Where vastgrid v2 opens files

[日本語](entries.ja.md)

vastgrid v2 opens huge CSV, Parquet and Excel files, and DataFrames, in six places. Each shows the same grid,
`DataGrid` of `vastgrid` (docs/v2-react.md), with the same document, session and commands (docs/v2-spec.md §5,
§6), and talks to its engine with the same messages (§8). What differs is the engine, how the messages travel, and
what the host does with written cells: each engine answers the capabilities of its host (§8.2), and none is made to
save as the others do.

## The entries

| Entry | Where the data is read | Engine | Messages travel | Details |
| --- | --- | --- | --- | --- |
| Browser page | in the browser, in a Web Worker | `vastgrid-js` | `workerTransport` | the site's `/open/` |
| React component | where the app puts its engine | `vastgrid-js`, `vastgrid-duckdb`, your own | a transport of §4.4 | [vastgrid](../packages/grid/README.md) |
| Command line | DuckDB, in the command (Node.js) | `vastgrid-duckdb` | `httpTransport` | [cli.md](cli.md) |
| VS Code | DuckDB, in the extension (Node.js) | `vastgrid-duckdb` | `workerTransport` over the webview's messages | [vscode.md](vscode.md) |
| MCP App | DuckDB, in the MCP server (Node.js) | `vastgrid-duckdb` | the App's tool calls | [mcp-app.md](mcp-app.md) |
| Notebook | DuckDB, in the kernel (Python) | `vastgrid` (Python) | `workerTransport` over the widget's messages | [notebook.md](notebook.md) |

## Formats

| Entry | CSV, TSV | JSON Lines | JSON | Parquet | Excel | DataFrames |
| --- | --- | --- | --- | --- | --- | --- |
| Browser page | yes | yes | | yes | `.xlsx`, `.xlsm` | |
| React component | as its engine reads | | | | | |
| Command line | yes, also compressed | yes | yes | yes | `.xlsx`, `.xlsm` | |
| VS Code | yes, also compressed | yes | | yes | `.xlsx`, `.xlsm` | |
| MCP App | yes, also compressed | yes | yes | yes | `.xlsx`, `.xlsm` | |
| Notebook | yes, also compressed | yes | yes | yes | `.xlsx` | pandas, Polars, PyArrow, DuckDB relations |

Every entry opens the sheets of a workbook, hidden ones marked, and a file of any size: Parquet files are read in
place a row range at a time, and the others are read into DuckDB, or into the memory engine within its memory limit.

## Editing, saving and exporting

| Entry | Edits cells | Saves into the file | Exports |
| --- | --- | --- | --- |
| Browser page | yes | no: the file stays in the browser | CSV, TSV, JSON, Excel, downloaded |
| React component | when the engine writes | when the engine saves (`capabilities.save`) | the engine's formats |
| Command line | yes | CSV and TSV, with `--save` (⌘S or Ctrl+S) | CSV, TSV, Parquet, JSON, Excel, downloaded |
| VS Code | yes (undo and redo on VS Code's stack) | CSV and TSV, with VS Code's Save; Save As writes any format | CSV, TSV, Parquet, JSON, Excel, where a save dialog says |
| MCP App | yes, the person and the agent alike | CSV and TSV, with `--save` | CSV, TSV, Parquet, JSON, Excel, written on the server |
| Notebook | yes | no: the notebook reads the written cells (`grid.to_pandas()`) | CSV, TSV, Parquet, JSON, Excel, downloaded or by `grid.export` |

A save writes only the edited fields of a CSV or TSV file and keeps every other byte (§7.5); a file changed on disk
since it was read is not saved over (§7.6). Written cells that are not saved stay with the engine until it stops.

## Installing

| Entry | How |
| --- | --- |
| Browser page | open https://vastgrid.yhay81.com/open/ (`/ja/open/` in Japanese); nothing to install |
| React component | `npm install vastgrid vastgrid-js`, or `vastgrid-duckdb` for an engine on a server (React 19.3 or later) |
| Command line | `npx vastgrid-cli <file or folder>…` (`--save` to save CSV and TSV files) |
| VS Code | the extension `yhay81.vastgrid-vscode` from the Marketplace, or a `.vsix` of a GitHub release (VS Code 1.100 or later) |
| MCP App | add `npx -y vastgrid-mcp <folder>` to the host's MCP servers |
| Notebook | `pip install vastgrid` (Python 3.11 or later; JupyterLab 4 or Notebook 7) |

Before 2.0.0 is released, the pre-releases are `vastgrid@next` (and the other npm packages at `@next`), `pip
install --pre vastgrid`, and the `.vsix` files of the GitHub release. From a clone of the repository, `npm install`
and `npm run build`, then: `npm run dev -w vastgrid-site` for the page, `node packages/cli/dist/cli.js` and
`node packages/mcp/dist/cli.js` for the commands, `code --extensionDevelopmentPath="$PWD/packages/vscode"
<folder>` or the package that `npm run package -w vastgrid-vscode` makes, and `pip install
./packages/notebook/python`.

## One grid in every entry

Each entry makes a store with `createGridStore` (`vastgrid/core`) over its transport and shows it with
`<DataGrid store={store}>`; nothing in the grid knows which entry it is in. What the entries needed of the React API,
and what they showed of it:

- **Transports.** `workerTransport` takes anything with `postMessage` and message events (`WorkerLike`), not only a
  Web Worker: VS Code's webview and the notebook's widget carry the messages over their own channels with it
  (v2-react.md §4.4). The CLI uses `httpTransport`, and the MCP App implements `Transport` over its tools.
- **Capabilities.** The grid offers what the engine answers it can do: the Save button and ⌘S only with
  `capabilities.save` (the command line with `--save`), exports in the formats of `capabilities.export`, written as
  its `delivery` says. VS Code saves itself and answers `save` false to its webview, so that its dirty state follows
  the file.
- **The document.** `onDocumentChange` gives the host the view (§5.1): the MCP App keeps the agent's grid in step
  with it, and the notebook reads it as `grid.plan` to export the view.
- **Keys.** The grid's keys work where the host leaves them to it: VS Code acts on its own keys of saving, Undo and
  Redo and gives them to the grid as commands, and a notebook skips its keys while the grid has the focus
  ([notebook.md](notebook.md#keys)). The grid follows the host's theme, light or dark.

Each entry is tested from opening a file, through editing it, to exporting or saving it: `e2e/open.spec.ts` (the
browser page), `e2e/cli.spec.ts` (the command line), `npm run test:vscode -w vastgrid-vscode` (VS Code),
`e2e/mcp.spec.ts` and `packages/mcp/test` (the MCP App), and `packages/notebook` with JupyterLab and Notebook 7 by
hand (the notebook, [notebook.md](notebook.md#testing)). The React component itself is tested in `packages/grid/test`
and the other files of `e2e`.
