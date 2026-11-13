"""The grid of a notebook (docs/notebook.md): an anywidget whose page shows vastgrid's grid, and whose engine runs in
the kernel. The page sends the messages of docs/spec.md §8 as the widget's custom messages; the kernel answers them
on threads of its own, so that the notebook runs cells meanwhile and `cancel` reaches a running request.

A grid lives as long as its cell's output: running the cell again closes the grids it made before, and so does the
kernel's end. The page's tables are closed with its view; the written cells stay with the `Grid` until it closes.
"""

from __future__ import annotations

import atexit
import os
import pathlib
import shutil
import tempfile
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import anywidget
import duckdb
import pyarrow as pa
import traitlets

from ._engine import Engine
from ._engine_types import Source, relation_column
from ._errors import EngineError
from ._export import excel_number_format
from ._session import Running, new_database
from ._sql import view_column
from ._table import file_format
from ._view_export import write_export
from ._views import View

_STATIC = pathlib.Path(__file__).parent / "static"
_MARK = "vastgrid:buffer"

_database: duckdb.DuckDBPyConnection | None = None
_database_lock = threading.Lock()
_grids: weakref.WeakSet[Grid] = weakref.WeakSet()
# The grids that each cell made, by the cell's id, with the request that ran it.
_cells: dict[str, tuple[str, list[weakref.ref[Grid]]]] = {}


def _shared_database() -> duckdb.DuckDBPyConnection:
    """The DuckDB database of the kernel's grids, in memory: one, so that DuckDB's memory limit holds for all."""
    global _database
    with _database_lock:
        if _database is None:
            _database = new_database()
        return _database


@atexit.register
def _close_all() -> None:
    for grid in list(_grids):
        grid.close()


def _split(value: Any, buffers: list[bytes]) -> Any:
    """The message with its bytes taken out into `buffers`, a mark in their place."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        buffers.append(bytes(value))
        return {_MARK: len(buffers) - 1}
    if isinstance(value, dict):
        return {key: _split(item, buffers) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_split(item, buffers) for item in value]
    return value


def _join(value: Any, buffers: list[Any]) -> Any:
    """The message with its buffers put back as bytes."""
    if isinstance(value, dict):
        if len(value) == 1 and _MARK in value:
            return bytes(buffers[value[_MARK]])
        return {key: _join(item, buffers) for key, item in value.items()}
    if isinstance(value, list):
        return [_join(item, buffers) for item in value]
    return value


def _cell() -> tuple[str, str] | None:
    """The id of the cell that runs now and of the request that runs it, where the notebook's front end sends them
    (JupyterLab, Notebook 7 and VS Code send the cell's id)."""
    try:
        from IPython import get_ipython

        shell = get_ipython()
        kernel = getattr(shell, "kernel", None)
        parent = kernel.get_parent() if kernel is not None else None
    except Exception:  # noqa: BLE001 - outside a kernel there is no cell
        return None
    if not isinstance(parent, dict):
        return None
    cell = parent.get("metadata", {}).get("cellId")
    request = parent.get("header", {}).get("msg_id")
    return (cell, request) if isinstance(cell, str) and isinstance(request, str) else None


def _displayed_columns(
    columns: list[dict[str, Any]], document: dict[str, Any] | None
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """The view's displayed columns in display order (docs/spec.md §5.1.1), and their settings by name."""
    raw_settings = (document or {}).get("columns") if isinstance(document, dict) else None
    if not isinstance(raw_settings, list):
        return list(columns), {}
    settings_list: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for item in raw_settings:
        if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"] not in seen_names:
            seen_names.add(item["name"])
            settings_list.append(item)
    by_setting: dict[str, dict[str, Any]] = {item["name"]: item for item in settings_list}
    by_name = {column["name"]: column for column in columns}
    listed = [
        (by_name[item["name"]], item)
        for item in settings_list
        if item["name"] in by_name and item.get("hidden") is not True
    ]
    left = [col for col, item in listed if item.get("pin") == "left"]
    right = [col for col, item in listed if item.get("pin") == "right"]
    middle = [
        *[col for col, item in listed if item.get("pin") not in ("left", "right")],
        *[col for col in columns if col["name"] not in by_setting],
    ]
    displayed = [*left, *middle, *right]
    if not displayed and columns:
        displayed.append(columns[0])
    return displayed, by_setting


class Grid(anywidget.AnyWidget):
    """A table in vastgrid's grid: a pandas or Polars DataFrame or Series, a PyArrow table, a DuckDB relation, or a
    file (CSV, TSV, Parquet, JSON, JSON Lines, Excel or DuckDB database), powered by DuckDB in the kernel. The grid
    filters, sorts, groups and edits it; `to_pandas`, `to_polars` and `to_arrow` give the table with the written
    cells."""

    _esm = _STATIC / "widget.js"
    _css = _STATIC / "widget.css"

    ref = traitlets.Unicode("table").tag(sync=True)
    name = traitlets.Unicode("table").tag(sync=True)
    sheet = traitlets.Unicode(None, allow_none=True).tag(sync=True)
    height = traitlets.Int(480).tag(sync=True)
    locale = traitlets.Unicode("en").tag(sync=True)
    document = traitlets.Dict(None, allow_none=True).tag(sync=True)

    # Until the grid has opened its table, and again once it is closed.
    _closed = True

    def __init__(
        self,
        data: Any,
        *,
        sheet: str | None = None,
        height: int = 480,
        locale: str = "en",
        name: str | None = None,
        document: dict[str, Any] | None = None,
        workers: int = 4,
    ) -> None:
        if isinstance(data, (str, os.PathLike)):
            path = os.path.abspath(os.fspath(data))
            fmt = file_format(path)
            if fmt is None:
                raise ValueError(
                    f"vastgrid reads CSV, TSV, Parquet, JSON, JSON Lines, Excel and DuckDB files, not {path}."
                )
            source = Source(path=path, format=fmt, sheet=sheet)
            name = name or os.path.basename(path)
        else:
            source = Source(data=data)
            name = name or "table"
        super().__init__(ref=name, name=name, sheet=sheet, height=height, locale=locale, document=document)
        self._engine = Engine(_shared_database().cursor())
        self._engine.add(name, source)
        # The kernel's own handle keeps the table, and its written cells, while the grid lives.
        opened = self._engine.handle({"v": 2, "id": 0, "op": "open", "ref": name})
        if opened is None or "error" in opened:
            error = (opened or {}).get("error", {})
            self._engine.close()
            super().close()
            raise EngineError(error.get("code", "load_failed"), error.get("message", "The table could not be read."))
        self._table_id: str = opened["result"]["table"]
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="vastgrid")
        self._unsubscribe = self._engine.subscribe(self._event)
        self._closed = False
        self.on_msg(self._receive)
        _grids.add(self)
        self._follow_cell()

    def _follow_cell(self) -> None:
        """Closes the grids that this grid's cell made when it ran before."""
        cell = _cell()
        if cell is None:
            return
        cell_id, request = cell
        before = _cells.get(cell_id)
        if before is not None and before[0] != request:
            for ref in before[1]:
                grid = ref()
                if grid is not None:
                    grid.close()
            before = None
        grids = before[1] if before is not None else []
        grids.append(weakref.ref(self))
        _cells[cell_id] = (request, grids)

    # ----- the page's messages -----

    def _receive(self, _widget: Any, content: Any, buffers: list[Any]) -> None:
        message = _join(content, buffers or [])
        if isinstance(message, dict) and message.get("op") == "cancel":
            self._answer(message)
            return
        if not self._closed:
            self._pool.submit(self._answer, message)

    def _answer(self, message: Any) -> None:
        response = self._engine.handle(message)
        if response is not None:
            self._post(response)

    def _event(self, event: dict[str, Any]) -> None:
        if event.get("table") != self._table_id:
            self._post(event)

    def _post(self, message: dict[str, Any]) -> None:
        if self._closed:
            return
        buffers: list[bytes] = []
        content = _split(message, buffers)
        self.send(content, buffers)

    # ----- the notebook's API -----

    @property
    def edits(self) -> dict[str, int]:
        """The written cells: `{"version", "cells"}` (docs/spec.md §8.2)."""
        return self._table().edits.state

    @property
    def plan(self) -> dict[str, Any]:
        """The plan of the grid's view (docs/spec.md §4): its filters, sort, groups and derived columns."""
        return dict((self.document or {}).get("plan") or {})

    def _table(self):
        if self._closed:
            raise ValueError("The grid is closed.")
        return self._engine.handles[self._table_id]

    def to_arrow(self, *, view: bool = False) -> pa.Table:
        """The table with the written cells, as a PyArrow table, in row order; with `view`, the grid's view: its
        rows, in its order, and its visible columns."""
        table = self._table()
        if view:
            return self._arrow_of_view(table)
        relation = table.relation
        assert relation is not None
        if not table.columns:
            return pa.table({"_": pa.nulls(table.row_count)}).select([])
        selected = ", ".join(
            f"{relation_column(relation, column['name'])} AS c{index}" for index, column in enumerate(table.columns)
        )
        cursor = self._engine.session.cursor()
        try:
            arrow = cursor.sql(f"SELECT {selected} FROM {relation.sql} ORDER BY {relation.row_id}").to_arrow_table()
            return arrow.rename_columns([column["name"] for column in table.columns])
        finally:
            cursor.close()

    def _arrow_of_view(self, table: Any) -> pa.Table:
        def read_arrow(v: View) -> pa.Table:
            columns, _ = _displayed_columns(v.sql.columns, self.document)
            if not columns:
                return pa.table({"_": pa.nulls(v.row_count)}).select([])
            selected_parts: list[str] = []
            for index, column in enumerate(columns):
                expr = view_column(v.sql, column["name"])
                if column.get("type") == "float":
                    expr = f"CAST({expr} AS {'FLOAT' if column.get('bits') == 32 else 'DOUBLE'})"
                selected_parts.append(f"{expr} AS c{index}")
            selected = ", ".join(selected_parts)
            cursor = self._engine.session.cursor()
            try:
                arrow = cursor.sql(
                    f"{v.sql.with_} SELECT {selected} FROM vg_view ORDER BY {v.position}",
                    params=v.sql.params,
                ).to_arrow_table()
                return arrow.rename_columns([column["name"] for column in columns])
            finally:
                cursor.close()

        return self._engine.views.use(table, {"plan": self.plan}, Running(), read_arrow)

    def to_pandas(self, *, view: bool = False):
        """The table with the written cells as a pandas DataFrame (see `to_arrow`)."""
        return self.to_arrow(view=view).to_pandas()

    def to_polars(self, *, view: bool = False):
        """The table with the written cells as a Polars DataFrame (see `to_arrow`)."""
        import polars

        return polars.from_arrow(self.to_arrow(view=view))

    def export(self, path: str | os.PathLike[str], format: str | None = None, *, view: bool = True) -> int:
        """Writes the grid's view (with `view=False`, the whole table in row order) with the written cells into a
        file, as the grid's Export menu writes it: CSV, TSV, Parquet, JSON or Excel (`xlsx`), by `format` or the
        file's extension. Gives the rows written. An existing file is replaced once the new one is complete."""
        table = self._table()
        target = os.path.abspath(os.fspath(path))
        fmt = format or os.path.splitext(target)[1].lstrip(".").lower()
        if fmt not in ("csv", "tsv", "parquet", "json", "xlsx"):
            raise ValueError(f"vastgrid exports CSV, TSV, Parquet, JSON and Excel (xlsx) files, not {fmt!r}.")
        parent = os.path.dirname(target) or "."
        temp_dir = tempfile.mkdtemp(prefix=".vastgrid-", dir=parent)
        temporary = os.path.join(temp_dir, f"export.{fmt}")
        running = Running()

        def write_view(v: View) -> int:
            number_formats: list[str | None] | None = None
            if view:
                columns, settings = _displayed_columns(v.sql.columns, self.document)
                headers = [
                    (settings.get(column["name"], {}).get("format") or {}).get("label") or column["name"]
                    for column in columns
                ]
                if fmt == "xlsx" and columns:
                    codes = [
                        excel_number_format(column["type"], settings.get(column["name"], {}).get("format"))
                        for column in columns
                    ]
                    if any(code is not None for code in codes):
                        number_formats = codes
            else:
                columns = v.sql.columns
                headers = [column["name"] for column in columns]
            write_export(self._engine.session, v, fmt, columns, headers, number_formats, temporary, running)
            return v.row_count

        try:
            rows = self._engine.views.use(table, {"plan": self.plan if view else {}}, running, write_view)
            os.replace(temporary, target)
            return rows
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def close(self) -> None:
        """Closes the grid: its page, its tables and the written cells."""
        if not self._closed:
            self._closed = True
            self._unsubscribe()
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._engine.close()
            _grids.discard(self)
        super().close()


def show(data: Any, **options: Any) -> Grid:
    """A grid of a table (see `Grid`), to show as a cell's output."""
    return Grid(data, **options)
