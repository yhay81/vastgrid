"""The normal form and the hash of plans (§4.8), with the vectors of packages/spec/test/hash.test.ts."""

from __future__ import annotations

import hashlib
import json
import re

import pytest

from vastgrid._hash import canonical_json, normalize_plan, plan_hash


def test_the_normal_form_leaves_out_empty_derive_and_sort():
    plan = {"derive": [], "sort": [], "where": {"col": "ok"}, "aggregate": {"keys": [], "measures": []}}
    assert normalize_plan(plan) == {"where": {"col": "ok"}, "aggregate": {"keys": [], "measures": []}}


def test_canonical_json_sorts_members_by_code_point_without_white_space():
    assert canonical_json({"b": 1, "a": [True, None, "x"], "c": {"z": 1, "y": 2}}) == (
        '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}'
    )
    # U+FF61 comes before U+1F600 by code point, after it by UTF-16 code unit.
    assert canonical_json({"\U0001f600": 1, "｡": 2}) == '{"｡":2,"\U0001f600":1}'
    assert canonical_json({"b": 1.5}) == '{"b":1.5}'
    with pytest.raises(TypeError):
        canonical_json(float("nan"))


def test_canonical_json_writes_numbers_and_strings_as_javascript_does():
    assert canonical_json([1.0, -0.0, 1e21, 1e20, 1e-7, 0.1, 2**53 + 1]) == (
        "[1,0,1e+21,100000000000000000000,1e-7,0.1,9007199254740992]"
    )
    assert canonical_json("\ud800\x1f 😀") == '"\\ud800\\u001f \U0001f600"'


def test_the_hash_is_the_sha256_of_the_normal_form_whatever_the_order_of_members():
    expected = f"sha256:{hashlib.sha256(b'{}').hexdigest()}"
    assert plan_hash({}) == expected
    assert plan_hash({"derive": [], "sort": []}) == expected
    a = {"sort": [{"column": "x", "direction": "asc"}], "where": {"fn": "eq", "args": [{"col": "x"}, {"lit": 1}]}}
    b = json.loads('{"where":{"args":[{"col":"x"},{"lit":1}],"fn":"eq"},"sort":[{"direction":"asc","column":"x"}]}')
    assert plan_hash(a) == plan_hash(b)
    assert plan_hash(a) != plan_hash({**a, "sort": [{"column": "x", "direction": "desc"}]})
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", plan_hash(a))
