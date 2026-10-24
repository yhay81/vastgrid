---
title: DataGrid
description: The props of DataGrid and the methods of its ref.
---

```tsx
import { DataGrid } from "vastgrid";
import "vastgrid/styles.css";
```

`DataGrid` fills its parent, which needs a height. Import `vastgrid/styles.css` once in your app.

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `source` | `TableSource` | (required) | The table to show. A new source starts a new grid. |
| `locale` | `string` | the browser's language | Locale for numbers and the built-in texts: Japanese for `ja`, English otherwise. |
| `messages` | `Partial<Messages>` | | Replaces some of the built-in texts (see `en` and `ja`). |
| `rowHeight` | `number` | `--vg-row-height` or 24 | Row height in pixels. |
| `headerHeight` | `number` | `--vg-header-height` or 32 | Header height in pixels. |
| `nullText` | `string` | `""` | Text shown for null cells. |
| `frozenColumns` | `number` | `0` | Columns frozen at the left when the table opens. |
| `toolbar` | `boolean` | `true` | Shows the search box, active filters and row count. |
| `statusBar` | `boolean` | `true` | Shows the active cell and the selection summary. |
| `reloadKey` | `unknown` | | Changing it reads the table again, for example when the file changed on disk. |
| `copyLimit` | `number` | `1000000` | Cells that can be copied at once, over all selected ranges. |
| `columnFormats` | `Record<string, ColumnFormat>` | | Display settings by schema column name: label, number and date formats, alignment, a format function. |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | Copy the values with the schema names, or the shown text with the labels. |
| `onQueryChange` | `(query: ViewQuery) => void` | | Called when the sort, filters or search change. |
| `onSelectionChange` | `(event: GridSelectionEvent) => void` | | Called when the selection or the active cell changes. See [Events](#events). |
| `onColumnsChange` | `(event: GridColumnsEvent) => void` | | Called when the columns' width, order, visibility or freezing change. |
| `onCellClick` | `(event: GridCellEvent) => void` | | Called when a cell is clicked, or Space is pressed on the active cell. |
| `onCellDoubleClick` | `(event: GridCellEvent) => void` | | Called when a cell is double-clicked, or F2 is pressed. `event.preventDefault()` keeps the cell inspector closed. |
| `initialState` | `GridState` | | Settings applied when a grid starts, once the table's columns are known. See [Saving the settings](#saving-the-settings). |
| `onStateChange` | `(state: GridState) => void` | | Called with the settings when the query or the column settings change. |
| `checkboxSelection` | `boolean` | `false` | Shows a checkbox for each row, and one for every row in the corner. See [Checked rows](#checked-rows). |
| `rowKey` | `string` | the row's position | Schema column whose values identify the rows (a primary key). Checked rows then survive new data. |
| `rowSelection` | `RowSelection` | | Checked rows to apply on start and whenever a different value is passed. |
| `onRowSelectionChange` | `(event: GridRowSelectionEvent) => void` | | Called when rows are checked or unchecked, by the user, the app or the grid. |
| `className`, `style` | | | Added to the root element (`.vg-root`). |
| `aria-label` | `string` | `messages.gridLabel` | The grid's name for screen readers. |

## Ref

A ref gives a `DataGridHandle`:

| Member | Description |
| --- | --- |
| `focus()` | Moves the keyboard focus to the grid. |
| `reload()` | Reads the table again, as a change of `reloadKey` does. |
| `getQuery()` | The current `ViewQuery`: sort, filters and search. |
| `setQuery(query)` | Applies a `ViewQuery`, replacing the current one. Before the table is ready, it applies once it is. |
| `getState()` | The query and the column settings, as a `GridState` to save. |
| `applyState(state)` | Applies a saved `GridState`. Returns `false` when the value is not a state this version reads. |
| `goToRow(row)` | Scrolls to a row of the current view and makes it active. |
| `getRowSelection()` | The checked rows, as a `RowSelection`. |
| `setRowSelection(selection)` | Replaces the checked rows. Returns `false` when the value is not a `RowSelection`. |
| `controller` | The `GridController` with the grid's state: the selection, the layout of the columns, the view. |
| `renderer` | The `CanvasRenderer`, for diagnostics such as `renderer.timings()`. `null` before the grid mounts. |

```tsx
import { DataGrid, type DataGridHandle } from "vastgrid";
import { useRef } from "react";

const grid = useRef<DataGridHandle>(null);

<DataGrid ref={grid} source={source} onQueryChange={(query) => saveQuery(query)} />;

// Largest values of the third column first, only rows that contain "Tokyo".
grid.current?.setQuery({ sort: [{ column: 2, direction: "desc" }], search: "Tokyo" });
```

Columns in a query are indexes into the table's columns (`TableInfo.columns`), not display positions, so
a saved query still means the same after columns were moved or hidden. See
[`ViewQuery`](/reference/table-source/#viewquery) for the filters.

## Events

The event props report changes made by the user and by the app (`setQuery`, `applyState`), each change
once. Scrolling, hovering and drawing send none. They are also available without React, as
`controller.onSelectionChange`, `onColumnsChange` and `onStateChange`, which return a function that
unsubscribes.

A cell has three kinds of coordinates:

| Field | Meaning |
| --- | --- |
| `row` | Position in the current view (0-based), after sorting and filters: the row as shown. |
| `rowId` | Position in the original table (0-based). Equal to `row` without sort and filters. In a view it comes with the row, so it is `null` until the row is loaded; `onSelectionChange` is called again when it arrives. |
| `col` | Position among the visible columns, in display order. Changes when columns are moved or hidden. |
| `column` | Index of the column in the table (`TableInfo.columns`), as in `ViewQuery`. Moving or hiding columns does not change it. |

- `GridSelectionEvent`: `active`, the active cell (`row`, `rowId`, `col`, `column`), and `ranges`, each
  with `top`, `bottom`, `left`, `right` (inclusive, in view rows and visible columns), `columns` (their
  table indexes) and `allRows` / `allCols` for whole columns and whole rows. It is also sent when the
  table's columns first arrive (the active cell gets a column), when a new view moves the active cell
  to its first row, and when moving or hiding columns puts another column under the active cell.
- `GridColumnsEvent`: `reason` (`"resize"`, `"move"`, `"visibility"`, `"freeze"`, `"state"` when a state
  was applied, `"schema"` when the table was read again with other columns), `columns` (every column in
  display order with `column`, `name`, `col` (-1 when hidden), `width`, `hidden`, `sized`, `frozen`) and
  `frozenColumns`. Dragging a column's edge reports the width once, when the drag ends. Widths that the
  grid fits by itself are not reported.
- `GridCellEvent`: the cell's coordinates, its loaded `value` (`undefined` while it is not loaded),
  `trigger` (`"pointer"` or `"keyboard"`), the modifier keys and `preventDefault()`. A click is a press and
  release on the same cell; a double click is preceded by two clicks, as in the DOM. Space on the
  active cell counts as a click only when `onCellClick` is set (otherwise the key is left to the
  browser), and F2 counts as a double click. With `checkboxSelection`, Space also checks the active
  row unless the handler calls `preventDefault()`.
- `GridRowSelectionEvent`: see [Checked rows](#checked-rows).

```tsx
<DataGrid
  source={source}
  onSelectionChange={({ active }) => setDetail(active.rowId)}
  onCellDoubleClick={(event) => {
    event.preventDefault(); // instead of the cell inspector
    openRecord(event.rowId);
  }}
/>
```

## Saving the settings

`getState()` returns the grid's settings as JSON: the query, and the columns' order, widths set by the
user, visibility and freezing. The selection and the scroll position are not part of it (use
`onSelectionChange` and `goToRow` to keep those). The app decides where to keep it:

```tsx
function read(text: string | null) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

// In localStorage, per file:
<DataGrid
  source={source}
  initialState={read(localStorage.getItem(`grid:${file}`))}
  onStateChange={(state) => localStorage.setItem(`grid:${file}`, JSON.stringify(state))}
/>;

// Or in the address, so that a link opens the same view:
<DataGrid
  source={source}
  initialState={read(new URLSearchParams(location.search).get("grid"))}
  onStateChange={(state) => {
    const url = new URL(location.href);
    url.searchParams.set("grid", JSON.stringify(state));
    history.replaceState(null, "", url);
  }}
/>;
```

```json
{
  "version": 1,
  "schema": ["id", "name", "price"],
  "query": { "sort": [{ "column": 2, "direction": "desc" }] },
  "columns": [{ "name": "name", "width": 220 }, { "name": "id", "hidden": true }, { "name": "price" }],
  "frozenColumns": 1
}
```

- Columns are kept by name. `schema` lists the names when the state was saved, and the query's column
  indexes refer to it, so they are mapped onto the table's columns by name. Of repeated names, the nth
  matches the nth.
- Columns of the table that the state does not list (added to the file later) keep their settings and
  follow the listed ones. Listed columns, sort keys and filters whose column the table no longer has are
  dropped, and frozen columns that are gone are not replaced by others. At least one column stays visible.
- A width is saved only for columns the user sized; the others are fitted again to their values.
- Every part except `version` is optional: applying a state changes only the parts it has. A
  `ViewQuery` saved from `onQueryChange` or `getQuery()` is read as a state with that query.
- `applyState` (and `initialState`) can be used before the table has loaded: the state waits until the
  columns are known, and the query until the table is ready. A query set with `setQuery` meanwhile wins
  over the state's.
- Values from storage are checked: invalid parts are left out, and a state of a newer `version` than this
  package reads is refused (`applyState` returns `false`). `parseGridState(value)` from `vastgrid-core`
  does the check on its own. Later versions add settings as new optional parts and change `version`
  only when a part changes its meaning, converting older states.

`onStateChange` is also called when a state is applied, including `initialState`.

`renderer.timings()` returns `{ frames, average, slowest }` in milliseconds over the last 120 frames
drawn. The [demo](/demo/) shows it in its toolbar.

## Column formats

`columnFormats` sets how columns look, by their schema names (`ColumnSchema.name`). Columns without an
entry look as before.

```tsx
import { type ColumnFormat, DataGrid } from "vastgrid";

// Outside the component, or memoized: a new object is compared again, and a new function redraws.
const formats: Record<string, ColumnFormat> = {
  price: { label: "Price", number: { style: "currency", currency: "USD" } },
  cost: { label: "Cost", number: { style: "currency", currency: "USD", fractionDigits: 0 } },
  share: { number: { style: "percent", fractionDigits: 1 } },
  weight: { number: { maximumFractionDigits: 2, suffix: " kg" } },
  ordered_at: { label: "Ordered", date: { pattern: "yyyy/MM/dd HH:mm" } },
  shipped_at: { date: { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" } },
  status: { align: "center", format: (value, { text }) => (value === "ok" ? "✓" : text) },
};

<DataGrid source={source} columnFormats={formats} />;
```

| Setting | Description |
| --- | --- |
| `label` | Shown in the header, the menus, the panels and the status bar instead of the schema name. |
| `number` | For numbers and numeric strings: `style` (`decimal`, `percent`, `currency` with `currency`), `currencyDisplay`, `fractionDigits` (or `minimumFractionDigits` and `maximumFractionDigits`), `grouping`, `notation`, `signDisplay`, `prefix` and `suffix`. Text that is not a number keeps its text. |
| `date` | For dates and times: a `pattern`, or `Intl.DateTimeFormat` options (`dateStyle`, `timeStyle`, `year`, `month`, `day`, `hour`, …). `timeZone` is where values with an offset (`timestamptz`) are shown; values without one are shown as they are. Text that is not a date keeps its text. |
| `align` | `left`, `center` or `right`. Defaults to `right` for numbers. |
| `format(value, { column, text })` | Returns the text of a value. `text` is what the other settings make. The result is shown in one line. |
| `copy` | `raw` or `formatted`: overrides `copyValues` for the column's cells. |

Patterns use `yyyy` `yy` (year), `M` `MM` `MMM` `MMMM` (month), `d` `dd` (day), `EEE` `EEEE` (weekday),
`H` `HH` (0–23), `h` `hh` with `a` (1–12 and AM/PM), `m` `mm`, `s` `ss`, and `S`, `SS`, `SSS`… (fraction
digits). Text in single quotes is kept: `yyyy-MM-dd 'at' HH:mm`. Month and weekday names follow
`locale`.

**Values and shown text.** The settings change only what is shown. Sorting, filters (also the values
typed into a condition), search, finding, column statistics, the selection summary and exports work on
the values: a percent column filtered with "> 0.5" keeps the values above 50%. 64-bit integers and
decimals that arrive as strings are formatted from their digits, never through a JavaScript number, so
`"9007199254740993"` stays exact. The cell inspector shows the value and, below it, the shown text.

**Copying.** By default copies (TSV, HTML and Markdown) hold the values, as `plainText` writes them, with
the schema names as headers, so that a spreadsheet reads numbers and dates. `copyValues="formatted"`
copies the shown text in full (not cut, line breaks kept) with the labels; a column's `copy` setting
decides for its own cells. Exports (`exportView`) are written by the source and always hold the values
and the schema names.

Invalid settings, such as a currency style without `currency` or an unknown time zone, throw a
`RangeError` as soon as the grid receives them. `ColumnFormatter` (made by `ValueFormatter.column(schema,
format)`, and `controller.formatterOf(index)` in the grid) formats values with the settings outside the
grid, and keeps them in `settings`.

## Checked rows

`checkboxSelection` adds a checkbox to the left of each row header, and one in the corner for every row.
Checking rows is separate from the cell selection: the cell selection is a set of view positions, while
checked rows are kept by **key**, so the same records stay checked when the view is sorted or filtered.

| Key | Valid for | When the table is read again |
| --- | --- | --- |
| The row's position in the file (`rowId`, the default) | One `TableInfo.revision` | The same revision keeps the checked rows. A new revision unchecks every row (reason `"revision"`), because positions may name other records. |
| The value of the `rowKey` column (a primary key) | As long as the column has the value | Keys stay. Keys of rows that are gone stay in the selection until the app or the user removes them. If the column is gone, every row is unchecked (reason `"schema"`). |

A source whose data can change must report a new `revision` when it does; sources without one are taken
to be unchanged. Changing `rowKey` unchecks every row (reason `"key"`).

A selection is a `RowSelection`, which needs no list of keys for "every row":

```ts
type RowSelection =
  | { type: "include"; keys: RowKey[] } // these rows
  | { type: "exclude"; keys: RowKey[]; query?: { filters?: Filter[]; search?: string } }; // every row except these
type RowKey = string | number;
```

- The corner checkbox checks every row of the view: without filters or a search, `{ type: "exclude",
  keys: [] }`, every row of the table, also rows added in a new revision; with them,
  `query: { filters, search }`, every row matching them. Clicking it again when every row is checked
  unchecks them all. Unchecking a row then adds its key to `keys`.
- Rows hidden by a filter stay checked. An `include` selection shows in every view. An `exclude`
  selection with a `query` shows row by row in views that have all of its filters and a search that
  contains its search (more filters are fine). In other views the grid reads the keys of the matching
  rows, and if there are at most 100,000 it turns the selection into an `include` of those rows (reason
  `"query"`); larger selections stay as they are, and their rows show a faint checkbox that cannot be
  toggled until the view returns to the filter.
- `count` in the event (and the toolbar) is the number of checked rows, or `null` while the rows matching
  an `exclude` selection's filters are not counted.
- Checked rows are not part of `GridState`; save `getRowSelection()` yourself if you need to, and check
  values from storage with `parseRowSelection(value)` from `vastgrid-core` (`setRowSelection` does the
  same check and returns `false` for invalid values).

```tsx
const [checked, setChecked] = useState<RowSelection>({ type: "include", keys: [] });

<DataGrid
  source={source}
  checkboxSelection
  rowKey="order_id"
  rowSelection={checked}
  onRowSelectionChange={({ selection, count, reason }) => {
    setChecked(selection);
    setCount(count);
  }}
/>;
```

`GridRowSelectionEvent` has `reason` (`"user"`, `"api"` for `setRowSelection` and the `rowSelection`
prop, `"revision"`, `"schema"`, `"query"`, `"key"`), `selection` and `count`. The controller offers it as
`controller.onRowSelectionChange`. Space checks the active row (after `onCellClick`, whose
`preventDefault()` stops it), ⌘/Ctrl + Shift + Space checks or unchecks every row, and Shift + click on
a checkbox checks the rows from the last clicked one when their keys are loaded. Screen readers hear the
active row's checkbox and its state, and the change after a key press.

## Exports

`vastgrid` re-exports everything in `vastgrid-core` (`ArraySource`, `RemoteSource`, the types and the
helpers), so most apps install only `vastgrid`. It also exports:

| Export | Description |
| --- | --- |
| `DataGrid`, `DataGridProps`, `DataGridHandle` | The component, its props and its ref. |
| `GridCell`, `GridCellEvent`, `GridSelectionEvent`, `GridSelectionRange`, `GridColumnsEvent`, `GridColumn`, `GridColumnsChangeReason` | Types of the [events](#events). |
| `GridRowSelectionEvent`, `GridRowSelectionChangeReason` | The [checked rows](#checked-rows) event. |
| `RowSelection`, `RowKey`, `RowSelectionQuery`, `RowSelectionModel`, `parseRowSelection(value)` | [Checked rows](#checked-rows) by key, from `vastgrid-core`. |
| `GridState`, `GridColumnSetting`, `parseGridState(value)`, `resolveGridState(state, names)`, `GRID_STATE_VERSION` | The [saved settings](#saving-the-settings), from `vastgrid-core`. |
| `en`, `ja`, `Messages`, `messagesFor(locale)` | The built-in texts and the set the grid picks for a locale. |
| `GridController`, `CanvasRenderer` | The grid's state and its canvas renderer, reached through the ref. |
| `GridOptions`, `ColumnState`, `Hit`, `HitZone` | Types of the controller's options, column state and hit tests. |
| `resolveTheme(element)`, `GridTheme` | The colors and fonts the canvas reads from the CSS variables of an element. |
| `CopyTooLargeError` | Thrown by copies of more than `copyLimit` cells. |
| `CopyRangesError` | Thrown by copies of several ranges that have neither the same rows nor the same columns. |
