/**
 * The plan corpus of vastgrid-spec (docs/v2-spec.md §10) through the engine's messages: every case whose plan
 * fits the engine's capabilities runs and conforms; every other case is answered with `invalid_plan`
 * (`unsupported`), and is counted as skipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Column, checkResponse, decodeBlock, MESSAGE_LIMITS, type Operation } from "vastgrid-spec";
import { type CaseResult, type CorpusCase, compareResult, isFailure, readCorpus } from "vastgrid-spec/conformance";
import { MEMORY_CAPABILITIES, memoryEngine } from "../src/index.ts";

type Json = Record<string, unknown>;

/** The members of plans that the engine does not evaluate (§4.10). */
const UNOFFERED = Object.entries(MEMORY_CAPABILITIES.plan ?? {})
  .filter(([, offered]) => offered === false)
  .map(([member]) => member);

/** Whether a case's plan uses only what the engine evaluates; plans that are not objects fail alike. */
function fits(item: CorpusCase): boolean {
  const plan = item.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return true;
  return !Object.keys(plan).some((member) => UNOFFERED.includes(member));
}

const counts = { run: 0, skipped: 0 };

for (const file of readCorpus()) {
  test(`conformance: ${file.file}`, async (t) => {
    const engine = memoryEngine({ tables: file.tables });
    let id = 0;
    const send = async (op: Operation, members: Json) => {
      const response = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
      checkResponse(response, op);
      assert.equal(response.id, id);
      return response;
    };
    for (const item of file.cases) {
      await t.test(item.id, async () => {
        const opened = (await send("open", { ref: item.table })).result as { table: string; revision: string };
        const start = item.read?.start ?? 0;
        // By default, every column of the view, which for this engine's plans are the table's. A case that
        // reads no columns still reads rows: one column is read, and its values are left out.
        const names = item.read?.columns ?? file.tables[item.table].columns.map((column) => column.name);
        const read = names.length > 0 ? names : [file.tables[item.table].columns[0].name];
        const response = await send("rows", {
          table: opened.table,
          revision: opened.revision,
          plan: item.plan,
          start,
          end: item.read?.end ?? start + Math.floor(MESSAGE_LIMITS.cells / read.length),
          columns: read,
        });
        await send("close", { table: opened.table });
        const error = response.error as { code: string; reason?: string; path?: string } | undefined;
        if (!fits(item)) {
          counts.skipped++;
          assert.deepEqual([error?.code, error?.reason], ["invalid_plan", "unsupported"]);
          return;
        }
        counts.run++;
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

test("every case of the corpus is run or skipped, and the cases that fit are the ones run", (t) => {
  const cases = readCorpus().flatMap((file) => file.cases);
  t.diagnostic(`${counts.run} cases run, ${counts.skipped} skipped: their plans use what the engine does not offer`);
  assert.equal(counts.run + counts.skipped, cases.length);
  assert.equal(counts.run, cases.filter(fits).length);
  assert.ok(counts.run >= 13, `${counts.run} cases run`);
});
