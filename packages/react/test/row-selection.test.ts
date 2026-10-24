import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue, type Filter, type TableInfo, type TableSource } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";
import type { GridRowSelectionEvent } from "../src/events.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  checkboxSelection: true,
};

const people: CellValue[][] = [
  ["Ada", 1815, "London"],
  ["Grace", 1906, "New York"],
  ["Linus", 1969, "Helsinki"],
  ["Alan", 1912, "London"],
];

/** An array table whose data can be replaced, with a revision for each version. */
class ChangingSource implements TableSource {
  private table: ArraySource;
  private revision = "1";

  constructor(rows: CellValue[][]) {
    this.table = new ArraySource({ columns: ["name", "born", "city"], rows });
  }

  replace(rows: CellValue[][], revision: string) {
    this.table = new ArraySource({ columns: ["name", "born", "city"], rows });
    this.revision = revision;
  }

  async info(): Promise<TableInfo> {
    return { ...(await this.table.info()), revision: this.revision };
  }
  createView: TableSource["createView"] = (query) => this.table.createView(query);
  readRows: TableSource["readRows"] = (request) => this.table.readRows(request);
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function readyGrid(source: TableSource, extra: { rowKey?: string } = {}) {
  const grid = new GridController(source, { ...options, ...extra });
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

/** Loads the rows of the view, as the renderer does while drawing. */
async function load(grid: GridController) {
  const columns = grid.schema.map((_, index) => index);
  grid.cache.want(0, grid.rowCount, columns);
  await until(() => {
    for (let row = 0; row < grid.rowCount; row++) if (grid.rowKey(row) === null) return false;
    return true;
  });
}

function record(grid: GridController) {
  const events: GridRowSelectionEvent[] = [];
  grid.onRowSelectionChange((event) => events.push(event));
  return events;
}

const names = (grid: GridController) =>
  Array.from({ length: grid.rowCount }, (_, row) => grid.cache.value(row, 0)).filter(
    (_, row) => grid.rowChecked(row) === true,
  );

const london: Filter = { type: "values", column: 2, values: ["London"] };

test("checked rows stay with their records when the view is sorted and filtered", async () => {
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    const events = record(grid);
    await load(grid);
    assert.equal(grid.toggleRow(0), true);
    assert.equal(grid.toggleRow(2), true);
    assert.deepEqual(events.at(-1), { reason: "user", selection: { type: "include", keys: [0, 2] }, count: 2 });
    await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
    await load(grid);
    assert.deepEqual(names(grid), ["Linus", "Ada"]);
    // Linus is filtered out but stays checked.
    await grid.setQuery({ filters: [london] });
    await load(grid);
    assert.deepEqual(names(grid), ["Ada"]);
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [0, 2] });
    assert.equal(grid.allRowsChecked, "mixed");
    assert.equal(events.length, 2, "views do not report the checked rows again");
  } finally {
    grid.dispose();
  }
});

test("shift checks the rows from the last clicked checkbox", async () => {
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    await grid.setQuery({ sort: [{ column: 0, direction: "asc" }] });
    await load(grid);
    grid.toggleRow(0);
    grid.toggleRow(2, true);
    assert.deepEqual(names(grid), ["Ada", "Alan", "Grace"]);
    grid.toggleRow(3);
    grid.toggleRow(1, true);
    assert.deepEqual(names(grid), ["Ada"]);
  } finally {
    grid.dispose();
  }
});

test("checking every row lists no keys, and a filtered view checks the rows matching its filters", async () => {
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    const events = record(grid);
    grid.toggleAllRows();
    assert.deepEqual(grid.getRowSelection(), { type: "exclude", keys: [] });
    assert.equal(grid.checkedCount, 4);
    assert.equal(grid.allRowsChecked, true);
    grid.toggleAllRows();
    assert.equal(grid.rowSelection.empty, true);

    await grid.setQuery({ filters: [london], sort: [{ column: 1, direction: "desc" }] });
    await load(grid);
    grid.toggleAllRows();
    const selection = grid.getRowSelection();
    assert.equal(selection.type, "exclude");
    assert.deepEqual(selection.type === "exclude" && selection.query, { filters: [london] });
    assert.equal(grid.checkedCount, 2);
    grid.toggleRow(0);
    assert.deepEqual(names(grid), ["Ada"]);
    assert.equal(grid.checkedCount, 1);
    // Sorting differently keeps to the same rows.
    await grid.setQuery({ filters: [london] });
    await load(grid);
    assert.deepEqual(names(grid), ["Ada"]);
    // Without the filter, the grid lists the keys of the checked rows so that each row can be told apart.
    await grid.setQuery({});
    await until(() => !grid.rowSelectionPending && grid.getRowSelection().type === "include");
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [0] });
    assert.equal(events.at(-1)?.reason, "query");
    await load(grid);
    assert.deepEqual(names(grid), ["Ada"]);
  } finally {
    grid.dispose();
  }
});

test("a large selection of every row matching a query stays as it is in views it does not cover", async () => {
  const rows = Array.from({ length: 240_001 }, (_, index) => [index, index % 2 === 0 ? "even" : "odd"]);
  const grid = await readyGrid(new ArraySource({ columns: ["n", "kind"], rows }));
  try {
    const even: Filter = { type: "values", column: 1, values: ["even"] };
    assert.equal(grid.setRowSelection({ type: "exclude", keys: [4], query: { filters: [even] } }), true);
    await until(() => !grid.rowSelectionPending);
    assert.equal(grid.getRowSelection().type, "exclude");
    grid.cache.want(0, 10, [0, 1]);
    await until(() => grid.rowKey(0) !== null);
    assert.equal(grid.rowChecked(0), null);
    assert.equal(grid.toggleRow(0), false);
    // The grid counted the matching rows while trying to list them.
    assert.equal(grid.checkedCount, 120_000);
    await grid.setQuery({ filters: [even] });
    grid.cache.want(0, 10, [0, 1]);
    await until(() => grid.rowKey(2) !== null);
    assert.deepEqual([grid.rowChecked(0), grid.rowChecked(1), grid.rowChecked(2)], [true, true, false]);
  } finally {
    grid.dispose();
  }
});

test("a new revision unchecks rows keyed by position, and the same revision keeps them", async () => {
  const source = new ChangingSource(people);
  const grid = await readyGrid(source);
  try {
    const events = record(grid);
    grid.setRowSelection({ type: "include", keys: [1] });
    assert.equal(events.at(-1)?.reason, "api");
    grid.reload();
    await until(() => grid.info?.status === "ready");
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [1] });
    source.replace([people[1], people[0]], "2");
    grid.reload();
    await until(() => grid.info?.revision === "2");
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [] });
    assert.equal(events.at(-1)?.reason, "revision");
  } finally {
    grid.dispose();
  }
});

test("keys from a key column survive a new revision, including keys of removed rows", async () => {
  const source = new ChangingSource(people);
  const grid = await readyGrid(source, { rowKey: "name" });
  try {
    const events = record(grid);
    await load(grid);
    assert.equal(grid.rowKey(1), "Grace");
    grid.toggleRow(1);
    grid.toggleRow(2);
    source.replace([people[2], people[3], people[0]], "2");
    grid.reload();
    await until(() => grid.info?.revision === "2");
    await load(grid);
    assert.deepEqual(names(grid), ["Linus"]);
    // Grace is no longer in the table; her key stays until the app or the user removes it.
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: ["Grace", "Linus"] });
    assert.equal(events.at(-1)?.reason, "user");
    // Another key column names other rows.
    grid.setRowKey(undefined);
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [] });
    assert.equal(events.at(-1)?.reason, "key");
  } finally {
    grid.dispose();
  }
});

test("the app sets checked rows; equal or invalid values change nothing", async () => {
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    const events = record(grid);
    assert.equal(grid.setRowSelection({ type: "include", keys: [2, 3] }), true);
    assert.equal(grid.setRowSelection({ type: "include", keys: [3, 2] }), true);
    assert.equal(events.length, 1);
    assert.equal(grid.setRowSelection({ type: "include", keys: [{}] } as never), false);
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [2, 3] });
    grid.clearRowSelection();
    assert.deepEqual(events.at(-1), { reason: "user", selection: { type: "include", keys: [] }, count: 0 });
    // Checked rows are not part of the saved state.
    assert.equal("rowSelection" in grid.getState(), false);
  } finally {
    grid.dispose();
  }
});

test("the checkboxes widen the row header and are hit at its left", async () => {
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    grid.setViewport(400, 300);
    const wide = grid.gutterWidth;
    assert.equal(grid.hitTest(10, 40).checkbox, true);
    assert.equal(grid.hitTest(10, 40).zone, "gutter");
    assert.equal(grid.hitTest(10, 10).checkbox, true);
    assert.equal(grid.hitTest(10, 10).zone, "corner");
    assert.equal(grid.hitTest(wide - 4, 40).checkbox, false);
    grid.setCheckboxSelection(false);
    assert.equal(grid.gutterWidth, wide - 28);
    assert.equal(grid.hitTest(10, 40).checkbox, false);
  } finally {
    grid.dispose();
  }
});

// ----- with reloads (#32), wrapping (#26) and cell hooks (#7) -----

/** A table that reports each replacement of its rows to its subscribers, with a new revision. */
function liveSource(rows: CellValue[][]) {
  const source = new ChangingSource(rows);
  const listeners = new Set<(change: { revision?: string | null }) => void>();
  let revision = 1;
  const live: TableSource = {
    info: (signal) => source.info(signal),
    createView: (query) => source.createView(query),
    readRows: (request) => source.readRows(request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (next: CellValue[][]) => {
    revision++;
    source.replace(next, String(revision));
    for (const listener of listeners) listener({ revision: String(revision) });
  };
  return { live, change };
}

/** A grid with a scroller and a viewport, as the component sets it up, so that reloads restore the position. */
async function mountedGrid(source: TableSource, extra: Partial<GridOptions> = {}) {
  const grid = new GridController(source, { ...options, changeDelay: 10, ...extra });
  grid.attach({ scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement, { style: {} } as unknown as HTMLElement);
  grid.setViewport(400, 32 + 24 * 3);
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

const appended = [...people, ["Barbara", 1939, "San Francisco"]];

test("a reported change keeps the active cell, and unchecks rows keyed by position", async () => {
  const { live, change } = liveSource(people);
  const grid = await mountedGrid(live);
  try {
    const events = record(grid);
    await grid.setQuery({ sort: [{ column: 1, direction: "asc" }] });
    await load(grid);
    grid.toggleRow(1);
    grid.selection.select({ row: 2, col: 1 });
    grid.selectionChanged();
    // Rows appended to the file give it a new revision: positions are not trusted across revisions.
    change(appended);
    await until(() => grid.info?.revision === "2" && grid.view.id !== null && !grid.viewPending);
    assert.deepEqual(grid.selection.active, { row: 2, col: 1 });
    assert.equal(grid.rowSelection.empty, true);
    assert.equal(events.at(-1)?.reason, "revision");
  } finally {
    grid.dispose();
  }
});

test("a reported change keeps rows keyed by a column checked in the restored view", async () => {
  const { live, change } = liveSource(people);
  const grid = await mountedGrid(live, { rowKey: "name" });
  try {
    const events = record(grid);
    await grid.setQuery({ filters: [london] });
    await load(grid);
    grid.toggleAllRows();
    grid.toggleRow(1);
    const before = events.length;
    change([...appended, ["Ann", 1990, "London"]]);
    await until(() => grid.info?.revision === "2" && grid.view.id !== null && !grid.viewPending);
    await load(grid);
    // Every London row except Alan, including the new one.
    assert.deepEqual(names(grid), ["Ada", "Ann"]);
    assert.equal(grid.checkedCount, 2);
    assert.equal(events.length, before, "a reload does not report unchanged checked rows");
  } finally {
    grid.dispose();
  }
});

test("checkboxes follow rows made taller by wrapping columns", async () => {
  const grid = await mountedGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }), { maxLines: 3 });
  try {
    grid.setColumnFormats({ city: { wrap: true } });
    const height = grid.rowHeight;
    assert.ok(height > options.rowHeight);
    await load(grid);
    // The lower part of the second row is still the second row's checkbox.
    const hit = grid.hitTest(8, options.headerHeight + height + height - 4);
    assert.deepEqual([hit.zone, hit.row, hit.checkbox], ["gutter", 1, true]);
    assert.equal(grid.toggleRow(hit.row), true);
    assert.deepEqual(grid.getRowSelection(), { type: "include", keys: [1] });
  } finally {
    grid.dispose();
  }
});

test("row keys are the rowId of cell events and of the cell hooks, and checking moves no cell", async () => {
  const seen: (number | null)[] = [];
  const grid = await readyGrid(new ArraySource({ columns: ["name", "born", "city"], rows: people }));
  try {
    grid.options.cellAction = (cell) => {
      seen.push(cell.rowId);
      return null;
    };
    await grid.setQuery({ sort: [{ column: 0, direction: "desc" }] });
    await load(grid);
    const selections: unknown[] = [];
    grid.onSelectionChange((event) => selections.push(event));
    for (let row = 0; row < grid.rowCount; row++) {
      const key = grid.rowKey(row);
      assert.equal(grid.cellContent(row, 0)?.rowId, key);
      assert.equal(grid.cell(row, 0).rowId, key);
      grid.cellActionAt(row, 0);
    }
    assert.deepEqual(seen, [2, 1, 3, 0]);
    grid.toggleRow(0);
    grid.toggleAllRows();
    assert.equal(selections.length, 0);
  } finally {
    grid.dispose();
  }
});
