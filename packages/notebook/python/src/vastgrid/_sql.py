"""Plans as DuckDB SQL (docs/spec.md §3, §4). The SQL implements the specification, not DuckDB's defaults where
they differ. Values are always parameters (`$1`, `$2`, … for `connection.execute(sql, params)`) and names are always
quoted. The session's time zone must be UTC, so that the text form of `timestamptz` values is the one of §2.4."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from ._check import CallExpr, CheckedMeasure, CheckedPlan, ColumnExpr, LiteralExpr, SearchExpr, TypedExpr, value_type
from ._plan import SpecError
from ._values import is_number, is_safe_integer, js_float, js_string, number_text, value_of_text

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


@dataclass
class SqlRead:
    """What `rows_query` reads: positions `[start, end)` and the view's columns, by name."""

    start: int
    end: int
    columns: list[str]


_NUMBER_PATTERN = r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?"
_DATE_PATTERN = "[0-9]{4}-[0-9]{2}-[0-9]{2}"
_TIMESTAMP_PATTERN = r"[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?"
_FLOAT_TOKENS = {"NaN": "'NaN'", "Infinity": "'Infinity'", "-Infinity": "'-Infinity'"}


class _Params:
    def __init__(self, initial: Sequence[SqlValue] = ()) -> None:
        self.values: list[SqlValue] = list(initial)

    def add(self, value: SqlValue) -> str:
        self.values.append(value)
        return f"${len(self.values)}"


def quote_identifier(name: str) -> str:
    """A name as a DuckDB identifier."""
    return '"' + name.replace('"', '""') + '"'


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
    text = f"CAST({sql} AS VARCHAR)"
    scale = type.get("scale") or 0
    precision = type.get("precision")
    if type["type"] == "decimal" and scale > 0 and scale == (38 if precision is None else precision):
        return f"regexp_replace({text}, '^(-?)\\.', '\\10.')"
    if type["type"] == "float" and type.get("bits") == 32:
        # DuckDB writes some 32-bit floats with all their exact digits (5525.71875 for 5525.7188): the shortest digits
        # that read back as the same float, which `printf` rounds halves to even, written as the double they are.
        shortest = " ".join(
            f"WHEN CAST(printf('%.{digits}e', {sql}) AS FLOAT) = {sql} "
            f"THEN CAST(CAST(printf('%.{digits}e', {sql}) AS DOUBLE) AS VARCHAR)"
            for digits in range(8)
        )
        return f"(CASE WHEN NOT isfinite({sql}) THEN {text} {shortest} ELSE {text} END)"
    return text


def _at_least(sql: str, low: int) -> str:
    """A count of code points from `low`: below it counts as `low`, and beyond 2^32 − 1, the most that DuckDB's
    `substring` takes, as 2^32 − 1, which no string reaches."""
    value = f"CAST({sql} AS BIGINT)"
    return f"(CASE WHEN {value} < {low} THEN {low} WHEN {value} > 4294967295 THEN 4294967295 ELSE {value} END)"


def _cast(sql: str, type: dict[str, Any]) -> str:
    return f"CAST({sql} AS {duckdb_type(type)})"


def _try_cast(sql: str, type: dict[str, Any]) -> str:
    return f"TRY_CAST({sql} AS {duckdb_type(type)})"


def float_param(value: int | float) -> str:
    """A float as text that DuckDB reads back as the same float, with the sign of −0.0. Floats are bound as text, as
    JavaScript's `String(number)` writes them."""
    number = js_float(value)
    return "-0.0" if number == 0 and math.copysign(1, number) < 0 else number_text(number)


def _finite(sql: str) -> str:
    """Null unless the number is finite (§3.6)."""
    return f"(CASE WHEN isfinite({sql}) THEN {sql} END)"


class _Compiler:
    def __init__(self, params: _Params) -> None:
        self.params = params

    def expression(self, node: TypedExpr) -> str:
        if isinstance(node, ColumnExpr):
            return quote_identifier(node.name)
        if isinstance(node, LiteralExpr):
            return self._literal(node)
        if isinstance(node, SearchExpr):
            if not node.columns:
                return "FALSE"
            text = f"CAST({self.params.add(node.text)} AS VARCHAR)"
            matches = [
                f"coalesce(contains(lower({text_sql(quote_identifier(column['name']), column)}), lower({text})), FALSE)"
                for column in node.columns
            ]
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
            if is_number(node.value):
                return f"CAST(CAST({self.params.add(float_param(node.value))} AS VARCHAR) AS DOUBLE)"
            token = _FLOAT_TOKENS.get(js_string(node.value))
            if token is None:
                raise ValueError(f"{js_string(node.value)} is not a float.")
            return f"CAST({token} AS DOUBLE)"
        if kind == "string":
            return f"CAST({self.params.add(js_string(node.value))} AS VARCHAR)"
        if kind == "binary":
            return f"from_base64(CAST({self.params.add(js_string(node.value))} AS VARCHAR))"
        return _cast(f"CAST({self.params.add(js_string(node.value))} AS VARCHAR)", type)

    def _number(self, node: TypedExpr) -> str:
        """A number argument: floats that are not finite become null (§3.6)."""
        sql = self.expression(node)
        return _finite(sql) if node.type["type"] == "float" else sql

    def _double(self, node: TypedExpr) -> str:
        return f"CAST({self._number(node)} AS DOUBLE)"

    def _exact(self, node: TypedExpr) -> str:
        """An exact operand of a decimal operation: integers are decimal(10, 0) and bigints decimal(19, 0) (§3.7)."""
        sql = self.expression(node)
        if node.type["type"] == "integer":
            return f"CAST({sql} AS DECIMAL(10,0))"
        if node.type["type"] == "bigint":
            return f"CAST({sql} AS DECIMAL(19,0))"
        return sql

    def _text(self, node: TypedExpr) -> str:
        sql = self.expression(node)
        return sql if node.type["type"] == "null" else text_sql(sql, node.type)

    def _call(self, node: CallExpr) -> str:
        args = node.args
        type = node.type
        fn = node.fn

        def arg(index: int) -> str:
            return self.expression(args[index])

        def every(separator: str) -> str:
            return separator.join(self.expression(item) for item in args)

        def typed() -> str:
            # Values in their common type (§4.4); a value that does not fit it is null (§3.6).
            return ", ".join(_try_cast(self.expression(item), type) for item in args)

        if fn == "and":
            return f"({every(' AND ')})"
        if fn == "or":
            return f"({every(' OR ')})"
        if fn == "not":
            return f"(NOT {arg(0)})"
        if fn in _COMPARISONS:
            return f"({arg(0)} {_COMPARISONS[fn]} {arg(1)})"
        if fn == "in":
            return f"({arg(0)} IN ({', '.join(self.expression(item) for item in args[1:])}))"
        if fn == "is_null":
            return f"({arg(0)} IS NULL)"
        if fn == "is_blank":
            if args[0].type["type"] == "null":
                return "TRUE"
            value = arg(0)
            return f"({value} IS NULL OR {value} = '')" if args[0].type["type"] == "string" else f"({value} IS NULL)"
        if fn == "if":
            return f"(CASE WHEN {arg(0)} THEN {_try_cast(arg(1), type)} ELSE {_try_cast(arg(2), type)} END)"
        if fn == "coalesce":
            # The first value that is not null, in the common type: null when it does not fit, as in the JS engine.
            cases = [f"WHEN {arg(index)} IS NOT NULL THEN {_try_cast(arg(index), type)}" for index in range(len(args))]
            return f"(CASE {' '.join(cases)} END)"
        if fn in ("least", "greatest"):
            return f"{fn}({typed()})"
        if fn in _OPERATORS:
            operator = _OPERATORS[fn]
            if type["type"] == "float":
                return _finite(f"({self._double(args[0])} {operator} {self._double(args[1])})")
            if type["type"] == "bigint":
                return f"TRY(CAST({arg(0)} AS BIGINT) {operator} CAST({arg(1)} AS BIGINT))"
            return f"TRY({_cast(f'({self._exact(args[0])} {operator} {self._exact(args[1])})', type)})"
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
            # 64-bit, also for a 32-bit float column (§3.7).
            if type["type"] == "float":
                return _finite(f"round({self._double(args[0])}, {digits})")
            if type["type"] != "decimal" and places >= 0:
                return arg(0)
            # Rounding past the type's range fails, which TRY makes null (§3.6).
            return f"TRY({_cast(f'round({arg(0)}, {digits})', type)})"
        if fn in ("floor", "ceil"):
            if type["type"] == "float":
                return _finite(f"{fn}({self._number(args[0])})")
            if type["type"] == "decimal":
                return _cast(f"{fn}({arg(0)})", type)
            return arg(0)
        if fn in ("sqrt", "exp", "ln", "log10"):
            return _finite(f"TRY({fn}({self._double(args[0])}))")
        if fn == "power":
            return _finite(f"TRY(power({self._double(args[0])}, {self._double(args[1])}))")
        if fn == "sign":
            return f"CAST(sign({self._number(args[0])}) AS INTEGER)"
        if fn == "to_number":
            value = f"trim({arg(0)})"
            return (
                f"(CASE WHEN regexp_full_match({value}, '{_NUMBER_PATTERN}') "
                f"THEN {_finite(f'TRY_CAST({value} AS DOUBLE)')} END)"
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
        if fn == "replace":
            return f"replace({arg(0)}, {arg(1)}, {arg(2)})"
        if fn in ("contains", "starts_with", "ends_with"):
            return f"{fn}({arg(0)}, {arg(1)})"
        if fn == "text":
            return self._text(args[0])
        if fn == "to_date":
            value = arg(0)
            return f"(CASE WHEN regexp_full_match({value}, '{_DATE_PATTERN}') THEN TRY_CAST({value} AS DATE) END)"
        if fn == "to_timestamp":
            value = arg(0)
            return (
                f"(CASE WHEN regexp_full_match({value}, '{_TIMESTAMP_PATTERN}') "
                f"THEN TRY_CAST(replace({value}, 'T', ' ') AS TIMESTAMP) END)"
            )
        if fn in ("year", "month", "day", "hour", "minute", "second", "isodow"):
            return f"CAST({fn}({arg(0)}) AS BIGINT)"
        if fn == "date_diff_days":
            mixed = args[0].type["type"] != args[1].type["type"]

            def side(index: int) -> str:
                return f"CAST({arg(index)} AS TIMESTAMP)" if mixed else arg(index)

            return f"date_diff('day', {side(0)}, {side(1)})"
        if fn == "add_days":
            days = f"TRY_CAST({arg(1)} AS INTEGER)"
            total = f"TRY({arg(0)} + {days})" if type["type"] == "date" else f"TRY({arg(0)} + to_days({days}))"
            # Years from 1 to 9999 (§2.2), as the JS engine gives them: DuckDB's dates go further, and a later date
            # would sort as itself and read as null.
            return f"(CASE WHEN year({total}) BETWEEN 1 AND 9999 THEN {total} END)"
        raise ValueError(f"There is no function {fn}.")

    def unscaled_sum(self, measure: CheckedMeasure, where: str) -> str | None:
        """The sum of a wide decimal column as a HUGEINT of its digits, or None for other columns. DuckDB sums a
        decimal(p, s) as a decimal(38, s) and refuses a sum beyond 38 digits, also inside avg; a decimal of up to 18
        digits needs more rows than a table has to get there. The digits after the point are multiplied out as a
        decimal of 38 digits, which holds those of up to 19."""
        decimal = measure.column
        scale = (decimal or {}).get("scale") or 0
        if decimal is None or decimal["type"] != "decimal" or (decimal.get("precision") or 38) <= 18 or scale > 19:
            return None
        column = quote_identifier(decimal["name"])
        factor = "1" + "0" * scale
        # trunc keeps the type: both parts and their sum fit in a HUGEINT.
        whole = f"CAST(trunc({column}) AS HUGEINT) * {factor}"
        digits = (
            f"CAST({column} AS HUGEINT)"
            if scale == 0
            else f"{whole} + CAST(({column} - trunc({column})) * {factor} AS HUGEINT)"
        )
        return f"sum({digits}){where}"

    def measure(self, measure: CheckedMeasure, condition: str | None = None) -> str:
        """A measure (§3.8, §4.5), optionally over the rows of a pivot's combination."""
        column = quote_identifier(measure.column["name"]) if measure.column else None
        conditions: list[str] = []
        if measure.column and measure.column["type"] == "float" and measure.fn not in ("count", "count_distinct"):
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
            unscaled = self.unscaled_sum(measure, where)
            if unscaled:
                # A HUGEINT of the sum's digits, which holds more than 38 of them: a sum beyond them is null (§3.8).
                point = f"0.{'0' * (scale - 1)}1" if scale > 0 else "1"
                total = f"(CAST({unscaled} AS DECIMAL(38, 0)) * {point})"
                return f"(CASE WHEN abs({unscaled}) <= {'9' * 38} THEN {total} END)"
            # DuckDB refuses aggregates inside TRY(); TRY_CAST takes them. The sum of integers is a HUGEINT, which
            # holds more than 38 digits: a sum beyond them is null (§3.8).
            total = f"TRY_CAST(sum({column}){where} AS {duckdb_type(measure.type)})"
            largest = "9" * (38 - scale) + (f".{'9' * scale}" if scale > 0 else "")
            return f"(CASE WHEN abs({total}) <= {largest} THEN {total} END)"
        if fn == "avg":
            unscaled = self.unscaled_sum(measure, where)
            if unscaled:
                scale = (measure.column or {}).get("scale") or 0
                return f"(CAST({unscaled} AS DOUBLE) / 1e{scale} / count({column}){where})"
            return f"CAST(avg({column}){where} AS DOUBLE)"
        if fn == "stddev":
            # DuckDB gives the infinities and NaN for squares beyond the largest float; the JS engine gives null.
            stddev = f"CAST(stddev_samp({column}){where} AS DOUBLE)"
            return f"(CASE WHEN isfinite({stddev}) THEN {stddev} END)"
        if fn in ("min", "max"):
            return f"{fn}({column}){where}"
        # quantile, interpolated in doubles, also for a 32-bit float column (§3.7).
        name = "approx_quantile" if measure.approx else "quantile_cont"
        return f"{name}(CAST({column} AS DOUBLE), {number_text(measure.p)}){where}"


_COMPARISONS = {"eq": "=", "ne": "<>", "lt": "<", "le": "<=", "gt": ">", "ge": ">="}
_OPERATORS = {"add": "+", "sub": "-", "mul": "*", "mod": "%"}


def _sort_terms(sql: str, type: dict[str, Any], direction: str) -> list[str]:
    """ORDER BY terms of one sort key: blanks last in both directions (§3.3)."""
    order = "DESC" if direction == "desc" else "ASC"
    return [f"NULLIF({sql}, '') {order} NULLS LAST"] if type["type"] == "string" else [f"{sql} {order} NULLS LAST"]


def _key_terms(column: Column) -> list[str]:
    """ORDER BY terms of group keys (§3.9): ascending, blanks last, the empty string before null."""
    sql = quote_identifier(column["name"])
    if column["type"] == "string":
        return [f"NULLIF({sql}, '') ASC NULLS LAST", f"{sql} ASC NULLS LAST"]
    return [f"{sql} ASC NULLS LAST"]


def _row_id_alias(plan: CheckedPlan) -> str:
    """A name for the column of row IDs that no column of the plan has."""
    names = {column["name"] for column in plan.rows}
    alias = "vg_row"
    while alias in names:
        alias += "_"
    return quote_identifier(alias)


def _rows_with(plan: CheckedPlan, source: SqlSource, compiler: _Compiler, alias: str) -> list[str]:
    """The `WITH` entries up to `vg_rows`, the rows that `where` keeps, with the derived columns."""
    columns = [quote_identifier(column["name"]) for column in plan.table]
    entries = [f"vg_base AS (SELECT {', '.join([*columns, f'{source.row_id} AS {alias}'])} FROM {source.relation})"]
    previous = "vg_base"
    for index, item in enumerate(plan.derive):
        name = f"vg_derive{index + 1}"
        entries.append(
            f"{name} AS (SELECT *, {compiler.expression(item.expr)} AS {quote_identifier(item.name)} FROM {previous})"
        )
        previous = name
    where = f" WHERE {compiler.expression(plan.where)}" if plan.where else ""
    entries.append(f"vg_rows AS (SELECT * FROM {previous}{where})")
    return entries


def pivot_query(plan: CheckedPlan, source: SqlSource) -> SqlQuery:
    """The query that reads the combinations of a pivot's values (§4.6), as their text forms, in order. It reads one
    more combination than the pivot may make columns for, so that `compile_view` can refuse too many."""
    pivot = plan.aggregate.pivot if plan.aggregate else None
    if pivot is None or plan.aggregate is None:
        raise ValueError("The plan has no pivot.")
    compiler = _Compiler(_Params(source.params))
    entries = _rows_with(plan, source, compiler, _row_id_alias(plan))
    names = [quote_identifier(column["name"]) for column in pivot.columns]
    texts = [
        f'{text_sql(quote_identifier(column["name"]), column)} AS "vg_value{index}"'
        for index, column in enumerate(pivot.columns)
    ]
    limit = pivot.max_columns // len(plan.aggregate.measures) + 1
    order = ", ".join(term for column in pivot.columns for term in _key_terms(column))
    sql = (
        f"WITH {', '.join(entries)} SELECT {', '.join(texts)} FROM (SELECT DISTINCT {', '.join(names)} FROM vg_rows) "
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
    alias = _row_id_alias(plan)
    entries = _rows_with(plan, source, compiler, alias)
    order = [
        term
        for key in plan.sort
        for term in _sort_terms(quote_identifier(key.column["name"]), key.column, key.direction)
    ]
    if plan.aggregate is None:
        entries.append("vg_view AS (SELECT * FROM vg_rows)")
        return SqlView(
            with_=f"WITH {', '.join(entries)}",
            params=compiler.params.values,
            columns=plan.columns,
            order=[*order, f"{alias} ASC"],
            row_ids=True,
            row_id=alias,
        )
    keys, measures, pivot = plan.aggregate.keys, plan.aggregate.measures, plan.aggregate.pivot
    columns = list(plan.columns)
    outputs = [quote_identifier(key["name"]) for key in keys]
    if pivot is not None:
        if combinations is None:
            raise ValueError("A pivot needs the combinations that pivot_query reads.")
        if len(combinations) > pivot.max_columns // len(measures):
            raise SpecError("too_many_columns", f"The pivot makes more than {pivot.max_columns} columns.")
        taken = {column["name"] for column in columns}
        for combination in combinations:
            condition = " AND ".join(
                f"({quote_identifier(column['name'])} IS NOT DISTINCT FROM "
                + (
                    f"CAST(NULL AS {duckdb_type(column)})"
                    if combination[index] is None
                    else _cast(f"CAST({compiler.params.add(combination[index])} AS VARCHAR)", column)
                )
                + ")"
                for index, column in enumerate(pivot.columns)
            )
            labels = ["(null)" if text is None else "(empty)" if text == "" else text for text in combination]
            for measure in measures:
                name = _unique_name(" / ".join([*labels, measure.name]), taken)
                outputs.append(f"{compiler.measure(measure, condition)} AS {quote_identifier(name)}")
                columns.append(
                    {
                        "name": name,
                        **value_type(measure.type),
                        "pivot": {
                            "values": [
                                value_of_text(text, pivot.columns[index]) for index, text in enumerate(combination)
                            ],
                            "measure": measure.name,
                        },
                    }
                )
    else:
        outputs += [f"{compiler.measure(measure)} AS {quote_identifier(measure.name)}" for measure in measures]
    group_by = f" GROUP BY {', '.join(quote_identifier(key['name']) for key in keys)}" if keys else ""
    # A pivot without keys whose rows make no combination has no columns, and one group.
    if not outputs:
        outputs.append("count(*) AS vg_none")
    entries.append(f"vg_groups AS (SELECT {', '.join(outputs)} FROM vg_rows{group_by})")
    having = f" WHERE {compiler.expression(plan.having)}" if plan.having else ""
    entries.append(f"vg_view AS (SELECT * FROM vg_groups{having})")
    return SqlView(
        with_=f"WITH {', '.join(entries)}",
        params=compiler.params.values,
        columns=columns,
        order=[*order, *(term for key in keys for term in _key_terms(key))],
        row_ids=False,
        row_id=None,
    )


def rows_query(view: SqlView, read: SqlRead, output: Callable[[Column, str], str] | None = None) -> SqlQuery:
    """The query that reads positions of a view, in order: the columns, then the row ID when the view has them.
    `output` (TypeScript's `select`) may wrap each column, for example to read exact numbers as text."""
    if not (is_safe_integer(read.start) and is_safe_integer(read.end) and 0 <= read.start <= read.end):
        raise ValueError("A read is a range of positions from 0, [start, end).")
    outputs: list[str] = []
    for name in read.columns:
        column = next((item for item in view.columns if item["name"] == name), None)
        if column is None:
            raise ValueError(f'The view has no column "{name}".')
        sql = quote_identifier(name)
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
