---
title: Using the grid
description: Selection, keyboard shortcuts, copying, sorting, filters, search, find, statistics and columns.
---

The grid works like a spreadsheet, with the mouse and with Excel's keyboard shortcuts. Everything here
can be tried in the [demo](/demo/).

## Selecting

- Click a cell to make it active; drag, or Shift + click, to select a range.
- ⌘/Ctrl + click adds another range. The summary and copies cover every range.
- Click a column header to select the column, a row header to select the row, and the corner to select
  everything. Drag across headers to select several.
- With `checkboxSelection`, rows also have checkboxes, which stay with their records when the view is
  sorted or filtered (see [Checked rows](/reference/data-grid/#checked-rows)). Shift + click checks a
  range.

The status bar shows the active cell and, for a selection of several cells, the count of non-blank
cells and, for numbers, their sum, average, minimum and maximum. In a sorted or filtered view it also
shows the row's position in the file.

## Keyboard

| Keys | Action |
| --- | --- |
| Arrows · Page Up/Down · Home/End | Move the active cell |
| ⌘/Ctrl + arrows · ⌘/Ctrl + Home/End | Jump to the first or last row or column |
| Shift + any of the above · Shift + click | Extend the selection |
| ⌘/Ctrl + click | Add a range |
| Tab / Enter (with Shift: backwards) | Move within the selection |
| Shift + Space · Ctrl + Space · ⌘/Ctrl + A | Select the row · the column · everything |
| Space · ⌘/Ctrl + Shift + Space (with `checkboxSelection`) | Check the active row · every row |
| ⌘/Ctrl + C · ⌘/Ctrl + Shift + C | Copy · copy with headers |
| ⌘/Ctrl + F | Find |
| Alt + ↓ | Column menu (sort, filter, statistics, freeze, hide) |
| F2 · double click | Show the full value of the cell |
| Alt + Enter (again: into the panel) · Esc | Open the detail panel of the active row · close it |
| Shift + F10 · context menu key · right click | Cell menu (copy, filter to value, sort) |
| Escape | Close a menu or panel, or cancel a copy that is still reading |

## Copying

⌘/Ctrl + C copies the selection as tab-separated text and as an HTML table, so pasting into a
spreadsheet or a document keeps the cells. ⌘/Ctrl + Shift + C adds the column names, and the cell menu
also copies as a Markdown table. Copies hold whole values, also of cells that are cut short on screen.
At most `copyLimit` cells (1,000,000 by default) are copied at once, counted over all ranges. Copies hold the values, not the text
that [column formats](/reference/data-grid/#column-formats) show, unless `copyValues` is `"formatted"`.

Several ranges are copied together as Excel does. Ranges with the same rows are placed side by side, and
ranges with the same columns one below the other. Either way the cells keep the order of the grid (rows
of the view, columns as they are shown, without hidden columns), the gaps between the ranges are left
out, and cells where ranges overlap are copied once. Other ranges cannot be copied together, and the grid
says so instead of copying. Cells that are not loaded yet are read first; Escape cancels a copy that is
still reading.

## Sorting

The column menu, opened with the ▾ that a header shows under the pointer or with Alt + ↓, sorts
ascending or descending. "Then sort ascending" and "Then sort descending" add the column as a further
key, for a sort by several columns; the headers then number the keys. Blank cells go last in both
directions, as in spreadsheets.

When the source can show a sort before it is finished (the DuckDB server does for tables of 1M rows or
more), the first rows appear right away and the toolbar says "Sorting… showing the first 1,000 of …
rows". You can scroll and select everywhere; the rows further down show as loading until the sort is
done, and then appear without the first rows moving. Until then, copying past the first rows and find
tell you to wait, the selection summary shows "…", and the statistics of a filtered view are off.

## Filtering and searching

- **By value.** "Filter…" in the column menu lists the column's values with their counts, most common
  first, with a box to search them. Uncheck values to leave them out.
- **By condition.** The same panel filters numbers by comparison or range, text by "Contains",
  "Begins with", "Ends with" and others (optionally matching case), and any column by "Is blank" or "Is
  not blank".
- **From a cell.** The cell menu filters to the cell's value, or excludes it.
- **AND / OR conditions.** "Add condition (AND)…" or "Add condition (OR)…" in a column's filter panel
  opens the condition builder with that filter and a new condition, for example "region is Tokyo *or*
  sales over 100,000". "Conditions…" in the toolbar opens it with every filter. A group keeps the rows
  that match all of its conditions (AND) or any of them (OR); groups nest, and a column can have several
  conditions. Conditions without a value are left out when you apply.
- **Search.** The box in the toolbar keeps the rows where any column contains the text, ignoring case.

Filters on several columns all apply. The toolbar shows each one, and the AND / OR conditions, with a
button to remove it, and the number of rows left; click the conditions to change them. A column used in
the conditions shows the filter mark in its header. Statistics, selection summaries, copies and exports
work on the rows left. Sources that cannot evaluate conditions (`capabilities.conditions`) keep the
builder disabled.

## Finding

⌘/Ctrl + F opens the find bar. Enter goes to the next cell that contains the text, Shift + Enter to the
previous one, from the active cell along its row and then on to the next rows. Find moves the active cell
without changing which rows are shown; use the search box for that.

## Column statistics

"Column statistics" in the column menu shows the number of rows, blanks and distinct values, the
minimum and maximum and, for numbers, the mean, standard deviation, quartiles and a histogram, or for
text the shortest and longest length. It also lists the most common values.

## Exporting

"Export" in the toolbar writes the current view (as filtered and sorted) or the whole table, with the
shown or all columns, as CSV, TSV, Parquet, JSON or Excel, depending on the source. See
[Exporting](/guides/export/).

## Columns

- Drag the edge of a header to resize a column; double-click it, or use "Fit width to content", to fit
  the column to its values.
- Drag the header of a selected column to move it.
- "Freeze up to this column" keeps the columns up to it at the left while you scroll sideways.
- "Hide column" hides it; the "Columns" button in the toolbar lists every column to show or hide.
- F2 or a double click shows the cell's whole value, with line breaks, in the cell inspector.
- Alt + Enter, or "Show row details" in the cell menu, opens the detail panel beside the grid (below it
  when the grid is narrow). It shows every column of the active row in full and follows the active cell
  as you move. Alt + Enter again moves the focus into it, and Esc closes it.
