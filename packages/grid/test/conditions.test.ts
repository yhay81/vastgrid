import assert from "node:assert/strict";
import { test } from "node:test";
import type { Column, Expr } from "vastgrid-spec";
import { ConditionError, readConditions, writeConditions } from "../src/core/conditions.ts";

const columns: Column[] = [
  { name: "city", type: "string" },
  { name: "qty", type: "integer" },
];

const gt: Expr = { fn: "gt", args: [{ col: "qty" }, { lit: 3 }] };
const range: Expr[] = [
  { fn: "ge", args: [{ col: "qty" }, { lit: 1 }] },
  { fn: "le", args: [{ col: "qty" }, { lit: 5 }] },
];
const tokyo: Expr = {
  fn: "contains",
  args: [
    { fn: "lower", args: [{ fn: "text", args: [{ col: "city" }] }] },
    { fn: "lower", args: [{ lit: "to" }] },
  ],
};
const across: Expr = { fn: "gt", args: [{ col: "qty" }, { fn: "length", args: [{ col: "city" }] }] };

/** A tree without its ids, to compare. */
function shape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (node === null || typeof node !== "object") return node;
  const { id: _id, ...rest } = node as Record<string, unknown>;
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, shape(value)]));
}

test("where reads as a tree of groups, conditions on one column, and expressions kept as they are", () => {
  const where: Expr = {
    fn: "and",
    args: [{ search: "x" }, { fn: "or", args: [gt, { fn: "and", args: range }, tokyo] }, across],
  };
  assert.deepEqual(shape(readConditions(where)), {
    kind: "group",
    op: "and",
    items: [
      {
        kind: "group",
        op: "or",
        items: [
          { kind: "condition", column: "qty", filter: { kind: "condition", operator: "gt", first: "3", second: "" } },
          {
            kind: "condition",
            column: "qty",
            filter: { kind: "condition", operator: "between", first: "1", second: "5" },
          },
          {
            kind: "condition",
            column: "city",
            filter: { kind: "condition", operator: "contains", first: "to", second: "" },
          },
        ],
      },
      { kind: "expression", expr: across },
    ],
  });
  // A where that is one `or` is that group.
  assert.equal(readConditions({ fn: "or", args: [gt, tokyo] }).op, "or");
  assert.deepEqual(readConditions(undefined).items, []);
});

test("a tree writes back to the same where, leaving out conditions without text", () => {
  const where: Expr = { fn: "or", args: [gt, { fn: "and", args: range }, tokyo] };
  assert.deepEqual(writeConditions(readConditions(where), columns), where);
  const tree = readConditions({ fn: "and", args: [gt, across] });
  tree.items.push({
    kind: "condition",
    id: 99,
    column: "city",
    filter: { kind: "condition", operator: "contains", first: "", second: "" },
  });
  assert.deepEqual(writeConditions(tree, columns), { fn: "and", args: [gt, across] });
  assert.equal(writeConditions(readConditions(undefined), columns), null);
});

test("text that is not a value of its column names the condition", () => {
  const tree = readConditions(gt);
  const [node] = tree.items;
  if (node.kind !== "condition") throw new Error("a condition");
  node.filter = { ...node.filter, first: "many" };
  assert.throws(
    () => writeConditions(tree, columns),
    (error: unknown) => error instanceof ConditionError && error.node === node.id && error.side === "first",
  );
});
