/**
 * The plan cases of the conformance corpus (docs/v2-spec.md §10), answered by the engine over messages: each table
 * of the corpus is a Parquet file, whose row numbers are the table's row IDs (its positions).
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Column, JsonValue } from "vastgrid-spec";
import { type CorpusTable, compareResult, isFailure, readCorpus } from "vastgrid-spec/conformance";
import { duckdbType, quoteIdentifier } from "vastgrid-sql";
import { type Client, setUp, type TableInfo } from "./client.ts";

for (const materializeRows of [0, 20_000_000])
  describe(`materializeRows=${materializeRows}`, () => {
    let context: Awaited<ReturnType<typeof setUp>>;
    let client: Client;

    before(async () => {
      context = await setUp({ materializeRows });
      client = context.client;
    });

    after(async () => {
      await context.tearDown();
    });

    /** A typed JSON value (§2.2) as SQL: numbers and text as parameters read as text, which DuckDB reads exactly. */
    function input(value: JsonValue, column: Column, params: string[]): string {
      const type = duckdbType(column);
      if (value === null) return `CAST(NULL AS ${type})`;
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      params.push(Object.is(value, -0) ? "-0.0" : String(value));
      return `CAST(CAST($${params.length} AS VARCHAR) AS ${type})`;
    }

    async function writeParquet(file: string, table: CorpusTable) {
      const instance = await DuckDBInstance.create(":memory:");
      const connection = await instance.connect();
      try {
        const columns = table.columns.map((column) => `${quoteIdentifier(column.name)} ${duckdbType(column)}`);
        await connection.run(`CREATE TABLE t (${columns.join(", ")}, vg_order BIGINT)`);
        for (const [index, row] of table.rows.entries()) {
          const params: string[] = [];
          const values = row.map((value, column) => input(value, table.columns[column], params));
          await connection.run(`INSERT INTO t VALUES (${[...values, String(index)].join(", ")})`, params);
        }
        const names = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
        await connection.run(
          `COPY (SELECT ${names} FROM t ORDER BY vg_order) TO '${file.replaceAll("'", "''")}' (FORMAT parquet)`,
        );
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    }

    for (const file of readCorpus()) {
      test(`plan corpus through the engine: ${file.file}`, async (t) => {
        const tables = new Map<string, TableInfo>();
        for (const [name, table] of Object.entries(file.tables)) {
          const parquet = path.join(context.workspace, `${path.basename(file.file, ".json")}-${name}.parquet`);
          await writeParquet(parquet, table);
          const info = await client.open(parquet);
          assert.equal(info.status, "ready", info.error);
          assert.deepEqual(
            info.columns.map(({ sourceType: _sourceType, ...column }) => column),
            table.columns,
            `the table ${name} reads with its own types`,
          );
          tables.set(name, info);
        }
        for (const item of file.cases) {
          await t.test(item.id, async () => {
            const info = tables.get(item.table) as TableInfo;
            const plan = item.plan as Record<string, unknown>;
            const start = item.read?.start ?? 0;
            if (isFailure(item.expect)) {
              const error = await client.error("rows", {
                table: info.table,
                revision: info.revision,
                plan,
                start,
                end: start + 1,
                columns: [],
              });
              const { code, reason, path: at } = item.expect.error;
              assert.deepEqual(
                {
                  code: error.code,
                  reason: reason === undefined ? undefined : error.reason,
                  path: at === undefined ? undefined : error.path,
                },
                { code, reason, path: at },
              );
              return;
            }
            // A read without columns gives the view's columns (§8.2); then the case's columns are read.
            const probe = await client.result<{ view: { columns: Column[] } }>("rows", {
              table: info.table,
              revision: info.revision,
              plan,
              start: 0,
              end: 0,
              columns: [],
            });
            const names = item.read?.columns ?? probe.view.columns.map((column) => column.name);
            const end = item.read?.end ?? start + Math.floor(1_000_000 / Math.max(1, names.length));
            const read = await client.rows(info, { start, end, columns: names, plan });
            const problems = compareResult(item.expect, {
              columns: read.columns.map(
                (column) => probe.view.columns.find((item) => item.name === column.name) as Column,
              ),
              rowCount: read.view.rowCount,
              rows: read.rows,
              rowIds: read.rowIds,
            });
            assert.deepEqual(problems, []);
          });
        }
      });
    }
  });
