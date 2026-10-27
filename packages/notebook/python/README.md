# vastgrid

Huge tables in a Jupyter notebook as a grid you can edit. DuckDB in the kernel reads a pandas or Polars DataFrame,
a PyArrow table, a DuckDB relation, or a CSV, TSV, Parquet, JSON, JSON Lines or Excel file of any size; vastgrid's
grid shows it in the cell's output, a row range at a time, and sorts, filters, groups, pivots, finds, edits and
exports it. The notebook gets the edited table back as a DataFrame.

```python
import vastgrid

grid = vastgrid.show("sales.parquet")
grid

grid.to_pandas(view=True)  # the grid's view, with the written cells
grid.export("view.xlsx")  # the view as CSV, TSV, Parquet, JSON or Excel
```

It needs Python 3.11 or later and runs in JupyterLab 4 and Jupyter Notebook 7 (with ipywidgets 8), as an
[anywidget](https://anywidget.dev).

- Documentation: [docs/notebook.md](https://github.com/yhay81/vastgrid/blob/main/docs/notebook.md)
- Other places vastgrid opens files: [docs/entries.md](https://github.com/yhay81/vastgrid/blob/main/docs/entries.md)
- License: MIT
