import assert from "node:assert/strict";
import { test } from "node:test";
import { type Column, type Expr, joinParts } from "vastgrid-spec";
import {
  type ColumnFilter,
  conditionsOf,
  FilterTextError,
  filterParts,
  readFilter,
  valuesPlan,
} from "../src/core/filters.ts";
import { createGridStore, localTransport } from "../src/core.ts";
import { CAPABILITIES, fakeEngine, settle } from "./fake-engine.ts";

const city: Column = { name: "city", type: "string" };
const qty: Column = { name: "qty", type: "integer" };
const price: Column = { name: "price", type: "decimal", precision: 10, scale: 2 };
const day: Column = { name: "day", type: "date" };

test("values become `in` and `is_blank`, and excluding them keeps the rows where they are null (§6.2.1)", () => {
  assert.deepEqual(filterParts({ kind: "values", values: ["Tokyo", "Kobe"], blank: false, exclude: false }, city), [
    { fn: "in", args: [{ col: "city" }, { lit: "Tokyo" }, { lit: "Kobe" }] },
  ]);
  assert.deepEqual(filterParts({ kind: "values", values: ["Tokyo"], blank: true, exclude: true }, city), [
    {
      fn: "not",
      args: [
        {
          fn: "coalesce",
          args: [
            {
              fn: "or",
              args: [
                { fn: "in", args: [{ col: "city" }, { lit: "Tokyo" }] },
                { fn: "is_blank", args: [{ col: "city" }] },
              ],
            },
            { lit: false },
          ],
        },
      ],
    },
  ]);
  // Nothing ticked keeps no row; nothing excluded keeps every row.
  assert.deepEqual(filterParts({ kind: "values", values: [], blank: false, exclude: false }, city), [{ lit: false }]);
  assert.deepEqual(filterParts({ kind: "values", values: [], blank: false, exclude: true }, city), []);
  // Values that JSON writes as strings carry their type.
  assert.deepEqual(
    filterParts({ kind: "values", values: ["12.50", "2024-01-31"].slice(0, 1), blank: false, exclude: false }, price),
    [{ fn: "in", args: [{ col: "price" }, { lit: "12.50", type: "decimal" }] }],
  );
});

test("conditions read typed text as the column's values (§7.3) and fail on text that is not one", () => {
  const condition = (operator: string, first: string, second = ""): ColumnFilter =>
    ({ kind: "condition", operator, first, second }) as ColumnFilter;
  assert.deepEqual(filterParts(condition("gt", "1,200"), qty), [{ fn: "gt", args: [{ col: "qty" }, { lit: 1200 }] }]);
  assert.deepEqual(filterParts(condition("between", "2024-01-01", ""), day), [
    { fn: "ge", args: [{ col: "day" }, { lit: "2024-01-01", type: "date" }] },
  ]);
  assert.deepEqual(filterParts(condition("le", " 3.5 "), price), [
    { fn: "le", args: [{ col: "price" }, { lit: "3.50", type: "decimal" }] },
  ]);
  // Floats are JSON numbers (§2.2): a whole number is a bigint literal, which compares with them.
  assert.deepEqual(filterParts(condition("gt", "9,000"), { name: "price", type: "float", bits: 64 }), [
    { fn: "gt", args: [{ col: "price" }, { lit: 9000 }] },
  ]);
  assert.throws(() => filterParts(condition("between", "1", "many"), qty), FilterTextError);
  assert.deepEqual(filterParts(condition("eq", ""), qty), []);
  assert.deepEqual(filterParts(condition("contains", "To"), city), [
    {
      fn: "contains",
      args: [
        { fn: "lower", args: [{ fn: "text", args: [{ col: "city" }] }] },
        { fn: "lower", args: [{ lit: "To" }] },
      ],
    },
  ]);
  assert.deepEqual(filterParts(condition("notBlank", ""), city), [
    { fn: "not", args: [{ fn: "is_blank", args: [{ col: "city" }] }] },
  ]);
});

test("what the menu writes reads back as the same filter; other conditions are `other`", () => {
  const filters: [ColumnFilter, Column][] = [
    [{ kind: "values", values: ["Tokyo", "Kobe"], blank: true, exclude: false }, city],
    [{ kind: "values", values: ["Tokyo"], blank: false, exclude: true }, city],
    [{ kind: "values", values: [], blank: false, exclude: false }, city],
    [{ kind: "condition", operator: "between", first: "1", second: "5" }, qty],
    [{ kind: "condition", operator: "notContains", first: "ky", second: "" }, city],
    [{ kind: "condition", operator: "endsWith", first: "be", second: "" }, city],
    [{ kind: "condition", operator: "ne", first: "3", second: "" }, qty],
    [{ kind: "condition", operator: "blank", first: "", second: "" }, city],
    [{ kind: "condition", operator: "notBlank", first: "", second: "" }, city],
  ];
  for (const [filter, column] of filters)
    assert.deepEqual(readFilter(filterParts(filter, column), column.name), filter);
  assert.equal(readFilter([], "city"), null);
  assert.equal(
    readFilter([{ fn: "eq", args: [{ fn: "length", args: [{ col: "city" }] }, { lit: 5 }] }], "city"),
    "other",
  );
});

test("the conditions of a column leave out the search and the parts that use other columns", () => {
  const own: Expr = { fn: "gt", args: [{ col: "qty" }, { lit: 1 }] };
  const both: Expr = { fn: "gt", args: [{ col: "qty" }, { col: "price" }] };
  const where = joinParts([{ search: "qty" }, own, both]);
  assert.deepEqual(conditionsOf(where, "qty"), [own]);
  const made = valuesPlan({ where, sort: [{ column: "qty", direction: "asc" }] }, "qty", "");
  assert.deepEqual(made?.plan.where, { fn: "and", args: [{ search: "qty" }, both] });
  assert.equal(made?.count, "count");
  assert.equal(valuesPlan({}, "count", "")?.count, "count 2");
  assert.equal(valuesPlan({ aggregate: { keys: ["qty"], measures: [] } }, "qty", ""), null);
});

test("the store lists a column's values, the most common first, under the other filters", async () => {
  const engine = fakeEngine(
    {
      columns: [
        { name: "city", type: "string" },
        { name: "qty", type: "integer" },
      ],
      rows: [
        ["Tokyo", 3],
        ["Osaka", 5],
        ["Tokyo", 1],
        [null, 2],
        ["Kobe", 9],
        ["Tokyo", 7],
      ],
    },
    {
      ...CAPABILITIES,
      plan: { ...CAPABILITIES.plan, where: true, aggregate: true },
      functions: ["and", "lt", "in"],
      measures: ["count"],
    },
  );
  const own: Expr = { fn: "in", args: [{ col: "city" }, { lit: "Kobe" }] };
  const other: Expr = { fn: "lt", args: [{ col: "qty" }, { lit: 6 }] };
  const store = createGridStore({
    transport: localTransport(engine),
    table: "cities",
    document: { kind: "vastgrid/document", version: 2, plan: { where: { fn: "and", args: [other, own] } } },
  });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["city", "qty"] });
  for (let attempt = 0; attempt < 200 && store.getSnapshot().view === null; attempt++) await settle(1);
  assert.deepEqual(await store.values("city", { limit: 2 }), {
    values: [
      { value: "Tokyo", count: 3 },
      { value: "Kobe", count: 1 },
    ],
    truncated: true,
  });
  // The list leaves out the column's own conditions, and keeps the others.
  const request = engine.requests.findLast((item) => item.op === "rows");
  assert.deepEqual(request?.plan, {
    where: other,
    aggregate: { keys: ["city"], measures: [{ name: "count", fn: "count" }] },
    sort: [
      { column: "count", direction: "desc" },
      { column: "city", direction: "asc" },
    ],
  });
  assert.equal(request?.end, 3);
  assert.equal((await store.values("city")).values.length, 4);
  disconnect();
});
