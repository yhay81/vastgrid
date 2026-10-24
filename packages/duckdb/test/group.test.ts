import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  ArraySource,
  type CellValue,
  type GroupRequest,
  type GroupResult,
  MAX_TEXT_LIMIT,
  parseProtocolRequest,
  type ViewQuery,
} from "vastgrid-core";
import { type OpenTable, TableEngine } from "../src/engine.ts";
import { createTableHandler } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-group-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function parquet(name: string, select: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = path.join(workspace, name).replaceAll("'", "''");
    await connection.run(`COPY (${select}) TO '${file}' (FORMAT parquet)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const table = await engine.open(path.join(workspace, name));
  await table.whenReady();
  return table;
}

/** The same rows in an `ArraySource`, read through the engine so that both hold the same values. */
async function mirror(table: OpenTable) {
  const info = table.info();
  const rows = info.rowCount ?? 0;
  const block = await table.readRows({
    view: null,
    start: 0,
    end: rows,
    columns: info.columns.map((_, index) => index),
    textLimit: MAX_TEXT_LIMIT,
  });
  return new ArraySource({ columns: info.columns, columnData: block.columns });
}

const sales = `
  SELECT * FROM (VALUES
    ('East', 'A', 3, 9007199254740993::BIGINT, '1.25'::DECIMAL(10,2), 0.5::DOUBLE, DATE '2024-01-03', true),
    ('East', 'B', 5, 9007199254740993::BIGINT, '2.50'::DECIMAL(10,2), 1.5::DOUBLE, DATE '2024-02-01', false),
    ('West', 'A', NULL, 1::BIGINT, '-0.75'::DECIMAL(10,2), 'NaN'::DOUBLE, DATE '2023-12-31', true),
    ('West', 'A', 7, 2::BIGINT, NULL, 2.0::DOUBLE, NULL, NULL),
    (NULL, 'B', 1, 3::BIGINT, '10.00'::DECIMAL(10,2), 'Infinity'::DOUBLE, DATE '2024-03-05', false),
    ('', 'C', 2, NULL, '0.10'::DECIMAL(10,2), NULL, DATE '2024-01-01', true),
    ('North', 'C', 4, 4::BIGINT, '3.00'::DECIMAL(10,2), 4.25::DOUBLE, DATE '2024-05-05', true)
  ) t(region, cat, qty, big, price, ratio, day, flag)
`;

/** Results of both sources, with averages compared to 12 significant digits (sums run in other orders). */
function comparable(result: GroupResult) {
  return {
    ...result,
    columns: result.columns.map((column) => ({ name: column.name, type: column.type })),
    rows: result.rows.map((row) =>
      row.map((value, index) =>
        result.columns[index].type === "float" && typeof value === "number" ? Number(value.toPrecision(12)) : value,
      ),
    ),
  };
}

async function both(table: OpenTable, array: ArraySource, request: Omit<GroupRequest, "view">, query?: ViewQuery) {
  const engineView = query ? (await table.createView(query)).id : null;
  const arrayView = query ? (await array.createView(query)).id : null;
  const fromEngine = await table.group({ ...request, view: engineView });
  const fromArray = await array.group({ ...request, view: arrayView });
  assert.deepEqual(comparable(fromArray), comparable(fromEngine), JSON.stringify(request));
  return fromEngine;
}

test("grouping gives the same groups, values and types in DuckDB and ArraySource", async () => {
  const table = await parquet("sales.parquet", sales);
  const array = await mirror(table);
  const all = [
    { fn: "count" as const },
    { fn: "count" as const, column: 2 },
    { fn: "sum" as const, column: 2 },
    { fn: "avg" as const, column: 2 },
    { fn: "min" as const, column: 2 },
    { fn: "max" as const, column: 2 },
    { fn: "sum" as const, column: 3 },
    { fn: "max" as const, column: 3 },
    { fn: "sum" as const, column: 4 },
    { fn: "avg" as const, column: 4 },
    { fn: "min" as const, column: 4 },
    { fn: "sum" as const, column: 5 },
    { fn: "max" as const, column: 5 },
    { fn: "min" as const, column: 6 },
    { fn: "max" as const, column: 0 },
    { fn: "min" as const, column: 7 },
  ];
  const byRegion = await both(table, array, { keys: [0], aggregates: all });
  // Blanks go last: '' and null are groups of their own, '' first.
  assert.deepEqual(
    byRegion.rows.map((row) => row[0]),
    ["East", "North", "West", "", null],
  );
  const east = byRegion.rows[0];
  assert.equal(east[1], 2);
  assert.equal(east[3], 8);
  // 64-bit sums stay exact.
  assert.equal(east[7], "18014398509481986");
  assert.equal(east[9], "3.75");
  assert.deepEqual(
    byRegion.columns.map((column) => [column.name, column.type]),
    [
      ["region", "string"],
      ["count(*)", "bigint"],
      ["count(qty)", "bigint"],
      ["sum(qty)", "bigint"],
      ["avg(qty)", "float"],
      ["min(qty)", "integer"],
      ["max(qty)", "integer"],
      ["sum(big)", "bigint"],
      ["max(big)", "bigint"],
      ["sum(price)", "decimal"],
      ["avg(price)", "float"],
      ["min(price)", "decimal"],
      ["sum(ratio)", "float"],
      ["max(ratio)", "float"],
      ["min(day)", "date"],
      ["max(region)", "string"],
      ["min(flag)", "boolean"],
    ],
  );
  // NaN and infinities are left out.
  const west = byRegion.rows[2];
  assert.equal(west[12], 2);
  assert.equal(byRegion.rows[4][12], null);
  assert.equal(byRegion.groups, 5);
  assert.equal(byRegion.truncated, false);

  await both(table, array, { keys: [0, 1], aggregates: [{ fn: "count" }, { fn: "sum", column: 4 }] });
  await both(table, array, {
    keys: [1],
    aggregates: [{ fn: "sum", column: 2 }],
    sort: [{ column: 1, direction: "desc" }],
  });
  await both(table, array, {
    keys: [7, 1],
    aggregates: [{ fn: "max", column: 6 }],
    sort: [{ column: 2, direction: "asc" }],
  });
  await both(table, array, { keys: [2], aggregates: [] });
  const limited = await both(table, array, {
    keys: [0],
    aggregates: [{ fn: "sum", column: 2 }],
    sort: [{ column: 1, direction: "desc" }],
    limit: 2,
  });
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.groups, 5);
  assert.equal(limited.truncated, true);
  assert.deepEqual(
    limited.rows.map((row) => row[0]),
    ["East", "West"],
  );
});

test("totals and groups follow the view's filters, condition tree and search", async () => {
  const table = await parquet("sales-filtered.parquet", sales);
  const array = await mirror(table);
  const aggregates = [{ fn: "count" as const }, { fn: "sum" as const, column: 4 }, { fn: "avg" as const, column: 5 }];
  const totals = await both(table, array, { keys: [], aggregates });
  assert.deepEqual(totals.rows[0].slice(0, 2), [7, "16.10"]);
  const query: ViewQuery = {
    filters: [{ type: "compare", column: 2, op: "ge", value: 2 }],
    where: {
      type: "or",
      filters: [
        { type: "values", column: 1, values: ["A"] },
        { type: "text", column: 0, op: "contains", value: "or" },
      ],
    },
    sort: [{ column: 2, direction: "desc" }],
  };
  const filtered = await both(table, array, { keys: [], aggregates }, query);
  assert.deepEqual(filtered.rows[0].slice(0, 2), [3, "4.25"]);
  await both(table, array, { keys: [1], aggregates }, query);
  await both(table, array, { keys: [0], aggregates }, { search: "a" });
  // Totals of no rows: one row, counts 0 and the rest null.
  const none = await both(
    table,
    array,
    { keys: [], aggregates },
    { filters: [{ type: "compare", column: 2, op: "gt", value: 99 }] },
  );
  assert.deepEqual(none.rows, [[0, null, null]]);
  const noGroups = await both(
    table,
    array,
    { keys: [0], aggregates },
    { filters: [{ type: "compare", column: 2, op: "gt", value: 99 }] },
  );
  assert.deepEqual(noGroups.rows, []);
});

test("grouping refuses columns that do not exist or do not fit the function", async () => {
  const table = await parquet("sales-invalid.parquet", sales);
  const array = await mirror(table);
  for (const request of [
    { view: null, keys: [9], aggregates: [] },
    { view: null, keys: [], aggregates: [{ fn: "sum" as const, column: 0 }] },
    { view: null, keys: [], aggregates: [{ fn: "avg" as const, column: 6 }] },
    { view: null, keys: [], aggregates: [{ fn: "count" as const }], sort: [{ column: 3, direction: "asc" as const }] },
  ]) {
    await assert.rejects(table.group(request), { code: "invalid_request" });
    await assert.rejects(array.group(request), { code: "invalid_request" });
  }
});

test("the protocol carries group requests to the engine", async () => {
  await parquet("sales-protocol.parquet", sales);
  const handler = createTableHandler({ engine, resolve: (ref) => path.join(workspace, ref) });
  const post = async (body: unknown) => {
    const response = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { result: Record<string, unknown> } };
  };
  const info = await post({ op: "info", ref: "sales-protocol.parquet" });
  assert.equal((info.body.result.capabilities as { group?: boolean }).group, true);
  const table = info.body.result.table as string;
  const grouped = await post({ op: "group", table, view: null, keys: [1], aggregates: [{ fn: "sum", column: 2 }] });
  assert.deepEqual(grouped.body.result.rows as CellValue[][], [
    ["A", 10],
    ["B", 6],
    ["C", 6],
  ]);
  const invalid = await post({ op: "group", table, view: null, keys: [], aggregates: [{ fn: "median", column: 2 }] });
  assert.equal(invalid.status, 400);
  assert.throws(() => parseProtocolRequest({ op: "group", table, keys: [], aggregates: [] }));
  assert.throws(() => parseProtocolRequest({ op: "group", table, keys: [1, 1], aggregates: [] }));
  assert.throws(() => parseProtocolRequest({ op: "group", table, keys: [1], aggregates: [], limit: 0 }));
  assert.deepEqual(
    parseProtocolRequest({
      op: "group",
      table,
      view: null,
      keys: [1],
      aggregates: [{ fn: "count", column: null }],
      limit: 5,
    }),
    { op: "group", table, view: null, keys: [1], aggregates: [{ fn: "count" }], limit: 5 },
  );
});
