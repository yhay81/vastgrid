"""DuckDB's types as the logical types of docs/spec.md §2.1, and how the engine reads their values as typed JSON
(§2.2): vastgrid-duckdb's `columns.ts` in Python."""

from __future__ import annotations

import re
from typing import Any

from ._calendar import date_text, parse_timestamp_text, timestamp_text
from ._json import MAX_SAFE_INTEGER, is_number, js_number
from ._sql import FIRST_DATE, LAST_DATE, duckdb_type, quote_identifier, temporal_param, text_sql
from ._values import float_json

_INTEGERS = {"TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT"}
_WIDE = {"UBIGINT", "HUGEINT", "UHUGEINT"}
_TIMESTAMPS: dict[str, dict[str, Any]] = {
    "TIMESTAMP": {"type": "timestamp"},
    "TIMESTAMP_S": {"type": "timestamp", "unit": "s"},
    "TIMESTAMP_MS": {"type": "timestamp", "unit": "ms"},
    "TIMESTAMP_NS": {"type": "timestamp", "unit": "ns"},
    "TIMESTAMP WITH TIME ZONE": {"type": "timestamptz"},
}
_SAME: dict[str, dict[str, Any]] = {
    "BOOLEAN": {"type": "boolean"},
    "BIGINT": {"type": "bigint"},
    "UINTEGER": {"type": "bigint"},
    "FLOAT": {"type": "float", "bits": 32},
    "DOUBLE": {"type": "float"},
    "VARCHAR": {"type": "string"},
    "DATE": {"type": "date"},
    "TIME": {"type": "time"},
    "INTERVAL": {"type": "interval"},
    "UUID": {"type": "uuid"},
    "BLOB": {"type": "binary"},
}
_DECIMAL = re.compile(r"^DECIMAL\((\d+),\s*(\d+)\)$")


def table_column(name: str, sql_type: str) -> dict[str, Any]:
    """The column of the table that a source column is (§2.1): its logical type, with `sourceType`, and `readOnly`
    for the types that are read as their text (lists, structs, maps, unions, JSON, enums, bit strings and others)."""
    upper = sql_type.upper()
    decimal = _DECIMAL.match(upper)
    if decimal:
        kind: dict[str, Any] | None = {"type": "decimal", "precision": int(decimal[1]), "scale": int(decimal[2])}
    elif upper in _WIDE:
        kind = {"type": "decimal", "precision": 38, "scale": 0}
    elif upper in _INTEGERS:
        kind = {"type": "integer"}
    else:
        kind = _TIMESTAMPS.get(upper) or _SAME.get(upper)
    if kind is None:
        return {"name": name, "type": "string", "sourceType": sql_type, "readOnly": True}
    return {"name": name, **kind, "sourceType": sql_type}


def source_expression(name: str, sql_type: str, column: dict[str, Any]) -> str:
    """The SQL that gives a source column as its table column: cast to the DuckDB type of its logical type, so that
    plans mean the same on every source (§3). Values of more than 38 digits read as null (§2.1)."""
    quoted = quote_identifier(name)
    target = duckdb_type(column)
    if column.get("readOnly") and column["type"] == "string":
        return f"CAST({quoted} AS VARCHAR)"
    if sql_type.upper() == target:
        return quoted
    return f"TRY_CAST({quoted} AS {target})" if column["type"] == "decimal" else f"CAST({quoted} AS {target})"


_EPOCHS = {
    "s": "CAST(epoch({}) AS BIGINT)",
    "ms": "epoch_ms({})",
    "us": "epoch_us({})",
    "ns": "epoch_ns({})",
}
"""The SQL of a timestamp's count of its unit since 1970-01-01 00:00:00."""


def read_expression(column: dict[str, Any], sql: str, text_limit: int) -> str:
    """The SQL that reads a value of a column for `read_value`: exact numbers, times as their text forms (§2.4), dates
    as days and timestamps as counts of their unit from 1970-01-01, binary values as base64, and strings with a mark
    in front, `.` for a whole value and `+` for one cut at `text_limit` code points. Values that are not dates or
    timestamps of §2.2 (`infinity`, and dates beyond the first and the last) read as null (§12)."""
    kind = column["type"]
    if kind in ("boolean", "integer", "bigint", "float"):
        return sql
    if kind == "string":
        return f"(CASE WHEN length({sql}) > {text_limit} THEN '+' || left({sql}, {text_limit}) ELSE '.' || {sql} END)"
    if kind == "date":
        within = f"{sql} BETWEEN {FIRST_DATE} AND {LAST_DATE}"
        return f"(CASE WHEN isfinite({sql}) AND {within} THEN {sql} - DATE '1970-01-01' END)"
    if kind == "timestamp":
        return f"(CASE WHEN isfinite({sql}) THEN {_EPOCHS[column.get('unit') or 'us'].format(sql)} END)"
    if kind == "timestamptz":
        return f"(CASE WHEN isfinite({sql}) THEN epoch_us({sql}) END)"
    if kind == "time":
        return f"(CASE WHEN {sql} < TIME '24:00:00' THEN CAST({sql} AS VARCHAR) END)"
    if kind == "binary":
        return f"to_base64({sql})"
    return text_sql(sql, column)


def read_value(column: dict[str, Any], value: Any) -> tuple[Any, bool]:
    """A value that `read_expression` read, as typed JSON (§2.2), and whether it is a string cut at the limit."""
    if value is None:
        return None, False
    kind = column["type"]
    if kind in ("date", "timestamp", "timestamptz"):
        return _temporal_json(column, int(value)), False
    if kind == "boolean":
        return bool(value), False
    if kind == "integer":
        return int(value), False
    if kind == "bigint":
        number = int(value)
        return (number if abs(number) <= MAX_SAFE_INTEGER else str(number)), False
    if kind == "float":
        return float_json(float(value)), False
    if kind == "string":
        text = str(value)
        return text[1:], text[0] == "+"
    return str(value), False


def _temporal_json(column: dict[str, Any], count: int) -> str | None:
    """The text of a date or a timestamp (§2.2) from its count, or None for one beyond the dates."""
    try:
        if column["type"] == "date":
            return date_text(count)
        if column["type"] == "timestamptz":
            return timestamp_text(count, "us") + "+00"
        return timestamp_text(count, column.get("unit") or "us")
    except ValueError:
        return None


def value_expression(value: Any, column: dict[str, Any], params: list[Any]) -> str:
    """The SQL of a typed JSON value of a column (§2.2), with its parameters: numbers as text, which DuckDB reads
    back exactly."""
    target = duckdb_type(column)
    if value is None:
        return f"CAST(NULL AS {target})"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    params.append(js_number(value) if is_number(value) else str(value))
    at = len(params)
    if column["type"] == "binary":
        return f"from_base64(CAST(${at} AS VARCHAR))"
    # DuckDB's VARCHAR cast overflows near the TIMESTAMP_NS limits: give it the exact count.
    if column["type"] == "timestamp" and column.get("unit") == "ns":
        params[-1] = str(parse_timestamp_text(str(value), "ns"))
        return f"make_timestamp_ns(CAST(${at} AS BIGINT))"
    if column["type"] in ("date", "timestamp", "timestamptz"):
        params[-1] = temporal_param(str(value))
    return f"CAST(CAST(${at} AS VARCHAR) AS {target})"
