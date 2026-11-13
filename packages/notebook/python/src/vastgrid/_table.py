"""Loading file and DataFrame sources into the relations read by the engine."""

from __future__ import annotations

import os
import uuid
import zipfile
from typing import Any
from xml.etree import ElementTree
from zlib import error as zlib_error

import duckdb

from ._columns import source_expression, table_column
from ._edits import Edits
from ._engine_types import Json, Relation, Source
from ._errors import EngineError
from ._messages import quoted
from ._session import Running, Session
from ._sql import quote_identifier
from ._values import combine_pairs

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
    ".xlsm": "xlsx",
    ".duckdb": "duckdb",
    ".ddb": "duckdb",
}


def file_format(path: str) -> str | None:
    """The format of a file by its extension (`.csv.gz` as `.csv`), or None for one the engine does not read."""
    name = path.lower()
    for suffix in (".gz", ".zst"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return FILE_FORMATS.get(os.path.splitext(name)[1])


_MAX_ZIP_ENTRIES = 10_000
_MAX_WORKBOOK_XML = 32 * 1024 * 1024
_MAX_PART_BASE = 128 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024


def _read_bounded(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int, keep: bool) -> bytes:
    """Reads or measures a ZIP entry while bounding actual inflated bytes, regardless of header claims."""
    total = 0
    chunks: list[bytes] = []
    with archive.open(info) as stream:
        while chunk := stream.read(262_144):
            total += len(chunk)
            if total > limit:
                raise EngineError("load_failed", "The workbook exceeds the maximum uncompressed size.")
            if keep:
                chunks.append(chunk)
    return b"".join(chunks) if keep else b""


def workbook_sheets(path: str) -> list[Json]:
    """The sheets of a workbook in their order (§8.2 `sheets`), read from `xl/workbook.xml`."""
    main = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > _MAX_ZIP_ENTRIES:
            raise EngineError("load_failed", "The workbook has too many archive entries.")
        workbook_bytes: bytes | None = None
        remaining = _MAX_ARCHIVE_BYTES
        for info in infos:
            part_limit = min(remaining, max(_MAX_PART_BASE, max(1, info.compress_size) * 1024))
            if info.filename == "xl/workbook.xml":
                workbook_bytes = _read_bounded(archive, info, min(part_limit, _MAX_WORKBOOK_XML), True)
                remaining -= len(workbook_bytes)
            else:
                # Verify inflated size of every XML/data entry before DuckDB's read_xlsx inflates it.
                total = 0
                with archive.open(info) as stream:
                    while chunk := stream.read(262_144):
                        total += len(chunk)
                        if total > part_limit:
                            raise EngineError("load_failed", "The workbook exceeds the maximum uncompressed size.")
                remaining -= total
        if workbook_bytes is None:
            raise KeyError("xl/workbook.xml")
        root = ElementTree.fromstring(workbook_bytes)
    sheets: list[Json] = []
    for sheet in root.iter(f"{main}sheet"):
        info_item: Json = {"name": sheet.get("name", "")}
        if sheet.get("state") in ("hidden", "veryHidden"):
            info_item["hidden"] = True
        sheets.append(info_item)
    return sheets


def _row_id_name(columns: list[Json]) -> str:
    """A name for the column of row IDs that no column of the table has (DuckDB compares names without case)."""
    names = {column["name"].lower() for column in columns}
    name = "vg_rowid"
    while name in names:
        name += "_"
    return name


def _unique_columns(sources: list[tuple[str, str]]) -> list[Json]:
    """Unique, non-empty table columns (§4.2) from DuckDB source descriptions."""
    taken: set[str] = set()
    columns: list[Json] = []
    for index, (raw_name, sql_type) in enumerate(sources):
        base = combine_pairs(raw_name or f"column_{index + 1}")[:256]
        name = base
        suffix = 2
        while name in taken:
            tail = f"_{suffix}"
            name = f"{base[: 256 - len(tail)]}{tail}"
            suffix += 1
        taken.add(name)
        columns.append(table_column(name, sql_type))
    return columns


def _relation_aliases(columns: list[Json], row_id_raw: str) -> tuple[list[str], dict[str, str] | None]:
    """Case-distinct quoted SQL aliases for a relation's columns when any two names differ only in case."""
    used = {row_id_raw.lower()}
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
        # Delimited files: how DuckDB reads them. "padded" fills short records with nulls, in parallel. DuckDB 2.0
        # does that only in one thread for files with line breaks in quotes ("sequential"), so such files whose
        # records all have the same fields are read without padding, in parallel ("plain").
        self.reading = "padded"
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
        if fmt == "parquet":
            try:
                if self.session.run(running, lambda cursor: self._parquet_in_place(cursor, path)):
                    return
            except duckdb.Error as failure:
                self.dispose()
                raise EngineError("load_failed", str(failure).replace(path, os.path.basename(path))) from failure
        if fmt == "duckdb":
            try:
                self.session.run(running, lambda cursor: self._load_database(cursor, path, source.sheet))
            except duckdb.Error as failure:
                self.dispose()
                raise EngineError("load_failed", str(failure).replace(path, os.path.basename(path))) from failure
            return
        if fmt == "xlsx":
            try:
                self.sheets = workbook_sheets(path)
            except EngineError:
                raise
            except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError, zlib_error) as error:
                raise EngineError("load_failed", "The file is not an Excel workbook.") from error
            names = [sheet["name"] for sheet in self.sheets]
            if source.sheet is not None and source.sheet not in names:
                raise EngineError("load_failed", f"The workbook has no sheet {quoted(source.sheet)}.")
            default_sheet = next((s["name"] for s in self.sheets if not s.get("hidden")), names[0]) if names else None
            self.sheet = source.sheet if source.sheet is not None else default_sheet
        attempts = 3 if fmt in ("csv", "tsv") else 2 if fmt in ("json", "ndjson") else 1
        error: Exception | None = None
        for attempt in range(attempts):
            try:
                self.session.run(running, lambda cursor, attempt=attempt: self._create_file(cursor, attempt, path))
                if attempt == 2:
                    self.notes.append("all_varchar")
                return
            except EngineError:
                self.dispose()
                raise
            except duckdb.Error as failure:
                self.dispose()
                error = failure
        message = str(error).replace(path, os.path.basename(path))
        raise EngineError("load_failed", message)

    def _create_file(self, cursor: duckdb.DuckDBPyConnection, attempt: int, path: str) -> None:
        """Loads the file with the reader of an attempt. When DuckDB refuses to pad it in parallel, reads it again
        without padding when that reads the same records (`_reads_plain`), and in one thread when it does not or a
        record has other fields."""
        try:
            self._create(cursor, self._reader(attempt), [path])
        except duckdb.Error as failure:
            if self.reading == "padded" and _refuses_parallel(failure):
                self.reading = "plain" if self._reads_plain(cursor, path) else "sequential"
                self._create_file(cursor, attempt, path)
                return
            if self.reading != "plain" or not _uneven_records(failure):
                raise
            self.reading = "sequential"
            self._create(cursor, self._reader(attempt), [path])

    def _reads_plain(self, cursor: duckdb.DuckDBPyConnection, path: str) -> bool:
        """Whether DuckDB reads a file without padding as it does with: its sniffer finds the same dialect, skipped
        lines, header and columns both ways. A record with other fields later in the file then fails the read."""

        def sniff(reading: str) -> list[tuple[Any, ...]]:
            query = (
                "SELECT Delimiter, Quote, Escape, NewLineDelimiter, Comment, SkipRows, HasHeader, Columns "
                f"FROM sniff_csv($1{self._delimited_options(0, reading)})"
            )
            return cursor.execute(query, [path]).fetchall()

        return sniff("sequential") == sniff("plain")

    def _reader(self, attempt: int) -> str:
        fmt = self.source.format
        # A file's columns are its own: DuckDB would add one for each folder of its path named like `key=value`.
        if fmt == "parquet":
            return "read_parquet($1, hive_partitioning=false)"
        if fmt == "json":
            options = "" if attempt == 0 else ", sample_size=-1"
            return f"read_json_auto($1, hive_partitioning=false{options})"
        if fmt == "ndjson":
            options = "" if attempt == 0 else ", sample_size=-1"
            return f"read_json_auto($1, format='newline_delimited', hive_partitioning=false{options})"
        if fmt == "xlsx":
            xlsx_opts: list[str] = []
            if self.sheet is not None:
                xlsx_opts.append(f"sheet='{self.sheet.replace(chr(39), chr(39) * 2)}'")
            if self.source.header_row is not None:
                if self.source.header_row == 0:
                    xlsx_opts.append("header=false")
                else:
                    xlsx_opts.append("header=true")
                    if self.source.header_row > 1:
                        xlsx_opts.append(f"range='A{self.source.header_row}:XFD1048576'")
            if self.source.keep_empty_rows is True:
                xlsx_opts.append("stop_at_empty=false")
            if self.source.keep_empty_columns is True:
                xlsx_opts.append("empty_as_varchar=true")
            xlsx_opts.append("ignore_errors=true")
            return f"read_xlsx($1, {', '.join(xlsx_opts)})"
        return f"read_csv($1{self._delimited_options(attempt, self.reading)})"

    def _delimited_options(self, attempt: int, reading: str) -> str:
        if reading == "plain" and attempt == 2:
            # Text without strict quotes is read with padding: unpadded, such a record would fail the read.
            reading = "sequential"
        delim = (
            self.source.delimiter
            if self.source.delimiter is not None
            else ("\t" if self.source.format == "tsv" else None)
        )
        if delim is not None:
            escaped_delim = "\\t" if delim == "\t" else delim.replace("'", "''")
            options = f", delim='{escaped_delim}'"
        else:
            options = ""
        if self.source.header_row is not None:
            header_flag = "true" if self.source.header_row > 0 else "false"
            options += f", header={header_flag}, skip={max(0, self.source.header_row - 1)}"
        options += ", hive_partitioning=false"
        # Without null_padding, DuckDB's sniffer may settle on the last consistent part of a file whose rows have
        # different numbers of fields and silently skip the rest (`_reads_plain` rules that out).
        if reading != "plain":
            options += ", null_padding=true"
        if reading == "sequential":
            options += ", parallel=false"
        if attempt == 1:
            # Types sniffed from the beginning did not hold for the whole file: sniff all rows.
            options += ", sample_size=-1"
        elif attempt == 2:
            # Irregular files: read every column as text and tolerate quotes and long lines.
            options += ", all_varchar=true, strict_mode=false, max_line_size=67108864"
        return options

    def _describe(self, cursor: duckdb.DuckDBPyConnection, sql: str, params: list[Any]) -> list[tuple[str, str]]:
        rows = cursor.execute(f"SELECT '.' || column_name, column_type FROM (DESCRIBE {sql})", params).fetchall()
        return [(str(row[0])[1:], str(row[1])) for row in rows]

    def _create(
        self,
        cursor: duckdb.DuckDBPyConnection,
        reader: str,
        params: list[Any],
        *,
        names: list[str] | None = None,
    ) -> None:
        """Creates a table of the session from a reader with the columns cast to their logical types (under names of
        its own, so that a column named like DuckDB's `rowid` stays a column), and the view that the engine reads."""
        described = self._describe(cursor, f"SELECT * FROM {reader}", params)
        sources = (
            [(names[index], sql_type) for index, (_, sql_type) in enumerate(described)]
            if names is not None
            else described
        )
        columns = _unique_columns(sources)
        table = quote_identifier(self.session.name("vg_t"))
        has_collision = names is None and len({name.lower() for name, _ in sources}) != len(sources)
        source_ids = [f'"s{i}"' for i in range(len(sources))]
        from_clause = f"(SELECT * FROM {reader}) vg_s({', '.join(source_ids)})" if has_collision and sources else reader
        raw_ids = (
            [quote_identifier(described[i][0]) for i in range(len(sources))]
            if names is not None
            else source_ids
            if has_collision
            else [None] * len(sources)
        )
        values = [
            f'{source_expression(name, sql_type, columns[index], raw_ids[index])} AS "c{index}"'
            for index, (name, sql_type) in enumerate(sources)
        ]
        selected = ", ".join(values) if values else "NULL AS vg_none"
        cursor.execute(f"CREATE TABLE {table} AS SELECT {selected} FROM {from_clause}", params)
        self.objects.insert(0, f"TABLE {table}")
        view = quote_identifier(self.session.name("vg_v"))
        raw_row_id = _row_id_name(columns)
        row_id = quote_identifier(raw_row_id)
        aliases, aliases_map = _relation_aliases(columns, raw_row_id)
        named = [f'"c{index}" AS {aliases[index]}' for index in range(len(columns))]
        cursor.execute(f"CREATE VIEW {view} AS SELECT {', '.join([*named, f'rowid AS {row_id}'])} FROM {table}")
        self.objects.insert(0, f"VIEW {view}")
        # fetchall finishes the result: DuckDB 2.0 refuses to unregister data (`_load_data`) while one is unfinished.
        rows = cursor.execute(f"SELECT count(*) FROM {table}").fetchall()[0][0]
        self.columns = columns
        self.relation = Relation(view, row_id, int(rows), aliases_map)
        self.row_count = int(rows)

    def _create_empty(self, cursor: duckdb.DuckDBPyConnection, rows: int) -> None:
        table = quote_identifier(self.session.name("vg_t"))
        cursor.execute(f"CREATE TABLE {table} AS SELECT NULL AS vg_none FROM range($1)", [rows])
        self.objects.insert(0, f"TABLE {table}")
        view = quote_identifier(self.session.name("vg_v"))
        row_id = quote_identifier("vg_row")
        cursor.execute(f"CREATE VIEW {view} AS SELECT rowid AS {row_id} FROM {table}")
        self.objects.insert(0, f"VIEW {view}")
        self.columns = []
        self.relation = Relation(view, row_id, rows, {})
        self.row_count = rows

    def _load_database(self, cursor: duckdb.DuckDBPyConnection, path: str, sheet: str | None) -> None:
        """A table of a DuckDB database: the database is attached read only while it is copied, and its tables are
        its sheets, those of the schema `main` by their names and others as `schema.name`. Its views are not: they
        are SQL of the database's author, which reads whatever it names. The copy's row IDs are positions (§1), and
        the file is free again for programs that write it."""
        name = self.session.name("vg_db")
        catalog = quote_identifier(name)
        try:
            cursor.execute(f"ATTACH $1 AS {catalog} (TYPE duckdb, READ_ONLY)", [path])
        except duckdb.Error as error:
            words = str(error).lower()
            # DuckDB's words on POSIX, and on Windows, where it also names the programs that have the file open.
            locked = ("could not set lock", "already open in", "being used by another process")
            if any(part in words for part in locked):
                message = "Another program has the database open to write it; close it there first."
                raise EngineError("load_failed", message) from error
            if "not a valid duckdb database" in words:
                raise EngineError("load_failed", "The file is not a DuckDB database.") from error
            raise
        try:
            listed = cursor.execute(
                "SELECT table_schema, table_name FROM information_schema.tables "
                "WHERE table_catalog = $1 AND table_type = 'BASE TABLE' "
                "ORDER BY table_schema <> 'main', table_schema, table_name",
                [name],
            ).fetchall()
            tables = [
                (
                    table if schema == "main" else f"{schema}.{table}",
                    f"{catalog}.{quote_identifier(schema)}.{quote_identifier(table)}",
                )
                for schema, table in listed
            ]
            self.sheets = [{"name": sheet_name} for sheet_name, _ in tables]
            if not tables:
                raise EngineError("load_failed", "The database has no tables.")
            chosen = tables[0] if sheet is None else next((table for table in tables if table[0] == sheet), None)
            if chosen is None:
                raise EngineError("load_failed", f"The database has no table named {quoted(sheet)}.")
            self.sheet = chosen[0]
            self._create(cursor, chosen[1], [])
        finally:
            try:
                cursor.execute(f"DETACH DATABASE IF EXISTS {catalog}")
            except duckdb.Error:
                pass

    def _parquet_in_place(self, cursor: duckdb.DuckDBPyConnection, path: str) -> bool:
        """Reads a Parquet file in place, by its row numbers; False for a file with a column named like those row
        numbers (`file_row_number`), which is loaded as a table instead."""
        literal = "'" + path.replace("'", "''") + "'"
        sources = self._describe(cursor, f"SELECT * FROM read_parquet({literal}, hive_partitioning=false)", [])
        if any(name.lower() == "file_row_number" or not name for name, _ in sources) or len(
            {name.lower() for name, _ in sources}
        ) != len(sources):
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
            f"FROM read_parquet({literal}, file_row_number=true, hive_partitioning=false)"
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
        elif type(data).__module__.startswith(("polars", "pandas")) and hasattr(data, "to_frame"):
            data = data.to_frame()
        if type(data).__module__.startswith("pyarrow") and hasattr(data, "validate"):
            try:
                data.validate(full=True)
            except Exception as error:  # noqa: BLE001
                raise EngineError("load_failed", str(error)) from error
        zero_cols_rows: int | None = None
        if getattr(data, "num_columns", None) == 0 and hasattr(data, "num_rows"):
            zero_cols_rows = int(data.num_rows)
        elif (
            type(data).__module__.startswith(("polars", "pandas"))
            and hasattr(data, "columns")
            and len(data.columns) == 0
        ):
            zero_cols_rows = int(len(data))
        if zero_cols_rows is not None:
            self._create_empty(cursor, zero_cols_rows)
            return
        raw_names: list[str] | None = None
        if hasattr(data, "column_names"):
            raw_names = [str(col) for col in data.column_names]
        elif type(data).__module__.startswith(("polars", "pandas")) and hasattr(data, "columns"):
            raw_names = [str(col) for col in data.columns]
        override_names: list[str] | None = None
        if raw_names is not None and (
            any(not col for col in raw_names) or len({col.lower() for col in raw_names}) != len(raw_names)
        ):
            override_names = raw_names
            safe = [f"c{index}" for index in range(len(raw_names))]
            if hasattr(data, "rename_columns"):
                data = data.rename_columns(safe)
            elif type(data).__module__.startswith("polars"):
                data = data.to_arrow().rename_columns(safe)
            else:
                data = data.copy(deep=False)
                data.columns = safe
        name = self.session.name("vg_data")
        try:
            cursor.register(name, data)
        except Exception as error:  # noqa: BLE001
            raise EngineError("load_failed", str(error)) from error
        try:
            self._create(cursor, quote_identifier(name), [], names=override_names)
        except duckdb.Error as error:
            raise EngineError("load_failed", str(error)) from error
        finally:
            cursor.unregister(name)

    def dispose(self) -> None:
        self.session.drop(self.objects)
        self.objects.clear()


def _refuses_parallel(error: Exception) -> bool:
    """Whether DuckDB refused to read a delimited file in parallel because it has quoted line breaks."""
    return "parallel scanner does not support null_padding" in str(error).lower()


def _uneven_records(error: Exception) -> bool:
    """Whether a read without padding failed on a record with fewer or more fields than the header."""
    return "expected number of columns" in str(error).lower()
