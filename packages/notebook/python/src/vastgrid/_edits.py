"""Cell writes, conflict checking and their overlay over a table's source values."""

from __future__ import annotations

import math
import re
import threading
from typing import TYPE_CHECKING, Any

import duckdb

from ._columns import read_expression, read_value, value_expression
from ._engine_types import Json, Relation
from ._errors import EngineError
from ._hash import canonical_json
from ._json import is_safe_integer
from ._messages import quoted
from ._session import Running, Session
from ._sql import duckdb_type, quote_identifier
from ._values import float_of, is_value_of

if TYPE_CHECKING:
    from ._table import Table


# The longest text that a message holds (§8.1): `previous` is compared with the whole value up to it.
MESSAGE_TEXT = 1_000_000


def key_text(key: Json) -> str:
    """A row key as text, the same for keys of the same row (`keyText` of vastgrid-spec)."""
    if "rowId" in key:
        return canonical_json({"rowId": key["rowId"]})
    value = key["value"]
    if isinstance(value, str) and re.fullmatch(r"-?(0|[1-9][0-9]*)", value) and abs(int(value)) <= 2**53 - 1:
        return canonical_json({"value": int(value)})
    return canonical_json({"value": value})


def _whole(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else None
    if isinstance(value, str) and re.fullmatch(r"-?[0-9]+", value.strip()):
        return int(value)
    return None


def same_cell_value(a: Any, b: Any, column: Json) -> bool:
    """Whether two values of a column are the same cell value (`sameCellValue` of vastgrid-spec)."""
    if a is None or b is None:
        return a is b
    kind = column["type"]
    if kind in ("integer", "bigint"):
        x, y = _whole(a), _whole(b)
        return x is not None and x == y
    if kind == "float":
        x, y = float_of(a), float_of(b)
        return math.isnan(y) if math.isnan(x) else x == y
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def _is_writable(column: Json) -> bool:
    """Whether a column's cells are written (§7.1)."""
    return not column.get("readOnly") and column["type"] not in ("interval", "binary")


class Edits:
    """The cells written into one table (§7.2): kept apart from the source, in a table for each written column, and
    read through a view that puts them over the source's values, so that every request sees them."""

    def __init__(self, session: Session, table: Table) -> None:
        self.session = session
        self.table = table
        # The edits version (§8.2): incremented by every write that changed cells.
        self.version = 0
        self.written: dict[int, set[int]] = {}
        self.stores: dict[int, str] = {}
        self.source: Relation | None = None
        self.lock = threading.Lock()

    @property
    def state(self) -> Json:
        return {"version": self.version, "cells": sum(len(rows) for rows in self.written.values())}

    def write(self, request: Json, running: Running) -> Json:
        """Writes cells (§7.2): every update or none."""
        with self.lock:
            return self._apply(request, running)

    def _apply(self, request: Json, running: Running) -> Json:
        table = self.table
        relation = table.relation
        assert relation is not None
        updates: list[Json] = request["updates"]
        columns = table.columns
        key_column = None
        if "rowKey" in request:
            key_column = next((column for column in columns if column["name"] == request["rowKey"]), None)
            if key_column is None:
                raise EngineError(
                    "invalid_request",
                    f"The table has no column {quoted(request['rowKey'])}.",
                    path="/rowKey",
                    reason="syntax",
                )
        indexes: list[int] = []
        for at, update in enumerate(updates):
            index = next((i for i, column in enumerate(columns) if column["name"] == update["column"]), -1)
            if index < 0 or not _is_writable(columns[index]):
                raise EngineError(
                    "read_only",
                    f"The cells of {quoted(update['column'])} are not written (§7.1).",
                    details={"column": update["column"]},
                )
            if not is_value_of(update["value"], columns[index]):
                raise EngineError(
                    "invalid_value",
                    f"{quoted(update['value'])} is not a value of {quoted(update['column'])}.",
                    path=f"/updates/{at}/value",
                    reason="type",
                    details={"update": at},
                )
            indexes.append(index)
        if not updates:
            return {"updated": 0, "edits": self.state}

        def apply(cursor: duckdb.DuckDBPyConnection) -> Json:
            rows = self._rows_of(cursor, relation, updates, key_column)
            for at, row in enumerate(rows):
                if row is None:
                    raise EngineError("edit_conflict", "No row has this key now.", details={"update": at})
            self._check_source_range(cursor, updates, indexes)
            self._check_previous(cursor, relation, updates, indexes, rows)
            running.check()
            # The last update of a cell is the one that stays, as when they are applied in order.
            by_column: dict[int, dict[int, Any]] = {}
            for at, update in enumerate(updates):
                by_column.setdefault(indexes[at], {})[rows[at]] = update["value"]
            self._store(cursor, relation, by_column)
            for index, cells in by_column.items():
                self.written.setdefault(index, set()).update(cells)
            self.version += 1
            return {"updated": len(updates), "edits": self.state}

        return self.session.run(running, apply)

    def _rows_of(
        self, cursor: duckdb.DuckDBPyConnection, relation: Relation, updates: list[Json], key_column: Json | None
    ) -> list[int | None]:
        """The row ID of each update's key (§5.3), or None when no row has it now."""
        row_count = self.table.row_count
        rows: list[int | None] = []
        for update in updates:
            key = update["key"]
            row_id = key.get("rowId")
            rows.append(int(row_id) if "rowId" in key and is_safe_integer(row_id) and row_id < row_count else None)
        if key_column is None:
            return rows
        # Values are looked up once each; the first row with a value is the one its key names.
        distinct: dict[str, Json] = {}
        for at, update in enumerate(updates):
            key = update["key"]
            if "value" not in key:
                continue
            entry = distinct.setdefault(key_text(key), {"value": key["value"], "at": []})
            entry["at"].append(at)
        if not distinct:
            return rows
        entries = list(distinct.values())
        params: list[Any] = []
        values = [
            f"({index}, {value_expression(entry['value'], key_column, params)})" for index, entry in enumerate(entries)
        ]
        found = cursor.execute(
            f"WITH vg_keys(i, v) AS (VALUES {', '.join(values)}) SELECT vg_keys.i, min(r.{relation.row_id}) "
            f"FROM vg_keys JOIN {relation.sql} r ON r.{quote_identifier(key_column['name'])} = vg_keys.v "
            "GROUP BY vg_keys.i",
            params,
        ).fetchall()
        for index, row in found:
            if row is None:
                continue
            for at in entries[int(index)]["at"]:
                rows[at] = int(row)
        return rows

    def _check_source_range(self, cursor: duckdb.DuckDBPyConnection, updates: list[Json], indexes: list[int]) -> None:
        """Fails with `invalid_value` for a timestamp in nanoseconds that DuckDB does not hold: it keeps the ends of
        the 64-bit range for its infinities, a narrower range than §2.2 allows."""
        params: list[Any] = []
        tests = []
        for at, update in enumerate(updates):
            column = self.table.columns[indexes[at]]
            if update["value"] is None or column["type"] != "timestamp" or column.get("unit") != "ns":
                continue
            tests.append(f"({at}, try({value_expression(update['value'], column, params)}) IS NULL)")
        if not tests:
            return
        found = cursor.execute(
            f"SELECT min(i) FROM (VALUES {', '.join(tests)}) t(i, failed) WHERE failed", params
        ).fetchone()
        if found is None or found[0] is None:
            return
        at = int(found[0])
        raise EngineError(
            "invalid_value",
            f"{quoted(updates[at]['value'])} is beyond the timestamps DuckDB holds.",
            path=f"/updates/{at}/value",
            reason="type",
            details={"update": at},
        )

    def _check_previous(
        self,
        cursor: duckdb.DuckDBPyConnection,
        relation: Relation,
        updates: list[Json],
        indexes: list[int],
        rows: list[int | None],
    ) -> None:
        """Fails with `edit_conflict` when a cell holds another value than its update's `previous` (§7.2)."""
        by_column: dict[int, list[int]] = {}
        for at, update in enumerate(updates):
            if "previous" in update:
                by_column.setdefault(indexes[at], []).append(at)
        for index, ats in by_column.items():
            column = self.table.columns[index]
            ids = sorted({rows[at] for at in ats})
            read = cursor.execute(
                f"SELECT {relation.row_id}, "
                f"{read_expression(column, quote_identifier(column['name']), MESSAGE_TEXT)} FROM {relation.sql} "
                f"WHERE {relation.row_id} IN ({', '.join(str(row) for row in ids)})"
            ).fetchall()
            now = {int(row): read_value(column, value)[0] for row, value in read}
            for at in ats:
                if not same_cell_value(now.get(rows[at]), updates[at]["previous"], column):
                    raise EngineError("edit_conflict", "The cell holds another value now.", details={"update": at})

    def _store(
        self, cursor: duckdb.DuckDBPyConnection, relation: Relation, by_column: dict[int, dict[int, Any]]
    ) -> None:
        """Stores the values in the tables of their columns, in one transaction, and makes the table read them: through
        a view of the source with the written values over its own, made again when a column is written the first
        time."""
        fresh = [index for index in by_column if index not in self.stores]
        names = {index: quote_identifier(self.session.name("vg_e")) for index in fresh}
        view = quote_identifier(self.session.name("vg_w")) if fresh else None
        if self.source is None:
            self.source = relation
        cursor.execute("BEGIN TRANSACTION")
        try:
            for index, name in names.items():
                value_type = duckdb_type(self.table.columns[index])
                cursor.execute(f"CREATE TABLE {name} (id BIGINT PRIMARY KEY, v {value_type})")
            for index, cells in by_column.items():
                column = self.table.columns[index]
                params: list[Any] = []
                values = [f"({row}, {value_expression(value, column, params)})" for row, value in cells.items()]
                store = self.stores.get(index) or names[index]
                cursor.execute(f"INSERT OR REPLACE INTO {store} VALUES {', '.join(values)}", params)
            if view is not None:
                cursor.execute(f"CREATE VIEW {view} AS {self._select({**self.stores, **names})}")
            cursor.execute("COMMIT")
        except BaseException:
            try:
                cursor.execute("ROLLBACK")
            except duckdb.Error:
                pass
            raise
        for index, name in names.items():
            self.stores[index] = name
            self.table.objects.insert(0, f"TABLE {name}")
        if view is not None:
            self.table.objects.insert(0, f"VIEW {view}")
            self.table.relation = Relation(view, relation.row_id, relation.rows)

    def _select(self, stores: dict[int, str]) -> str:
        """The query of the source's rows with the written values over its own."""
        source = self.source
        assert source is not None
        joins: list[str] = []
        outputs: list[str] = []
        for index, column in enumerate(self.table.columns):
            name = quote_identifier(column["name"])
            store = stores.get(index)
            if store is None:
                outputs.append(f"s.{name}")
                continue
            alias = f"e{index}"
            joins.append(f"LEFT JOIN {store} {alias} ON {alias}.id = s.{source.row_id}")
            outputs.append(f"CASE WHEN {alias}.id IS NULL THEN s.{name} ELSE {alias}.v END AS {name}")
        return f"SELECT {', '.join([*outputs, f's.{source.row_id}'])} FROM {source.sql} s {' '.join(joins)}"
