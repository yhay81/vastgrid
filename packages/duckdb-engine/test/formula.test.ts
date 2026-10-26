/**
 * Formulas (docs/v2-spec.md §4.11) evaluated by DuckDB: v1's formula tests, whose results v2 keeps or changes as
 * §4.11 lists, and a v1 state with formulas migrated (§5.6) and read through the engine.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { type Column, compileFormula, FormulaError, type JsonValue, migrateGridState } from "vastgrid-spec";
import { type Client, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let info: TableInfo;

// v1's test row, as a Parquet file.
before(async () => {
  context = await setUp();
  client = context.client;
  const file = path.join(context.workspace, "formulas.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(`COPY (SELECT
      3::INTEGER AS qty, 2.5::DOUBLE AS price, ' Apple pie ' AS name, DATE '2024-02-28' AS day,
      TIMESTAMP '2024-02-28 23:30:15.25' AS at, TRUE AS ok, 1.50::DECIMAL(10, 2) AS "unit price",
      9007199254740993::BIGINT AS id, 120::INTEGER AS 単価
    ) TO '${file.replaceAll("'", "''")}' (FORMAT parquet)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  info = await client.open(file);
  assert.equal(info.status, "ready", info.error);
});

after(async () => {
  await context.tearDown();
});

async function value(formula: string, columns: Column[] = info.columns): Promise<JsonValue> {
  const { expr } = compileFormula(formula, columns);
  const rows = await client.rows(info, { plan: { derive: [{ name: "f", expr }] }, columns: ["f"] });
  return rows.rows[0][0];
}

test("v1's formulas give v1's results", async () => {
  const same: [string, JsonValue][] = [
    ["qty * price", 7.5],
    ["qty * price + 1 - 2 / 4", 8],
    ["-qty % 2", -1],
    ["単価 * qty", 360],
    ["qty / 0", null],
    ["MOD(qty, 0)", null],
    ["1e308 * 10", null],
    ["SQRT(-1)", null],
    ["LN(0)", null],
    ["MIN(qty, price, NULL)", 2.5],
    ["MAX('b', 'a')", "b"],
    ["name & '!'", " Apple pie !"],
    ["TEXT(id)", "9007199254740993"],
    ["TEXT([unit price])", "1.50"],
    ["LEN('a😀b')", 3],
    ["LEFT('a😀bc', 2) & '|' & RIGHT('abc', 2) & '|' & MID('abcdef', 0, 3)", "a😀|bc|abc"],
    ["REPLACE('a-b-c', '-', '+') & REPLACE('abc', '', 'x')", "a+b+cabc"],
    ["UPPER(TRIM(name))", "APPLE PIE"],
    ["CONTAINS(name, 'pie') AND STARTSWITH(name, ' A') AND NOT ENDSWITH(name, 'x')", true],
    ["VALUE(' 1000.5 ') + VALUE('x')", null],
    ["VALUE(' 1000.5 ')", 1000.5],
    ["ADDDAYS(day, 2)", "2024-03-01"],
    ["DAYS(DATE('2024-03-01'), day)", 2],
    ["YEAR(day) * 10000 + MONTH(day) * 100 + DAY(day)", 20240228],
    ["WEEKDAY(day)", 3],
    ["HOUR(at) & ':' & MINUTE(at) & ':' & SECOND(at)", "23:30:15"],
    ["ADDDAYS(at, 1)", "2024-02-29 23:30:15.25"],
    ["DATE(at)", "2024-02-28"],
    ["DATETIME(day)", "2024-02-28 00:00:00"],
    ["DATE('2024-02-30')", null],
    ["DATETIME(' 2024-1-5T7:08 ')", "2024-01-05 07:08:00"],
    ["day > '2024-01-01' AND at < '2025-01-01'", true],
    ["IF(qty > 2, 'many', 'few')", "many"],
    ["IF(NULL, 1, 2)", 2],
    ["IF(FALSE, 1)", null],
    ["COALESCE(NULL, qty)", 3],
    ["ISBLANK(NULL) AND ISBLANK('') AND NOT ISBLANK(qty)", true],
    ["NULL AND FALSE", false],
    ["NULL OR TRUE", true],
    ["qty + NULL", null],
    ["'ｱ' < '😀'", true],
  ];
  for (const [formula, expected] of same) assert.deepEqual(await value(formula), expected, formula);
});

test("v1's formulas whose results v2 changes (§4.11)", async () => {
  const changed: [string, JsonValue, JsonValue][] = [
    // Exact numbers stay exact: decimals are written as text, and 0.285 is not 0.28499999…
    ["[unit price] * 2", "3.00", 3],
    ["ROUND(2.5)", "3", 3],
    ["ROUND(0.285, 2)", "0.29", 0.28],
    ["ROUND(1234.5, -2)", "1200", 1200],
    // The text forms of §2.4.
    ["TRIM(name) & qty & ok & NULL", "Apple pie3true", "Apple pie3TRUE"],
    ["TEXT(price * 2)", "5.0", "5"],
    ["TEXT(0.00001)", "0.00001", "1e-05"],
    // A null argument gives null (§3.6), and to_number reads no underscores.
    ["LEFT('abc', NULL)", null, ""],
    ["VALUE(' 1_000.5 ')", null, 1000.5],
  ];
  for (const [formula, expected] of changed) assert.deepEqual(await value(formula), expected, formula);
  // Formulas that v2 refuses: round's digits are from −18 to 18, and two nulls have no type to compare.
  for (const formula of ["ROUND(123.456, 400)", "NULL = NULL"]) {
    assert.throws(() => compileFormula(formula, info.columns), FormulaError, formula);
  }
});

test("a v1 state with formulas migrates and reads through the engine", async () => {
  const { document, dropped } = migrateGridState(
    {
      version: 1,
      formulas: [
        { name: "label", expression: "UPPER(TRIM(name)) & ' x' & qty" },
        { name: "total", expression: "qty * [unit price]" },
      ],
      query: { filters: [{ type: "compare", column: 10, op: "gt", value: "4" }] },
      group: { keys: ["label"], aggregates: [{ fn: "sum", column: "total" }] },
    },
    info.columns,
  );
  assert.deepEqual(dropped, []);
  const rows = await client.rows(info, {
    plan: document.plan as Record<string, unknown>,
    columns: ["label", "sum(total)"],
  });
  assert.deepEqual(rows.rows, [["APPLE PIE x3", "4.50"]]);
});
