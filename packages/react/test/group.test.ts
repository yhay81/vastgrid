import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type GridState, GroupedSource, type GroupRequest, type TableSource } from "vastgrid-core";
import { totalText } from "../src/components/totals-row.tsx";
import { GridController } from "../src/controller.ts";
import { pivotColumnFormats, pivotColumnGroups, pivotHeaders } from "../src/grouping.ts";

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

test("totals read the formula columns of the view", async () => {
  const grid = await readyGrid(sales());
  try {
    grid.setFormulas([{ name: "double", expression: "amount * 2" }]);
    await until(() => grid.schema.length === 4 && !grid.viewPending && grid.view.id !== null);
    grid.setTotal(3, "sum");
    await until(() => grid.totalValues?.get(3) === 46);
    // The totals follow a filter on the formula column.
    await grid.setQuery({ ...grid.query, filters: [{ type: "compare", column: 3, op: "ge", value: 14 }] });
    await until(() => grid.totalValues?.get(3) === 34);
  } finally {
    grid.dispose();
  }
});

test("a cross tabulation's grid groups its generated columns under their values and freezes the keys", async () => {
  const schema = [
    { name: "region", type: "string" as const },
    { name: "year", type: "integer" as const },
    { name: "amount", type: "integer" as const },
  ];
  const base = new ArraySource({
    columns: schema,
    rows: [
      ["East", 2023, 1],
      ["East", 2024, 2],
      ["West", 2024, 3],
    ],
  });
  const draft = { keys: [0], aggregates: [{ fn: "count" as const }, { fn: "sum" as const, column: 2 }], pivot: [1] };
  const grouped = new GroupedSource(base, { ...draft, pivot: { columns: draft.pivot } });
  const result = await grouped.load();
  const columnGroups = pivotColumnGroups(result);
  assert.deepEqual(columnGroups, [
    { name: "2023", children: ["2023 / count(*)", "2023 / sum(amount)"] },
    { name: "2024", children: ["2024 / count(*)", "2024 / sum(amount)"] },
  ]);
  const columnFormats = pivotColumnFormats(
    { source: grouped, draft, schema },
    { "2024 / count(*)": { label: "Mine" } },
  );
  const grid = new GridController(grouped, { ...options, columnGroups, columnFormats, frozenColumns: 1 });
  grid.start();
  await until(() => grid.info?.status === "ready");
  try {
    assert.equal(grid.columnLabel(1), "count(*)");
    assert.equal(grid.columnLabel(3), "Mine");
    assert.deepEqual(
      grid.groupSpans()[0].map((span) => [span.group.name, span.start, span.end]),
      [
        ["2023", 1, 2],
        ["2024", 3, 4],
      ],
    );
    assert.equal(grid.frozen, 1);
    assert.equal(grid.getState().frozenColumns, 1);
  } finally {
    grid.dispose();
  }
});

test("a grid of groups reads them again on reload, with the headers of the new cross tabulation", async () => {
  const schema = [
    { name: "city", type: "string" as const },
    { name: "year", type: "integer" as const },
  ];
  let current = new ArraySource({
    columns: schema,
    rows: [
      ["Tokyo", 2024],
      ["Osaka", 2024],
    ],
  });
  // A table that changes without telling (no `subscribe`, no `revision`), as a file read again with `reloadKey`.
  const base: TableSource = {
    info: () => current.info(),
    createView: (query) => current.createView(query),
    readRows: (request) => current.readRows(request),
    group: (request) => current.group(request),
  };
  const draft = { keys: [1], aggregates: [{ fn: "count" as const }], pivot: [0] };
  const source = new GroupedSource(base, { ...draft, pivot: { columns: draft.pivot } });
  await source.load();
  const grouping = { source, draft, schema };
  let headers = pivotHeaders(grouping, null, undefined);
  const grid = new GridController(source, {
    ...options,
    columnGroups: headers?.columnGroups,
    columnFormats: headers?.columnFormats,
  });
  grid.start();
  await until(() => grid.info?.status === "ready");
  try {
    assert.equal(grid.schema.length, 3);
    current = new ArraySource({
      columns: schema,
      rows: [
        ["Tokyo", 2024],
        ["Osaka", 2024],
        ["Nagoya", 2024],
      ],
    });
    // What the grid does on reload (`reloadTable`): the groups are read again.
    source.reload();
    // While they are read again, the last headers stay.
    assert.equal(pivotHeaders(grouping, headers, undefined)?.columnGroups?.length, 2);
    grid.reload();
    await until(() => grid.info?.status === "ready" && grid.schema.length === 4);
    headers = pivotHeaders(grouping, headers, undefined);
    grid.setColumnGroups(headers?.columnGroups);
    grid.setColumnFormats(headers?.columnFormats);
    assert.deepEqual(
      grid.groupSpans()[0].map((span) => span.group.name),
      ["Nagoya", "Osaka", "Tokyo"],
    );
    assert.equal(grid.columnLabel(1), "count(*)");
  } finally {
    grid.dispose();
  }
});
