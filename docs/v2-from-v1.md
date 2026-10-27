# From v1 to v2

v1 is vastgrid 0.1.x (the packages `vastgrid`, `vastgrid-core`, `vastgrid-duckdb` and `vastgrid-browser`). v2 is
vastgrid 2.0.0 and later: a new design, specified by [v2-spec.md](v2-spec.md) (§) and [v2-react.md](v2-react.md)
(React §), with a grid that keeps v1's features. v1's code was removed from this repository at 2.0.0; it stays in
the history at the tag [`v0.1.1`](https://github.com/yhay81/vastgrid/tree/v0.1.1).

This page is the migration guide (what to change in an app), then where each of v1's features is in v2.

## Migrating

### Packages

Install the packages of the engine you use with the grid, all at the same version:

| v1 (0.1.x) | v2 (2.0.0) |
| --- | --- |
| `vastgrid` (React) | `vastgrid`: the grid (`vastgrid`), its core without React (`vastgrid/core`), server rendering (`vastgrid/server`) and `vastgrid/styles.css` |
| `vastgrid-core` (protocol, `ArraySource`, `RemoteSource`) | `vastgrid/core` for transports; `vastgrid-js` for tables in memory; `vastgrid-spec` for the types, plans and formulas |
| `vastgrid-duckdb` (`TableEngine`, `createTableHandler`) | `vastgrid-duckdb` (`DuckDBEngine`, `createHttpHandler`): the same name, a new API |
| `vastgrid-browser` (`BrowserSource`, `serveTable`) | `vastgrid-js` in a Web Worker, with `workerTransport` and `serveEngine` of `vastgrid/core` |
| | new: `vastgrid-sql` (plans as DuckDB SQL), `vastgrid-cli`, `vastgrid-mcp`, the VS Code extension and the notebook's Python package |

`vastgrid-core` and `vastgrid-browser` have no v2 version and are deprecated on npm. Before 2.0.0 is released,
v2 is on the `next` tag: `npm install vastgrid@next vastgrid-js@next`.

The grid needs React 19.3 or later (v1: React 18 or later), as an optional peer: servers use `vastgrid/core`
and the engines without React. The packages need Node.js 20 or later.

### Sources become engines and transports

v1's grid read a **source** (`source={…}`), an object of the protocol. v2's grid reads a **table** of an
**engine** through a **transport**: `transport={…} table="…"`. Engines answer the messages of §8 wherever they
run, and transports carry them (React §4).

| v1 | v2 |
| --- | --- |
| `new ArraySource({ schema, rows, editable })` | `localTransport(memoryEngine({ tables: { orders: { columns, rows, editable } } }))`, `table="orders"` |
| `GroupedSource` | `aggregate` in the document's plan (§4.5); `having` and `sort` filter and sort the groups |
| `TableEngine` of `vastgrid-duckdb` with `createTableHandler`, and `RemoteSource` in the browser | `DuckDBEngine.create({ allowedDirectories, tempDirectory })` with `createHttpHandler(engine)`, and `httpTransport(url, { events })` in the browser; or `serverFunctionTransport` for a `"use server"` function |
| `BrowserSource({ file })`, `BrowserSource({ url })` | `memoryEngine({ tables: { [name]: { file } } })` or `{ parquet: file or url }`, served in a Worker by `serveEngine` and read by `workerTransport(worker)` |
| A source of your own (`TableSource`) | an engine of your own: the messages of §8, checked against the conformance corpus of `vastgrid-spec` |

```tsx
// v1
import { ArraySource, DataGrid } from "vastgrid";
const source = new ArraySource({ schema, rows });
<DataGrid source={source} frozenColumns={1} checkboxSelection />;

// v2
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";
const transport = localTransport(memoryEngine({ tables: { orders: { columns, rows } } }));
<DataGrid
  transport={transport}
  table="orders"
  defaultDocument={{ kind: "vastgrid/document", version: 2, columns: [{ name: "id", pin: "left" }] }}
  checkboxes
/>;
```

Values are typed (§2): a column is `{ name, type }` with the type's parameters (`{ name: "price", type:
"decimal", precision: 10, scale: 2 }`), and rows hold typed JSON (§2.2): a decimal is a string with its scale's
digits (`"1.50"`), a date `"2024-01-31"`, a timestamp `"2024-01-31 12:00:00"`, a bigint beyond 2^53 a string. v1's
`CellValue` passed exact numbers as strings too, but had no types beyond its schema's names. v1's row
positions (`RowBlock.rowIds`) are row IDs and row keys (§5.3). The spec's
[Appendix A](v2-spec.md#appendix-a-from-v1) maps the rest of v1's protocol (`TableSource.info`, `ViewQuery`,
filters, `columnStats`, `exportView`, `updateCells`, `subscribe`) to v2's messages.

### The grid's props

| v1 prop | v2 |
| --- | --- |
| `source` | `transport` and `table` (and `open`), or `store` (React §5.4) |
| `initialState`, `onStateChange` | `defaultDocument` or `document`, with `onDocumentChange`; and `defaultSession` or `session`, with `onSessionChange` (React §5.2). v1's saved states migrate with `migrateGridState` (below) |
| `onQueryChange`, `onColumnsChange` | `onDocumentChange`: the document's `plan` and `columns` |
| `onSelectionChange`, `onHistoryChange` | `onSessionChange`: the session's `selection` and `history` (§5.2) |
| `formulas`, `onFormulasChange` | the plan's `derive` (§4.11), in the document |
| `columnFormats` | each column's `format`, `wrap` and `total` in the document's `columns` (§5.1), and `styles` |
| `frozenColumns`, `frozenRightColumns` | `pin: "left"` or `pin: "right"` on the document's `columns` |
| `checkboxSelection` | `checkboxes` |
| `rowKey` | `rowKey` in the document (§5.3) |
| `rowSelection`, `onRowSelectionChange` | the session's `checked` (§5.2.1), with `onSessionChange` |
| `detailOpen`, `defaultDetailOpen`, `onDetailOpenChange` | the session's `detail` (`detail.open`, `detail.close`) |
| `maxLines` | `wrapLines` (default 2; v1's default was 3) |
| `cellAction`, `onCellClick`, `onCellDoubleClick` | `cellAction` and `onCellAction` (React §6.12); a double click and F2 edit a cell |
| `drawCell` | `drawCell`, with `cellText` and `cellStyle` for text and colors (React §6.12) |
| `readOnly` | the engine: a memory table writes its cells only with `editable: true`, and the DuckDB engine's tables are written in memory and saved only with `saveFiles` |
| `validateCell` | the engine checks values against their column's type (§7.3); a check of the app's own is not in v2 |
| `onCellsChange` | `onDocumentChange` and `onSessionChange` for the history, and `onError` for failures that belong to no command; failed writes offer Retry, Overwrite and Discard in the grid (React §6.6) |
| `exportOptions` | the `export` command (§6.6) and the Export menu; a server keeps exports and the browser downloads them (§8.2) |
| `copyValues` | `copy` with `raw` (§6.6); `formatted` is answered `unsupported` |
| `reloadKey`, `followTail` | engines follow their files (§7.6) and send `changed` events; `reload` reads a file again. Following the end of a growing file is not in v2 |
| `copyLimit`, `nullText` | not in v2: copying reads what it copies from the engine, and blank cells are empty |
| `locale`, `messages`, `rowHeight`, `headerHeight`, `columnGroups`, `groupHeaderHeight`, `toolbar`, `statusBar`, `detailPanel`, `className`, `style`, `aria-label` | the same names |
| `ref` (`DataGridHandle`) | `{ store, dispatch, focus }` (React §5.5): everything else is a command (§6) |

New in v2: `initial` (rows read on the server with `readInitialView` of `vastgrid/server`, shown before the
first read, React §7), `GridProvider` with the hooks `useGridSelector`, `useGridDispatch` and `useGridRows`
(React §5.3), and commands that hosts and agents dispatch as people's keys and menus do.

### Saved states

A `GridState` that v1 saved (`onStateChange`, version 1) becomes a document with `migrateGridState` of
`vastgrid-spec` (§5.6). It needs the table's columns, so read them first (`info`, or the store's snapshot):

```ts
import { migrateGridState } from "vastgrid-spec";

const { document, dropped, reasons } = migrateGridState(JSON.parse(saved), columns);
// dropped: JSON Pointers into the v1 state of what could not be migrated, and reasons[pointer] says why.
<DataGrid transport={transport} table="orders" defaultDocument={document} />;
```

It migrates the sort (by names), the search, filters and filter trees (as `where`), formulas (as `derive`), the
columns' widths, hidden columns, totals and frozen columns (as pins), and grouping and pivots with the groups'
sort and filters (as `aggregate`, `having` and `sort`). A query that v1 saved without a state migrates too. The
document is then repaired for the table (§5.5), so what no longer validates is removed and reported. The
session (selection, scroll position, checked rows, history) is not migrated: v1 did not save it either.

### Formulas

v2 reads v1's formula language: the same names, operators and functions, with every function of §4.4 and
literals of every type added (§4.11). A formula becomes a derived column of the plan, `{ name, expr }`:
`compileFormula(text, columns)` of `vastgrid-spec` gives its expression, and `formulaText(expr)` writes it back;
the grid's Formulas menu does both. `migrateGridState` compiles v1's formulas, each after those it uses.

Numbers are no longer all 64-bit floats: exact numbers stay exact, and nulls give nulls. Some formulas give other
results than in v1, as §4.11 lists: `ROUND(0.285, 2)` is `0.29` (v1: 0.28), `TEXT(0.00001)` is `0.00001` (v1:
`1e-05`), `LEFT('abc', NULL)` is null (v1: `""`), and `VALUE('1_000')` is null (v1: 1000).

### What else changes

- **Saving**: the DuckDB engine saves CSV and TSV files only when its host allows it (`saveFiles`), keeps every byte
  that was not edited, and refuses a file that changed on disk since it was read (§7.5). Other formats are never
  written; their written cells can be exported.
- **Totals and groups**: the totals row and grouping are plans (`total`, `aggregate`), computed by the engine
  for every row of the view, not the rows read.
- **Styles**: the grid's root is `.vg-root`, themed with the `--vg-*` variables (React §6.5). It follows the
  system's light or dark mode; `.vg-root { color-scheme: light }` keeps it light.
- **Loading**: the find bar, the detail panel and the menus load when they first open (React §10).

### Not in v2

- A tree of rows (#30, as in v1): data whose hierarchy is in columns is shown by grouping by several keys.
- Resizing several columns at once: each column is resized, or fitted to its values from its menu.
- `validateCell`, `copyLimit`, `nullText` and `followTail` (above).
- Charts inside the grid (as in v1): a chart reads a grouped view with `useGridRows`, as the site's example does.

## v1's features in v2

The issues of v1's roadmap ([#3](https://github.com/yhay81/vastgrid/issues/3)), #4 to #32, and where each
feature is in v2: **ported**, or **not in v2**, with the reason. All of the v2 roadmap's issues
([#33](https://github.com/yhay81/vastgrid/issues/33)) that v1's features waited for are done. Scopes are those v1
shipped: what v1 left out (a row tree, #30) is not added.

| v1 issue | Feature | v2 |
| --- | --- | --- |
| [#4](https://github.com/yhay81/vastgrid/issues/4) | Events of the selection, columns and cells | Ported: `onDocumentChange`, `onSessionChange` and `onError` (React §5.1), the store's events (React §4), and `onCellAction` (React §6.12). Every change is a command, which hosts can also dispatch. |
| [#5](https://github.com/yhay81/vastgrid/issues/5) | Saving and restoring the grid's settings | Ported: the document and the session (§5), controlled or not (React §5.2); `migrateGridState` reads v1's `GridState` (§5.6). |
| [#6](https://github.com/yhay81/vastgrid/issues/6) | Labels, number and date formats | Ported: `format` (§5.1, React §6.10), edited from the column menu. |
| [#7](https://github.com/yhay81/vastgrid/issues/7) | Custom drawing and conditional formats | Ported: `styles` in the document (§5.1), and `cellText`, `cellStyle` and `drawCell` (React §6.12). |
| [#8](https://github.com/yhay81/vastgrid/issues/8) | Selections kept by stable row IDs; checkboxes | Ported: row keys (§5.3), checked rows (§5.2.1) and `checkboxes` (React §6.11). |
| [#9](https://github.com/yhay81/vastgrid/issues/9) | Export formats and downloads | Ported: `export` (§6.6, §8.2) and the Export menu, [#38](https://github.com/yhay81/vastgrid/issues/38). |
| [#10](https://github.com/yhay81/vastgrid/issues/10) | Copying several ranges | Ported: `copy` places ranges as spreadsheets do (§6.6). |
| [#11](https://github.com/yhay81/vastgrid/issues/11) | OR across columns and nested AND / OR | Ported: `where` (§4.3) and the Conditions menu (React §6.9). |
| [#12](https://github.com/yhay81/vastgrid/issues/12) | Formula columns | Ported: `derive` written as formulas (§4.11) and the Formulas menu, [#39](https://github.com/yhay81/vastgrid/issues/39). |
| [#13](https://github.com/yhay81/vastgrid/issues/13) | Editing cells, with typed checks | Ported: §6.5, §7 and React §6.6, [#36](https://github.com/yhay81/vastgrid/issues/36): a failed write offers Retry, Overwrite after a conflict, and Discard. |
| [#14](https://github.com/yhay81/vastgrid/issues/14) | Pasting cells from Excel and TSV | Ported: `edit.paste` (§6.5.1). |
| [#15](https://github.com/yhay81/vastgrid/issues/15) | Undo and redo | Ported: §7.4. |
| [#16](https://github.com/yhay81/vastgrid/issues/16) | Fill from the selection | Ported: `edit.fill` with ⌘/Ctrl+D and R (React §6.12). v1 also left out the fill handle and series. |
| [#17](https://github.com/yhay81/vastgrid/issues/17) | CSV saved with the bytes not edited | Ported: `save` (§7.5), [#37](https://github.com/yhay81/vastgrid/issues/37). |
| [#18](https://github.com/yhay81/vastgrid/issues/18) | Large files in the browser, in a Worker | Ported: `vastgrid-js` reads CSV, TSV, JSON Lines, Excel and Parquet files in a Web Worker (`workerTransport` and `serveEngine`, React §4.4), [#43](https://github.com/yhay81/vastgrid/issues/43); the site's Open page uses it. |
| [#19](https://github.com/yhay81/vastgrid/issues/19) | Parquet at a URL, read by HTTP Range | Ported: `{ parquet: url }` in `vastgrid-js` reads the footer and the row groups that a view needs by HTTP Range, [#43](https://github.com/yhay81/vastgrid/issues/43). |
| [#20](https://github.com/yhay81/vastgrid/issues/20) | Reading Excel files | Ported: the DuckDB engine reads workbooks and their sheets (§8.2 `open`). |
| [#21](https://github.com/yhay81/vastgrid/issues/21) | Exporting Excel files | Ported: `xlsx` in `export` (§8.2), [#38](https://github.com/yhay81/vastgrid/issues/38). |
| [#22](https://github.com/yhay81/vastgrid/issues/22) | The first rows of a large sort before it ends | Ported: progressive views (§9), [#35](https://github.com/yhay81/vastgrid/issues/35). |
| [#23](https://github.com/yhay81/vastgrid/issues/23) | Columns frozen at the right | Ported: `pin: "right"` (§5.1, §6.3). |
| [#24](https://github.com/yhay81/vastgrid/issues/24) | The totals row (v1 left out freezing data rows) | Ported: `total` (§5.1) and the totals row (React §6.8). |
| [#25](https://github.com/yhay81/vastgrid/issues/25) | Column groups and headers of several rows | Ported: `columnGroups` (React §6.12); clicking a group selects its columns, and dragging it moves them (React §6.13). |
| [#26](https://github.com/yhay81/vastgrid/issues/26) | Wrapped text (v1: rows of one height, `maxLines`) | Ported: `wrap` (§5.1) and `wrapLines` (React §6.10). |
| [#27](https://github.com/yhay81/vastgrid/issues/27) | Grouping rows, subtotals and totals | Ported: `aggregate` (§4.1), the Group menu and the totals row (React §6.8). |
| [#28](https://github.com/yhay81/vastgrid/issues/28) | Pivot tables | Ported: `pivot` (§4.6) in the Group menu. |
| [#29](https://github.com/yhay81/vastgrid/issues/29) | Charts of grouped results (v1: an example with a chart library) | Ported as v1 had it, an example: the site's charts guide draws bars from a grouped view of the same store with `useGridSelector` and `useGridRows`, [#44](https://github.com/yhay81/vastgrid/issues/44). Charts in the grid itself stay out, as in v1. |
| [#30](https://github.com/yhay81/vastgrid/issues/30) | A tree of rows | Not in v2, as in v1: data whose hierarchy is in columns is shown by grouping by several keys. |
| [#31](https://github.com/yhay81/vastgrid/issues/31) | The detail panel | Ported: `detail` (§5.2), the Details button, Alt+Enter and `detailPanel` (React §6.11). |
| [#32](https://github.com/yhay81/vastgrid/issues/32) | Change notifications and live updates | Ported: `changes` and events (§7.6, §8.5), [#37](https://github.com/yhay81/vastgrid/issues/37). |

## Not in these issues

v1 features that no issue above names:

- Find (⌘F) with a find bar: ported (React §6.13).
- The cell menu, filtering to a cell's value or excluding it, and showing a value in full: ported (React §6.13).
- Moving columns by dragging their headers: ported (React §6.13). Resizing several columns at once is not in v2's
  grid: each column is resized, or fitted to its values from its menu.

## Input formats

| Where | v1 | v2 |
| --- | --- | --- |
| JavaScript values | `ArraySource`: rows of JSON | `vastgrid-js`: rows of typed JSON, Apache Arrow IPC |
| In the browser, without a server | `vastgrid-browser`: CSV, TSV, JSON Lines and Parquet files; Parquet at a URL | `vastgrid-js`: CSV, TSV, JSON Lines, Excel (`.xlsx`, `.xlsm`) and Parquet files; Parquet at a URL by HTTP Range |
| Node.js, with DuckDB | `vastgrid-duckdb`: CSV and TSV (also `.gz`, `.zst`), Parquet, JSON, JSON Lines, Excel; UTF-16, Shift_JIS and EUC-JP text | `vastgrid-duckdb`: the same formats and encodings, read by DuckDB without loading them whole |
| Apps | the playground (an example) | `vastgrid-cli`, the VS Code extension, the MCP App and the notebook, with the DuckDB engine ([entries.md](entries.md)) |

## Using the grid

What people do in the grid works as in v1, and is specified now: the keyboard of the ARIA grid pattern (§6.4) with
v1's shortcuts (React §6.4: Alt+Enter for the details, Alt+↓ for the column menu, Shift+F10 for the cell menu,
⌘/Ctrl+F, ⌘/Ctrl+D and R, ⌘/Ctrl+S); typing into a cell, with an IME whose keys stay its own while it composes;
copying and pasting with Excel and other spreadsheets (TSV and HTML); undo and redo; selecting, resizing, fitting,
moving, pinning and hiding columns; the column, cell, group, conditions, formulas and columns menus; the totals
row; and the find bar. English and Japanese are built in, as in v1. The end-to-end tests (`e2e/`) run these in a
browser, and the performance budgets of React §10 hold them to frame times while scrolling and editing.

## Saving

v1 saved CSV files with the bytes that were not edited (#17). v2 keeps that and specifies it (§7.5): the DuckDB
engine writes anew only the edited fields of the edited records of a CSV or TSV file, and keeps every other byte
(byte order mark, header, quoting, delimiters, line breaks, encoding). It writes a temporary file next to the
original and renames it over it, so the file is never half written; refuses a file that someone else changed since
it was read (`file_changed`), keeping the edits; saves only inside the folders it may read; and saves only when its
host allows it (`saveFiles`). Edits that are not saved stay in the session: a write that fails offers Retry,
Overwrite after a conflict, and Discard (React §6.6), and a file that changes on disk is read again only when it
has no edits (§7.6). Other formats are not written; the view with its edits can be exported to CSV, TSV, Parquet, JSON or Excel (§8.2).
