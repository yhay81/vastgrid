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
| `copyLimit` | `number` | `1000000` | Cells that can be copied at once. |
| `columnFormats` | `Record<string, ColumnFormat>` | | Display settings by schema column name: label, number and date formats, alignment, a format function. |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | Copy the values with the schema names, or the shown text with the labels. |
| `onQueryChange` | `(query: ViewQuery) => void` | | Called when the sort, filters or search change. |
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
| `goToRow(row)` | Scrolls to a row of the current view and makes it active. |
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

## Exports

`vastgrid` re-exports everything in `vastgrid-core` (`ArraySource`, `RemoteSource`, the types and the
helpers), so most apps install only `vastgrid`. It also exports:

| Export | Description |
| --- | --- |
| `DataGrid`, `DataGridProps`, `DataGridHandle` | The component, its props and its ref. |
| `en`, `ja`, `Messages`, `messagesFor(locale)` | The built-in texts and the set the grid picks for a locale. |
| `GridController`, `CanvasRenderer` | The grid's state and its canvas renderer, reached through the ref. |
| `GridOptions`, `ColumnState`, `Hit`, `HitZone` | Types of the controller's options, column state and hit tests. |
| `resolveTheme(element)`, `GridTheme` | The colors and fonts the canvas reads from the CSS variables of an element. |
| `CopyTooLargeError` | Thrown by copies of more than `copyLimit` cells. |
