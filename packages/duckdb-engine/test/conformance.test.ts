/**
 * The plan cases of the conformance corpus (docs/spec.md §10), answered by the engine over messages: each table
 * of the corpus is a Parquet file, whose row numbers are the table's row IDs (its positions).
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Column } from "vastgrid-spec";
import { compareResult, isFailure, readCorpus } from "vastgrid-spec/conformance";
import { type Client, setUp, type TableInfo, writeParquet } from "./client.ts";

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
