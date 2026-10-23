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
| `CopyRangesError` | Thrown by copies of several ranges that have neither the same rows nor the same columns. |
