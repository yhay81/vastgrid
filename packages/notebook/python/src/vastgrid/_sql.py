"""Plans as DuckDB SQL (docs/spec.md §3, §4). The SQL implements the specification, not DuckDB's defaults where
they differ. Values are always parameters (`$1`, `$2`, … for `connection.execute(sql, params)`) and names are always
quoted. The session's time zone must be UTC, so that the text form of `timestamptz` values is the one of §2.4."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from ._calendar import infinity_of, parse_timestamp_text
from ._check import CallExpr, CheckedMeasure, CheckedPlan, ColumnExpr, LiteralExpr, SearchExpr, TypedExpr, value_type
from ._fold import FoldPart, fold_all, fold_part, search_folds
from ._plan import SpecError
from ._values import (
    exact_number_text,
    is_number,
    is_safe_integer,
    is_value_of,
    js_float,
    js_string,
    number_text,
    same_type,
    value_of_text,
)

Column = dict[str, Any]
SqlValue = str | int | float | bool | None

PivotCombinations = list[list[str | None]]
"""The text forms of the values of a pivot's combinations, in order, as `pivot_query` reads them."""


@dataclass
class SqlQuery:
    """A statement and its parameters (`$1`, `$2`, …)."""

    sql: str
    params: list[SqlValue]


@dataclass
class SqlSource:
    """Where a table's rows come from."""

    relation: str
    """The relation as SQL: a quoted table name, or a table function."""
    row_id: str
    """The relation's column of row IDs (§1), as SQL."""
    params: list[SqlValue] = field(default_factory=list)
    """Parameters that `relation` uses, as `$1`, `$2`, …"""
    columns: dict[str, str] | None = None
    """Quoted SQL identifiers in `relation` when column names differ only in case."""


@dataclass
class SqlView:
    """A view as SQL: `with_` (TypeScript's `with`) defines the relation `vg_view`, which holds the view's columns."""

    with_: str
    params: list[SqlValue]
    columns: list[Column]
    order: list[str]
    """ORDER BY terms that order the view totally (§3.3)."""
    row_ids: bool
    row_id: str | None
    """The column of `vg_view` that holds row IDs, when the view has them."""
    identifiers: dict[str, str] = field(default_factory=dict)
    """Quoted SQL identifiers in `vg_view` by column name."""


@dataclass
class SqlRead:
    """What `rows_query` reads: positions `[start, end)` and the view's columns, by name."""

    start: int
    end: int
    columns: list[str]


FIRST_DATE = "DATE '-290308-12-22'"
"""The first date (§2.2)."""
LAST_DATE = "DATE '294247-01-10'"
"""The last date (§2.2)."""
_NUMBER_PATTERN = r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?"
_DATE_PATTERN = "[0-9]{4}-[0-9]{2}-[0-9]{2}"
_TIMESTAMP_PATTERN = r"[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?"
_FLOAT_TOKENS = {"NaN": "'NaN'", "Infinity": "'Infinity'", "-Infinity": "'-Infinity'"}
_SIMPLE_SQL = re.compile(r'^(?:"(?:[^"]|"")+"|vg_[a-z0-9_]+|\$[0-9]+|NULL|TRUE|FALSE)\Z')
_NANOS_INFINITY = "CAST('10000000000000000000000000' AS HUGEINT)"


class _Params:
    def __init__(self, initial: Sequence[SqlValue] = ()) -> None:
        self.values: list[SqlValue] = list(initial)

    def add(self, value: SqlValue) -> str:
        self.values.append(value)
        return f"${len(self.values)}"


def quote_identifier(name: str) -> str:
    """A name as a DuckDB identifier."""
    return '"' + name.replace('"', '""') + '"'


def view_column(view: SqlView, name: str) -> str:
    """The quoted SQL identifier of `name` in `view`'s `vg_view` relation."""
    return view.identifiers.get(name) or quote_identifier(name)


def _let_sql(sql: str, body: Callable[[str], str], name: str = "vg_v") -> str:
    """Evaluates `sql` once when `body` refers to it more than once."""
    return body(sql) if _SIMPLE_SQL.match(sql) else f"list_transform([{sql}], lambda {name}: {body(name)})[1]"


def duckdb_type(type: dict[str, Any]) -> str:
    """The DuckDB type of a logical type (§2.1)."""
    kind = type["type"]
    if kind == "decimal":
        precision = type.get("precision")
        scale = type.get("scale")
        return f"DECIMAL({number_text(38 if precision is None else precision)},{number_text(scale or 0)})"
    if kind == "float":
        return "FLOAT" if type.get("bits") == 32 else "DOUBLE"
    if kind == "timestamp":
        return {"s": "TIMESTAMP_S", "ms": "TIMESTAMP_MS", "ns": "TIMESTAMP_NS"}.get(type.get("unit"), "TIMESTAMP")
    return _DUCKDB_TYPES[kind]


_DUCKDB_TYPES = {
    "boolean": "BOOLEAN",
    "integer": "INTEGER",
    "bigint": "BIGINT",
    "string": "VARCHAR",
    "date": "DATE",
    "time": "TIME",
    "timestamptz": "TIMESTAMPTZ",
    "interval": "INTERVAL",
    "uuid": "UUID",
    "binary": "BLOB",
}


def text_sql(sql: str, type: dict[str, Any]) -> str:
    """The SQL of the text form (§2.4) of a value of a type. DuckDB writes a decimal without whole digits, such as a
    decimal(1, 1), as `.5` and `-.5`, where §2.4 writes `0.5` and `-0.5` (Appendix B)."""
    if type["type"] == "string":
        return sql
    scale = type.get("scale") or 0
    precision = type.get("precision")
    if type["type"] == "decimal" and scale > 0 and scale == (38 if precision is None else precision):
        return f"regexp_replace(CAST({sql} AS VARCHAR), '^(-?)\\.', '\\10.')"
    if type["type"] == "float" and type.get("bits") == 32:
        # DuckDB writes some 32-bit floats with all their exact digits (5525.71875 for 5525.7188): the shortest digits
        # that read back as the same float, which `printf` rounds halves to even, written as the double they are.
        def _float32_text(val: str) -> str:
            text = f"CAST({val} AS VARCHAR)"
            shortest = " ".join(
                f"WHEN CAST(printf('%.{digits}e', {val}) AS FLOAT) = {val} "
                f"THEN CAST(CAST(printf('%.{digits}e', {val}) AS DOUBLE) AS VARCHAR)"
                for digits in range(8)
            )
            return f"(CASE WHEN NOT isfinite({val}) THEN {text} {shortest} ELSE {text} END)"

        return _let_sql(sql, _float32_text)
    return f"CAST({sql} AS VARCHAR)"


def _at_least(sql: str, low: int) -> str:
    """A count of code points from `low`: below it counts as `low`, and beyond 2^32 − 1, the most that DuckDB's
    `substring` takes, as 2^32 − 1, which no string reaches."""
    return _let_sql(
        f"CAST({sql} AS BIGINT)",
        lambda value: (
            f"(CASE WHEN {value} < {low} THEN {low} WHEN {value} > 4294967295 THEN 4294967295 ELSE {value} END)"
        ),
    )


def temporal_param(text: str) -> str:
    """The text of a date or a timestamp (§2.2) as DuckDB reads it: years after 9999 without their `+`."""
    return text[1:] if text.startswith("+") else text


def _cast(sql: str, type: dict[str, Any]) -> str:
    return f"CAST({sql} AS {duckdb_type(type)})"


def _try_cast(sql: str, type: dict[str, Any]) -> str:
    return f"TRY_CAST({sql} AS {duckdb_type(type)})"


def float_param(value: int | float) -> str:
    """A float as text that DuckDB reads back as the same float, with the sign of −0.0. Floats are bound as text, as
    JavaScript's `String(number)` writes them."""
    number = js_float(value)
    return "-0.0" if number == 0 and math.copysign(1, number) < 0 else number_text(number)


_FINITE_TYPES = ("float", "date", "timestamp", "timestamptz")
"""The types whose values may be infinite."""

_REPLACED_SINGLES = 16
"""Folds that change at most this many single code points use `replace`, which is faster than `translate`."""


def _code_point_class(chars: list[str]) -> str:
    """An RE2 class of code points, as escapes and ranges: `[\\x{3041}-\\x{3096}]`."""
    codes = sorted({ord(char) for char in chars})
    parts: list[str] = []
    start = 0
    while start < len(codes):
        end = start
        while end + 1 < len(codes) and codes[end + 1] == codes[end] + 1:
            end += 1
        first = f"\\x{{{codes[start]:x}}}"
        parts.append(f"{first}-\\x{{{codes[end]:x}}}" if end > start else first)
        start = end + 1
    return f"[{''.join(parts)}]"


def _finite(sql: str) -> str:
    """Null unless the number, the date or the timestamp is finite (§3.6)."""
    return _let_sql(sql, lambda val: f"(CASE WHEN isfinite({val}) THEN {val} END)")


def _exact_digits(type: dict[str, Any]) -> tuple[int, int]:
    if type["type"] == "integer":
        return 10, 0
    if type["type"] == "bigint":
        return 19, 0
    precision = type.get("precision")
    return (38 if precision is None else precision), (type.get("scale") or 0)


def _needs_wide_exact_compare(types: Sequence[dict[str, Any]]) -> bool:
    exact: list[tuple[int, int]] = []
    for type in types:
        if type["type"] == "null":
            continue
        if type["type"] not in ("integer", "bigint", "decimal"):
            return False
        exact.append(_exact_digits(type))
    if len(exact) < 2:
        return False
    whole = max(p - s for p, s in exact)
    scale = max(s for _, s in exact)
    return whole + scale > 38


def _exact_parts(sql: str, type: dict[str, Any]) -> tuple[str, str]:
    if type["type"] == "null":
        return "CAST(NULL AS DECIMAL(38,0))", "CAST(NULL AS DECIMAL(38,38))"
    p, s = _exact_digits(type)
    if s == 0:
        return (
            f"CAST({sql} AS DECIMAL(38,0))",
            f"(CASE WHEN {sql} IS NOT NULL THEN CAST(0 AS DECIMAL(38,38)) END)",
        )
    if s == p:
        return (
            f"(CASE WHEN {sql} IS NOT NULL THEN CAST(0 AS DECIMAL(38,0)) END)",
            f"CAST({sql} AS DECIMAL(38,38))",
        )
    return (
        f"CAST(trunc({sql}) AS DECIMAL(38,0))",
        f"CAST({sql} - CAST(trunc({sql}) AS DECIMAL({p},{s})) AS DECIMAL(38,38))",
    )


def _needs_mixed_ns_compare(types: Sequence[dict[str, Any]]) -> bool:
    has_ns = any(t["type"] == "timestamp" and t.get("unit") == "ns" for t in types)
    has_wider = any(t["type"] == "date" or (t["type"] == "timestamp" and t.get("unit") != "ns") for t in types)
    return has_ns and has_wider


def _temporal_nanos(sql: str, type: dict[str, Any]) -> str:
    """A date or timestamp as nanoseconds since 1970-01-01 in HUGEINT, with ±10^25 for ±infinity (§3.1)."""
    if type["type"] == "null":
        return "CAST(NULL AS HUGEINT)"

    def _convert(val: str) -> str:
        if type["type"] == "date":
            finite_count = f"CAST({val} - DATE '1970-01-01' AS HUGEINT) * 86400000000000"
        elif type["type"] == "timestamp" and type.get("unit") == "ns":
            finite_count = f"CAST(epoch_ns({val}) AS HUGEINT)"
        elif type["type"] == "timestamp" and type.get("unit") == "ms":
            finite_count = f"CAST(epoch_ms({val}) AS HUGEINT) * 1000000"
        elif type["type"] == "timestamp" and type.get("unit") == "s":
            finite_count = f"CAST(epoch_us(CAST({val} AS TIMESTAMP)) AS HUGEINT) * 1000"
        else:
            finite_count = f"CAST(epoch_us({val}) AS HUGEINT) * 1000"
        return (
            f"(CASE WHEN isfinite({val}) THEN {finite_count} "
            f"WHEN {val} = 'infinity' THEN {_NANOS_INFINITY} "
            f"WHEN {val} = '-infinity' THEN -{_NANOS_INFINITY} END)"
        )

    return _let_sql(sql, _convert)


class _IdentifierScope:
    """Allocates quoted SQL identifiers that never collide in DuckDB's case-insensitive catalog."""

    def __init__(self, reserved: Iterable[str] = ()) -> None:
        # A lambda parameter shadows even a quoted column of the same name.
        self.used = {"vg_v", "vg_l", "vg_r", "vg_c", "vg_w", "vg_a", "vg_n"}
        self.used.update(name.lower() for name in reserved)
        self.map: dict[str, str] = {}
        self._next = 0

    def allocate(self, name: str) -> str:
        lower = name.lower()
        if lower not in self.used:
            self.used.add(lower)
            sql = quote_identifier(name)
        else:
            candidate = f"vg_c{self._next}"
            self._next += 1
            while candidate in self.used:
                candidate = f"vg_c{self._next}"
                self._next += 1
            self.used.add(candidate)
            sql = quote_identifier(candidate)
        self.map[name] = sql
        return sql


class _Compiler:
    def __init__(self, params: _Params) -> None:
        self.params = params
        self._tables: dict[str, str] = {}
        self._columns: dict[str, str] = {}

    def set_columns(self, columns: dict[str, str]) -> None:
        self._columns = columns

    def column(self, name: str) -> str:
        return self._columns.get(name) or quote_identifier(name)

    def expression(self, node: TypedExpr) -> str:
        if isinstance(node, ColumnExpr):
            return self.column(node.name)
        if isinstance(node, LiteralExpr):
            return self._literal(node)
        if isinstance(node, SearchExpr):
            if not node.columns:
                return "FALSE"
            # The folds first, then lower (§3.5). The text is folded here, by the same tables. Values are folded only
            # by the parts of the folds that the search needs, and only strings: the other text forms are ASCII, which
            # no fold changes.
            text = f"lower(CAST({self.params.add(fold_all(node.text, node.fold))} AS VARCHAR))"
            parts = search_folds(node.text, node.fold)
            matches = []
            for column in node.columns:
                value = text_sql(self.column(column["name"]), column)
                if column["type"] == "string":
                    value = self._folded(value, parts)
                matches.append(f"coalesce(contains(lower({value}), {text}), FALSE)")
            return f"({' OR '.join(matches)})"
        return self._call(node)

    def _literal(self, node: LiteralExpr) -> str:
        type = node.type
        kind = type["type"]
        if kind == "null":
            return "NULL"
        if node.value is None:
            return f"CAST(NULL AS {duckdb_type(type)})"
        if kind == "boolean":
            return "TRUE" if node.value is True else "FALSE"
        if kind == "float":
            target = duckdb_type(type)
            if is_number(node.value):
                return f"CAST(CAST({self.params.add(float_param(node.value))} AS VARCHAR) AS {target})"
            token = _FLOAT_TOKENS.get(js_string(node.value))
            if token is None:
                raise ValueError(f"{js_string(node.value)} is not a float.")
            return f"CAST({token} AS {target})"
        if kind == "string":
            return f"CAST({self.params.add(js_string(node.value))} AS VARCHAR)"
        if kind == "binary":
            return f"from_base64(CAST({self.params.add(js_string(node.value))} AS VARCHAR))"
        if kind == "timestamp":
            text = js_string(node.value)
            if type.get("unit") == "ns" and infinity_of(text) == 0:
                count = str(parse_timestamp_text(text, "ns"))
                return f"make_timestamp_ns(CAST({self.params.add(count)} AS BIGINT))"
            return _cast(f"CAST({self.params.add(temporal_param(text))} AS VARCHAR)", type)
        if kind in ("date", "timestamptz"):
            return _cast(f"CAST({self.params.add(temporal_param(js_string(node.value)))} AS VARCHAR)", type)
        return _cast(f"CAST({self.params.add(js_string(node.value))} AS VARCHAR)", type)

    def _number(self, node: TypedExpr) -> str:
        """A number argument: floats that are not finite become null (§3.6)."""
        sql = self.expression(node)
        return _finite(sql) if node.type["type"] == "float" else sql

    def _table(self, value: str) -> str:
        """A text of a table of `fold`, as one parameter for the whole plan."""
        param = self._tables.get(value)
        if param is None:
            param = self._tables[value] = self.params.add(value)
        return f"CAST({param} AS VARCHAR)"

    def _folded(self, sql: str, parts: Sequence[FoldPart], guarded: bool = True) -> str:
        result = sql
        sources: list[str] = []
        for pairs, singles in parts:
            for pair, letter in pairs:
                result = f"replace({result}, {self._table(pair)}, {self._table(letter)})"
                sources.append(pair[0])
            if len(singles) <= _REPLACED_SINGLES:
                for source, target in singles:
                    result = f"replace({result}, {self._table(source)}, {self._table(target)})"
            else:
                source = "".join(source for source, _ in singles)
                target = "".join(target for _, target in singles)
                result = f"translate({result}, {self._table(source)}, {self._table(target)})"
            sources.extend(source for source, _ in singles)
        if not sources:
            return sql
        if not guarded:
            return result
        changed = self._table(_code_point_class(sources))
        return f"(CASE WHEN regexp_matches({sql}, {changed}) THEN {result} ELSE {sql} END)"

    def _double(self, node: TypedExpr) -> str:
        return f"CAST({self._number(node)} AS DOUBLE)"

    def _exact(self, node: TypedExpr, wide: bool = False) -> str:
        """An exact operand of a decimal operation: integers are decimal(10, 0) and bigints decimal(19, 0) (§3.7).
        With `wide`, it has 19 digits at least."""
        sql = self.expression(node)
        if node.type["type"] == "integer":
            return f"CAST({sql} AS DECIMAL({19 if wide else 10},0))"
        if node.type["type"] == "bigint":
            return f"CAST({sql} AS DECIMAL(19,0))"
        precision = node.type.get("precision")
        if wide and node.type["type"] == "decimal" and precision is not None and precision < 19:
            return f"CAST({sql} AS DECIMAL(19,{number_text(node.type.get('scale') or 0)}))"
        return sql

    def _text(self, node: TypedExpr) -> str:
        sql = self.expression(node)
        return sql if node.type["type"] == "null" else text_sql(sql, node.type)

    def _double_or_null(self, node: TypedExpr) -> str:
        return "CAST(NULL AS DOUBLE)" if node.type["type"] == "null" else f"CAST({self.expression(node)} AS DOUBLE)"

    def _compare(self, fn: str, left: TypedExpr, right: TypedExpr) -> str:
        op = _COMPARISONS[fn]
        types = (left.type, right.type)
        if any(item["type"] == "float" for item in types):
            return f"({self._double_or_null(left)} {op} {self._double_or_null(right)})"
        if _needs_mixed_ns_compare(types):
            left_ns = _temporal_nanos(self.expression(left), left.type)
            right_ns = _temporal_nanos(self.expression(right), right.type)
            return f"({left_ns} {op} {right_ns})"
        if _needs_wide_exact_compare(types):

            def _cmp(lv: str, rv: str) -> str:
                aw, af = _exact_parts(lv, left.type)
                bw, bf = _exact_parts(rv, right.type)
                if fn == "eq":
                    return f"({aw} = {bw} AND {af} = {bf})"
                if fn == "ne":
                    return f"({aw} <> {bw} OR {af} <> {bf})"
                if fn == "lt":
                    return f"({aw} < {bw} OR ({aw} = {bw} AND {af} < {bf}))"
                if fn == "le":
                    return f"({aw} < {bw} OR ({aw} = {bw} AND {af} <= {bf}))"
                if fn == "gt":
                    return f"({aw} > {bw} OR ({aw} = {bw} AND {af} > {bf}))"
                return f"({aw} > {bw} OR ({aw} = {bw} AND {af} >= {bf}))"

            return _let_sql(
                self.expression(left),
                lambda lv: _let_sql(self.expression(right), lambda rv: _cmp(lv, rv), "vg_r"),
                "vg_l",
            )
        return f"({self.expression(left)} {op} {self.expression(right)})"

    def _in_list(self, args: list[TypedExpr]) -> str:
        types = [item.type for item in args]
        if any(item["type"] == "float" for item in types):
            head, *choices = args
            if head.type["type"] != "float":
                exact = [item for item in choices if item.type["type"] != "float"]
                floats = [item for item in choices if item.type["type"] == "float"]
                if exact and floats:
                    return f"({self._in_list([head, *exact])} OR {self._in_list([head, *floats])})"
            items = ", ".join(self._double_or_null(item) for item in choices)
            return f"({self._double_or_null(head)} IN ({items}))"
        if _needs_mixed_ns_compare(types):
            head = _temporal_nanos(self.expression(args[0]), args[0].type)
            choices = ", ".join(_temporal_nanos(self.expression(item), item.type) for item in args[1:])
            return f"({head} IN ({choices}))"
        if _needs_wide_exact_compare(types):
            rights = [_exact_parts(self.expression(item), item.type) for item in args[1:]]

            def _in_wide(lv: str) -> str:
                lw, lf = _exact_parts(lv, args[0].type)
                terms = [f"({lw} = {rw} AND {lf} = {rf})" for rw, rf in rights]
                return f"({' OR '.join(terms)})"

            return _let_sql(self.expression(args[0]), _in_wide, "vg_l")
        return f"({self.expression(args[0])} IN ({', '.join(self.expression(item) for item in args[1:])}))"

    def _call(self, node: CallExpr) -> str:
        args = node.args
        type = node.type
        fn = node.fn

        def arg(index: int) -> str:
            return self.expression(args[index])

        def every(separator: str) -> str:
            return separator.join(self.expression(item) for item in args)

        def typed() -> str:
            return ", ".join(_try_cast(self.expression(item), type) for item in args)

        if fn == "and":
            return f"({every(' AND ')})"
        if fn == "or":
            return f"({every(' OR ')})"
        if fn == "not":
            return f"(NOT {arg(0)})"
        if fn in _COMPARISONS:
            return self._compare(fn, args[0], args[1])
        if fn == "in":
            return self._in_list(args)
        if fn == "is_null":
            return f"({arg(0)} IS NULL)"
        if fn == "is_blank":
            if args[0].type["type"] == "null":
                return "TRUE"
            value = arg(0)
            return (
                _let_sql(value, lambda val: f"({val} IS NULL OR {val} = '')")
                if args[0].type["type"] == "string"
                else f"({value} IS NULL)"
            )
        if fn == "if":
            return f"(CASE WHEN {arg(0)} THEN {_try_cast(arg(1), type)} ELSE {_try_cast(arg(2), type)} END)"
        if fn == "coalesce":
            if all(item.type["type"] != "null" and same_type(item.type, type) for item in args):
                return f"coalesce({', '.join(arg(index) for index in range(len(args)))})"
            fields = ", ".join(f"a{index} := {arg(index)}" for index in range(len(args)))
            cases = " ".join(
                f"WHEN vg_c.a{index} IS NOT NULL THEN {_try_cast(f'vg_c.a{index}', type)}" for index in range(len(args))
            )
            return f"list_transform([struct_pack({fields})], lambda vg_c: CASE {cases} END)[1]"
        if fn in ("least", "greatest"):
            return f"{fn}({typed()})"
        if fn in _OPERATORS:
            operator = _OPERATORS[fn]
            if type["type"] == "float":
                return _finite(f"({self._double(args[0])} {operator} {self._double(args[1])})")
            if type["type"] == "bigint":
                return f"TRY(CAST({arg(0)} AS BIGINT) {operator} CAST({arg(1)} AS BIGINT))"
            precision = type.get("precision")
            wide = fn == "mul" and type["type"] == "decimal" and (precision is None or precision > 18)
            return f"TRY({_cast(f'({self._exact(args[0], wide)} {operator} {self._exact(args[1])})', type)})"
        if fn == "div":
            return _finite(f"({self._double(args[0])} / {self._double(args[1])})")
        if fn == "neg":
            return (
                _finite(f"(-{self._number(args[0])})")
                if type["type"] == "float"
                else f"TRY({_cast(f'(-{arg(0)})', type)})"
            )
        if fn == "abs":
            if type["type"] == "float":
                return _finite(f"abs({self._number(args[0])})")
            return f"TRY({_cast(f'abs({arg(0)})', type)})"
        if fn == "round":
            places = js_float(args[1].value) if len(args) == 2 else 0.0
            digits = number_text(places)
            if type["type"] == "float":
                return _finite(f"round({self._double(args[0])}, {digits})")
            if type["type"] != "decimal" and places >= 0:
                return arg(0)
            return f"TRY({_cast(f'round({arg(0)}, {digits})', type)})"
        if fn in ("floor", "ceil"):
            if type["type"] == "float":
                return _finite(f"{fn}({self._number(args[0])})")
            if type["type"] == "decimal":
                return _cast(f"{fn}({arg(0)})", type)
            return arg(0)
        if fn == "bin":
            if type["type"] == "float":
                return _let_sql(
                    self._double(args[1]),
                    lambda width: _finite(f"(floor({self._double(args[0])} / {width}) * {width})"),
                    "vg_w",
                )
            exact = exact_number_text(js_float(args[1].value))
            assert exact is not None
            step = _cast(f"CAST({self.params.add(exact)} AS VARCHAR)", type)
            return _let_sql(
                arg(0),
                lambda val: (
                    "TRY("
                    + _cast(
                        f"({val} - (CASE WHEN ({val} % {step}) < 0 "
                        f"THEN ({val} % {step}) + {step} ELSE ({val} % {step}) END))",
                        type,
                    )
                    + ")"
                ),
            )
        if fn in ("sqrt", "exp", "ln", "log10"):
            return _finite(f"TRY({fn}({self._double(args[0])}))")
        if fn == "power":
            return _finite(f"TRY(power({self._double(args[0])}, {self._double(args[1])}))")
        if fn == "sign":
            return f"CAST(sign({self._number(args[0])}) AS INTEGER)"
        if fn == "to_number":
            return _let_sql(
                f"trim({arg(0)})",
                lambda value: (
                    f"(CASE WHEN regexp_full_match({value}, '{_NUMBER_PATTERN}') "
                    f"THEN {_finite(f'TRY_CAST({value} AS DOUBLE)')} END)"
                ),
            )
        if fn == "concat":
            return f"concat({', '.join(self._text(item) for item in args)})"
        if fn == "length":
            return f"CAST(length({arg(0)}) AS BIGINT)"
        if fn in ("lower", "upper", "trim"):
            return f"{fn}({arg(0)})"
        if fn in ("left", "right"):
            return f"{fn}({arg(0)}, {_at_least(arg(1), 0)})"
        if fn == "substr":
            start = _at_least(arg(1), 1)
            if len(args) == 3:
                return f"substring({arg(0)}, {start}, {_at_least(arg(2), 0)})"
            return f"substring({arg(0)}, {start})"
        if fn == "fold":
            return self._folded(arg(0), [fold_part(args[1].value)], isinstance(args[0], ColumnExpr))
        if fn == "replace":
            return f"replace({arg(0)}, {arg(1)}, {arg(2)})"
        if fn in ("contains", "starts_with", "ends_with"):
            return f"{fn}({arg(0)}, {arg(1)})"
        if fn == "text":
            return self._text(args[0])
        if fn == "to_date":
            return _let_sql(
                arg(0),
                lambda value: (
                    f"(CASE WHEN regexp_full_match({value}, '{_DATE_PATTERN}') THEN TRY_CAST({value} AS DATE) END)"
                ),
            )
        if fn == "to_timestamp":
            return _let_sql(
                arg(0),
                lambda value: (
                    f"(CASE WHEN regexp_full_match({value}, '{_TIMESTAMP_PATTERN}') "
                    f"THEN TRY_CAST(replace({value}, 'T', ' ') AS TIMESTAMP) END)"
                ),
            )
        if fn in ("year", "month", "day", "hour", "minute", "second", "isodow"):
            return f"CAST({fn}({arg(0)}) AS BIGINT)"
        if fn == "date_diff_days":
            mixed = args[0].type["type"] != args[1].type["type"]
            left_day = f"CAST({arg(0)} AS TIMESTAMP)" if mixed else arg(0)
            right_day = f"CAST({arg(1)} AS TIMESTAMP)" if mixed else arg(1)
            return f"date_diff('day', {left_day}, {right_day})"
        if fn == "add_days":
            days = f"TRY_CAST({arg(1)} AS INTEGER)"
            if type["type"] == "date":
                return _let_sql(
                    f"TRY({arg(0)} + {days})",
                    lambda total: f"(CASE WHEN {total} BETWEEN {FIRST_DATE} AND {LAST_DATE} THEN {total} END)",
                )
            if type.get("unit") == "ns":
                return (
                    f"list_transform([struct_pack(t := {arg(0)}, d := {days})], lambda vg_a: "
                    "CASE WHEN isfinite(vg_a.t) AND vg_a.d IS NOT NULL THEN "
                    "list_transform([CAST(epoch_ns(vg_a.t) AS HUGEINT) + CAST(vg_a.d AS HUGEINT) * 86400000000000], "
                    "lambda vg_n: CASE WHEN vg_n BETWEEN -9223372036854775806 AND 9223372036854775806 "
                    "THEN make_timestamp_ns(CAST(vg_n AS BIGINT)) END)[1] END)[1]"
                )
            base = f"CAST({arg(0)} AS TIMESTAMP)" if type.get("unit") else arg(0)
            total = _finite(f"TRY({base} + to_days({days}))")
            return _try_cast(total, type) if type.get("unit") else total
        raise ValueError(f"There is no function {fn}.")

    def _wide_decimal_sum_text(self, measure: CheckedMeasure, where: str) -> str | None:
        """DuckDB's variable-width integer sum can accumulate every unscaled digit, even through overflow
        and cancellation. Restore the fixed decimal point after the aggregation."""
        decimal = measure.column
        if decimal is None or decimal["type"] != "decimal":
            return None
        precision = decimal.get("precision")
        if precision is not None and precision <= 18:
            return None
        column = self.column(decimal["name"])
        total = f"CAST(sum(CAST(replace(CAST({column} AS VARCHAR), '.', '') AS BIGNUM)){where} AS VARCHAR)"
        scale = decimal.get("scale") or 0
        if scale == 0:
            return total

        def scaled(value: str) -> str:
            digits = f"ltrim({value}, '-')"
            padded = f"lpad({digits}, CAST(greatest(length({digits}), {scale + 1}) AS INTEGER), '0')"
            return (
                f"((CASE WHEN starts_with({value}, '-') THEN '-' ELSE '' END) || "
                f"regexp_replace({padded}, '([0-9]{{{scale}}})$', '.\\1'))"
            )

        return _let_sql(total, scaled)

    def measure(self, measure: CheckedMeasure, condition: str | None = None) -> str:
        """A measure (§3.8, §4.5), optionally over the rows of a pivot's combination."""
        column = self.column(measure.column["name"]) if measure.column else None
        conditions: list[str] = []
        finite_type = measure.column is not None and measure.column["type"] in _FINITE_TYPES
        if finite_type and measure.fn not in ("count", "count_distinct"):
            conditions.append(f"isfinite({column})")
        if condition:
            conditions.append(condition)
        where = f" FILTER (WHERE {' AND '.join(conditions)})" if conditions else ""
        fn = measure.fn
        if fn == "count":
            return f"count({column or '*'}){where}"
        if fn == "count_distinct":
            return f"approx_count_distinct({column}){where}" if measure.approx else f"count(DISTINCT {column}){where}"
        if fn == "sum":
            if measure.type["type"] == "float":
                return f"sum({column}){where}"
            scale = measure.type.get("scale") or 0
            wide_text = self._wide_decimal_sum_text(measure, where)
            if wide_text:
                return f"TRY_CAST({wide_text} AS {duckdb_type(measure.type)})"
            total = f"TRY_CAST(sum({column}){where} AS {duckdb_type(measure.type)})"
            largest = "9" * (38 - scale) + (f".{'9' * scale}" if scale > 0 else "")
            return f"(CASE WHEN abs({total}) <= {largest} THEN {total} END)"
        if fn == "avg":
            wide_text = self._wide_decimal_sum_text(measure, where)
            if wide_text:
                return _finite(f"(CAST({wide_text} AS DOUBLE) / count({column}){where})")
            return f"CAST(avg({column}){where} AS DOUBLE)"
        if fn == "stddev":
            stddev = f"CAST(stddev_samp({column}){where} AS DOUBLE)"
            return f"(CASE WHEN isfinite({stddev}) THEN {stddev} END)"
        if fn in ("min", "max"):
            return f"{fn}({column}){where}"
        if measure.type["type"] != "float":
            result = f"quantile_cont({column}, {number_text(measure.p)}){where}"
            if measure.type["type"] == "time":
                return result
            count = f"CAST(CAST(epoch_us({result}) AS VARCHAR) AS BIGINT)"
            return f"(CASE WHEN {count} >= epoch_us({FIRST_DATE}) THEN {result} END)"
        name = "approx_quantile" if measure.approx else "quantile_cont"
        return f"{name}(CAST({column} AS DOUBLE), {number_text(measure.p)}){where}"


_COMPARISONS = {"eq": "=", "ne": "<>", "lt": "<", "le": "<=", "gt": ">", "ge": ">="}
_OPERATORS = {"add": "+", "sub": "-", "mul": "*", "mod": "%"}


def _sort_terms(sql: str, type: dict[str, Any], direction: str) -> list[str]:
    """ORDER BY terms of one sort key: blanks last in both directions (§3.3)."""
    order = "DESC" if direction == "desc" else "ASC"
    return [f"NULLIF({sql}, '') {order} NULLS LAST"] if type["type"] == "string" else [f"{sql} {order} NULLS LAST"]


def _key_sql(sql: str, column: Column) -> str:
    """The value of a group's key: DuckDB keeps the first row's, which may be −0.0 where §3.9 reads 0.0."""
    return f"({sql} + CAST(0 AS {duckdb_type(column)}))" if column["type"] == "float" else sql


def _key_terms(sql: str, column: Column) -> list[str]:
    """ORDER BY terms of group keys (§3.9): ascending, blanks last, the empty string before null."""
    if column["type"] == "string":
        return [f"NULLIF({sql}, '') ASC NULLS LAST", f"{sql} ASC NULLS LAST"]
    return [f"{sql} ASC NULLS LAST"]


def _row_id_name(plan: CheckedPlan) -> str:
    """A name for the column of row IDs that no column of the plan has, ignoring case."""
    names = {column["name"].lower() for column in plan.rows}
    alias = "vg_row"
    while alias in names:
        alias += "_"
    return alias


def _rows_with(
    plan: CheckedPlan, source: SqlSource, compiler: _Compiler, row_id_raw: str
) -> tuple[list[str], dict[str, str], str]:
    """The `WITH` entries up to `vg_rows`, the rows that `where` keeps, with the derived columns."""
    scope = _IdentifierScope([row_id_raw])
    alias = quote_identifier(row_id_raw)
    columns = []
    for column in plan.table:
        raw = (source.columns or {}).get(column["name"]) or quote_identifier(column["name"])
        col_id = scope.allocate(column["name"])
        columns.append(col_id if raw == col_id else f"{raw} AS {col_id}")
    compiler.set_columns(scope.map)
    entries = [f"vg_base AS (SELECT {', '.join([*columns, f'{source.row_id} AS {alias}'])} FROM {source.relation})"]
    previous = "vg_base"
    for index, item in enumerate(plan.derive):
        name = f"vg_derive{index + 1}"
        expr = compiler.expression(item.expr)
        col_id = scope.allocate(item.name)
        entries.append(f"{name} AS (SELECT *, {expr} AS {col_id} FROM {previous})")
        previous = name
    where = f" WHERE {compiler.expression(plan.where)}" if plan.where else ""
    entries.append(f"vg_rows AS (SELECT * FROM {previous}{where})")
    return entries, dict(scope.map), alias


def pivot_query(plan: CheckedPlan, source: SqlSource) -> SqlQuery:
    """The query that reads the combinations of a pivot's values (§4.6), as their text forms, in order. It reads one
    more combination than the pivot may make columns for, so that `compile_view` can refuse too many."""
    pivot = plan.aggregate.pivot if plan.aggregate else None
    if pivot is None or plan.aggregate is None:
        raise ValueError("The plan has no pivot.")
    compiler = _Compiler(_Params(source.params))
    entries, _, _ = _rows_with(plan, source, compiler, _row_id_name(plan))
    ids = [compiler.column(column["name"]) for column in pivot.columns]
    texts = [
        f'{text_sql(_key_sql(f"vg_distinct.{ids[index]}", column), column)} AS "vg_value{index}"'
        for index, column in enumerate(pivot.columns)
    ]
    limit = pivot.max_columns // len(plan.aggregate.measures) + 1
    order = ", ".join(
        term for index, column in enumerate(pivot.columns) for term in _key_terms(f"vg_distinct.{ids[index]}", column)
    )
    sql = (
        f"WITH {', '.join(entries)} SELECT {', '.join(texts)} "
        f"FROM (SELECT DISTINCT {', '.join(ids)} FROM vg_rows) vg_distinct "
        f"ORDER BY {order} LIMIT {limit}"
    )
    return SqlQuery(sql, compiler.params.values)


def _unique_name(name: str, taken: set[str]) -> str:
    """A name that no earlier column has: `name`, then `name (2)`, `name (3)`, … (§4.6)."""
    unique = name
    index = 2
    while unique in taken:
        unique = f"{name} ({index})"
        index += 1
    taken.add(unique)
    return unique


def compile_view(plan: CheckedPlan, source: SqlSource, combinations: PivotCombinations | None = None) -> SqlView:
    """The view of a checked plan as SQL. A pivot needs the combinations that `pivot_query` read, and fails with
    `too_many_columns` when they would make more columns than its `maxColumns`."""
    compiler = _Compiler(_Params(source.params))
    entries, row_ids, alias = _rows_with(plan, source, compiler, _row_id_name(plan))
    if plan.aggregate is None:
        order = [
            term for key in plan.sort for term in _sort_terms(row_ids[key.column["name"]], key.column, key.direction)
        ]
        entries.append("vg_view AS (SELECT * FROM vg_rows)")
        return SqlView(
            with_=f"WITH {', '.join(entries)}",
            params=compiler.params.values,
            columns=plan.columns,
            order=[*order, f"{alias} ASC"],
            row_ids=True,
            row_id=alias,
            identifiers=row_ids,
        )
    keys, measures, pivot = plan.aggregate.keys, plan.aggregate.measures, plan.aggregate.pivot
    columns = list(plan.columns)
    group_scope = _IdentifierScope()
    outputs = [f"{_key_sql(row_ids[key['name']], key)} AS {group_scope.allocate(key['name'])}" for key in keys]
    if pivot is not None:
        if combinations is None:
            raise ValueError("A pivot needs the combinations that pivot_query reads.")
        if len(combinations) > pivot.max_columns // len(measures):
            raise SpecError("too_many_columns", f"The pivot makes more than {pivot.max_columns} columns.")
        taken = {column["name"] for column in columns}
        for combination in combinations:
            if len(combination) != len(pivot.columns):
                raise ValueError("Each pivot combination must match pivot.columns.")
            json_values = []
            for index, text in enumerate(combination):
                val = value_of_text(text, pivot.columns[index])
                if not is_value_of(val, pivot.columns[index]):
                    raise ValueError(f"Invalid pivot combination value for {pivot.columns[index]['name']}.")
                json_values.append(val)
            condition = " AND ".join(
                f"({row_ids[column['name']]} IS NOT DISTINCT FROM "
                f"{compiler._literal(LiteralExpr(json_values[index], column))})"
                for index, column in enumerate(pivot.columns)
            )
            labels = ["(null)" if text is None else "(empty)" if text == "" else text for text in combination]
            for measure in measures:
                name = _unique_name(" / ".join([*labels, measure.name]), taken)
                outputs.append(f"{compiler.measure(measure, condition)} AS {group_scope.allocate(name)}")
                columns.append(
                    {
                        "name": name,
                        **value_type(measure.type),
                        "pivot": {
                            "values": json_values,
                            "measure": measure.name,
                        },
                    }
                )
    else:
        for measure in measures:
            outputs.append(f"{compiler.measure(measure)} AS {group_scope.allocate(measure.name)}")
    group_by = f" GROUP BY {', '.join(row_ids[key['name']] for key in keys)}" if keys else ""
    if not outputs:
        outputs.append("count(*) AS vg_none")
    entries.append(f"vg_groups AS (SELECT {', '.join(outputs)} FROM vg_rows{group_by})")
    identifiers = dict(group_scope.map)
    compiler.set_columns(identifiers)
    having = f" WHERE {compiler.expression(plan.having)}" if plan.having else ""
    entries.append(f"vg_view AS (SELECT * FROM vg_groups{having})")
    order = [
        term for key in plan.sort for term in _sort_terms(identifiers[key.column["name"]], key.column, key.direction)
    ]
    return SqlView(
        with_=f"WITH {', '.join(entries)}",
        params=compiler.params.values,
        columns=columns,
        order=[*order, *(term for key in keys for term in _key_terms(identifiers[key["name"]], key))],
        row_ids=False,
        row_id=None,
        identifiers=identifiers,
    )


def rows_query(view: SqlView, read: SqlRead, output: Callable[[Column, str], str] | None = None) -> SqlQuery:
    """The query that reads positions of a view, in order: the columns, then the row ID when the view has them.
    `output` (TypeScript's `select`) may wrap each column, for example to read exact numbers as text."""
    if not (is_safe_integer(read.start) and is_safe_integer(read.end) and 0 <= read.start <= read.end):
        raise ValueError("A read is a range of positions from 0, [start, end).")
    by_name = {item["name"]: item for item in view.columns}
    outputs: list[str] = []
    for name in read.columns:
        column = by_name.get(name)
        if column is None:
            raise ValueError(f'The view has no column "{name}".')
        sql = view_column(view, name)
        outputs.append(output(column, sql) if output else sql)
    if view.row_id:
        outputs.append(view.row_id)
    if not outputs:
        outputs.append("NULL")
    order = f" ORDER BY {', '.join(view.order)}" if view.order else ""
    return SqlQuery(
        f"{view.with_} SELECT {', '.join(outputs)} FROM vg_view{order} "
        f"LIMIT {number_text(read.end - read.start)} OFFSET {number_text(read.start)}",
        view.params,
    )


def count_query(view: SqlView) -> SqlQuery:
    """The query that counts the rows of a view."""
    return SqlQuery(f"{view.with_} SELECT count(*) FROM vg_view", view.params)
