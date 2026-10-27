/**
 * Views of groups (docs/v2-spec.md §3.8, §3.9, §4.5, §4.6) beyond the conformance corpus: reading, locating and
 * summarizing groups, the names of a pivot's columns, sums beyond their type, writes, and a million rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "vastgrid-spec";
import type { MemoryTable } from "../src/index.ts";
import { Client, random } from "./client.ts";

const ORDERS: MemoryTable = {
  columns: [
    { name: "id", type: "bigint" },
    { name: "region", type: "string" },
    { name: "qty", type: "integer" },
    { name: "price", type: "decimal", precision: 10, scale: 2 },
  ],
  rows: [
    [1, "Tokyo", 3, "12.50"],
    [2, "Osaka", 1, "8.00"],
    [3, "tokyo bay", null, null],
    [4, "", 5, "100.00"],
    [5, "Nagoya", 2, "3.25"],
    [6, "Osaka", 7, "0.10"],
  ],
  editable: true,
};

const BY_REGION = {
  aggregate: {
    keys: ["region"],
    measures: [
      { name: "n", fn: "count" },
      { name: "s", fn: "sum", column: "price" },
    ],
  },
  sort: [{ column: "n", direction: "desc" }],
};

test("groups have no row IDs; locate finds their keys and summarize reads their columns", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const read = await client.rows(info, BY_REGION, { columns: ["region", "n", "s"] });
  assert.equal(read.rowIds, null);
  assert.deepEqual(read.view.columns, [
    { name: "region", type: "string" },
    { name: "n", type: "bigint" },
    { name: "s", type: "decimal", precision: 38, scale: 2 },
  ]);
  // Osaka has two rows; the ties stay in the order of their keys, the empty string last (§3.9).
  assert.deepEqual(read.rows, [
    ["Osaka", 2, "8.10"],
    ["Nagoya", 1, "3.25"],
    ["Tokyo", 1, "12.50"],
    ["tokyo bay", 1, null],
    ["", 1, "100.00"],
  ]);
  const at = { table: info.table, revision: info.revision, plan: BY_REGION };
  const locate = async (keys: unknown[], rowKey: string) =>
    ((await client.result("locate", { ...at, keys, rowKey })) as { rows: unknown[] }).rows;
  assert.deepEqual(await locate([{ value: "Tokyo" }, { value: "" }, { value: "Kyoto" }, { rowId: 0 }], "region"), [
    2,
    4,
    null,
    null,
  ]);
  // A column of the table that the view does not have finds nothing.
  assert.deepEqual(await locate([{ value: 3 }], "qty"), [null]);
  const summary = (await client.result("summarize", { ...at, ranges: [[0, 2]], columns: ["s", "s"] })) as {
    count: number;
    sum: JsonValue;
  };
  assert.deepEqual([summary.count, summary.sum], [2, 11.35]);
  assert.equal((await client.error("rows", { ...at, start: 0, end: 1, columns: ["qty"] })).code, "invalid_request");
});

test("a pivot's columns are named by their values and measure, and a name taken gets (2) (§4.6)", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const plan = {
    derive: [{ name: "Osaka / n", expr: { lit: "all" } }],
    aggregate: { keys: ["Osaka / n"], measures: [{ name: "n", fn: "count" }], pivot: { columns: ["region"] } },
    having: { fn: "eq", args: [{ col: "Osaka / n" }, { lit: "all" }] },
    sort: [{ column: "Osaka / n", direction: "desc" }],
  };
  const read = await client.rows(info, plan, { columns: [] });
  assert.deepEqual(read.view.columns, [
    { name: "Osaka / n", type: "string" },
    { name: "Nagoya / n", type: "bigint", pivot: { values: ["Nagoya"], measure: "n" } },
    { name: "Osaka / n (2)", type: "bigint", pivot: { values: ["Osaka"], measure: "n" } },
    { name: "Tokyo / n", type: "bigint", pivot: { values: ["Tokyo"], measure: "n" } },
    { name: "tokyo bay / n", type: "bigint", pivot: { values: ["tokyo bay"], measure: "n" } },
    { name: "(empty) / n", type: "bigint", pivot: { values: [""], measure: "n" } },
  ]);
  const names = read.view.columns.map((column) => column.name);
  assert.deepEqual((await client.rows(info, plan, { columns: names })).rows, [["all", 1, 2, 1, 1, 1]]);
});

test("a sum that does not fit decimal(38, s) is null, and averages come from the exact sum (§3.8)", async () => {
  const nines = "9".repeat(37);
  const client = new Client({
    big: {
      columns: [{ name: "d", type: "decimal", precision: 38, scale: 1 }],
      rows: [[`${nines}.0`], [`${nines}.0`], ["-0.5"]],
    },
  });
  const info = await client.open("big");
  const plan = {
    aggregate: {
      keys: [],
      measures: [
        { name: "s", fn: "sum", column: "d" },
        { name: "a", fn: "avg", column: "d" },
      ],
    },
  };
  const read = await client.rows(info, plan, { columns: ["s", "a"] });
  assert.deepEqual(read.rows, [[null, (2 * Number(nines) - 0.5) / 3]]);
});

test("groups see the values that writes have written", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const plan = { aggregate: { keys: [], measures: [{ name: "q", fn: "sum", column: "qty" }] } };
  assert.deepEqual((await client.rows(info, plan, { columns: ["q"] })).rows, [["18"]]);
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 2 }, column: "qty", value: 100 }],
  });
  assert.deepEqual((await client.rows(info, plan, { columns: ["q"] })).rows, [["118"]]);
});

test("1,000,000 rows group by 1,000 keys with their measures within 3 seconds", async (t) => {
  const next = random(44);
  const rows: JsonValue[][] = Array.from({ length: 1_000_000 }, () => [
    Math.floor(next() * 1_000),
    (next() * 100).toFixed(2),
  ]);
  const client = new Client({
    big: {
      columns: [
        { name: "key", type: "integer" },
        { name: "price", type: "decimal", precision: 6, scale: 2 },
      ],
      rows,
    },
  });
  const info = await client.open("big");
  const plan = {
    aggregate: {
      keys: ["key"],
      measures: [
        { name: "n", fn: "count" },
        { name: "s", fn: "sum", column: "price" },
        { name: "a", fn: "avg", column: "price" },
        { name: "d", fn: "count_distinct", column: "price" },
      ],
    },
    sort: [{ column: "s", direction: "desc" }],
  };
  const start = performance.now();
  const read = await client.rows(info, plan, { start: 0, end: 1, columns: ["key", "n", "s"] });
  const time = performance.now() - start;
  t.diagnostic(`group and sort ${time.toFixed(0)} ms`);
  assert.ok(time < 3000, `${time.toFixed(0)} ms`);
  assert.equal(read.view.rowCount, 1_000);
  const sums = new Map<number, number>();
  for (const [key, price] of rows) {
    sums.set(key as number, (sums.get(key as number) ?? 0) + Math.round(Number(price) * 100));
  }
  const [key, cents] = [...sums].sort((a, b) => b[1] - a[1])[0];
  assert.deepEqual(read.rows[0][0], key);
  assert.equal(read.rows[0][2], (cents / 100).toFixed(2));
});
