"""The engine's operations beyond the plan corpus (docs/spec.md §8): the requests of the message corpus, the files
and DataFrames it reads, closing, reloading and cancelling, and what it refuses. The answers of its plans, writes,
finds, summaries and exports are compared with vastgrid-js's in packages/notebook/test/engines.test.ts."""

from __future__ import annotations

import json
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

import duckdb
import pandas
import polars
import pyarrow as pa
import pytest

from vastgrid import Engine, Source
from vastgrid._edits import Edits
from vastgrid._messages import ProtocolError, check_request
from vastgrid._table import file_format

MESSAGES = Path(__file__).resolve().parents[3] / "spec" / "conformance" / "messages"
REQUESTS = json.loads((MESSAGES / "requests.json").read_text("utf-8"))["cases"]


@pytest.mark.parametrize("case", REQUESTS, ids=[case["id"] for case in REQUESTS])
def test_requests_of_the_message_corpus(case: dict[str, Any]) -> None:
    expect = case["expect"]
    if expect.get("valid"):
        check_request(case["message"])
        return
    with pytest.raises(ProtocolError) as raised:
        check_request(case["message"])
    error = expect["error"]
    assert raised.value.code == error["code"]
    assert {"reason": raised.value.reason, "path": raised.value.path} == {
        "reason": error.get("reason", raised.value.reason),
        "path": error.get("path", raised.value.path),
    }


class Client:
    """Requests to an engine, with ids."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.id = 0
        self.events: list[dict[str, Any]] = []
        engine.subscribe(self.events.append)

    def send(self, op: str, **members: Any) -> dict[str, Any]:
        self.id += 1
        response = self.engine.handle({"v": 2, "id": self.id, "op": op, **members})
        assert response is not None and response["id"] == self.id
        return response

    def result(self, op: str, **members: Any) -> Any:
        response = self.send(op, **members)
        assert "error" not in response, response["error"]
        return response["result"]

    def error(self, op: str, **members: Any) -> dict[str, Any]:
        response = self.send(op, **members)
        assert "error" in response, f"{op} answers {response['result']}"
        return response["error"]

    def rows(self, info: dict[str, Any], plan: Any = None, columns: list[str] | None = None) -> list[list[Any]]:
        names = columns if columns is not None else [column["name"] for column in info["columns"]]
        result = self.result(
            "rows", table=info["table"], revision=info["revision"], plan=plan or {}, start=0, end=1000, columns=names
        )
        block = pa.ipc.open_stream(result["block"]["bytes"]).read_all()
        return [list(row) for row in zip(*(column.to_pylist() for column in block.columns), strict=True)]


@pytest.fixture
def engine():
    engine = Engine()
    yield engine
    engine.close()


def workbook(path: Path, sheets: dict[str, list[list[Any]]], hidden: tuple[str, ...] = ()) -> None:
    """A workbook of sheets of numbers and inline strings, as small as Excel reads it."""
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relations = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    names = list(sheets)

    def cell(column: int, row: int, value: Any) -> str:
        ref = f"{chr(65 + column)}{row}"
        if isinstance(value, str):
            return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'
        return f'<c r="{ref}"><v>{value}</v></c>'

    with zipfile.ZipFile(path, "w") as archive:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{index + 1}.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(len(names))
        )
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/'
            f'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>',
        )
        archive.writestr(
            "_rels/.rels",
            f'<Relationships xmlns="{package}"><Relationship Id="r1" Type="{relations}/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>',
        )
        state = ' state="hidden"'
        entries = "".join(
            f'<sheet name="{name}" sheetId="{index + 1}" r:id="r{index + 1}"{state if name in hidden else ""}/>'
            for index, name in enumerate(names)
        )
        archive.writestr(
            "xl/workbook.xml", f'<workbook xmlns="{main}" xmlns:r="{relations}"><sheets>{entries}</sheets></workbook>'
        )
        targets = "".join(
            f'<Relationship Id="r{index + 1}" Type="{relations}/worksheet" Target="worksheets/sheet{index + 1}.xml"/>'
            for index in range(len(names))
        )
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{package}">{targets}</Relationships>')
        for index, name in enumerate(names):
            rows = "".join(
                f'<row r="{at + 1}">{"".join(cell(column, at + 1, value) for column, value in enumerate(row))}</row>'
                for at, row in enumerate(sheets[name])
            )
            archive.writestr(
                f"xl/worksheets/sheet{index + 1}.xml",
                f'<worksheet xmlns="{main}"><sheetData>{rows}</sheetData></worksheet>',
            )


def test_files_of_every_format(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    files = {
        "a.csv": "city,n\nTokyo,1\nOsaka,2\n",
        "a.tsv": "city\tn\nTokyo\t1\nOsaka\t2\n",
        "a.json": '[{"city": "Tokyo", "n": 1}, {"city": "Osaka", "n": 2}]',
        "a.ndjson": '{"city": "Tokyo", "n": 1}\n{"city": "Osaka", "n": 2}\n',
        "a.jsonl": '{"city": "Tokyo", "n": 1}\n{"city": "Osaka", "n": 2}\n',
    }
    for name, text in files.items():
        (tmp_path / name).write_text(text, "utf-8")
    duckdb.sql(f"COPY (SELECT 'Tokyo' AS city, 1 AS n UNION ALL SELECT 'Osaka', 2) TO '{tmp_path / 'a.parquet'}'")
    workbook(tmp_path / "a.xlsx", {"Cities": [["city", "n"], ["Tokyo", 1], ["Osaka", 2]]})
    # A workbook with macros is a workbook of the same parts, and its macros are not run.
    workbook(tmp_path / "a.xlsm", {"Cities": [["city", "n"], ["Tokyo", 1], ["Osaka", 2]]})
    for name in [*files, "a.parquet", "a.xlsx", "a.xlsm"]:
        path = tmp_path / name
        engine.add(name, Source(path=str(path), format=file_format(name) or ""))
        info = client.result("open", ref=name)
        assert info["status"] == "ready" and info["rowCount"] == 2, name
        assert [column["name"] for column in info["columns"]] == ["city", "n"], name
        assert [row[0] for row in client.rows(info)] == ["Tokyo", "Osaka"], name
        assert info["capabilities"]["save"] is False
        assert info["capabilities"]["export"]["delivery"] == "data"


def test_csv_files_with_line_breaks_in_quotes_keep_every_record(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)

    # Records with a line break in quotes now and then, beyond the rows that DuckDB's sniffer samples.
    def records(count: int) -> str:
        return "\n".join(
            f'{i},"a{i}",{chr(34) + "x" + chr(10) + "y" + chr(34) if i % 100 == 0 else "z"}' for i in range(count)
        )

    files = [
        # The same fields in every record: read without padding.
        ("even.csv", f"id,name,note\n{records(30_000)}", 30_000, [29_999, "a29999", "z"]),
        # A short record late in the file: read again with padding.
        ("short-late.csv", f"id,name,note\n{records(30_000)}\n7,b", 30_001, [7, "b", None]),
        # Lines before the header and a short first record, which only padding reads as records.
        ("preamble.csv", f"Sales report\nmade 2026\n\nid,name,note\n{records(3_000)}", 3_002, ["2999", "a2999", "z"]),
        ("short-early.csv", f"id,name,note\n1,a\n{records(3_000)}", 3_001, [2_999, "a2999", "z"]),
    ]
    for name, text, row_count, last in files:
        (tmp_path / name).write_text(text, "utf-8")
        engine.add(name, Source(path=str(tmp_path / name), format="csv"))
        info = client.result("open", ref=name)
        assert info["status"] == "ready" and info["rowCount"] == row_count, name
        result = client.result(
            "rows",
            table=info["table"],
            revision=info["revision"],
            plan={},
            start=row_count - 1,
            end=row_count,
            columns=[column["name"] for column in info["columns"]],
        )
        block = pa.ipc.open_stream(result["block"]["bytes"]).read_all()
        assert [column[0].as_py() for column in block.columns] == last, name


def test_sheets_of_a_workbook(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    path = tmp_path / "book.xlsx"
    workbook(path, {"First": [["a"], [1]], "Second": [["b"], ["x"], ["y"]], "Secret": [["c"]]}, hidden=("Secret",))
    engine.add("book", Source(path=str(path), format="xlsx"))
    first = client.result("open", ref="book")
    assert first["sheets"] == [{"name": "First"}, {"name": "Second"}, {"name": "Secret", "hidden": True}]
    assert first["sheet"] == "First"
    second = client.result("open", ref="book", read={"sheet": "Second"})
    assert second["sheet"] == "Second" and client.rows(second) == [["x"], ["y"]]
    assert client.error("open", ref="book", read={"sheet": "Missing"})["code"] in ("not_found", "load_failed")


def test_tables_of_a_duckdb_database(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    path = tmp_path / "shop.duckdb"
    database = duckdb.connect(str(path))
    database.execute("CREATE TABLE cities (id INTEGER, name VARCHAR)")
    database.execute("INSERT INTO cities VALUES (1, 'Tokyo'), (2, 'Osaka'), (3, 'Nara')")
    # Deleted rows leave gaps in DuckDB's rowid; the row IDs of the table are its positions (§1).
    database.execute("DELETE FROM cities WHERE id = 2")
    database.execute("CREATE VIEW names AS SELECT name FROM cities")
    database.execute("CREATE SCHEMA sales")
    database.execute("CREATE TABLE sales.orders AS SELECT 'Tokyo' AS city")
    database.close()
    assert file_format("shop.duckdb") == "duckdb" and file_format("Shop.DDB") == "duckdb"
    assert file_format("shop.db") is None
    engine.add("shop", Source(path=str(path), format="duckdb"))
    first = client.result("open", ref="shop")
    assert first["format"] == "duckdb"
    # A view is SQL of the database's author, which reads whatever it names.
    assert first["sheets"] == [{"name": "cities"}, {"name": "sales.orders"}]
    assert first["sheet"] == "cities" and client.rows(first) == [[1, "Tokyo"], [3, "Nara"]]
    names = [column["name"] for column in first["columns"]]
    read = client.result(
        "rows", table=first["table"], revision=first["revision"], plan={}, start=0, end=9, columns=names
    )
    assert read["rowIds"] == [0, 1]
    orders = client.result("open", ref="shop", read={"sheet": "sales.orders"})
    assert orders["sheet"] == "sales.orders" and client.rows(orders) == [["Tokyo"]]
    for sheet in ("nowhere", "names"):
        missing = client.error("open", ref="shop", read={"sheet": sheet})
        assert missing["message"] == f'The database has no table named "{sheet}".'
    # The database is attached only while its table loads.
    attached = engine.session.database.execute("SELECT database_name FROM duckdb_databases()").fetchall()
    assert not any(name.startswith("vg_db") for (name,) in attached)


def test_files_that_are_not_duckdb_databases(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    (tmp_path / "fake.duckdb").write_text("id,name\n1,a\n" * 1000, "utf-8")
    engine.add("fake", Source(path=str(tmp_path / "fake.duckdb"), format="duckdb"))
    assert client.error("open", ref="fake")["message"] == "The file is not a DuckDB database."
    duckdb.connect(str(tmp_path / "empty.duckdb")).close()
    engine.add("empty", Source(path=str(tmp_path / "empty.duckdb"), format="duckdb"))
    assert client.error("open", ref="empty")["message"] == "The database has no tables."


def test_dataframes_arrow_tables_and_relations(engine: Engine) -> None:
    client = Client(engine)
    sources = {
        "pandas": pandas.DataFrame({"city": ["Tokyo", "Osaka"], "n": [1, 2]}),
        "polars": polars.DataFrame({"city": ["Tokyo", "Osaka"], "n": [1, 2]}),
        "arrow": pa.table({"city": ["Tokyo", "Osaka"], "n": [1, 2]}),
        "relation": duckdb.sql("SELECT 'Tokyo' AS city, 1 AS n UNION ALL SELECT 'Osaka', 2 ORDER BY n"),
    }
    for ref, data in sources.items():
        engine.add(ref, Source(data=data))
        info = client.result("open", ref=ref)
        assert client.rows(info) == [["Tokyo", 1], ["Osaka", 2]], ref
        assert info["capabilities"]["write"] is True


def test_refusals_closing_and_reloading(engine: Engine) -> None:
    client = Client(engine)
    engine.add("t", Source(data=pa.table({"n": [1, 2, 3]})))
    assert client.error("open", ref="elsewhere.csv")["code"] == "not_allowed"
    info = client.result("open", ref="t")
    table = {"table": info["table"], "revision": info["revision"]}
    assert client.error("save", table=info["table"])["code"] == "save_unsupported"
    target = client.error("export", **table, plan={}, format="csv", target="out.csv")
    assert target["code"] == "not_allowed"
    exported = client.result("export", **table, plan={}, format="csv")
    assert exported["target"] is None and exported["rows"] == 3
    assert exported["data"]["bytes"] == b"n\n1\n2\n3\n"
    written = client.result("write", **table, updates=[{"key": {"rowId": 1}, "column": "n", "value": 20}])
    assert written == {"updated": 1, "edits": {"version": 1, "cells": 1}}
    assert client.events[-1]["event"] == "changed"
    # Every handle of the table sees the written values.
    other = client.result("open", ref="t")
    assert client.rows(other) == [[1], [20], [3]]
    assert client.result("changes", table=other["table"])["edits"] == {"version": 1, "cells": 1}
    # A handle that reloads reads the source as it is, without the written values, which the others keep (§7.6).
    reloaded = client.result("reload", table=info["table"])
    assert reloaded["edits"] == {"version": 0, "cells": 0} and reloaded["revision"] != info["revision"]
    assert client.rows(reloaded) == [[1], [2], [3]]
    assert client.rows(other) == [[1], [20], [3]]
    assert client.result("close", table=info["table"]) is None
    assert client.result("close", table=other["table"]) is None
    assert client.error("info", table=info["table"])["code"] == "table_not_found"
    again = client.result("open", ref="t")
    assert client.rows(again) == [[1], [2], [3]]


def test_cancel_interrupts_a_request(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    path = tmp_path / "big.parquet"
    duckdb.sql(f"COPY (SELECT range AS n FROM range(30000000)) TO '{path}'")
    engine.add("big", Source(path=str(path), format="parquet"))
    info = client.result("open", ref="big")
    plan = {
        "derive": [{"name": "t", "expr": {"fn": "text", "args": [{"col": "n"}]}}],
        "sort": [{"column": "t", "direction": "desc"}],
    }
    answers: list[dict[str, Any]] = []
    request = {"v": 2, "id": 1, "op": "rows", "table": info["table"], "revision": info["revision"], "plan": plan}
    running = threading.Thread(
        target=lambda: answers.append(engine.handle({**request, "start": 0, "end": 10, "columns": ["t"]}))
    )
    running.start()
    time.sleep(0.3)
    assert engine.handle({"v": 2, "id": 2, "op": "cancel", "request": 1}) is None
    running.join(30)
    assert answers[0]["error"]["code"] == "cancelled"
    # The engine answers the next request.
    assert client.rows(info, {}, ["n"])[:2] == [[0], [1]]


def test_files_in_folders_named_like_key_value_have_their_own_columns(engine: Engine, tmp_path: Path) -> None:
    client = Client(engine)
    folder = tmp_path / "region=west" / "year=2024"
    folder.mkdir(parents=True)
    (folder / "sales.csv").write_text("id,item\n1,a\n", "utf-8")
    (folder / "sales.jsonl").write_text('{"id":1,"item":"a"}\n', "utf-8")
    (folder / "sales.json").write_text('[{"id":1,"item":"a"}]', "utf-8")
    parquet = str(folder / "sales.parquet").replace("'", "''")
    duckdb.connect().execute(f"COPY (SELECT 1 AS id, 'a' AS item) TO '{parquet}' (FORMAT parquet)")
    formats = {"sales.csv": "csv", "sales.jsonl": "ndjson", "sales.json": "json", "sales.parquet": "parquet"}
    for name, fmt in formats.items():
        engine.add(name, Source(path=str(folder / name), format=fmt))
        opened = client.result("open", ref=name)
        assert [column["name"] for column in opened["columns"]] == ["id", "item"], name
        assert client.rows(opened) == [[1, "a"]], name


def test_series_null_only_columns_case_colliding_columns_and_sequential_writes(engine: Engine) -> None:
    client = Client(engine)
    for ref, series in (
        ("pandas-series", pandas.Series(["Tokyo", "Osaka"], name="city")),
        ("polars-series", polars.Series("city", ["Tokyo", "Osaka"])),
    ):
        engine.add(ref, Source(data=series))
        opened = client.result("open", ref=ref)
        assert [column["name"] for column in opened["columns"]] == ["city"], ref
        assert client.rows(opened) == [["Tokyo"], ["Osaka"]], ref

    engine.add("nulls", Source(data=pandas.DataFrame({"note": [None, None]})))
    nulls = client.result("open", ref="nulls")
    assert nulls["columns"] == [{"name": "note", "type": "string", "sourceType": '"NULL"'}]
    client.result(
        "write",
        table=nulls["table"],
        revision=nulls["revision"],
        updates=[{"key": {"rowId": 0}, "column": "note", "value": "ok"}],
    )
    assert client.rows(nulls) == [["ok"], [None]]

    engine.add("case", Source(data=pa.table({"a": [1, 2], "A": [10, 20]})))
    case = client.result("open", ref="case")
    assert [column["name"] for column in case["columns"]] == ["a", "A"]
    at = {"table": case["table"], "revision": case["revision"]}
    missing_row_key = client.error("write", **at, updates=[{"key": {"value": 1}, "column": "A", "value": 99}])
    assert missing_row_key["code"] == "invalid_request" and missing_row_key["path"] == "/rowKey"
    staged = client.result(
        "write",
        **at,
        rowKey="a",
        updates=[
            {"key": {"value": 1}, "column": "a", "value": 3, "previous": 1},
            {"key": {"value": 3}, "column": "A", "value": 30, "previous": 10},
        ],
    )
    assert staged == {"updated": 2, "edits": {"version": 1, "cells": 2}}
    assert client.rows(case) == [[3, 30], [2, 20]]
    exported = client.result("export", **at, plan={}, format="csv")
    assert exported["data"]["bytes"] == b"a,A\n3,30\n2,20\n"
    empty_hdr = client.result("export", **at, plan={}, format="csv", headers=["", 'n"1'])
    assert empty_hdr["data"]["bytes"] == b'"","n""1"\n3,30\n2,20\n'


@pytest.mark.parametrize(("unit", "limit"), [("s", 9_223_372_036_854), ("ms", 9_223_372_036_854_775)])
def test_out_of_range_source_timestamps_are_null_per_cell(engine: Engine, unit: str, limit: int) -> None:
    counts = [0, -limit, limit, -limit - 1, limit + 1, -(2**63 - 1), 2**63 - 1]
    column = pa.array(counts, type=pa.int64()).view(pa.timestamp(unit))
    engine.add("time", Source(data=pa.table({"t": column})))
    client = Client(engine)
    opened = client.result("open", ref="time")
    table = engine.handles[opened["table"]]
    assert table.relation is not None
    read = engine.session.database.sql(f'SELECT "t" FROM {table.relation.sql} ORDER BY {table.relation.row_id}')
    assert read.to_arrow_table().column(0).cast(pa.int64()).to_pylist() == [*counts[:3], None, None, *counts[-2:]]


def test_pastes_read_previous_values_once_per_column(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    count = 120
    engine.add("paste", Source(data=pa.table({"x": list(range(count)), "y": [None] * count})))
    client = Client(engine)
    opened = client.result("open", ref="paste")
    reads = []
    read_cells = Edits._read_cells

    def track(self, cursor, relation, index, rows):
        reads.append((index, len(rows)))
        return read_cells(self, cursor, relation, index, rows)

    monkeypatch.setattr(Edits, "_read_cells", track)
    updates = [
        {"key": {"rowId": row}, "column": column, "value": new, "previous": old}
        for row in range(count)
        for column, old, new in [("x", row, row + 1), ("y", None, "yes")]
    ]
    updates.append({"key": {"rowId": 1}, "column": "x", "previous": 2, "value": 8})
    client.result("write", table=opened["table"], revision=opened["revision"], updates=updates)
    assert reads == [(0, count), (1, count)]
    assert client.rows(opened)[:2] == [[1, "yes"], [8, "yes"]]


def test_mixed_in_and_lambda_column_bins(engine: Engine) -> None:
    exact = 2**53
    engine.add("numbers", Source(data=pa.table({"i": [exact, exact + 1, None], "VG_W": [42.0, -11.0, None]})))
    client = Client(engine)
    opened = client.result("open", ref="numbers")
    plan = {
        "derive": [
            {
                "name": "matches",
                "expr": {"fn": "in", "args": [{"col": "i"}, {"lit": str(exact), "type": "bigint"}, {"lit": 0.5}]},
            },
            {"name": "bin", "expr": {"fn": "bin", "args": [{"col": "VG_W"}, {"lit": 10}]}},
        ]
    }
    assert client.rows(opened, plan, ["matches", "bin"]) == [[True, 40.0], [False, -20.0], [None, None]]


def test_wide_decimal_ops_overflow_summarize_corrupt_parquet_and_write_error_order(
    engine: Engine, tmp_path: Path
) -> None:
    from decimal import Decimal
    import zipfile

    client = Client(engine)
    wide = pa.table(
        {
            "big_i": pa.array([100000000000000001], type=pa.int64()),
            "wide_d": pa.array([Decimal("3.00000000000000000000")], type=pa.decimal128(25, 20)),
            "d38_0": pa.array([Decimal("10000000000000000000000000000")], type=pa.decimal128(38, 0)),
            "d38_10": pa.array([Decimal("-5000000000000000000000000000.2500000000")], type=pa.decimal128(38, 10)),
        }
    )
    engine.add("wide", Source(data=wide))
    opened = client.result("open", ref="wide")
    plan = {
        "derive": [
            {"name": "m", "expr": {"fn": "mod", "args": [{"col": "big_i"}, {"col": "wide_d"}]}},
            {"name": "s", "expr": {"fn": "add", "args": [{"col": "d38_0"}, {"col": "d38_10"}]}},
            {"name": "g", "expr": {"fn": "greatest", "args": [{"col": "d38_0"}, {"col": "d38_10"}]}},
        ]
    }
    assert client.rows(opened, plan, ["m", "s", "g"]) == [
        [Decimal("2.00000000000000000000"), Decimal("4999999999999999999999999999.7500000000"), None]
    ]

    # Summarize on [1e308, 1e308, -1e308, -1e308] never returns "NaN" and averages via scaled fallback.
    engine.add("inf_sum", Source(data=pa.table({"f": [1e308, 1e308, -1e308, -1e308]})))
    inf_info = client.result("open", ref="inf_sum")
    summary = client.result(
        "summarize",
        table=inf_info["table"],
        revision=inf_info["revision"],
        plan={},
        ranges=[[0, 4]],
        columns=["f"],
    )
    assert summary == {"count": 4, "numericCount": 4, "sum": 0.0, "min": -1e308, "max": 1e308, "average": 0.0}

    # Corrupt Parquet reports load_failed without internal path leak, and open.read delimiter works.
    bad_pq = tmp_path / "corrupt.parquet"
    bad_pq.write_bytes(b"not a parquet file")
    engine.add("bad_pq", Source(path=str(bad_pq), format="parquet"))
    bad_err = client.error("open", ref="bad_pq")
    assert bad_err["code"] == "load_failed"

    semi_csv = tmp_path / "semi.csv"
    semi_csv.write_text("a;b\n1;2\n", "utf-8")
    engine.add("semi", Source(path=str(semi_csv), format="csv"))
    semi_info = client.result("open", ref="semi", read={"delimiter": ";"})
    assert [c["name"] for c in semi_info["columns"]] == ["a", "b"]
    assert client.rows(semi_info) == [[1, 2]]

    # Oversized workbook XML is rejected as load_failed rather than reading unbounded memory.
    bomb_xlsx = tmp_path / "bomb.xlsx"
    with zipfile.ZipFile(bomb_xlsx, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("xl/workbook.xml", b"<workbook>" + b" " * (4 * 1024 * 1024) + b"</workbook>")
    engine.add("bomb", Source(path=str(bomb_xlsx), format="xlsx"))
    assert client.error("open", ref="bomb")["code"] == "load_failed"

    # Mixed edit_conflict on update 0 + invalid_value on update 1 reports edit_conflict first, matching TS/JS.
    engine.add("ord", Source(data=pa.table({"x": [1, 2]})))
    ord_info = client.result("open", ref="ord")
    err = client.error(
        "write",
        table=ord_info["table"],
        revision=ord_info["revision"],
        updates=[
            {"key": {"rowId": 0}, "column": "x", "value": 10, "previous": 999},
            {"key": {"rowId": 1}, "column": "x", "value": "bad"},
        ],
    )
    assert err["code"] == "edit_conflict"
    assert client.error(
        "write",
        table=ord_info["table"],
        revision=ord_info["revision"],
        updates=[{"key": {"rowId": 0}, "column": "x", "value": "1\n"}],
    )["code"] == "invalid_value"
