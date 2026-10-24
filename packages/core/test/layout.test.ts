import assert from "node:assert/strict";
import { test } from "node:test";
import { ColumnLayout, fitFrozen, MAX_FROZEN_SHARE } from "../src/layout.ts";

test("a layout finds columns by x and clamps to the existing ones", () => {
  const layout = new ColumnLayout([100, 50, 200]);
  assert.equal(layout.total, 350);
  assert.equal(layout.indexAt(-5), 0);
  assert.equal(layout.indexAt(120), 1);
  assert.equal(layout.indexAt(150), 2);
  assert.equal(layout.indexAt(1000), 2);
  assert.equal(new ColumnLayout([]).indexAt(0), -1);
});

test("frozen columns stay frozen while they fit, and give way at the right first", () => {
  const layout = new ColumnLayout([100, 100, 100, 100, 100, 100]);
  // Columns 0-1 at the left and 4-5 at the right: 400 px.
  assert.deepEqual(fitFrozen(layout, 2, 2, 1000), { left: 2, right: 2 });
  assert.deepEqual(fitFrozen(layout, 2, 2, 400 / MAX_FROZEN_SHARE), { left: 2, right: 2 });
  // Narrower: the inner column at the right scrolls, then the other one.
  assert.deepEqual(fitFrozen(layout, 2, 2, 399 / MAX_FROZEN_SHARE), { left: 2, right: 1 });
  assert.deepEqual(fitFrozen(layout, 2, 2, 250 / MAX_FROZEN_SHARE), { left: 2, right: 0 });
  // Then the columns at the left, from the inner one.
  assert.deepEqual(fitFrozen(layout, 2, 2, 150 / MAX_FROZEN_SHARE), { left: 1, right: 0 });
  assert.deepEqual(fitFrozen(layout, 2, 2, 50), { left: 0, right: 0 });
  // An unknown width keeps them, and the counts never overlap or exceed the columns.
  assert.deepEqual(fitFrozen(layout, 2, 2, 0), { left: 2, right: 2 });
  assert.deepEqual(fitFrozen(layout, 4, 5, 0), { left: 4, right: 2 });
  assert.deepEqual(fitFrozen(layout, 9, 1, 0), { left: 6, right: 0 });
  assert.deepEqual(fitFrozen(new ColumnLayout([]), 1, 1, 500), { left: 0, right: 0 });
});
