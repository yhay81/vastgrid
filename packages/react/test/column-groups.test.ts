import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type ColumnGroup } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

const q1: ColumnGroup = { name: "Q1", children: ["jan", "feb"] };
const q2: ColumnGroup = { name: "Q2", children: ["apr"] };
const groups: ColumnGroup[] = [{ name: "Sales", children: [q1, q2] }];

function source() {
  return new ArraySource({
    columns: ["id", "jan", "feb", "apr", "note"],
    rows: Array.from({ length: 50 }, (_, row) => [row, row * 10, row * 20, row * 30, `n${row}`]),
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function mountedGrid(extra: Partial<GridOptions> = {}) {
  const grid = new GridController(source(), { ...options, columnGroups: groups, ...extra });
  grid.attach({ scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement, { style: {} } as unknown as HTMLElement);
  grid.setViewport(2000, 300);
  grid.start();
  await until(() => grid.info?.status === "ready");
  return grid;
}

function labels(grid: GridController) {
  return grid.groupSpans().map((row) => row.map((span) => `${span.group.name}:${span.start}-${span.end}`));
}

/** The middle of a visible column, in screen x. */
function middle(grid: GridController, col: number) {
  return grid.columnX(col) + grid.layout.width(col) / 2;
}

test("group rows add to the header, and rows start below it", async () => {
  const grid = await mountedGrid({ groupHeaderHeight: 20 });
  try {
    assert.equal(grid.groupRows, 2);
    assert.equal(grid.headerHeight, 32 + 2 * 20);
    assert.equal(grid.rowY(0), 72);
    assert.equal(grid.rowAt(71), -1);
    assert.equal(grid.rowAt(72), 0);
    assert.equal(grid.bodyHeight, 300 - 72);
    const hit = grid.hitTest(middle(grid, 1), 72 + 24 + 2);
    assert.deepEqual([hit.zone, hit.row, hit.col], ["cell", 1, 1]);
    // The checkboxes of the rows follow them.
    grid.setCheckboxSelection(true);
    const box = grid.hitTest(8, 72 + 2);
    assert.deepEqual([box.zone, box.row, box.checkbox], ["gutter", 0, true]);
    assert.equal(grid.hitTest(8, 10).zone, "corner");
  } finally {
    grid.dispose();
  }
});

test("hit testing tells group headers from the columns' own headers", async () => {
  const grid = await mountedGrid();
  try {
    const outer = grid.hitTest(middle(grid, 2), 5);
    assert.equal(outer.zone, "group");
    assert.equal(outer.col, 2);
    assert.deepEqual([outer.group?.group.name, outer.group?.start, outer.group?.end], ["Sales", 1, 3]);
    const inner = grid.hitTest(middle(grid, 3), 24 + 5);
    assert.deepEqual([inner.zone, inner.group?.group.name, inner.group?.level], ["group", "Q2", 1]);
    // An ungrouped column's header reaches up through the empty group rows.
    const id = grid.hitTest(middle(grid, 0), 5);
    assert.deepEqual([id.zone, id.col, id.group], ["header", 0, undefined]);
    assert.equal(grid.headerTop(0), 0);
    assert.equal(grid.headerTop(1), 48);
    // The menu button is only in the row of column names.
    const right = grid.columnX(4) + grid.layout.width(4) - 12;
    assert.equal(grid.hitTest(right, 5).menu, false);
    assert.equal(grid.hitTest(right, 48 + 16).menu, true);
    const name = grid.hitTest(middle(grid, 2), 48 + 16);
    assert.deepEqual([name.zone, name.col], ["header", 2]);
    // Sorting and filters name the schema column under the pointer.
    grid.sortBy(name.col, "desc");
    assert.deepEqual(grid.query.sort, [{ column: grid.visible[2].index, direction: "desc" }]);
  } finally {
    grid.dispose();
  }
});

test("moving, hiding and freezing columns split group headers", async () => {
  const grid = await mountedGrid();
  try {
    assert.deepEqual(labels(grid), [["Sales:1-3"], ["Q1:1-2", "Q2:3-3"]]);
    // "note" moved between jan and feb.
    grid.moveColumn(4, 2);
    assert.deepEqual(
      grid.visible.map((column) => grid.schema[column.index].name),
      ["id", "jan", "note", "feb", "apr"],
    );
    assert.deepEqual(labels(grid), [
      ["Sales:1-1", "Sales:3-4"],
      ["Q1:1-1", "Q1:3-3", "Q2:4-4"],
    ]);
    // Hiding "note" joins them again.
    grid.hideColumn(2);
    assert.deepEqual(labels(grid), [["Sales:1-3"], ["Q1:1-2", "Q2:3-3"]]);
    // Freezing up to jan splits Sales and Q1 between the frozen and the scrolling columns.
    grid.freezeUpTo(1);
    assert.deepEqual(labels(grid), [
      ["Sales:1-1", "Sales:2-3"],
      ["Q1:1-1", "Q1:2-2", "Q2:3-3"],
    ]);
    // The header's height stays: it depends only on the groups.
    for (const column of grid.columns) if (grid.schema[column.index].name !== "id") column.hidden = true;
    grid.updateLayout();
    assert.deepEqual(labels(grid), [[], []]);
    assert.equal(grid.groupRows, 2);
  } finally {
    grid.dispose();
  }
});

test("a group's columns move together", async () => {
  const grid = await mountedGrid();
  try {
    const names = () => grid.visible.map((column) => grid.schema[column.index].name);
    // Q1 (jan, feb) after note.
    grid.moveColumns(1, 2, 4);
    assert.deepEqual(names(), ["id", "apr", "note", "jan", "feb"]);
    // And back before id.
    grid.moveColumns(3, 4, 0);
    assert.deepEqual(names(), ["jan", "feb", "id", "apr", "note"]);
    // Onto one of its own columns: nothing moves.
    grid.moveColumns(0, 1, 1);
    assert.deepEqual(names(), ["jan", "feb", "id", "apr", "note"]);
    assert.deepEqual(labels(grid), [
      ["Sales:0-1", "Sales:3-3"],
      ["Q1:0-1", "Q2:3-3"],
    ]);
    // The state keeps the order by column name, not the groups.
    const state = grid.getState();
    assert.deepEqual(
      state.columns?.map((column) => column.name),
      ["jan", "feb", "id", "apr", "note"],
    );
    assert.equal("columnGroups" in state, false);
  } finally {
    grid.dispose();
  }
});

test("changing the groups resizes the header and keeps the first visible row", async () => {
  const grid = await mountedGrid();
  try {
    grid.scrollToVirtual(null, 24 * 10);
    assert.equal(grid.visibleRows()[0], 10);
    grid.setColumnGroups([{ name: "Months", children: ["jan", "feb", "apr"] }]);
    assert.equal(grid.headerHeight, 32 + 24);
    assert.equal(grid.visibleRows()[0], 10);
    assert.deepEqual(labels(grid), [["Months:1-3"]]);
    assert.throws(() => grid.setColumnGroups([q1, { name: "Again", children: ["jan"] }]), RangeError);
    assert.equal(grid.groupRows, 1, "invalid groups keep the current ones");
    grid.setColumnGroups([]);
    assert.equal(grid.headerHeight, 32);
    assert.deepEqual(grid.groupSpans(), []);
    assert.equal(grid.hitTest(middle(grid, 1), 5).zone, "header");
  } finally {
    grid.dispose();
  }
});

test("copies have one header row: the column names", async () => {
  const grid = await mountedGrid();
  try {
    grid.selection.select({ row: 0, col: 1 });
    grid.selection.select({ row: 1, col: 2 }, "extend");
    const copied = await grid.copySelection({ headers: true });
    assert.equal(copied.text.split(/\r?\n/)[0], "jan\tfeb");
  } finally {
    grid.dispose();
  }
});

test("freezing columns at the right splits group headers there too", async () => {
  const grid = await mountedGrid();
  try {
    // Freezing from feb to the right edge: feb, apr and note stay at the right.
    grid.freezeFrom(2);
    assert.equal(grid.frozenRight, 3);
    assert.deepEqual(labels(grid), [
      ["Sales:1-1", "Sales:2-3"],
      ["Q1:1-1", "Q1:2-2", "Q2:3-3"],
    ]);
  } finally {
    grid.dispose();
  }
});
