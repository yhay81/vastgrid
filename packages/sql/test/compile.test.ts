import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { type Column, checkPlan, isValueOf } from "vastgrid-spec";
import { test } from "vite-plus/test";
import { compileView, countQuery, pivotQuery, quoteIdentifier, rowsQuery } from "../src/index.ts";
import { jsonOf, output } from "./duckdb.ts";

const columns: Column[] = [
  { name: 'say "hi"', type: "string" },
  { name: "n", type: "integer" },
];
const source = { relation: quoteIdentifier("t"), rowId: "row_id" };

test("values are parameters and names are quoted, whatever they hold", () => {
  const text = "x'); DROP TABLE t; --";
  const plan = checkPlan(
    {
      derive: [{ name: "a'b", expr: { fn: "concat", args: [{ col: 'say "hi"' }, { lit: text }] } }],
      where: {
        fn: "and",
        args: [{ search: text }, { fn: "gt", args: [{ col: "n" }, { lit: "1.5", type: "decimal" }] }],
      },
      sort: [{ column: "a'b", direction: "desc" }],
    },
    columns,
  );
  const view = compileView(plan, source);
  const query = rowsQuery(view, { start: 0, end: 10, columns: ["a'b"] });
  assert.ok(!query.sql.includes("DROP"), query.sql);
  assert.ok(!query.sql.includes("1.5"), query.sql);
  assert.ok(query.sql.includes('"say ""hi"""'), query.sql);
  assert.ok(query.sql.includes(`"a'b"`), query.sql);
  assert.deepEqual(query.params, [text, text, "1.5"]);
  assert.deepEqual(countQuery(view).params, query.params);
});

test("source parameters come first", () => {
  const plan = checkPlan({ where: { fn: "eq", args: [{ col: "n" }, { lit: 2 }] } }, columns);
  const view = compileView(plan, { relation: "read_csv($1)", rowId: "row_id", params: ["data.csv"] });
  assert.deepEqual(view.params, ["data.csv", "2"]);
  assert.ok(view.with.includes("CAST(CAST($2 AS VARCHAR) AS BIGINT)"), view.with);
});

test("a product of decimals widens its left operand only when the product has more than 18 digits", () => {
  const decimals: Column[] = [
    { name: "d", type: "decimal", precision: 10, scale: 2 },
    { name: "e", type: "decimal", precision: 5, scale: 3 },
    { name: "n", type: "integer" },
  ];
  const product = (left: string, right: string) =>
    compileView(
      checkPlan({ derive: [{ name: "x", expr: { fn: "mul", args: [{ col: left }, { col: right }] } }] }, decimals),
      source,
    ).with;
  // decimal(10, 2) × decimal(5, 3) is decimal(15, 5), which DuckDB multiplies in 64 bits.
  assert.ok(!product("d", "e").includes("DECIMAL(19,"), product("d", "e"));
  // decimal(10, 2) × decimal(10, 2) is decimal(20, 4), and integer × decimal(10, 2) decimal(20, 2).
  assert.ok(product("d", "d").includes('CAST("d" AS DECIMAL(19,2))'), product("d", "d"));
  assert.ok(product("n", "d").includes('CAST("n" AS DECIMAL(19,0))'), product("n", "d"));
});

test("the row ID column takes a name that no column has, ignoring case", () => {
  for (const name of ["vg_row", "VG_ROW"]) {
    const plan = checkPlan({}, [{ name, type: "integer" }]);
    const view = compileView(plan, source);
    assert.equal(view.rowId, '"vg_row_"');
    assert.deepEqual(view.order, ['"vg_row_" ASC']);
  }
});

test("mixed IN keeps exact comparisons and arbitrary column names survive lambda scopes", async () => {
  const columns: Column[] = [
    { name: "vg_w", type: "float" },
    { name: "__proto__", type: "bigint" },
    { name: "constructor", type: "integer" },
  ];
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run(
      'CREATE TABLE t AS SELECT 0 AS row_id, 5.5::DOUBLE AS vg_w, 9007199254740993::BIGINT AS "__proto__", 8 AS constructor',
    );
    const plan = checkPlan(
      {
        derive: [
          { name: "bucket", expr: { fn: "bin", args: [{ col: "vg_w" }, { lit: 2.5 }] } },
          {
            name: "member",
            expr: { fn: "in", args: [{ col: "__proto__" }, { lit: "9007199254740992", type: "bigint" }, { lit: 0.5 }] },
          },
          { name: "unknown", expr: { fn: "in", args: [{ lit: null }, { lit: 3 }, { lit: 0.5 }] } },
        ],
      },
      columns,
    );
    const view = compileView(plan, { ...source, columns: {} });
    const query = rowsQuery(view, {
      start: 0,
      end: 1,
      columns: ["bucket", "member", "unknown", "constructor", "__proto__"],
    });
    assert.deepEqual((await conn.runAndReadAll(query.sql, query.params)).getRowsJS()[0].slice(0, 5), [
      5,
      false,
      null,
      8,
      9007199254740993n,
    ]);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

test("wide decimal pivots emit a single sum per measure and combination", async () => {
  const schema: Column[] = [
    { name: "v", type: "decimal", precision: 38, scale: 20 },
    { name: "k", type: "string" },
  ];
  const plan = checkPlan(
    { aggregate: { keys: [], measures: [{ name: "sum", fn: "sum", column: "v" }], pivot: { columns: ["k"] } } },
    schema,
  );
  const combinations = Array.from({ length: 200 }, (_, i) => [String(i)]);
  const view = compileView(plan, source, combinations);
  assert.equal(view.with.match(/\bsum\(/g)?.length, combinations.length);
  const query = rowsQuery(view, { start: 0, end: 1, columns: view.columns.map((c) => c.name) }, output);
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run(
      "CREATE TABLE t(row_id BIGINT, v DECIMAL(38,20), k VARCHAR); INSERT INTO t VALUES (0, -0.5, '0'), (1, 0.01, '0'), (2, 0.00000000000000000001, '1')",
    );
    const [row] = (await conn.runAndReadAll(query.sql, query.params)).getRowsJS();
    assert.deepEqual(row.slice(0, 2), ["-0.49000000000000000000", "0.00000000000000000001"]);
    assert.ok(row.slice(2).every((value) => value === null));
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

test("reads are ranges of positions", () => {
  const view = compileView(checkPlan({}, columns), source);
  assert.throws(() => rowsQuery(view, { start: 5, end: 2, columns: [] }), RangeError);
  assert.throws(() => rowsQuery(view, { start: 0, end: 1, columns: ["missing"] }), RangeError);
  assert.match(rowsQuery(view, { start: 3, end: 7, columns: ["n"] }).sql, /LIMIT 4 OFFSET 3$/);
});

test("case-colliding derive and pivot columns, BOMs and typed pivot values stay distinct in DuckDB", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run("SET TimeZone = 'UTC'");
    await conn.run(
      `CREATE TABLE t (row_id BIGINT, "a" INTEGER, s VARCHAR, b BLOB, d DATE);
       INSERT INTO t VALUES
         (0, 1, 'foo', from_base64('AAEC'), DATE '-0044-03-15'),
         (1, 10, 'FOO', from_base64('AAEC'), DATE '10000-01-01'),
         (2, 100, chr(65279), from_base64('AAEC'), DATE '10000-01-01')`,
    );
    const schema: Column[] = [
      { name: "a", type: "integer" },
      { name: "s", type: "string" },
      { name: "b", type: "binary" },
      { name: "d", type: "date" },
    ];
    const derivedPlan = checkPlan(
      { derive: [{ name: "A", expr: { lit: 999 } }], sort: [{ column: "A", direction: "asc" }] },
      schema,
    );
    const derivedView = compileView(derivedPlan, source);
    const derivedQuery = rowsQuery(derivedView, { start: 0, end: 3, columns: ["a", "A"] }, output);
    const derivedRows = (await conn.runAndReadAll(derivedQuery.sql, derivedQuery.params)).getRowsJS();
    assert.deepEqual(
      [jsonOf(derivedRows[0][0], derivedView.columns[0]), jsonOf(derivedRows[0][1], derivedView.columns[4])],
      [1, 999],
    );

    const pivotPlan = checkPlan(
      {
        aggregate: {
          keys: [],
          measures: [{ name: "sum_a", fn: "sum", column: "a" }],
          pivot: { columns: ["s", "b", "d"] },
        },
      },
      schema,
    );
    const pq = pivotQuery(pivotPlan, source);
    const marked = pivotPlan.aggregate!.pivot!.columns.map((_, i) => `'.' || "vg_value${i}"`).join(", ");
    const combRows = (await conn.runAndReadAll(`SELECT ${marked} FROM (${pq.sql})`, pq.params)).getRowsJS();
    const combinations = combRows.map((r) => r.map((v) => (v === null ? null : String(v).slice(1))));
    const pivotView = compileView(pivotPlan, source, combinations);
    for (const col of pivotView.columns) {
      assert.ok(col.pivot);
      for (const [idx, val] of col.pivot.values.entries()) {
        assert.equal(isValueOf(val, pivotPlan.aggregate!.pivot!.columns[idx]), true, JSON.stringify(val));
      }
    }
    const pQuery = rowsQuery(pivotView, { start: 0, end: 1, columns: pivotView.columns.map((c) => c.name) }, output);
    const pRow = (await conn.runAndReadAll(pQuery.sql, pQuery.params))
      .getRowsJS()[0]
      .map((v, i) => jsonOf(v, pivotView.columns[i]));
    assert.deepEqual(pRow, ["10", "1", "100"]);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

test("cross-type temporal, wide-decimal and float32 comparisons and wide-decimal sum/avg never fail", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run("SET TimeZone = 'UTC'");
    await conn.run(
      `CREATE TABLE t (
         row_id BIGINT,
         ts_ns TIMESTAMP_NS,
         d DATE,
         ts_us TIMESTAMP,
         dec_whole DECIMAL(38,0),
         dec_frac DECIMAL(38,38),
         dec_mid DECIMAL(38,20),
         f32 FLOAT,
         bi BIGINT
       );
       INSERT INTO t VALUES
         (0, make_timestamp_ns(-9223372036854775806), DATE '1500-01-01', TIMESTAMP '2500-01-01 00:00:00',
          CAST('90000000000000000000000000000000000000' AS DECIMAL(38,0)),
          CAST('0.99999999999999999999999999999999999999' AS DECIMAL(38,38)),
          CAST('999999999999999999.99999999999999999999' AS DECIMAL(38,20)),
          CAST(16777216 AS FLOAT),
          16777217),
         (1, TIMESTAMP_NS '2024-01-01 00:00:00', DATE '2024-01-01', TIMESTAMP '2024-01-01 00:00:00',
          CAST('90000000000000000000000000000000000000' AS DECIMAL(38,0)),
          CAST('0.50000000000000000000000000000000000000' AS DECIMAL(38,38)),
          CAST('999999999999999999.99999999999999999999' AS DECIMAL(38,20)),
          CAST(0.1 AS FLOAT),
          0)`,
    );
    const schema: Column[] = [
      { name: "ts_ns", type: "timestamp", unit: "ns" },
      { name: "d", type: "date" },
      { name: "ts_us", type: "timestamp", unit: "us" },
      { name: "dec_whole", type: "decimal", precision: 38, scale: 0 },
      { name: "dec_frac", type: "decimal", precision: 38, scale: 38 },
      { name: "dec_mid", type: "decimal", precision: 38, scale: 20 },
      { name: "f32", type: "float", bits: 32 },
      { name: "bi", type: "bigint" },
    ];
    const cmpPlan = checkPlan(
      {
        derive: [
          { name: "c1", expr: { fn: "gt", args: [{ col: "ts_ns" }, { col: "d" }] } },
          { name: "c2", expr: { fn: "lt", args: [{ col: "ts_ns" }, { col: "ts_us" }] } },
          { name: "c2_null", expr: { fn: "lt", args: [{ col: "ts_ns" }, { lit: null }] } },
          {
            name: "c3",
            expr: {
              fn: "in",
              args: [
                { col: "ts_ns" },
                { lit: "1500-01-01", type: "date" },
                { lit: "2024-01-01 00:00:00", type: "timestamp" },
              ],
            },
          },
          { name: "c4", expr: { fn: "gt", args: [{ col: "dec_whole" }, { col: "dec_frac" }] } },
          { name: "c4_eq", expr: { fn: "eq", args: [{ col: "dec_whole" }, { col: "dec_mid" }] } },
          { name: "c4_ne", expr: { fn: "ne", args: [{ col: "dec_whole" }, { col: "dec_frac" }] } },
          { name: "c4_lt", expr: { fn: "lt", args: [{ col: "dec_frac" }, { col: "dec_mid" }] } },
          { name: "c4_le", expr: { fn: "le", args: [{ col: "dec_frac" }, { col: "dec_whole" }] } },
          { name: "c4_ge", expr: { fn: "ge", args: [{ col: "dec_mid" }, { col: "dec_frac" }] } },
          { name: "c4_null", expr: { fn: "eq", args: [{ col: "dec_frac" }, { lit: null }] } },
          {
            name: "c4_in",
            expr: {
              fn: "in",
              args: [
                { col: "dec_whole" },
                { lit: "0.50000000000000000000000000000000000000", type: "decimal" },
                { lit: "999999999999999999.99999999999999999999", type: "decimal" },
                { lit: "90000000000000000000000000000000000000", type: "decimal" },
              ],
            },
          },
          { name: "c5", expr: { fn: "eq", args: [{ col: "f32" }, { col: "bi" }] } },
          { name: "c6", expr: { fn: "eq", args: [{ col: "f32" }, { lit: "0.1", type: "decimal" }] } },
          {
            name: "c7",
            expr: { fn: "in", args: [{ col: "f32" }, { lit: 16777217 }, { lit: "0.1", type: "decimal" }] },
          },
          {
            name: "c7_null",
            expr: { fn: "in", args: [{ lit: null }, { lit: 1.5 }] },
          },
          { name: "b", expr: { fn: "bin", args: [{ col: "dec_frac" }, { lit: 1e-7 }] } },
        ],
      },
      schema,
    );
    const cmpView = compileView(cmpPlan, source);
    const cmpCols = [
      "c1",
      "c2",
      "c2_null",
      "c3",
      "c4",
      "c4_eq",
      "c4_ne",
      "c4_lt",
      "c4_le",
      "c4_ge",
      "c4_null",
      "c4_in",
      "c5",
      "c6",
      "c7",
      "c7_null",
    ];
    const cmpQuery = rowsQuery(cmpView, { start: 0, end: 2, columns: cmpCols }, output);
    const cmpRows = (await conn.runAndReadAll(cmpQuery.sql, cmpQuery.params))
      .getRowsJS()
      .map((r) => r.slice(0, cmpCols.length));
    assert.deepEqual(cmpRows, [
      [true, true, null, false, true, false, true, true, true, true, null, true, false, false, false, null],
      [false, false, null, true, true, false, true, true, true, true, null, true, false, false, false, null],
    ]);

    const aggPlan = checkPlan(
      {
        aggregate: {
          keys: [],
          measures: [
            { name: "sw", fn: "sum", column: "dec_whole" },
            { name: "aw", fn: "avg", column: "dec_whole" },
            { name: "sm", fn: "sum", column: "dec_mid" },
            { name: "am", fn: "avg", column: "dec_mid" },
            { name: "sf", fn: "sum", column: "dec_frac" },
            { name: "af", fn: "avg", column: "dec_frac" },
          ],
        },
      },
      schema,
    );
    const aggView = compileView(aggPlan, source);
    const aggNames = aggView.columns.map((c) => c.name);
    const aggQuery = rowsQuery(aggView, { start: 0, end: 1, columns: aggNames }, output);
    const aggRow = (await conn.runAndReadAll(aggQuery.sql, aggQuery.params))
      .getRowsJS()[0]
      .map((v, i) => jsonOf(v, aggView.columns[i]));
    assert.deepEqual(aggRow, [null, 9e37, null, 1e18, null, 0.75]);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

test("add_days preserves timestamp units, coalesce binds params once, float32 pivot matches and deep text stays linear", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run("SET TimeZone = 'UTC'");
    await conn.run(
      `CREATE TABLE t (
         row_id BIGINT,
         ts_ns TIMESTAMP_NS,
         ts_ms TIMESTAMP_MS,
         ts_s TIMESTAMP_S,
         f32 FLOAT,
         bi BIGINT
       );
       INSERT INTO t VALUES
         (0, TIMESTAMP_NS '2024-01-01 00:00:00.123456789', TIMESTAMP_MS '2024-01-01 00:00:00.250', TIMESTAMP_S '2024-01-01 00:00:01', CAST(0.1 AS FLOAT), 10),
         (1, TIMESTAMP_NS '2262-04-11 12:00:00.123456789', TIMESTAMP_MS '2024-01-01 00:00:00.250', TIMESTAMP_S '2024-01-01 00:00:01', CAST(0.1 AS FLOAT), NULL)`,
    );
    const schema: Column[] = [
      { name: "ts_ns", type: "timestamp", unit: "ns" },
      { name: "ts_ms", type: "timestamp", unit: "ms" },
      { name: "ts_s", type: "timestamp", unit: "s" },
      { name: "f32", type: "float", bits: 32 },
      { name: "bi", type: "bigint" },
    ];
    let deep: Record<string, unknown> = { col: "f32" };
    for (let i = 0; i < 6; i++) {
      deep = { fn: "to_number", args: [{ fn: "text", args: [deep] }] };
    }
    const plan = checkPlan(
      {
        derive: [
          { name: "dns", expr: { fn: "add_days", args: [{ col: "ts_ns" }, { lit: 1 }] } },
          { name: "dms", expr: { fn: "add_days", args: [{ col: "ts_ms" }, { lit: 1 }] } },
          { name: "ds", expr: { fn: "add_days", args: [{ col: "ts_s" }, { lit: 1 }] } },
          { name: "co", expr: { fn: "coalesce", args: [{ col: "bi" }, { lit: "12.5", type: "decimal" }] } },
          { name: "ns_ms", expr: { fn: "lt", args: [{ col: "ts_ns" }, { col: "ts_ms" }] } },
          { name: "ns_s", expr: { fn: "lt", args: [{ col: "ts_ns" }, { col: "ts_s" }] } },
          { name: "dp", expr: deep as never },
        ],
      },
      schema,
    );
    const view = compileView(plan, source);
    assert.ok(view.with.length < 8000, `SQL grew too large: ${view.with.length}`);
    assert.deepEqual(view.params, ["1", "1", "1", "12.5"]);
    const cols = ["dns", "dms", "ds", "co", "ns_ms", "ns_s"];
    const query = rowsQuery(view, { start: 0, end: 2, columns: cols }, output);
    const rows = (await conn.runAndReadAll(query.sql, query.params))
      .getRowsJS()
      .map((r) => cols.map((_, idx) => jsonOf(r[idx], view.columns[5 + idx])));
    assert.deepEqual(rows, [
      ["2024-01-02 00:00:00.123456789", "2024-01-02 00:00:00.25", "2024-01-02 00:00:01", "10.0", true, true],
      [null, "2024-01-02 00:00:00.25", "2024-01-02 00:00:01", "12.5", false, false],
    ]);

    const pivotPlan = checkPlan(
      { aggregate: { keys: [], measures: [{ name: "c", fn: "count" }], pivot: { columns: ["f32"] } } },
      schema,
    );
    const pq = pivotQuery(pivotPlan, source);
    const comb = (await conn.runAndReadAll(pq.sql, pq.params))
      .getRowsJS()
      .map((r) => r.map((v) => (v === null ? null : String(v))));
    const pView = compileView(pivotPlan, source, comb);
    const pQuery = rowsQuery(pView, { start: 0, end: 1, columns: pView.columns.map((c) => c.name) }, output);
    const pRows = (await conn.runAndReadAll(pQuery.sql, pQuery.params)).getRowsJS();
    assert.equal(Number(pRows[0][0]), 2);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});
