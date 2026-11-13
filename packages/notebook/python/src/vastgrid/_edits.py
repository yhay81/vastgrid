"""Cell writes, conflict checking and their overlay over a table's source values."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

import duckdb

from ._columns import accept_key_value, holds_duck_value, read_expression, read_value, value_expression
from ._engine_types import Json, Relation, relation_column
from ._errors import EngineError
from ._messages import quoted
from ._session import Running, Session
from ._sql import duckdb_type, quote_identifier
from ._values import is_safe_integer, key_text, same_cell_value

if TYPE_CHECKING:
    from ._table import Table


# The longest text that a message holds (§8.1): `previous` is compared with the whole value up to it.
MESSAGE_TEXT = 1_000_000


def _is_writable(column: Json) -> bool:
    """Whether a column's cells are written (§7.1)."""
    return not column.get("readOnly") and column["type"] not in ("interval", "binary")


def _overlay_aliases(columns: list[Json], row_id_quoted: str) -> tuple[list[str], dict[str, str] | None]:
    used = {row_id_quoted.strip('"').replace('""', '"').lower()}
    aliases: list[str] = []
    collided = False
    next_id = 0
    for column in columns:
        lower = column["name"].lower()
        if lower not in used:
            used.add(lower)
            aliases.append(quote_identifier(column["name"]))
            continue
        collided = True
        while f"vg_c{next_id}" in used:
            next_id += 1
        alias = f"vg_c{next_id}"
        next_id += 1
        used.add(alias)
        aliases.append(quote_identifier(alias))
    if not collided:
        return aliases, None
    return aliases, {column["name"]: aliases[i] for i, column in enumerate(columns)}


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
        key_column: Json | None = None
        if "rowKey" in request:
            key_column = next((column for column in columns if column["name"] == request["rowKey"]), None)
            if key_column is None:
                raise EngineError(
                    "invalid_request",
                    f"The table has no column {quoted(request['rowKey'])}.",
                    path="/rowKey",
                    reason="syntax",
                )
        elif any("value" in update["key"] for update in updates):
            raise EngineError(
                "invalid_request",
                "Keys by value need rowKey, the column of their values (§5.3).",
                path="/rowKey",
                reason="syntax",
            )
        indexes = [
            next((i for i, column in enumerate(columns) if column["name"] == update["column"]), -1)
            for update in updates
        ]
        if not updates:
            return {"updated": 0, "edits": self.state}

        def apply(cursor: duckdb.DuckDBPyConnection) -> Json:
            initial_rows = self._rows_of(cursor, relation, updates, key_column)
            by_column: dict[int, dict[int, Any]] = {}
            staged_keys: dict[int, Any] = {}
            known: dict[int, set[int]] = {}
            for update, index, row in zip(updates, indexes, initial_rows, strict=True):
                if "previous" in update and index >= 0 and row is not None:
                    known.setdefault(index, set()).add(row)
            cached = {index: self._read_cells(cursor, relation, index, rows) for index, rows in known.items()}
            key_index = (
                next((i for i, col in enumerate(columns) if col["name"] == key_column["name"]), -1)
                if key_column is not None
                else -1
            )
            for at, update in enumerate(updates):
                col_index = indexes[at]
                if col_index < 0 or not _is_writable(columns[col_index]):
                    raise EngineError(
                        "read_only",
                        f"The cells of {quoted(update['column'])} are not written (§7.1).",
                        details={"column": update["column"]},
                    )
                column = columns[col_index]
                row = self._row_of_with_staged(
                    cursor, relation, update["key"], initial_rows[at], key_column, staged_keys
                )
                if row is None:
                    raise EngineError("edit_conflict", "No row has this key now.", details={"update": at})
                if not holds_duck_value(update["value"], column):
                    raise EngineError(
                        "invalid_value",
                        f"{quoted(update['value'])} is not a value of {quoted(update['column'])}.",
                        path=f"/updates/{at}/value",
                        reason="type",
                        details={"update": at},
                    )
                if "previous" in update:
                    values = cached.setdefault(col_index, {})
                    if row not in values:
                        # A preceding row-key edit can redirect this update to another row.
                        values.update(self._read_cells(cursor, relation, col_index, {row}))
                    current = values[row]
                    if not same_cell_value(current, update["previous"], column):
                        raise EngineError("edit_conflict", "The cell holds another value now.", details={"update": at})
                cached.setdefault(col_index, {})[row] = update["value"]
                by_column.setdefault(col_index, {})[row] = update["value"]
                if col_index == key_index:
                    staged_keys[row] = update["value"]
            running.check()
            self._store(cursor, relation, by_column)
            for index, cells in by_column.items():
                self.written.setdefault(index, set()).update(cells)
            self.version += 1
            return {"updated": len(updates), "edits": self.state}

        return self.session.run(running, apply)

    def _rows_of(
        self, cursor: duckdb.DuckDBPyConnection, relation: Relation, updates: list[Json], key_column: Json | None
    ) -> list[int | None]:
        """The row ID of each update's key (§5.3) before in-batch updates, or None when no row has it now."""
        row_count = self.table.row_count
        rows: list[int | None] = []
        for update in updates:
            key = update["key"]
            row_id = key.get("rowId")
            rows.append(int(row_id) if "rowId" in key and is_safe_integer(row_id) and 0 <= row_id < row_count else None)
        if key_column is None:
            return rows
        distinct: dict[str, Json] = {}
        for at, update in enumerate(updates):
            key = update["key"]
            if "value" not in key:
                continue
            normalized = accept_key_value(key["value"], key_column)
            if normalized is None:
                continue
            entry = distinct.setdefault(key_text({"value": normalized}), {"value": normalized, "at": []})
            entry["at"].append(at)
        if not distinct:
            return rows
        entries = list(distinct.values())
        params: list[Any] = []
        values = [
            f"({index}, {value_expression(entry['value'], key_column, params)})" for index, entry in enumerate(entries)
        ]
        col_sql = relation_column(relation, key_column["name"])
        found = cursor.execute(
            f"WITH vg_keys(i, v) AS (VALUES {', '.join(values)}) SELECT vg_keys.i, min(r.{relation.row_id}) "
            f"FROM vg_keys JOIN {relation.sql} r ON r.{col_sql} = vg_keys.v "
            "GROUP BY vg_keys.i",
            params,
        ).fetchall()
        for index, row in found:
            if row is None:
                continue
            for at in entries[int(index)]["at"]:
                rows[at] = int(row)
        return rows

    def _row_of_with_staged(
        self,
        cursor: duckdb.DuckDBPyConnection,
        relation: Relation,
        key: Json,
        initial: int | None,
        key_column: Json | None,
        staged_keys: dict[int, Any],
    ) -> int | None:
        if "rowId" in key or key_column is None or not staged_keys:
            return initial
        normalized = accept_key_value(key["value"], key_column)
        if normalized is None:
            return None
        staged_match: int | None = None
        for row_id, value in staged_keys.items():
            if same_cell_value(value, normalized, key_column):
                if staged_match is None or row_id < staged_match:
                    staged_match = row_id
        if initial is not None and initial not in staged_keys:
            return staged_match if staged_match is not None and staged_match < initial else initial
        params: list[Any] = []
        expr = value_expression(normalized, key_column, params)
        excluded = ", ".join(str(r) for r in staged_keys)
        col_sql = relation_column(relation, key_column["name"])
        found = cursor.execute(
            f"SELECT min(r.{relation.row_id}) FROM {relation.sql} r "
            f"WHERE r.{col_sql} = {expr} AND r.{relation.row_id} NOT IN ({excluded})",
            params,
        ).fetchone()
        db_match = None if found is None or found[0] is None else int(found[0])
        if staged_match is None:
            return db_match
        if db_match is None:
            return staged_match
        return min(staged_match, db_match)

    def _read_cells(
        self, cursor: duckdb.DuckDBPyConnection, relation: Relation, index: int, rows: set[int]
    ) -> dict[int, Any]:
        """Reads the previous values of a pasted column in one scan."""
        column = self.table.columns[index]
        col_sql = relation_column(relation, column["name"])
        found = cursor.execute(
            f"SELECT {relation.row_id}, {read_expression(column, col_sql, MESSAGE_TEXT)} FROM {relation.sql} "
            f"WHERE {relation.row_id} IN ({', '.join(str(row) for row in rows)})"
        ).fetchall()
        return {int(row): read_value(column, value)[0] for row, value in found}

    def _store(
        self, cursor: duckdb.DuckDBPyConnection, relation: Relation, by_column: dict[int, dict[int, Any]]
    ) -> None:
        """Stores the values in the tables of their columns, in one transaction, and makes the table read them: through
        a view of the source with the written values over its own, made again when a column is written the first
        time."""
        fresh = [index for index in by_column if index not in self.stores]
        names = {index: quote_identifier(self.session.name("vg_e")) for index in fresh}
        view = quote_identifier(self.session.name("vg_w")) if fresh else None
        source = self.source or relation
        select_sql, aliases_map = self._select(source, {**self.stores, **names}) if view is not None else ("", None)
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
                cursor.execute(f"CREATE VIEW {view} AS {select_sql}")
            cursor.execute("COMMIT")
        except BaseException:
            try:
                cursor.execute("ROLLBACK")
            except duckdb.Error:
                pass
            raise
        self.source = source
        for index, name in names.items():
            self.stores[index] = name
            self.table.objects.insert(0, f"TABLE {name}")
        if view is not None:
            self.table.objects.insert(0, f"VIEW {view}")
            self.table.relation = Relation(view, relation.row_id, relation.rows, aliases_map)

    def _select(self, source: Relation, stores: dict[int, str]) -> tuple[str, dict[str, str] | None]:
        """The query of the source's rows with the written values over its own."""
        aliases, aliases_map = _overlay_aliases(self.table.columns, source.row_id)
        joins: list[str] = []
        outputs: list[str] = []
        for index, column in enumerate(self.table.columns):
            src_col = relation_column(source, column["name"])
            out_col = aliases[index]
            store = stores.get(index)
            if store is None:
                outputs.append(f"s.{src_col}" if src_col == out_col else f"s.{src_col} AS {out_col}")
                continue
            alias = f"e{index}"
            joins.append(f"LEFT JOIN {store} {alias} ON {alias}.id = s.{source.row_id}")
            outputs.append(f"CASE WHEN {alias}.id IS NULL THEN s.{src_col} ELSE {alias}.v END AS {out_col}")
        sql = f"SELECT {', '.join([*outputs, f's.{source.row_id}'])} FROM {source.sql} s {' '.join(joins)}"
        return sql, aliases_map
