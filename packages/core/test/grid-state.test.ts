import assert from "node:assert/strict";
import { test } from "node:test";
import { type GridState, parseGridState, resolveGridState } from "../src/grid-state.ts";

test("a state survives JSON and keeps only valid parts", () => {
  const state: GridState = {
    version: 1,
    schema: ["a", "b"],
    query: { sort: [{ column: 1, direction: "desc" }], search: "x" },
    columns: [
      { name: "b", width: 120 },
      { name: "a", hidden: true },
    ],
    frozenColumns: 1,
  };
  assert.deepEqual(parseGridState(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(
    parseGridState({
      version: 1,
      query: { sort: [{ column: -1, direction: "up" }] },
      columns: [{ name: "a", width: -5, hidden: "yes" }, { width: 10 }, "b"],
      frozenColumns: 1.5,
    }),
    { version: 1, columns: [{ name: "a" }] },
  );
});

test("a plain query saved before states existed becomes a state, other values and newer versions do not", () => {
  assert.deepEqual(parseGridState({ filters: [{ type: "blank", column: 0, blank: true }] }), {
    version: 1,
    query: { filters: [{ type: "blank", column: 0, blank: true }] },
  });
  assert.equal(parseGridState(null), null);
  assert.equal(parseGridState("{}"), null);
  assert.equal(parseGridState({ columns: [] }), null);
  assert.equal(parseGridState({ version: 2, columns: [] }), null);
});

test("query columns follow their names onto the table's columns and missing ones are dropped", () => {
  const resolved = resolveGridState(
    {
      version: 1,
      schema: ["name", "age", "removed"],
      query: {
        sort: [
          { column: 1, direction: "asc" },
          { column: 2, direction: "desc" },
        ],
        filters: [{ type: "text", column: 0, op: "contains", value: "a" }],
        search: "x",
      },
    },
    ["age", "name"],
  );
  assert.deepEqual(resolved.query, {
    sort: [{ column: 0, direction: "asc" }],
    filters: [{ type: "text", column: 1, op: "contains", value: "a" }],
    search: "x",
  });
  // Without names (a plain query), indexes are kept where the table has them.
  assert.deepEqual(
    resolveGridState(
      {
        version: 1,
        query: {
          sort: [
            { column: 0, direction: "asc" },
            { column: 5, direction: "asc" },
          ],
        },
      },
      ["a"],
    ).query,
    { sort: [{ column: 0, direction: "asc" }] },
  );
});

test("columns are matched by name, repeated names by occurrence, and frozen columns are not replaced", () => {
  const resolved = resolveGridState(
    {
      version: 1,
      schema: ["x", "x", "gone", "y"],
      columns: [{ name: "gone" }, { name: "x", width: 80 }, { name: "y", hidden: true }, { name: "x" }],
      frozenColumns: 2,
    },
    ["y", "x", "x", "new"],
  );
  assert.deepEqual(resolved.columns, [
    { index: 1, hidden: false, width: 80 },
    { index: 0, hidden: true },
    { index: 2, hidden: false },
  ]);
  // "gone" and the first "x" were frozen; only "x" remains of them.
  assert.equal(resolved.frozenColumns, 1);
  assert.deepEqual(resolveGridState({ version: 1, frozenColumns: 3 }, ["a"]), { frozenColumns: 3 });
});

test("columns frozen at the right are kept by name, and states without them still read", () => {
  assert.deepEqual(parseGridState({ version: 1, frozenColumns: 1, frozenRightColumns: 2 }), {
    version: 1,
    frozenColumns: 1,
    frozenRightColumns: 2,
  });
  assert.deepEqual(parseGridState({ version: 1, frozenRightColumns: -1 }), { version: 1 });
  // A state saved before right freezing existed has only the left part.
  const legacy = resolveGridState(
    { version: 1, columns: [{ name: "a" }, { name: "b" }, { name: "c" }], frozenColumns: 1 },
    ["a", "b", "c"],
  );
  assert.equal(legacy.frozenColumns, 1);
  assert.equal(legacy.frozenRightColumns, undefined);
  const state: GridState = {
    version: 1,
    columns: [{ name: "a" }, { name: "b" }, { name: "total" }, { name: "hidden", hidden: true }, { name: "actions" }],
    frozenColumns: 1,
    frozenRightColumns: 2,
  };
  assert.equal(resolveGridState(state, ["a", "b", "total", "hidden", "actions"]).frozenRightColumns, 2);
  // Frozen columns that the table no longer has are not replaced by the ones before them.
  assert.equal(resolveGridState(state, ["a", "b", "hidden", "actions"]).frozenRightColumns, 1);
  assert.equal(resolveGridState(state, ["a", "b", "total", "hidden"]).frozenRightColumns, 1);
  assert.equal(resolveGridState(state, ["a", "b", "hidden"]).frozenRightColumns, 0);
  assert.deepEqual(resolveGridState({ version: 1, frozenRightColumns: 3 }, ["a"]), { frozenRightColumns: 3 });
});
