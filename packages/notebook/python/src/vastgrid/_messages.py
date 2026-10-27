"""Messages (docs/v2-spec.md §8): the checks of requests and the error responses, as vastgrid-spec's `checkRequest`
and `errorResponse` make them, so that an engine in Python answers every request as the others do."""

from __future__ import annotations

import re
from typing import Any

from ._json import MAX_SAFE_INTEGER, is_number, is_safe_integer, js_json

PROTOCOL_VERSION = 2

OPERATIONS = (
    "open",
    "info",
    "rows",
    "summarize",
    "find",
    "locate",
    "write",
    "save",
    "export",
    "changes",
    "reload",
    "cancel",
    "close",
)

EXPORT_FORMATS = ("csv", "tsv", "parquet", "json", "xlsx")

TEXT_LIMIT = 1_000_000
DEPTH_LIMIT = 256
ITEMS_LIMIT = 1_000_000
ERROR_TEXT_LIMIT = 1000
ROWS_LIMIT = 1_000_000
CELLS_LIMIT = 1_000_000
TEXT_LIMIT_DEFAULT = 2000
RANGES_LIMIT = 1000
KEYS_LIMIT = 10_000
UPDATES_LIMIT = 100_000

_BASE64 = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

# The members of each request after `v`, `id` and `op`: required and optional.
REQUESTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "open": (("ref",), ("read",)),
    "info": (("table",), ()),
    "rows": (("table", "revision", "plan", "start", "end", "columns"), ("textLimit", "preview")),
    "summarize": (("table", "revision", "plan", "ranges", "columns"), ()),
    "find": (("table", "revision", "plan", "text", "columns", "from", "direction"), ("caseSensitive",)),
    "locate": (("table", "revision", "plan", "keys"), ("rowKey",)),
    "write": (("table", "revision", "updates"), ("rowKey",)),
    "save": (("table",), ()),
    "export": (("table", "revision", "plan", "format"), ("target", "columns", "headers", "numberFormats")),
    "changes": (("table",), ()),
    "reload": (("table",), ()),
    "cancel": (("request",), ()),
    "close": (("table",), ()),
}


class ProtocolError(Exception):
    """A request that does not follow §8 (`invalid_request`); `path` is a JSON Pointer into the request."""

    code = "invalid_request"

    def __init__(self, path: str, reason: str, message: str):
        super().__init__(message)
        self.path = path
        self.reason = reason
        self.message = message


def _longer(text: str, limit: int) -> bool:
    """Whether a text holds more than `limit` code points (a lone surrogate is one, as in JavaScript)."""
    return len(text) > limit


def _step(key: Any) -> str:
    return "/" + str(key).replace("~", "~0").replace("/", "~1")


def fit_path(path: str) -> str:
    """A path beyond the limit of §8.1 (one through a name that is too long) cut to the member that holds the name."""
    while _longer(path, TEXT_LIMIT):
        path = path[: path.rindex("/")]
    return path


def fit_text(text: str, limit: int) -> str:
    """A text cut to `limit` code points, with "…" for what is left out."""
    return text if not _longer(text, limit) else f"{text[: limit - 1]}…"


def quoted(value: Any) -> str:
    """A name or a value as an error's message quotes it: its JSON, cut to 60 code points."""
    return fit_text(js_json(value), 60)


def answer_id(message: Any) -> int | None:
    """The `id` that answers a message (§8.1): its own, or None when it has no valid `id`."""
    value = message.get("id") if isinstance(message, dict) else None
    return int(value) if is_safe_integer(value) and value >= 0 else None


def error_response(
    id: int | None,
    code: str,
    message: str,
    path: str | None = None,
    reason: str | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """An error response (§8.1, §8.7) that follows §8 whatever it quotes of a request."""
    error: dict[str, Any] = {"code": code, "message": fit_text(message, ERROR_TEXT_LIMIT)}
    if path is not None:
        error["path"] = fit_path(path)
    if reason is not None:
        error["reason"] = reason
    if details is not None:
        error["details"] = details
    return {"v": PROTOCOL_VERSION, "id": id, "error": error}


def _fail(path: str, reason: str, message: str):
    raise ProtocolError(fit_path(path), reason, fit_text(message, ERROR_TEXT_LIMIT))


def _bounds(message: Any) -> None:
    """The limits of §8.1 through the whole message: names and strings, levels, items and members."""
    pending: list[tuple[Any, str, int]] = [(message, "", 1)]
    while pending:
        value, path, level = pending.pop()
        if isinstance(value, str):
            if _longer(value, TEXT_LIMIT):
                _fail(path, "limit", "A string holds at most 1,000,000 code points.")
            continue
        if not isinstance(value, (dict, list)):
            continue
        if level > DEPTH_LIMIT:
            _fail(path, "limit", "A message nests at most 256 objects and lists.")
        if len(value) > ITEMS_LIMIT:
            _fail(path, "limit", "A list or an object holds at most 1,000,000 items.")
        if isinstance(value, list):
            pending.extend((child, f"{path}{_step(index)}", level + 1) for index, child in enumerate(value))
            continue
        for key, child in value.items():
            if _longer(key, TEXT_LIMIT):
                _fail(path, "limit", "A name holds at most 1,000,000 code points.")
            pending.append((child, f"{path}{_step(key)}", level + 1))


def _object(value: Any, path: str, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "syntax", f"{what} is an object.")
    return value


def _members(value: dict[str, Any], required: tuple[str, ...], optional: tuple[str, ...], path: str) -> None:
    for key in value:
        if key not in required and key not in optional:
            _fail(f"{path}{_step(key)}", "syntax", f"{quoted(key)} is not a member here.")
    for key in required:
        if key not in value:
            _fail(f"{path}/{key}", "syntax", f'"{key}" is required.')


def _string(value: Any, path: str) -> str:
    if not isinstance(value, str):
        _fail(path, "syntax", "Expected a string.")
    if _longer(value, TEXT_LIMIT):
        _fail(path, "limit", "A string holds at most 1,000,000 code points.")
    return value


def _optional_string(value: dict[str, Any], key: str, path: str) -> None:
    if key in value:
        _string(value[key], path)


def _boolean(value: dict[str, Any], key: str, path: str) -> None:
    if key in value and not isinstance(value[key], bool):
        _fail(path, "syntax", "Expected a boolean.")


def _integer(value: Any, path: str, low: int = 0, high: int = MAX_SAFE_INTEGER) -> int:
    if not is_safe_integer(value) or value < low or value > high:
        _fail(path, "syntax", f"Expected an integer from {low} to {high}.")
    return int(value)


def _names(value: Any, path: str, non_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or (non_empty and len(value) == 0):
        _fail(path, "syntax", "Expected a list of names.")
    return [_string(item, f"{path}/{index}") for index, item in enumerate(value)]


def _choice(value: Any, values: tuple[str, ...], path: str) -> None:
    if not isinstance(value, str) or value not in values:
        _fail(path, "syntax", f"Expected one of {', '.join(values)}.")


def _row_key(value: Any, path: str) -> None:
    """A row key (§5.3), as vastgrid-spec's `checkRowKey`."""
    if not isinstance(value, dict):
        _fail(path, "syntax", "A row key is { rowId } or { value }.")
    if "rowId" in value:
        for key in value:
            if key != "rowId":
                _fail(f"{path}/{key}", "syntax", f'"{key}" is not a member here.')
        row = value["rowId"]
        if not is_safe_integer(row) or row < 0:
            _fail(f"{path}/rowId", "syntax", "A position is an integer from 0.")
        return
    for key in value:
        if key != "value":
            _fail(f"{path}/{key}", "syntax", f'"{key}" is not a member here.')
    key = value.get("value")
    if not isinstance(key, (str, bool)) and not is_number(key):
        _fail(f"{path}/value", "syntax", "A key's value is a string, a number or a boolean.")


def _value(value: Any, path: str) -> None:
    """A value as JSON writes it (§2.2): null, a boolean, a finite number or a string."""
    if value is None or isinstance(value, (str, bool)):
        return
    if is_number(value) and (not isinstance(value, float) or value == value and abs(value) != float("inf")):
        return
    _fail(path, "syntax", "A value is null, a boolean, a number or a string (§2.2).")


def check_request(message: Any) -> dict[str, Any]:
    """Checks that a request follows §8.1 and §8.2, and gives it. Raises `ProtocolError` (`invalid_request`)."""
    request = _object(message, "", "A message")
    if request.get("v") != PROTOCOL_VERSION or isinstance(request.get("v"), bool):
        _fail("/v", "version", "This reader knows messages of version 2.")
    _bounds(request)
    _integer(request.get("id"), "/id")
    op = request.get("op")
    if not isinstance(op, str):
        _fail("/op", "syntax", "op is a string.")
    if op not in OPERATIONS:
        _fail("/op", "unknown_op", f"There is no operation {quoted(op)}.")
    required, optional = REQUESTS[op]
    _members(request, ("v", "id", "op", *required), optional, "")
    if "table" in required:
        _string(request["table"], "/table")
    if "revision" in required and request["revision"] is not None:
        _string(request["revision"], "/revision")
    if "plan" in required:
        _object(request["plan"], "/plan", "plan")
    if op == "open":
        _string(request["ref"], "/ref")
        if "read" in request:
            read = _object(request["read"], "/read", "read")
            _members(read, (), ("sheet", "headerRow", "keepEmptyRows", "keepEmptyColumns"), "/read")
            _optional_string(read, "sheet", "/read/sheet")
            if "headerRow" in read:
                _integer(read["headerRow"], "/read/headerRow")
            _boolean(read, "keepEmptyRows", "/read/keepEmptyRows")
            _boolean(read, "keepEmptyColumns", "/read/keepEmptyColumns")
    elif op == "rows":
        start = _integer(request["start"], "/start")
        end = _integer(request["end"], "/end", start)
        columns = _names(request["columns"], "/columns", False)
        if end - start > ROWS_LIMIT:
            _fail("/end", "limit", "A request reads at most 1,000,000 rows.")
        if (end - start) * len(columns) > CELLS_LIMIT:
            _fail("/columns", "limit", "A request reads at most 1,000,000 cells.")
        if "textLimit" in request:
            _integer(request["textLimit"], "/textLimit", 1, TEXT_LIMIT)
        _boolean(request, "preview", "/preview")
    elif op == "summarize":
        ranges = request["ranges"]
        if not isinstance(ranges, list):
            _fail("/ranges", "syntax", "ranges is a list of [start, end) pairs.")
        if len(ranges) > RANGES_LIMIT:
            _fail("/ranges", "limit", "A request has at most 1,000 ranges.")
        for index, pair in enumerate(ranges):
            at = f"/ranges/{index}"
            if not isinstance(pair, list) or len(pair) != 2:
                _fail(at, "syntax", "A range is [start, end).")
            start = _integer(pair[0], f"{at}/0")
            _integer(pair[1], f"{at}/1", start)
        _names(request["columns"], "/columns")
    elif op == "find":
        _string(request["text"], "/text")
        columns = _names(request["columns"], "/columns")
        start = _object(request["from"], "/from", "from")
        _members(start, ("row", "column"), (), "/from")
        _integer(start["row"], "/from/row")
        _integer(start["column"], "/from/column", 0, len(columns) - 1)
        direction = request["direction"]
        if not is_number(direction) or direction not in (1, -1):
            _fail("/direction", "syntax", "direction is 1 or -1.")
        _boolean(request, "caseSensitive", "/caseSensitive")
    elif op == "locate":
        keys = request["keys"]
        if not isinstance(keys, list):
            _fail("/keys", "syntax", "keys is a list of row keys.")
        if len(keys) > KEYS_LIMIT:
            _fail("/keys", "limit", "A request locates at most 10,000 keys.")
        for index, key in enumerate(keys):
            _row_key(key, f"/keys/{index}")
        _optional_string(request, "rowKey", "/rowKey")
    elif op == "write":
        updates = request["updates"]
        if not isinstance(updates, list):
            _fail("/updates", "syntax", "updates is a list.")
        if len(updates) > UPDATES_LIMIT:
            _fail("/updates", "limit", "A write holds at most 100,000 updates.")
        for index, item in enumerate(updates):
            at = f"/updates/{index}"
            update = _object(item, at, "An update")
            _members(update, ("key", "column", "value"), ("previous",), at)
            _row_key(update["key"], f"{at}/key")
            _string(update["column"], f"{at}/column")
            _value(update["value"], f"{at}/value")
            if "previous" in update:
                _value(update["previous"], f"{at}/previous")
        _optional_string(request, "rowKey", "/rowKey")
    elif op == "export":
        _choice(request["format"], EXPORT_FORMATS, "/format")
        _optional_string(request, "target", "/target")
        columns = _names(request["columns"], "/columns") if "columns" in request else None
        for member in ("headers", "numberFormats"):
            if member not in request:
                continue
            items = request[member]
            if not isinstance(items, list):
                _fail(f"/{member}", "syntax", f"{member} is a list.")
            if columns is not None and len(items) != len(columns):
                _fail(f"/{member}", "syntax", f"{member} has one item per column.")
            for index, item in enumerate(items):
                if member == "numberFormats" and item is None:
                    continue
                _string(item, f"/{member}/{index}")
    elif op == "cancel":
        _integer(request["request"], "/request")
    return request
