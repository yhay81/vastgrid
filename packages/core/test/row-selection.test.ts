import assert from "node:assert/strict";
import { test } from "node:test";
import {
  impliesRowQuery,
  parseRowSelection,
  RowSelectionModel,
  rowKeyOf,
  rowSelectionQuery,
  sameRowQuery,
} from "../src/row-selection.ts";
import type { Filter } from "../src/types.ts";

const london: Filter = { type: "values", column: 2, values: ["London"] };
const old: Filter = { type: "compare", column: 1, op: "lt", value: 1900 };

test("an include selection keeps checked keys in every view", () => {
  const selection = new RowSelectionModel();
  assert.equal(selection.empty, true);
  assert.equal(selection.state({}), false);
  assert.equal(selection.setRows([1, "a"], true, { filters: [london] }), true);
  assert.equal(selection.has(1, {}), true);
  assert.equal(selection.has("a", { sort: [{ column: 0, direction: "desc" }] }), true);
  assert.equal(selection.has("1", {}), false, "a number and its text are different keys");
  assert.equal(selection.state({}), "mixed");
  assert.equal(selection.count(null), 2);
  selection.setRows([1], false, {});
  assert.deepEqual(selection.value(), { type: "include", keys: ["a"] });
});

test("checking every row lists no keys, and unchecked rows are the listed ones", () => {
  const selection = new RowSelectionModel();
  selection.selectAll({ sort: [{ column: 0, direction: "asc" }] });
  assert.deepEqual(selection.value(), { type: "exclude", keys: [] });
  assert.equal(selection.state({ filters: [london] }), true);
  selection.setRows([5], false, {});
  assert.equal(selection.has(5, {}), false);
  assert.equal(selection.has(6, { search: "x" }), true);
  assert.equal(selection.state({}), "mixed");
  assert.equal(selection.count(1_000_000_000), 999_999_999);
  assert.equal(selection.count(null), null);
});

test("every row matching a query is told apart only in views that keep to that query", () => {
  const selection = new RowSelectionModel();
  selection.selectAll({ filters: [london], search: " Ad " });
  assert.deepEqual(selection.value(), { type: "exclude", keys: [], query: { filters: [london], search: "Ad" } });
  // More filters and a longer search keep to the query.
  assert.equal(selection.has(1, { filters: [old, london], search: "ada" }), true);
  assert.equal(selection.state({ filters: [london], search: "Ada" }), true);
  // Without the filter, rows that do not match it may show.
  assert.equal(selection.has(1, { search: "ada" }), null);
  assert.equal(selection.state({}), "mixed");
  assert.equal(selection.setRows([1], false, {}), false);
  assert.equal(selection.size, 0);
});

test("queries compare by their filters and search, not their sort", () => {
  assert.equal(rowSelectionQuery({ sort: [{ column: 0, direction: "asc" }], search: "  " }), undefined);
  assert.deepEqual(rowSelectionQuery({ filters: [london], sort: [] }), { filters: [london] });
  assert.equal(sameRowQuery({ filters: [london] }, { filters: [london], search: "" }), true);
  assert.equal(sameRowQuery({ filters: [london] }, { filters: [old] }), false);
  // Options left at their default are the same condition.
  assert.equal(sameRowQuery({ filters: [london] }, { filters: [{ ...london, exclude: false }] }), true);
  assert.equal(
    impliesRowQuery({ filters: [{ values: ["London"], column: 2, type: "values" }] }, { filters: [london] }),
    true,
  );
  assert.equal(impliesRowQuery({}, undefined), true);
  assert.equal(impliesRowQuery({ filters: [old] }, { filters: [london] }), false);
});

test("row selections from outside are checked", () => {
  assert.deepEqual(parseRowSelection({ type: "include", keys: [1, "b"] }), { type: "include", keys: [1, "b"] });
  const parsed = parseRowSelection({ type: "exclude", keys: [], query: { filters: [london] } });
  assert.equal(parsed?.type, "exclude");
  assert.equal(parsed?.type === "exclude" && sameRowQuery(parsed.query, { filters: [london] }), true);
  assert.deepEqual(parseRowSelection({ type: "exclude", keys: [], query: { sort: [] } }), {
    type: "exclude",
    keys: [],
  });
  assert.equal(parseRowSelection({ type: "include", keys: [Number.NaN] }), null);
  assert.equal(parseRowSelection({ type: "include" }), null);
  assert.equal(parseRowSelection({ type: "all", keys: [] }), null);
  assert.equal(parseRowSelection({ type: "exclude", keys: [], query: { filters: [{ type: "nope" }] } }), null);
  assert.equal(rowKeyOf(true), "true");
  assert.equal(rowKeyOf(null), null);
  assert.equal(rowKeyOf("9007199254740993"), "9007199254740993");
});

test("equal selections are told apart from changed ones", () => {
  const selection = new RowSelectionModel();
  selection.set({ type: "include", keys: [3, 1] });
  assert.equal(selection.equals({ type: "include", keys: [1, 3] }), true);
  assert.equal(selection.equals({ type: "include", keys: [1] }), false);
  assert.equal(selection.equals({ type: "exclude", keys: [1, 3] }), false);
  selection.set({ type: "exclude", keys: [], query: { filters: [london] } });
  assert.equal(selection.equals({ type: "exclude", keys: [], query: { filters: [london] } }), true);
  assert.equal(selection.equals({ type: "exclude", keys: [] }), false);
});
