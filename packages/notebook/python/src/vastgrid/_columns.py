"""DuckDB's types as the logical types of docs/spec.md §2.1, and how the engine reads their values as typed JSON
(§2.2): vastgrid-duckdb's `columns.ts` in Python."""

from __future__ import annotations

import re
from typing import Any

from ._calendar import (
    DATE_INFINITY,
    TIMESTAMP_INFINITY,
    IntervalParts,
    date_text,
    infinity_of,
    interval_text,
    normalize_interval,
    parse_timestamp_text,
    timestamp_text,
    timestamptz_text,
)
from ._sql import FIRST_DATE, LAST_DATE, duckdb_type, float_param, quote_identifier, temporal_param, text_sql
from ._values import MAX_SAFE_INTEGER, float_json, is_number, is_value_of, number_text

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
    '"NULL"': {"type": "string"},
    "SQLNULL": {"type": "string"},
}
_DECIMAL = re.compile(r"^DECIMAL\((\d+),\s*(\d+)\)$")
_DECIMAL_VALUE = re.compile(r"^(-?)([0-9]+)(?:\.([0-9]+))?$")


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


def source_expression(name: str, sql_type: str, column: dict[str, Any], source_sql: str | None = None) -> str:
    """The SQL that gives a source column as its table column: cast to the DuckDB type of its logical type, so that
    plans mean the same on every source (§3). Values of more than 38 digits read as null (§2.1)."""
    quoted = quote_identifier(name) if source_sql is None else source_sql
    target = duckdb_type(column)
    if column.get("readOnly") and column["type"] == "string":
        return f"CAST({quoted} AS VARCHAR)"
    if sql_type.upper() in ("TIMESTAMP_S", "TIMESTAMP_MS"):
        # Even isfinite() widens to microseconds and can throw on valid 64-bit source counts.
        return f"(CASE WHEN TRY_CAST({quoted} AS TIMESTAMP) IS NOT NULL THEN {quoted} END)"
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


def _infinities(sql: str, count: int) -> str:
    """The `WHEN`s of DuckDB's infinities of a date or a timestamp, as their counts (§2.2)."""
    return f"WHEN {sql} = 'infinity' THEN {count} WHEN {sql} = '-infinity' THEN -{count}"


def read_expression(column: dict[str, Any], sql: str, text_limit: int) -> str:
    """The SQL that reads a value of a column for `read_value`: exact numbers, times as their text forms (§2.4), dates
    as days and timestamps as counts of their unit from 1970-01-01, binary values as base64, and strings with a mark
    in front, `.` for a whole value and `+` for one cut at `text_limit` code points. DuckDB's infinities read as the
    counts of §2.2, and its dates beyond the first and the last as null (§12)."""
    kind = column["type"]
    if kind in ("boolean", "integer", "bigint", "float"):
        return sql
    if kind == "string":
        return f"(CASE WHEN length({sql}) > {text_limit} THEN '+' || left({sql}, {text_limit}) ELSE '.' || {sql} END)"
    if kind == "date":
        within = f"{sql} BETWEEN {FIRST_DATE} AND {LAST_DATE}"
        return f"(CASE WHEN {within} THEN {sql} - DATE '1970-01-01' {_infinities(sql, DATE_INFINITY)} END)"
    infinities = _infinities(sql, TIMESTAMP_INFINITY)
    if kind == "timestamp":
        return f"(CASE WHEN isfinite({sql}) THEN {_EPOCHS[column.get('unit') or 'us'].format(sql)} {infinities} END)"
    if kind == "timestamptz":
        return f"(CASE WHEN isfinite({sql}) THEN epoch_us({sql}) {infinities} END)"
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
            return timestamptz_text(count)
        return timestamp_text(count, column.get("unit") or "us")
    except ValueError:
        return None


def holds_duck_value(value: Any, column: dict[str, Any]) -> bool:
    """Whether DuckDB can store a validated value of `column` without overflowing `TIMESTAMP_NS` infinities."""
    if not is_value_of(value, column):
        return False
    if (
        value is not None
        and column["type"] == "timestamp"
        and column.get("unit") == "ns"
        and infinity_of(str(value)) == 0
    ):
        nanos = parse_timestamp_text(str(value), "ns")
        return nanos is not None and -9_223_372_036_854_775_807 < nanos < 9_223_372_036_854_775_807
    return True


def accept_key_value(value: Any, column: dict[str, Any]) -> Any | None:
    """Normalizes a row key's `value` (§5.3, §8.2) for `column` without rounding or cross-type coercion (§3.1), or
    returns None when no value of `column` can equal it."""
    if value is None:
        return None
    if column["type"] == "decimal":
        if not isinstance(value, str):
            return None
        match = _DECIMAL_VALUE.match(value)
        if not match:
            return None
        scale = column.get("scale") or 0
        precision = 38 if column.get("precision") is None else column["precision"]
        fraction = match[3] or ""
        if len(fraction) > scale and fraction[scale:].strip("0"):
            return None
        scaled = fraction[:scale].ljust(scale, "0")
        whole = match[2].lstrip("0") or "0"
        significant = (whole + scaled).lstrip("0")
        if len(significant) > precision:
            return None
        if not significant:
            return f"0.{'0' * scale}" if scale > 0 else "0"
        return f"{match[1]}{whole}.{scaled}" if scale > 0 else f"{match[1]}{whole}"
    if column["type"] == "interval":
        if not isinstance(value, str):
            return None
        parts = normalize_interval(value)
        if parts is None:
            return None
        months, days, nanos = parts
        if not (-2_147_483_648 <= months <= 2_147_483_647) or nanos % 1000 != 0:
            return None
        return interval_text(IntervalParts(months=months, days=days, nanos=nanos))
    return value if holds_duck_value(value, column) else None


def value_expression(value: Any, column: dict[str, Any], params: list[Any]) -> str:
    """The SQL of a typed JSON value of a column (§2.2), with its parameters: numbers as text, which DuckDB reads
    back exactly."""
    target = duckdb_type(column)
    if value is None:
        return f"CAST(NULL AS {target})"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if is_number(value):
        text = float_param(value) if column["type"] == "float" else number_text(value)
    else:
        text = str(value)
    params.append(text)
    at = len(params)
    if column["type"] == "binary":
        return f"from_base64(CAST(${at} AS VARCHAR))"
    # DuckDB's VARCHAR cast overflows near the TIMESTAMP_NS limits: give it the exact count.
    if column["type"] == "timestamp" and column.get("unit") == "ns" and infinity_of(text) == 0:
        params[-1] = str(parse_timestamp_text(text, "ns"))
        return f"make_timestamp_ns(CAST(${at} AS BIGINT))"
    if column["type"] in ("date", "timestamp", "timestamptz"):
        params[-1] = temporal_param(text)
    return f"CAST(CAST(${at} AS VARCHAR) AS {target})"
