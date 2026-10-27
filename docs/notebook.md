# vastgrid in notebooks

`vastgrid` (`packages/notebook/python`, a Python package) shows a table of any size in vastgrid's grid in a Jupyter
notebook: a pandas or Polars DataFrame, a PyArrow table, a DuckDB relation, or a CSV, TSV, Parquet, JSON, JSON Lines
or Excel file. DuckDB reads it in the kernel; the grid in the cell's output is an [anywidget](https://anywidget.dev)
module (`packages/notebook/widget`) that shows `DataGrid` (react.md) and reads blocks of rows over the widget's
messages, a row range at a time, as it does from any engine (docs/spec.md §8). The notebook gets the edited table
back as a DataFrame, or exports it.

## Running it

```sh
pip install vastgrid
```

Before 0.2.0 is released, the pre-release is `pip install --pre vastgrid`. From this repository, build the grid's
module into the package first: `npm install`, `npm run build`, then `pip install ./packages/notebook/python`.

It needs Python 3.11 or later, `anywidget` 0.10 or later, `duckdb` 2.0 or later and `pyarrow` 19 or later;
`pandas` and `polars` are needed only for their DataFrames and for `to_pandas` and `to_polars`. In a notebook:

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
| `locale` | `"en"` | the grid's texts and numbers: `"en"` or `"ja"` |
| `name` | the file's name, or `"table"` | the table's name, which the grid reads it by and screen readers say |
| `workers` | 4 | the threads that answer the grid's requests side by side |

The environments are JupyterLab 4.6 and Jupyter Notebook 7.6 (with ipywidgets 8): both are tested (below). Other
hosts of anywidget (VS Code's notebooks, Google Colab, marimo) are not tested yet.

## Files and tables

| Format | Files | In the grid |
| --- | --- | --- |
| CSV, TSV | `.csv`, `.txt`, `.tsv`, `.tab` (also `.gz`, `.zst`) | edited |
| JSON, JSON Lines | `.json`, `.jsonl`, `.ndjson` (also `.gz`, `.zst`) | edited |
| Parquet | `.parquet`, `.pq` | edited; read in place, a row range at a time |
| Excel | `.xlsx` | edited; the sheets of the workbook, hidden ones marked, and `sheet` chooses one |
| DataFrames | pandas, Polars, PyArrow tables, DuckDB relations | edited |

A DataFrame is copied into DuckDB in its row order when the grid opens: the DataFrame itself does not change. Files
other than Parquet are read into DuckDB as tables. All the kernel's grids share one DuckDB database in memory, so
that DuckDB's memory limit holds for all of them, and what does not fit spills into a temporary folder of its own,
deleted with the database.

## Editing, exporting and saving

Everything the grid does with an engine works: sorting, filtering, searching, grouping, pivoting, formulas,
statistics, finding and editing cells (typing, pasting, clearing, filling, undo and redo). The grid in the output is
`DataGrid` with its toolbar and status bar.

The engine answers `capabilities.save` false: a notebook has its data as variables, so nothing is saved into a file
in its place. The notebook reads the written cells instead:

```python
grid.edits                     # {"version": 3, "cells": 3}: the written cells (§8.2)
grid.plan                      # the plan of the grid's view: filters, sort, groups, derived columns (§4)
grid.to_pandas()               # the table with the written cells, in row order (to_polars, to_arrow too)
grid.to_pandas(view=True)      # the grid's view: its rows, in its order, and its columns
grid.export("view.xlsx")       # the view as a file: CSV, TSV, Parquet, JSON or Excel, by the extension
grid.export("all.parquet", view=False)   # the whole table in row order
grid.close()                   # closes the grid, its tables and the written cells
```

`export` gives the rows written, and replaces an existing file only once the new one is complete. The grid's Export
menu writes the same files and the browser downloads them: the engine answers exports with their bytes (`delivery`
`data`, §8.2), and refuses an export `target` (`not_allowed`).

## Lifetimes

- A grid lives as long as its cell's output. Running the cell again closes the grids that it made before; the
  kernel's end closes all of them. A closed grid's `edits`, `to_pandas` and `export` raise `ValueError`.
- The page's tables close with the output's view (a cell cleared, the notebook closed, the page loaded again); the
  kernel's own handle keeps the table and its written cells for the `Grid` until it closes, and a view shown again
  opens the table anew with them.
- `grid.close()` closes the grid at once: its page, its tables, its threads and its written cells.

## Messages

The page sends the requests of §8.1 as the widget's custom messages, and the kernel answers them, and sends the
engine's events, the same way. The bytes of blocks and exports travel as the messages' buffers: the message holds
`{"vastgrid:buffer": <index>}` in their place. The page's side is `workerTransport` (react.md §4.4) over a port
that carries these messages; the kernel answers each request on a thread of its own, so that cells run meanwhile and
`cancel` interrupts a running request.

## Keys

The grid's keys are its own while it has the focus: typing starts editing a cell, the arrows move between cells,
Enter and Tab write the edited cell and move, Esc cancels. JupyterLab handles keys after the page and Notebook 7 before it; both skip their
keys of command mode (A adds a cell, the arrows move between cells) for a notebook marked `jp-mod-readWrite`, as it is
while one of its text fields has the focus, so the grid sets that mark while it has the focus. The notebook's own keys
work again once the focus leaves the grid. The grid follows JupyterLab's theme, light or dark.

## Testing

- `packages/notebook/python/tests` (pytest): the requests of the message corpus, files of every format, the sheets of
  a workbook, DataFrames, closing, reloading, refusals and cancelling (`test_engine.py`); the widget's messages and
  buffers, the notebook's API, exports and the grids' lifetimes with their cells (`test_widget.py`).
- `packages/notebook/test/conformance.test.ts` runs the conformance corpus of `packages/spec` against the engine,
  over its messages on standard input and output (`tests/stdio_server.py`).
- `packages/notebook/test/engines.test.ts` compares the engine's answers with vastgrid-js's memory engine: generated
  tables and plans, finding, statistics, locating, every export format and generated writes (`VASTGRID_SEED`,
  `VASTGRID_PLANS`).
- By hand, in JupyterLab 4.6.4 and Notebook 7.6.3 (`uv run jupyter lab` in `packages/notebook/python`): a DataFrame
  of 1,000,000 rows opens, sorts by a column, takes typed cells without the notebook's keys, gives `grid.edits`, the
  view as a DataFrame and the view exported as Excel and CSV with the written cells; running the cell again closes
  the grid before.

The Python tests need [uv](https://docs.astral.sh/uv/): `uv run pytest` in `packages/notebook/python`, and the
TypeScript tests skip without it.

## Not yet

- The package is not on PyPI; publishing it belongs to switching from 0.1 to 0.2
  ([#45](https://github.com/yhay81/vastgrid/issues/45)).
- `.xlsm` workbooks do not open.
- The grid does not save into the file it read: export the table, or write it from the DataFrame.
- Written cells stay in the kernel's memory; a kernel that restarts loses them.
