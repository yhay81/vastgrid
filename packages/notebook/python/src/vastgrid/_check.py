"""Checking a plan against a table's columns (docs/spec.md §4.7): its form, its names, the types of its expressions
(§3.7, §4.4, §4.5) and its limits (§4.9). The checked plan is a typed tree that engines run. Plans, columns and types
are JSON (dicts); the checked tree is made of dataclasses."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, NoReturn

from ._plan import FUNCTIONS, LIMITS, MEASURES, PlanError
from ._values import (
    LOGICAL_TYPES,
    code_points,
    decimal_text_type,
    is_integer,
    is_number,
    is_safe_integer,
    is_value_of,
    is_well_formed,
    js_float,
    js_keys,
    json_text,
    number_text,
    same_type,
    trim_spaces,
    type_name,
)

Column = dict[str, Any]
ValueType = dict[str, Any]


@dataclass
class ColumnExpr:
    name: str
    type: ValueType
    kind: str = field(default="column", init=False)


@dataclass
class LiteralExpr:
    """A literal; its type is `{"type": "null"}` while it is an untyped null that no place gave a type (§2.5)."""

    value: Any
    type: ValueType
    kind: str = field(default="literal", init=False)


@dataclass
class CallExpr:
    fn: str
    args: list[TypedExpr]
    type: ValueType
    kind: str = field(default="call", init=False)


@dataclass
class SearchExpr:
    """The search of §3.5, over the table's own columns."""

    text: str
    columns: list[Column]
    type: ValueType
    kind: str = field(default="search", init=False)


TypedExpr = ColumnExpr | LiteralExpr | CallExpr | SearchExpr
"""A checked expression: every node knows its type."""


@dataclass
class CheckedDerived:
    name: str
    expr: TypedExpr
    column: Column


@dataclass
class CheckedMeasure:
    name: str
    fn: str
    column: Column | None
    """The measured column; None for `count` of rows."""
    p: float | int | None
    """`quantile`'s `p`."""
    approx: bool
    type: ValueType


@dataclass
class CheckedPivot:
    columns: list[Column]
    max_columns: int


@dataclass
class CheckedAggregate:
    keys: list[Column]
    measures: list[CheckedMeasure]
    pivot: CheckedPivot | None


@dataclass
class CheckedSortKey:
    column: Column
    direction: str


@dataclass
class CheckedPlan:
    """A plan checked against a table (§4.7)."""

    plan: dict[str, Any]
    """The plan as given."""
    table: list[Column]
    derive: list[CheckedDerived]
    rows: list[Column]
    """The columns of the rows before grouping: the table's, then the derived ones."""
    where: TypedExpr | None
    aggregate: CheckedAggregate | None
    having: TypedExpr | None
    sort: list[CheckedSortKey]
    columns: list[Column]
    """The view's columns (§4.2). For a pivot, only the keys: the generated columns come from the data."""
    row_ids: bool
    """Views without `aggregate` have row IDs."""


@dataclass
class CheckOptions:
    """What an engine evaluates (§4.10); everything by default. `plan` maps members such as `"search"` to False."""

    functions: Sequence[str] | None = None
    measures: Sequence[str] | None = None
    plan: Mapping[str, bool] | None = None


def plan_options(capabilities: Mapping[str, Any] | None = None) -> CheckOptions:
    """The options of `check_plan` for an engine's capabilities (§4.10, JSON): everything without them."""
    if not capabilities:
        return CheckOptions()
    return CheckOptions(capabilities.get("functions"), capabilities.get("measures"), capabilities.get("plan"))


def _options(options: CheckOptions | Mapping[str, Any] | None) -> CheckOptions:
    if options is None:
        return CheckOptions()
    if isinstance(options, CheckOptions):
        return options
    return CheckOptions(options.get("functions"), options.get("measures"), options.get("plan"))


BOOLEAN: ValueType = {"type": "boolean"}
INTEGER: ValueType = {"type": "integer"}
BIGINT: ValueType = {"type": "bigint"}
FLOAT: ValueType = {"type": "float"}
STRING: ValueType = {"type": "string"}
DATE: ValueType = {"type": "date"}
TIMESTAMP: ValueType = {"type": "timestamp"}

_ORDERABLE = frozenset(
    ("integer", "bigint", "decimal", "float", "string", "boolean", "date", "time", "timestamp", "timestamptz", "uuid")
)
_TEMPORAL = frozenset(("date", "time", "timestamp", "timestamptz"))
_MISSING = object()
_FRACTION = re.compile(r"\.([0-9]+)\Z")


def _is_number(type: ValueType) -> bool:
    return type["type"] in ("integer", "bigint", "decimal", "float")


def _is_whole(type: ValueType) -> bool:
    return type["type"] in ("integer", "bigint")


def _is_date_like(type: ValueType) -> bool:
    return type["type"] in ("date", "timestamp")


def _is_null(type: ValueType) -> bool:
    return type["type"] == "null"


def _comparable(a: ValueType, b: ValueType) -> bool:
    """Values of these types can be compared with each other (§3.1)."""
    if _is_number(a) and _is_number(b):
        return True
    if _is_date_like(a) and _is_date_like(b):
        return True
    return a["type"] == b["type"]


def _decimal(precision: int, scale: int) -> ValueType:
    return {"type": "decimal", "precision": precision, "scale": scale}


def _member(type: ValueType, key: str, default: Any) -> Any:
    value = type.get(key)
    return default if value is None else value


def _decimal_shape(type: ValueType) -> tuple[int, int]:
    """Precision and scale of an exact number when it meets a decimal (§3.7)."""
    if type["type"] == "integer":
        return 10, 0
    if type["type"] == "bigint":
        return 19, 0
    return _member(type, "precision", 38), _member(type, "scale", 0)


def _holds_exact(type: ValueType, value: float) -> bool:
    """Whether an exact type holds a number: its digits (as `String` writes them) fit its scale and range."""
    text = number_text(value)
    if "e" in text.lower():
        return False
    whole, _, fraction = text.partition(".")
    if type["type"] == "integer":
        return fraction == "" and value <= 2147483647
    if type["type"] == "bigint":
        return fraction == "" and int(whole) <= 9223372036854775807
    precision, scale = _decimal_shape(type)
    return len(fraction) <= scale and len(whole.lstrip("0")) <= precision - scale


def arithmetic_type(fn: str, a: ValueType, b: ValueType) -> ValueType:
    """The type of `add`, `sub`, `mul`, `div` or `mod` on two numbers (§3.7)."""
    if fn == "div" or a["type"] == "float" or b["type"] == "float":
        return FLOAT
    if _is_whole(a) and _is_whole(b):
        return BIGINT
    xp, xs = _decimal_shape(a)
    yp, ys = _decimal_shape(b)
    scale = max(xs, ys)
    whole = max(xp - xs, yp - ys)
    if fn in ("add", "sub"):
        return _decimal(min(38, whole + scale + 1), scale)
    if fn == "mul":
        return FLOAT if xs + ys > 38 else _decimal(min(38, xp + yp), xs + ys)
    return _decimal(min(38, whole + scale), scale)


def _measure_type(fn: str, column: Column | None) -> ValueType:
    """The type of a measure (§3.8, §4.5)."""
    if fn in ("count", "count_distinct"):
        return BIGINT
    if fn == "sum":
        if column is None:
            return BIGINT
        if _is_whole(column):
            return _decimal(38, 0)
        if column["type"] == "decimal":
            return _decimal(38, _member(column, "scale", 0))
        return FLOAT
    if fn in ("avg", "stddev"):
        return FLOAT
    if fn == "quantile":
        if column is not None and column["type"] in ("date", "timestamp"):
            return TIMESTAMP
        return {"type": column["type"]} if column is not None and column["type"] in _TEMPORAL else FLOAT
    return value_type(column) if column else BIGINT


def value_type(column: ValueType) -> ValueType:
    """A column's type without its other members."""
    type: ValueType = {"type": column["type"]}
    if "precision" in column:
        type["precision"] = column["precision"]
    if "scale" in column:
        type["scale"] = column["scale"]
    if "bits" in column and column["bits"] != 64:
        type["bits"] = column["bits"]
    if "unit" in column and column["unit"] != "us":
        type["unit"] = column["unit"]
    return type


def _child(path: str, key: str | int) -> str:
    """The JSON Pointer of a member."""
    return f"{path}/{str(key).replace('~', '~0').replace('/', '~1')}"


def _fail(path: str, reason: str, message: str) -> NoReturn:
    raise PlanError(path, reason, message)


def _members(value: dict[str, Any], allowed: Sequence[str], path: str) -> None:
    for key in js_keys(value):
        if key not in allowed:
            _fail(_child(path, key), "syntax", f'"{key}" is not a member here.')


def _name_of(value: Any, path: str) -> str:
    if not isinstance(value, str):
        _fail(path, "syntax", "A name is a string.")
    if not 1 <= code_points(value) <= LIMITS.name:
        _fail(path, "syntax", f"A name has 1 to {LIMITS.name} characters.")
    return value


def _settle(node: TypedExpr, type: ValueType) -> None:
    if isinstance(node, LiteralExpr) and _is_null(node.type):
        node.type = type


def _describe_count(low: int, high: float) -> str:
    if low == high:
        return f"{low}"
    return f"{low} or more" if high == math.inf else f"{low} to {high}"


class _Checker:
    def __init__(self, table: Sequence[Column], options: CheckOptions) -> None:
        self.table = list(table)
        self.options = options
        self.in_literals = 0
        self.searched = False
        self.nodes = 0
        self.root = ""

    def member(self, name: str, path: str) -> None:
        if self.options.plan is not None and self.options.plan.get(name) is False:
            _fail(path, "unsupported", f"This engine does not evaluate {name}.")

    def expression(self, node: Any, scope: Mapping[str, Column], path: str, place: str) -> TypedExpr:
        """Checks one expression of the plan (a derived column, `where` or `having`)."""
        self.nodes = 0
        self.root = path
        return self._visit(node, scope, path, place, 1)

    def _visit(self, node: Any, scope: Mapping[str, Column], path: str, place: str, depth: int) -> TypedExpr:
        if depth > LIMITS.depth:
            _fail(path, "limit", f"An expression is nested at most {LIMITS.depth} levels deep.")
        self.nodes += 1
        if self.nodes > LIMITS.nodes:
            _fail(self.root, "limit", f"An expression has at most {LIMITS.nodes} nodes.")
        if not isinstance(node, dict):
            _fail(path, "syntax", "An expression is an object: { col }, { lit }, { fn, args } or { search }.")
        if "col" in node:
            _members(node, ("col",), path)
            name = _name_of(node["col"], _child(path, "col"))
            column = scope.get(name)
            if column is None:
                _fail(path, "unknown_column", f'There is no column "{name}" here.')
            return ColumnExpr(name, value_type(column))
        if "lit" in node:
            _members(node, ("lit", "type"), path)
            return self._literal(node["lit"], node.get("type", _MISSING), path)
        if "search" in node:
            _members(node, ("search",), path)
            return self._search(node["search"], path, place)
        if "fn" in node:
            _members(node, ("fn", "args"), path)
            fn = node["fn"]
            if not isinstance(fn, str):
                _fail(_child(path, "fn"), "syntax", "A function's name is a string.")
            if fn not in FUNCTIONS:
                _fail(path, "unknown_function", f'There is no function "{fn}".')
            if self.options.functions is not None and fn not in self.options.functions:
                _fail(path, "unsupported", f"This engine does not evaluate {fn}.")
            raw = node.get("args")
            args_path = _child(path, "args")
            if not isinstance(raw, list):
                _fail(args_path, "syntax", "A function's arguments are an array.")
            args = [
                self._visit(arg, scope, _child(args_path, index), place, depth + 1) for index, arg in enumerate(raw)
            ]
            return CallExpr(fn, args, self._call(fn, args, path))
        _fail(path, "syntax", "An expression is an object: { col }, { lit }, { fn, args } or { search }.")

    def _literal(self, value: Any, declared: Any, path: str) -> TypedExpr:
        if value is not None and not isinstance(value, (str, bool)) and not is_number(value):
            _fail(_child(path, "lit"), "syntax", "A literal is a string, a number, a boolean or null.")
        if declared is _MISSING:
            if value is None:
                return LiteralExpr(value, {"type": "null"})
            if isinstance(value, bool):
                return LiteralExpr(value, BOOLEAN)
            if isinstance(value, str):
                if not is_value_of(value, STRING):
                    _fail(path, "literal", "A string literal is well-formed Unicode text.")
                return LiteralExpr(value, STRING)
            if not math.isfinite(js_float(value)):
                _fail(path, "literal", "A number literal is finite; write NaN with type float.")
            return LiteralExpr(value, BIGINT if is_safe_integer(value) else FLOAT)
        if not isinstance(declared, str) or declared not in LOGICAL_TYPES:
            _fail(_child(path, "type"), "syntax", f"There is no type {json_text(declared)}.")
        if value is None:
            return LiteralExpr(value, _decimal(38, 0) if declared == "decimal" else {"type": declared})
        if declared == "decimal":
            found = decimal_text_type(value) if isinstance(value, str) else None
            if found is None:
                _fail(path, "literal", f'{json_text(value)} is not a decimal written as digits, such as "12.50".')
            return LiteralExpr(value, _decimal(found["precision"], found["scale"]))
        literal_type: ValueType = {"type": declared}
        if declared == "timestamp" and isinstance(value, str):
            fraction = _FRACTION.search(value)
            literal_type = {"type": declared, "unit": "ns"} if fraction and len(fraction[1]) > 6 else TIMESTAMP
        if not is_value_of(value, literal_type):
            _fail(path, "literal", f"{json_text(value)} is not a {declared} value.")
        return LiteralExpr(value, literal_type)

    def _search(self, text: Any, path: str, place: str) -> TypedExpr:
        self.member("search", path)
        if not isinstance(text, str):
            _fail(_child(path, "search"), "syntax", "A search is a string.")
        if not is_well_formed(text):
            _fail(_child(path, "search"), "literal", "A search is well-formed Unicode text.")
        if place != "where" or self.searched:
            _fail(path, "misplaced", "A plan can search once, in where.")
        if trim_spaces(text) == "":
            _fail(path, "literal", "A search needs text other than spaces.")
        self.searched = True
        return SearchExpr(text, list(self.table), BOOLEAN)

    def _want(
        self, arg: TypedExpr, path: str, accepts: Callable[[ValueType], bool], kind: str, otherwise: ValueType
    ) -> None:
        """A value of the kind a function takes: an untyped null takes `otherwise`."""
        if _is_null(arg.type):
            _settle(arg, otherwise)
            return
        if not accepts(arg.type):
            _fail(path, "type", f"Expected {kind}, not {type_name(arg.type)}.")

    def _common(self, args: list[TypedExpr], path: str) -> ValueType:
        """The common type of several values (§4.4), given to their untyped nulls."""
        result: ValueType | None = None
        for arg in args:
            if _is_null(arg.type):
                continue
            type = arg.type
            if result is None or same_type(result, type):
                result = result or type
            elif _is_number(result) and _is_number(type):
                result = FLOAT if "float" in (result["type"], type["type"]) else arithmetic_type("add", result, type)
            elif _is_date_like(result) and _is_date_like(type):
                result = result if result["type"] == "timestamp" else type
            else:
                _fail(path, "type", f"{type_name(result)} and {type_name(type)} have no common type.")
        if result is None:
            _fail(path, "type", "The type of these values cannot be decided: give a null literal a type.")
        for arg in args:
            _settle(arg, result)
        return result

    def _numbers(self, fn: str, args: list[TypedExpr], path: str) -> tuple[ValueType, ValueType]:
        """Two numbers, whose untyped nulls take the other's type."""
        a, b = args
        if _is_null(a.type) and _is_null(b.type):
            _fail(path, "type", f"The types of {fn}'s arguments cannot be decided.")
        _settle(a, b.type)
        _settle(b, a.type)
        for index, arg in enumerate(args):
            self._want(arg, _child(_child(path, "args"), index), _is_number, "a number", FLOAT)
        return a.type, b.type

    def _call(self, fn: str, args: list[TypedExpr], path: str) -> ValueType:
        def at(index: int) -> str:
            return _child(_child(path, "args"), index)

        def arity(low: int, high: float | None = None) -> None:
            high = low if high is None else high
            if len(args) < low or len(args) > high:
                _fail(path, "arity", f"{fn} takes {_describe_count(low, high)} arguments, not {len(args)}.")

        def is_boolean(type: ValueType) -> bool:
            return type["type"] == "boolean"

        def is_string(type: ValueType) -> bool:
            return type["type"] == "string"

        def strings() -> None:
            for index, arg in enumerate(args):
                self._want(arg, at(index), is_string, "a string", STRING)

        def whole_number(index: int) -> None:
            self._want(args[index], at(index), _is_whole, "an integer", BIGINT)

        def number(index: int) -> ValueType:
            self._want(args[index], at(index), _is_number, "a number", FLOAT)
            return args[index].type

        if fn in ("and", "or"):
            arity(2, math.inf)
            for index, arg in enumerate(args):
                self._want(arg, at(index), is_boolean, "a boolean", BOOLEAN)
            return BOOLEAN
        if fn == "not":
            arity(1)
            self._want(args[0], at(0), is_boolean, "a boolean", BOOLEAN)
            return BOOLEAN
        if fn in ("eq", "ne", "lt", "le", "gt", "ge"):
            arity(2)
            a, b = args
            if _is_null(a.type) and _is_null(b.type):
                _fail(path, "type", "The type of a comparison of two nulls cannot be decided.")
            _settle(a, b.type)
            _settle(b, a.type)
            if not _comparable(a.type, b.type):
                _fail(path, "type", f"{type_name(a.type)} and {type_name(b.type)} values cannot be compared.")
            return BOOLEAN
        if fn == "in":
            arity(2, math.inf)
            value, items = args[0], args[1:]
            for index, item in enumerate(items):
                if not isinstance(item, LiteralExpr) or item.value is None:
                    _fail(at(index + 1), "type", "The values of in are literals other than null.")
            _settle(value, items[0].type)
            for index, item in enumerate(items):
                if not _comparable(value.type, item.type):
                    _fail(
                        at(index + 1),
                        "type",
                        f"{type_name(item.type)} cannot be compared with {type_name(value.type)}.",
                    )
            self.in_literals += len(items)
            if self.in_literals > LIMITS.in_literals:
                _fail(path, "limit", f"A plan has at most {LIMITS.in_literals} values of in.")
            return BOOLEAN
        if fn in ("is_null", "is_blank"):
            arity(1)
            return BOOLEAN
        if fn == "if":
            arity(3)
            self._want(args[0], at(0), is_boolean, "a boolean", BOOLEAN)
            return self._common(args[1:], path)
        if fn == "coalesce":
            arity(1, math.inf)
            return self._common(args, path)
        if fn in ("least", "greatest"):
            arity(2, math.inf)
            type = self._common(args, path)
            if type["type"] not in _ORDERABLE:
                _fail(path, "type", f"{type_name(type)} values have no order.")
            return type
        if fn in ("add", "sub", "mul", "div", "mod"):
            arity(2)
            a, b = self._numbers(fn, args, path)
            return arithmetic_type(fn, a, b)
        if fn in ("neg", "abs"):
            arity(1)
            type = number(0)
            return FLOAT if type["type"] == "float" else value_type(type)
        if fn == "round":
            arity(1, 2)
            number(0)
            digits = 0
            if len(args) == 2:
                node = args[1]
                if not isinstance(node, LiteralExpr) or not is_integer(node.value):
                    _fail(at(1), "type", "round's digits are an integer literal.")
                digits = int(js_float(node.value))
                if digits < -18 or digits > 18:
                    _fail(at(1), "type", "round's digits are from -18 to 18.")
            type = args[0].type
            if type["type"] == "float":
                return FLOAT
            if type["type"] == "decimal":
                return _decimal(_member(type, "precision", 38), min(_member(type, "scale", 0), max(digits, 0)))
            return value_type(type)
        if fn in ("floor", "ceil"):
            arity(1)
            type = number(0)
            if type["type"] == "float":
                return FLOAT
            if type["type"] == "decimal":
                return _decimal(_member(type, "precision", 38), 0)
            return value_type(type)
        if fn == "bin":
            arity(2)
            type = number(0)
            width = args[1]
            if not isinstance(width, LiteralExpr) or not is_number(width.value) or not js_float(width.value) > 0:
                _fail(at(1), "type", "bin's width is a positive number literal.")
            value = js_float(width.value)
            if not math.isfinite(value) or (type["type"] != "float" and not _holds_exact(type, value)):
                _fail(at(1), "type", "bin's width is a value of the number's type.")
            return FLOAT if type["type"] == "float" else value_type(type)
        if fn in ("sqrt", "exp", "ln", "log10"):
            arity(1)
            number(0)
            return FLOAT
        if fn == "power":
            arity(2)
            self._numbers(fn, args, path)
            return FLOAT
        if fn == "sign":
            arity(1)
            number(0)
            return INTEGER
        if fn == "to_number":
            arity(1)
            strings()
            return FLOAT
        if fn == "concat":
            arity(1, math.inf)
            for arg in args:
                _settle(arg, STRING)
            return STRING
        if fn == "length":
            arity(1)
            strings()
            return BIGINT
        if fn in ("lower", "upper", "trim"):
            arity(1)
            strings()
            return STRING
        if fn in ("left", "right"):
            arity(2)
            self._want(args[0], at(0), is_string, "a string", STRING)
            whole_number(1)
            return STRING
        if fn == "substr":
            arity(2, 3)
            self._want(args[0], at(0), is_string, "a string", STRING)
            for index in range(1, len(args)):
                whole_number(index)
            return STRING
        if fn == "replace":
            arity(3)
            strings()
            return STRING
        if fn in ("contains", "starts_with", "ends_with"):
            arity(2)
            strings()
            return BOOLEAN
        if fn == "text":
            arity(1)
            _settle(args[0], STRING)
            return STRING
        if fn == "to_date":
            arity(1)
            strings()
            return DATE
        if fn == "to_timestamp":
            arity(1)
            strings()
            return TIMESTAMP
        if fn in ("year", "month", "day", "isodow"):
            arity(1)
            self._want(args[0], at(0), _is_date_like, "a date or a timestamp", DATE)
            return BIGINT
        if fn in ("hour", "minute", "second"):
            arity(1)
            self._want(
                args[0], at(0), lambda type: type["type"] in ("time", "timestamp"), "a time or a timestamp", TIMESTAMP
            )
            return BIGINT
        if fn == "date_diff_days":
            arity(2)
            for index, arg in enumerate(args):
                self._want(arg, at(index), _is_date_like, "a date or a timestamp", DATE)
            return BIGINT
        # add_days
        arity(2)
        self._want(args[0], at(0), _is_date_like, "a date or a timestamp", DATE)
        whole_number(1)
        return value_type(args[0].type)

    def measures(self, raw: Any, rows: Mapping[str, Column], names: set[str], path: str) -> list[CheckedMeasure]:
        if not isinstance(raw, list):
            _fail(path, "syntax", "measures is an array.")
        if len(raw) > LIMITS.measures:
            _fail(path, "limit", f"An aggregate has at most {LIMITS.measures} measures.")
        checked: list[CheckedMeasure] = []
        for index, measure in enumerate(raw):
            at = _child(path, index)
            if not isinstance(measure, dict):
                _fail(at, "syntax", "A measure is an object: { name, fn, column?, p?, approx? }.")
            _members(measure, ("name", "fn", "column", "p", "approx"), at)
            name = _name_of(measure.get("name"), _child(at, "name"))
            fn = measure.get("fn")
            if not isinstance(fn, str):
                _fail(_child(at, "fn"), "syntax", "A measure's fn is a string.")
            if fn not in MEASURES:
                _fail(_child(at, "fn"), "unknown_function", f'There is no measure "{fn}".')
            if self.options.measures is not None and fn not in self.options.measures:
                _fail(_child(at, "fn"), "unsupported", f"This engine does not evaluate {fn}.")
            if name in names:
                _fail(_child(at, "name"), "duplicate_name", f'The view already has a column "{name}".')
            names.add(name)
            column: Column | None = None
            if "column" in measure:
                column_name = _name_of(measure["column"], _child(at, "column"))
                column = rows.get(column_name)
                if column is None:
                    _fail(_child(at, "column"), "unknown_column", f'There is no column "{column_name}" here.')
            elif fn != "count":
                _fail(at, "syntax", f"{fn} measures a column.")
            if column is not None:
                if fn == "count":
                    accepted = True
                elif fn in ("count_distinct", "min", "max"):
                    accepted = column["type"] in _ORDERABLE
                elif fn == "quantile":
                    accepted = _is_number(column) or column["type"] in _TEMPORAL
                else:
                    accepted = _is_number(column)
                if not accepted:
                    _fail(_child(at, "column"), "type", f"{fn} does not measure {type_name(column)} values.")
            p = None
            if fn == "quantile":
                p = measure.get("p")
                if not is_number(p) or not 0 <= js_float(p) <= 1:
                    _fail(_child(at, "p"), "syntax", "quantile takes p, from 0 to 1.")
            elif "p" in measure:
                _fail(_child(at, "p"), "syntax", "Only quantile takes p.")
            if "approx" in measure and not isinstance(measure["approx"], bool):
                _fail(_child(at, "approx"), "syntax", "approx is a boolean.")
            checked.append(
                CheckedMeasure(name, fn, column, p, measure.get("approx") is True, _measure_type(fn, column))
            )
        return checked


def check_expression(
    expr: Any, columns: Sequence[Column], options: CheckOptions | Mapping[str, Any] | None = None
) -> TypedExpr:
    """Checks one expression over columns as a derived column is checked (§4.7) and gives its typed tree, for front
    ends such as formulas (§4.11) that need the types of what they build. Paths of errors start at the expression:
    `/args/0`."""
    scope = {column["name"]: column for column in columns}
    return _Checker(columns, _options(options)).expression(expr, scope, "", "derive")


def _column_of(name: str, type: ValueType) -> Column:
    return {"name": name, **value_type(type)}


def check_plan(
    plan: Any, table: Sequence[Column], options: CheckOptions | Mapping[str, Any] | None = None
) -> CheckedPlan:
    """Checks a plan against a table's columns (§4.7) and gives the typed tree that engines run. Raises a `PlanError`
    with the JSON Pointer `path` of the problem and its `reason`. `options` is a `CheckOptions`, or a dict with its
    members (`plan_options(capabilities)` makes one from an engine's capabilities)."""
    checker = _Checker(table, _options(options))
    if not isinstance(plan, dict):
        _fail("", "syntax", "A plan is an object.")
    _members(plan, ("derive", "where", "aggregate", "having", "sort"), "")
    rows: dict[str, Column] = {column["name"]: column for column in table}

    derive: list[CheckedDerived] = []
    if "derive" in plan:
        checker.member("derive", "/derive")
        items = plan["derive"]
        if not isinstance(items, list):
            _fail("/derive", "syntax", "derive is an array.")
        if len(items) > LIMITS.derive:
            _fail("/derive", "limit", f"A plan has at most {LIMITS.derive} derived columns.")
        for index, item in enumerate(items):
            at = f"/derive/{index}"
            if not isinstance(item, dict):
                _fail(at, "syntax", "A derived column is an object: { name, expr }.")
            _members(item, ("name", "expr"), at)
            name = _name_of(item.get("name"), f"{at}/name")
            if name in rows:
                _fail(f"{at}/name", "duplicate_name", f'The view already has a column "{name}".')
            expr = checker.expression(item.get("expr"), rows, f"{at}/expr", "derive")
            if _is_null(expr.type):
                _fail(
                    f"{at}/expr",
                    "type",
                    "The type of a derived column cannot be decided: give the null literal a type.",
                )
            column = _column_of(name, expr.type)
            derive.append(CheckedDerived(name, expr, column))
            rows[name] = column

    where: TypedExpr | None = None
    if "where" in plan:
        checker.member("where", "/where")
        where = checker.expression(plan["where"], rows, "/where", "where")
        _settle(where, BOOLEAN)
        if where.type["type"] != "boolean":
            _fail("/where", "type", f"where is a boolean, not {type_name(where.type)}.")

    aggregate: CheckedAggregate | None = None
    columns = list(rows.values())
    if "aggregate" in plan:
        checker.member("aggregate", "/aggregate")
        raw = plan["aggregate"]
        if not isinstance(raw, dict):
            _fail("/aggregate", "syntax", "aggregate is an object: { keys, measures, pivot? }.")
        _members(raw, ("keys", "measures", "pivot"), "/aggregate")
        raw_keys = raw.get("keys")
        if not isinstance(raw_keys, list):
            _fail("/aggregate/keys", "syntax", "keys is an array of column names.")
        if len(raw_keys) > LIMITS.keys:
            _fail("/aggregate/keys", "limit", f"An aggregate has at most {LIMITS.keys} keys.")
        names: set[str] = set()
        keys: list[Column] = []
        for index, key in enumerate(raw_keys):
            name = _name_of(key, f"/aggregate/keys/{index}")
            column = rows.get(name)
            if column is None:
                _fail(f"/aggregate/keys/{index}", "unknown_column", f'There is no column "{name}" here.')
            if name in names:
                _fail(f"/aggregate/keys/{index}", "duplicate_name", f'"{name}" is a key twice.')
            names.add(name)
            keys.append(column)
        pivot: CheckedPivot | None = None
        if "pivot" in raw:
            checker.member("pivot", "/aggregate/pivot")
            spec = raw["pivot"]
            if not isinstance(spec, dict):
                _fail("/aggregate/pivot", "syntax", "pivot is an object: { columns, maxColumns? }.")
            _members(spec, ("columns", "maxColumns"), "/aggregate/pivot")
            spec_columns = spec.get("columns")
            if not isinstance(spec_columns, list) or len(spec_columns) == 0:
                _fail("/aggregate/pivot/columns", "syntax", "pivot's columns are a list of column names.")
            if len(spec_columns) > LIMITS.pivot_columns:
                _fail("/aggregate/pivot/columns", "limit", f"A pivot has at most {LIMITS.pivot_columns} columns.")
            used: set[str] = set()
            pivot_columns: list[Column] = []
            for index, item in enumerate(spec_columns):
                at = f"/aggregate/pivot/columns/{index}"
                name = _name_of(item, at)
                column = rows.get(name)
                if column is None:
                    _fail(at, "unknown_column", f'There is no column "{name}" here.')
                if name in names or name in used:
                    _fail(at, "duplicate_name", f'"{name}" is already a key or a pivot column.')
                used.add(name)
                pivot_columns.append(column)
            max_columns = LIMITS.pivot_default
            if "maxColumns" in spec:
                value = spec["maxColumns"]
                if not is_integer(value) or js_float(value) < 1:
                    _fail("/aggregate/pivot/maxColumns", "syntax", "maxColumns is a positive integer.")
                if js_float(value) > LIMITS.pivot_output:
                    _fail(
                        "/aggregate/pivot/maxColumns", "limit", f"A pivot makes at most {LIMITS.pivot_output} columns."
                    )
                max_columns = int(value)
            pivot = CheckedPivot(pivot_columns, max_columns)
        measures = checker.measures(raw.get("measures"), rows, names, "/aggregate/measures")
        if pivot is not None and len(measures) == 0:
            _fail("/aggregate/pivot", "misplaced", "A pivot needs at least one measure.")
        aggregate = CheckedAggregate(keys, measures, pivot)
        columns = [_column_of(key["name"], key) for key in keys]
        if pivot is None:
            columns += [_column_of(measure.name, measure.type) for measure in measures]
    view = {column["name"]: column for column in columns}

    having: TypedExpr | None = None
    if "having" in plan:
        checker.member("having", "/having")
        if aggregate is None:
            _fail("/having", "misplaced", "having filters groups: it needs aggregate.")
        having = checker.expression(plan["having"], view, "/having", "having")
        _settle(having, BOOLEAN)
        if having.type["type"] != "boolean":
            _fail("/having", "type", f"having is a boolean, not {type_name(having.type)}.")

    sort: list[CheckedSortKey] = []
    if "sort" in plan:
        checker.member("sort", "/sort")
        keys_raw = plan["sort"]
        if not isinstance(keys_raw, list):
            _fail("/sort", "syntax", "sort is an array.")
        if len(keys_raw) > LIMITS.sort_keys:
            _fail("/sort", "limit", f"A plan has at most {LIMITS.sort_keys} sort keys.")
        for index, key in enumerate(keys_raw):
            at = f"/sort/{index}"
            if not isinstance(key, dict):
                _fail(at, "syntax", "A sort key is an object: { column, direction }.")
            _members(key, ("column", "direction"), at)
            name = _name_of(key.get("column"), f"{at}/column")
            column = view.get(name)
            if column is None:
                _fail(f"{at}/column", "unknown_column", f'There is no column "{name}" here.')
            direction = key.get("direction")
            if direction not in ("asc", "desc"):
                _fail(f"{at}/direction", "syntax", "direction is asc or desc.")
            sort.append(CheckedSortKey(column, direction))

    return CheckedPlan(
        plan=plan,
        table=list(table),
        derive=derive,
        rows=list(rows.values()),
        where=where,
        aggregate=aggregate,
        having=having,
        sort=sort,
        columns=columns,
        row_ids=aggregate is None,
    )
