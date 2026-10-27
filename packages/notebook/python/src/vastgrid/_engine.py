"""The engine of the notebook (docs/v2-spec.md §8): tables of DataFrames and files in DuckDB, answered with the
messages of §8.1 as vastgrid-duckdb answers them. It runs in the kernel, so that the grid in the notebook's
page reads tables of any size a row range at a time, and the notebook gets the edited table back.

Every request runs on a cursor of its own (`cancel` interrupts it), so requests run side by side on threads. Writes
run one at a time, and so do builds of views.
"""

from __future__ import annotations

import dataclasses
import itertools
import math
import os
import re
import shutil
import tempfile
import threading
import uuid
import weakref
import zipfile
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any
from xml.etree import ElementTree

import duckdb

from ._block import BlockValueError, encode_block
from ._check import check_plan, plan_options
from ._columns import read_expression, read_value, source_expression, table_column, value_expression
from ._export import check_xlsx_size, delimited_field, write_json, write_xlsx
from ._hash import canonical_json, normalize_plan, plan_hash
from ._json import is_safe_integer
from ._messages import ProtocolError, answer_id, check_request, error_response, quoted
from ._plan import PlanError, SpecError
from ._sql import SqlSource, SqlView, compile_view, count_query, duckdb_type, pivot_query, quote_identifier, text_sql
from ._values import float_json, float_of, is_value_of

Json = dict[str, Any]

EXPORT_FORMATS = ["csv", "tsv", "parquet", "json", "xlsx"]

CAPABILITIES: Json = {
    "plan": {
        "derive": True,
        "where": True,
        "aggregate": True,
        "pivot": True,
        "having": True,
        "sort": True,
        "search": True,
    },
    "summarize": True,
    "find": True,
    "locate": True,
    "write": True,
    # The notebook has the edited table as a DataFrame (`Grid.to_pandas`, …), or exports it: nothing is saved
    # into a file in its place.
    "save": False,
    "export": {"formats": EXPORT_FORMATS, "delivery": "data"},
    "preview": False,
    "partialViews": False,
    "changes": "push",
}

FILE_FORMATS = {
    ".csv": "csv",
    ".tsv": "tsv",
    ".tab": "tsv",
    ".txt": "csv",
    ".parquet": "parquet",
    ".pq": "parquet",
    ".json": "json",
    ".ndjson": "ndjson",
    ".jsonl": "ndjson",
    ".xlsx": "xlsx",
}

# The longest text that a message holds (§8.1): `previous` is compared with the whole value up to it.
MESSAGE_TEXT = 1_000_000
_NUMERIC = {"integer", "bigint", "decimal", "float"}


class EngineError(Exception):
    """An error of §8.7 that the engine answers a request with, with its `path`, `reason` or `details`."""

    def __init__(self, code: str, message: str, **members: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.members = members


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


def _cancelled() -> EngineError:
    return EngineError("cancelled", "The request was cancelled.")


def _revision_changed() -> EngineError:
    return EngineError("revision_changed", "The table has another revision: read its TableInfo again.")


def file_format(path: str) -> str | None:
    """The format of a file by its extension (`.csv.gz` as `.csv`), or None for one the engine does not read."""
    name = path.lower()
    for suffix in (".gz", ".zst"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return FILE_FORMATS.get(os.path.splitext(name)[1])


def workbook_sheets(path: str) -> list[Json]:
    """The sheets of a workbook in their order (§8.2 `sheets`), read from `xl/workbook.xml`."""
    main = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    sheets: list[Json] = []
    for sheet in root.iter(f"{main}sheet"):
        info: Json = {"name": sheet.get("name", "")}
        if sheet.get("state") in ("hidden", "veryHidden"):
            info["hidden"] = True
        sheets.append(info)
    return sheets


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


class Running:
    """A request that runs: its cursor, which `cancel` interrupts."""

    def __init__(self) -> None:
        self.cancelled = False
        self.cursors: list[duckdb.DuckDBPyConnection] = []
        self.lock = threading.Lock()

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            for cursor in self.cursors:
                try:
                    cursor.interrupt()
                except duckdb.Error:
                    pass

    def check(self) -> None:
        if self.cancelled:
            raise _cancelled()


def new_database() -> duckdb.DuckDBPyConnection:
    """A DuckDB database in memory, which spills what does not fit into a folder of its own (DuckDB's default is a
    folder `.tmp` in the working directory, the notebook's)."""
    folder = tempfile.mkdtemp(prefix="vastgrid-spill-")
    database = duckdb.connect(":memory:", config={"temp_directory": folder})
    weakref.finalize(database, shutil.rmtree, folder, True)
    return database


class Session:
    """The engine's DuckDB database, with a cursor for each query and names for the objects it creates."""

    def __init__(self, database: duckdb.DuckDBPyConnection | None = None) -> None:
        self.database = database or new_database()
        self._names = itertools.count(1)
        self._prefix = uuid.uuid4().hex[:8]
        self.folder = tempfile.mkdtemp(prefix="vastgrid-")

    def name(self, prefix: str) -> str:
        return f"{prefix}_{self._prefix}_{next(self._names)}"

    def run(self, running: Running | None, task: Callable[[duckdb.DuckDBPyConnection], Any]) -> Any:
        """Runs a task on a cursor of its own, which `running.cancel` interrupts."""
        cursor = self.cursor()
        if running is not None:
            with running.lock:
                running.check()
                running.cursors.append(cursor)
        try:
            return task(cursor)
        except duckdb.InterruptException as error:
            raise _cancelled() from error
        finally:
            if running is not None:
                with running.lock:
                    running.cursors.remove(cursor)
            cursor.close()

    def cursor(self) -> duckdb.DuckDBPyConnection:
        """A connection of its own to the database. Timestamps with time zone are read in UTC, as §2.2 writes them."""
        cursor = self.database.cursor()
        cursor.execute("SET TimeZone = 'UTC'")
        return cursor

    def drop(self, objects: list[str]) -> None:
        cursor = self.database.cursor()
        try:
            for item in objects:
                kind, name = item.split(" ", 1)
                try:
                    cursor.execute(f"DROP {kind} IF EXISTS {name}")
                except duckdb.Error:
                    pass
        finally:
            cursor.close()

    def close(self) -> None:
        for name in os.listdir(self.folder):
            os.remove(os.path.join(self.folder, name))
        os.rmdir(self.folder)


def _row_id_name(columns: list[Json]) -> str:
    """A name for the column of row IDs that no column of the table has (DuckDB compares names without case)."""
    names = {column["name"].lower() for column in columns}
    name = "vg_rowid"
    while name in names:
        name += "_"
    return name


def _is_writable(column: Json) -> bool:
    """Whether a column's cells are written (§7.1)."""
    return not column.get("readOnly") and column["type"] not in ("interval", "binary")


class Table:
    """A table read from a source, and the cells written into it (§7.2), shared by the handles that `open` gives."""

    def __init__(self, session: Session, ref: str, source: Source) -> None:
        self.session = session
        self.ref = ref
        self.source = source
        self.revision = uuid.uuid4().hex[:16]
        self.columns: list[Json] = []
        self.relation: Relation | None = None
        self.row_count = 0
        self.notes: list[str] = []
        self.sheets: list[Json] | None = None
        self.sheet: str | None = None
        self.byte_size: int | None = None
        self.handles = 0
        self.objects: list[str] = []
        # Delimited files: whether DuckDB reads them in one thread, which it needs for quoted line breaks.
        self.sequential = False
        self.edits = Edits(session, self)

    # ----- loading -----

    def load(self, running: Running) -> None:
        source = self.source
        if source.path is None:
            self.session.run(running, lambda cursor: self._load_data(cursor, source.data))
            return
        path = source.path
        if not os.path.isfile(path):
            raise EngineError("load_failed", "The file does not exist.")
        self.byte_size = os.path.getsize(path)
        fmt = source.format
        if fmt == "parquet" and self.session.run(running, lambda cursor: self._parquet_in_place(cursor, path)):
            return
        if fmt == "xlsx":
            try:
                self.sheets = workbook_sheets(path)
            except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as error:
                raise EngineError("load_failed", "The file is not an Excel workbook.") from error
            names = [sheet["name"] for sheet in self.sheets]
            if source.sheet is not None and source.sheet not in names:
                raise EngineError("load_failed", f"The workbook has no sheet {quoted(source.sheet)}.")
            self.sheet = source.sheet if source.sheet is not None else (names[0] if names else None)
        attempts = 3 if fmt in ("csv", "tsv") else 2 if fmt in ("json", "ndjson") else 1
        error: Exception | None = None
        for attempt in range(attempts):
            try:
                self.session.run(running, lambda cursor, attempt=attempt: self._create_file(cursor, attempt, path))
                if attempt == 2:
                    self.notes.append("all_varchar")
                return
            except EngineError:
                raise
            except duckdb.Error as failure:
                error = failure
        message = str(error).replace(path, os.path.basename(path))
        raise EngineError("load_failed", message)

    def _create_file(self, cursor: duckdb.DuckDBPyConnection, attempt: int, path: str) -> None:
        """Loads the file with the reader of an attempt, in one thread when DuckDB refuses to read it in parallel."""
        try:
            self._create(cursor, self._reader(attempt), [path])
        except duckdb.Error as failure:
            if self.sequential or not _refuses_parallel(failure):
                raise
            self.sequential = True
            self._create(cursor, self._reader(attempt), [path])

    def _reader(self, attempt: int) -> str:
        fmt = self.source.format
        if fmt == "parquet":
            return "read_parquet($1)"
        if fmt == "json":
            return "read_json_auto($1)" if attempt == 0 else "read_json_auto($1, sample_size=-1)"
        if fmt == "ndjson":
            options = "" if attempt == 0 else ", sample_size=-1"
            return f"read_json_auto($1, format='newline_delimited'{options})"
        if fmt == "xlsx":
            sheet = "" if self.sheet is None else f", sheet='{self.sheet.replace(chr(39), chr(39) * 2)}'"
            return f"read_xlsx($1{sheet}, ignore_errors=true)"
        # Without null_padding, DuckDB's sniffer may settle on the last consistent part of a file whose rows have
        # different numbers of fields and silently skip the rest.
        options = ", delim='\\t'" if fmt == "tsv" else ""
        options += ", null_padding=true"
        if self.sequential:
            # DuckDB 2.0 reads such files in parallel only without quoted line breaks (`_refuses_parallel`).
            options += ", parallel=false"
        if attempt == 1:
            # Types sniffed from the beginning did not hold for the whole file: sniff all rows.
            options += ", sample_size=-1"
        elif attempt == 2:
            # Irregular files: read every column as text and tolerate quotes and long lines.
            options += ", all_varchar=true, strict_mode=false, max_line_size=67108864"
        return f"read_csv($1{options})"

    def _describe(self, cursor: duckdb.DuckDBPyConnection, sql: str, params: list[Any]) -> list[tuple[str, str]]:
        return [(str(row[0]), str(row[1])) for row in cursor.execute(f"DESCRIBE {sql}", params).fetchall()]

    def _create(self, cursor: duckdb.DuckDBPyConnection, reader: str, params: list[Any]) -> None:
        """Creates a table of the session from a reader with the columns cast to their logical types (under names of
        its own, so that a column named like DuckDB's `rowid` stays a column), and the view that the engine reads."""
        sources = self._describe(cursor, f"SELECT * FROM {reader}", params)
        columns = [table_column(name, sql_type) for name, sql_type in sources]
        table = quote_identifier(self.session.name("vg_t"))
        values = [
            f'{source_expression(name, sql_type, columns[index])} AS "c{index}"'
            for index, (name, sql_type) in enumerate(sources)
        ]
        selected = ", ".join(values) if values else "NULL AS vg_none"
        cursor.execute(f"CREATE TABLE {table} AS SELECT {selected} FROM {reader}", params)
        self.objects.insert(0, f"TABLE {table}")
        view = quote_identifier(self.session.name("vg_v"))
        row_id = quote_identifier(_row_id_name(columns))
        named = [f'"c{index}" AS {quote_identifier(column["name"])}' for index, column in enumerate(columns)]
        cursor.execute(f"CREATE VIEW {view} AS SELECT {', '.join([*named, f'rowid AS {row_id}'])} FROM {table}")
        self.objects.insert(0, f"VIEW {view}")
        # fetchall finishes the result: DuckDB 2.0 refuses to unregister data (`_load_data`) while one is unfinished.
        rows = cursor.execute(f"SELECT count(*) FROM {table}").fetchall()[0][0]
        self.columns = columns
        self.relation = Relation(view, row_id, int(rows))
        self.row_count = int(rows)

    def _parquet_in_place(self, cursor: duckdb.DuckDBPyConnection, path: str) -> bool:
        """Reads a Parquet file in place, by its row numbers; False for a file with a column named like those row
        numbers (`file_row_number`), which is loaded as a table instead."""
        literal = "'" + path.replace("'", "''") + "'"
        sources = self._describe(cursor, f"SELECT * FROM read_parquet({literal})", [])
        if any(name.lower() == "file_row_number" for name, _ in sources):
            return False
        columns = [table_column(name, sql_type) for name, sql_type in sources]
        view = quote_identifier(self.session.name("vg_p"))
        row_id = quote_identifier(_row_id_name(columns))
        values = [
            f"{source_expression(name, sql_type, columns[index])} AS {quote_identifier(name)}"
            for index, (name, sql_type) in enumerate(sources)
        ]
        cursor.execute(
            f"CREATE VIEW {view} AS SELECT {', '.join([*values, f'file_row_number AS {row_id}'])} "
            f"FROM read_parquet({literal}, file_row_number=true)"
        )
        self.objects.insert(0, f"VIEW {view}")
        rows = int(cursor.execute(f"SELECT count(*) FROM {view}").fetchone()[0])
        self.columns = columns
        self.relation = Relation(view, row_id, rows)
        self.row_count = rows
        return True

    def _load_data(self, cursor: duckdb.DuckDBPyConnection, data: Any) -> None:
        """A DataFrame-like object (pandas, Polars, PyArrow, a DuckDB relation), copied in its row order."""
        if isinstance(data, duckdb.DuckDBPyRelation):
            data = data.to_arrow_table()
        name = self.session.name("vg_data")
        cursor.register(name, data)
        try:
            self._create(cursor, quote_identifier(name), [])
        finally:
            cursor.unregister(name)

    def dispose(self) -> None:
        self.session.drop(self.objects)
        self.objects.clear()


def _refuses_parallel(error: Exception) -> bool:
    """Whether DuckDB refused to read a delimited file in parallel because it has quoted line breaks."""
    return "parallel scanner does not support null_padding" in str(error).lower()


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
        source = SqlSource(relation=relation.sql, row_id=relation.row_id)
        combinations = None
        if plan.aggregate is not None and plan.aggregate.pivot is not None:
            query = pivot_query(plan, source)
            found = self.session.run(running, lambda cursor: cursor.execute(query.sql, query.params).fetchall())
            combinations = [[None if value is None else str(value) for value in row] for row in found]
        sql = compile_view(plan, source, combinations)
        positional = plan.where is None and plan.aggregate is None and len(plan.sort) == 0
        view_hash = plan_hash(plan.plan)
        row_count = relation.rows
        if plan.where is not None or plan.aggregate is not None:
            query = count_query(sql)
            row_count = int(
                self.session.run(running, lambda cursor: cursor.execute(query.sql, query.params).fetchone()[0])
            )
        if positional:
            return View(plan, sql, True, row_count, view_hash, sql.row_id)
        position = _free_name("vg_position", sql.columns)
        view = View(plan, sql, False, row_count, view_hash, position)
        self._materialize(view, running)
        return view

    def _materialize(self, view: View, running: Running) -> None:
        """Stores the total order once. Internal columns have fixed names, so even a user column `rowid` is safe."""
        name = quote_identifier(self.session.name("vg_order"))
        sql = view.sql
        outputs = [f"{quote_identifier(column['name'])} AS c{index}" for index, column in enumerate(sql.columns)]
        if sql.row_id:
            outputs.append(f"{sql.row_id} AS source_id")
        # A view without columns (a pivot without keys and combinations) still has its rows.
        if not outputs:
            outputs.append("NULL AS vg_none")
        order = f" ORDER BY {', '.join(sql.order)}" if sql.order else ""
        self.session.run(
            running,
            lambda cursor: cursor.execute(
                f"CREATE TABLE {name} AS {sql.with_} SELECT {', '.join(outputs)} FROM vg_view{order}", sql.params
            ),
        )
        view.objects.append(f"TABLE {name}")
        selected = [f"c{index} AS {quote_identifier(column['name'])}" for index, column in enumerate(sql.columns)]
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
            outputs = [read_expression(column, quote_identifier(column["name"]), limit) for column in columns]
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
        return self.use(table, request, running, lambda view: self._locate_of(view, request, running))

    def _locate_of(self, view: View, request: Json, running: Running) -> Json:
        keys = request["keys"]
        rows: list[int | None] = [None] * len(keys)
        by_row_id = [(index, key["rowId"]) for index, key in enumerate(keys) if "rowId" in key]
        by_value = [(index, key["value"]) for index, key in enumerate(keys) if "value" in key]
        if view.positional:
            for index, value in by_row_id:
                rows[index] = int(value) if value < view.row_count else None
        elif view.sql.row_ids:
            self._positions_of(view, by_row_id, view.sql.row_id, {"type": "bigint"}, rows, running)
        row_key = request.get("rowKey")
        column = next((item for item in view.sql.columns if item["name"] == row_key), None)
        if column is not None and by_value:
            self._positions_of(view, by_value, quote_identifier(column["name"]), column, rows, running)
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
            sql = quote_identifier(column["name"])
            blank = f"({sql} IS NULL OR {sql} = '')" if column["type"] == "string" else f"{sql} IS NULL"
            aggregates.append(f"count(*) FILTER (WHERE NOT {blank})")
            if column["type"] in _NUMERIC:
                number = f"CAST({sql} AS DOUBLE)"
                finite = f"FILTER (WHERE isfinite({number}))"
                aggregates += [
                    f"count(*) {finite}",
                    f"sum({number}) {finite}",
                    f"min({number}) {finite}",
                    f"max({number}) {finite}",
                ]
        query = f"{view.sql.with_} SELECT {', '.join(aggregates)} FROM vg_view WHERE {within}"
        values = self.session.run(running, lambda cursor: cursor.execute(query, view.sql.params).fetchone())
        at = 0
        count = numeric_count = 0
        total = 0.0
        low = float("inf")
        high = float("-inf")
        for column in columns:
            count += int(values[at])
            at += 1
            if column["type"] not in _NUMERIC:
                continue
            numbers = int(values[at])
            part, least, most = values[at + 1], values[at + 2], values[at + 3]
            at += 4
            if numbers == 0:
                continue
            numeric_count += numbers
            total += float(part)
            low = min(low, float(least))
            high = max(high, float(most))
        if numeric_count == 0:
            return {**empty, "count": count}
        return {
            "count": count,
            "numericCount": numeric_count,
            "sum": float_json(total),
            "min": low,
            "max": high,
            "average": float_json(total / numeric_count),
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
            value = text_sql(quote_identifier(item["name"]), item)
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
            headers = request.get("headers") or [column["name"] for column in columns]
            write_export(
                self.session, view, request["format"], columns, headers, request.get("numberFormats"), file, running
            )
            return view.row_count

        return self.use(table, request, running, write)


def _rows_batches(
    session: Session, view: View, columns: list[Json], running: Running, text_limit: int, size: int = 10_000
) -> Iterator[list[list[Any]]]:
    """The view's rows as typed JSON, a batch at a time; text cut at `text_limit`."""
    outputs = [read_expression(column, quote_identifier(column["name"]), text_limit) for column in columns]
    query = f"{view.sql.with_} SELECT {', '.join(outputs) if outputs else 'NULL'} FROM vg_view ORDER BY {view.position}"
    cursor = session.cursor()
    with running.lock:
        running.check()
        running.cursors.append(cursor)
    try:
        cursor.execute(query, view.sql.params)
        while True:
            running.check()
            found = cursor.fetchmany(size)
            if not found:
                return
            yield [[read_value(column, record[index])[0] for index, column in enumerate(columns)] for record in found]
    except duckdb.InterruptException as error:
        raise _cancelled() from error
    finally:
        with running.lock:
            running.cursors.remove(cursor)
        cursor.close()


def write_export(
    session: Session,
    view: View,
    fmt: str,
    columns: list[Json],
    headers: list[str],
    number_formats: list[str | None] | None,
    file: str,
    running: Running,
) -> None:
    """Writes the rows of a view into a new file, as the DuckDB engine of Node.js writes them."""
    if fmt == "xlsx":
        check_xlsx_size(view.row_count, len(columns))
        named = [{"name": headers[index], "type": column["type"]} for index, column in enumerate(columns)]
        with open(file, "xb") as out:
            # Text is cut to Excel's limit in DuckDB already.
            write_xlsx(named, _rows_batches(session, view, columns, running, 32_767), out, number_formats)
        return
    if fmt == "json":
        # DuckDB's JSON has NaN and Infinity, which JSON does not, float32 as the double it widens to, and decimals of
        # up to 18 digits as doubles (12.5 for 12.50): the rows are written here instead.
        with open(file, "xb") as out:
            write_json(columns, _rows_batches(session, view, columns, running, 2**53 - 1), out)
        return
    # DuckDB renames repeated names in a header ("x", "x_1"): a CSV or TSV file with repeated headers, or without
    # columns (whose rows DuckDB writes as a column NULL), gets its header line written here instead.
    delimited = fmt in ("csv", "tsv")
    delimiter = "\t" if fmt == "tsv" else ","
    own_header = delimited and (not columns or len(set(headers)) != len(headers))
    selected = []
    for index, column in enumerate(columns):
        name = quote_identifier(column["name"])
        # DuckDB writes decimals without whole digits without their 0 (`.5`) and some 32-bit floats with all their
        # exact digits (5525.71875), unlike their text forms (§2.4), and a float of the view whose SQL keeps a FLOAT
        # (`abs` of a float32) as a FLOAT: as the view's type.
        value = name
        if delimited and column["type"] == "decimal" and column.get("scale") == column.get("precision"):
            value = text_sql(name, column)
        if column["type"] == "float":
            value = f"CAST({name} AS {'FLOAT' if column.get('bits') == 32 else 'DOUBLE'})"
        if delimited and column["type"] == "float" and column.get("bits") == 32:
            value = text_sql(value, column)
        if delimited and not own_header and headers[index] != column["name"]:
            selected.append(f"{value} AS {quote_identifier(headers[index])}")
        else:
            selected.append(name if value == name else f"{value} AS {name}")
    options = {
        "csv": f"FORMAT csv, HEADER {'false' if own_header else 'true'}",
        "tsv": f"FORMAT csv, HEADER {'false' if own_header else 'true'}, DELIMITER '\\t'",
        # Without dictionaries when there are intervals: DuckDB's dictionaries keep one of the values that compare
        # equal, and "1 month" and "30 days" compare equal (§3.1), so one would be written for the other.
        "parquet": "FORMAT parquet, COMPRESSION zstd"
        + (", DICTIONARY_SIZE_LIMIT 1" if any(column["type"] == "interval" for column in columns) else ""),
    }[fmt]
    body = f"{file}.body" if own_header else file
    literal = "'" + body.replace("'", "''") + "'"
    try:
        session.run(
            running,
            lambda cursor: cursor.execute(
                f"COPY ({view.sql.with_} SELECT {', '.join(selected) if selected else 'NULL'} FROM vg_view "
                f"ORDER BY {view.position}) TO {literal} ({options})",
                view.sql.params,
            ),
        )
        if own_header:
            with open(file, "xb") as out, open(body, "rb") as rows:
                line = delimiter.join(delimited_field(text, delimiter) for text in headers) + "\n"
                out.write(line.encode("utf-8"))
                while chunk := rows.read(1 << 20):
                    out.write(chunk)
    finally:
        if own_header and os.path.exists(body):
            os.remove(body)


class Engine:
    """Answers the messages of §8.1 for tables of the sources it was given (`add`), by their refs."""

    def __init__(
        self, database: duckdb.DuckDBPyConnection | None = None, text_limit: int = 2000, max_views: int = 8
    ) -> None:
        self.session = Session(database)
        self.views = Views(self.session, text_limit, max_views)
        self.sources: dict[str, Source] = {}
        self.tables: dict[str, Table] = {}
        self.handles: dict[str, Table] = {}
        self.listeners: list[Callable[[Json], None]] = []
        self.running: dict[int, Running] = {}
        self.lock = threading.Lock()
        self._handles = itertools.count(1)
        self.closed = False

    def add(self, ref: str, source: Source) -> None:
        """Lets `open` read a source by `ref`."""
        self.sources[ref] = source

    def subscribe(self, listener: Callable[[Json], None]) -> Callable[[], None]:
        """Follows the events of the engine's tables (§8.5)."""
        self.listeners.append(listener)
        return lambda: self.listeners.remove(listener) if listener in self.listeners else None

    def _emit(self, event: Json) -> None:
        for listener in list(self.listeners):
            listener(event)

    def _tell_changed(self, table: Table) -> None:
        for handle, item in list(self.handles.items()):
            if item is table:
                self._emit(
                    {
                        "v": 2,
                        "event": "changed",
                        "table": handle,
                        "revision": table.revision,
                        "edits": table.edits.state,
                    }
                )

    def handle(self, message: Any) -> Json | None:
        """Answers a request message (§8.1): with a response, an error response, or None for `cancel`."""
        try:
            request = check_request(message)
        except ProtocolError as error:
            return error_response(answer_id(message), "invalid_request", error.message, error.path, error.reason)
        if request["op"] == "cancel":
            with self.lock:
                running = self.running.get(request["request"])
            if running is not None:
                running.cancel()
            return None
        running = Running()
        with self.lock:
            self.running[request["id"]] = running
        try:
            result = self._answer(request, running)
            running.check()
            return {"v": 2, "id": request["id"], "result": result}
        except Exception as error:  # noqa: BLE001 - every error is answered (§8.7)
            code, text, members = self._error_of(error)
            return error_response(
                request["id"], code, text, members.get("path"), members.get("reason"), members.get("details")
            )
        finally:
            with self.lock:
                if self.running.get(request["id"]) is running:
                    del self.running[request["id"]]

    def _error_of(self, error: Exception) -> tuple[str, str, Json]:
        if isinstance(error, BlockValueError):
            return "invalid_value", str(error), {"path": error.path, "reason": error.reason}
        if isinstance(error, EngineError):
            return error.code, error.message, error.members
        if isinstance(error, PlanError):
            return "invalid_plan", error.message, {"path": error.path, "reason": error.reason}
        if isinstance(error, SpecError):
            return error.code, error.message, {}
        if isinstance(error, duckdb.InterruptException):
            return "cancelled", "The request was cancelled.", {}
        return "internal", str(error) or type(error).__name__, {}

    def _table(self, request: Json) -> Table:
        table = self.handles.get(request["table"])
        if table is None:
            raise EngineError("table_not_found", "The table is closed or unknown.")
        if "revision" in request and request["revision"] != table.revision:
            raise _revision_changed()
        return table

    def _answer(self, request: Json, running: Running) -> Any:
        op = request["op"]
        if op == "open":
            return self._open(request["ref"], request.get("read"), running)
        if op == "info":
            return self._info(request["table"], self._table(request))
        if op == "changes":
            table = self._table(request)
            return {"revision": table.revision, "edits": table.edits.state}
        if op == "reload":
            return self._reload(request["table"], running)
        if op == "close":
            self._close(request["table"])
            return None
        if op == "rows":
            return self.views.rows(self._table(request), request, running)
        if op == "locate":
            return self.views.locate(self._table(request), request, running)
        if op == "summarize":
            return self.views.summarize(self._table(request), request, running)
        if op == "find":
            return self.views.find(self._table(request), request, running)
        if op == "write":
            table = self._table(request)
            result = table.edits.write(request, running)
            if result["updated"] > 0:
                self._tell_changed(table)
            return result
        if op == "save":
            self._table(request)
            raise EngineError(
                "save_unsupported",
                "The notebook does not save files: export the table, or read it "
                "into the notebook (Grid.to_pandas, to_polars, to_arrow).",
            )
        if op == "export":
            return self._export(request, running)
        raise EngineError("internal", f"The engine does not answer {op}.")

    def _open(self, ref: str, read: Any, running: Running) -> Json:
        if self.closed:
            raise EngineError("internal", "The engine was closed.")
        source = self.sources.get(ref)
        if source is None:
            raise EngineError("not_allowed", "The notebook did not give a table by this name.")
        if source.format == "xlsx" and isinstance(read, dict) and isinstance(read.get("sheet"), str):
            source = Source(path=source.path, format="xlsx", sheet=read["sheet"])
        key = f"{ref}\0{source.sheet or ''}"
        with self.lock:
            table = self.tables.get(key)
        if table is None:
            table = Table(self.session, ref, source)
            table.load(running)
            with self.lock:
                self.tables[key] = table
        with self.lock:
            table.handles += 1
            handle = f"t{next(self._handles)}"
            self.handles[handle] = table
        return self._info(handle, table)

    def _info(self, handle: str, table: Table) -> Json:
        info: Json = {
            "table": handle,
            "revision": table.revision,
            "edits": table.edits.state,
            "status": "ready",
            "progress": 1,
            "rowCount": table.row_count,
            "readableRows": table.relation.rows if table.relation else 0,
            "columns": table.columns,
            "capabilities": CAPABILITIES,
        }
        if table.source.format is not None:
            info["format"] = table.source.format
        if table.byte_size is not None:
            info["byteSize"] = table.byte_size
        if table.notes:
            info["notes"] = list(table.notes)
        if table.sheets is not None:
            info["sheets"] = [dict(sheet) for sheet in table.sheets]
        if table.sheet is not None:
            info["sheet"] = table.sheet
        return info

    def _reload(self, handle: str, running: Running) -> Json:
        """Moves a handle to its source as it is now (§7.6): with a new revision and without the written cells, which
        stay with the other handles of the table it leaves."""
        old = self._table({"table": handle})
        fresh = Table(self.session, old.ref, old.source)
        fresh.load(running)
        with self.lock:
            if self.handles.get(handle) is not old:
                fresh.dispose()
                raise EngineError("table_not_found", "The table is closed or unknown.")
            self.handles[handle] = fresh
            fresh.handles = 1
            old.handles -= 1
            key = f"{old.ref}\0{old.source.sheet or ''}"
            if self.tables.get(key) is old:
                self.tables[key] = fresh
            left = old.handles == 0
        if left:
            self._release(old)
        self._tell_changed(fresh)
        return self._info(handle, fresh)

    def _close(self, handle: str) -> None:
        """Takes a handle back (§8.2). Written cells belong to the handles open on the table: once the last one
        closes, they are gone, and the source is read again when it is opened again."""
        with self.lock:
            table = self.handles.pop(handle, None)
            if table is None:
                raise EngineError("table_not_found", "The table is closed or unknown.")
            table.handles -= 1
            left = table.handles == 0
            if left:
                for key in [key for key, item in self.tables.items() if item is table]:
                    del self.tables[key]
        if left:
            self._release(table)

    def _release(self, table: Table) -> None:
        self.views.forget(table)
        table.dispose()

    def _export(self, request: Json, running: Running) -> Json:
        """The view's rows as a file (§8.2), answered as its bytes (`delivery` `data`)."""
        table = self._table(request)
        if request["format"] not in EXPORT_FORMATS:
            raise EngineError(
                "invalid_request",
                f"This engine does not export {request['format']} (§4.10).",
                path="/format",
                reason="syntax",
            )
        if "target" in request:
            raise EngineError(
                "not_allowed", "This engine answers exports as data and writes no files: leave out target."
            )
        file = os.path.join(self.session.folder, f"{self.session.name('export')}.{request['format']}")
        try:
            rows = self.views.export(table, request, running, file)
            running.check()
            with open(file, "rb") as data:
                content = data.read()
        finally:
            if os.path.exists(file):
                os.remove(file)
        return {"target": None, "rows": rows, "data": {"bytes": content}}

    def export_file(self, handle: str, request: Json, file: str) -> int:
        """Writes the view of a plan into a file of the notebook's, as `export` writes it; gives its row count."""
        table = self._table({"table": handle})
        return self.views.export(table, {"plan": {}, **request}, Running(), file)

    def close(self) -> None:
        """Cancels the running requests, drops every table and deletes the engine's files."""
        if self.closed:
            return
        self.closed = True
        with self.lock:
            running = list(self.running.values())
            tables = {id(table): table for table in [*self.tables.values(), *self.handles.values()]}
            self.tables.clear()
            self.handles.clear()
        for item in running:
            item.cancel()
        for table in tables.values():
            self._release(table)
        self.listeners.clear()
        self.session.close()
