/**
 * Plans that derive, filter and search (docs/spec.md §3, §4.1, §4.4) beyond the conformance corpus: views
 * whose rows are a part of the table, read, sorted, summarized and located, and values that JavaScript
 * compares or maps otherwise than the specification.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "vastgrid-spec";
import type { MemoryTable } from "../src/index.ts";
import { Client, random, single } from "./client.ts";

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

const TOTAL = {
  name: "total",
  expr: { fn: "mul", args: [{ col: "qty" }, { col: "price" }] },
};
const OVER_5 = { fn: "gt", args: [{ col: "total" }, { lit: "5", type: "decimal" }] };

test("a view derives, filters and sorts by a derived column, and reads it as its type", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const plan = { derive: [TOTAL], where: OVER_5, sort: [{ column: "total", direction: "desc" }] };
  const read = await client.rows(info, plan, { columns: ["id", "total"] });
  assert.equal(read.view.rowCount, 4);
  assert.deepEqual(read.view.columns.at(-1), { name: "total", type: "decimal", precision: 20, scale: 2 });
  assert.deepEqual(read.rowIds, [3, 0, 1, 4]);
  assert.deepEqual(read.rows, [
    [4, "500.00"],
    [1, "37.50"],
    [2, "8.00"],
    [5, "6.50"],
  ]);
});

test("a search matches the text form of the table's own columns, ignoring letter case (§3.5)", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const ids = async (plan: unknown) => (await client.rows(info, plan, { columns: ["id"] })).rowIds;
  assert.deepEqual(await ids({ where: { search: "TOKYO" } }), [0, 2]);
  assert.deepEqual(await ids({ where: { search: "12.5" } }), [0]);
  assert.deepEqual(await ids({ where: { search: "0.1" } }), [5]);
  // Derived columns are not searched.
  assert.deepEqual(await ids({ derive: [TOTAL], where: { search: "37.50" } }), []);
  const both = { fn: "and", args: [{ search: "osaka" }, { fn: "gt", args: [{ col: "qty" }, { lit: 2 }] }] };
  assert.deepEqual(await ids({ where: both }), [5]);
});

test("locate and summarize work on the rows that a view keeps", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const plan = { derive: [TOTAL], where: OVER_5, sort: [{ column: "total", direction: "asc" }] };
  const at = { table: info.table, revision: info.revision, plan };
  const located = (await client.result("locate", {
    ...at,
    keys: [{ rowId: 0 }, { rowId: 2 }, { rowId: 3 }, { rowId: 9 }, { value: "Osaka" }, { value: "tokyo bay" }],
    rowKey: "region",
  })) as { rows: (number | null)[] };
  // Ascending: rows 4, 1, 0 and 3; row 2 (no quantity) is left out.
  assert.deepEqual(located.rows, [2, null, 3, null, 1, null]);
  const summary = (await client.result("summarize", { ...at, ranges: [[0, 4]], columns: ["total"] })) as {
    count: number;
    sum: JsonValue;
  };
  assert.deepEqual([summary.count, summary.sum], [4, 552]);
});

test("conditions see the values that writes have written", async () => {
  const client = new Client({ orders: ORDERS });
  const info = await client.open("orders");
  const plan = { where: { fn: "eq", args: [{ col: "region" }, { lit: "Kyoto" }] } };
  assert.deepEqual((await client.rows(info, plan, { columns: ["id"] })).rowIds, []);
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 4 }, column: "region", value: "Kyoto" }],
  });
  assert.deepEqual((await client.rows(info, plan, { columns: ["id"] })).rowIds, [4]);
  assert.equal(ORDERS.rows[4][1], "Nagoya");
});

test("lower and upper map each code point by itself, and strings compare by code points (§3.1, §3.4)", async () => {
  const client = new Client({ words: single({ type: "string" }, ["İ", "ΣΑΣ", "ß", "ᾳ", "ﬀ", "｡", "😀", null]) });
  const info = await client.open("words");
  const plan = {
    derive: [
      { name: "lower", expr: { fn: "lower", args: [{ col: "x" }] } },
      { name: "upper", expr: { fn: "upper", args: [{ col: "x" }] } },
      { name: "length", expr: { fn: "length", args: [{ col: "x" }] } },
      { name: "after", expr: { fn: "gt", args: [{ col: "x" }, { lit: "｡" }] } },
    ],
  };
  const read = await client.rows(info, plan, { columns: ["lower", "upper", "length", "after"] });
  assert.deepEqual(read.rows, [
    ["i", "İ", 1, false],
    ["σασ", "ΣΑΣ", 3, false],
    ["ß", "ẞ", 1, false],
    ["ᾳ", "ᾼ", 1, false],
    ["ﬀ", "ﬀ", 1, false],
    ["｡", "｡", 1, false],
    ["😀", "😀", 1, true],
    [null, null, null, null],
  ]);
});

test("values of every comparable type compare as §3.1 says", async () => {
  const table: MemoryTable = {
    columns: [
      { name: "d", type: "date" },
      { name: "t", type: "timestamp", unit: "ns" },
      { name: "i", type: "interval" },
      { name: "b", type: "binary" },
      { name: "f", type: "float" },
    ],
    rows: [
      ["2024-01-31", "2024-01-31 00:00:00", "1 month", "AQ==", "NaN"],
      ["2024-02-01", "2024-01-31 00:00:00.000000001", "29 days", "/w==", 0],
    ],
  };
  const client = new Client({ table });
  const info = await client.open("table");
  const derive = (name: string, fn: string, args: unknown[]) => ({ name, expr: { fn, args } });
  const plan = {
    derive: [
      derive("dt", "eq", [{ col: "d" }, { col: "t" }]),
      derive("month", "eq", [{ col: "i" }, { lit: "30 days", type: "interval" }]),
      derive("bytes", "lt", [{ col: "b" }, { lit: "gA==", type: "binary" }]),
      derive("nan", "gt", [{ col: "f" }, { lit: "Infinity", type: "float" }]),
      derive("zero", "eq", [{ col: "f" }, { lit: "-0.0", type: "decimal" }]),
      derive("later", "greatest", [{ col: "d" }, { col: "t" }]),
    ],
  };
  const read = await client.rows(info, plan, { columns: ["dt", "month", "bytes", "nan", "zero", "later"] });
  assert.deepEqual(read.rows, [
    [true, true, true, true, false, "2024-01-31 00:00:00"],
    [false, false, false, false, true, "2024-02-01 00:00:00"],
  ]);
});

test("1,000,000 rows derive, filter and sort within 3 seconds", async (t) => {
  const next = random(43);
  const rows: JsonValue[][] = Array.from({ length: 1_000_000 }, (_, row) => [
    row % 1_000 === 0 ? null : Math.floor(next() * 1_000),
    (next() * 100).toFixed(2),
  ]);
  const client = new Client({
    big: {
      columns: [
        { name: "qty", type: "integer" },
        { name: "price", type: "decimal", precision: 6, scale: 2 },
      ],
      rows,
    },
  });
  const info = await client.open("big");
  const plan = {
    derive: [TOTAL],
    where: { fn: "gt", args: [{ col: "total" }, { lit: "50000", type: "decimal" }] },
    sort: [{ column: "total", direction: "desc" }],
  };
  const start = performance.now();
  const read = await client.rows(info, plan, { start: 0, end: 3, columns: ["total"] });
  const time = performance.now() - start;
  t.diagnostic(`derive, filter and sort ${time.toFixed(0)} ms, ${read.view.rowCount} rows kept`);
  assert.ok(time < 3000, `${time.toFixed(0)} ms`);
  const totals = rows
    .filter(([qty]) => qty !== null)
    .map(([qty, price]) => (qty as number) * Number(price))
    .filter((total) => total > 50_000)
    .sort((a, b) => b - a);
  assert.equal(read.view.rowCount, totals.length);
  assert.deepEqual(
    read.rows.map(([total]) => Number(total)),
    totals.slice(0, 3),
  );
});
