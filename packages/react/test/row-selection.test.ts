import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue, type Filter, type TableInfo, type TableSource } from "vastgrid-core";
import { GridController } from "../src/controller.ts";
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
