import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";

const options: GridOptions = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  changeDelay: 10,
};

function orders() {
  return new ArraySource({
    columns: [
      { name: "item", type: "string" },
      { name: "qty", type: "integer" },
      { name: "price", type: "integer" },
    ],
    rows: [
      ["apple", 3, 120],
      ["pear", 1, 300],
      ["fig", 5, 80],
    ],
    editable: true,
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 300 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function mounted(extra: Partial<GridOptions> = {}, source = orders()) {
  const grid = new GridController(source, { ...options, ...extra });
  grid.attach({ scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement, { style: {} } as unknown as HTMLElement);
  grid.setViewport(600, 32 + 24 * 5);
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

/** Loads the rows of the view and returns a column by name. */
async function column(grid: GridController, name: string): Promise<CellValue[]> {
  const index = grid.schema.findIndex((item) => item.name === name);
  grid.cache.want(
    0,
    grid.rowCount,
    grid.schema.map((_, at) => at),
  );
  await until(() => grid.cache.value(grid.rowCount - 1, index) !== undefined);
  return Array.from({ length: grid.rowCount }, (_, row) => grid.cache.value(row, index) ?? null);
}

const colOf = (grid: GridController, name: string) =>
  grid.visible.findIndex((state) => grid.schema[state.index]?.name === name);

test("formula columns cannot be edited, pasted, filled or cleared", async () => {
  const grid = await mounted();
  grid.setFormulas([{ name: "total", expression: "qty * price" }]);
  await until(() => !grid.viewPending && grid.view.id !== null);
  await column(grid, "total");
  const total = colOf(grid, "total");
  assert.ok(total >= 0);
  assert.equal(grid.edits.cellEditable(0, total), false);
  assert.equal(grid.edits.columnEditable(grid.visible[total].index), false);
  const typed = await grid.edits.prepare([{ row: 0, col: total, text: "1" }], "edit");
  assert.deepEqual(typed.ok ? null : typed.problems[0].problem, { kind: "readOnly" });
  // A paste and a fill right that reach the formula column are refused as a whole.
  grid.selection.select({ row: 0, col: colOf(grid, "price") });
  const paste = await grid.edits.pasteTargets([["100", "7"]]);
  assert.equal((await grid.edits.prepare(paste.inputs, "paste")).ok, false);
  grid.selection.select({ row: 0, col: colOf(grid, "price") });
  grid.selection.select({ row: 0, col: total }, "extend");
  assert.equal((await grid.edits.prepare(await grid.edits.fillTargets("right"), "fill")).ok, false);
  // Clearing skips it: only the columns that can be written are cleared.
  const cleared = await grid.edits.targetCells(0, 1, [colOf(grid, "price"), total]);
  assert.deepEqual(
    cleared.map((cell) => grid.schema[cell.column].name),
    ["price"],
  );
  grid.dispose();
});

test("writing a column updates the formulas that use it, their sort and their statistics; undo too", async () => {
  const source = orders();
  const grid = await mounted({}, source);
  grid.setFormulas([{ name: "total", expression: "qty * price" }]);
  await until(() => !grid.viewPending && grid.view.id !== null);
  const totalIndex = grid.schema.findIndex((item) => item.name === "total");
  grid.sortBy(colOf(grid, "total"), "desc");
  await until(() => !grid.viewPending && grid.query.sort?.length === 1);
  assert.deepEqual(await column(grid, "item"), ["fig", "apple", "pear"]);
  // pear: 1 × 300 → 10 × 300, now the largest total.
  const pear = 2;
  assert.equal(grid.rowId(pear), 1);
  const prepared = await grid.edits.prepare([{ row: pear, col: colOf(grid, "qty"), text: "10", previous: 1 }], "edit");
  assert.ok(prepared.ok);
  const view = grid.view.id;
  await grid.edits.write(prepared.changes, "edit");
  await until(() => !grid.viewPending && grid.view.id !== view);
  assert.deepEqual(await column(grid, "item"), ["pear", "fig", "apple"]);
  assert.deepEqual(await column(grid, "total"), [3000, 400, 360]);
  const stats = await source.columnStats(grid.view.id, totalIndex);
  assert.equal(stats.max, 3000);
  const filtered = await source.createView({
    formulas: grid.query.formulas,
    filters: [{ type: "compare", column: totalIndex, op: "gt", value: 1000 }],
  });
  assert.equal(filtered.rowCount, 1);
  assert.equal(await grid.edits.undo(), true);
  await until(() => !grid.viewPending && grid.edits.historyState.canRedo);
  await until(() => !grid.viewPending);
  assert.deepEqual(await column(grid, "item"), ["fig", "apple", "pear"]);
  grid.dispose();
});

test("an ArraySource view keeps showing formula values computed from the written rows", async () => {
  const source = orders();
  const view = await source.createView({ formulas: [{ name: "total", expression: "qty * price" }] });
  await source.updateCells({ updates: [{ row: 0, column: 1, value: 4 }] });
  const rows = await source.readRows({ view: view.id, start: 0, end: 3, columns: [3] });
  assert.deepEqual(rows.columns[0], [480, 300, 400]);
  const summary = await source.aggregate({ view: view.id, ranges: [{ start: 0, end: 3, columns: [3] }] });
  assert.equal(summary.sum, 1180);
});

test("the cell editor sits over its cell with right-frozen columns and group headers", async () => {
  const grid = await mounted({
    columnGroups: [{ name: "Order", children: ["qty", "price"] }],
    frozenRightColumns: 1,
  });
  grid.setViewport(300, 32 + 24 + 24 * 5);
  assert.equal(grid.headerHeight, 32 + 24, "one row of groups above the names");
  const right = grid.visible.length - 1;
  assert.ok(grid.isFrozenRight(right));
  const box = grid.cellBox(0, right);
  assert.equal(box.top, grid.headerHeight, "below the group row");
  assert.equal(box.left, grid.columnX(right));
  assert.ok(box.left >= grid.frozenRightX && box.shown);
  // A scrolling column under the right-frozen one is cut at its edge, or hidden.
  const middle = right - 1;
  const cut = grid.cellBox(0, middle);
  assert.ok(cut.left + cut.width <= grid.frozenRightX);
  grid.scrollToVirtual(null, 0);
  // A row scrolled above the header is hidden.
  const scrolled = grid.cellBox(-2, 0);
  assert.equal(scrolled.shown, false);
  grid.dispose();
});
