import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  ArraySource,
  type CellValue,
  compileFormulas,
  type FormulaColumn,
  parseViewQuery,
  type TableSource,
  type ViewQuery,
} from "vastgrid-core";
import { TableEngine } from "../src/engine.ts";
import { formulaSelect } from "../src/formula.ts";
import { createTableHandler } from "../src/handler.ts";
import type { SqlColumn } from "../src/sql.ts";

let root: string;
let workspace: string;
let engine: TableEngine;
/** The same engine, but views of more than 3 rows keep only positions and sorts answer with a preview. */
let positions: TableEngine;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-formula-"));
  workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const options = { allowedDirectories: [workspace], memoryLimit: "1GB", threads: 2 };
  engine = await TableEngine.create({ ...options, tempDirectory: path.join(root, "temp") });
  positions = await TableEngine.create({
    ...options,
    tempDirectory: path.join(root, "temp2"),
    materializeRows: 3,
    viewPreviewMinRows: 1,
    viewPreviewRows: 2,
  });
  await write("typed.parquet");
});

after(async () => {
  await engine.dispose();
  await positions.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Integers, doubles (with NaN and infinity), decimals, 64-bit integers, text, dates, timestamps and booleans. */
const rows = `
  SELECT * FROM (VALUES
    (1, 'Tokyo',   3,    2.5,         '1.50',  9007199254740993, DATE '2024-02-28', TIMESTAMP '2024-02-28 23:30:15.25', TIMESTAMPTZ '2024-02-28 23:30:00+09', true,  ' Apple pie '),
    (2, 'Osaka',   5,    1.25,        '-2.25', 42,               DATE '2024-01-01', TIMESTAMP '2024-01-01 00:00:00',    TIMESTAMPTZ '2024-01-01 00:00:00+00', false, '2024-03-05'),
    (3, 'Tokyo',   NULL, 1e308,       '0.00',  -5,               DATE '2023-12-31', TIMESTAMP '2023-12-31 12:00:00',    NULL,                                 NULL,  '1_000.5'),
    (4, 'Nagoya',  0,    'NaN',       NULL,    NULL,             NULL,              NULL,                               TIMESTAMPTZ '2024-06-30 12:00:00-05', true,  ''),
    (5, NULL,      7,    'Infinity',  '10.10', 0,                DATE '2024-12-31', TIMESTAMP '2024-12-31 08:05:09.000001', NULL,                               false, NULL),
    (6, '東京',    2,    0.1,         '99.99', 7,                DATE '2000-02-29', TIMESTAMP '2000-02-29 00:00:01',    NULL,                                 true,  'a😀b')
  ) t(id, region, qty, price, amount, big, day, seen, zoned, ok, note)
`;

async function write(name: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = path.join(workspace, name).replaceAll("'", "''");
    await connection.run(
      `COPY (SELECT id::INTEGER AS id, region, qty::INTEGER AS qty, price::DOUBLE AS price, amount::DECIMAL(10,2) AS amount,
        big::BIGINT AS big, day, seen, zoned, ok, note FROM (${rows})) TO '${file}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function table(on: TableEngine = engine) {
  const opened = await on.open(path.join(workspace, "typed.parquet"));
  await opened.whenReady();
  return opened;
}

/** Formulas over every type, every operator and every function, with blanks and values out of range. */
const formulas: FormulaColumn[] = [
  { name: "total", expression: "qty * price" },
  { name: "with tax", expression: "ROUND(total * 1.1, 2)" },
  { name: "ratio", expression: "price / qty" },
  { name: "rest", expression: "qty % 2 + MOD(big, 3) - -qty" },
  { name: "math", expression: "ABS(-qty) + FLOOR(price) + CEILING(price) + SIGN(big) + SQRT(qty) + POWER(qty, 2)" },
  { name: "logs", expression: "LN(qty) + LOG10(100) + EXP(0) + SQRT(-1)" },
  { name: "round", expression: "ROUND(price, -1) + ROUND(amount, 1) + ROUND(2.5) + ROUND(-2.5) + ROUND(1e300, 400)" },
  { name: "extremes", expression: "MIN(qty, price, big) & '/' & MAX(region, note) & '/' & MIN(day, seen)" },
  { name: "label", expression: "region & ': ' & TEXT(qty) & ' × ' & price & ' = ' & total" },
  {
    name: "exact",
    expression: "TEXT(big) & '|' & TEXT(amount) & '|' & TEXT(id) & '|' & TEXT(ok) & '|' & TEXT(0.00001) & '|' & 1e16",
  },
  {
    name: "texts",
    expression: "LEN(note) & LOWER(region) & UPPER(note) & '|' & TRIM(note) & '|' & LEFT(note, 2) & RIGHT(note, 3)",
  },
  {
    name: "mid",
    expression: "MID(note, 2, 3) & '|' & MID(note, 0, 2) & '|' & MID(note, NULL, 2) & '|' & LEFT(note, -1)",
  },
  { name: "replace", expression: "REPLACE(note, 'p', 'P') & REPLACE(note, '', 'x') & CONCAT(region, NULL, qty, ok)" },
  { name: "tests", expression: "CONTAINS(note, 'pie') OR STARTSWITH(region, 'O') OR ENDSWITH(note, '5')" },
  { name: "value", expression: "VALUE(note) + VALUE(TEXT(qty))" },
  { name: "dates", expression: "DATE(note) & '|' & DATETIME(note) & '|' & DATE(seen) & '|' & DATETIME(day)" },
  { name: "parts", expression: "YEAR(day) * 10000 + MONTH(day) * 100 + DAY(day) + WEEKDAY(day) / 10" },
  { name: "clock", expression: "HOUR(seen) * 3600 + MINUTE(seen) * 60 + SECOND(seen) + HOUR(zoned)" },
  { name: "span", expression: "DAYS(seen, day) + DAYS('2024-03-01', day)" },
  { name: "later", expression: "ADDDAYS(day, qty)" },
  { name: "later at", expression: "ADDDAYS(seen, 1)" },
  { name: "zoned day", expression: "DATE(zoned)" },
  { name: "compare", expression: "day > '2024-01-01' AND seen <= '2024-12-31 08:05:09.000001' OR region = 'Tokyo'" },
  { name: "texts compare", expression: "region < note OR note >= 'b' OR 'ｱ' < '😀'" },
  { name: "logic", expression: "(NULL AND FALSE) OR NOT ok OR (ok AND NULL)" },
  { name: "choice", expression: "IF(ok, 'yes', IF(NOT ok, 'no')) & COALESCE(region, note, '?')" },
  { name: "blank", expression: "ISBLANK(note) & ISBLANK(qty) & ISBLANK(NULL)" },
  { name: "nothing", expression: "IF(FALSE, NULL)" },
  { name: "overflow", expression: "price * 10 + 1e308 * 10" },
  { name: "chain", expression: "IF(total > 5, 'big', 'small') & ' ' & [with tax]" },
];

/** Every row and column of a view, in view order. */
async function readAll(source: TableSource, query: ViewQuery) {
  const view = await source.createView(query);
  const columns = Array.from({ length: 11 + (query.formulas?.length ?? 0) }, (_, index) => index);
  const block = await source.readRows({ view: view.id, start: 0, end: view.rowCount, columns });
  return { view, columns: block.columns, rowIds: block.rowIds };
}

async function arrayOf(duck: TableSource) {
  const info = await duck.info();
  const all = await duck.readRows({ view: null, start: 0, end: 100, columns: info.columns.map((_, index) => index) });
  return new ArraySource({ columns: info.columns, columnData: all.columns });
}

test("formula columns give the same values in DuckDB and in ArraySource", async () => {
  const duck = await table();
  const info = await duck.info();
  assert.equal(info.capabilities.formulas, true);
  const array = await arrayOf(duck);
  // Every formula is valid over the table.
  for (const formula of compileFormulas(info.columns, formulas)) assert.equal(formula.error, null, formula.name);
  const query = parseViewQuery({ formulas });
  const expected = await readAll(array, query);
  const actual = await readAll(duck, query);
  formulas.forEach((formula, index) => {
    assert.deepEqual(actual.columns[11 + index], expected.columns[11 + index], formula.name);
  });
  assert.deepEqual(actual.rowIds, [0, 1, 2, 3, 4, 5]);
  // A few values, written out.
  const column = (name: string) => expected.columns[11 + formulas.findIndex((item) => item.name === name)];
  assert.deepEqual(column("total"), [7.5, 6.25, null, null, null, 0.2]);
  assert.deepEqual(column("with tax"), [8.25, 6.88, null, null, null, 0.22]);
  assert.equal(column("label")[0], "Tokyo: 3 × 2.5 = 7.5");
  assert.equal(column("exact")[0], "9007199254740993|1.50|1|TRUE|1e-05|1e+16");
  assert.deepEqual(column("later"), ["2024-03-02", "2024-01-06", null, null, "2025-01-07", "2000-03-02"]);
  assert.equal(column("zoned day")[0], "2024-02-28");
  assert.equal(column("dates")[1], "2024-03-05|2024-03-05 00:00:00|2024-01-01|2024-01-01 00:00:00");
  assert.deepEqual(column("nothing"), [null, null, null, null, null, null]);
});

test("formula columns sort, filter, summarize, count values and export alike in both sources", async () => {
  for (const on of [engine, positions]) {
    const duck = await table(on);
    const array = await arrayOf(duck);
    const columns = 11;
    const queries: ViewQuery[] = [
      { formulas, sort: [{ column: columns, direction: "desc" }] },
      {
        formulas,
        sort: [
          { column: columns + 8, direction: "asc" },
          { column: 0, direction: "desc" },
        ],
      },
      { formulas, filters: [{ type: "compare", column: columns, op: "ge", value: 1 }] },
      {
        formulas,
        where: {
          type: "or",
          filters: [
            { type: "text", column: columns + 8, op: "contains", value: "tokyo" },
            { type: "blank", column: columns + 1, blank: true },
          ],
        },
        sort: [{ column: columns + 1, direction: "asc" }],
      },
      { formulas, filters: [{ type: "values", column: columns + 13, values: [true] }] },
      { formulas, filters: [{ type: "between", column: columns + 19, min: "2024-01-01", max: "2024-12-31" }] },
      { formulas, search: "tokyo" },
    ];
    for (const query of queries) {
      const parsed = parseViewQuery(query);
      const expected = await readAll(array, parsed);
      const actual = await readAll(duck, parsed);
      assert.deepEqual(actual.rowIds, expected.rowIds, JSON.stringify(query));
      assert.deepEqual(actual.columns, expected.columns, JSON.stringify(query));
      const viewId = actual.view.id;
      for (const column of [columns, columns + 1, columns + 8, columns + 13]) {
        const [duckStats, arrayStats] = await Promise.all([
          duck.columnStats(viewId, column),
          array.columnStats(expected.view.id, column),
        ]);
        assert.equal(duckStats.rows, arrayStats.rows);
        assert.equal(duckStats.nulls, arrayStats.nulls);
        assert.equal(duckStats.distinct, arrayStats.distinct);
        const [duckValues, arrayValues] = await Promise.all([
          duck.distinctValues({ view: viewId, column }),
          array.distinctValues({ view: expected.view.id, column }),
        ]);
        assert.deepEqual(
          duckValues.values.map((item) => item.count).sort(),
          arrayValues.values.map((item) => item.count).sort(),
        );
      }
      const ranges = [{ start: 0, end: actual.view.rowCount, columns: [columns, columns + 2, columns + 16] }];
      const [duckSummary, arraySummary] = await Promise.all([
        duck.aggregate({ view: viewId, ranges }),
        array.aggregate({ view: expected.view.id, ranges }),
      ]);
      assert.equal(duckSummary.count, arraySummary.count);
      assert.equal(duckSummary.numericCount, arraySummary.numericCount);
      assert.equal(duckSummary.min, arraySummary.min);
      assert.equal(duckSummary.max, arraySummary.max);
      // Sums of floating-point numbers depend on the order of the additions.
      assert.ok(Math.abs((duckSummary.sum ?? 0) - (arraySummary.sum ?? 0)) <= 1e-9 * Math.abs(arraySummary.sum ?? 1));
      const found = { text: "big", columns: [0, columns + 29], row: 0, column: 0, direction: 1 as const };
      assert.deepEqual(
        await duck.find({ view: viewId, ...found }),
        await array.find({ view: expected.view.id, ...found }),
      );
    }
    // Exports write formula columns under their names, in view order.
    const query = parseViewQuery({ formulas, sort: [{ column: columns, direction: "desc" }] });
    const view = await duck.createView(query);
    const target = path.join(workspace, `export-${on === engine ? "rows" : "positions"}.csv`);
    await duck.exportView({ view: view.id, format: "csv", columns: [0, columns, columns + 8], target }, target);
    const arrayView = await array.createView(query);
    const exported = await array.exportView({
      view: arrayView.id,
      format: "csv",
      columns: [0, columns, columns + 8],
      target: "x.csv",
    });
    const written = await readFile(target, "utf8");
    assert.equal(written.split("\n")[0], "id,total,label");
    assert.deepEqual(
      written
        .trim()
        .split("\n")
        .map((line) => line.split(",")[0]),
      (await exported.data?.text())
        ?.trim()
        .split("\n")
        .map((line) => line.split(",")[0]),
    );
  }
});

test("a sort over a formula shows its first rows while the rest is built", async () => {
  const duck = await table(positions);
  const query = parseViewQuery({ formulas, sort: [{ column: 11, direction: "asc" }] });
  const view = await duck.createView(query, undefined, { preview: true });
  const done = await duck.createView(query);
  assert.equal(done.id, view.id);
  const block = await duck.readRows({ view: done.id, start: 0, end: done.rowCount, columns: [11] });
  assert.deepEqual(block.columns[0], [0.2, 6.25, 7.5, null, null, null]);
});

test("formula SQL holds no text of the formula: names are quoted identifiers, values are parameters", async () => {
  const columns: SqlColumn[] = [
    { name: 'a"; DROP TABLE x; --', sqlType: "INTEGER", type: "integer" },
    { name: "b", sqlType: "VARCHAR", type: "string" },
  ];
  const schema = [
    { name: 'a"; DROP TABLE x; --', type: "integer" as const },
    { name: "b", type: "string" as const },
  ];
  const compiled = compileFormulas(schema, [
    { name: "x", expression: '[a"; DROP TABLE x; --] + 1' },
    { name: "y", expression: "b & '''); DROP TABLE x; --' & \"--\"" },
  ]);
  const select = formulaSelect(compiled, columns);
  const sql = select.layers.flat().join(" ");
  assert.ok(sql.includes('f."a""; DROP TABLE x; --"'));
  assert.ok(!sql.includes("'); DROP"));
  assert.deepEqual(
    select.constants.map((item) => item.value),
    [1, "'); DROP TABLE x; --", "--"],
  );
  // Functions outside the list, statements and SQL syntax are refused before any SQL is made.
  for (const expression of [
    "read_csv('/etc/passwd')",
    "1); DROP TABLE x; --",
    "qty; SELECT 1",
    "qty::VARCHAR",
    "qty || 'a'",
    "(SELECT 1)",
    '"a" -- comment',
  ]) {
    const [formula] = compileFormulas([{ name: "qty", type: "integer" }], [{ name: "f", expression }]);
    assert.ok(formula.error, expression);
  }

  // Over HTTP: invalid formulas are refused, and values that look like SQL stay values.
  const handler = createTableHandler({ engine, resolve: (ref) => path.join(workspace, ref) });
  const post = async (body: unknown) => {
    const response = await handler(
      new Request("http://localhost/api/table", { method: "POST", body: JSON.stringify(body) }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        result?: { table: string; id: string; columns: CellValue[][] };
        error?: { code: string };
      },
    };
  };
  const opened = await post({ op: "info", ref: "typed.parquet" });
  const handle = opened.body.result?.table;
  for (const expression of ["read_csv('/etc/passwd')", "qty; DROP TABLE x", "missing * 2", "region * 2"]) {
    const response = await post({ op: "view", table: handle, query: { formulas: [{ name: "f", expression }] } });
    assert.equal(response.status, 400, expression);
    assert.equal(response.body.error?.code, "invalid_request");
  }
  const tooMany = Array.from({ length: 33 }, (_, index) => ({ name: `f${index}`, expression: "1" }));
  assert.equal((await post({ op: "view", table: handle, query: { formulas: tooMany } })).status, 400);
  const view = await post({
    op: "view",
    table: handle,
    query: { formulas: [{ name: "f", expression: "'x''); DROP TABLE t; --' & region" }] },
  });
  assert.equal(view.status, 200);
  const read = await post({ op: "rows", table: handle, view: view.body.result?.id, start: 0, end: 1, columns: [11] });
  assert.deepEqual(read.body.result?.columns, [["x'); DROP TABLE t; --Tokyo"]]);
  // The table is still there.
  const again = await post({ op: "rows", table: handle, view: null, start: 0, end: 1, columns: [0] });
  assert.deepEqual(again.body.result?.columns, [[1]]);
});

test("formula columns exist only in views that have them", async () => {
  const duck = await table();
  await assert.rejects(duck.readRows({ view: null, start: 0, end: 1, columns: [11] }), /does not exist/);
  const view = await duck.createView({ formulas: [{ name: "f", expression: "qty + 1" }] });
  assert.equal(view.rowCount, 6);
  await assert.rejects(duck.readRows({ view: view.id, start: 0, end: 1, columns: [12] }), /does not exist/);
  const values = (await duck.readRows({ view: view.id, start: 0, end: 6, columns: [11] })).columns[0] as CellValue[];
  assert.deepEqual(values, [4, 6, null, 1, 8, 3]);
});
