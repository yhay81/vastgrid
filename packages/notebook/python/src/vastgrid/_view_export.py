"""Writing a SQL view to a file through DuckDB or the streaming format writers."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import duckdb
import pyarrow.parquet as parquet

from ._columns import read_expression, read_value
from ._engine_types import Json
from ._errors import _cancelled
from ._export import XLSX_MAX_TEXT, check_xlsx_size, delimited_field, write_json, write_xlsx
from ._session import Running, Session
from ._sql import quote_identifier, text_sql, view_column

if TYPE_CHECKING:
    from ._views import View


def _rows_batches(
    session: Session, view: View, columns: list[Json], running: Running, text_limit: int, size: int = 10_000
) -> Iterator[list[list[Any]]]:
    """The view's rows as typed JSON, a batch at a time; text cut at `text_limit`."""
    outputs = [read_expression(column, view_column(view.sql, column["name"]), text_limit) for column in columns]
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


def _parquet_name(name: str) -> bytes:
    """A UTF-8 string prefixed by its Compact Thrift unsigned-varint length."""
    data = name.encode("utf-8")
    size = len(data)
    prefix = bytearray()
    while size >= 128:
        prefix.append((size & 127) | 128)
        size >>= 7
    prefix.append(size)
    return bytes(prefix) + data


def _restore_parquet_names(file: str, prefix: str, names: list[str]) -> None:
    """DuckDB wrote unique temporary names for this flat schema. Replace only the name in each schema
    element and column chunk, leaving the native type annotations, row data, offsets and statistics intact."""
    expected = parquet.read_metadata(file).num_row_groups + 1
    replacements = {_parquet_name(f"{prefix}{i:08x}"): _parquet_name(name) for i, name in enumerate(names)}
    counts = dict.fromkeys(replacements, 0)

    def restore(match: re.Match[bytes]) -> bytes:
        key = match.group()
        counts[key] += 1
        return replacements[key]

    with open(file, "r+b") as out:
        out.seek(-8, os.SEEK_END)
        size = int.from_bytes(out.read(4), "little")
        start = out.tell() - 4 - size
        out.seek(start)
        # Every temporary name has the same byte length. The random prefix distinguishes names from statistics.
        pattern = re.escape(_parquet_name(prefix + "0" * 8)[:-8]) + b"[0-9a-f]{8}"
        footer = re.sub(pattern, restore, out.read(size))
        if any(count != expected for count in counts.values()):
            raise ValueError("Unexpected temporary column names in Parquet metadata.")
        out.seek(start)
        out.write(footer)
        out.write(len(footer).to_bytes(4, "little") + b"PAR1")
        out.truncate()


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
            write_xlsx(
                named, _rows_batches(session, view, columns, running, XLSX_MAX_TEXT), out, number_formats, running
            )
        return
    if fmt == "json":
        # DuckDB's JSON has NaN and Infinity, which JSON does not, float32 as the double it widens to, and decimals of
        # up to 18 digits as doubles (12.5 for 12.50): the rows are written here instead.
        with open(file, "xb") as out:
            write_json(columns, _rows_batches(session, view, columns, running, 2**53 - 1), out, running)
        return
    # DuckDB renames repeated names in a header ("x", "x_1"), including names differing only in case ("a", "A_1"):
    # a CSV or TSV file with colliding headers, or without columns (whose rows DuckDB writes as a column NULL), gets
    # its header line written here instead.
    delimited = fmt in ("csv", "tsv")
    delimiter = "\t" if fmt == "tsv" else ","
    own_header = delimited and (
        not columns
        or any(header == "" or "\x00" in header for header in headers)
        or len({header.lower() for header in headers}) != len(headers)
    )
    names = [column["name"] for column in columns]
    parquet_prefix = None
    if fmt == "parquet" and len({name.lower() for name in names}) != len(names):
        parquet_prefix = f"vg_{uuid.uuid4().hex}_"
    selected = []
    for index, column in enumerate(columns):
        name = view_column(view.sql, column["name"])
        value = name
        if delimited and column["type"] == "decimal" and column.get("scale") == column.get("precision"):
            value = text_sql(name, column)
        if column["type"] == "float":
            value = f"CAST({name} AS {'FLOAT' if column.get('bits') == 32 else 'DOUBLE'})"
        if delimited and column["type"] == "float" and column.get("bits") == 32:
            value = text_sql(value, column)
        if parquet_prefix:
            target = quote_identifier(f"{parquet_prefix}{index:08x}")
        elif delimited:
            target = quote_identifier(f"c{index}" if own_header else headers[index])
        else:
            target = quote_identifier(column["name"])
        selected.append(name if value == name and target == name else f"{value} AS {target}")
    options = {
        "csv": f"FORMAT csv, HEADER {'false' if own_header else 'true'}",
        "tsv": f"FORMAT csv, HEADER {'false' if own_header else 'true'}, DELIMITER '\\t'",
        # Without dictionaries when there are intervals: DuckDB's dictionaries keep one of the values that compare
        # equal, and "1 month" and "30 days" compare equal (§3.1), so one would be written for the other.
        "parquet": "FORMAT parquet, COMPRESSION zstd"
        + (", DICTIONARY_SIZE_LIMIT 0" if any(column["type"] == "interval" for column in columns) else ""),
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
        if parquet_prefix:
            _restore_parquet_names(file, parquet_prefix, names)
        if own_header:
            with open(file, "xb") as out, open(body, "rb") as rows:
                line = delimiter.join(delimited_field(text, delimiter) for text in headers) + "\n"
                out.write(line.encode("utf-8"))
                while chunk := rows.read(1 << 20):
                    running.check()
                    out.write(chunk)
    finally:
        if own_header and os.path.exists(body):
            os.remove(body)
