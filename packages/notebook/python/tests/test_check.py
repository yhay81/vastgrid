"""Checking plans (§4.7), with the vectors of packages/spec/test/check.test.ts."""

from __future__ import annotations

from typing import Any

from vastgrid._check import arithmetic_type, check_plan
from vastgrid._plan import PlanError

COLUMNS = [
    {"name": "qty", "type": "integer"},
    {"name": "price", "type": "decimal", "precision": 10, "scale": 2},
    {"name": "name", "type": "string"},
    {"name": "score", "type": "float", "bits": 32},
]


def reason(plan: Any, options: Any = None) -> tuple[str, str] | None:
    try:
        check_plan(plan, COLUMNS, options)
    except PlanError as error:
        return error.reason, error.path
    return None


def decimal(precision: int, scale: int) -> dict[str, Any]:
    return {"type": "decimal", "precision": precision, "scale": scale}


def test_numeric_results_have_the_types_of_3_7():
    assert arithmetic_type("add", {"type": "integer"}, {"type": "integer"}) == {"type": "bigint"}
    assert arithmetic_type("add", decimal(10, 2), decimal(5, 3)) == decimal(12, 3)
    assert arithmetic_type("mul", decimal(10, 2), decimal(5, 3)) == decimal(15, 5)
    assert arithmetic_type("mul", decimal(38, 20), decimal(38, 20)) == {"type": "float"}
    assert arithmetic_type("add", {"type": "bigint"}, decimal(3, 1)) == decimal(21, 1)
    assert arithmetic_type("mod", decimal(3, 1), {"type": "integer"}) == decimal(11, 1)
    assert arithmetic_type("add", decimal(38, 0), decimal(38, 0)) == decimal(38, 0)
    assert arithmetic_type("div", {"type": "integer"}, {"type": "integer"}) == {"type": "float"}
    assert arithmetic_type("add", {"type": "float", "bits": 32}, {"type": "integer"}) == {"type": "float"}


def test_the_views_columns_are_the_tables_and_the_derived_ones_or_the_keys_and_the_measures():
    plain = check_plan(
        {"derive": [{"name": "total", "expr": {"fn": "mul", "args": [{"col": "qty"}, {"col": "price"}]}}]}, COLUMNS
    )
    assert [(column["name"], column["type"]) for column in plain.columns] == [
        ("qty", "integer"),
        ("price", "decimal"),
        ("name", "string"),
        ("score", "float"),
        ("total", "decimal"),
    ]
    assert plain.row_ids is True
    grouped = check_plan(
        {
            "aggregate": {
                "keys": ["name"],
                "measures": [{"name": "low", "fn": "min", "column": "score"}, {"name": "n", "fn": "count"}],
            }
        },
        COLUMNS,
    )
    assert grouped.columns == [
        {"name": "name", "type": "string"},
        {"name": "low", "type": "float", "bits": 32},
        {"name": "n", "type": "bigint"},
    ]
    assert grouped.row_ids is False


def test_engines_that_do_not_offer_something_refuse_it():
    where = {"fn": "contains", "args": [{"col": "name"}, {"lit": "a"}]}
    assert reason({"where": where}, {"functions": ["eq"]}) == ("unsupported", "/where")
    assert reason({"where": {"search": "a"}}, {"plan": {"search": False}}) == ("unsupported", "/where")
    assert reason({"sort": []}, {"plan": {"sort": False}}) == ("unsupported", "/sort")
    quantile = {"aggregate": {"keys": [], "measures": [{"name": "q", "fn": "quantile", "column": "qty", "p": 0.5}]}}
    assert reason(quantile, {"measures": ["count"]}) == ("unsupported", "/aggregate/measures/0/fn")


def test_plans_keep_within_the_limits_of_4_9():
    derive = [{"name": f"d{index}", "expr": {"lit": index}} for index in range(33)]
    assert reason({"derive": derive}) == ("limit", "/derive")
    deep: dict[str, Any] = {"col": "qty"}
    for _ in range(64):
        deep = {"fn": "neg", "args": [deep]}
    assert reason({"derive": [{"name": "x", "expr": deep}]})[0] == "limit"
    wide = {"fn": "and", "args": [{"lit": True}] * 1000}
    assert reason({"where": wide}) == ("limit", "/where")
    values = [{"lit": index} for index in range(100_001)]
    assert reason({"where": {"fn": "in", "args": [{"col": "qty"}, *values]}}) == ("limit", "/where")
    sort = [{"column": "qty", "direction": "asc"}] * 33
    assert reason({"aggregate": {"keys": [], "measures": []}, "sort": sort}) == ("limit", "/sort")


def test_rounds_digits_and_ins_values_are_literals():
    def derive(expr: Any) -> Any:
        return {"derive": [{"name": "x", "expr": expr}]}

    assert reason(derive({"fn": "round", "args": [{"col": "price"}, {"col": "qty"}]})) == (
        "type",
        "/derive/0/expr/args/1",
    )
    assert reason(derive({"fn": "round", "args": [{"col": "price"}, {"lit": 19}]})) == ("type", "/derive/0/expr/args/1")
    for item in ({"col": "qty"}, {"lit": None}, {"lit": "1"}):
        assert reason({"where": {"fn": "in", "args": [{"col": "qty"}, item]}}) == ("type", "/where/args/1")


def test_rounding_a_decimal_keeps_at_most_its_scale():
    plan = check_plan(
        {
            "derive": [
                {"name": "a", "expr": {"fn": "round", "args": [{"col": "price"}, {"lit": 1}]}},
                {"name": "b", "expr": {"fn": "round", "args": [{"col": "price"}, {"lit": 5.0}]}},
                {"name": "c", "expr": {"fn": "round", "args": [{"col": "price"}, {"lit": -2}]}},
            ]
        },
        COLUMNS,
    )
    assert [(item.column["precision"], item.column["scale"]) for item in plan.derive] == [(10, 1), (10, 2), (10, 0)]


def test_names_are_1_to_256_characters_counted_in_code_points():
    assert reason({"derive": [{"name": "😀" * 256, "expr": {"lit": 1}}]}) is None
    assert reason({"derive": [{"name": "😀" * 256, "expr": {"lit": 1}}]}) is None
    assert reason({"derive": [{"name": "a" * 257, "expr": {"lit": 1}}]}) == ("syntax", "/derive/0/name")
    assert reason({"derive": [{"name": "", "expr": {"lit": 1}}]}) == ("syntax", "/derive/0/name")


def test_numbers_are_read_as_javascript_reads_them():
    plan = check_plan({"derive": [{"name": "a", "expr": {"lit": 1.0}}, {"name": "b", "expr": {"lit": 2**53}}]}, COLUMNS)
    assert [item.column["type"] for item in plan.derive] == ["bigint", "float"]
    assert reason({"derive": [{"name": "x", "expr": {"lit": 10**400}}]}) == ("literal", "/derive/0/expr")
    assert reason({"derive": [{"name": "x", "expr": {"lit": 1, "zz": 1, "0": 1}}]}) == ("syntax", "/derive/0/expr/0")
