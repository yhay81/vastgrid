import assert from "node:assert/strict";
import { test } from "node:test";
import type { Expr } from "vastgrid-spec";
import { allState, checkedCount, checkState } from "../src/core/checked.ts";

const tokyo: Expr = { fn: "eq", args: [{ col: "city" }, { lit: "Tokyo" }] };

test("rows are checked by key; exclude checks the others (§5.2.1)", () => {
  const include = { mode: "include" as const, keys: [{ rowId: 3 }, { value: "9007199254740991" }] };
  assert.equal(checkState(include, {}, { rowId: 3 }), "checked");
  assert.equal(checkState(include, {}, { rowId: 4 }), "unchecked");
  // Keys are the same once safe bigints are numbers (§5.3).
  assert.equal(checkState(include, {}, { value: 9007199254740991 }), "checked");
  assert.equal(checkState(undefined, {}, { rowId: 3 }), "unchecked");
  const exclude = { mode: "exclude" as const, keys: [{ rowId: 3 }] };
  assert.equal(checkState(exclude, {}, { rowId: 3 }), "unchecked");
  assert.equal(checkState(exclude, {}, { rowId: 4 }), "checked");
  assert.equal(checkedCount(include, {}, 10), 2);
  assert.equal(checkedCount(exclude, {}, 10), 9);
  assert.equal(allState(exclude, {}, 10), "some");
  assert.equal(allState({ mode: "exclude", keys: [] }, {}, 10), "all");
  assert.equal(allState(undefined, {}, 10), "none");
  assert.equal(allState(include, {}, 2), "some");
});

test("checks of a filtered view are unknown in a view that its filter does not imply", () => {
  const checked = { mode: "exclude" as const, keys: [], where: { fn: "and", args: [tokyo, { search: "ab" }] } as Expr };
  // The same condition, and a search that contains the checked one's text.
  const narrower = { where: { fn: "and", args: [{ search: "abc" }, tokyo, { lit: true }] } as Expr };
  assert.equal(checkState(checked, narrower, { rowId: 1 }), "checked");
  assert.equal(checkedCount(checked, narrower, 4), 4);
  assert.equal(checkState(checked, { where: tokyo }, { rowId: 1 }), "unknown");
  assert.equal(checkedCount(checked, {}, 4), null);
  assert.equal(allState(checked, {}, 4), "unknown");
});
