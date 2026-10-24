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
| `maxLines` | `number` | `3` | Lines shown at most in cells of columns that wrap (`wrap` in `columnFormats`), 1 to 20. |
| `headerHeight` | `number` | `--vg-header-height` or 32 | Height of the row of column names in pixels. Rows of `columnGroups` add to the header. |
| `columnGroups` | `ColumnGroup[]` | | Groups of columns named in header rows above the column names (see [Column groups](#column-groups)). |
| `groupHeaderHeight` | `number` | `--vg-group-header-height` or 24 | Height of each header row of groups in pixels. |
| `nullText` | `string` | `""` | Text shown for null cells. |
| `frozenColumns` | `number` | `0` | Columns frozen at the left when the table opens. |
| `toolbar` | `boolean` | `true` | Shows the search box, active filters and row count. |
| `statusBar` | `boolean` | `true` | Shows the active cell and the selection summary. |
| `reloadKey` | `unknown` | | Changing it reads the table again, for example when the file changed on disk. Sources that report their changes (`subscribe`) are read again by themselves. Either way the query, the column settings, the scroll position and the active cell stay. |
| `followTail` | `boolean` | `false` | After the table changed, show its end when the last row was shown before (for appended rows, as `tail -f`). |
| `copyLimit` | `number` | `1000000` | Cells that can be copied at once, over all selected ranges. |
| `columnFormats` | `Record<string, ColumnFormat>` | | Display settings by schema column name: label, number and date formats, alignment, a format function, wrapping. |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | Copy the values with the schema names, or the shown text with the labels. |
| `exportOptions` | `GridExportOptions \| false` | `{}` | The export panel: where files go and which formats to offer. `false` hides it. See [Exporting](/guides/export/). |
| `drawCell` | `(args: DrawCellArgs) => void` | | Draws the visible loaded cells instead of the grid. See [Cell colors and custom drawing](#cell-colors-and-custom-drawing). |
| `cellAction` | `(cell: GridCellContent) => CellAction \| null` | | Makes cells links or buttons (pointer, underline, screen reader role; click and Space call `onCellClick`). |
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
| `detailOpen` | `boolean` | | Shows the [detail panel](#detail-panel) (controlled). Without it, the grid keeps the state. |
| `defaultDetailOpen` | `boolean` | `false` | Whether the detail panel is open when the grid mounts, when `detailOpen` is not set. |
| `onDetailOpenChange` | `(open: boolean) => void` | | Called when the detail panel is opened or closed by the user or the handle. |
| `detailPanel` | `ComponentType<DetailPanelProps>` | `DetailFields` | Replaces the content of the detail panel. |
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
| `openExport()` | Opens the export panel, also without the toolbar. Returns `false` when the source cannot export now. |
| `openDetail({ focus })` | Opens the detail panel; with `focus: true`, moves the focus into it. |
| `closeDetail()` | Closes the detail panel. |
| `detailOpen` | Whether the detail panel is open. |
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
| `format(value, { column, text })` | Returns the text of a value. `text` is what the other settings make. The result is shown in one line, or wrapped with `wrap`. |
| `copy` | `raw` or `formatted`: overrides `copyValues` for the column's cells. |
| `wrap` | `true` wraps the text onto up to `maxLines` lines (see below). |
| `style(value, { column, text })` | Returns the cell's `color`, `background` and `description` by value, or `null`. See [Cell colors and custom drawing](#cell-colors-and-custom-drawing). |

Patterns use `yyyy` `yy` (year), `M` `MM` `MMM` `MMMM` (month), `d` `dd` (day), `EEE` `EEEE` (weekday),
`H` `HH` (0–23), `h` `hh` with `a` (1–12 and AM/PM), `m` `mm`, `s` `ss`, and `S`, `SS`, `SSS`… (fraction
digits). Text in single quotes is kept: `yyyy-MM-dd 'at' HH:mm`. Month and weekday names follow
`locale`.

**Wrapping.** `wrap: true` shows a column's text on several lines, up to `maxLines` (3 by default):
lines break at spaces and between Japanese, Chinese and Korean characters (not before closing
punctuation such as `。` or `」`, nor after opening brackets), words longer than the column are cut, and
line breaks in the value start new lines. Text that needs more lines ends with "…"; the cell inspector
shows it all. All rows keep one height, so that scrolling and jumping to a row stay exact for hundreds
of millions of rows: while a visible column wraps, every row is `rowHeight` plus `--vg-line-height` (1.4
times the font size) for each further line, and when this height changes the first visible row stays
in place. Only the visible cells are wrapped. `wrap` and `maxLines` are settings of the app, like the
other formats, and are not part of `GridState`.

```tsx
<DataGrid source={source} columnFormats={{ comment: { wrap: true } }} maxLines={4} />
```

**Values and shown text.** The settings change only what is shown. Sorting, filters (also the values
typed into a condition), search, finding, column statistics, the selection summary and exports work on
the values: a percent column filtered with "> 0.5" keeps the values above 50%. 64-bit integers and
decimals that arrive as strings are formatted from their digits, never through a JavaScript number, so
`"9007199254740993"` stays exact. The cell inspector shows the value and, below it, the shown text.

**Copying.** By default copies (TSV, HTML and Markdown) hold the values, as `plainText` writes them, with
the schema names as headers, so that a spreadsheet reads numbers and dates. `copyValues="formatted"`
copies the shown text in full (not cut, line breaks kept) with the labels; a column's `copy` setting
decides for its own cells. Exports (`exportView`) are written by the source and hold the values; the
export panel can write the labels as headers and, in Excel files, the number and date formats as Excel
number formats (see [Exporting](/guides/export/)).

Invalid settings, such as a currency style without `currency` or an unknown time zone, throw a
`RangeError` as soon as the grid receives them. `ColumnFormatter` (made by `ValueFormatter.column(schema,
format)`, and `controller.formatterOf(index)` in the grid) formats values with the settings outside the
grid, and keeps them in `settings`.

## Column groups

`columnGroups` names groups of columns in header rows above the column names. A `ColumnGroup` has a
`name` and `children`: schema column names (`ColumnSchema.name`) and nested groups. Each level of
nesting adds a header row of `groupHeaderHeight` pixels, so the whole header is `headerHeight` plus
that for each level (`controller.headerHeight`); rows, scrolling, `goToRow` and the row checkboxes
start below it.

```tsx
import { type ColumnGroup, DataGrid } from "vastgrid";

const groups: ColumnGroup[] = [
  { name: "Sales", children: [
    { name: "Q1", children: ["jan", "feb", "mar"] },
    { name: "Q2", children: ["apr", "may", "jun"] },
  ] },
  { name: "Notes", children: ["comment"] },
];

<DataGrid source={source} columnGroups={groups} />;
```

Keep the array stable (memoize it or define it outside components). Names the table does not have are
ignored, so one definition can serve similar files. A column listed twice, a group without `children`
or groups nested deeper than 8 levels throw a `RangeError` when the grid receives them.

**Groups follow their columns.** The groups are a display definition separate from the schema and from
the column settings. The header is computed from the visible columns in their current order:

- A group's header spans its visible columns that are side by side. Moving a column between them, or
  moving one of them away, splits the header; each part shows the group's name. Hiding a column leaves it
  out, and hiding all of a group's columns hides the group.
- Frozen columns split a group that continues into the scrolling columns, so each region shows its own
  part. In the scrolling part, the name stays at the left edge while the columns scroll under it.
- Resizing columns never splits a group; a narrow group cuts its name with "…".
- The header's height depends only on how deep the groups nest, not on which columns are shown, so it
  does not jump when columns are hidden.
- A column with fewer groups than the header has rows has its header reach up through the empty rows.
  Its name, sort and filter marks and menu stay in the row of column names.

**Pointer.** Clicking a group header selects its columns, as clicking column headers does: Shift extends
the selection over the group, ⌘/Ctrl (Ctrl on Windows and Linux) adds it as another range. Dragging the
header of a group whose columns are selected moves them together, keeping their order
(`controller.moveColumns(first, last, to)`); dropping it on one of its own columns does nothing. Moves
are reported with the reason `move`, as for one column. Group headers have no menu and no resize
handle: the column headers below them have.

**Sorting, filters and events.** Group headers are only drawn: sorting, filters, the column menu,
statistics, find and selection work on the columns under them. `controller.hitTest(x, y)` reports
`zone: "group"` with the group's span (`hit.group`: `group`, `level`, and its first and last visible
columns `start` and `end`) and `col`, the column under the pointer. Events give `col` and `column` for
the columns, as without groups; `controller.groupSpans()` and `controller.groupsOf(col)` give the spans.

**Keyboard and screen readers.** The keyboard moves between cells as before; group headers are not
focused. For the active cell, the hidden ARIA rows describe each group above its column as a
`columnheader` with `aria-colspan` (its visible columns) in its own header row, then the row of column
names, so that screen readers can announce the groups with the column. `aria-rowcount` counts the
group rows.

**Copies and exports.** Copies with headers (TSV, HTML, Markdown) and exports (CSV, TSV, JSON, Parquet,
Excel) keep one header row with the column names or labels: the files stay tables that other programs,
and the grid itself, read back with the right column names. Groups are not written as merged cells.

**Saved settings.** Groups are not part of `GridState`: they are the app's definition, given by a prop
like `columnFormats`, while the state keeps what the user changes. The state keeps the columns' order,
visibility and freezing by name, so applying it shows the same group headers, split where they were.

## Detail panel

The detail panel shows the whole record of the active row at a fixed place: beside the grid, or below
it when the grid is narrower than 640px. Rows keep their height, so scrolling, `goToRow` and frozen
columns work as without it. Open it with `detailOpen` (controlled, with `onDetailOpenChange`),
`defaultDetailOpen`, the handle (`openDetail({ focus })`, `closeDetail()`), Alt+Enter or "Show row details"
in the cell menu.

The built-in content (`DetailFields`) lists every column in display order, hidden ones marked, with
its label from `columnFormats` and its formatted value. Values that the table cut are read in full.

**Which row it shows.** The panel follows the active cell, the `active` of `onSelectionChange`:

- Moving to another row shows that row. Moving within the row, or moving, hiding, freezing or
  formatting columns, keeps the record.
- Values come from the loaded rows. Columns that are not loaded and text that the source cut (ending in
  "…") are read in full for that row alone, after 120 ms; moving on before or during the read cancels it,
  so going quickly through rows reads only the row where you stop.
- A new view (sort, filters, search) makes its first row active, and the panel shows it, with its row in
  the original table in the title.
- Reading the table again keeps the record when the table did not change. A changed table keeps the
  active row, like `reloadKey` and the source's change reports, and the panel reads its record anew.
- Without rows, the panel says so.

**Keyboard and focus.** In the grid, Alt+Enter opens the panel and leaves the focus in the grid, so the
arrows keep moving through rows; Alt+Enter again moves the focus into the panel. In the panel, Esc
closes it and Alt+Enter goes back to the grid, both returning the focus to the grid. Esc in the grid also
closes the panel when it has nothing else to close. The panel is a complementary landmark (`<aside>`)
named by its title, and it is `aria-busy` while values are read.

**Errors.** When the row cannot be read, the panel shows the error with a Retry button
(`retry()` in custom content) and keeps the values it had.

**Custom content.** `detailPanel` takes a component that receives `DetailPanelProps`:

| Prop | Type | Description |
| --- | --- | --- |
| `row` | `number` | The row in the current view. |
| `rowId` | `number \| null` | The row in the original table, or `null` while the row of a view is not loaded. |
| `values` | `(CellValue \| undefined)[]` | Values by schema column index, read in full; `undefined` while being read. |
| `schema` | `ColumnSchema[]` | The table's columns. |
| `status` | `"loading" \| "ready" \| "error"` | Whether the values are being read, read, or failed. |
| `error` | `string \| null` | Why reading failed. |
| `fields` | `DetailField[]` | Every column in display order: `column`, `name`, `label`, `hidden`, `value` and the shown `text`. |
| `retry()` | | Reads the row again. |
| `messages` | `Messages` | The grid's texts. |

```tsx
import { DataGrid, type DetailPanelProps } from "vastgrid";

function Order({ fields, status, rowId }: DetailPanelProps) {
  return (
    <article aria-busy={status === "loading"}>
      <h3>Order {rowId === null ? "" : rowId + 1}</h3>
      {fields
        .filter((field) => !field.hidden)
        .map((field) => (
          <p key={field.column}>
            <strong>{field.label}</strong> {field.text}
          </p>
        ))}
    </article>
  );
}

<DataGrid source={source} defaultDetailOpen detailPanel={Order} />;
```

`--vg-detail-width` (340px) and `--vg-detail-height` (45%) set the panel's size. `DetailTracker` follows
the active row of a `GridController` and reads its record outside React, for apps that show it
elsewhere.

## Cell colors and custom drawing

Three settings change how cells look and what they do. They run only for the loaded cells in the
visible rows and columns: never for the rest of the table, and cells whose rows are loading keep their
placeholder. Keep the functions stable (outside the component, or memoized), since a new function draws
the grid again.

```tsx
import { type CellActionHook, type ColumnFormat, DataGrid, type DrawCell } from "vastgrid";

const formats: Record<string, ColumnFormat> = {
  // Red on pink below zero, the standard drawing otherwise.
  balance: {
    style: (value) =>
      Number(value) < 0 ? { color: "#b42318", background: "#fdecea", description: "Overdrawn" } : null,
  },
};

// A pill for a boolean column, the standard cell elsewhere.
const drawCell: DrawCell = (args) => {
  if (args.schema.name !== "active") return args.drawDefault();
  const { ctx, rect, theme } = args;
  ctx.fillStyle = args.value === true ? "#1a7f37" : theme.placeholder;
  ctx.beginPath();
  ctx.roundRect(rect.x + args.padding, rect.y + (rect.height - 16) / 2, 36, 16, 8);
  ctx.fill();
};

const cellAction: CellActionHook = (cell) =>
  cell.schema.name === "url" && cell.value !== null ? { kind: "link", label: `Open ${cell.text}` } : null;

<DataGrid
  source={source}
  columnFormats={formats}
  drawCell={drawCell}
  cellAction={cellAction}
  onCellClick={(event) => {
    if (event.column === urlColumn && typeof event.value === "string") window.open(event.value, "_blank");
  }}
/>;
```

**Colors by value.** A column's `style(value, { column, text })` returns a `CellStyle` (`color`,
`background`, `description`) or `null` for the defaults. The cell keeps its text, alignment and font;
the background lies under the find highlight and the selection. The result is kept with the loaded rows
like the text, so the function runs once per loaded cell, not on every frame. `description` is read by
screen readers after the value of the active cell, since colors are not announced.

**Drawing.** `drawCell(args)` replaces the drawing of each visible loaded cell. `args` has the cell's
coordinates (`row`, `rowId`, `col`, `column`), `value`, `type`, `schema`, the shown `text`, `rect` (in CSS
pixels), the column's `style` and `align`, its `action`, `selected`, `active`, `hovered`, `matched` (find),
the `theme`, `padding`, and:

- `ctx`: the canvas context with the cell font, `textBaseline = "middle"` and the column's `textAlign`. It
  is clipped to the column, not to the cell, so draw inside `rect` or clip yourself. Its state is restored
  after the hook.
- `drawDefault(options?)`: the standard cell (background, find highlight, text in the style's or the link
  color, link underline). `options` replaces its `text`, `color`, `background`, `align` or `underline`.
- `fitText(text, width)`: the text shortened with "…" to fit, in the cell font.

The grid draws the lines and the selection over the cell afterwards. While `drawCell` is set, moving the
pointer to another row draws again, so that `hovered` follows it.

**Links and buttons.** `cellAction(cell)` returns `{ kind: "link" | "button", label?, cursor? }` for cells
that do something, or `null`. The contract follows the [events](#events):

| | Behavior |
| --- | --- |
| Pointer | Over the cell the pointer is `cursor` (`pointer` by default). A click selects the cell and then calls `onCellClick` with `trigger: "pointer"`; dragging selects without clicking. |
| Keyboard | Space on the active cell calls `onCellClick` with `trigger: "keyboard"`, F2 `onCellDoubleClick`. Enter, Tab and the arrows keep moving the active cell, so a column of links can still be walked through. |
| Screen readers | The active cell's content gets the role `link` or `button`, `label` as its name when given, and `aria-keyshortcuts="Space"` when `onCellClick` is set. |
| Drawing | Links are drawn in `--vg-link-fg` and underlined unless a style or `drawCell` says otherwise. |

The grid does not open anything itself: `onCellClick` decides, for example with `window.open`.
`controller.cellContent(row, col)`, `cellActionAt` and `cellStyleAt` give the same information outside
the hooks.

**Cost.** On a 2520 × 1731 px viewport showing 1,349 cells, a frame took 2.7–2.8 ms before these hooks
existed and 2.8 ms without them, 2.5 ms with a `style` on every column, 2.8 ms with `cellAction` on half
the columns, and 2.8 ms with a `drawCell` that calls `drawDefault()` and adds a mark (median of four
runs of 180 frames, Chromium, Apple M2 Pro). Hooks that measure or allocate much per cell cost more:
check with `renderer.timings()`.

## Checked rows

`checkboxSelection` adds a checkbox to the left of each row header, and one in the corner for every row.
Checking rows is separate from the cell selection: the cell selection is a set of view positions, while
checked rows are kept by **key**, so the same records stay checked when the view is sorted or filtered.

| Key | Valid for | When the table is read again |
| --- | --- | --- |
| The row's position in the file (`rowId`, the default) | One `TableInfo.revision` | The same revision keeps the checked rows. A new revision unchecks every row (reason `"revision"`), because positions may name other records. |
| The value of the `rowKey` column (a primary key) | As long as the column has the value | Keys stay. Keys of rows that are gone stay in the selection until the app or the user removes them. If the column is gone, every row is unchecked (reason `"schema"`). |

A source whose data can change must report a new `revision` when it does; sources without one are taken
to be unchanged. Appending rows to a [file that changes](/guides/server/#files) also gives it a new
revision, so for tables that grow (`followTail`), set `rowKey` to keep rows checked. Reading the table
again keeps the scroll position and the active cell either way. Changing `rowKey` unchecks every row
(reason `"key"`).

Checked rows are shaded over their cells, also over conditional formats and `drawCell`, and the
checkbox stays centered when wrapping columns make rows taller.

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
`controller.onRowSelectionChange`; checking rows does not move the active cell, so the cell selection
events and the detail panel are not affected. Default keys are the `rowId` of the events and of
`GridCellContent` in `drawCell` and `cellAction`. Space checks the active row (after `onCellClick`, whose
`preventDefault()` stops it; on a link or button cell from `cellAction`, Space only clicks it), ⌘/Ctrl + Shift + Space checks or unchecks every row, and Shift + click on
a checkbox checks the rows from the last clicked one when their keys are loaded. Screen readers hear the
active row's checkbox and its state, and the change after a key press.

## Exports

`vastgrid` re-exports everything in `vastgrid-core` (`ArraySource`, `RemoteSource`, the types and the
helpers), so most apps install only `vastgrid`. It also exports:

| Export | Description |
| --- | --- |
| `DataGrid`, `DataGridProps`, `DataGridHandle` | The component, its props and its ref. |
| `DetailPanelProps`, `DetailField`, `DetailFields`, `DetailTracker`, `DetailRecord`, `DetailStatus`, `detailKeyAction` | The [detail panel](#detail-panel): props of custom content, the built-in content, and the record outside React. |
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
| `GridExportOptions`, `ExportChoice`, `ExportContext` | The [export panel](/guides/export/)'s options and what it passes to them. |
| `runExport(controller, choice, options, signal)`, `exportRequest(controller, choice)`, `exportSupport(info, exportView)` | Run an export as the panel does, or build its request, for an export UI of your own. |
| `ExportInterruptedError` | Thrown by `runExport` when the table changed during the export. |
| `downloadBlob(data, fileName)` | Saves a `Blob` as a browser download. |
