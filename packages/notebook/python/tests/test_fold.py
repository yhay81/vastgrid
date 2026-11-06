"""Searches with folds on DuckDB (docs/spec.md §3.5, §4.4), as packages/sql/test/fold.test.ts checks them: the values
are folded only by the parts of the folds that a search needs, and find the rows that folding everything finds."""

from __future__ import annotations

import duckdb
import pytest

from vastgrid._check import check_plan
from vastgrid._fold import FOLD_TABLES, fold_all
from vastgrid._sql import SqlRead, SqlSource, compile_view, quote_identifier, rows_query

ALPHABET = list("ｶｷﾊﾀｳﾜｦｲﾔﾌｪﾞﾟ゙゚カガキギハバパタダウヴイヤフェかがきぎはばぱただうゔいやふぇ") + list(
    "aAａＡbBｂＢ　 。｡「｢東京0０-"
)
PAIRS = ["ｶﾞ", "ｶﾞｶ", "ﾊﾟﾊﾞ", "ｳﾞ", "ﾜﾞｦﾞ", "ﾞ", "ﾟ", "ｶ゙", "ガ", "ﾀﾞｲﾔ"]
MARKS = ["ｶ", "カ", "か", "ハ", "ウ", "ワ", "ｦ", "タ", "゙", "゚", "ﾞ", "ﾟ", "ガ", "パ", "ヴ", "ヷ", "Ａ"]
COLUMNS = [{"name": "s", "type": "string"}]
SOURCE = SqlSource(quote_identifier("t"), "id")


class Random:
    """The generator of the TypeScript test, so that both check the same texts."""

    def __init__(self, seed: int) -> None:
        self.state = seed

    def __call__(self, limit: int) -> int:
        self.state = (self.state * 1103515245 + 12345) % 2147483648
        return self.state % limit


def _text(next_value: Random, length: int) -> str:
    return "".join(ALPHABET[next_value(len(ALPHABET))] for _ in range(length))


NEXT = Random(17)
VALUES = PAIRS + [_text(NEXT, 1 + NEXT(6)) for _ in range(400)]


@pytest.fixture(scope="module")
def connection():
    connection = duckdb.connect(":memory:")
    connection.execute("CREATE TABLE t (id BIGINT, s VARCHAR)")
    connection.executemany("INSERT INTO t VALUES (?, ?)", list(enumerate(VALUES)))
    yield connection
    connection.close()


def _read(connection: duckdb.DuckDBPyConnection, plan: dict, columns: list[str]) -> list[tuple]:
    view = compile_view(check_plan(plan, COLUMNS), SOURCE)
    query = rows_query(view, SqlRead(0, len(VALUES), columns))
    return connection.execute(query.sql, query.params).fetchall()


@pytest.mark.parametrize("folds", [["width"], ["kana"], ["width", "kana"]])
def test_search_finds_what_folding_everything_finds(connection, folds: list[str]) -> None:
    # A search needs text other than spaces.
    needles = [needle for needle in (_text(NEXT, 1 + NEXT(3)) for _ in range(60)) if needle.strip()] + MARKS
    for needle in needles:
        folded = fold_all(needle, folds).lower()
        expected = [index for index, value in enumerate(VALUES) if folded in fold_all(value, folds).lower()]
        rows = _read(connection, {"where": {"search": needle, "fold": folds}}, [])
        assert sorted(int(row[-1]) for row in rows) == expected, f"{needle!r} folded by {folds}"


def test_search_folds_only_what_can_make_its_text() -> None:
    def sql(search: str, folds: list[str], columns: list[dict] = COLUMNS) -> str:
        return compile_view(check_plan({"where": {"search": search, "fold": folds}}, columns), SOURCE).with_

    assert not any(name in sql("東京", ["width", "kana"]) for name in ("replace", "translate", "regexp_matches"))
    kana = sql("かふぇ", ["width", "kana"])
    assert "regexp_matches" in kana and "replace(" in kana and "translate(" not in kana
    uuid = sql("０ｆ", ["width"], [{"name": "u", "type": "uuid"}])
    assert not any(name in uuid for name in ("replace", "translate", "regexp_matches"))


@pytest.mark.parametrize("fold", list(FOLD_TABLES))
def test_fold_in_an_expression_folds_every_code_point(connection, fold: str) -> None:
    for arg, suffix in (({"col": "s"}, ""), ({"fn": "concat", "args": [{"col": "s"}, {"lit": "ｶ"}]}, "ｶ")):
        plan = {"derive": [{"name": "f", "expr": {"fn": "fold", "args": [arg, {"lit": fold}]}}]}
        rows = _read(connection, plan, ["f"])
        assert [row[0] for row in rows] == [fold_all(value + suffix, [fold]) for value in VALUES]
