"""Table sources and loaded relations shared by the notebook engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

Json = dict[str, Any]


@dataclass
class Source:
    """What a table is read from: a file (`path` and its `format`), or a DataFrame-like object (`data`)."""

    data: Any = None
    path: str | None = None
    format: str | None = None
    sheet: str | None = None


@dataclass
class Relation:
    """The view that the engine reads a table from: its quoted name, its column of row IDs and its row count."""

    sql: str
    row_id: str
    rows: int
