"""Cached views and the row, locate, summary and find requests that read them."""

from __future__ import annotations

import dataclasses
import math
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import duckdb

from ._block import encode_block
from ._capabilities import CAPABILITIES
from ._check import check_plan, plan_options
from ._columns import accept_key_value, read_expression, read_value, value_expression
from ._engine_types import Json, Relation
from ._errors import EngineError
from ._hash import canonical_json, normalize_plan, plan_hash
from ._messages import quoted
from ._session import Running, Session
from ._sql import SqlSource, SqlView, compile_view, pivot_query, quote_identifier, text_sql, view_column
from ._table import Table
from ._values import float_json
from ._view_export import write_export

_NUMERIC = {"integer", "bigint", "decimal", "float"}


@dataclass
class View:
    """A plan's view of a table (§4.2), as SQL (`vastgrid-sql`), with what `rows` and the other requests read."""

    plan: Any
    sql: SqlView
    positional: bool
    row_count: int
    hash: str
    position: str
    objects: list[str] = field(default_factory=list)
    users: int = 0


def _free_name(base: str, columns: list[Json]) -> str:
    """A name that no column of the view has, for a column that a query adds."""
    names = {column["name"].lower() for column in columns}
    name = base
    while name in names:
        name += "_"
    return quote_identifier(name)


def _columns_of(view: View, names: list[str]) -> list[Json]:
    columns = []
    for index, name in enumerate(names):
        column = next((item for item in view.sql.columns if item["name"] == name), None)
        if column is None:
            raise EngineError(
                "invalid_request", f"The view has no column {quoted(name)}.", path=f"/columns/{index}", reason="syntax"
            )
        columns.append(column)
    return columns


class Views:
    """The views of the open tables, kept by table, relation, edits version and plan; the least recently used beyond
    `max_views` are dropped once no request reads them."""

    def __init__(self, session: Session, text_limit: int, max_views: int = 8) -> None:
        self.session = session
        self.text_limit = text_limit
        self.max_views = max_views
        self.cache: OrderedDict[tuple[int, str], View] = OrderedDict()
        self.lock = threading.Lock()
        self.builds = threading.Lock()

    def use(self, table: Table, request: Json, running: Running, read: Callable[[View], Any]) -> Any:
        relation = table.relation
        assert relation is not None
        checked = check_plan(request.get("plan"), table.columns, plan_options(CAPABILITIES))
        normal = normalize_plan(checked.plan)
        # Views hold the values of one edits version (§8.3).
        key = (id(table), f"{table.revision}\0{relation.sql}\0{table.edits.version}\0{canonical_json(normal)}")
        view = self._take(key)
        if view is None:
            with self.builds:
                view = self._take(key)
                if view is None:
                    view = self._make(checked, relation, running)
                    view.users = 1
                    with self.lock:
                        self.cache[key] = view
        try:
            return read(view)
        finally:
            with self.lock:
                view.users -= 1
            self._trim()

    def _take(self, key: tuple[int, str]) -> View | None:
        with self.lock:
            view = self.cache.get(key)
            if view is not None:
                view.users += 1
                self.cache.move_to_end(key)
            return view

    def _trim(self) -> None:
        dropped: list[str] = []
        with self.lock:
            idle = [key for key, view in self.cache.items() if view.users == 0]
            while len(self.cache) > self.max_views and idle:
                dropped.extend(self.cache.pop(idle.pop(0)).objects)
        if dropped:
            self.session.drop(dropped)

    def forget(self, table: Table) -> None:
        """Drops the views of a table."""
        dropped: list[str] = []
        with self.lock:
            for key in [key for key in self.cache if key[0] == id(table)]:
                dropped.extend(self.cache.pop(key).objects)
        self.session.drop(dropped)

    def _make(self, plan: Any, relation: Relation, running: Running) -> View:
        source = SqlSource(relation=relation.sql, row_id=relation.row_id, columns=relation.columns)
        combinations = None
        if plan.aggregate is not None and plan.aggregate.pivot is not None:
            query = pivot_query(plan, source)
            found = self.session.run(running, lambda cursor: cursor.execute(query.sql, query.params).fetchall())
            combinations = [[None if value is None else str(value) for value in row] for row in found]
        sql = compile_view(plan, source, combinations)
        positional = plan.where is None and plan.aggregate is None and len(plan.sort) == 0
        view_hash = plan_hash(plan.plan)
        if positional:
            assert sql.row_id is not None
            return View(plan, sql, True, relation.rows, view_hash, sql.row_id)
        position = _free_name("vg_position", sql.columns)
        view = View(plan, sql, False, 0, view_hash, position)
        self._materialize(view, running)
        return view

    def _materialize(self, view: View, running: Running) -> None:
        """Stores the total order once and counts the rows in one pass."""
        name = quote_identifier(self.session.name("vg_order"))
        sql = view.sql
        outputs = [f"{view_column(sql, column['name'])} AS c{index}" for index, column in enumerate(sql.columns)]
        if sql.row_id:
            outputs.append(f"{sql.row_id} AS source_id")
        # A view without columns (a pivot without keys and combinations) still has its rows.
        if not outputs:
            outputs.append("NULL AS vg_none")
        order = f" ORDER BY {', '.join(sql.order)}" if sql.order else ""

        def build(cursor: duckdb.DuckDBPyConnection) -> int:
            cursor.execute(
                f"CREATE TABLE {name} AS {sql.with_} SELECT {', '.join(outputs)} FROM vg_view{order}", sql.params
            )
            return int(cursor.execute(f"SELECT count(*) FROM {name}").fetchone()[0])

        try:
            view.row_count = self.session.run(running, build)
        except BaseException:
            self.session.drop([f"TABLE {name}"])
            raise
        view.objects.append(f"TABLE {name}")
        selected = [f"c{index} AS {view_column(sql, column['name'])}" for index, column in enumerate(sql.columns)]
        if sql.row_id:
            selected.append(f"source_id AS {sql.row_id}")
        selected.append(f"rowid AS {view.position}")
        view.sql = dataclasses.replace(
            sql, with_=f"WITH vg_view AS (SELECT {', '.join(selected)} FROM {name})", params=[], order=[view.position]
        )

    # ----- requests -----

    def rows(self, table: Table, request: Json, running: Running) -> Json:
        return self.use(table, request, running, lambda view: self._rows_of(table, view, request, running))

    def _rows_of(self, table: Table, view: View, request: Json, running: Running) -> Json:
        columns = _columns_of(view, request["columns"])
        start = request["start"]
        end = max(start, min(request["end"], view.row_count))
        limit = request.get("textLimit", self.text_limit)
        rows: list[list[Any]] = []
        row_ids: list[int] | None = [] if view.sql.row_ids else None
        truncated: dict[str, list[int]] = {}
        if end > start:
            outputs = [read_expression(column, view_column(view.sql, column["name"]), limit) for column in columns]
            if view.sql.row_id:
                outputs.append(view.sql.row_id)
            if not outputs:
                outputs.append("NULL")
            params = [*view.sql.params, start, end]
            query = (
                f"{view.sql.with_} SELECT {', '.join(outputs)} FROM vg_view WHERE {view.position} >= "
                f"${len(params) - 1} AND {view.position} < ${len(params)} ORDER BY {view.position}"
            )
            found = self.session.run(running, lambda cursor: cursor.execute(query, params).fetchall())
            for at, record in enumerate(found):
                values = []
                for index, column in enumerate(columns):
                    value, cut = read_value(column, record[index])
                    values.append(value)
                    if cut:
                        truncated.setdefault(column["name"], []).append(at)
                rows.append(values)
                if row_ids is not None:
                    row_ids.append(int(record[len(columns)]))
        result: Json = {
            "view": {
                "hash": view.hash,
                "status": "ready",
                "rowCount": view.row_count,
                "rowCountExact": True,
                "readableRows": view.row_count,
                "columns": view.sql.columns,
                "edits": table.edits.state,
            },
            "start": start,
            "end": start + len(rows),
            "rowIds": row_ids,
            "block": {"bytes": encode_block(columns, rows)},
        }
        if truncated:
            result["truncated"] = truncated
        return result

    def locate(self, table: Table, request: Json, running: Running) -> Json:
        return self.use(table, request, running, lambda view: self._locate_of(table, view, request, running))

    def _locate_of(self, table: Table, view: View, request: Json, running: Running) -> Json:
        keys = request["keys"]
        by_row_id = [(index, key["rowId"]) for index, key in enumerate(keys) if "rowId" in key]
        by_value = [(index, key["value"]) for index, key in enumerate(keys) if "value" in key]
        key_column: Json | None = None
        if "rowKey" in request:
            row_key = request["rowKey"]
            key_column = next((item for item in table.columns if item["name"] == row_key), None)
            if key_column is None:
                raise EngineError(
                    "invalid_request",
                    f"The table has no column {quoted(row_key)}.",
                    path="/rowKey",
                    reason="syntax",
                )
        elif by_value:
            raise EngineError(
                "invalid_request",
                "Keys by value need rowKey, the column of their values (§5.3).",
                path="/rowKey",
                reason="syntax",
            )
        rows: list[int | None] = [None] * len(keys)
        if view.positional:
            for index, value in by_row_id:
                rows[index] = int(value) if value < view.row_count else None
        elif view.sql.row_ids:
            assert view.sql.row_id is not None
            self._positions_of(view, by_row_id, view.sql.row_id, {"type": "bigint"}, rows, running)
        in_view = (
            next((item for item in view.sql.columns if item["name"] == key_column["name"]), None)
            if key_column is not None
            and (
                view.plan.aggregate is None
                or any(item["name"] == key_column["name"] for item in view.plan.aggregate.keys)
            )
            else None
        )
        if in_view is not None and by_value:
            accepted = [
                (index, normalized)
                for index, value in by_value
                if (normalized := accept_key_value(value, in_view)) is not None
            ]
            self._positions_of(view, accepted, view_column(view.sql, in_view["name"]), in_view, rows, running)
        return {"rows": rows}

    def _positions_of(
        self,
        view: View,
        keys: list[tuple[int, Any]],
        sql: str,
        column: Json,
        rows: list[int | None],
        running: Running,
    ) -> None:
        """Puts the first position of each value of a column into `rows`."""
        if not keys:
            return
        params: list[Any] = [*view.sql.params]
        values = [f"({index}, {value_expression(value, column, params)})" for index, value in keys]
        query = (
            f"{view.sql.with_}, vg_keys(i, v) AS (VALUES {', '.join(values)}) SELECT vg_keys.i, "
            f"min(vg_view.{view.position}) FROM vg_keys JOIN vg_view ON vg_view.{sql} = vg_keys.v GROUP BY vg_keys.i"
        )
        for index, found in self.session.run(running, lambda cursor: cursor.execute(query, params).fetchall()):
            rows[int(index)] = None if found is None else int(found)

    def summarize(self, table: Table, request: Json, running: Running) -> Json:
        return self.use(table, request, running, lambda view: self._summarize_of(view, request, running))

    def _summarize_of(self, view: View, request: Json, running: Running) -> Json:
        # Each cell counts once, however the ranges overlap or a column repeats (§8.2).
        columns: list[Json] = []
        for column in _columns_of(view, request["columns"]):
            if not any(column is item for item in columns):
                columns.append(column)
        ranges = request["ranges"]
        empty = {"count": 0, "numericCount": 0, "sum": None, "min": None, "max": None, "average": None}
        if all(end <= start for start, end in ranges):
            return empty
        position = view.position
        # Positions are integers that the request was checked to hold (§8.1), so they are written into the query.
        within = " OR ".join(f"({position} >= {start} AND {position} < {end})" for start, end in ranges)
        aggregates: list[str] = []
        for column in columns:
            sql = view_column(view.sql, column["name"])
            blank = f"({sql} IS NULL OR {sql} = '')" if column["type"] == "string" else f"{sql} IS NULL"
            aggregates.append(f"count(*) FILTER (WHERE NOT {blank})")
            if column["type"] in _NUMERIC:
                number = f"CAST({sql} AS DOUBLE)"
                finite = f"FILTER (WHERE isfinite({number}))"
                aggregates += [
                    f"count(*) {finite}",
                    f"sum({number}) {finite}",
                    f"sum({number} * 5.421010862427522e-20) {finite}",
                    f"min({number}) {finite}",
                    f"max({number}) {finite}",
                ]
        query = f"{view.sql.with_} SELECT {', '.join(aggregates)} FROM vg_view WHERE {within}"
        values = self.session.run(running, lambda cursor: cursor.execute(query, view.sql.params).fetchone())
        at = 0
        count = numeric_count = 0
        total = 0.0
        scaled_total = 0.0
        low = float("inf")
        high = float("-inf")
        for column in columns:
            count += int(values[at])
            at += 1
            if column["type"] not in _NUMERIC:
                continue
            numbers = int(values[at])
            part, scaled_part, least, most = values[at + 1], values[at + 2], values[at + 3], values[at + 4]
            at += 5
            if numbers == 0:
                continue
            numeric_count += numbers
            total += float(part)
            scaled_total += float(scaled_part)
            low = min(low, float(least))
            high = max(high, float(most))
        if numeric_count == 0:
            return {**empty, "count": count}
        if not math.isfinite(total):
            total = scaled_total * 2.0**64
        average = total / numeric_count if math.isfinite(total) else (scaled_total / numeric_count) * 2.0**64
        return {
            "count": count,
            "numericCount": numeric_count,
            "sum": None if math.isnan(total) else float_json(total + 0.0),
            "min": low + 0.0,
            "max": high + 0.0,
            "average": None if math.isnan(average) else float_json(average + 0.0),
        }

    def find(self, table: Table, request: Json, running: Running) -> Json | None:
        return self.use(table, request, running, lambda view: self._find_of(view, request, running))

    def _find_of(self, view: View, request: Json, running: Running) -> Json | None:
        """The first cell after `from` (before it, with −1), row by row and in a row in the order of `columns`, whose
        text form contains the text, wrapping around and ending with `from` itself."""
        columns = _columns_of(view, request["columns"])
        text = request["text"]
        if text == "" or view.row_count == 0:
            return None
        forward = request["direction"] == 1
        sensitive = request.get("caseSensitive") is True
        start = request["from"]
        row = min(start["row"], view.row_count - 1)
        column = start["column"]
        position = view.position
        params = [*view.sql.params, text]
        needle = f"${len(params)}" if sensitive else f"lower(${len(params)})"
        tests = []
        for item in columns:
            value = text_sql(view_column(view.sql, item["name"]), item)
            tests.append(f"coalesce(contains({value if sensitive else f'lower({value})'}, {needle}), false)")
        any_test = f"({' OR '.join(tests)})"

        def flags(cursor: duckdb.DuckDBPyConnection, condition: str, order: str) -> tuple[int, list[bool]] | None:
            query = (
                f"{view.sql.with_} SELECT {position}, {', '.join(tests)} FROM vg_view WHERE {condition} "
                f"ORDER BY {position} {order} LIMIT 1"
            )
            found = cursor.execute(query, params).fetchone()
            return None if found is None else (int(found[0]), [value is True for value in found[1:]])

        def first(matches: list[bool], after: int) -> int:
            if forward:
                return next((index for index, match in enumerate(matches) if match and index > after), -1)
            for index in range(min(after, len(matches)) - 1, -1, -1):
                if matches[index]:
                    return index
            return -1

        def search(cursor: duckdb.DuckDBPyConnection) -> Json | None:
            own = flags(cursor, f"{position} = {row}", "ASC")
            # The cells of the row of `from` after it (before it, with −1).
            if own is not None:
                index = first(own[1], column)
                if index >= 0:
                    return {"row": row, "column": index}
            # Then the other rows, in order, wrapping around at the end.
            if forward:
                found = flags(cursor, f"{position} > {row} AND {any_test}", "ASC") or flags(
                    cursor, f"{position} < {row} AND {any_test}", "ASC"
                )
            else:
                found = flags(cursor, f"{position} < {row} AND {any_test}", "DESC") or flags(
                    cursor, f"{position} > {row} AND {any_test}", "DESC"
                )
            if found is not None:
                matches = found[1]
                index = matches.index(True) if forward else len(matches) - 1 - matches[::-1].index(True)
                return {"row": found[0], "column": index}
            # Last, the cells of the row of `from` up to `from` itself.
            if own is not None:
                if forward:
                    index = next((at for at, match in enumerate(own[1]) if match and at <= column), -1)
                    if index >= 0:
                        return {"row": row, "column": index}
                else:
                    for index in range(len(own[1]) - 1, column - 1, -1):
                        if own[1][index]:
                            return {"row": row, "column": index}
            return None

        return self.session.run(running, search)

    def export(self, table: Table, request: Json, running: Running, file: str) -> int:
        """Writes the whole view of a request (§8.2) into a new file; gives its row count."""

        def write(view: View) -> int:
            names = request.get("columns")
            columns = view.sql.columns if names is None else _columns_of(view, names)
            for member in ("headers", "numberFormats"):
                if member in request and len(request[member]) != len(columns):
                    raise EngineError(
                        "invalid_request",
                        f"{member} has one item per column.",
                        path=f"/{member}",
                        reason="syntax",
                    )
            headers = request.get("headers") or [column["name"] for column in columns]
            write_export(
                self.session, view, request["format"], columns, headers, request.get("numberFormats"), file, running
            )
            return view.row_count

        return self.use(table, request, running, write)
