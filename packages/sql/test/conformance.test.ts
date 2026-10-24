import assert from "node:assert/strict";
import { test } from "node:test";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { type Column, checkPlan, type JsonValue, PlanError, SpecError } from "vastgrid-spec";
import {
  type CaseResult,
  type CorpusCase,
  type CorpusFile,
  type CorpusTable,
  compareResult,
  isFailure,
  readCorpus,
} from "vastgrid-spec/conformance";
import {
  compileView,
  countQuery,
  duckdbType,
  floatParam,
  type PivotCombinations,
  pivotQuery,
  quoteIdentifier,
  rowsQuery,
  type SqlValue,
} from "../src/index.ts";

/** The column of row IDs in the tables of the corpus: the position of each row. */
const ROW_ID = "vg_corpus_row";

const FLOAT_TOKENS = new Set(["NaN", "Infinity", "-Infinity"]);

/** A typed JSON value (§2.2) as SQL, with its parameter. */
function input(value: JsonValue, column: Column, params: SqlValue[]): string {
  const type = duckdbType(column);
  if (value === null) return `CAST(NULL AS ${type})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (column.type === "float" && typeof value === "string") {
    if (!FLOAT_TOKENS.has(value)) throw new RangeError(`${value} is not a float.`);
    return `CAST('${value}' AS ${type})`;
  }
  if (typeof value === "number" && column.type === "integer") {
    params.push(value);
    return `CAST($${params.length} AS ${type})`;
  }
  params.push(typeof value === "number" && column.type === "float" ? floatParam(value) : String(value));
  if (column.type === "binary") return `from_base64(CAST($${params.length} AS VARCHAR))`;
  return `CAST(CAST($${params.length} AS VARCHAR) AS ${type})`;
}

async function createTable(connection: DuckDBConnection, name: string, table: CorpusTable) {
  const columns = table.columns.map((column) => `${quoteIdentifier(column.name)} ${duckdbType(column)}`);
  await connection.run(`CREATE TABLE ${quoteIdentifier(name)} (${columns.join(", ")}, ${ROW_ID} BIGINT)`);
  for (const [index, row] of table.rows.entries()) {
    const params: SqlValue[] = [];
    const values = row.map((value, column) => input(value, table.columns[column], params));
    await connection.run(
      `INSERT INTO ${quoteIdentifier(name)} VALUES (${[...values, String(index)].join(", ")})`,
      params,
    );
  }
}

/**
 * Reads exact numbers, dates and times as their text, which is how JSON writes them (§2.2). Strings get a
 * leading "." that `jsonOf` removes: `@duckdb/node-api` 1.5.6-r.1 decodes text with a `TextDecoder` that drops
 * a U+FEFF at the start of a value.
 */
function output(column: Column, sql: string): string {
  switch (column.type) {
    case "string":
      return `('.' || ${sql})`;
    case "bigint":
    case "decimal":
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
    case "interval":
    case "uuid":
      return `CAST(${sql} AS VARCHAR)`;
    case "binary":
      return `to_base64(${sql})`;
    default:
      return sql;
  }
}

function jsonOf(value: unknown, column: Column): JsonValue {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "bigint": {
      const text = String(value);
      return Number.isSafeInteger(Number(text)) ? Number(text) : text;
    }
    case "integer":
      return Number(value);
    case "float": {
      const number = Number(value);
      if (Number.isNaN(number)) return "NaN";
      if (number === Number.POSITIVE_INFINITY) return "Infinity";
      if (number === Number.NEGATIVE_INFINITY) return "-Infinity";
      return number;
    }
    case "boolean":
      return Boolean(value);
    case "string":
      return String(value).slice(1);
    default:
      return String(value);
  }
}

type Answer = { result: CaseResult } | { error: { code: string; reason?: string; path?: string } };

async function answer(connection: DuckDBConnection, file: CorpusFile, item: CorpusCase): Promise<Answer> {
  const table = file.tables[item.table];
  assert.ok(table, `The table "${item.table}" is not in ${file.file}.`);
  try {
    const plan = checkPlan(item.plan, table.columns);
    const source = { relation: quoteIdentifier(item.table), rowId: ROW_ID };
    let combinations: PivotCombinations | undefined;
    if (plan.aggregate?.pivot) {
      const query = pivotQuery(plan, source);
      const rows = (await connection.runAndReadAll(query.sql, query.params)).getRowsJS();
      combinations = rows.map((row) => row.map((value) => (value === null ? null : String(value))));
    }
    const view = compileView(plan, source, combinations);
    const count = countQuery(view);
    const rowCount = Number((await connection.runAndReadAll(count.sql, count.params)).getRowsJS()[0][0]);
    const names = item.read?.columns ?? view.columns.map((column) => column.name);
    const columns = names.map((name) => view.columns.find((column) => column.name === name) as Column);
    const start = item.read?.start ?? 0;
    const query = rowsQuery(view, { start, end: item.read?.end ?? Math.max(start, rowCount), columns: names }, output);
    const rows = (await connection.runAndReadAll(query.sql, query.params)).getRowsJS();
    return {
      result: {
        columns,
        rowCount,
        rows: rows.map((row) => columns.map((column, index) => jsonOf(row[index], column))),
        rowIds: view.rowIds ? rows.map((row) => Number(row[columns.length])) : null,
      },
    };
  } catch (error) {
    if (error instanceof PlanError) return { error: { code: error.code, reason: error.reason, path: error.path } };
    if (error instanceof SpecError) return { error: { code: error.code } };
    throw error;
  }
}

for (const file of readCorpus()) {
  test(`conformance: ${file.file}`, async (t) => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("SET TimeZone = 'UTC'");
      for (const [name, table] of Object.entries(file.tables)) await createTable(connection, name, table);
      for (const item of file.cases) {
        await t.test(item.id, async () => {
          const got = await answer(connection, file, item);
          if (isFailure(item.expect)) {
            assert.ok("error" in got, `expected the error ${item.expect.error.code}, got rows`);
            const { code, reason, path } = item.expect.error;
            assert.deepEqual(
              {
                code: got.error.code,
                reason: reason === undefined ? undefined : got.error.reason,
                path: path === undefined ? undefined : got.error.path,
              },
              { code, reason, path },
            );
            return;
          }
          assert.ok("result" in got, `expected rows, got the error ${"error" in got ? JSON.stringify(got.error) : ""}`);
          assert.deepEqual(compareResult(item.expect, got.result), []);
        });
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
}
