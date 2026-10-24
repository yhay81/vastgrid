import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue, type TableChangeListener, type TableSource } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";

const options: GridOptions = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  changeDelay: 20,
};

function rowsUpTo(count: number): CellValue[][] {
  return Array.from({ length: count }, (_, index) => [index, `row ${index}`]);
}

/** A table whose rows the test replaces, reporting each replacement to its subscribers. */
function liveSource(count: number) {
  let current = new ArraySource({ columns: ["n", "text"], rows: rowsUpTo(count) });
  let revision = 1;
  const listeners = new Set<TableChangeListener>();
  const state = { infos: 0, listeners };
  const source: TableSource = {
    info: async () => {
      state.infos++;
      return { ...(await current.info()), revision: String(revision) };
    },
    createView: (query, signal) => current.createView(query, signal),
    readRows: (request) => current.readRows(request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (rows: number) => {
    current = new ArraySource({ columns: ["n", "text"], rows: rowsUpTo(rows) });
    revision++;
    for (const listener of listeners) listener({ revision: String(revision) });
  };
  return { source, state, change };
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

/** A grid with a viewport of 5 rows, as the component sets it up. */
async function mounted(source: TableSource, extra: Partial<GridOptions> = {}) {
  const grid = new GridController(source, { ...options, ...extra });
  const scroller = { scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement;
  const sizer = { style: {} } as unknown as HTMLElement;
  grid.attach(scroller, sizer);
  grid.setViewport(400, 32 + 24 * 5);
  grid.start();
  await until(() => grid.info?.status === "ready");
  return grid;
}

test("a reported change reads the table again once, keeping the sort, the scroll position and the active cell", async () => {
  const { source, state, change } = liveSource(100);
  const grid = await mounted(source);
  await grid.setQuery({ sort: [{ column: 0, direction: "desc" }] });
  grid.scrollToVirtual(null, 24 * 50);
  grid.selection.select({ row: 52, col: 1 });
  const infos = state.infos;
  // Many changes at once are merged into one reload.
  change(101);
  change(102);
  change(103);
  await until(() => grid.info?.revision === "4" && grid.view.id !== null && !grid.viewPending);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(state.infos - infos, 1);
  assert.deepEqual(grid.query, { sort: [{ column: 0, direction: "desc" }] });
  assert.equal(grid.rowCount, 103);
  assert.equal(grid.scrollY.position, 24 * 50);
  assert.deepEqual(grid.selection.active, { row: 52, col: 1 });
  grid.dispose();
});

test("followTail shows the appended rows when the last row was shown", async () => {
  const { source, change } = liveSource(100);
  const grid = await mounted(source, { followTail: true });
  grid.scrollToVirtual(null, 24 * 100);
  grid.selection.select({ row: 99, col: 0 });
  assert.equal(grid.visibleRows()[1], 100);
  change(110);
  await until(() => grid.rowCount === 110 && grid.visibleRows()[1] === 110);
  assert.deepEqual(grid.selection.active, { row: 109, col: 0 });

  // Scrolled away from the end, the grid stays where it is.
  grid.scrollToVirtual(null, 24 * 10);
  change(120);
  await until(() => grid.rowCount === 120);
  assert.equal(grid.scrollY.position, 24 * 10);
  grid.dispose();
});

test("without followTail the grid stays at the old end", async () => {
  const { source, change } = liveSource(100);
  const grid = await mounted(source);
  grid.scrollToVirtual(null, 24 * 100);
  const top = grid.scrollY.position;
  change(110);
  await until(() => grid.rowCount === 110);
  assert.equal(grid.scrollY.position, top);
  grid.dispose();
});

test("stopping or disposing the grid ends its subscription and a pending reload", async () => {
  const { source, state, change } = liveSource(10);
  const grid = await mounted(source);
  assert.equal(state.listeners.size, 1);
  grid.stop();
  assert.equal(state.listeners.size, 0);
  grid.start();
  assert.equal(state.listeners.size, 1);
  change(11);
  const infos = state.infos;
  grid.dispose();
  assert.equal(state.listeners.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(state.infos, infos, "the merged reload does not run after dispose");
});
