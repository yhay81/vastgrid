"""Blocks (docs/spec.md §8.4): rows of typed JSON (§2.2) as an Apache Arrow IPC stream with one schema and one
record batch, written with the Arrow types of §2.1, as vastgrid-spec's `encodeBlock` writes them."""

from __future__ import annotations

import base64
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

import pyarrow as pa

from ._calendar import parse_date_text, parse_interval_text, parse_time_text, parse_timestamp_text
from ._values import is_value_of, type_name

UUID_EXTENSION = (b"ARROW:extension:name", b"arrow.uuid")

_FLOAT_TOKENS = {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}


class BlockValueError(TypeError):
    """A value that cannot be written without loss; the path is relative to the block's rows."""

    reason = "type"

    def __init__(self, path: str, column: dict[str, Any]):
        super().__init__(f"The value at {path} is not a {type_name(column)} value within the ranges of §2.2.")
        self.path = path


def arrow_type(column: dict[str, Any]) -> pa.DataType:
    """The Arrow type of a logical type (§8.4)."""
    kind = column["type"]
    if kind == "boolean":
        return pa.bool_()
    if kind == "integer":
        return pa.int32()
    if kind == "bigint":
        return pa.int64()
    if kind == "decimal":
        return pa.decimal128(column.get("precision", 38), column.get("scale", 0))
    if kind == "float":
        return pa.float32() if column.get("bits") == 32 else pa.float64()
    if kind == "string":
        return pa.string()
    if kind == "date":
        return pa.date32()
    if kind == "time":
        return pa.time64("us")
    if kind == "timestamp":
        return pa.timestamp(column.get("unit", "us"))
    if kind == "timestamptz":
        return pa.timestamp("us", tz="UTC")
    if kind == "interval":
        return pa.month_day_nano_interval()
    if kind == "uuid":
        return pa.binary(16)
    if kind == "binary":
        return pa.binary()
    raise ValueError(f"{kind} is not a logical type.")


def _decimal(value: str) -> Decimal:
    return Decimal(value)


def _float(value: Any) -> float:
    return _FLOAT_TOKENS[value] if isinstance(value, str) else float(value)


def _count(column: dict[str, Any], text: str) -> int:
    kind = column["type"]
    if kind == "date":
        return parse_date_text(text)
    if kind == "time":
        return parse_time_text(text)
    if kind == "timestamptz":
        return parse_timestamp_text(text[:-3], "us")
    return parse_timestamp_text(text, column.get("unit", "us"))


def _interval(text: str) -> pa.MonthDayNano:
    parts = parse_interval_text(text)
    return pa.MonthDayNano([parts.months, parts.days, parts.nanos])


_CONVERT = {
    "boolean": None,
    "integer": None,
    "bigint": int,
    "decimal": _decimal,
    "float": _float,
    "string": None,
    "date": None,
    "time": None,
    "timestamp": None,
    "timestamptz": None,
    "interval": _interval,
    "uuid": lambda value: bytes.fromhex(value.replace("-", "")),
    "binary": base64.b64decode,
}


def _array(column: dict[str, Any], values: list[Any]) -> pa.Array:
    kind = column["type"]
    if kind in ("date", "time", "timestamp", "timestamptz"):
        counts = [None if value is None else _count(column, value) for value in values]
        storage = pa.array(counts, pa.int32() if kind == "date" else pa.int64())
        return storage.view(arrow_type(column))
    convert = _CONVERT[kind]
    if convert is not None:
        values = [None if value is None else convert(value) for value in values]
    return pa.array(values, arrow_type(column))


def schema_of(columns: Sequence[dict[str, Any]]) -> pa.Schema:
    return pa.schema(
        [
            pa.field(
                column["name"],
                arrow_type(column),
                nullable=True,
                metadata=dict([UUID_EXTENSION]) if column["type"] == "uuid" else None,
            )
            for column in columns
        ]
    )


def encode_block(columns: Sequence[dict[str, Any]], rows: Sequence[Sequence[Any]]) -> bytes:
    """Writes rows (typed JSON, §2.2) of columns as a block (§8.4); a value outside §2.2 raises `BlockValueError`."""
    arrays = []
    for index, column in enumerate(columns):
        values = []
        for at, row in enumerate(rows):
            value = row[index]
            if not is_value_of(value, column):
                raise BlockValueError(f"/rows/{at}/{index}", column)
            values.append(value)
        arrays.append(_array(column, values))
    schema = schema_of(columns)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, schema) as writer:
        # A block without columns has its schema only: the answer gives its positions (§8.4).
        if columns:
            writer.write_batch(pa.record_batch(arrays, schema=schema))
    return sink.getvalue().to_pybytes()
