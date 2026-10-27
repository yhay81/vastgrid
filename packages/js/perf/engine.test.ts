/** Run with npm run test:performance, with no other test files running concurrently. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveRows, groupRows, sortFloats } from "../test/workloads.ts";

for (const form of ["rows", "Arrow"] as const) {
  test(`1,000,000 floats as ${form} open, sort and read within 3 seconds`, async (t) => {
    const { open, sorted, again, reversed } = await sortFloats(1_000_000, form);
    t.diagnostic(
      `open ${open.toFixed(0)} ms, sort ${sorted.toFixed(0)} ms, read ${again.toFixed(0)} ms, reverse ${reversed.toFixed(0)} ms`,
    );
    assert.ok(open + sorted < 3000, `open and sort: ${(open + sorted).toFixed(0)} ms`);
    assert.ok(reversed < 3000, `reverse: ${reversed.toFixed(0)} ms`);
  });
}

for (const [name, workload] of [
  ["derive, filter and sort", deriveRows],
  ["group and sort", groupRows],
] as const) {
  test(`1,000,000 rows ${name} within 3 seconds`, async (t) => {
    const time = await workload(1_000_000);
    t.diagnostic(`${name}: ${time.toFixed(0)} ms`);
    assert.ok(time < 3000, `${time.toFixed(0)} ms`);
  });
}
