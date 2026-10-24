import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type Filter, type FilterNode, type TableChangeListener, type TableSource } from "vastgrid-core";
import { initialDraft } from "../src/components/filter-builder.tsx";
import { GridController } from "../src/controller.ts";
import { conditionLabel } from "../src/labels.ts";
import { en } from "../src/messages.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

function sales() {
  return new ArraySource({
    columns: ["region", "amount", "status"],
    rows: [
      ["Tokyo", 50_000, "open"],
      ["Osaka", 150_000, "open"],
      ["Tokyo", 200_000, "cancelled"],
      ["Nagoya", 20_000, "open"],
    ],
  });
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(condition());
}

async function readyGrid(source: TableSource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  await until(() => grid.info?.status === "ready");
  return grid;
}

const tokyo: Filter = { type: "values", column: 0, values: ["Tokyo"] };
const large: Filter = { type: "compare", column: 1, op: "gt", value: 100_000 };
const notCancelled: Filter = { type: "values", column: 2, values: ["cancelled"], exclude: true };

test("conditions keep single column filters in `filters` and the rest in the condition tree", async () => {
  const grid = await readyGrid(sales());
  try {
    const or: FilterNode = { type: "or", filters: [tokyo, large] };
    await grid.setCondition({ type: "and", filters: [notCancelled, or] });
    assert.deepEqual(grid.query.filters, [notCancelled]);
    assert.deepEqual(grid.query.where, or);
    assert.equal(grid.rowCount, 2);
    assert.equal(grid.filterOf(2), notCancelled);
    assert.equal(grid.filterOf(0), null);
    assert.equal(grid.isFiltered(0), true, "the header shows that the tree uses the column");
    assert.deepEqual(grid.condition, { type: "and", filters: [notCancelled, or] });
    // Two conditions on one column stay together in the tree.
    const range: Filter[] = [
      { type: "compare", column: 1, op: "ge", value: 20_000 },
      { type: "compare", column: 1, op: "lt", value: 150_000 },
    ];
    await grid.setCondition({ type: "and", filters: range });
    assert.deepEqual(grid.query.filters, []);
    assert.deepEqual(grid.query.where, { type: "and", filters: range });
    assert.equal(grid.rowCount, 2);
    // A top OR group goes to the tree as it is; clearing removes everything.
    await grid.setCondition(or);
    assert.deepEqual(grid.query.where, or);
    assert.equal(grid.rowCount, 3);
    grid.clearFilters();
    await until(() => !grid.viewPending);
    assert.equal(grid.query.where, undefined);
    assert.equal(grid.rowCount, 4);
    // The state saves the tree.
    await grid.setCondition({ type: "and", filters: [notCancelled, or] });
    const saved = JSON.parse(JSON.stringify(grid.getState()));
    const other = await readyGrid(sales());
    try {
      assert.equal(other.applyState(saved), true);
      await until(() => !other.viewPending && other.view.id !== null);
      assert.deepEqual(other.query.where, { type: "or", filters: [{ ...tokyo, exclude: false }, large] });
      assert.equal(other.rowCount, 2);
    } finally {
      other.dispose();
    }
  } finally {
    grid.dispose();
  }
});

test("a column's filter panel adds a condition by AND or OR in the builder", async () => {
  const grid = await readyGrid(sales());
  try {
    await grid.setCondition({ type: "and", filters: [notCancelled, tokyo] });
    const or = initialDraft(grid.condition, grid.schema, { column: 0, filter: tokyo, type: "or" });
    // The column's filter moves into a new OR group with a new condition on the same column.
    assert.deepEqual(
      or.children.map((child) => (child.kind === "leaf" ? child.column : child.children.map((item) => item.kind))),
      [2, ["leaf", "leaf"]],
    );
    const and = initialDraft(grid.condition, grid.schema, { column: 1, filter: null, type: "and" });
    assert.equal(and.children.length, 3);
  } finally {
    grid.dispose();
  }
});

test("condition trees are left out for sources that do not run them, and labels describe them", async () => {
  // A source written before condition trees existed filters, but does not report `conditions`.
  for (const capabilities of [{ filter: false }, { conditions: undefined }]) {
    const source = sales();
    const info = source.info.bind(source);
    source.info = async (signal?: AbortSignal) => {
      const result = await info(signal);
      return { ...result, capabilities: { ...result.capabilities, ...capabilities } };
    };
    const grid = await readyGrid(source);
    try {
      await grid.setQuery({ where: { type: "or", filters: [tokyo, large] }, search: "open" });
      assert.deepEqual(grid.query, { search: "open" });
    } finally {
      grid.dispose();
    }
  }
  const names = ["region", "amount", "status"];
  const label = conditionLabel(
    { type: "and", filters: [{ type: "or", filters: [tokyo, large] }, notCancelled] },
    (column) => ({ label: names[column], format: String }) as never,
    en,
  );
  assert.equal(label, "(region : Tokyo or amount > 100000) and status ≠ cancelled");
});

test("a reported change reads the table again with the condition tree, its columns followed by name", async () => {
  const first = sales();
  // The file is rewritten: "status" is gone, "amount" comes first and a row is added.
  const second = new ArraySource({
    columns: ["amount", "region"],
    rows: [
      [50_000, "Tokyo"],
      [150_000, "Osaka"],
      [200_000, "Tokyo"],
      [20_000, "Nagoya"],
      [300_000, "Kyoto"],
    ],
  });
  let current = first;
  let revision = 1;
  const listeners = new Set<TableChangeListener>();
  const source: TableSource = {
    info: async () => ({ ...(await current.info()), revision: String(revision) }),
    createView: (query, signal) => current.createView(query, signal),
    readRows: (request) => current.readRows(request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (next: ArraySource) => {
    current = next;
    revision++;
    for (const listener of listeners) listener({ revision: String(revision) });
  };
  const grid = new GridController(source, { ...options, changeDelay: 10 });
  grid.start();
  await until(() => grid.info?.status === "ready");
  try {
    const where: FilterNode = {
      type: "or",
      filters: [tokyo, large, { type: "and", filters: [notCancelled, { type: "blank", column: 2, blank: true }] }],
    };
    await grid.setQuery({ where });
    assert.equal(grid.rowCount, 3);
    // The same columns: the tree stays as it is and applies to the new rows.
    change(
      new ArraySource({
        columns: ["region", "amount", "status"],
        rows: [
          ["Tokyo", 50_000, "open"],
          ["Kobe", 500_000, "open"],
        ],
      }),
    );
    await until(() => grid.info?.revision === "2" && grid.view.id !== null && !grid.viewPending);
    assert.deepEqual(grid.query.where, where);
    assert.equal(grid.rowCount, 2);
    // Moved columns follow their names; conditions on the removed column, and the group they leave
    // empty, are dropped.
    change(second);
    await until(() => grid.info?.revision === "3" && grid.view.id !== null && !grid.viewPending);
    assert.deepEqual(grid.query.where, {
      type: "or",
      filters: [
        { ...tokyo, column: 1 },
        { ...large, column: 0 },
      ],
    });
    assert.equal(grid.rowCount, 4);
    assert.equal(grid.viewError, null);
  } finally {
    grid.dispose();
  }
});
