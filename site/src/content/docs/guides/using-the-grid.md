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
| ⌘/Ctrl + C · ⌘/Ctrl + Shift + C | Copy · copy with headers |
| ⌘/Ctrl + F | Find |
| Alt + ↓ | Column menu (sort, filter, statistics, freeze, hide) |
| F2 · double click | Show the full value of the cell |
| Shift + F10 · context menu key · right click | Cell menu (copy, filter to value, sort) |
| Escape | Close a menu or panel |

## Copying

⌘/Ctrl + C copies the selection as tab-separated text and as an HTML table, so pasting into a
spreadsheet or a document keeps the cells. ⌘/Ctrl + Shift + C adds the column names, and the cell menu
also copies as a Markdown table. Copies hold whole values, also of cells that are cut short on screen.
At most `copyLimit` cells (1,000,000 by default) are copied at once.

## Sorting

The column menu, opened with the ▾ that a header shows under the pointer or with Alt + ↓, sorts
ascending or descending. "Then sort ascending" and "Then sort descending" add the column as a further
key, for a sort by several columns; the headers then number the keys. Blank cells go last in both
directions, as in spreadsheets.

## Filtering and searching

- **By value.** "Filter…" in the column menu lists the column's values with their counts, most common
  first, with a box to search them. Uncheck values to leave them out.
- **By condition.** The same panel filters numbers by comparison or range, text by "Contains",
  "Begins with", "Ends with" and others (optionally matching case), and any column by "Is blank" or "Is
  not blank".
- **From a cell.** The cell menu filters to the cell's value, or excludes it.
- **Search.** The box in the toolbar keeps the rows where any column contains the text, ignoring case.

Filters on several columns all apply. The toolbar shows each one, with a button to remove it, and the
number of rows left.

## Finding

⌘/Ctrl + F opens the find bar. Enter goes to the next cell that contains the text, Shift + Enter to the
previous one, from the active cell along its row and then on to the next rows. Find moves the active cell
without changing which rows are shown; use the search box for that.

## Column statistics

"Column statistics" in the column menu shows the number of rows, blanks and distinct values, the
minimum and maximum and, for numbers, the mean, standard deviation, quartiles and a histogram, or for
text the shortest and longest length. It also lists the most common values.

## Columns

- Drag the edge of a header to resize a column; double-click it, or use "Fit width to content", to fit
  the column to its values.
- Drag the header of a selected column to move it.
- "Freeze up to this column" keeps the columns up to it at the left while you scroll sideways.
- "Hide column" hides it; the "Columns" button in the toolbar lists every column to show or hide.
- F2 or a double click shows the cell's whole value, with line breaks, in the cell inspector.
