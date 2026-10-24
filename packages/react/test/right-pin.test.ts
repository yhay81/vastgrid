import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type GridState, MAX_FROZEN_SHARE } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";
import type { GridColumnsEvent } from "../src/events.ts";

const options: GridOptions = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 1,
  frozenRightColumns: 2,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

const NAMES = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];

function source() {
  return new ArraySource({
    columns: NAMES,
    rows: Array.from({ length: 50 }, (_, row) => NAMES.map((name) => `${name}:${row}`)),
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

/** A grid of eight columns of 100 px, 600 px wide, with column 0 frozen at the left and 6-7 at the right. */
async function readyGrid(extra: Partial<GridOptions> = {}) {
  const grid = new GridController(source(), { ...options, ...extra });
  const scroller = { scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement;
  grid.attach(scroller, { style: {} } as unknown as HTMLElement);
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  for (let col = 0; col < grid.visible.length; col++) grid.resizeColumn(col, 100);
  grid.setViewport(600, 300);
  return grid;
}

const names = (grid: GridController) => grid.visible.map((column) => grid.schema[column.index].name);

function record<T>(subscribe: (listener: (event: T) => void) => () => void) {
  const events: T[] = [];
  subscribe((event) => events.push(event));
  return events;
}

test("columns frozen at the right stay at the grid's right edge while the others scroll between", async () => {
  const grid = await readyGrid();
  try {
    const g = grid.gutterWidth;
    assert.equal(grid.frozen, 1);
    assert.equal(grid.frozenRight, 2);
    assert.equal(grid.frozenRightWidth, 200);
    assert.equal(grid.frozenRightX, 400);
    assert.equal(grid.columnX(0), g);
    assert.equal(grid.columnX(1), g + 100);
    assert.equal(grid.columnX(6), 400);
    assert.equal(grid.columnX(7), 500);
    assert.deepEqual(grid.visibleScrollColumns(), [1, 3]);
    assert.equal(grid.columnAt(g + 50), 0);
    assert.equal(grid.columnAt(g + 150), 1);
    assert.equal(grid.columnAt(450), 6);
    assert.equal(grid.columnAt(599), 7);
    assert.equal(grid.columnAt(600), -1);

    // The scroll range is the content's width, as without frozen columns: at its end, the last
    // scrolling column ends where the right frozen columns start.
    assert.equal(grid.scrollX.virtualRange, g + 800 - 600);
    grid.scrollToVirtual(grid.scrollX.virtualRange, null);
    assert.equal(grid.columnX(5) + grid.layout.width(5), 400);
    assert.deepEqual(grid.visibleScrollColumns(), [3, 5]);
    assert.equal(grid.columnX(6), 400);
    assert.equal(grid.columnAt(399), 5);
    assert.equal(grid.columnAt(401), 6);
    assert.equal(grid.columnAt(g + 50), 0);
  } finally {
    grid.dispose();
  }
});

test("hit testing finds the edges, menus and cells of the columns frozen at the right", async () => {
  const grid = await readyGrid();
  try {
    const g = grid.gutterWidth;
    // Columns frozen at the right are resized at their left edge.
    assert.equal(grid.hitTest(400, 10).resize, 6);
    assert.equal(grid.hitTest(397, 10).resize, 6);
    assert.equal(grid.hitTest(503, 10).resize, 7);
    assert.equal(grid.hitTest(598, 10).resize, -1);
    // Scrolling columns at their right edge, as before.
    assert.equal(grid.hitTest(g + 200, 10).resize, 1);
    assert.equal(grid.hitTest(g + 100, 10).resize, 0);
    const menu = grid.hitTest(585, 10);
    assert.equal(menu.menu, true);
    assert.equal(menu.col, 7);
    const cell = grid.hitTest(450, 32 + 24 * 2 + 5);
    assert.deepEqual([cell.zone, cell.row, cell.col], ["cell", 2, 6]);
  } finally {
    grid.dispose();
  }
});

test("keyboard moves scroll only the scrolling columns into view, between the frozen ones", async () => {
  const grid = await readyGrid();
  try {
    const g = grid.gutterWidth;
    grid.ensureVisible(0, 5);
    // Column 5 ends where the frozen columns at the right start.
    assert.equal(grid.columnX(5) + 100, 400);
    assert.equal(grid.scrollX.position, g + 200);
    grid.ensureVisible(0, 7);
    grid.ensureVisible(0, 0);
    assert.equal(grid.scrollX.position, g + 200);
    grid.ensureVisible(0, 1);
    assert.equal(grid.columnX(1), g + 100);
    assert.equal(grid.scrollX.position, 0);
  } finally {
    grid.dispose();
  }
});

test("frozen columns that would take the whole width scroll, the right ones first, until the grid widens", async () => {
  const grid = await readyGrid();
  try {
    const events = record<GridColumnsEvent>((listener) => grid.onColumnsChange(listener));
    const body = (frozen: number) => Math.ceil(frozen / MAX_FROZEN_SHARE) + grid.gutterWidth;
    grid.setViewport(body(300) - 1, 300);
    assert.deepEqual([grid.frozen, grid.frozenRight], [1, 1]);
    grid.setViewport(body(150), 300);
    assert.deepEqual([grid.frozen, grid.frozenRight], [1, 0]);
    assert.equal(grid.frozenRightX, grid.width);
    assert.deepEqual(grid.visibleScrollColumns()[0], 1);
    grid.setViewport(body(50), 300);
    assert.deepEqual([grid.frozen, grid.frozenRight], [0, 0]);
    // The settings stay, and are saved.
    assert.deepEqual(grid.pinned, { left: 1, right: 2 });
    assert.equal(grid.getState().frozenRightColumns, 2);
    assert.equal(events.length, 0);
    grid.setViewport(600, 300);
    assert.deepEqual([grid.frozen, grid.frozenRight], [1, 2]);
  } finally {
    grid.dispose();
  }
});

test("columns are frozen at either side or none, and events and the state report where", async () => {
  const grid = await readyGrid({ frozenRightColumns: 0 });
  try {
    const events = record<GridColumnsEvent>((listener) => grid.onColumnsChange(listener));
    grid.freezeFrom(6);
    assert.deepEqual(grid.pinned, { left: 1, right: 2 });
    grid.setColumnPin(2, "right");
    assert.deepEqual(names(grid), ["c0", "c1", "c3", "c4", "c5", "c2", "c6", "c7"]);
    assert.deepEqual(grid.pinned, { left: 1, right: 3 });
    grid.setColumnPin(6, "left");
    assert.deepEqual(names(grid), ["c0", "c6", "c1", "c3", "c4", "c5", "c2", "c7"]);
    assert.deepEqual(grid.pinned, { left: 2, right: 2 });
    grid.setColumnPin(0, null);
    assert.deepEqual(names(grid), ["c6", "c0", "c1", "c3", "c4", "c5", "c2", "c7"]);
    assert.deepEqual(grid.pinned, { left: 1, right: 2 });
    grid.setColumnPin(7, null);
    assert.deepEqual(names(grid), ["c6", "c0", "c1", "c3", "c4", "c5", "c7", "c2"]);
    assert.deepEqual(grid.pinned, { left: 1, right: 1 });
    grid.setColumnPin(2, "right");
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.reason === "freeze"));
    const last = events[events.length - 1];
    assert.equal(last.frozenColumns, 1);
    assert.equal(last.frozenRightColumns, 1);
    assert.deepEqual(
      last.columns.map((column) => [column.name, column.pin, column.frozen]),
      [
        ["c6", "left", true],
        ["c0", null, false],
        ["c1", null, false],
        ["c3", null, false],
        ["c4", null, false],
        ["c5", null, false],
        ["c7", null, false],
        ["c2", "right", true],
      ],
    );

    // Hiding a frozen column frees its place; freezing up to a column keeps the sides apart.
    grid.hideColumn(7);
    assert.deepEqual(grid.pinned, { left: 1, right: 0 });
    grid.freezeFrom(5);
    assert.deepEqual(grid.pinned, { left: 1, right: 2 });
    grid.freezeUpTo(5);
    assert.deepEqual(grid.pinned, { left: 6, right: 1 });
    grid.freezeFrom(2);
    assert.deepEqual(grid.pinned, { left: 2, right: 5 });
    grid.freezeFrom(grid.visible.length);
    grid.freezeUpTo(-1);
    assert.deepEqual(grid.pinned, { left: 0, right: 0 });
    // Moving a column keeps the counts, as for the left side.
    grid.freezeFrom(5);
    grid.moveColumn(0, 6);
    assert.deepEqual(grid.pinned, { left: 0, right: 2 });
    assert.equal(names(grid)[6], "c6");
  } finally {
    grid.dispose();
  }
});

test("a copy and the selection follow the display order across the frozen sides", async () => {
  const grid = await readyGrid();
  try {
    grid.scrollToVirtual(grid.scrollX.virtualRange, null);
    grid.selection.select({ row: 0, col: 5 });
    grid.selection.select({ row: 1, col: 6 }, "extend");
    grid.selectionChanged();
    const copied = await grid.copySelection({});
    assert.equal(copied.text, "c5:0\tc6:0\nc5:1\tc6:1");
  } finally {
    grid.dispose();
  }
});

test("a state keeps the frozen columns of both sides, and older states keep the right ones", async () => {
  const first = await readyGrid();
  let saved: GridState;
  try {
    first.setColumnPin(1, "right");
    saved = JSON.parse(JSON.stringify(first.getState()));
    assert.equal(saved.frozenColumns, 1);
    assert.equal(saved.frozenRightColumns, 3);
    assert.deepEqual(
      saved.columns?.map((column) => column.name),
      ["c0", "c2", "c3", "c4", "c5", "c1", "c6", "c7"],
    );
  } finally {
    first.dispose();
  }
  const second = await readyGrid({ frozenColumns: 0, frozenRightColumns: 0 });
  try {
    assert.ok(second.applyState(saved));
    assert.deepEqual(names(second), ["c0", "c2", "c3", "c4", "c5", "c1", "c6", "c7"]);
    assert.deepEqual(second.pinned, { left: 1, right: 3 });
    // A state saved before right freezing existed changes only the left side.
    assert.ok(second.applyState({ version: 1, frozenColumns: 2 }));
    assert.deepEqual(second.pinned, { left: 2, right: 3 });
    // Columns that a state does not list go before the columns frozen at the right.
    assert.ok(
      second.applyState({
        version: 1,
        columns: [{ name: "c0" }, { name: "c7" }],
        frozenColumns: 1,
        frozenRightColumns: 1,
      }),
    );
    assert.deepEqual(names(second), ["c0", "c2", "c3", "c4", "c5", "c1", "c6", "c7"]);
    assert.deepEqual(second.pinned, { left: 1, right: 1 });
  } finally {
    second.dispose();
  }
});

test("hiding and showing columns from the columns panel keeps both frozen sides", async () => {
  const grid = await readyGrid({ frozenColumns: 1, frozenRightColumns: 2 });
  try {
    const right = grid.visible[7].index;
    grid.setColumnHidden(right, true);
    // The column left the right side; the next scrolling column stays scrolling.
    assert.equal(grid.pinned.right, 1);
    assert.equal(grid.pinOf(grid.visible.length - 2), null);
    // Shown again after the right-frozen column, it joins the right side.
    grid.setColumnHidden(right, false);
    assert.equal(grid.pinned.right, 2);
    assert.equal(grid.schema[grid.visible[7].index].name, NAMES[7]);
    // A scrolling column hidden and shown again stays scrolling.
    const middle = grid.visible[3].index;
    grid.setColumnHidden(middle, true);
    grid.setColumnHidden(middle, false);
    assert.deepEqual([grid.pinned.left, grid.pinned.right], [1, 2]);
  } finally {
    grid.dispose();
  }
});
