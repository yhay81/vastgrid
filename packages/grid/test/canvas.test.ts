import assert from "node:assert/strict";
import { test } from "node:test";
import { Geometry } from "../src/canvas/geometry.ts";
import { ColumnLayout, fitFrozen } from "../src/canvas/layout.ts";
import { ScrollAxis } from "../src/canvas/scroll.ts";

const none = { area: "none", row: 0, column: 0, edge: false, menu: false };

/** Six columns of 100 px beside the gutter of 48 px, on a canvas 548 px wide: they scroll by 100 px. */
function grid(rowCount = 5) {
  const geometry = new Geometry();
  geometry.width = 548;
  geometry.height = 272;
  geometry.layout = new ColumnLayout([100, 100, 100, 100, 100, 100]);
  geometry.rowCount = rowCount;
  geometry.scrollX.resize(600, 500);
  geometry.scrollY.resize(rowCount * 24, 240);
  return geometry;
}

test("a column layout finds the column at an x, clamped to its columns", () => {
  // A negative width counts as none.
  const layout = new ColumnLayout([100, 0, 50, -20, 30]);
  assert.deepEqual(Array.from(layout.offsets), [0, 100, 100, 150, 150, 180]);
  assert.equal(layout.total, 180);
  assert.equal(layout.indexAt(-5), 0);
  assert.equal(layout.indexAt(99.9), 0);
  // An x on an edge is in the column at its right, past the columns of no width.
  assert.equal(layout.indexAt(100), 2);
  assert.equal(layout.indexAt(150), 4);
  assert.equal(layout.indexAt(180), 4);
  assert.equal(layout.indexAt(1e9), 4);
  assert.equal(new ColumnLayout([]).indexAt(0), -1);
});

test("frozen columns give way past three quarters of the width, those at the right first", () => {
  const layout = new ColumnLayout([100, 100, 100, 100, 100]);
  assert.deepEqual(fitFrozen(layout, 3, 1, 600), { left: 3, right: 1 });
  assert.deepEqual(fitFrozen(layout, 3, 1, 500), { left: 3, right: 0 });
  assert.deepEqual(fitFrozen(layout, 3, 1, 300), { left: 2, right: 0 });
  // An unknown width keeps them all; the counts are whole and within the columns.
  assert.deepEqual(fitFrozen(layout, 3, 1, 0), { left: 3, right: 1 });
  assert.deepEqual(fitFrozen(layout, 9, 9, 0), { left: 5, right: 0 });
  assert.deepEqual(fitFrozen(layout, 2.7, -1, 0), { left: 2, right: 0 });
  // A single column wider than three quarters is not frozen.
  assert.deepEqual(fitFrozen(new ColumnLayout([500, 100]), 1, 0, 600), { left: 0, right: 0 });
});

test("a scroll axis within its native limit scrolls natively", () => {
  const axis = new ScrollAxis(10_000);
  assert.equal(axis.resize(5_000, 1_000), 5_000);
  assert.equal(axis.scaled, false);
  assert.equal(axis.onNativeScroll(1_234), 1_234);
  assert.equal(axis.onNativeScroll(9_999), 4_000);
  assert.equal(axis.onNativeScroll(-5), 0);
  assert.equal(axis.scrollTo(2_500), 2_500);
  assert.equal(axis.scrollTo(1e9), 4_000);
  // Content smaller than the viewport does not scroll.
  assert.equal(axis.resize(500, 1_000), 500);
  assert.equal(axis.position, 0);
  assert.equal(axis.scrollTo(100), 0);
});

test("a scroll axis past its native limit moves by small steps as they are, and maps jumps and the ends", () => {
  const axis = new ScrollAxis(10_000);
  // 1,000,000 px of content on 10,000 native px, with a viewport of 100 px.
  assert.equal(axis.resize(1_000_000, 100), 10_000);
  assert.equal(axis.scaled, true);
  assert.equal(axis.onNativeScroll(50), 50);
  assert.equal(axis.onNativeScroll(80), 80);
  // Dragging the thumb to the middle of the native range shows the middle of the content.
  assert.equal(axis.onNativeScroll(4_950), 499_950);
  assert.equal(axis.onNativeScroll(4_960), 499_960);
  assert.equal(axis.onNativeScroll(9_900), 999_900);
  assert.equal(axis.onNativeScroll(0), 0);
});

test("scrolling a large axis to a near position moves the native one as much, and to a far one in proportion", () => {
  const axis = new ScrollAxis(10_000);
  axis.resize(1_000_000, 100);
  axis.onNativeScroll(4_950);
  assert.equal(axis.scrollTo(500_250), 5_250);
  // The scroll event that follows keeps the position asked for, though the browser rounds the native one.
  assert.equal(axis.onNativeScroll(5_251), 500_250);
  assert.equal(axis.scrollTo(249_975), 2_475);
  assert.equal(axis.position, 249_975);
  assert.equal(axis.scrollTo(-1), 0);
  assert.equal(axis.scrollTo(2_000_000), 9_900);
  assert.equal(axis.position, 999_900);
  // Less content keeps the position within it.
  axis.resize(500_000, 100);
  assert.equal(axis.position, 499_900);
});

test("hits: the corner, the gutter and its check boxes, headers with their menu buttons and edges, and cells", () => {
  const geometry = grid();
  assert.deepEqual(geometry.hit(10, 10), { area: "corner", row: 0, column: 0, edge: false, menu: false, check: false });
  assert.deepEqual(geometry.hit(30, 85), { area: "gutter", row: 2, column: 0, edge: false, menu: false, check: false });
  geometry.checkboxes = true;
  assert.equal(geometry.hit(10, 85).check, true);
  assert.equal(geometry.hit(30, 85).check, false);
  assert.deepEqual(geometry.hit(98, 10), { area: "header", row: 0, column: 0, edge: false, menu: false });
  assert.deepEqual(geometry.hit(140, 10), { area: "header", row: 0, column: 0, edge: false, menu: true });
  // Near the right edge, dragging resizes the column instead of opening its menu.
  assert.deepEqual(geometry.hit(146, 10), { area: "header", row: 0, column: 0, edge: true, menu: false });
  assert.deepEqual(geometry.hit(198, 129), { area: "cell", row: 4, column: 1, edge: false, menu: false });
  assert.deepEqual(geometry.hit(-1, 50), none);
  assert.deepEqual(geometry.hit(549, 50), none);
  assert.deepEqual(geometry.hit(100, 273), none);
});

test("below the last row and in an empty view, the gutter is empty like the cells", () => {
  const geometry = grid();
  geometry.checkboxes = true;
  // The last row ends at 32 + 5 × 24 = 152.
  assert.deepEqual(geometry.hit(10, 151), { area: "gutter", row: 4, column: 0, edge: false, menu: false, check: true });
  assert.deepEqual(geometry.hit(10, 152), none);
  assert.deepEqual(geometry.hit(30, 200), none);
  assert.deepEqual(geometry.hit(100, 200), none);
  const empty = grid(0);
  assert.deepEqual(empty.hit(10, 40), none);
  assert.deepEqual(empty.hit(100, 40), none);
  assert.equal(empty.hit(10, 10).area, "corner");
});

test("the totals row at the bottom is not a row", () => {
  const geometry = grid(20);
  geometry.footer = 24;
  assert.equal(geometry.hit(100, 247).area, "cell");
  assert.deepEqual(geometry.hit(100, 248), none);
  assert.deepEqual(geometry.hit(10, 260), none);
  assert.deepEqual(geometry.visibleRows(), [0, 9]);
});

test("scrolled rows: the first row on screen and the row under a point follow the vertical position", () => {
  const geometry = grid(1000);
  geometry.scrollY.scrollTo(30);
  assert.equal(geometry.topRow(), 1);
  assert.deepEqual(geometry.visibleRows(), [1, 12]);
  assert.equal(geometry.hit(100, 32).row, 1);
  assert.equal(geometry.rowY(1), 26);
});

test("columns frozen at each side stay while those between them scroll under them", () => {
  const geometry = grid();
  geometry.frozenLeft = 1;
  geometry.frozenRight = 1;
  geometry.scrollX.scrollTo(60);
  // The scrolling columns show from x = 148 to 448.
  assert.deepEqual(geometry.visibleScrollColumns(), [1, 4]);
  assert.equal(geometry.columnAt(98), 0);
  assert.equal(geometry.columnAt(150), 1);
  assert.equal(geometry.columnAt(200), 2);
  assert.equal(geometry.columnAt(460), 5);
  assert.equal(geometry.columnX(2), 188);
  assert.equal(geometry.columnX(5), 448);
  assert.equal(geometry.cellBox(0, 1).shown, true);
  // Column 1 is all under the frozen column 0 now.
  geometry.scrollX.scrollTo(100);
  assert.equal(geometry.cellBox(0, 1).shown, false);
  assert.equal(geometry.cellBox(0, 0).shown, true);
});

test("rows of groups above the column names", () => {
  const geometry = grid();
  geometry.groupRows = 1;
  geometry.headerHeight = 56;
  const group = { id: 1, name: "Sales" };
  geometry.groupPaths = [[group], [group], [null]];
  assert.deepEqual(geometry.hit(98, 10), { area: "group", row: 0, column: 0, edge: false, menu: false, level: 0 });
  assert.equal(geometry.hit(248, 10).area, "none");
  assert.equal(geometry.hit(348, 10).area, "none");
  assert.equal(geometry.hit(98, 30).area, "header");
  assert.equal(geometry.hit(10, 30).area, "corner");
});
