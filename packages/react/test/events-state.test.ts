import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type GridState, type TableSource } from "vastgrid-core";
import { GridController } from "../src/controller.ts";
import type { GridColumnsEvent, GridSelectionEvent } from "../src/events.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

function people() {
  return new ArraySource({
    columns: ["name", "born", "city"],
    rows: [
      ["Ada", 1815, "London"],
      ["Grace", 1906, "New York"],
      ["Linus", 1969, "Helsinki"],
    ],
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function readyGrid(source: TableSource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

function record<T>(subscribe: (listener: (event: T) => void) => () => void) {
  const events: T[] = [];
  subscribe((event) => events.push(event));
  return events;
}

const names = (grid: GridController) => grid.visible.map((column) => grid.schema[column.index].name);

test("selection events report changes once, and not for drawing, sizing or repeated selections", async () => {
  const grid = await readyGrid(people());
  try {
    const events = record<GridSelectionEvent>((listener) => grid.onSelectionChange(listener));
    grid.setViewport(400, 300);
    grid.requestRender();
    grid.growColumns(new Map([[0, 300]]));
    grid.emit();
    assert.equal(events.length, 0);
    grid.selection.select({ row: 1, col: 2 });
    grid.selectionChanged();
    grid.selectionChanged();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].active, { row: 1, rowId: 1, col: 2, column: 2 });
    grid.selection.select({ row: 2, col: 0 }, "extend");
    grid.selectionChanged();
    assert.deepEqual(events[1].ranges, [
      { top: 1, bottom: 2, left: 0, right: 2, columns: [0, 1, 2], allRows: false, allCols: false },
    ]);
    // Moving a column changes which schema column the active cell is in.
    grid.moveColumn(2, 0);
    assert.equal(events.length, 3);
    assert.deepEqual(events[2].active, { row: 1, rowId: 1, col: 2, column: 1 });
  } finally {
    grid.dispose();
  }
});

test("in a sorted view, the active row's position in the table arrives with the row", async () => {
  const grid = await readyGrid(people());
  try {
    const events = record<GridSelectionEvent>((listener) => grid.onSelectionChange(listener));
    await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
    assert.equal(events.at(-1)?.active.rowId, null);
    grid.cache.want(0, 3, [0, 1, 2]);
    await until(() => events.at(-1)?.active.rowId !== null);
    // The newest person is the last row of the table.
    assert.deepEqual(events.at(-1)?.active, { row: 0, rowId: 2, col: 0, column: 0 });
    assert.deepEqual(grid.cell(2, 1), { row: 2, rowId: 0, col: 1, column: 1 });
  } finally {
    grid.dispose();
  }
});

test("column events report each change by the user, a drag of a column's edge once", async () => {
  const grid = await readyGrid(people());
  try {
    const events = record<GridColumnsEvent>((listener) => grid.onColumnsChange(listener));
    grid.resizing = 0;
    grid.resizeColumn(0, 100);
    grid.resizeColumn(0, 140);
    assert.equal(events.length, 0);
    grid.finishResize();
    assert.deepEqual(
      events.map((event) => event.reason),
      ["resize"],
    );
    assert.deepEqual(events[0].columns[0], {
      column: 0,
      name: "name",
      col: 0,
      width: 140,
      hidden: false,
      sized: true,
      frozen: false,
    });
    // Pressing an edge without moving it changes nothing.
    grid.resizing = 0;
    grid.finishResize();
    grid.moveColumn(2, 0);
    grid.hideColumn(1);
    grid.setColumnHidden(0, true);
    grid.freezeUpTo(0);
    grid.freezeUpTo(0);
    grid.showAllColumns();
    grid.showAllColumns();
    grid.growColumns(new Map([[1, 400]]));
    assert.deepEqual(
      events.map((event) => event.reason),
      ["resize", "move", "visibility", "freeze", "visibility"],
    );
    const last = events.at(-1) as GridColumnsEvent;
    assert.deepEqual(
      last.columns.map((column) => [column.name, column.col, column.frozen]),
      [
        ["city", 0, true],
        ["name", 1, false],
        ["born", 2, false],
      ],
    );
    assert.equal(last.frozenColumns, 1);
  } finally {
    grid.dispose();
  }
});

test("cell events carry the cell's coordinates and value and can stop the default action", async () => {
  const grid = await readyGrid(people());
  try {
    grid.cache.want(0, 3, [0, 1, 2]);
    await until(() => grid.value(1, 0) !== undefined);
    grid.hideColumn(0);
    const keys = { shiftKey: false, ctrlKey: false, metaKey: true, altKey: false };
    const event = grid.cellEvent(1, 1, "keyboard", keys);
    assert.equal(event.column, 2);
    assert.equal(event.value, "New York");
    assert.equal(event.trigger, "keyboard");
    assert.equal(event.metaKey, true);
    assert.equal(event.defaultPrevented, false);
    event.preventDefault();
    assert.equal(event.defaultPrevented, true);
  } finally {
    grid.dispose();
  }
});

test("a saved state restores the query and the columns in a new grid, applied before it loads", async () => {
  const first = await readyGrid(people());
  let saved: GridState;
  try {
    first.moveColumn(2, 0);
    first.resizeColumn(1, 210);
    first.hideColumn(2);
    first.freezeUpTo(0);
    await first.setQuery({ sort: [{ column: 1, direction: "desc" }], search: "n" });
    saved = JSON.parse(JSON.stringify(first.getState()));
    assert.deepEqual(saved, {
      version: 1,
      schema: ["name", "born", "city"],
      query: { sort: [{ column: 1, direction: "desc" }], search: "n" },
      columns: [{ name: "city" }, { name: "name", width: 210 }, { name: "born", hidden: true }],
      frozenColumns: 1,
    });
  } finally {
    first.dispose();
  }
  const second = new GridController(people(), { ...options });
  try {
    assert.equal(second.applyState(saved), true);
    assert.deepEqual(second.getState(), saved);
    second.start();
    await until(() => second.status === "ready" && !second.viewPending && second.view.id !== null);
    assert.deepEqual(second.getState(), saved);
    assert.deepEqual(names(second), ["city", "name"]);
    assert.equal(second.visible[1].width, 210);
    assert.equal(second.frozen, 1);
    // "Grace", "Linus" and "Ada" contain "n" (search ignores case); the newest first.
    assert.equal(second.rowCount, 3);
  } finally {
    second.dispose();
  }
});

test("a state applied to a table whose columns changed keeps what still exists", async () => {
  const grid = await readyGrid(
    new ArraySource({
      columns: ["city", "added", "name"],
      rows: [
        ["London", 1, "Ada"],
        ["Helsinki", 2, "Linus"],
      ],
    }),
  );
  try {
    const applied = grid.applyState({
      version: 1,
      schema: ["name", "removed", "city"],
      query: {
        sort: [
          { column: 1, direction: "asc" },
          { column: 0, direction: "asc" },
        ],
        filters: [{ type: "values", column: 2, values: ["London", "Helsinki"] }],
      },
      columns: [{ name: "removed" }, { name: "name", width: 90 }, { name: "city", hidden: true }],
      frozenColumns: 2,
    });
    assert.equal(applied, true);
    await until(() => !grid.viewPending && grid.view.id !== null);
    assert.deepEqual(grid.query, {
      sort: [{ column: 2, direction: "asc" }],
      filters: [{ type: "values", column: 0, values: ["London", "Helsinki"], exclude: false }],
    });
    // The new column follows the listed ones; "removed" was frozen, so only "name" is.
    assert.deepEqual(names(grid), ["name", "added"]);
    assert.equal(grid.frozen, 1);
    assert.equal(grid.applyState({ version: 9 } as unknown as GridState), false);
    // All columns hidden: the first stays visible.
    grid.applyState({
      version: 1,
      columns: [
        { name: "city", hidden: true },
        { name: "added", hidden: true },
        { name: "name", hidden: true },
      ],
    });
    assert.deepEqual(names(grid), ["city"]);
  } finally {
    grid.dispose();
  }
});

test("a state waits for a schema that arrives late, and a query set after it wins", async () => {
  const source = people();
  const info = source.info.bind(source);
  let empty = 2;
  source.info = async () => {
    const result = await info();
    if (empty-- <= 0) return result;
    return { ...result, columns: [], status: "loading", rowCount: null, readableRows: 0 };
  };
  const grid = new GridController(source, { ...options });
  try {
    grid.applyState({
      version: 1,
      schema: ["name", "born", "city"],
      query: { search: "Ada" },
      columns: [{ name: "born" }],
    });
    grid.start();
    await until(() => grid.schema.length === 0 && grid.info !== null);
    assert.deepEqual(grid.getState().columns, [{ name: "born" }]);
    grid.setQuery({ sort: [{ column: 0, direction: "desc" }] });
    await until(() => grid.status === "ready" && !grid.viewPending && grid.view.id !== null);
    assert.deepEqual(names(grid), ["born", "name", "city"]);
    assert.deepEqual(grid.query, { sort: [{ column: 0, direction: "desc" }] });
  } finally {
    grid.dispose();
  }
});

test("state changes are reported for the query and column settings, not for the selection", async () => {
  const grid = await readyGrid(people());
  try {
    const states = record<GridState>((listener) => grid.onStateChange(listener));
    grid.selection.select({ row: 1, col: 1 });
    grid.selectionChanged();
    grid.growColumns(new Map([[1, 400]]));
    assert.equal(states.length, 0);
    grid.setColumnHidden(2, true);
    await grid.setQuery({ search: "a" });
    assert.equal(states.length, 2);
    assert.deepEqual(states[1].query, { search: "a" });
    assert.deepEqual(states[1].columns?.[2], { name: "city", hidden: true });
    // A plain query, as saved from onQueryChange, applies as a state.
    assert.equal(grid.applyState({ sort: [{ column: 1, direction: "asc" }] } as unknown as GridState), true);
    await until(() => !grid.viewPending);
    assert.deepEqual(grid.query, { sort: [{ column: 1, direction: "asc" }] });
    assert.equal(states.length, 3);
  } finally {
    grid.dispose();
  }
});
