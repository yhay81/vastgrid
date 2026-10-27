# vastgrid

[![npm](https://img.shields.io/npm/v/vastgrid)](https://www.npmjs.com/package/vastgrid)
[![CI](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/yhay81/vastgrid)](LICENSE)

vastgrid opens huge CSV, TSV, Parquet, JSON Lines and Excel files like a spreadsheet, lets people fix them, and
saves them safely. It is a canvas data grid for React with engines for the browser and Node.js, and the same grid
comes as a command, a VS Code extension, an MCP App and a Jupyter widget.

**[Try the demo](https://vastgrid.yhay81.com/demo/)** · [Open a file in the browser](https://vastgrid.yhay81.com/open/) · [Documentation](https://vastgrid.yhay81.com) · [日本語](README.ja.md)

[![A Parquet file of 100,000,000 rows sorted by price in vastgrid-cli, with a selection and its sum in the status bar](docs/images/grid.jpg)](https://vastgrid.yhay81.com/demo/)

- **Any size.** Rows are read a block at a time as you scroll, and Parquet files are read in place, also over HTTP
  Range requests. A 100-million-row Parquet file sorts on DuckDB with its first rows ready in under a second.
  Cells are drawn on a canvas, and scrolling renders no React.
- **A spreadsheet's way of working.** Excel's keys and selections, sorting, filters, conditions, search and find,
  groups, pivots and totals, formulas, formats, copy, paste and fill.
- **Edits you can trust.** Typed input is checked against the column's type, writes are checked for conflicts and
  can be undone, and saving a CSV or TSV file rewrites only the edited fields and keeps every other byte. A file
  that changes on disk is followed, and is never saved over.
- **One state, typed commands.** What the grid shows is a document (the view and its columns) and a session (where
  the person is), controlled or not. Every change is a command that a toolbar, a host or an AI agent can dispatch.
- **Engines you choose.** `vastgrid-js` in memory, in the page or a Web Worker; `vastgrid-duckdb` on Node.js; or
  your own, through a small set of messages.
- **English and Japanese** built in, light and dark themes through CSS variables, ARIA grid semantics and full
  keyboard operation.

## Where to use it

| Where | How | Engine |
| --- | --- | --- |
| A React app | `npm install vastgrid vastgrid-js` ([quick start](#quick-start)) | in memory, a worker, or a server |
| The browser | [vastgrid.yhay81.com/open/](https://vastgrid.yhay81.com/open/): drop a file; it stays in the browser | `vastgrid-js` in a Web Worker |
| The command line | `npx vastgrid-cli sales.parquet` | DuckDB on this computer |
| VS Code | the extension [vastgrid](packages/vscode) (`yhay81.vastgrid-vscode`) | DuckDB in the extension |
| An AI chat | the MCP server `vastgrid-mcp` with its MCP App | DuckDB in the MCP server |
| A Jupyter notebook | `pip install vastgrid`, then `vastgrid.show(df)` | DuckDB in the kernel |

[docs/entries.md](docs/entries.md) compares them: formats, editing, saving and exporting.

**Command line.** Opens files or folders in a grid in the browser, served on 127.0.0.1 only; `--save` lets ⌘S or
Ctrl+S save edited CSV and TSV files ([docs/cli.md](docs/cli.md)).

```sh
npx vastgrid-cli sales.parquet
npx vastgrid-cli --save data/
```

**VS Code.** Parquet and Excel files open in vastgrid; CSV, TSV and JSON Lines files open with "Open in vastgrid".
Cells of CSV and TSV files are saved with VS Code's Save, and undone with its Undo ([docs/vscode.md](docs/vscode.md)).

**MCP App.** An agent opens a file in a grid that the person sees in the chat, and both work on the same grid: the
agent reads its state and rows and applies the same commands as the person's keys and menus
([docs/mcp-app.md](docs/mcp-app.md)).

```json
{ "mcpServers": { "vastgrid": { "command": "npx", "args": ["-y", "vastgrid-mcp", "/path/to/data"] } } }
```

**Notebook.** A DataFrame, an Arrow table, a DuckDB relation or a file in JupyterLab 4 or Notebook 7; the notebook
reads the edited table back ([docs/notebook.md](docs/notebook.md)).

```python
import vastgrid

grid = vastgrid.show("sales.parquet")  # or a pandas or Polars DataFrame
grid.to_pandas(view=True)              # the grid's view, with the edited cells
```

## Quick start

```sh
npm install vastgrid vastgrid-js
```

Until 2.0.0 is released, the packages are prereleases on npm's `next` tag, and `npm install vastgrid` still gives
v1 (0.1.x): try this version with `npm install vastgrid@next vastgrid-js@next` (and `@next` for the other packages).

```tsx
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(
  memoryEngine({
    tables: {
      orders: {
        columns: [
          { name: "id", type: "integer" },
          { name: "customer", type: "string" },
          { name: "price", type: "decimal", precision: 10, scale: 2 },
          { name: "ordered", type: "date" },
        ],
        rows: [
          [1, "Acme", "12.50", "2026-01-31"],
          [2, "Globex", "8.00", "2026-02-01"],
        ],
        editable: true,
      },
    },
  }),
);

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

Rows are typed JSON: decimals as strings with their exact digits, dates as `YYYY-MM-DD`
([v2-spec.md §2.2](docs/v2-spec.md#22-values-in-json)). The memory engine also takes Apache Arrow, and CSV, TSV,
JSON Lines, Excel and Parquet files ([vastgrid-js](packages/js)). With `editable: true`, people write cells; the
written values are kept apart from `rows`, and every view, total and export sees them.

The grid works uncontrolled, or with `document` and `onDocumentChange` (the view: plan, column widths, formats,
pins) and `session` and `onSessionChange` (selection, scroll, undo history), so that a host can save and restore
them. Everything is a typed command, and your own controls dispatch the same ones:

```tsx
import { DataGrid, GridProvider, useCreateGridStore, useGridDispatch, useGridSelector } from "vastgrid";

function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <ClearSort />
      <DataGrid store={store} style={{ height: 480 }} />
    </GridProvider>
  );
}

function ClearSort() {
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const dispatch = useGridDispatch();
  return (
    <button type="button" disabled={!sort} onClick={() => dispatch({ command: "sort.clear" })}>
      Clear sort
    </button>
  );
}
```

The props, hooks and commands are in [docs/v2-react.md](docs/v2-react.md) and [docs/v2-spec.md](docs/v2-spec.md)
§5–§6.

## Large files

**In a Web Worker.** The memory engine runs in a worker as it does in the page, so that sorting a million rows never
blocks the page. Parquet is read by row groups as the grid needs them, from a `File` or a URL that answers HTTP
Range requests:

```ts
// engine.worker.ts
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({ tables: { trips: { parquet: "https://example.com/trips.parquet" } } });
serveEngine(engine, self as unknown as WorkerLike);
```

```tsx
import { DataGrid, workerTransport } from "vastgrid";

const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
const transport = workerTransport(worker);

export function Trips() {
  return <DataGrid transport={transport} table="trips" style={{ height: 600 }} />;
}
```

A file that the person drops or chooses is posted to the worker and given as `{ file }` (CSV, TSV, JSON Lines,
Excel) or `{ parquet: file }`, as [the open page](site/src/components/open/engine-worker.ts) does. Columns read
whole stay within `maxBytes` (1 GiB by default); beyond it, a text file is read by blocks.

**On a server, with DuckDB.** `vastgrid-duckdb` opens files of any size on Node.js: Parquet in place, and CSV, TSV,
JSON Lines and Excel loaded into DuckDB with their first rows readable at once. It reads only files inside the
folders you allow, by their real location with links followed, loads no DuckDB extensions, and passes every value
to SQL as a parameter.

```ts
// server.ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
  saveFiles: true, // lets the grid save edited CSV and TSV files
});
createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

```tsx
import { DataGrid, httpTransport } from "vastgrid";

const transport = httpTransport("/api", { events: "/api/events" });

export function Sales() {
  return <DataGrid transport={transport} table="sales.csv" style={{ height: 600 }} />;
}
```

The handler also works as middleware (Express, Connect, Vite). `serverFunctionTransport` carries the messages
through a React Server Function instead, and `readInitialView` of `vastgrid/server` reads the first rows on the
server, which the grid sends as HTML before the canvas takes over (v2-react.md §7).

## Editing and saving

What the engines guarantee ([v2-spec.md §7](docs/v2-spec.md#7-editing)):

- **Typed checks.** Text that people type or paste is read as the column's type without losing digits (`1,234.5`
  pasted into a number column is 1234.5); a value that does not fit keeps the editor open and says why.
- **Atomic writes with conflict checks.** A write changes every cell or none. Each cell carries the value it was
  edited from: when someone else changed it meanwhile, the write fails, and the grid offers Retry, Overwrite or
  Discard.
- **Undo and redo** of typed values, clears, pastes and fills (100 steps), also of an agent's writes in the MCP App.
- **Kept apart until saved.** Written cells are not in the file until it is saved, and every view, filter, total,
  find and export sees them.
- **Saves that keep every other byte.** `save` writes only the edited fields of a CSV or TSV file, and keeps its byte
  order mark, quoting, delimiters, line breaks and encoding (Shift_JIS and UTF-16 included). It writes a temporary
  file and renames it over the original, so a failed save leaves the file as it was, and it refuses a file that
  someone else changed since it was read.
- **Files that change on disk** are read again. When the table has unsaved edits, it stays as it was read, the grid
  says the file changed, and "Discard edits and reload" reads it anew.

Other formats are not saved into: export them, with the edits, as CSV, TSV, Parquet, JSON or Excel.

## Features

- **Reading.** Sort by several columns (click a header, Shift to add a key); filter a column by a list of its values
  with their counts, or by a condition; the Conditions menu combines conditions across columns with AND and OR in
  nested groups; a search box across all columns; find (⌘F); column statistics.
- **Shaping.** Group by columns with count, distinct count, sum, average, standard deviation, min, max and quantile;
  pivot values into columns; a totals row; formulas as derived columns (`qty * price`), from the Formulas menu.
- **Columns.** A menu on every header (the arrow, a right click or Alt+↓): sort, filter, statistics, total, group,
  fit, pin to the left or the right, hide. Drag headers to move columns and their edges to resize them; the Columns
  menu shows, hides and moves them; `columnGroups` adds header rows of groups.
- **Formats.** Labels, alignment, wrapping, number, percent and currency formats, date patterns (`yyyy/MM/dd`), and
  conditional colors, from the column's Format… item.
- **Selecting and editing.** Ranges with the mouse and Excel's keys, several ranges at once; copy as TSV and HTML,
  paste from spreadsheets, fill down and right, and the count, sum and average of the selection.
- **Rows.** Check boxes that keep the same records checked through sorts and filters (`checkboxes`), and a detail
  panel of the active row (Alt+Enter, or your own `detailPanel`).
- **Exporting** the view or the whole table as CSV, TSV, JSON or Excel (with the columns' number and date formats),
  and Parquet with the DuckDB engine, which writes the file on the server.
- **Your own cells.** `cellText`, `cellStyle`, `drawCell` (draw on the canvas, with the grid's drawing at hand) and
  `cellAction` (links and buttons, with `onCellAction`).
- **Languages.** English and Japanese by `locale`, and any text replaced by `messages`.
- **Theming.** Every color, font and size is a CSS custom property on `.vg-root`, which the canvas reads; colors are
  `light-dark()` pairs that follow the page's light or dark scheme.

  ```css
  .my-app .vg-root {
    --vg-font-family: "Inter", sans-serif;
    --vg-accent: var(--brand);
    --vg-selection-bg: color-mix(in srgb, var(--brand) 15%, transparent);
  }
  ```

- **Accessibility.** The ARIA grid pattern, with the rows on screen as accessible rows under the canvas, the active
  cell as `aria-activedescendant`, and results announced in a live region.
- **Server rendering.** The first rows as an HTML table, streamed from a Server Component; Strict Mode and
  concurrent rendering; every component compiled with React Compiler.

### Keyboard

| Keys | Action |
| --- | --- |
| Arrows · Page Up/Down · Home/End | Move the active cell; with ⌘/Ctrl, jump to the first or last row or column |
| Shift + the above · Shift + click · ⌘/Ctrl + click | Extend the selection · add a range |
| Tab · Enter (Shift: backwards) | Move within the selection |
| ⌘/Ctrl + A | Select everything |
| ⌘/Ctrl + C · ⌘/Ctrl + V | Copy · paste |
| Typing · F2 · double click | Edit the active cell (Enter writes, Esc cancels) |
| Delete · ⌘/Ctrl + D · ⌘/Ctrl + R | Clear the selected cells · fill down · fill right |
| ⌘/Ctrl + Z · ⌘/Ctrl + Shift + Z or Ctrl + Y | Undo · redo |
| ⌘/Ctrl + S | Save, when the engine saves the file |
| ⌘/Ctrl + F | Find |
| Alt + ↓ · Shift + F10 | The column menu · the cell menu |
| Space · Alt + Enter | Check the active row (with `checkboxes`) · the detail panel |

## Packages

| Package | Contents |
| --- | --- |
| [`vastgrid`](packages/grid) | The React grid: `DataGrid`, `GridProvider` and the hooks; `vastgrid/core` (the store and the transports, without React), `vastgrid/server`, `vastgrid/styles.css`. |
| [`vastgrid-js`](packages/js) | The memory engine, for the browser and Node.js: rows of typed JSON, Arrow, CSV, TSV, JSON Lines, Excel and Parquet (also over HTTP). |
| [`vastgrid-duckdb`](packages/duckdb-engine) | The DuckDB engine for Node.js: files of any size, writing cells, saving CSV and TSV, following files, exports; an HTTP handler. |
| [`vastgrid-spec`](packages/spec) | The specification as code: types, plan checking, commands, message schemas, the conformance corpus. |
| [`vastgrid-sql`](packages/sql) | Plans as DuckDB SQL. |
| [`vastgrid-cli`](packages/cli) | `npx vastgrid-cli <file>`: a file in a grid in the browser, read by DuckDB on this computer. |
| [`vastgrid-mcp`](packages/mcp) | An MCP server with an MCP App. |
| [`vastgrid-vscode`](packages/vscode) | The VS Code extension, on the Marketplace. |
| [`vastgrid` (Python)](packages/notebook/python) | The Jupyter widget, on PyPI. |

The npm packages are released together at one version. `vastgrid` needs React 19.3 or later (an optional peer
dependency: servers use `vastgrid/core` without React) and a browser with CSS `light-dark()`: Chrome and Edge 123,
Firefox 120, Safari 17.5 or later. The engines need Node.js 20 or later; DuckDB runs on Linux (x64, arm64; glibc
and musl), macOS (x64, arm64) and Windows (x64, arm64).

## Performance

On an Apple M2 Pro. In Chromium, the grid on a table of 1,000,000 rows and 8 columns in the memory engine
([v2-react.md Appendix A](docs/v2-react.md#a2-in-the-browser), tested against budgets by `e2e/budgets.spec.ts`):

| Measure | Time |
| --- | ---: |
| From mount to the first rows on screen | 36–49 ms |
| From a key press to the next frame (95th percentile) | 13.4–14.1 ms |
| The gap between frames while scrolling (95th percentile) | 16.7–16.8 ms: no frame dropped at 60 Hz |
| React commits while scrolling 100 frames | 0 |
| Sorting by a float column until the rows are on screen: engine in the page · in a Web Worker | 85–98 ms · 112–113 ms |
| The longest task of the page meanwhile: engine in the page · in a Web Worker | 81–93 ms · none |

The DuckDB engine on Node.js 24 with DuckDB 1.5.6, 8 threads and 2 GB of memory
([v2-views-benchmark.md](docs/v2-views-benchmark.md)); 256 rows of 8 columns at a time, without HTTP:

| File and view | First rows | 256 rows anywhere in the view, median |
| --- | ---: | ---: |
| Parquet, 1.38 GB, 100M rows, sorted by a float | 778 ms | 676 ms |
| Parquet, 100M rows, filtered | 191 ms | 21 ms |
| CSV, 735 MB, 10M rows, sorted | 53 ms | 3.1 ms |
| CSV, 10M rows, filtered | 179 ms | 2.7 ms |

Saving two edited cells takes about 60 ms in a 6 MB CSV file and 0.3 s in a 65 MB one; a sorted view of a million
rows exports in 0.3 s as CSV and 0.1 s as Parquet. The memory engine opens a million-row Parquet file in 26 ms and a
CSV one in about a second ([v2-memory-engine-benchmark.md](docs/v2-memory-engine-benchmark.md)). What a page loads
first of `DataGrid` and the memory engine is about 100 KB with gzip; menus and panels load when they open.

## Migrating from v1

vastgrid 2.0 replaces 0.1.x. The grid reads through an engine and a transport instead of v1's sources, its state is
a document and a session, and the separate core and browser packages are gone: their parts are in `vastgrid/core`
and `vastgrid-js`. `vastgrid-duckdb` is now the DuckDB engine of this version (`DuckDBEngine`, `createHttpHandler`).
`migrateGridState` of `vastgrid-spec` reads v1's saved grid state, and formulas keep v1's language.
[docs/v2-from-v1.md](docs/v2-from-v1.md) maps every v1 feature to its place now.

## Documentation

- [vastgrid.yhay81.com](https://vastgrid.yhay81.com): guides, the demo and the open page.
- [docs/entries.md](docs/entries.md): the React component, the browser page, the command line, VS Code, the MCP App
  and the notebook compared. [cli.md](docs/cli.md), [vscode.md](docs/vscode.md), [mcp-app.md](docs/mcp-app.md) and
  [notebook.md](docs/notebook.md) describe each.
- [docs/v2-react.md](docs/v2-react.md): the React API (store, transports, `DataGrid`, hooks, rendering, server
  rendering).
- [docs/v2-spec.md](docs/v2-spec.md): values and types, plans, the document and session, commands, editing and
  saving, and the messages between the grid and its engine.
- [CHANGELOG.md](CHANGELOG.md), and plans in the [GitHub issues](https://github.com/yhay81/vastgrid/issues).

## Development

```sh
npm install
npm run build      # every package, the CLI's page, the MCP App and the extension
npm test           # the unit tests, on the sources
npm run e2e        # Playwright on the build
npm run dev        # examples/files: the grid on the DuckDB engine, at http://127.0.0.1:5182
npm run dev -w vastgrid-site   # the site, the demo and /open/, at http://localhost:4321
```

`npm run typecheck`, `npm run lint` and `npm run bench` check and measure the rest. See
[CONTRIBUTING.md](CONTRIBUTING.md) before a change.

## License

MIT
