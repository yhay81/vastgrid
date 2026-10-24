import assert from "node:assert/strict";
import { test } from "node:test";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { type Column, checkPlan, PlanError, SpecError } from "vastgrid-spec";
import {
  type CaseResult,
  type CorpusCase,
  type CorpusFile,
  compareResult,
  isFailure,
  readCorpus,
} from "vastgrid-spec/conformance";
import {
  compileView,
  countQuery,
  type PivotCombinations,
  pivotQuery,
  quoteIdentifier,
  rowsQuery,
} from "../src/index.ts";
import { createTable, jsonOf, output, ROW_ID } from "./duckdb.ts";

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
