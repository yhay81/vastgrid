"""The normal form and the hash of plans (docs/spec.md §4.8), byte for byte as the TypeScript implementation
writes them."""

from __future__ import annotations

import hashlib
import math
from typing import Any

from ._values import combine_pairs, is_number, js_float, number_text, quote


def normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """The plan without `derive` and `sort` when they are empty; everything else stays as it is."""
    normal: dict[str, Any] = {}
    if _has_items(plan.get("derive")):
        normal["derive"] = plan["derive"]
    for member in ("where", "aggregate", "having"):
        if member in plan:
            normal[member] = plan[member]
    if _has_items(plan.get("sort")):
        normal["sort"] = plan["sort"]
    return normal


def _has_items(value: Any) -> bool:
    """`value && value.length > 0`."""
    return isinstance(value, (list, tuple, str)) and len(value) > 0


def canonical_json(value: Any) -> str:
    """JSON with the members of every object sorted by name in code point order and no white space; strings and
    numbers as `JSON.stringify` writes them."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return quote(value)
    if is_number(value):
        if not math.isfinite(js_float(value)):
            raise TypeError("JSON has no numbers that are not finite.")
        return number_text(value)
    if isinstance(value, (list, tuple)):
        return f"[{','.join(canonical_json(item) for item in value)}]"
    if isinstance(value, dict):
        keys = sorted(value, key=combine_pairs)
        return "{" + ",".join(f"{quote(key)}:{canonical_json(value[key])}" for key in keys) + "}"
    raise TypeError(f"JSON has no {type(value).__name__} values.")


def plan_hash(plan: dict[str, Any]) -> str:
    """`sha256:` and the lowercase hex SHA-256 of the plan's normal form in UTF-8."""
    return "sha256:" + hashlib.sha256(canonical_json(normalize_plan(plan)).encode("utf-8")).hexdigest()
