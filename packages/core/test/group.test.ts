import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import { parseGridState } from "../src/grid-state.ts";
import { GroupedSource } from "../src/grouped-source.ts";
import type { TableChangeListener, TableSource } from "../src/source.ts";
import type { GroupRequest } from "../src/types.ts";

function orders() {
  return new ArraySource({
    columns: [
      { name: "region", type: "string" },
      { name: "qty", type: "integer" },
      { name: "price", type: "decimal", sourceType: "DECIMAL(10,2)" },
      { name: "big", type: "bigint" },
    ],
    rows: [
      ["East", 3, "1.25", "9007199254740993"],
      ["West", 5, "2.5", "1"],
      ["East", null, "0.1", "9007199254740993"],
      ["North", 2, null, null],
      [null, 1, "3", "2"],
      ["", 4, "-1.00", "3"],
    ],
  });
}

test("array sources group exactly, with decimal scales, big integers, nulls and empty strings", async () => {
  const result = await orders().group({
    view: null,
    keys: [0],
    aggregates: [
      { fn: "count" },
      { fn: "sum", column: 1 },
      { fn: "sum", column: 2 },
      { fn: "sum", column: 3 },
      { fn: "min", column: 3 },
      { fn: "avg", column: 1 },
    ],
  });
  assert.deepEqual(result.rows, [
    ["East", 2, 3, "1.35", "18014398509481986", "9007199254740993", 3],
    ["North", 1, 2, null, null, null, 2],
    ["West", 1, 5, "2.50", 1, 1, 5],
    ["", 1, 4, "-1.00", 3, 3, 4],
    [null, 1, 1, "3.00", 2, 2, 1],
  ]);
  assert.equal(result.columns[3].sourceType, "DECIMAL(38,2)");
  // Numbers group by value: 1.5 and "1.50" are one group.
  const numbers = new ArraySource({
    columns: [{ name: "n", type: "decimal" }],
    rows: [["1.5"], ["1.50"], [1.5], ["2"]],
  });
  assert.deepEqual((await numbers.group({ view: null, keys: [0], aggregates: [{ fn: "count" }] })).rows, [
    ["1.5", 3],
    ["2", 1],
  ]);
});

test("result names are unique and say what they aggregate", async () => {
  const source = new ArraySource({ columns: ["count(*)", "x"], rows: [[1, 2]] });
  const result = await source.group({
    view: null,
    keys: [0],
    aggregates: [{ fn: "count" }, { fn: "count" }, { fn: "max", column: 1 }],
  });
  assert.deepEqual(
    result.columns.map((column) => column.name),
    ["count(*)", "count(*) (2)", "count(*) (3)", "max(x)"],
  );
});

test("a grouped source shows the groups as a table and sorts truncated results on the base", async () => {
  const base = orders();
  const requests: GroupRequest[] = [];
  const counted = Object.assign(Object.create(base) as ArraySource, {
    group(request: GroupRequest) {
      requests.push(request);
      return base.group(request);
    },
  });
  const grouped = new GroupedSource(counted, {
    keys: [0],
    aggregates: [{ fn: "sum", column: 1 }],
    query: { filters: [{ type: "compare", column: 1, op: "ge", value: 2 }], sort: [{ column: 1, direction: "desc" }] },
    limit: 2,
  });
  const info = await grouped.info();
  assert.equal(info.status, "ready");
  assert.deepEqual(
    info.columns.map((column) => column.name),
    ["region", "sum(qty)"],
  );
  assert.equal(info.rowCount, 2);
  // Truncated: only what works on the returned groups is offered.
  assert.equal(info.capabilities.sort, true);
  assert.equal(info.capabilities.filter, false);
  assert.equal(info.capabilities.export, false);
  assert.equal(grouped.result?.groups, 4);
  const first = await grouped.readRows({ view: null, start: 0, end: 2, columns: [0, 1] });
  assert.deepEqual(first.columns, [
    ["East", "North"],
    [3, 2],
  ]);
  const view = await grouped.createView({ sort: [{ column: 1, direction: "desc" }] });
  const sorted = await grouped.readRows({ view: view.id, start: 0, end: 2, columns: [0, 1] });
  assert.deepEqual(sorted.columns, [
    ["West", ""],
    [5, 4],
  ]);
  assert.deepEqual(requests.at(-1)?.sort, [{ column: 1, direction: "desc" }]);
  assert.notEqual(requests.at(-1)?.view, null);

  // Complete results run filters, totals and exports on the groups themselves.
  const complete = new GroupedSource(base, { keys: [0], aggregates: [{ fn: "count" }] });
  const all = await complete.info();
  assert.equal(all.capabilities.filter, true);
  assert.equal(all.capabilities.group, true);
  const filtered = await complete.createView({ filters: [{ type: "values", column: 0, values: ["East", "West"] }] });
  assert.equal(filtered.rowCount, 2);
  const totals = await complete.group({ view: filtered.id, keys: [], aggregates: [{ fn: "sum", column: 1 }] });
  assert.deepEqual(totals.rows, [[3]]);
});

test("a grouped source reports errors as its status and follows changes of the base", async () => {
  const base = orders();
  const failing = new GroupedSource(base, { keys: [0], aggregates: [{ fn: "sum", column: 0 }] });
  const info = await failing.info();
  assert.equal(info.status, "error");
  await assert.rejects(failing.load(), { code: "invalid_request" });

  let listener: TableChangeListener | null = null;
  const watched = Object.assign(Object.create(base) as ArraySource, {
    subscribe(next: TableChangeListener) {
      listener = next;
      return () => undefined;
    },
  });
  const grouped = new GroupedSource(watched, { keys: [], aggregates: [{ fn: "count" }] });
  const before = await grouped.info();
  const changes: unknown[] = [];
  grouped.subscribe((change) => changes.push(change));
  (listener as TableChangeListener | null)?.({});
  assert.equal(changes.length, 1);
  assert.equal(grouped.result, null);
  const after = await grouped.info();
  assert.notEqual(after.revision, before.revision);
});

test("grid states keep the grouping and the totals of columns", () => {
  const state = parseGridState({
    version: 1,
    columns: [
      { name: "qty", total: "sum" },
      { name: "price", total: "median" },
    ],
    group: {
      keys: ["region"],
      aggregates: [{ fn: "sum", column: "qty" }, { fn: "count" }, { fn: "avg" }, { fn: "nope", column: "x" }],
      state: {
        version: 1,
        query: { sort: [{ column: 1, direction: "desc" }] },
        group: { keys: ["x"], aggregates: [] },
      },
    },
  });
  assert.deepEqual(state?.columns, [{ name: "qty", total: "sum" }, { name: "price" }]);
  assert.deepEqual(state?.group, {
    keys: ["region"],
    aggregates: [{ fn: "sum", column: "qty" }, { fn: "count" }],
    state: { version: 1, query: { sort: [{ column: 1, direction: "desc" }] } },
  });
  assert.equal(parseGridState({ version: 1, group: null })?.group, null);
  assert.equal(parseGridState({ version: 1, group: { keys: [], aggregates: [] } })?.group, undefined);
});

test("cross tabulations name their columns by values and keep them in the state", async () => {
  const source = new ArraySource({
    columns: [
      { name: "region", type: "string" },
      { name: "year", type: "integer" },
      { name: "amount", type: "integer" },
    ],
    rows: [
      ["East", 2024, 1],
      ["East", 2023, 2],
      ["West", 2024, 3],
      ["West", null, 4],
      ["East", 2024, 5],
    ],
  });
  const result = await source.group({
    view: null,
    keys: [0],
    aggregates: [{ fn: "sum", column: 2 }],
    pivot: { columns: [1] },
    sort: [{ column: 2, direction: "desc" }],
  });
  assert.deepEqual(
    result.columns.map((column) => column.name),
    ["region", "2023 / sum(amount)", "2024 / sum(amount)", "(null) / sum(amount)"],
  );
  assert.deepEqual(result.rows, [
    ["East", 2, 6, null],
    ["West", null, 3, 4],
  ]);
  assert.deepEqual(
    result.pivot?.map((column) => [column.column, column.values]),
    [
      [1, [2023]],
      [2, [2024]],
      [3, [null]],
    ],
  );
  // Refused once the column-axis values make too many columns, not cut.
  await assert.rejects(
    source.group({ view: null, keys: [0], aggregates: [{ fn: "count" }], pivot: { columns: [1], maxColumns: 2 } }),
    { code: "too_many_columns" },
  );
  const state = parseGridState({
    version: 1,
    group: { keys: ["region"], aggregates: [{ fn: "sum", column: "amount" }], pivot: ["year"] },
  });
  assert.deepEqual(state?.group?.pivot, ["year"]);
  assert.equal(
    parseGridState({ version: 1, group: { keys: ["region"], aggregates: [], pivot: ["year"] } })?.group,
    undefined,
  );
});

test("a grouped source groups the formula columns of its query", async () => {
  const grouped = new GroupedSource(orders(), {
    query: {
      formulas: [{ name: "double", expression: "qty * 2" }],
      filters: [{ type: "compare", column: 4, op: "ge", value: 4 }],
    },
    keys: [0],
    aggregates: [{ fn: "sum", column: 4 }],
  });
  const info = await grouped.info();
  assert.equal(info.status, "ready", info.error);
  assert.deepEqual(
    info.columns.map((column) => column.name),
    ["region", "sum(double)"],
  );
  assert.deepEqual((await grouped.readRows({ view: null, start: 0, end: 4, columns: [0, 1] })).columns, [
    ["East", "North", "West", ""],
    [6, 4, 10, 8],
  ]);
});

test("states keep formulas, grouping, totals and both frozen sides together", () => {
  const value = {
    version: 1,
    schema: ["region", "qty", "double"],
    formulas: [{ name: "double", expression: "qty * 2" }],
    query: { sort: [{ column: 2, direction: "desc" }] },
    columns: [{ name: "double", total: "sum" }, { name: "region" }],
    frozenColumns: 1,
    frozenRightColumns: 1,
    group: {
      keys: ["region"],
      aggregates: [{ fn: "sum", column: "double" }],
      pivot: ["qty"],
      state: { version: 1, frozenRightColumns: 2, columns: [{ name: "region", width: 90 }] },
    },
  };
  const state = parseGridState(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(state, value);
  // A state saved before grouping, formulas and right freezing still reads.
  assert.deepEqual(parseGridState({ version: 1, frozenColumns: 2 }), { version: 1, frozenColumns: 2 });
});

test("a grouped source reads its groups again on reload, and for a new revision of the base", async () => {
  let current = new ArraySource({ columns: ["k"], rows: [["a"], ["b"]] });
  let revision: string | undefined;
  // A base without `subscribe`: it changes without telling.
  const base: TableSource = {
    info: async () => ({ ...(await current.info()), ...(revision ? { revision } : {}) }),
    createView: (query) => current.createView(query),
    readRows: (request) => current.readRows(request),
    group: (request) => current.group(request),
  };
  const grouped = new GroupedSource(base, { keys: [0], aggregates: [{ fn: "count" }] });
  const first = await grouped.info();
  assert.equal(first.rowCount, 2);
  current = new ArraySource({ columns: ["k"], rows: [["a"], ["b"], ["c"]] });
  assert.equal((await grouped.info()).rowCount, 2, "nothing says the table changed");
  grouped.reload();
  const reloaded = await grouped.info();
  assert.equal(reloaded.rowCount, 3);
  assert.notEqual(reloaded.revision, first.revision);
  current = new ArraySource({ columns: ["k"], rows: [["a"]] });
  revision = "2";
  assert.equal((await grouped.info()).rowCount, 1, "a new revision is grouped again");
});
