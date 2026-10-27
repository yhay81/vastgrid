---
title: Using the grid
description: Selecting, the keyboard, copying, sorting, filters and search, find, statistics, columns and the detail panel.
---

The grid works like a spreadsheet, with the pointer and the keyboard. Everything here can be tried in the
[demo](/demo/). Each action is a [command](/reference/commands/) on the grid's state, so what a person does with
the pointer, an app can do with `dispatch`.

What the toolbar and the menus offer depends on the engine. Each engine reports what it can do in its
capabilities (`plan.where`, `plan.aggregate`, `find`, `summarize`, `write`, `export`, …), and the grid shows only
what the engine does: see [Engines](/reference/engines/).

## Selecting

- Click a cell to make it active. Drag, or Shift + click, to select a range; dragging past an edge scrolls.
- ⌘/Ctrl + click adds another range. Copies cover every range.
- Click the gutter (the row numbers) to select whole rows, and drag along it for more. Click the corner, or press
  ⌘/Ctrl + A, to select everything.
- With `columnGroups`, clicking a group's header selects its columns. A click on a column's name sorts by it
  rather than selecting it (see [Sorting](#sorting)).

The status bar shows the active cell (`Row 12, price`). For one range of several cells it adds their count, sum
and average a moment later, computed by the engine (`capabilities.summarize`), so a range of a million rows
counts every row.

## Keyboard

⌘ is the modifier on Apple platforms, Ctrl on the others.

| Keys | Action |
| --- | --- |
| Arrows · Page Up/Down | Move the active cell by one cell · by a page |
| ⌘/Ctrl + arrows | Jump to the first or last row or column |
| Home/End · ⌘/Ctrl + Home/End | First or last column · first or last cell of the view |
| Shift + any of the above | Extend the selection |
| Tab · Enter (with Shift: backwards) | Move right · down; inside a selection of several cells, walk through it |
| ⌘/Ctrl + A | Select everything |
| ⌘/Ctrl + C | Copy |
| Typing · F2 · double click | Edit the cell (see [Editing cells](/guides/editing/)) |
| Delete · Backspace | Clear the selected cells |
| ⌘/Ctrl + Z · ⌘/Ctrl + Shift + Z (Ctrl + Y) | Undo · redo |
| ⌘/Ctrl + D · ⌘/Ctrl + R | Fill down · fill right |
| ⌘/Ctrl + S | Save into the file, when the engine saves |
| ⌘/Ctrl + F | Find, when the engine finds |
| Alt + ↓ | The active column's menu |
| Shift + F10 · context menu key · right click | The cell menu |
| Alt + Enter | Open or close the detail panel |
| Space | Check or uncheck the active row (with `checkboxes`), or follow a link or button cell |
| Esc | Close a menu, the find bar or the editor |

The keys that write do so only where cells are writable. Where the engine does not save or find, ⌘/Ctrl + S and
⌘/Ctrl + F are left to the browser.

## Copying

⌘/Ctrl + C copies the selected cells as tab-separated text and as an HTML table, so pasting into a spreadsheet or
a document keeps the cells. Copies hold whole values in their text form (`2024-01-31`, numbers with all their
digits), not the formatted text on screen, and no column names. Cells that are not read yet are read first. Up to
1,000,000 cells are copied at once.

Several ranges are placed as spreadsheets place them: ranges with the same rows side by side, ranges with the same
columns one below the other, in the grid's order and without the cells between them. Other combinations are not
copied, and the grid says so (`copy_layout`).

From code, `dispatch({ command: "copy", headers: true })` gives `{ tsv, html, markdown }` of the selection with
the column names.

## Sorting

- Click a column's name to sort by it: ascending, then descending, then not sorted. Shift + click adds the column
  as a further key.
- The column menu (the arrow at the right of a header, a right click on the header, or Alt + ↓) has Sort
  ascending, Sort descending, Then sort ascending, Then sort descending and Clear sort.
- Blank values (null and empty text) come last in both directions, and rows that are equal keep the table's order.
  Every engine sorts the same way ([§3.3](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#33-order)).

The engine sorts the whole table, not the rows on screen. The DuckDB engine shows the first 1,000 rows of a sort of
a million rows or more at once and sorts the rest meanwhile: the status bar says "Reading the view…" until the
view is complete, and rows further down come when they are ready.

## Filtering and searching

- **Search** (the toolbar's box) keeps the rows where any column of the table contains the text, ignoring letter
  case.
- **Filter…** in the column menu lists the column's values with how many rows have each, the most common first,
  with check boxes, "Search values", "(Select all)" and "(Blank)". Below it, a condition on typed text: Equals,
  Does not equal, Less than (or equal to), Greater than (or equal to), Between (From, To), Contains, Does not
  contain, Begins with, Ends with, Is blank, Is not blank. Text conditions ignore letter case, and values are read
  as the column's type. Engines that do not group rows offer the condition only. A header whose column has
  conditions shows a funnel instead of its arrow.
- **Filter to this value** and **Exclude this value** in the cell menu filter by the active cell's value.
- **Conditions** in the toolbar (with their number when there are some) shows every condition as a group that
  matches "All of these (AND)" or "Any of these (OR)", with Add condition, Add group (groups nest) and Clear all.
  Conditions that code wrote and the menu cannot take apart are shown as formulas and kept. Apply replaces the
  conditions and keeps the search.

All of these are the plan's `where`, kept in the document (see [State](/guides/state/)). Filter… is not offered on
a grouped view; the conditions on groups are its `having` (see [Grouping](/guides/grouping/)).

## Finding

⌘/Ctrl + F opens a find bar under the toolbar. Enter finds the next cell after the active cell whose text
contains what is typed, Shift + Enter the one before, in the displayed columns, wrapping around; the cell found
becomes active. Letter case is ignored unless "Match case" is on. Esc closes the bar. The engine looks through
the whole view, so cells far from the screen are found too.

## The cell menu

A right click on a cell, Shift + F10 or the context menu key opens it: Copy, Filter to this value, Exclude this
value (not on grouped views), Show full value (reads a text that the engine cut short, such as the DuckDB
engine's strings over 2,000 characters), and Details.

## Column statistics

Statistics… in the column menu shows, over the rows of the view: Rows, Values, Empty, Distinct, Minimum,
Maximum, Sum, Average, Median and Standard deviation, those that fit the column's type. The engine computes them,
so they are exact for a table of any size. It is offered when the engine groups rows and the view is not
grouped.

## Columns

- **Width**: drag a header's right edge (40 pixels at least). Double-click the edge, or choose "Fit width to
  content" in the column menu, to fit the column.
- **Order**: drag a column's name; a line shows where it goes. A selection of whole columns moves together, and
  dragging a group's header moves its columns. Columns take the side they are dropped on, frozen or not.
- **Freezing**: "Freeze at the left", "Freeze at the right" and "Unfreeze" in the column menu keep columns in view
  while the grid scrolls sideways.
- **Hiding**: "Hide column" in the column menu, and "Show all columns" to show them again.
- **Columns** in the toolbar lists the displayed columns in order, with a check box to hide each and buttons to
  move it left or right, then the hidden ones, a "Find a column" box, and "Show all".
- **Format…** in the column menu sets the label in the header, the alignment, wrapping, numbers (Number, Percent
  or Currency, with decimal places and digit grouping), the date pattern, and conditional colors (a condition, a
  text color, a background, and what the colors mean). "Clear format" removes it. Copies and the editor keep the
  values; exports use the label as the header and, in Excel files, the number format.

Each of these is a command (`column.resize`, `column.move`, `column.pin`, `column.hide`, `column.show`,
`column.format`), kept in the document.

"Total…" in the column menu adds a totals row, and "Group by this column" shows groups instead of rows: see
[Grouping and totals](/guides/grouping/). The toolbar's Formulas menu adds computed columns
([Formulas](/guides/formulas/)) and its Export menu writes files ([Exporting](/guides/export/)).

## Checked rows and the detail panel

- With `checkboxes`, the gutter has a check box for each row and the corner one for every row of the view. A box,
  or Space, checks the active row. Checks belong to the records (by key), so they stay when the view is sorted or
  filtered, and the status bar says how many rows are checked. A row whose state cannot be known under the
  current filter shows a dash and cannot be checked until the filter is as it was.
- **Details** in the toolbar, or Alt + Enter, opens a panel beside the grid (below it when the grid is narrower
  than 640 pixels) with every column of the active row, hidden ones included, with their labels and formats and
  their whole text. It follows the active cell. The `detailPanel` prop shows the row with a component of your
  own: see [DataGrid](/reference/data-grid/).
