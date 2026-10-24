import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue } from "vastgrid-core";
import { GridController } from "../src/controller.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  lineHeight: 18,
};

async function readyGrid(extra: Partial<typeof options> & { maxLines?: number } = {}) {
  const rows = 100_000;
  const columnData: CellValue[][] = [
    Array.from({ length: rows }, (_, index) => index),
    Array.from({ length: rows }, (_, index) => `note ${index}\nsecond line`),
  ];
  const grid = new GridController(new ArraySource({ columns: ["id", "note"], columnData }), {
    ...options,
    ...extra,
  });
  grid.start();
  while (grid.info?.status !== "ready" || grid.visible.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  grid.setViewport(800, 600);
  return grid;
}

test("rows are one line high until a visible column wraps", async () => {
  const grid = await readyGrid();
  assert.equal(grid.rowHeight, 24);
  grid.setColumnFormats({ note: { wrap: true } });
  assert.equal(grid.maxLines, 3);
  assert.equal(grid.rowHeight, 24 + 2 * 18);
  grid.setMaxLines(5);
  assert.equal(grid.rowHeight, 24 + 4 * 18);
  grid.setMaxLines(1);
  assert.equal(grid.rowHeight, 24);
  grid.setMaxLines(100);
  assert.equal(grid.maxLines, 20);
  grid.setMaxLines(undefined);
  // A hidden column that wraps does not make rows higher.
  grid.setColumnHidden(1, true);
  assert.equal(grid.rowHeight, 24);
  grid.setColumnHidden(1, false);
  assert.equal(grid.rowHeight, 60);
  grid.setLineHeight(20);
  assert.equal(grid.rowHeight, 64);
  grid.dispose();
});

test("rows, pages and the scroll range follow the row height", async () => {
  const grid = await readyGrid({ maxLines: 2 });
  grid.setColumnFormats({ note: { wrap: true } });
  assert.equal(grid.rowHeight, 42);
  assert.equal(grid.scrollY.virtualRange, 32 + 100_000 * 42 - 600);
  grid.scrollY.scrollTo(42 * 500);
  assert.deepEqual(grid.visibleRows(), [500, 500 + Math.ceil((600 - 32) / 42)]);
  assert.equal(grid.rowAt(32 + 42 * 3 + 1), 503);
  assert.equal(grid.rowY(501), 32 + 42);
  assert.equal(grid.pageRows, Math.floor((600 - 32) / 42) - 1);
  grid.dispose();
});

test("the first visible row stays in place when the row height changes", async () => {
  const grid = await readyGrid();
  // Row 2,000 at the top, scrolled a third into it.
  grid.scrollY.scrollTo(2000 * 24 + 8);
  assert.equal(grid.visibleRows()[0], 2000);
  grid.setColumnFormats({ note: { wrap: true } });
  assert.equal(grid.visibleRows()[0], 2000);
  assert.equal(grid.scrollY.position, (2000 + 1 / 3) * 60);
  grid.setMaxLines(6);
  assert.equal(grid.visibleRows()[0], 2000);
  grid.setColumnFormats({});
  assert.equal(grid.visibleRows()[0], 2000);
  assert.equal(grid.scrollY.position, 2000 * 24 + 8);
  grid.dispose();
});
