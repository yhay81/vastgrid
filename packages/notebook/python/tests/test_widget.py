"""The grid of a notebook (docs/notebook.md) without a front end: the page's messages over the widget's custom
messages, with their bytes as buffers; the lifetimes of grids with their cells; and the notebook's API of written
cells, plans and exports."""

from __future__ import annotations

import queue
import struct
from pathlib import Path
from typing import Any

import pandas
import polars
import pyarrow as pa
import pyarrow.parquet as parquet
import pytest

import vastgrid._widget as widget
from vastgrid import Grid, show


class Page:
    """The page of a grid: it sends requests as the widget's custom messages and reads what the kernel sends."""

    def __init__(self, grid: Grid, monkeypatch: pytest.MonkeyPatch) -> None:
        self.grid = grid
        self.sent: queue.Queue[dict[str, Any]] = queue.Queue()
        self.id = 100

        def send(content: Any, buffers: list[bytes] | None = None) -> None:
            self.sent.put(widget._join(content, buffers or []))

        monkeypatch.setattr(grid, "send", send)

    def request(self, op: str, **members: Any) -> dict[str, Any]:
        self.id += 1
        buffers: list[bytes] = []
        content = widget._split({"v": 2, "id": self.id, "op": op, **members}, buffers)
        self.grid._receive(self.grid, content, buffers)
        while True:
            message = self.sent.get(timeout=30)
            if message.get("id") == self.id:
                return message


@pytest.fixture
def no_cell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(widget, "_cell", lambda: None)


def test_bytes_travel_as_buffers() -> None:
    message = {"v": 2, "id": 1, "result": {"block": {"bytes": b"\x00\x01"}, "data": [{"bytes": b"x"}, 1, "two"]}}
    buffers: list[bytes] = []
    content = widget._split(message, buffers)
    assert buffers == [b"\x00\x01", b"x"]
    assert content["result"]["block"] == {"bytes": {"vastgrid:buffer": 0}}
    assert widget._join(content, [memoryview(buffer) for buffer in buffers]) == message


def test_the_page_reads_and_writes_the_table(no_cell: None, monkeypatch: pytest.MonkeyPatch) -> None:
    grid = Grid(pandas.DataFrame({"city": ["Tokyo", "Osaka", "Kyoto"], "n": [3, 1, 2]}), name="cities")
    page = Page(grid, monkeypatch)
    try:
        opened = page.request("open", ref="cities")["result"]
        assert opened["rowCount"] == 3 and opened["capabilities"]["save"] is False
        at = {"table": opened["table"], "revision": opened["revision"]}
        rows = page.request(
            "rows", **at, plan={"sort": [{"column": "n", "direction": "asc"}]}, start=0, end=3, columns=["city"]
        )
        block = pa.ipc.open_stream(rows["result"]["block"]["bytes"]).read_all()
        assert block.column(0).to_pylist() == ["Osaka", "Kyoto", "Tokyo"]
        written = page.request("write", **at, updates=[{"key": {"rowId": 0}, "column": "city", "value": "Nara"}])
        assert written["result"]["edits"] == {"version": 1, "cells": 1}
        # The page's own write is told to it as an event too, and the notebook's API sees the written cell.
        assert grid.edits == {"version": 1, "cells": 1}
        assert grid.to_pandas()["city"].tolist() == ["Nara", "Osaka", "Kyoto"]
        exported = page.request("export", **at, plan={}, format="xlsx")
        assert exported["result"]["data"]["bytes"][:2] == b"PK"
        # The page's tables close with its view; the grid keeps the written cells.
        assert page.request("close", table=opened["table"])["result"] is None
        assert grid.to_polars()["city"].to_list() == ["Nara", "Osaka", "Kyoto"]
        assert page.request("info", table=opened["table"])["error"]["code"] == "table_not_found"
        # A view shown again (the page loaded again) opens the table anew, with the written cells.
        again = page.request("open", ref="cities")["result"]
        assert again["edits"] == {"version": 1, "cells": 1}
        rows = page.request(
            "rows", table=again["table"], revision=again["revision"], plan={}, start=0, end=3, columns=["city"]
        )
        assert pa.ipc.open_stream(rows["result"]["block"]["bytes"]).read_all().column(0).to_pylist()[0] == "Nara"
    finally:
        grid.close()


def test_the_notebook_reads_the_view_and_exports_it(no_cell: None, tmp_path: Path) -> None:
    grid = show(polars.DataFrame({"city": ["Tokyo", "Osaka", "Kyoto"], "n": [3, 1, 2]}))
    try:
        # The page sets the document as the grid's plan changes.
        grid.document = {
            "plan": {
                "where": {"fn": "gt", "args": [{"col": "n"}, {"lit": 1}]},
                "sort": [{"column": "n", "direction": "desc"}],
            },
            "columns": [
                {"name": "n", "format": {"label": "Count"}},
                {"name": "city", "hidden": True},
            ],
        }
        view = grid.to_pandas(view=True)
        assert list(view.columns) == ["n"] and view["n"].tolist() == [3, 2]
        assert grid.to_arrow()["city"].to_pylist() == ["Tokyo", "Osaka", "Kyoto"]
        assert grid.export(tmp_path / "view.csv") == 2
        assert (tmp_path / "view.csv").read_text("utf-8") == "Count\n3\n2\n"
        assert grid.export(tmp_path / "all.parquet", view=False) == 3
        assert parquet.read_table(tmp_path / "all.parquet")["n"].to_pylist() == [3, 1, 2]
        with pytest.raises(ValueError):
            grid.export(tmp_path / "view.txt")
        assert sorted(path.name for path in tmp_path.iterdir()) == ["all.parquet", "view.csv"]
    finally:
        grid.close()


def test_zero_column_and_case_colliding_views(no_cell: None, tmp_path: Path) -> None:
    empty = Grid(pa.table({"removed": [1, 2, 3]}).drop(["removed"]))
    colliding = Grid(pa.table({"a": [1, 2], "A": [10, 20]}))
    try:
        assert empty.to_arrow().shape == (3, 0)
        assert empty.to_arrow(view=True).shape == (3, 0)
        empty.document = {"plan": {"where": {"lit": False}}}
        assert empty.to_arrow(view=True).shape == (0, 0)
        table = colliding.to_arrow(view=True)
        assert table.column_names == ["a", "A"]
        assert [column.to_pylist() for column in table.columns] == [[1, 2], [10, 20]]
        path = tmp_path / "case.parquet"
        assert colliding.export(path) == 2
        exported = parquet.read_table(path)
        assert exported.column_names == ["a", "A"]
        assert exported.column(0).equals(table.column(0))
        assert exported.column(1).equals(table.column(1))
    finally:
        empty.close()
        colliding.close()


def test_parquet_keeps_distinct_intervals_with_case_colliding_names(no_cell: None, tmp_path: Path) -> None:
    intervals = pa.array([(1, 0, 0), (0, 30, 0)], type=pa.month_day_nano_interval())
    grid = Grid(pa.table({"span": intervals, "SPAN": [1, 2]}))
    try:
        path = tmp_path / "intervals.parquet"
        assert grid.export(path) == 2
        metadata = parquet.read_metadata(path)
        assert metadata.schema.column(0).converted_type == "INTERVAL"
        exported = parquet.read_table(path)
        assert exported.column_names == ["span", "SPAN"]
        # The Parquet INTERVAL stores months, days and milliseconds as three little-endian integers.
        assert [struct.unpack("<III", value) for value in exported.column(0).to_pylist()] == [(1, 0, 0), (0, 30, 0)]
    finally:
        grid.close()


def test_files_and_unknown_formats(no_cell: None, tmp_path: Path) -> None:
    path = tmp_path / "cities.csv"
    path.write_text("city,n\nTokyo,1\n", "utf-8")
    grid = Grid(path)
    try:
        assert grid.name == "cities.csv" and grid.to_pandas()["n"].tolist() == [1]
    finally:
        grid.close()
    with pytest.raises(ValueError):
        Grid(tmp_path / "cities.docx")


def test_a_cell_run_again_closes_the_grids_it_made(monkeypatch: pytest.MonkeyPatch) -> None:
    run = {"cell": ("cell-1", "run-1")}
    monkeypatch.setattr(widget, "_cell", lambda: run["cell"])
    table = pa.table({"n": [1, 2]})
    first, second = Grid(table), Grid(table)
    run["cell"] = ("cell-2", "run-2")
    other = Grid(table)
    assert not first._closed and not second._closed
    run["cell"] = ("cell-1", "run-3")
    again = Grid(table)
    assert first._closed and second._closed and not other._closed and not again._closed
    with pytest.raises(ValueError):
        first.to_arrow()
    widget._close_all()
    assert other._closed and again._closed


def test_view_to_arrow_respects_displayed_columns_pivot_and_export_timezone(no_cell: None, tmp_path: Path) -> None:
    grid = Grid(
        pa.table(
            {
                "k": ["A", "A", "B"],
                "p": ["x", "y", "x"],
                "v": pa.array([1.5, 2.5, 3.0], type=pa.float32()),
                "ts": pa.array([0, 0, 0], type=pa.timestamp("us", tz="UTC")),
            }
        ),
        document={
            "timeZone": "Asia/Tokyo",
            "columns": [{"name": "p", "hidden": True}],
        },
    )
    try:
        shown = grid.to_arrow(view=True)
        assert shown.column_names == ["k", "v", "ts"]
        assert shown.schema.field("v").type == pa.float32()

        grid.document = {
            "timeZone": "Asia/Tokyo",
            "plan": {
                "aggregate": {
                    "keys": ["k"],
                    "measures": [{"name": "s", "fn": "sum", "column": "v"}],
                    "pivot": {"columns": ["p"]},
                }
            },
        }
        pivoted = grid.to_arrow(view=True)
        assert pivoted.column_names == ["k", "x / s", "y / s"]
        assert pivoted.to_pydict() == {"k": ["A", "B"], "x / s": [1.5, 3.0], "y / s": [2.5, None]}

        grid.document = {"columns": [{"name": "v", "format": {"number": {"fractionDigits": 3}}}]}
        xlsx_path = tmp_path / "formatted.xlsx"
        grid.export(xlsx_path)
        import zipfile

        with zipfile.ZipFile(xlsx_path) as zf:
            assert "0.000" in zf.read("xl/styles.xml").decode("utf-8")
    finally:
        grid.close()
