"""Table sources and loaded relations shared by the notebook engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._sql import quote_identifier

Json = dict[str, Any]


@dataclass
class Source:
    """What a table is read from: a file (`path` and its `format`), or a DataFrame-like object (`data`)."""

    data: Any = None
    path: str | None = None
    format: str | None = None
    sheet: str | None = None
    header_row: int | None = None
    delimiter: str | None = None
    keep_empty_rows: bool | None = None
    keep_empty_columns: bool | None = None


@dataclass
class Relation:
    """The view that the engine reads a table from: its quoted name, its column of row IDs and its row count."""

    sql: str
    row_id: str
    rows: int
    columns: dict[str, str] | None = None


def relation_column(relation: Relation, name: str) -> str:
    """The quoted SQL identifier of `name` in `relation`."""
    return (relation.columns or {}).get(name) or quote_identifier(name)
