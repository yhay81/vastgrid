"""Writing a SQL view to a file through DuckDB or the streaming format writers."""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import duckdb

from ._columns import read_expression, read_value
from ._engine_types import Json
from ._errors import _cancelled
from ._export import check_xlsx_size, delimited_field, write_json, write_xlsx
from ._session import Running, Session
from ._sql import quote_identifier, text_sql

if TYPE_CHECKING:
    from ._views import View


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
