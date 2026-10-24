import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type GridState, GroupedSource, type GroupRequest, type TableSource } from "vastgrid-core";
import { totalText } from "../src/components/totals-row.tsx";
import { GridController } from "../src/controller.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  locale: "en",
};

function sales() {
  return new ArraySource({
    columns: [
      { name: "region", type: "string" },
      { name: "amount", type: "integer" },
      { name: "day", type: "date" },
    ],
    rows: [
      ["East", 10, "2024-01-02"],
      ["West", 5, "2024-03-01"],
      ["East", 7, "2023-12-31"],
      [null, 1, null],
    ],
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function readyGrid(source: TableSource, state?: GridState) {
  const grid = new GridController(source, { ...options });
  if (state) grid.applyState(state);
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

test("the totals row is computed by the source over the current view and kept in the state", async () => {
  const requests: GroupRequest[] = [];
  const base = sales();
  const source = Object.assign(Object.create(base) as ArraySource, {
    group(request: GroupRequest) {
      requests.push(request);
      return base.group(request);
    },
  });
  const grid = await readyGrid(source);
  try {
    assert.equal(grid.totalsAvailable, true);
    grid.setTotal(1, "sum");
    // Functions that do not fit the column are ignored.
    grid.setTotal(2, "sum");
    grid.setTotal(2, "max");
    await until(() => !grid.totalsPending && grid.totalValues !== null);
    assert.deepEqual(
      [...(grid.totalValues ?? [])],
      [
        [1, 23],
        [2, "2024-03-01"],
      ],
    );
    assert.equal(totalText(grid, 1), "23");
    assert.deepEqual(requests.at(-1), {
      view: null,
      keys: [],
      aggregates: [
        { fn: "sum", column: 1 },
        { fn: "max", column: 2 },
      ],
    });
    const asked = requests.length;
    grid.updateLayout();
    assert.equal(requests.length, asked, "unchanged totals are not read again");

    await grid.setQuery({ filters: [{ type: "values", column: 0, values: ["East"] }] });
    await until(() => !grid.totalsPending && grid.totalValues?.get(1) === 17);
    assert.notEqual(requests.at(-1)?.view, null);

    const state = grid.getState();
    assert.deepEqual(
      state.columns?.map((column) => [column.name, column.total]),
      [
        ["region", undefined],
        ["amount", "sum"],
        ["day", "max"],
      ],
    );
    const restored = await readyGrid(sales(), state);
    try {
      assert.equal(restored.totalOf(1), "sum");
      await until(() => restored.totalValues?.get(1) === 17);
      restored.applyState({ version: 1, columns: [{ name: "amount" }] });
      assert.equal(restored.totalOf(1), null);
      assert.equal(restored.totalOf(2), "max");
    } finally {
      restored.dispose();
    }
    grid.setTotal(1, null);
    grid.setTotal(2, null);
    assert.equal(grid.totalValues, null);
  } finally {
    grid.dispose();
  }
});

test("sources without grouping offer no totals", async () => {
  const base = sales();
  const source: TableSource = {
    info: async () => ({ ...(await base.info()), capabilities: { ...(await base.info()).capabilities, group: false } }),
    createView: (query) => base.createView(query),
    readRows: (request) => base.readRows(request),
  };
  const grid = await readyGrid(source);
  try {
    assert.equal(grid.totalsAvailable, false);
    grid.setTotal(1, "sum");
    assert.equal(grid.totalValues, null);
    assert.equal(grid.totalsPending, false);
  } finally {
    grid.dispose();
  }
});

test("a grid of groups sorts, filters and totals them", async () => {
  const grouped = new GroupedSource(sales(), {
    keys: [0],
    aggregates: [{ fn: "count" }, { fn: "sum", column: 1 }],
  });
  const grid = await readyGrid(grouped);
  try {
    assert.deepEqual(
      grid.schema.map((column) => column.name),
      ["region", "count(*)", "sum(amount)"],
    );
    assert.equal(grid.rowCount, 3);
    grid.sortBy(2, "desc");
    await until(() => !grid.viewPending && grid.view.id !== null);
    const rows = await grouped.readRows({ view: grid.view.id, start: 0, end: 3, columns: [0, 2] });
    assert.deepEqual(rows.columns, [
      ["East", "West", null],
      [17, 5, 1],
    ]);
    grid.setTotal(2, "sum");
    await until(() => grid.totalValues?.get(2) === 23);
  } finally {
    grid.dispose();
  }
});
