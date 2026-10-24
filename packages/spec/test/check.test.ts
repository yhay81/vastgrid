import assert from "node:assert/strict";
import { test } from "node:test";
import { arithmeticType, type Column, checkPlan, type Expr, PlanError } from "../src/index.ts";

const columns: Column[] = [
  { name: "qty", type: "integer" },
  { name: "price", type: "decimal", precision: 10, scale: 2 },
  { name: "name", type: "string" },
  { name: "score", type: "float", bits: 32 },
];

function reason(plan: unknown, options?: Parameters<typeof checkPlan>[2]) {
  try {
    checkPlan(plan, columns, options);
  } catch (error) {
    if (error instanceof PlanError) return [error.reason, error.path];
    throw error;
  }
  return null;
}

test("numeric results have the types of §3.7", () => {
  const decimal = (precision: number, scale: number) => ({ type: "decimal" as const, precision, scale });
  assert.deepEqual(arithmeticType("add", { type: "integer" }, { type: "integer" }), { type: "bigint" });
  assert.deepEqual(arithmeticType("add", decimal(10, 2), decimal(5, 3)), decimal(12, 3));
  assert.deepEqual(arithmeticType("mul", decimal(10, 2), decimal(5, 3)), decimal(15, 5));
  assert.deepEqual(arithmeticType("mul", decimal(38, 20), decimal(38, 20)), { type: "float" });
  assert.deepEqual(arithmeticType("add", { type: "bigint" }, decimal(3, 1)), decimal(21, 1));
  assert.deepEqual(arithmeticType("mod", decimal(3, 1), { type: "integer" }), decimal(11, 1));
  assert.deepEqual(arithmeticType("add", decimal(38, 0), decimal(38, 0)), decimal(38, 0));
  assert.deepEqual(arithmeticType("div", { type: "integer" }, { type: "integer" }), { type: "float" });
  assert.deepEqual(arithmeticType("add", { type: "float", bits: 32 }, { type: "integer" }), { type: "float" });
});

test("the view's columns are the table's and the derived ones, or the keys and the measures (§4.2)", () => {
  const plain = checkPlan(
    { derive: [{ name: "total", expr: { fn: "mul", args: [{ col: "qty" }, { col: "price" }] } }] },
    columns,
  );
  assert.deepEqual(
    plain.columns.map((column) => [column.name, column.type]),
    [
      ["qty", "integer"],
      ["price", "decimal"],
      ["name", "string"],
      ["score", "float"],
      ["total", "decimal"],
    ],
  );
  assert.equal(plain.rowIds, true);
  const grouped = checkPlan(
    {
      aggregate: {
        keys: ["name"],
        measures: [
          { name: "low", fn: "min", column: "score" },
          { name: "n", fn: "count" },
        ],
      },
    },
    columns,
  );
  assert.deepEqual(grouped.columns, [
    { name: "name", type: "string" },
    { name: "low", type: "float", bits: 32 },
    { name: "n", type: "bigint" },
  ]);
  assert.equal(grouped.rowIds, false);
});

test("engines that do not offer something refuse it (§4.10)", () => {
  const where = { fn: "contains", args: [{ col: "name" }, { lit: "a" }] };
  assert.deepEqual(reason({ where }, { functions: ["eq"] }), ["unsupported", "/where"]);
  assert.deepEqual(reason({ where: { search: "a" } }, { plan: { search: false } }), ["unsupported", "/where"]);
  assert.deepEqual(reason({ sort: [] }, { plan: { sort: false } }), ["unsupported", "/sort"]);
  assert.deepEqual(
    reason(
      { aggregate: { keys: [], measures: [{ name: "q", fn: "quantile", column: "qty", p: 0.5 }] } },
      { measures: ["count"] },
    ),
    ["unsupported", "/aggregate/measures/0/fn"],
  );
});

test("plans keep within the limits of §4.9", () => {
  const derive = Array.from({ length: 33 }, (_, index) => ({ name: `d${index}`, expr: { lit: index } }));
  assert.deepEqual(reason({ derive }), ["limit", "/derive"]);
  let deep: Expr = { col: "qty" };
  for (let index = 0; index < 64; index++) deep = { fn: "neg", args: [deep] };
  assert.deepEqual(reason({ derive: [{ name: "x", expr: deep }] })?.[0], "limit");
  const wide: Expr = { fn: "and", args: Array.from({ length: 1000 }, () => ({ lit: true })) };
  assert.deepEqual(reason({ where: wide }), ["limit", "/where"]);
  const values = Array.from({ length: 100_001 }, (_, index) => ({ lit: index }));
  assert.deepEqual(reason({ where: { fn: "in", args: [{ col: "qty" }, ...values] } }), ["limit", "/where"]);
  assert.deepEqual(
    reason({
      aggregate: { keys: [], measures: [], pivot: undefined },
      sort: Array(33).fill({ column: "qty", direction: "asc" }),
    }),
    ["limit", "/sort"],
  );
});

test("round's digits and in's values are literals", () => {
  assert.deepEqual(
    reason({ derive: [{ name: "x", expr: { fn: "round", args: [{ col: "price" }, { col: "qty" }] } }] }),
    ["type", "/derive/0/expr/args/1"],
  );
  assert.deepEqual(reason({ derive: [{ name: "x", expr: { fn: "round", args: [{ col: "price" }, { lit: 19 }] } }] }), [
    "type",
    "/derive/0/expr/args/1",
  ]);
  assert.deepEqual(reason({ where: { fn: "in", args: [{ col: "qty" }, { col: "qty" }] } }), ["type", "/where/args/1"]);
  assert.deepEqual(reason({ where: { fn: "in", args: [{ col: "qty" }, { lit: null }] } }), ["type", "/where/args/1"]);
  assert.deepEqual(reason({ where: { fn: "in", args: [{ col: "qty" }, { lit: "1" }] } }), ["type", "/where/args/1"]);
});

test("rounding a decimal keeps at most its scale", () => {
  const plan = checkPlan(
    {
      derive: [
        { name: "a", expr: { fn: "round", args: [{ col: "price" }, { lit: 1 }] } },
        { name: "b", expr: { fn: "round", args: [{ col: "price" }, { lit: 5 }] } },
        { name: "c", expr: { fn: "round", args: [{ col: "price" }, { lit: -2 }] } },
      ],
    },
    columns,
  );
  assert.deepEqual(
    plan.derive.map((item) => [item.column.precision, item.column.scale]),
    [
      [10, 1],
      [10, 2],
      [10, 0],
    ],
  );
});

test("names are 1 to 256 characters, counted in code points", () => {
  assert.equal(reason({ derive: [{ name: "😀".repeat(256), expr: { lit: 1 } }] }), null);
  assert.deepEqual(reason({ derive: [{ name: "a".repeat(257), expr: { lit: 1 } }] }), ["syntax", "/derive/0/name"]);
  assert.deepEqual(reason({ derive: [{ name: "", expr: { lit: 1 } }] }), ["syntax", "/derive/0/name"]);
});
