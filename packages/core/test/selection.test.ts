import assert from "node:assert/strict";
import { test } from "node:test";
import { SelectionModel } from "../src/selection.ts";

test("arrow keys move the active cell and collapse the selection", () => {
  const selection = new SelectionModel(10, 5);
  selection.select({ row: 2, col: 2 });
  selection.move(1, 0);
  assert.deepEqual(selection.active, { row: 3, col: 2 });
  assert.equal(selection.size, 1);
  selection.move(-10, -10);
  assert.deepEqual(selection.active, { row: 0, col: 0 });
});

test("shift extends from the anchor while the active cell stays", () => {
  const selection = new SelectionModel(10, 5);
  selection.select({ row: 2, col: 1 });
  selection.move(2, 1, true);
  assert.deepEqual(selection.active, { row: 2, col: 1 });
  assert.deepEqual(selection.current, { top: 2, left: 1, bottom: 4, right: 2 });
  selection.move(-4, 0, true);
  assert.deepEqual(selection.current, { top: 0, left: 1, bottom: 2, right: 2 });
  assert.equal(selection.size, 6);
});

test("ctrl adds ranges and whole rows and columns follow size changes", () => {
  const selection = new SelectionModel(10, 5);
  selection.select({ row: 0, col: 0 });
  selection.select({ row: 5, col: 3 }, "add");
  assert.equal(selection.ranges.length, 2);
  assert.ok(selection.contains(0, 0) && selection.contains(5, 3));
  selection.selectCols(1, 2);
  assert.deepEqual(selection.current, { top: 0, left: 1, bottom: 9, right: 2, allRows: true });
  selection.setBounds(100, 5);
  assert.equal(selection.current?.bottom, 99);
  assert.ok(selection.colSelected(2));
  selection.selectRows(3, 3);
  selection.selectRows(3, 6, "extend");
  assert.deepEqual(selection.current, { top: 3, left: 0, bottom: 6, right: 4, allCols: true });
  assert.ok(selection.rowSelected(5));
  selection.selectAll();
  assert.equal(selection.size, 500);
});

test("tab and enter walk inside a multi-cell selection and wrap", () => {
  const selection = new SelectionModel(10, 5);
  selection.select({ row: 1, col: 1 });
  selection.move(1, 1, true);
  assert.deepEqual(selection.advance(0, 1), { row: 1, col: 2 });
  assert.deepEqual(selection.advance(0, 1), { row: 2, col: 1 });
  assert.deepEqual(selection.advance(0, 1), { row: 2, col: 2 });
  assert.deepEqual(selection.advance(0, 1), { row: 1, col: 1 });
  assert.deepEqual(selection.advance(1, 0), { row: 2, col: 1 });
  assert.deepEqual(selection.advance(1, 0), { row: 1, col: 2 });
  // The selection itself is unchanged.
  assert.equal(selection.size, 4);
});

test("an empty grid ignores selection changes", () => {
  const selection = new SelectionModel(0, 0);
  selection.select({ row: 3, col: 3 });
  selection.selectAll();
  assert.equal(selection.ranges.length, 0);
});
