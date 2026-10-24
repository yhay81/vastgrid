import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  mapFilterNode,
  matchesFilterNode,
  pruneFilterNode,
  queryCondition,
  queryFilters,
} from "../src/filter-tree.ts";
import { parseGridState, resolveGridState } from "../src/grid-state.ts";
import { parseProtocolRequest, parseViewQuery } from "../src/protocol.ts";
import { RemoteSource } from "../src/remote-source.ts";
import { filtersRows, isEmptyQuery } from "../src/source.ts";
import type { Filter, FilterNode, ViewQuery } from "../src/types.ts";

function sales() {
  return new ArraySource({
    columns: ["region", "amount", "status"],
    rows: [
      ["Tokyo", 50_000, "open"],
      ["Osaka", 150_000, "open"],
      ["Tokyo", 200_000, "cancelled"],
      ["Nagoya", 20_000, "open"],
      [null, 120_000, "open"],
      ["", 5_000, null],
    ],
  });
}

async function ids(source: ArraySource, query: ViewQuery) {
  const view = await source.createView(query);
  if (view.id === null) return Array.from({ length: view.rowCount }, (_, index) => index);
  return (await source.readRows({ view: view.id, start: 0, end: view.rowCount, columns: [] })).rowIds;
}

const tokyoOrLarge: FilterNode = {
  type: "or",
  filters: [
    { type: "values", column: 0, values: ["Tokyo"] },
    { type: "compare", column: 1, op: "gt", value: 100_000 },
  ],
};
const notCancelled: Filter = { type: "values", column: 2, values: ["cancelled"], exclude: true };

test("a condition tree combines OR across columns with the AND of filters", async () => {
  const source = sales();
  // (region is Tokyo OR amount > 100,000) AND status is not cancelled
  assert.deepEqual(await ids(source, { filters: [notCancelled], where: tokyoOrLarge }), [0, 1, 4]);
  assert.deepEqual(await ids(source, { where: { type: "and", filters: [notCancelled, tokyoOrLarge] } }), [0, 1, 4]);
  // Several conditions on one column, nested two levels.
  const where: FilterNode = {
    type: "or",
    filters: [
      {
        type: "and",
        filters: [
          { type: "compare", column: 1, op: "ge", value: 20_000 },
          { type: "compare", column: 1, op: "lt", value: 100_000 },
        ],
      },
      { type: "blank", column: 0, blank: true },
    ],
  };
  assert.deepEqual(await ids(source, { where }), [0, 3, 4, 5]);
});

test("groups without conditions are left out, also inside other groups", async () => {
  const source = sales();
  assert.equal(pruneFilterNode({ type: "and", filters: [{ type: "or", filters: [] }] }), undefined);
  assert.deepEqual(await ids(source, { where: { type: "or", filters: [] } }), [0, 1, 2, 3, 4, 5]);
  assert.equal(isEmptyQuery({ where: { type: "and", filters: [] } }), true);
  assert.equal(filtersRows({ where: tokyoOrLarge }), true);
  // An empty group under OR does not make the OR hold.
  const where: FilterNode = { type: "or", filters: [{ type: "and", filters: [] }, notCancelled] };
  assert.deepEqual(await ids(source, { where }), [0, 1, 3, 4, 5]);
  assert.equal(
    matchesFilterNode({ type: "or", filters: [{ type: "and", filters: [] }] }, () => false),
    true,
  );
});

test("value lists match empty text and numbers as SQL does", async () => {
  const source = sales();
  // "" is empty text, not a missing value; null matches both.
  assert.deepEqual(await ids(source, { filters: [{ type: "values", column: 0, values: [""] }] }), [5]);
  assert.deepEqual(await ids(source, { filters: [{ type: "values", column: 0, values: [null] }] }), [4, 5]);
  const decimals = new ArraySource({
    columns: [{ name: "price", type: "decimal" }],
    rows: [["1.50"], ["2.00"], [null]],
  });
  assert.deepEqual(await ids(decimals, { filters: [{ type: "values", column: 0, values: ["1.5", 2] }] }), [0, 1]);
});

test("helpers walk, map and combine trees", () => {
  const query: ViewQuery = { filters: [notCancelled], where: tokyoOrLarge };
  assert.deepEqual(
    queryFilters(query).map((filter) => filter.column),
    [2, 0, 1],
  );
  assert.deepEqual(queryCondition(query), { type: "and", filters: [notCancelled, tokyoOrLarge] });
  assert.equal(queryCondition({}), undefined);
  // Mapping drops filters and the groups they leave empty.
  const mapped = mapFilterNode(
    { type: "and", filters: [tokyoOrLarge, { type: "or", filters: [notCancelled] }] },
    (filter) => (filter.column === 2 ? null : { ...filter, column: filter.column + 10 }),
  );
  assert.deepEqual(mapped, {
    type: "and",
    filters: [
      {
        type: "or",
        filters: [
          { type: "values", column: 10, values: ["Tokyo"] },
          { type: "compare", column: 11, op: "gt", value: 100_000 },
        ],
      },
    ],
  });
});

function nested(depth: number): FilterNode {
  let node: FilterNode = { type: "blank", column: 0, blank: true };
  for (let level = 0; level < depth; level++) node = { type: level % 2 ? "and" : "or", filters: [node] };
  return node;
}

test("protocol requests validate condition trees with limits on depth, size and values", () => {
  const request = parseProtocolRequest({
    op: "view",
    table: "t",
    query: { filters: [notCancelled], where: tokyoOrLarge },
  });
  assert.deepEqual(request, {
    op: "view",
    table: "t",
    query: {
      filters: [notCancelled],
      where: {
        type: "or",
        filters: [
          { type: "values", column: 0, values: ["Tokyo"], exclude: false },
          { type: "compare", column: 1, op: "gt", value: 100_000 },
        ],
      },
    },
  });
  // Empty groups are dropped; a tree without conditions leaves no `where`.
  assert.deepEqual(parseViewQuery({ where: { type: "and", filters: [{ type: "or", filters: [] }] } }), {});
  assert.deepEqual(parseViewQuery({ where: null }), {});
  assert.ok(parseViewQuery({ where: nested(MAX_FILTER_DEPTH) }).where);
  assert.throws(() => parseViewQuery({ where: nested(MAX_FILTER_DEPTH + 1) }), /deeper than 8/);
  const many = (count: number) => ({
    type: "and",
    filters: Array.from({ length: count }, () => ({ type: "blank", column: 0 })),
  });
  assert.ok(parseViewQuery({ where: many(MAX_FILTER_NODES - 1) }).where);
  assert.throws(() => parseViewQuery({ where: many(MAX_FILTER_NODES) }), /more than 256/);
  const values = (count: number) => ({ type: "values", column: 0, values: Array.from({ length: count }, (_, i) => i) });
  assert.throws(
    () => parseViewQuery({ where: { type: "or", filters: [values(60_000), values(60_000)] } }),
    /more than 100000 values/,
  );
  for (const where of [
    { type: "xor", filters: [] },
    { type: "and" },
    { type: "and", filters: [{ type: "compare", column: 0, op: "gt" }] },
    { type: "or", filters: [{ type: "blank", column: -1 }] },
    [],
    "a",
  ]) {
    assert.throws(() => parseViewQuery({ where }), /where/, JSON.stringify(where));
  }
});

test("remote sources send condition trees as they are", async () => {
  const bodies: unknown[] = [];
  const source = new RemoteSource({
    endpoint: "http://test/api",
    ref: "t.csv",
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const result =
        body.op === "info"
          ? {
              table: "t1",
              columns: [{ name: "a", type: "string" }],
              rowCount: 3,
              readableRows: 3,
              status: "ready",
              capabilities: { filter: true },
            }
          : { id: "v1", rowCount: 1, query: body.query };
      return new Response(JSON.stringify({ result }), { status: 200 });
    }) as typeof fetch,
  });
  await source.info();
  const query: ViewQuery = { where: tokyoOrLarge };
  await source.createView(query);
  assert.deepEqual((bodies[1] as { query: ViewQuery }).query, query);
  // A tree without conditions asks for nothing.
  const table = await source.createView({ where: { type: "or", filters: [] } });
  assert.equal(table.id, null);
  assert.equal(bodies.filter((body) => (body as { op: string }).op === "view").length, 1);
});

test("saved states keep condition trees and map their columns by name", () => {
  const state = parseGridState(
    JSON.parse(
      JSON.stringify({
        version: 1,
        schema: ["region", "amount", "status"],
        query: { filters: [notCancelled], where: tokyoOrLarge },
      }),
    ),
  );
  assert.ok(state?.query?.where);
  // The table's columns moved, and "region" is gone.
  const resolved = resolveGridState(state, ["status", "amount", "note"]);
  assert.deepEqual(resolved.query, {
    filters: [{ ...notCancelled, column: 0, exclude: true }],
    where: { type: "or", filters: [{ type: "compare", column: 1, op: "gt", value: 100_000 }] },
  });
  // Without any column of the tree left, the tree is dropped.
  assert.deepEqual(resolveGridState(state, ["status"]).query, { filters: [{ ...notCancelled, column: 0 }] });
  // A plain query with a tree, saved before states existed.
  assert.deepEqual(parseGridState({ where: tokyoOrLarge })?.query?.where?.type, "or");
});

test("remote sources recreate a view with its condition tree after the table reopens", async () => {
  const backend = sales();
  let table = "t1";
  const views: ViewQuery[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    // The server validates every request, `revision` included, as a real one does.
    const body = parseProtocolRequest(JSON.parse(String(init.body)));
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    if (body.op === "info") return reply(200, { result: { table, ...(await backend.info()), revision: table } });
    if (body.table !== table) return reply(404, { error: { code: "table_not_found", message: "gone" } });
    if (body.op === "revision") return reply(200, { result: { revision: table } });
    if (body.op === "view") {
      views.push(body.query);
      return reply(200, { result: await backend.createView(body.query) });
    }
    if (body.op === "rows") return reply(200, { result: await backend.readRows(body) });
    return reply(400, { error: { code: "invalid_request", message: "?" } });
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "sales.csv", fetch: fakeFetch, changes: false });
  await source.info();
  const view = await source.createView({ where: tokyoOrLarge });
  assert.equal(view.rowCount, 4);
  // The server reopened the table (for example after the file changed): the view is made again, with the tree.
  table = "t2";
  const rows = await source.readRows({ view: view.id, start: 0, end: 4, columns: [0] });
  assert.deepEqual(rows.columns[0], ["Tokyo", "Osaka", "Tokyo", null]);
  assert.equal(views.length, 2);
  assert.deepEqual(views[1].where, views[0].where);
});
