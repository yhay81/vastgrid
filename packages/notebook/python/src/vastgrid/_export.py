"""Writes the files of `export` (docs/spec.md §8.2) from rows of typed JSON (§2.2), as vastgrid-spec's
`export.ts` (JSON) and `xlsx.ts` (Excel workbooks) write them, so that every engine writes them alike. CSV, TSV and
Parquet are written by DuckDB (`COPY`), as the DuckDB engine of Node.js writes them."""

from __future__ import annotations

import math
import re
import zipfile
from collections.abc import Iterable, Iterator, Sequence
from typing import IO, Any

from ._calendar import civil_from_days, days_from_civil
from ._plan import SpecError
from ._session import Running
from ._values import code_points, combine_pairs, is_number, is_value_of, json_text, number_text, text_of

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
        return number_text(value) if is_number(value) else str(value)
    if kind == "float":
        text = text_of(value, column)
        assert text is not None
        return f'"{text}"' if re.fullmatch(r"-?(?:nan|inf)", text) else text
    return json_text(text_of(value, column))


def write_json(
    columns: Sequence[dict[str, Any]], batches: Rows, out: IO[bytes], running: Running | None = None
) -> None:
    """JSON: an array of objects by column name, with the layout of DuckDB's `COPY (FORMAT json, ARRAY true)`."""
    keys = [json_text(column["name"]) + ":" for column in columns]
    first = True
    out.write(b"[\n")
    for batch in batches:
        if running is not None:
            running.check()
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
_TIME_OF_DAY = re.compile(r"^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})?$", re.I)
_NUMERIC_TEXT = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$", re.I)
_NOT_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff\ud800-\udfff]")
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


def _offset_seconds(offset: str | None) -> int | None:
    """Seconds east of UTC of an offset such as `Z`, `+09`, `+0930` or `-05:00`, or None when invalid."""
    if not offset or offset.lower() == "z":
        return 0
    digits = offset[1:].replace(":", "")
    hours = int(digits[0:2])
    minutes = int(digits[2:4] or 0)
    seconds = int(digits[4:6] or 0)
    if hours > 23 or minutes > 59 or seconds > 59:
        return None
    total = hours * 3600 + minutes * 60 + seconds
    return -total if offset[0] == "-" else total


def excel_serial(value: str, kind: str) -> float | None:
    """The Excel serial number of an ISO-like date, time or timestamp, or None when Excel cannot show it."""
    if kind == "time":
        match = _TIME_OF_DAY.match(value.strip())
        if not match:
            return None
        hours, minutes, secs = int(match[1]), int(match[2]), int(match[3] or 0)
        if hours > 23 or minutes > 59 or secs > 59 or _offset_seconds(match[5]) is None:
            return None
        seconds = hours * 3600 + minutes * 60 + secs + float(match[4] or 0)
        return seconds / 86_400 if seconds < 86_400 else None
    match = _TEMPORAL.match(value.strip())
    if not match:
        return None
    if kind == "date" and (match[4] is not None or match[8] is not None):
        return None
    year, month, day = int(match[1]), int(match[2]), int(match[3])
    if month < 1 or month > 12 or day < 1:
        return None
    days = days_from_civil(year, month, day)
    if civil_from_days(days) != (year, month, day):
        return None
    hours, minutes, secs = int(match[4] or 0), int(match[5] or 0), int(match[6] or 0)
    if hours > 23 or minutes > 59 or secs > 59:
        return None
    offset = _offset_seconds(match[8])
    if offset is None:
        return None
    seconds = hours * 3600 + minutes * 60 + secs + float(match[7] or 0) - offset
    serial = days + _EXCEL_EPOCH_DAYS + seconds / 86_400
    return serial if _MIN_SERIAL <= serial < _MAX_SERIAL else None


def _exact_number(text: str) -> float | None:
    """A number for numeric text that a double holds exactly as written (at most 15 significant digits)."""
    if not _NUMERIC_TEXT.match(text):
        return None
    mantissa = re.sub(r"e.*$", "", re.sub(r"^[+-]", "", text), flags=re.I).replace(".", "", 1)
    significant = mantissa.lstrip("0").rstrip("0")
    if len(significant) > 15:
        return None
    number = float(text)
    return number if math.isfinite(number) and abs(number) < 1e15 else None


_PATTERN_TOKENS = re.compile(r"'([^']|'')*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|a|mm|m|ss|s|S+|[A-Za-z]")
_MAPPED_DATE_TOKENS = {
    "yyyy": "yyyy",
    "yy": "yy",
    "MMMM": "mmmm",
    "MMM": "mmm",
    "MM": "mm",
    "M": "m",
    "dd": "dd",
    "d": "d",
    "EEEE": "dddd",
    "EEE": "ddd",
    "HH": "hh",
    "H": "h",
    "hh": "hh",
    "h": "h",
    "a": "AM/PM",
    "mm": "mm",
    "m": "m",
    "ss": "ss",
    "s": "s",
}


def _excel_quoted(text: str) -> str:
    return '\\"'.join(f'"{part}"' if part else "" for part in text.split('"'))


def _excel_date_code(pattern: str) -> str | None:
    code = ""
    literal = ""
    last = 0
    for match in _PATTERN_TOKENS.finditer(pattern):
        literal += pattern[last : match.start()]
        last = match.end()
        token = match.group(0)
        if token.startswith("'"):
            literal += "'" if token == "''" else token[1:-1].replace("''", "'")
            continue
        if token.startswith("S"):
            literal = re.sub(r"[.,]$", "", literal)
        code += _excel_quoted(literal)
        literal = ""
        if token.startswith("S"):
            code += "." + "0" * min(len(token), 3)
        elif token in _MAPPED_DATE_TOKENS:
            code += _MAPPED_DATE_TOKENS[token]
        else:
            return None
    code += _excel_quoted(literal + pattern[last:])
    if "h" in re.sub(r"'([^']|'')*'", "", pattern) and "AM/PM" not in code:
        code += " AM/PM"
    return code


def excel_number_format(kind: str, fmt: dict[str, Any] | None) -> str | None:
    """The Excel number format code for a column's display settings, matching `excelNumberFormat` in `vastgrid-spec`."""
    if not isinstance(fmt, dict):
        return None
    num = fmt.get("number")
    if kind in _NUMERIC and isinstance(num, dict) and num.get("notation") != "compact":
        style = num.get("style", "decimal")
        if style == "currency" and not num.get("currency"):
            return None
        integer = kind in ("integer", "bigint")
        min_d = num.get("fractionDigits", num.get("minimumFractionDigits"))
        max_d = num.get("fractionDigits", num.get("maximumFractionDigits"))
        if min_d is None and max_d is None:
            if style == "currency":
                min_d = max_d = 0 if str(num.get("currency")).upper() in ("JPY", "KRW", "VND", "CLP", "ISK") else 2
            elif style == "percent":
                min_d = max_d = 0
            elif not integer:
                min_d, max_d = 0, 10
        min_d = 0 if min_d is None else int(min_d)
        max_d = max(min_d if max_d is None else int(max_d), min_d)
        frac = "" if max_d <= 0 else f".{'0' * min_d}{'#' * max(0, max_d - min_d)}"
        notation = num.get("notation")
        if notation in ("scientific", "engineering"):
            code = f"{'##' if notation == 'engineering' else ''}0{frac}E+00"
        else:
            grouping = num.get("grouping", True)
            code = f"{'#,##0' if grouping else '0'}{frac}"
        if style == "percent":
            code += "%"
        prefix = str(num.get("prefix") or "")
        suffix = str(num.get("suffix") or "")
        if style == "currency" and num.get("currency"):
            currency = str(num["currency"])
            symbols = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}
            display = num.get("currencyDisplay", "symbol")
            symbol = currency if display in ("code", "name") else symbols.get(currency, f"{currency} ")
            prefix = f"{prefix}{symbol}"
        positive = f"{_excel_quoted(prefix)}{code}{_excel_quoted(suffix)}"
        sign = num.get("signDisplay")
        if sign in ("always", "exceptZero"):
            zero = f"{_excel_quoted('+' + prefix)}{code}{_excel_quoted(suffix)}" if sign == "always" else positive
            return f"{_excel_quoted('+' + prefix)}{code}{_excel_quoted(suffix)};{_excel_quoted('-' + prefix)}{code}{_excel_quoted(suffix)};{zero}"
        if sign == "never":
            return f"{positive};{positive}"
        return positive
    date_fmt = fmt.get("date")
    if isinstance(date_fmt, dict) and kind in ("date", "time", "timestamp", "timestamptz"):
        pattern = date_fmt.get("pattern")
        return _excel_date_code(pattern) if isinstance(pattern, str) else None
    return None


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
    text = combine_pairs(value)
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
    return f'<c r="{ref}"{styled}><v>{number_text(value)}</v></c>'


def _value_cell(ref: str, value: Any, kind: str, style: int) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>'
    if is_number(value):
        return _number_cell(ref, value, style) if math.isfinite(value) else _text_cell(ref, number_text(value))
    if not isinstance(value, str):
        return _text_cell(ref, json_text(value))
    if kind in ("date", "timestamp", "timestamptz", "time"):
        serial = excel_serial(value, kind)
        if serial is not None:
            return _number_cell(ref, serial, style)
        text = (text_of(value, {"type": kind}) or value) if is_value_of(value, {"type": kind}) else value
        return _text_cell(ref, text)
    if kind in _NUMERIC:
        number = _exact_number(value.strip())
        return _text_cell(ref, value) if number is None else _number_cell(ref, number, style)
    if kind == "binary":
        text = (text_of(value, {"type": kind}) or value) if is_value_of(value, {"type": kind}) else value
        return _text_cell(ref, text)
    return _text_cell(ref, value)


def _sheet_name(name: str | None) -> str:
    replaced = re.sub(r"[\[\]:*?/\\\x00-\x1f]", "_", combine_pairs(name or "")).strip("'")
    cleaned = _utf16_prefix(replaced, 31).strip("'")
    return cleaned if cleaned.strip() and cleaned.lower() != "history" else "Sheet1"


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
    return min(60, max(8, typical.get(kind, 12), code_points(name) + 2))


def _sheet(
    columns: Sequence[dict[str, Any]], styles: list[int], batches: Rows, running: Running | None = None
) -> Iterator[str]:
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
        if running is not None:
            running.check()
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
    running: Running | None = None,
    sheet_name: str | None = None,
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
        for name, text in _static_parts(_sheet_name(sheet_name), formats).items():
            archive.writestr(name, text)
        with archive.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as sheet:
            for text in _sheet(columns, styles, batches, running):
                sheet.write(text.encode("utf-8"))
