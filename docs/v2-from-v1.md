# v1's features in v2

The issues of v1's roadmap ([#3](https://github.com/yhay81/vastgrid/issues/3)), #4 to #32, and where each
feature is in v2: **ported**, **in another issue** of the v2 roadmap ([#33](https://github.com/yhay81/vastgrid/issues/33)),
or **not in v2**, with the reason. Scopes are those v1 shipped: what v1 left out (a row tree, #30) is not added.
The specifications are [v2-spec.md](v2-spec.md) (§) and [v2-react.md](v2-react.md) (React §).

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
| [#13](https://github.com/yhay81/vastgrid/issues/13) | Editing cells, with typed checks | Ported: §6.5, §7 and React §6.6, [#36](https://github.com/yhay81/vastgrid/issues/36). |
| [#14](https://github.com/yhay81/vastgrid/issues/14) | Pasting cells from Excel and TSV | Ported: `edit.paste` (§6.5.1). |
| [#15](https://github.com/yhay81/vastgrid/issues/15) | Undo and redo | Ported: §7.4. |
| [#16](https://github.com/yhay81/vastgrid/issues/16) | Fill from the selection | Ported: `edit.fill` with ⌘/Ctrl+D and R (React §6.12). v1 also left out the fill handle and series. |
| [#17](https://github.com/yhay81/vastgrid/issues/17) | CSV saved with the bytes not edited | Ported: `save` (§7.5), [#37](https://github.com/yhay81/vastgrid/issues/37). |
| [#18](https://github.com/yhay81/vastgrid/issues/18) | Large files in the browser, in a Worker | In another issue: [#43](https://github.com/yhay81/vastgrid/issues/43). `workerTransport` runs an engine in a Worker already (React §4.4); the engine that reads large files in the browser is #43's. |
| [#19](https://github.com/yhay81/vastgrid/issues/19) | Parquet at a URL, read by HTTP Range | In another issue: [#43](https://github.com/yhay81/vastgrid/issues/43), with the browser's engine. |
| [#20](https://github.com/yhay81/vastgrid/issues/20) | Reading Excel files | Ported: the DuckDB engine reads workbooks and their sheets (§8.2 `open`). |
| [#21](https://github.com/yhay81/vastgrid/issues/21) | Exporting Excel files | Ported: `xlsx` in `export` (§8.2), [#38](https://github.com/yhay81/vastgrid/issues/38). |
| [#22](https://github.com/yhay81/vastgrid/issues/22) | The first rows of a large sort before it ends | Ported: progressive views (§9), [#35](https://github.com/yhay81/vastgrid/issues/35). |
| [#23](https://github.com/yhay81/vastgrid/issues/23) | Columns frozen at the right | Ported: `pin: "right"` (§5.1, §6.3). |
| [#24](https://github.com/yhay81/vastgrid/issues/24) | The totals row (v1 left out freezing data rows) | Ported: `total` (§5.1) and the totals row (React §6.8). |
| [#25](https://github.com/yhay81/vastgrid/issues/25) | Column groups and headers of several rows | Ported: `columnGroups` (React §6.12); clicking a group selects its columns, and dragging it moves them (React §6.13). |
| [#26](https://github.com/yhay81/vastgrid/issues/26) | Wrapped text (v1: rows of one height, `maxLines`) | Ported: `wrap` (§5.1) and `wrapLines` (React §6.10). |
| [#27](https://github.com/yhay81/vastgrid/issues/27) | Grouping rows, subtotals and totals | Ported: `aggregate` (§4.1), the Group menu and the totals row (React §6.8). |
| [#28](https://github.com/yhay81/vastgrid/issues/28) | Pivot tables | Ported: `pivot` (§4.6) in the Group menu. |
| [#29](https://github.com/yhay81/vastgrid/issues/29) | Charts of grouped results (v1: an example with a chart library) | In another issue: the example belongs with the entry points of [#44](https://github.com/yhay81/vastgrid/issues/44). Grouped views are read with `useGridRows` or `rows` like any view. Charts in the grid itself stay out, as in v1. |
| [#30](https://github.com/yhay81/vastgrid/issues/30) | A tree of rows | Not in v2, as in v1: data whose hierarchy is in columns is shown by grouping by several keys. |
| [#31](https://github.com/yhay81/vastgrid/issues/31) | The detail panel | Ported: `detail` (§5.2), the Details button, Alt+Enter and `detailPanel` (React §6.11). |
| [#32](https://github.com/yhay81/vastgrid/issues/32) | Change notifications and live updates | Ported: `changes` and events (§7.6, §8.5), [#37](https://github.com/yhay81/vastgrid/issues/37). |

## Not in these issues

v1 features that no issue above names:

- Find (⌘F) with a find bar: ported (React §6.13).
- The cell menu, filtering to a cell's value or excluding it, and showing a value in full: ported (React §6.13).
- Moving columns by dragging their headers: ported (React §6.13). Resizing several columns at once is not in v2's
  grid: each column is resized, or fitted to its values from its menu.
