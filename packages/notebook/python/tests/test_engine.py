"""The engine's operations beyond the plan corpus (docs/v2-spec.md §8): the requests of the message corpus, the files
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
from vastgrid._messages import ProtocolError, check_request

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
    for name in [*files, "a.parquet", "a.xlsx"]:
        path = tmp_path / name
        engine.add(name, Source(path=str(path), format=name.rsplit(".", 1)[1].replace("jsonl", "ndjson")))
        info = client.result("open", ref=name)
        assert info["status"] == "ready" and info["rowCount"] == 2, name
        assert [column["name"] for column in info["columns"]] == ["city", "n"], name
        assert [row[0] for row in client.rows(info)] == ["Tokyo", "Osaka"], name
        assert info["capabilities"]["save"] is False
        assert info["capabilities"]["export"]["delivery"] == "data"


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
