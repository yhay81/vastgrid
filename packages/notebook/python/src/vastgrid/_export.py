"""Writes the files of `export` (docs/v2-spec.md §8.2) from rows of typed JSON (§2.2), as vastgrid-spec's
`export.ts` (JSON) and `xlsx.ts` (Excel workbooks) write them, so that every engine writes them alike. CSV, TSV and
Parquet are written by DuckDB (`COPY`), as the DuckDB engine of Node.js writes them."""

from __future__ import annotations

import math
import re
import zipfile
from collections.abc import Iterable, Iterator, Sequence
from typing import IO, Any

from ._json import is_number, js_json, js_number
from ._plan import SpecError
from ._values import text_of

XLSX_MAX_ROWS = 1_048_576
XLSX_MAX_COLUMNS = 16_384
XLSX_MAX_TEXT = 32_767

Rows = Iterable[Sequence[Sequence[Any]]]


def delimited_field(text: str, delimiter: str) -> str:
    """A field of CSV or TSV, quoted as DuckDB quotes fields."""
    if text == "" or re.search(r'["\r\n]', text) or delimiter in text:
        return '"' + text.replace('"', '""') + '"'
    return text


def json_value_text(value: Any, column: dict[str, Any]) -> str:
    """A value as JSON text, as `write_json` writes it."""
    if value is None:
        return "null"
    kind = column["type"]
    if kind == "boolean":
        return "true" if value is True else "false"
    if kind in ("integer", "bigint", "decimal"):
        return js_number(value) if is_number(value) else str(value)
    if kind == "float":
        text = text_of(value, column)
        return f'"{text}"' if re.fullmatch(r"-?(?:nan|inf)", text) else text
    return js_json(text_of(value, column))


def write_json(columns: Sequence[dict[str, Any]], batches: Rows, out: IO[bytes]) -> None:
    """JSON: an array of objects by column name, with the layout of DuckDB's `COPY (FORMAT json, ARRAY true)`."""
    keys = [js_json(column["name"]) + ":" for column in columns]
    first = True
    out.write(b"[\n")
    for batch in batches:
        parts: list[str] = []
        for values in batch:
            parts.append("\t{" if first else ",\n\t{")
            first = False
            parts.append(",".join(keys[i] + json_value_text(values[i], column) for i, column in enumerate(columns)))
            parts.append("}")
        out.write("".join(parts).encode("utf-8"))
    out.write(b"]\n" if first else b"\n]\n")


# ----- workbooks -----

_EXCEL_EPOCH_DAYS = 25_569  # 1970-01-01
_MIN_SERIAL = 61  # 1900-03-01: Excel counts a 29 February 1900 that did not exist
_MAX_SERIAL = 2_958_466  # 10000-01-01

_TEMPORAL = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})?$", re.I
)
_TIME_OF_DAY = re.compile(r"^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2}){0,2})?$", re.I)
_NUMERIC_TEXT = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$", re.I)
_NOT_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]")
_ESCAPE_LIKE = re.compile(r"_(x[0-9a-f]{4}_)", re.I)
_NUMERIC = {"integer", "bigint", "decimal", "float"}
_DEFAULT_FORMATS = {
    "date": "yyyy-mm-dd",
    "timestamp": "yyyy-mm-dd hh:mm:ss",
    "timestamptz": "yyyy-mm-dd hh:mm:ss",
    "time": "hh:mm:ss",
}
_XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def check_xlsx_size(rows: int, columns: int) -> None:
    """Refuses a table that does not fit in one Excel sheet (`export_too_large`, §8.7)."""
    if rows + 1 > XLSX_MAX_ROWS or columns > XLSX_MAX_COLUMNS:
        raise SpecError(
            "export_too_large",
            f"An Excel sheet holds at most {XLSX_MAX_ROWS - 1} rows and {XLSX_MAX_COLUMNS} columns; "
            "filter the rows or choose another format.",
        )


def _offset_seconds(offset: str | None) -> int:
    """Seconds east of UTC of an offset such as `Z`, `+09`, `+0930` or `-05:00`."""
    if not offset or offset.lower() == "z":
        return 0
    digits = offset[1:].replace(":", "")
    total = int(digits[0:2]) * 3600 + int(digits[2:4] or 0) * 60 + int(digits[4:6] or 0)
    return -total if offset[0] == "-" else total


def excel_serial(value: str, kind: str) -> float | None:
    """The Excel serial number of an ISO-like date, time or timestamp, or None when Excel cannot show it."""
    if kind == "time":
        match = _TIME_OF_DAY.match(value.strip())
        if not match:
            return None
        seconds = int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3] or 0) + float(match[4] or 0)
        return seconds / 86_400 if seconds < 86_400 else None
    match = _TEMPORAL.match(value.strip())
    if not match:
        return None
    days = _days_from_civil(int(match[1]), int(match[2]), 1) + int(match[3]) - 1
    seconds = (
        int(match[4] or 0) * 3600
        + int(match[5] or 0) * 60
        + int(match[6] or 0)
        + float(match[7] or 0)
        - _offset_seconds(match[8])
    )
    serial = days + _EXCEL_EPOCH_DAYS + seconds / 86_400
    return serial if _MIN_SERIAL <= serial < _MAX_SERIAL else None


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days from 1970-01-01 in the proleptic Gregorian calendar, months beyond 1 to 12 rolling over into other years
    as JavaScript's `setUTCFullYear` rolls them."""
    year += (month - 1) // 12
    month = (month - 1) % 12 + 1
    year -= month <= 2
    era = (year if year >= 0 else year - 399) // 400
    of_era = year - era * 400
    of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    of_era_days = of_era * 365 + of_era // 4 - of_era // 100 + of_year
    return era * 146_097 + of_era_days - 719_468


def _exact_number(text: str) -> float | None:
    """A number for numeric text that a double holds exactly as written (at most 15 significant digits)."""
    if not _NUMERIC_TEXT.match(text):
        return None
    mantissa = re.sub(r"e.*$", "", re.sub(r"^[+-]", "", text), flags=re.I).replace(".", "", 1)
    significant = mantissa.lstrip("0").rstrip("0")
    if len(significant) > 15:
        return None
    number = float(text)
    return number if math.isfinite(number) else None


def _column_name(index: int) -> str:
    name = ""
    rest = index + 1
    while rest > 0:
        name = chr(65 + (rest - 1) % 26) + name
        rest = (rest - 1) // 26
    return name


def _escape_xml(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _cell_text(value: str) -> str:
    """Text for a cell: cut to Excel's limit, with characters XML cannot hold written as `_xHHHH_` (and text that
    looks like such an escape escaped itself), as the format defines."""
    text = value
    if _utf16_length(text) > XLSX_MAX_TEXT:
        text = _utf16_prefix(text, XLSX_MAX_TEXT)
    text = _ESCAPE_LIKE.sub(r"_x005F_\1", text)
    text = _NOT_XML.sub(lambda match: f"_x{ord(match.group()):04X}_", text)
    return _escape_xml(text)


def _utf16_length(text: str) -> int:
    return len(text) + sum(1 for char in text if ord(char) > 0xFFFF)


def _utf16_prefix(text: str, units: int) -> str:
    """The longest prefix of at most `units` UTF-16 units that does not end in half a pair."""
    count = 0
    for index, char in enumerate(text):
        count += 2 if ord(char) > 0xFFFF else 1
        if count > units:
            return text[:index]
    return text


def _text_cell(ref: str, text: str, style: int = 0) -> str:
    styled = f' s="{style}"' if style else ""
    return f'<c r="{ref}"{styled} t="inlineStr"><is><t xml:space="preserve">{_cell_text(text)}</t></is></c>'


def _number_cell(ref: str, value: float, style: int) -> str:
    styled = f' s="{style}"' if style else ""
    return f'<c r="{ref}"{styled}><v>{js_number(value)}</v></c>'


def _value_cell(ref: str, value: Any, kind: str, style: int) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>'
    if is_number(value):
        return _number_cell(ref, value, style) if math.isfinite(value) else _text_cell(ref, js_number(value))
    if not isinstance(value, str):
        return _text_cell(ref, js_json(value))
    if kind in ("date", "timestamp", "timestamptz", "time"):
        serial = excel_serial(value, kind)
        return _text_cell(ref, value) if serial is None else _number_cell(ref, serial, style)
    if kind in _NUMERIC:
        number = _exact_number(value.strip())
        return _text_cell(ref, value) if number is None else _number_cell(ref, number, style)
    return _text_cell(ref, value)


def _sheet_name(name: str | None) -> str:
    cleaned = re.sub(r"[\[\]:*?/\\\x00-\x1f]", "_", name or "")
    cleaned = re.sub(r"^'+|'+$", "", cleaned)[:31]
    return cleaned if cleaned.strip() else "Sheet1"


def _static_parts(sheet_name: str, formats: list[str]) -> dict[str, str]:
    num_fmts = "".join(
        f'<numFmt numFmtId="{164 + index}" formatCode="{_escape_xml(code)}"/>' for index, code in enumerate(formats)
    )
    xfs = "".join(
        f'<xf numFmtId="{164 + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        for index in range(len(formats))
    )
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relationships = "http://schemas.openxmlformats.org/package/2006/relationships"
    office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    sheet_type = "application/vnd.openxmlformats-officedocument.spreadsheetml"
    return {
        "[Content_Types].xml": f'{_XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/xl/workbook.xml" ContentType="{sheet_type}.sheet.main+xml"/>'
        f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{sheet_type}.worksheet+xml"/>'
        f'<Override PartName="/xl/styles.xml" ContentType="{sheet_type}.styles+xml"/></Types>',
        "_rels/.rels": f'{_XML_HEAD}<Relationships xmlns="{relationships}"><Relationship Id="rId1" '
        f'Type="{office}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'{_XML_HEAD}<workbook xmlns="{main}" xmlns:r="{office}"><sheets>'
        f'<sheet name="{_escape_xml(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'{_XML_HEAD}<Relationships xmlns="{relationships}">'
        f'<Relationship Id="rId1" Type="{office}/worksheet" Target="worksheets/sheet1.xml"/>'
        f'<Relationship Id="rId2" Type="{office}/styles" Target="styles.xml"/></Relationships>',
        # Style 1 is the bold header; styles 2… are the number formats.
        "xl/styles.xml": f'{_XML_HEAD}<styleSheet xmlns="{main}">'
        + (f'<numFmts count="{len(formats)}">{num_fmts}</numFmts>' if formats else "")
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        f'<cellXfs count="{2 + len(formats)}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        f'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>{xfs}</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    }


def _column_width(name: str, kind: str) -> int:
    typical = {"date": 11, "timestamp": 20, "timestamptz": 20, "time": 10}
    return min(60, max(8, typical.get(kind, 12), len(name) + 2))


def _sheet(columns: Sequence[dict[str, Any]], styles: list[int], batches: Rows) -> Iterator[str]:
    refs = [_column_name(index) for index in range(len(columns))]
    cols = "".join(
        f'<col min="{index + 1}" max="{index + 1}" width="{_column_width(column["name"], column["type"])}" '
        'customWidth="1"/>'
        for index, column in enumerate(columns)
    )
    header = "".join(_text_cell(f"{refs[index]}1", column["name"], 1) for index, column in enumerate(columns))
    pane = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' if columns else ""
    yield (
        f'{_XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews>'
        f'<sheetView workbookViewId="0">{pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
        + (f"<cols>{cols}</cols>" if cols else "")
        + f'<sheetData><row r="1">{header}</row>'
    )
    row = 1
    for batch in batches:
        if row + len(batch) > XLSX_MAX_ROWS:
            check_xlsx_size(row + len(batch), len(columns))
        parts: list[str] = []
        for values in batch:
            row += 1
            parts.append(f'<row r="{row}">')
            for index, column in enumerate(columns):
                parts.append(_value_cell(f"{refs[index]}{row}", values[index], column["type"], styles[index]))
            parts.append("</row>")
        yield "".join(parts)
    yield "</sheetData></worksheet>"


def write_xlsx(
    columns: Sequence[dict[str, Any]],
    batches: Rows,
    out: IO[bytes],
    number_formats: Sequence[str | None] | None = None,
) -> None:
    """A workbook with one sheet: a bold, frozen header row of the columns' names (`name`, with their logical
    `type`), then the rows, in batches. Raises `SpecError` (`export_too_large`) when they do not fit in a sheet."""
    check_xlsx_size(0, len(columns))
    formats: list[str] = []
    styles: list[int] = []
    for index, column in enumerate(columns):
        code = (number_formats[index] if number_formats else None) or _DEFAULT_FORMATS.get(column["type"])
        if not code:
            styles.append(0)
            continue
        if code not in formats:
            formats.append(code)
        styles.append(2 + formats.index(code))
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for name, text in _static_parts(_sheet_name(None), formats).items():
            archive.writestr(name, text)
        with archive.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as sheet:
            for text in _sheet(columns, styles, batches):
                sheet.write(text.encode("utf-8"))
