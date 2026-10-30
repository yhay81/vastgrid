"""Plans and expressions (docs/spec.md §4): their limits and errors. Plans themselves stay JSON: dicts and lists."""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any

FUNCTIONS: tuple[str, ...] = (
    # Logic and comparison
    "and",
    "or",
    "not",
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "in",
    "is_null",
    "is_blank",
    "if",
    "coalesce",
    "least",
    "greatest",
    # Arithmetic and numbers
    "add",
    "sub",
    "mul",
    "div",
    "mod",
    "neg",
    "abs",
    "round",
    "floor",
    "ceil",
    "bin",
    "sqrt",
    "exp",
    "ln",
    "log10",
    "power",
    "sign",
    "to_number",
    # Text
    "concat",
    "length",
    "lower",
    "upper",
    "trim",
    "left",
    "right",
    "substr",
    "replace",
    "contains",
    "starts_with",
    "ends_with",
    "text",
    # Dates and times
    "to_date",
    "to_timestamp",
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "isodow",
    "date_diff_days",
    "add_days",
)
"""The functions of expressions (§4.4)."""

MEASURES: tuple[str, ...] = ("count", "count_distinct", "sum", "avg", "stddev", "min", "max", "quantile")
"""The functions of measures (§4.5)."""

PLAN_MEMBERS: tuple[str, ...] = ("derive", "where", "aggregate", "pivot", "having", "sort", "search")
"""The members of a plan that an engine may not evaluate (§4.10)."""


@dataclass(frozen=True)
class Limits:
    """The limits of §4.9."""

    derive: int = 32
    name: int = 256
    nodes: int = 1000
    depth: int = 64
    in_literals: int = 100_000
    sort_keys: int = 32
    keys: int = 16
    pivot_columns: int = 16
    measures: int = 64
    pivot_output: int = 1000
    pivot_default: int = 200


LIMITS = Limits()

PLAN_ERROR_REASONS: tuple[str, ...] = (
    "syntax",
    "unknown_column",
    "duplicate_name",
    "type",
    "arity",
    "unknown_function",
    "unsupported",
    "misplaced",
    "literal",
    "limit",
)
"""Why a plan does not validate (§4.7)."""


class PlanError(Exception):
    """A plan that does not validate against a table (§4.7): `path` is a JSON Pointer to the member at fault."""

    code = "invalid_plan"

    def __init__(self, path: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.path = path
        self.reason = reason
        self.message = message


class SpecError(Exception):
    """An error of §8.7 other than `invalid_plan`, such as `too_many_columns`."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_ELSEWHERE = {
    "check_plan": "_check",
    "check_expression": "_check",
    "plan_options": "_check",
    "canonical_json": "_hash",
    "normalize_plan": "_hash",
    "plan_hash": "_hash",
}


def __getattr__(name: str) -> Any:
    """Checking (§4.7) and hashing (§4.8) live in `_check`, which imports this module, and `_hash`; this module gives
    them too, on first use."""
    if name in _ELSEWHERE:
        return getattr(importlib.import_module(f"{__package__}.{_ELSEWHERE[name]}"), name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
