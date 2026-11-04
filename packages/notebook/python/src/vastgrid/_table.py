"""Loading file and DataFrame sources into the relations read by the engine."""

from __future__ import annotations

import os
import uuid
import zipfile
from typing import Any
from xml.etree import ElementTree

import duckdb

from ._columns import source_expression, table_column
from ._edits import Edits
from ._engine_types import Json, Relation, Source
from ._errors import EngineError
from ._messages import quoted
from ._session import Running, Session
from ._sql import quote_identifier

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
}


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


def _row_id_name(columns: list[Json]) -> str:
    """A name for the column of row IDs that no column of the table has (DuckDB compares names without case)."""
    names = {column["name"].lower() for column in columns}
    name = "vg_rowid"
    while name in names:
        name += "_"
    return name


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
        return f"read_csv($1{self._delimited_options(attempt, self.reading)})"

    def _delimited_options(self, attempt: int, reading: str) -> str:
        if reading == "plain" and attempt == 2:
            # Text without strict quotes is read with padding: unpadded, such a record would fail the read.
            reading = "sequential"
        options = ", delim='\\t'" if self.source.format == "tsv" else ""
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


def _uneven_records(error: Exception) -> bool:
    """Whether a read without padding failed on a record with fewer or more fields than the header."""
    return "expected number of columns" in str(error).lower()
