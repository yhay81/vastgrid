"""JSON as JavaScript writes it (`JSON.stringify`, `String(number)`), for texts that both languages must write alike:
the messages of errors (§8.1) quote values of requests."""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1

_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def is_number(value: Any) -> bool:
    """Whether a value is a JSON number, as `typeof value === "number"` (a `bool` is not one)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_safe_integer(value: Any) -> bool:
    """`Number.isSafeInteger`: JSON's `1.0` is the integer 1 in JavaScript."""
    if not is_number(value):
        return False
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer() and abs(value) <= MAX_SAFE_INTEGER
    return abs(value) <= MAX_SAFE_INTEGER


def js_number(value: float | int) -> str:
    """`String(number)`: the shortest digits, in fixed notation from 1e-6 to 1e21 and in exponent notation beyond."""
    if isinstance(value, int) and abs(value) <= MAX_SAFE_INTEGER:
        return str(value)
    number = float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    sign, digits, exponent = Decimal(repr(number)).normalize().as_tuple()
    text = "".join(map(str, digits))
    # The number is 0.text × 10^point.
    point = len(text) + exponent
    if len(text) <= point <= 21:
        body = text + "0" * (point - len(text))
    elif 0 < point <= 21:
        body = f"{text[:point]}.{text[point:]}"
    elif -6 < point <= 0:
        body = f"0.{'0' * -point}{text}"
    else:
        mantissa = text[0] if len(text) == 1 else f"{text[0]}.{text[1:]}"
        power = point - 1
        body = f"{mantissa}e{'+' if power >= 0 else '-'}{abs(power)}"
    return f"-{body}" if sign else body


def _string(text: str) -> str:
    quoted = json.dumps(text, ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


def js_json(value: Any) -> str:
    """`JSON.stringify(value)`: compact, numbers as JavaScript writes them, lone surrogates escaped."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if is_number(value):
        return js_number(value) if math.isfinite(value) else "null"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, dict):
        return "{" + ",".join(f"{_string(str(key))}:{js_json(item)}" for key, item in value.items()) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    return _string(str(value))
