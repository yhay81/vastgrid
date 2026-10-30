---
title: Notebook
description: Show DataFrames and CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid in a Jupyter notebook, with DuckDB in the kernel, and get the edited table back.
---

The Python package `vastgrid` shows a table of any size in vastgrid's grid in a Jupyter notebook: a pandas or
Polars DataFrame, a PyArrow table, a DuckDB relation, or a CSV, TSV, Parquet, JSON, JSON Lines or Excel file.
DuckDB reads it in the kernel; the grid in the cell's output is an [anywidget](https://anywidget.dev) that shows
`DataGrid` and reads blocks of rows over the widget's messages, a row range at a time. The notebook gets the
edited table back as a DataFrame, or exports it.

## Running it

```sh
pip install vastgrid
```

It needs Python 3.11 or later, `anywidget` 0.10 or later, `duckdb` 2.0 or later and `pyarrow` 19 or later,
which pip installs with it; `pandas` and `polars` are needed only for their DataFrames and for `to_pandas` and
`to_polars`. In a notebook:

```python
import vastgrid

grid = vastgrid.show(df)  # a pandas or Polars DataFrame, a PyArrow table or a DuckDB relation
grid = vastgrid.show("sales.parquet")
grid = vastgrid.show("book.xlsx", sheet="2025", height=600, locale="ja")
grid
```

`show(data, **options)` is `Grid(data, **options)`:

| Option | Default | What it is |
| --- | --- | --- |
| `sheet` | the first sheet | the sheet of a workbook |
| `height` | 480 | the grid's height in pixels |
| `locale` | `"en"` | the grid's texts and numbers, a BCP 47 tag: `"ja"`, `"zh-CN"`, `"zh-TW"`, `"ko"`, `"es"`, `"pt-BR"`, `"fr"`, `"de"`; texts are English for other languages |
| `name` | the file's name, or `"table"` | the table's name, which screen readers say |
| `workers` | 4 | the threads that answer the grid's requests side by side |

JupyterLab 4.6 and Jupyter Notebook 7.6 (with ipywidgets 8) are tested. Other hosts of anywidget (VS Code's
notebooks, Google Colab, marimo) are not tested yet.

## Files and tables

| Format | Files | In the grid |
| --- | --- | --- |
| CSV, TSV | `.csv`, `.txt`, `.tsv`, `.tab` (also `.gz`, `.zst`) | edited |
| JSON, JSON Lines | `.json`, `.jsonl`, `.ndjson` (also `.gz`, `.zst`) | edited |
| Parquet | `.parquet`, `.pq` | edited; read in place, a row range at a time |
| Excel | `.xlsx`, `.xlsm` | edited; the sheets of the workbook, hidden ones marked, and `sheet` chooses one |
| DataFrames | pandas, Polars, PyArrow tables, DuckDB relations | edited |

A DataFrame is copied into DuckDB in its row order when the grid opens; the DataFrame itself does not change.
Files other than Parquet are read into DuckDB as tables. All the kernel's grids share one DuckDB database in
memory, so that DuckDB's memory limit holds for all of them, and what does not fit spills into a temporary folder
of its own, deleted with the database.

## Editing and exporting

Everything the grid does with an engine works: sorting, filtering, searching, grouping, pivots, formulas,
statistics, finding and editing cells (typing, pasting, clearing, filling, undo and redo). See
[Using the grid](/guides/using-the-grid/).

Nothing is saved into a file in its place: a notebook has its data as variables, so the engine answers that it
does not save. The notebook reads the written cells instead:

```python
grid.edits                     # {"version": 3, "cells": 3}: the written cells
grid.plan                      # the plan of the grid's view: filters, sort, groups, derived columns
grid.to_pandas()               # the table with the written cells, in row order (to_polars, to_arrow too)
grid.to_pandas(view=True)      # the grid's view: its rows, in its order, and its columns
grid.export("view.xlsx")       # the view as a file: CSV, TSV, Parquet, JSON or Excel, by the extension
grid.export("all.parquet", view=False)   # the whole table in row order
grid.close()                   # closes the grid, its tables and the written cells
```

`export` gives the number of rows written, and replaces an existing file only once the new one is complete. The
grid's Export menu writes the same files and the browser downloads them.

## Lifetimes

- A grid lives as long as its cell's output. Running the cell again closes the grids it made before, and the
  kernel's end closes all of them. A closed grid's `edits`, `to_pandas` and `export` raise `ValueError`.
- The page's tables close with the output's view (a cell cleared, the notebook closed, the page loaded again).
  The `Grid` keeps the table and its written cells until it closes, and a view shown again opens it anew with them.
- `grid.close()` closes the grid at once: its page, its tables, its threads and its written cells.

## Keys

The grid's keys are its own while it has the focus: typing starts editing a cell, the arrows move between cells,
Enter and Tab write the edited cell and move, Esc cancels. The notebook's keys of command mode (A adds a cell, the
arrows move between cells) are off meanwhile, and work again once the focus leaves the grid. The grid follows
JupyterLab's theme, light or dark.

## Not yet

- The grid does not save into the file it read: export the table, or write it from the DataFrame.
- Written cells stay in the kernel's memory; a kernel that restarts loses them.

[notebook.md](https://github.com/yhay81/vastgrid/blob/main/docs/notebook.md) on GitHub has the details of the
messages and the tests.
