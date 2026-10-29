"""Types and values (docs/spec.md §2): how JSON writes them, their text form, and literals. Values are JSON as
Python decodes it; where JavaScript's numbers and strings differ from Python's, the functions here read them as
JavaScript does, so that both implementations agree: `1.0` is the integer 1, numbers print as `String(number)`, and
strings are sequences of code points in which a surrogate pair is one."""

from __future__ import annotations

import base64
import math
import re
import struct
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

from ._calendar import UNIT_DIGITS, parse_interval_text, parse_timestamp_text

LOGICAL_TYPES: tuple[str, ...] = (
    "boolean",
    "integer",
    "bigint",
    "decimal",
    "float",
    "string",
    "date",
    "time",
    "timestamp",
    "timestamptz",
    "interval",
    "uuid",
    "binary",
)
"""Logical types (§2.1)."""

MAX_SAFE_INTEGER = 2**53 - 1
_INT32_MIN = -2147483648
_INT32_MAX = 2147483647
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1

_INTEGER_TEXT = re.compile(r"-?(0|[1-9][0-9]*)")
_DECIMAL_TEXT = re.compile(r"-?(0|[1-9][0-9]*)(?:\.([0-9]+))?")
_UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_BASE64_TEXT = re.compile(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")
_DATE_TEXT = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_TIME_TEXT = re.compile(r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?")
_TIMESTAMP_TEXT = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?")
_SURROGATE = re.compile(r"[\ud800-\udfff]")
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")
# Unicode category Zs, which `trim` removes (§4.4).
_SPACE_SEPARATORS = "                　"
# The white space and line terminators that JavaScript's `Number(text)` ignores around a number.
_JS_SPACE = _SPACE_SEPARATORS + "\t\n\v\f\r  ﻿"
_JS_NUMBER = re.compile(r"[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)")
_JS_RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")
_JSON_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_JSON_ESCAPED = re.compile(r'["\\\x00-\x1f\ud800-\udfff]')
_FLOAT_TOKENS = ("NaN", "Infinity", "-Infinity")


# ----- JavaScript's numbers and strings -----


def is_number(value: Any) -> bool:
    """`typeof value === "number"`: an int or a float, and not a bool."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def js_float(value: int | float) -> float:
    """The JavaScript number of a JSON number: ints beyond floats are infinite, as `JSON.parse` reads them."""
    if isinstance(value, float):
        return value
    try:
        return float(value)
    except OverflowError:
        return math.inf if value > 0 else -math.inf


def is_integer(value: Any) -> bool:
    """`Number.isInteger`."""
    if not is_number(value):
        return False
    number = js_float(value)
    return math.isfinite(number) and number.is_integer()


def is_safe_integer(value: Any) -> bool:
    """`Number.isSafeInteger`."""
    return is_integer(value) and abs(js_float(value)) <= MAX_SAFE_INTEGER


def fround(value: float) -> float:
    """`Math.fround`: the nearest 32-bit float."""
    try:
        return struct.unpack("f", struct.pack("f", value))[0]
    except OverflowError:
        return math.copysign(math.inf, value)


def _digits(magnitude: float) -> tuple[str, int]:
    """The shortest digits that read back as a positive float, without trailing zeros, and the exponent of the
    first."""
    exact = Decimal(repr(magnitude))
    return "".join(map(str, exact.as_tuple().digits)).rstrip("0") or "0", exact.adjusted()


def number_text(value: int | float) -> str:
    """`String(number)`: the shortest digits, in fixed notation from 1e-6 to 1e21 and in exponent notation beyond."""
    number = js_float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    if number.is_integer() and abs(number) <= MAX_SAFE_INTEGER:
        return str(int(number))
    digits, exponent = _digits(abs(number))
    point = exponent + 1
    if len(digits) <= point <= 21:
        body = digits + "0" * (point - len(digits))
    elif 0 < point <= 21:
        body = f"{digits[:point]}.{digits[point:]}"
    elif -6 < point <= 0:
        body = f"0.{'0' * -point}{digits}"
    else:
        mantissa = digits if len(digits) == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"
    return f"-{body}" if number < 0 else body


def number_of_text(text: str) -> float:
    """`Number(text)`: NaN unless the text, without white space around it, is a number (0 when it is empty)."""
    text = text.strip(_JS_SPACE)
    if text == "":
        return 0.0
    if _JS_RADIX.fullmatch(text):
        return js_float(int(text, 0))
    if _JS_NUMBER.fullmatch(text):
        return float(text.replace("Infinity", "inf"))
    return math.nan


def js_string(value: Any) -> str:
    """`String(value)` of a JSON value."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if is_number(value):
        return number_text(value)
    if isinstance(value, (list, tuple)):
        return ",".join("" if item is None else js_string(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def combine_pairs(text: str) -> str:
    """The text with each surrogate pair as the one code point that JavaScript reads; lone surrogates stay."""
    if not _SURROGATE.search(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def code_points(text: str) -> int:
    """The number of code points of a string, as `[...text].length` counts them."""
    return len(combine_pairs(text))


def is_well_formed(text: str) -> bool:
    """Whether a string has no lone surrogates (`String.prototype.isWellFormed`)."""
    return not _SURROGATE.search(text) or not _SURROGATE.search(combine_pairs(text))


def js_keys(value: dict[str, Any]) -> list[str]:
    """`Object.keys`: the keys that are array indexes in ascending order, then the others in their order."""
    indexes = [key for key in value if isinstance(key, str) and _ARRAY_INDEX.fullmatch(key) and int(key) < 2**32 - 1]
    if not indexes:
        return list(value)
    rest = [key for key in value if key not in indexes]
    return sorted(indexes, key=int) + rest


def quote(text: str) -> str:
    """`JSON.stringify` of a string: lone surrogates escaped, other characters as they are."""
    escaped = _JSON_ESCAPED.sub(
        lambda match: _JSON_ESCAPES.get(match[0]) or f"\\u{ord(match[0]):04x}", combine_pairs(text)
    )
    return f'"{escaped}"'


def json_text(value: Any) -> str:
    """`JSON.stringify(value)`: compact, with numbers and members in JavaScript's order and form."""
    if is_number(value):
        return number_text(value) if math.isfinite(js_float(value)) else "null"
    if value is None or isinstance(value, bool):
        return js_string(value)
    if isinstance(value, str):
        return quote(value)
    if isinstance(value, (list, tuple)):
        return f"[{','.join(json_text(item) for item in value)}]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{quote(key)}:{json_text(value[key])}" for key in js_keys(value)) + "}"
    return quote(str(value))


# ----- values (§2.2) -----


def _get(value: dict[str, Any], key: str, default: Any) -> Any:
    """`value.key ?? default`."""
    found = value.get(key)
    return default if found is None else found


def trim_spaces(text: str) -> str:
    """The string without its leading and trailing space separators (Unicode category Zs), as `trim` (§4.4)."""
    return text.strip(_SPACE_SEPARATORS)


def _is_leap_year(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _is_day(year: int, month: int, day: int) -> bool:
    if month < 1 or month > 12 or day < 1:
        return False
    return day <= (29 if month == 2 and _is_leap_year(year) else _MONTH_DAYS[month - 1])


def _is_date(year: str, month: str, day: str) -> bool:
    return year != "0000" and _is_day(int(year), int(month), int(day))


def _is_time(hour: str, minute: str, second: str, fraction: str | None, digits: int) -> bool:
    if int(hour) >= 24 or int(minute) >= 60 or int(second) >= 60:
        return False
    # Fractions have no trailing zeros (§2.2).
    return fraction is None or (len(fraction) <= digits and not fraction.endswith("0"))


def is_date_text(text: str) -> bool:
    """Whether the text is a date as §2.2 writes it: `YYYY-MM-DD`, naming a real day."""
    match = _DATE_TEXT.fullmatch(text)
    return match is not None and _is_date(*match.groups())


def is_time_text(text: str, digits: int = 6) -> bool:
    """Whether the text is a time as §2.2 writes it, with at most `digits` digits after the point."""
    match = _TIME_TEXT.fullmatch(text)
    return match is not None and _is_time(*match.groups(), digits)


def _is_timestamp(text: str, digits: int) -> bool:
    match = _TIMESTAMP_TEXT.fullmatch(text)
    return match is not None and _is_date(*match.groups()[:3]) and _is_time(*match.groups()[3:], digits)


def is_timestamp_text(text: str, unit: str | None = "us") -> bool:
    """Whether the text is a timestamp as §2.2 writes it, for a unit."""
    unit = unit or "us"
    return _is_timestamp(text, UNIT_DIGITS[unit]) and (unit != "ns" or parse_timestamp_text(text, unit) is not None)


def decimal_text_type(text: str) -> dict[str, int] | None:
    """The precision and scale of a decimal written as text (§2.5), or None when the text is not a decimal."""
    match = _DECIMAL_TEXT.fullmatch(text)
    if not match:
        return None
    scale = len(match[2] or "")
    integer_digits = 0 if match[1] == "0" else len(match[1])
    precision = max(1, integer_digits + scale)
    return None if precision > 38 else {"precision": precision, "scale": scale}


def is_value_of(value: Any, type: dict[str, Any]) -> bool:
    """Whether a JSON value is a value of the type, written as §2.2 writes it. None is a value of every type."""
    if value is None:
        return True
    kind = type["type"]
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return is_integer(value) and _INT32_MIN <= js_float(value) <= _INT32_MAX
    if kind == "bigint":
        if is_number(value):
            return is_safe_integer(value)
        return (
            isinstance(value, str)
            and _INTEGER_TEXT.fullmatch(value) is not None
            and (_INT64_MIN <= int(value) <= _INT64_MAX)
        )
    if kind == "decimal":
        if not isinstance(value, str):
            return False
        found = decimal_text_type(value)
        scale = _get(type, "scale", 0)
        return (
            found is not None
            and found["scale"] == scale
            and found["precision"] - found["scale"] <= _get(type, "precision", 38) - scale
        )
    if kind == "float":
        if is_number(value):
            number = js_float(value)
            return math.isfinite(number) and (type.get("bits") != 32 or fround(number) == number)
        return value in _FLOAT_TOKENS
    if not isinstance(value, str):
        return False
    if kind == "string":
        return is_well_formed(value)
    if kind == "interval":
        return parse_interval_text(value) is not None
    if kind == "date":
        return is_date_text(value)
    if kind == "time":
        return is_time_text(value)
    if kind == "timestamp":
        return is_timestamp_text(value, type.get("unit"))
    if kind == "timestamptz":
        return value.endswith("+00") and _is_timestamp(value[:-3], UNIT_DIGITS["us"])
    if kind == "uuid":
        return _UUID_TEXT.fullmatch(value) is not None
    if kind == "binary":
        return _BASE64_TEXT.fullmatch(value) is not None
    return False


def same_type(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two types are the same, members included."""
    if a["type"] != b["type"]:
        return False
    if a["type"] == "decimal":
        return a.get("precision") == b.get("precision") and a.get("scale") == b.get("scale")
    if a["type"] == "float":
        return _get(a, "bits", 64) == _get(b, "bits", 64)
    if a["type"] == "timestamp":
        return _get(a, "unit", "us") == _get(b, "unit", "us")
    return True


def type_name(type: dict[str, Any]) -> str:
    """A type as people read it: `decimal(10, 2)`, `float(32)`, `timestamp(ns)`."""
    kind = type["type"]
    if kind == "decimal":
        return f"decimal({number_text(_get(type, 'precision', 38))}, {number_text(_get(type, 'scale', 0))})"
    if kind == "float":
        return "float(32)" if type.get("bits") == 32 else "float"
    if kind == "timestamp":
        unit = type.get("unit")
        return f"timestamp({unit})" if unit and unit != "us" else "timestamp"
    return kind


def _exponential(magnitude: float, digits: int, other: bool = False) -> Decimal:
    """The exact value rounded to `digits` digits, halves to even, as DuckDB's `printf` rounds it; with `other`,
    rounded the other way."""
    exact = Decimal(magnitude)
    unit = Decimal(1).scaleb(exact.adjusted() - digits + 1)
    rounded = exact.quantize(unit, rounding=ROUND_HALF_EVEN)
    if not other:
        return rounded
    return rounded + unit if rounded < exact else rounded - unit


def _shortest_digits(magnitude: float, bits: int) -> tuple[str, int]:
    """The shortest digits and exponent of a float that read back as the same float of its bits (§2.4.1); of two that
    are as short, the nearer, and of two as near, the even one."""
    if bits == 32:
        for count in range(1, 10):
            # At a power of two the float below is nearer than the float above, so the nearer digits can read back
            # as the float below while the others read back as this one.
            for other in (False, True):
                candidate = _exponential(magnitude, count, other)
                if fround(float(candidate)) == magnitude:
                    return "".join(map(str, candidate.as_tuple().digits)).rstrip("0") or "0", candidate.adjusted()
    return _digits(magnitude)


def float_text(value: int | float, bits: int = 64) -> str:
    """The text form of a float (§2.4.1): the shortest digits that read back as the same float of `bits`, in fixed
    notation when the exponent is from −4 to 15 and in exponent notation otherwise, as Python's `repr` and DuckDB's
    `CAST(x AS VARCHAR)` write it."""
    number = js_float(value)
    if math.isnan(number):
        return "nan"
    if number == 0:
        return "-0.0" if math.copysign(1, number) < 0 else "0.0"
    if bits == 32:
        number = fround(number)
    if math.isinf(number):
        return "inf" if number > 0 else "-inf"
    sign = "-" if number < 0 else ""
    digits, exponent = _shortest_digits(abs(number), bits)
    if -4 <= exponent < 16:
        if exponent < 0:
            return f"{sign}0.{'0' * (-exponent - 1)}{digits}"
        whole = digits[: exponent + 1].ljust(exponent + 1, "0")
        return f"{sign}{whole}.{digits[exponent + 1 :] or '0'}"
    mantissa = f"{digits[0]}.{digits[1:]}" if len(digits) > 1 else digits
    return f"{sign}{mantissa}e{'-' if exponent < 0 else '+'}{str(abs(exponent)).rjust(2, '0')}"


def _json_number(number: float) -> int | float:
    """A JavaScript number as Python's JSON writes it: an int when it is a safe integer."""
    return int(number) if math.isfinite(number) and number.is_integer() and abs(number) <= MAX_SAFE_INTEGER else number


def value_of_text(text: str | None, type: dict[str, Any]) -> Any:
    """The typed JSON of a value given its text form (§2.4), for example the values of a pivot's combination."""
    if text is None:
        return None
    kind = type["type"]
    if kind == "boolean":
        return text == "true"
    if kind == "integer":
        return _json_number(number_of_text(text))
    if kind == "bigint":
        number = number_of_text(text)
        return _json_number(number) if is_safe_integer(number) else text
    if kind == "float":
        if text == "nan":
            return "NaN"
        if text == "inf":
            return "Infinity"
        if text == "-inf":
            return "-Infinity"
        number = number_of_text(text)
        return fround(number) if type.get("bits") == 32 else number
    return text


def float_of(value: Any) -> float:
    """The number of a float written as JSON (§2.2): a number, or one of `NaN`, `Infinity` and `-Infinity`."""
    if is_number(value):
        return js_float(value)
    if value == "NaN":
        return math.nan
    if value == "Infinity":
        return math.inf
    if value == "-Infinity":
        return -math.inf
    raise TypeError(f"{json_text(value)} is not a float.")


def float_json(value: float) -> float | str:
    """The JSON of a float (§2.2)."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def to_base64(data: bytes) -> str:
    """Bytes as base64 (RFC 4648, with padding)."""
    return base64.b64encode(data).decode("ascii")


def from_base64(text: str) -> bytes:
    """The bytes of base64 text, as `atob` reads it: white space is left out and padding is optional."""
    text = re.sub(r"[\t\n\f\r ]", "", text)
    if len(text) % 4 == 0 and text.endswith("="):
        text = text[:-2] if text.endswith("==") else text[:-1]
    if len(text) % 4 == 1 or not re.fullmatch(r"[A-Za-z0-9+/]*", text):
        raise ValueError("The text is not base64.")
    return base64.b64decode(text + "=" * (-len(text) % 4))


def _bytes_text(data: bytes) -> str:
    """DuckDB's text of bytes: printable ASCII as it is, and `\\xHH` for a backslash and the other bytes."""
    return "".join(chr(byte) if 0x20 <= byte <= 0x7E and byte != 0x5C else f"\\x{byte:02X}" for byte in data)


def text_of(value: Any, type: dict[str, Any]) -> str | None:
    """The text form of a value (§2.4), or None for null."""
    if value is None:
        return None
    kind = type["type"]
    if kind == "boolean":
        return "true" if value is True else "false"
    if kind == "float":
        return float_text(float_of(value), _get(type, "bits", 64))
    if kind == "binary":
        return _bytes_text(from_base64(js_string(value)))
    return js_string(value)


def _big_int(value: Any) -> int:
    """`BigInt(value)` of a number or a string."""
    if is_number(value) or isinstance(value, bool):
        if not is_integer(value) and not isinstance(value, bool):
            raise ValueError(f"{json_text(value)} is not an integer.")
        return int(js_float(value))
    text = str(value).strip(_JS_SPACE)
    if text == "":
        return 0
    if _JS_RADIX.fullmatch(text):
        return int(text, 0)
    if re.fullmatch(r"[+-]?[0-9]+", text):
        return int(text)
    raise ValueError(f"{json_text(value)} is not an integer.")


def _strict_equal(a: Any, b: Any) -> bool:
    """`a === b` of JSON values."""
    if is_number(a) and is_number(b):
        return js_float(a) == js_float(b)
    return type(a) is type(b) and a == b


def same_cell_value(a: Any, b: Any, type: dict[str, Any]) -> bool:
    """Whether two values of a type are the same value (§3.1), whichever JSON writes them (§2.2)."""
    if a is None or b is None:
        return a is None and b is None
    if type["type"] in ("integer", "bigint"):
        return _big_int(a) == _big_int(b)
    if type["type"] == "float":
        x = float_of(a)
        y = float_of(b)
        return math.isnan(y) if math.isnan(x) else x == y
    return _strict_equal(a, b)


def key_text(key: dict[str, Any]) -> str:
    """A row key (§5.3) written so that keys that are the same have the same text."""
    from ._hash import canonical_json

    if "rowId" in key:
        return canonical_json({"rowId": key["rowId"]})
    value = key.get("value")
    if isinstance(value, str) and _INTEGER_TEXT.fullmatch(value) and is_safe_integer(number_of_text(value)):
        return canonical_json({"value": int(value)})
    return canonical_json({"value": value} if "value" in key else {})
