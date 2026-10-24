import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { ArraySource, type FilterNode, parseViewQuery, type ViewQuery } from "vastgrid-core";
import { TableEngine } from "../src/engine.ts";
import { createTableHandler } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-filter-tree-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
  });
  await write("typed.parquet");
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Strings with blanks, integers, doubles, decimals, 64-bit integers beyond 2^53, dates, timestamps and booleans. */
const rows = `
  SELECT * FROM (VALUES
    (1, 'Tokyo',  50000.5,  '1.50',  9007199254740993, DATE '2024-01-03', TIMESTAMP '2024-01-03 10:00:00', true,  'open'),
    (2, 'Osaka',  150000,   '-2.25', 9007199254740992, DATE '2024-02-10', TIMESTAMP '2024-02-10 00:00:00', false, 'open'),
    (3, 'Tokyo',  200000,   '0.00',  -5,               DATE '2023-12-31', TIMESTAMP '2023-12-31 23:59:59', true,  'cancelled'),
    (4, 'Nagoya', NULL,     NULL,    NULL,             NULL,              NULL,                            NULL,  'open'),
    (5, NULL,     120000,   '10.10', 9007199254740995, DATE '2024-01-15', TIMESTAMP '2024-01-15 12:30:00', false, NULL),
    (6, '',       5000,     '1.5',   0,                DATE '2024-01-01', TIMESTAMP '2024-01-01 00:00:00', true,  ''),
    (7, 'tokyo',  100000,   '99.99', 42,               DATE '2024-03-01', TIMESTAMP '2024-03-01 08:00:00', NULL,  'Open')
  ) t(id, region, sales, amount, big, day, seen, ok, status)
`;

async function write(name: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = path.join(workspace, name).replaceAll("'", "''");
    await connection.run(
      `COPY (SELECT id::INTEGER AS id, region, sales::DOUBLE AS sales, amount::DECIMAL(10,2) AS amount,
        big::BIGINT AS big, day, seen, ok, status FROM (${rows})) TO '${file}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function table() {
  const opened = await engine.open(path.join(workspace, "typed.parquet"));
  await opened.whenReady();
  return opened;
}

const region = 1;
const sales = 2;
const amount = 3;
const big = 4;
const day = 5;
const at = 6;
const ok = 7;
const status = 8;

/** Trees that mix every filter type with nulls, empty strings and exact numbers, on several columns. */
const trees: FilterNode[] = [
  // (region is Tokyo OR sales > 100,000) AND status is not cancelled
  {
    type: "and",
    filters: [
      {
        type: "or",
        filters: [
          { type: "values", column: region, values: ["Tokyo"] },
          { type: "compare", column: sales, op: "gt", value: 100_000 },
        ],
      },
      { type: "values", column: status, values: ["cancelled"], exclude: true },
    ],
  },
  // Several conditions on one column, and blanks.
  {
    type: "or",
    filters: [
      {
        type: "and",
        filters: [
          { type: "compare", column: sales, op: "ge", value: 50_000 },
          { type: "compare", column: sales, op: "lt", value: 150_000 },
        ],
      },
      { type: "blank", column: region, blank: true },
    ],
  },
  {
    type: "or",
    filters: [
      { type: "values", column: region, values: [""] },
      { type: "values", column: ok, values: [null] },
    ],
  },
  { type: "or", filters: [{ type: "values", column: region, values: [null, "Osaka"], exclude: true }] },
  // Text matches with and without case, and their negations on nulls.
  {
    type: "or",
    filters: [
      { type: "text", column: region, op: "startsWith", value: "TOK" },
      { type: "text", column: status, op: "equals", value: "Open", caseSensitive: true },
    ],
  },
  {
    type: "and",
    filters: [
      { type: "text", column: region, op: "notContains", value: "o" },
      { type: "text", column: status, op: "notEquals", value: "open" },
    ],
  },
  // Decimals and 64-bit integers compare exactly.
  {
    type: "or",
    filters: [
      { type: "compare", column: amount, op: "eq", value: "1.5" },
      { type: "values", column: amount, values: ["10.1"] },
      { type: "between", column: amount, min: "-3", max: "0.001" },
    ],
  },
  {
    type: "and",
    filters: [
      { type: "compare", column: big, op: "gt", value: "9007199254740992" },
      { type: "compare", column: big, op: "ne", value: "9007199254740995" },
    ],
  },
  { type: "or", filters: [{ type: "values", column: big, values: ["9007199254740992", 42] }] },
  // Dates and timestamps.
  {
    type: "or",
    filters: [
      { type: "between", column: day, min: "2024-01-01", max: "2024-01-31" },
      { type: "compare", column: at, op: "ge", value: "2024-03-01 00:00:00" },
    ],
  },
  {
    type: "and",
    filters: [
      { type: "compare", column: day, op: "lt", value: "2024-02-01" },
      { type: "blank", column: at, blank: false },
      { type: "values", column: ok, values: [true] },
    ],
  },
  // Three levels.
  {
    type: "and",
    filters: [
      { type: "blank", column: status, blank: false },
      {
        type: "or",
        filters: [
          {
            type: "and",
            filters: [
              { type: "values", column: ok, values: [false] },
              { type: "compare", column: sales, op: "le", value: 150_000 },
            ],
          },
          { type: "text", column: region, op: "endsWith", value: "yo" },
        ],
      },
    ],
  },
];

async function rowIds(
  source: { createView: ArraySource["createView"]; readRows: ArraySource["readRows"] },
  query: ViewQuery,
) {
  const view = await source.createView(query);
  if (view.id === null) return Array.from({ length: view.rowCount }, (_, index) => index);
  const block = await source.readRows({ view: view.id, start: 0, end: view.rowCount, columns: [] });
  return [...(block.rowIds ?? [])].sort((a, b) => a - b);
}

test("condition trees keep the same rows in DuckDB and in ArraySource", async () => {
  const duck = await table();
  const info = await duck.info();
  assert.equal(info.capabilities.conditions, true);
  const columns = info.columns.map((_, index) => index);
  const all = await duck.readRows({ view: null, start: 0, end: 100, columns });
  const array = new ArraySource({ columns: info.columns, columnData: all.columns });
  const expected = [
    [1, 2, 5],
    [1, 5, 6, 7],
    [4, 6, 7],
    [1, 3, 4, 7],
    [1, 3, 7],
    [5, 6],
    [1, 2, 3, 5, 6],
    [1],
    [2, 7],
    [1, 5, 6, 7],
    [1, 3, 6],
    [1, 2, 3, 7],
  ];
  for (const [index, where] of trees.entries()) {
    // The query goes through validation as it would over HTTP.
    const query = parseViewQuery({ where, sort: [{ column: 0, direction: "asc" }] });
    const fromDuck = await rowIds(duck, query);
    const fromArray = await rowIds(array, query);
    assert.deepEqual(fromDuck, fromArray, `tree ${index}: ${JSON.stringify(where)}`);
    assert.deepEqual(
      fromDuck.map((row) => row + 1),
      expected[index],
      `tree ${index} keeps the expected ids`,
    );
    // The same conditions as `filters` and `where` together.
    if (where.type === "and") {
      const [first, ...rest] = where.filters;
      if (first.type !== "and" && first.type !== "or") {
        const split = parseViewQuery({ filters: [first], where: { type: "and", filters: rest } });
        assert.deepEqual(await rowIds(duck, split), fromDuck, `tree ${index} split`);
      }
    }
  }
});

test("statistics, value lists, summaries and exports use the view of a condition tree", async () => {
  const duck = await table();
  const view = await duck.createView({ where: trees[0] });
  assert.equal(view.rowCount, 3);
  const stats = await duck.columnStats(view.id, sales);
  assert.equal(stats.rows, 3);
  assert.equal(stats.max, 150_000);
  const summary = await duck.aggregate({ view: view.id, ranges: [{ start: 0, end: 3, columns: [sales] }] });
  assert.equal(summary.sum, 50000.5 + 150_000 + 120_000);
  const distinct = await duck.distinctValues({ view: view.id, column: region });
  assert.deepEqual(distinct.values.map((item) => item.value).sort(), ["Osaka", "Tokyo", null].sort());
});

test("the HTTP handler accepts condition trees and refuses ones beyond the limits", async () => {
  const handler = createTableHandler({ engine, resolve: (ref) => path.join(workspace, ref) });
  const post = async (body: unknown) => {
    const response = await handler(
      new Request("http://test/api", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
    return {
      status: response.status,
      json: (await response.json()) as { result?: { table?: string; rowCount?: number }; error?: { code: string } },
    };
  };
  await table();
  const info = await post({ op: "info", ref: "typed.parquet" });
  const handle = info.json.result?.table;
  const created = await post({ op: "view", table: handle, query: { where: trees[0] } });
  assert.equal(created.json.result?.rowCount, 3);
  let deep: FilterNode = { type: "blank", column: 0, blank: true };
  for (let level = 0; level < 9; level++) deep = { type: "and", filters: [deep] };
  const refused = await post({ op: "view", table: handle, query: { where: deep } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error?.code, "invalid_request");
});
