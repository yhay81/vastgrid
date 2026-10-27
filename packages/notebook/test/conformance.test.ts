/**
 * The plan corpus of vastgrid-spec (docs/spec.md §10) through the notebook's engine, the Python package in
 * `python/`, over its messages: every case runs and conforms, and every response is one of §8. The engine runs in a
 * Python process of its own (`kernel.ts`); without uv, the tests are skipped.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Column, decodeBlock, encodeBlock, MESSAGE_LIMITS } from "vastgrid-spec";
import { type CaseResult, compareResult, isFailure, readCorpus } from "vastgrid-spec/conformance";
import { Kernel, skip } from "./kernel.ts";

let kernel: Kernel;
before(() => {
  if (!skip) kernel = new Kernel();
});
after(() => kernel?.close());

let run = 0;

for (const file of readCorpus()) {
  test(`conformance through the notebook's engine: ${file.file}`, { skip }, async (t) => {
    // As blocks: JSON would not carry all of the values (`-0` is `0` in it).
    await kernel.add(
      Object.fromEntries(
        Object.entries(file.tables).map(([ref, table]) => [ref, encodeBlock(table.columns, table.rows)]),
      ),
    );
    for (const item of file.cases) {
      await t.test(item.id, async () => {
        const opened = await kernel.send("open", { ref: item.table });
        assert.ok(!opened.error, `the table ${item.table} opens: ${JSON.stringify(opened.error)}`);
        const info = opened.result as { table: string; revision: string; columns: Column[] };
        assert.deepEqual(
          info.columns.map(({ sourceType: _sourceType, ...column }) => column),
          file.tables[item.table].columns,
          `the table ${item.table} reads with its own types`,
        );
        const start = item.read?.start ?? 0;
        const members = { table: info.table, revision: info.revision, plan: item.plan, start };
        const view = (await kernel.send("rows", { ...members, end: start, columns: [] })).result as
          | { view: { columns: Column[] } }
          | undefined;
        const names = item.read?.columns ?? view?.view.columns.map((column) => column.name) ?? [];
        // A case that reads no columns still reads rows: one column is read, and its values are left out.
        const read = names.length > 0 ? names : (view?.view.columns.slice(0, 1).map((column) => column.name) ?? [""]);
        const response = await kernel.send("rows", {
          ...members,
          end: item.read?.end ?? start + Math.floor(MESSAGE_LIMITS.cells / read.length),
          columns: read,
        });
        await kernel.send("close", { table: info.table });
        run++;
        const error = response.error as { code: string; reason?: string; path?: string } | undefined;
        if (isFailure(item.expect)) {
          assert.ok(error, `expected the error ${item.expect.error.code}, got rows`);
          const { code, reason, path } = item.expect.error;
          assert.deepEqual(
            {
              code: error.code,
              reason: reason === undefined ? undefined : error.reason,
              path: path === undefined ? undefined : error.path,
            },
            { code, reason, path },
          );
          return;
        }
        assert.ok(!error, `expected rows, got the error ${JSON.stringify(error)}`);
        const result = response.result as {
          view: { rowCount: number };
          rowIds: number[] | null;
          block: { bytes: Uint8Array };
        };
        const block = decodeBlock(result.block.bytes);
        const got: CaseResult = {
          columns: names.length > 0 ? (block.columns as Column[]) : [],
          rowCount: result.view.rowCount,
          rows: names.length > 0 ? block.rows : block.rows.map(() => []),
          rowIds: result.rowIds,
        };
        assert.deepEqual(compareResult(item.expect, got), []);
      });
    }
  });
}

test("every case of the corpus runs through the notebook's engine", { skip }, () => {
  assert.equal(run, readCorpus().flatMap((file) => file.cases).length);
});
