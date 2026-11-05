import assert from "node:assert/strict";
import type { Column } from "vastgrid-spec";
import { test } from "vite-plus/test";
import { type Answer, compareInputs, differences, same, sameSummary } from "./generated.ts";

const column: Column = { name: "average", type: "float", bits: 64 };
const result: Answer = { columns: [column], rowCount: 1, rowIds: null, rows: [[42]] };

test("known DuckDB errors do not hide a Parquet error or different rows", () => {
  const known = { error: { code: "internal", message: "STDDEV_SAMP is out of range" } };
  assert.deepEqual(compareInputs(result, structuredClone(result), known), { known: true, problems: [] });
  assert.deepEqual(compareInputs(result, structuredClone(result), result), { known: false, problems: [] });
  for (const broken of [
    { error: { code: "load_failed", message: "Parquet read failed" } },
    { ...result, rows: [[99]] },
    { ...result, rows: [] },
    known,
  ]) {
    for (const [rows, parquet] of [
      [result, broken],
      [broken, result],
    ]) {
      const compared = compareInputs(rows, parquet, known);
      assert.equal(compared.known, true);
      assert.ok(compared.problems.some((problem) => problem.startsWith("rows/parquet:")));
    }
  }
  const unexpected = { error: { code: "internal", message: "new failure" } };
  assert.equal(compareInputs(result, result, unexpected).known, false);
  assert.equal(compareInputs(result, result, unexpected).problems.length, 2);
});

test("generated comparisons reject missing or extra rows and cells, including null cells", () => {
  for (const [left, right] of [
    [result, { ...result, rows: [] }],
    [result, { ...result, rows: [[42], [99]] }],
    [result, { ...result, rows: [[42, null]] }],
    [
      { ...result, rows: [[null]] },
      { ...result, rows: [[]] },
    ],
    [
      { ...result, rows: [[null]] },
      { ...result, rows: [] },
    ],
  ]) {
    assert.notDeepEqual(differences(left, right), [], JSON.stringify([left, right]));
    assert.notDeepEqual(differences(right, left), [], JSON.stringify([right, left]));
  }
  assert.deepEqual(differences(result, structuredClone(result)), []);
  assert.deepEqual(differences({ ...result, rows: [[null]] }, { ...result, rows: [[null]] }), []);
});

test("floating point tolerance distinguishes null from zero while allowing subnormal rounding", () => {
  for (const value of [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE]) {
    assert.equal(same(null, value, column), false);
    assert.equal(same(value, null, column), false);
    assert.notDeepEqual(differences({ ...result, rows: [[null]] }, { ...result, rows: [[value]] }), []);
  }
  assert.equal(same(null, null, column), true);
  assert.equal(same(0, Number.MIN_VALUE, column), true);
  assert.equal(same(-Number.MIN_VALUE, 0, column), true);
  assert.equal(same(1, 1 + 1e-10, column), true);
  assert.equal(same(1, 2, column), false);
});

test("summary comparisons keep an empty result distinct from zero", () => {
  const empty = { count: 0, numericCount: 0, min: null, max: null, sum: null, average: null };
  assert.equal(sameSummary(empty, { ...empty }), true);
  for (const member of ["min", "max", "sum", "average"]) {
    assert.equal(sameSummary(empty, { ...empty, [member]: 0 }), false, member);
    assert.equal(sameSummary({ ...empty, [member]: 0 }, empty), false, member);
  }
  const numbers = { count: 2, numericCount: 2, min: -1, max: 1, sum: 0, average: 0 };
  assert.equal(sameSummary(numbers, { ...numbers, sum: 1e-12, average: 5e-13 }), true);
});
