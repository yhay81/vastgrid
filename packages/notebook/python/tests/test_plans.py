"""The plan corpus (docs/spec.md §10, packages/spec/conformance/plans) on DuckDB, as
packages/sql/test/conformance.test.ts runs it: tables of typed JSON, then each case's plan checked, compiled, counted
and read back as typed JSON (§2.2), compared as packages/spec/src/conformance.ts compares results."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import duckdb
import pytest

from vastgrid._calendar import timestamp_text
from vastgrid._check import check_plan
from vastgrid._plan import PlanError, SpecError
from vastgrid._sql import (
    SqlRead,
    SqlSource,
    compile_view,
    count_query,
    duckdb_type,
    float_param,
    pivot_query,
    quote_identifier,
    rows_query,
    text_sql,
)
from vastgrid._values import fround, is_number, js_float, js_string, json_text, same_type, type_name, value_of_text

PLANS = Path(__file__).resolve().parents[4] / "packages" / "spec" / "conformance" / "plans"
FILES = {path.name: json.loads(path.read_text("utf-8")) for path in sorted(PLANS.glob("*.json"))}
CASES = [(name, case) for name, file in FILES.items() for case in file["cases"]]

ROW_ID = "vg_corpus_row"
"""The column of row IDs in the tables of the corpus: the position of each row."""

FLOAT_TOKENS = ("NaN", "Infinity", "-Infinity")


def _input(value: Any, column: dict[str, Any], params: list[Any]) -> str:
    """A typed JSON value (§2.2) as SQL, with its parameter."""
    type = duckdb_type(column)
    if value is None:
        return f"CAST(NULL AS {type})"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if column["type"] == "float" and isinstance(value, str):
        assert value in FLOAT_TOKENS, f"{value} is not a float."
        return f"CAST('{value}' AS {type})"
    if is_number(value) and column["type"] == "integer":
        params.append(value)
        return f"CAST(${len(params)} AS {type})"
    params.append(float_param(value) if is_number(value) and column["type"] == "float" else js_string(value))
    if column["type"] == "binary":
        return f"from_base64(CAST(${len(params)} AS VARCHAR))"
    return f"CAST(CAST(${len(params)} AS VARCHAR) AS {type})"


def create_table(connection: duckdb.DuckDBPyConnection, name: str, table: dict[str, Any]) -> None:
    columns = [f"{quote_identifier(column['name'])} {duckdb_type(column)}" for column in table["columns"]]
    connection.execute(f"CREATE TABLE {quote_identifier(name)} ({', '.join(columns)}, {ROW_ID} BIGINT)")
    for index, row in enumerate(table["rows"]):
        params: list[Any] = []
        values = [_input(value, table["columns"][column], params) for column, value in enumerate(row)]
        connection.execute(f"INSERT INTO {quote_identifier(name)} VALUES ({', '.join([*values, str(index)])})", params)


def output(column: dict[str, Any], sql: str) -> str:
    """Reads exact numbers, dates and times as their text, which is how JSON writes them (§2.2). Strings get a leading
    "." that `json_of` removes, as in the TypeScript test."""
    if column["type"] == "timestamp" and column.get("unit") == "ns":
        return f"epoch_ns({sql})"
    kind = column["type"]
    if kind == "string":
        return f"('.' || {sql})"
    if kind == "decimal":
        return text_sql(sql, column)
    if kind in ("bigint", "date", "time", "timestamp", "timestamptz", "interval", "uuid"):
        return f"CAST({sql} AS VARCHAR)"
    if kind == "binary":
        return f"to_base64({sql})"
    return sql


def json_of(value: Any, column: dict[str, Any]) -> Any:
    if value is None:
        return None
    if column["type"] == "timestamp" and column.get("unit") == "ns":
        return timestamp_text(int(value), "ns")
    kind = column["type"]
    if kind == "bigint":
        return value_of_text(js_string(value), column)
    if kind == "integer":
        return value
    if kind == "float":
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if kind == "boolean":
        return bool(value)
    if kind == "string":
        return value[1:]
    return js_string(value)


def answer(connection: duckdb.DuckDBPyConnection, file: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    table = file["tables"][case["table"]]
    try:
        plan = check_plan(case["plan"], table["columns"])
        source = SqlSource(quote_identifier(case["table"]), ROW_ID)
        combinations = None
        if plan.aggregate is not None and plan.aggregate.pivot is not None:
            query = pivot_query(plan, source)
            rows = connection.execute(query.sql, query.params).fetchall()
            combinations = [[None if value is None else js_string(value) for value in row] for row in rows]
        view = compile_view(plan, source, combinations)
        count = count_query(view)
        row_count = int(connection.execute(count.sql, count.params).fetchone()[0])
        read = case.get("read") or {}
        names = read["columns"] if read.get("columns") is not None else [column["name"] for column in view.columns]
        columns = [next((column for column in view.columns if column["name"] == name), None) for name in names]
        start = read["start"] if read.get("start") is not None else 0
        end = read["end"] if read.get("end") is not None else max(start, row_count)
        query = rows_query(view, SqlRead(start, end, names), output)
        rows = connection.execute(query.sql, query.params).fetchall()
        return {
            "result": {
                "columns": columns,
                "rowCount": row_count,
                "rows": [[json_of(row[index], column) for index, column in enumerate(columns)] for row in rows],
                "rowIds": [int(row[len(columns)]) for row in rows] if view.row_ids else None,
            }
        }
    except PlanError as error:
        return {"error": {"code": error.code, "reason": error.reason, "path": error.path}}
    except SpecError as error:
        return {"error": {"code": error.code}}


def _float_of(value: Any) -> float | None:
    if is_number(value):
        return js_float(value)
    return (
        {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}.get(value) if isinstance(value, str) else None
    )


def _strict_equal(a: Any, b: Any) -> bool:
    """`a === b` of JSON values."""
    if is_number(a) and is_number(b):
        return js_float(a) == js_float(b)
    return type(a) is type(b) and a == b


def same_value(expected: Any, actual: Any, type: dict[str, Any], tolerance: float = 0) -> bool:
    """Whether two values of a type are the same for conformance: floats by value (−0.0 equals 0.0, NaN equals NaN,
    and 32-bit floats are rounded to 32 bits first) within a relative `tolerance`, and other values by their JSON
    (bigints written as numbers or digits alike)."""
    if expected is None or actual is None:
        return expected is None and actual is None
    if type["type"] == "float":
        a = _float_of(expected)
        b = _float_of(actual)
        if a is None or b is None:
            return False
        if type.get("bits") == 32:
            a, b = fround(a), fround(b)
        if math.isnan(a) or math.isnan(b):
            return math.isnan(a) and math.isnan(b)
        if a == b:
            return True
        if not math.isfinite(a) or not math.isfinite(b):
            return False
        return abs(a - b) <= tolerance * max(abs(a), abs(b))
    if type["type"] in ("integer", "bigint"):
        return js_string(expected) == js_string(actual)
    return _strict_equal(expected, actual)


def compare_result(expect: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """The differences between what a case expects and what the engine answered; empty when it conforms."""
    problems: list[str] = []
    if expect.get("columns") is not None:
        names = [column["name"] for column in actual["columns"]]
        wanted = [column["name"] for column in expect["columns"]]
        if names != wanted:
            problems.append(f"columns {json_text(', '.join(names))}, expected {json_text(', '.join(wanted))}")
        else:
            for index, column in enumerate(expect["columns"]):
                got = actual["columns"][index]
                if not same_type(column, got):
                    problems.append(f"column {column['name']} is {type_name(got)}, expected {type_name(column)}")
    if actual["rowCount"] != expect["rowCount"]:
        problems.append(f"rowCount {actual['rowCount']}, expected {expect['rowCount']}")
    if len(actual["rows"]) != len(expect["rows"]):
        problems.append(f"{len(actual['rows'])} rows read, expected {len(expect['rows'])}")
    types = expect.get("columns") or actual["columns"]
    for index, row in enumerate(expect["rows"]):
        if index >= len(actual["rows"]):
            continue
        got = actual["rows"][index]
        for column, value in enumerate(row):
            type = types[column] if column < len(types) else {"name": str(column), "type": "string"}
            found = got[column] if column < len(got) else None
            if not same_value(value, found, type, expect.get("tolerance") or 0):
                problems.append(f"row {index}, column {type['name']}: {json_text(found)}, expected {json_text(value)}")
    if "rowIds" in expect and json_text(expect["rowIds"]) != json_text(actual["rowIds"]):
        problems.append(f"rowIds {json_text(actual['rowIds'])}, expected {json_text(expect['rowIds'])}")
    return problems


@pytest.fixture(scope="module")
def connect():
    """A connection per corpus file, with its tables, in a session whose time zone is UTC."""
    opened: dict[str, duckdb.DuckDBPyConnection] = {}

    def open_file(name: str) -> duckdb.DuckDBPyConnection:
        if name not in opened:
            connection = duckdb.connect(":memory:")
            connection.execute("SET TimeZone = 'UTC'")
            for table_name, table in FILES[name]["tables"].items():
                create_table(connection, table_name, table)
            opened[name] = connection
        return opened[name]

    yield open_file
    for connection in opened.values():
        connection.close()


@pytest.mark.parametrize(("file", "case"), CASES, ids=[case["id"] for _, case in CASES])
def test_case(connect, file: str, case: dict[str, Any]) -> None:
    got = answer(connect(file), FILES[file], case)
    expect = case["expect"]
    if "error" in expect:
        assert "error" in got, f"expected the error {expect['error']['code']}, got rows"
        wanted = expect["error"]
        assert {
            "code": got["error"]["code"],
            "reason": got["error"].get("reason") if "reason" in wanted else None,
            "path": got["error"].get("path") if "path" in wanted else None,
        } == {"code": wanted["code"], "reason": wanted.get("reason"), "path": wanted.get("path")}
        return
    assert "result" in got, f"expected rows, got the error {got.get('error')}"
    assert compare_result(expect, got["result"]) == []
