import assert from "node:assert/strict";
import { test } from "node:test";
import { copyLayout, SelectionModel } from "../src/selection.ts";

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

test("ranges with the same rows are copied side by side in display order", () => {
  const layout = copyLayout([
    { top: 2, left: 4, bottom: 3, right: 5 },
    { top: 2, left: 0, bottom: 3, right: 1 },
    { top: 2, left: 1, bottom: 3, right: 2 },
  ]);
  assert.deepEqual(layout, { rows: [{ start: 2, end: 4 }], cols: [0, 1, 2, 4, 5] });
});

test("ranges with the same columns are stacked in view order and overlaps are copied once", () => {
  const layout = copyLayout([
    { top: 8, left: 1, bottom: 9, right: 2 },
    { top: 0, left: 1, bottom: 2, right: 2 },
    { top: 2, left: 1, bottom: 4, right: 2 },
    { top: 5, left: 1, bottom: 5, right: 2 },
  ]);
  assert.deepEqual(layout, {
    rows: [
      { start: 0, end: 6 },
      { start: 8, end: 10 },
    ],
    cols: [1, 2],
  });
});

test("whole columns combine, and ranges with other rows and columns cannot be copied together", () => {
  const selection = new SelectionModel(100, 6);
  selection.selectCols(4, 4);
  selection.selectCols(1, 2, "add");
  assert.deepEqual(copyLayout(selection.ranges), { rows: [{ start: 0, end: 100 }], cols: [1, 2, 4] });
  selection.select({ row: 0, col: 0 });
  assert.deepEqual(copyLayout(selection.ranges), { rows: [{ start: 0, end: 1 }], cols: [0] });
  selection.select({ row: 3, col: 3 }, "add");
  assert.equal(copyLayout(selection.ranges), null);
  assert.deepEqual(copyLayout([]), { rows: [], cols: [] });
});
