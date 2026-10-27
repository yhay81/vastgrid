/**
 * The engine's speed on a table of 1,000,000 floats, given as rows and as Arrow: sorting it and reading a block
 * of 256 rows stays far within what a grid waits for. The bound is generous so that slow machines do not fail it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeBlock, type JsonValue } from "vastgrid-spec";
import { Client, random, single } from "./client.ts";

const ROWS = 1_000_000;

const next = random(2026);
const values: JsonValue[] = Array.from({ length: ROWS }, (_, row) =>
  row % 10_007 === 0 ? null : row % 10_009 === 0 ? "NaN" : (next() - 0.5) * 1e6,
);
const table = single({ type: "float" }, values);

for (const [form, given] of [
  ["rows", table],
  ["Arrow", { arrow: encodeBlock(table.columns, table.rows) }],
] as const)
  test(`1,000,000 floats as ${form} sort, and a block of 256 rows is read, within 3 seconds`, async (t) => {
    const client = new Client({ floats: given });
    const time = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
      const start = performance.now();
      const result = await work();
      return [result, performance.now() - start];
    };
    const [info, open] = await time(() => client.open("floats"));
    const asc = { sort: [{ column: "x", direction: "asc" as const }] };
    const desc = { sort: [{ column: "x", direction: "desc" as const }] };
    const [first, sorted] = await time(() => client.rows(info, asc, { start: 0, end: 256 }));
    const [, again] = await time(() => client.rows(info, asc, { start: 500_000, end: 500_256 }));
    const [last, reversed] = await time(() => client.rows(info, desc, { start: 0, end: 256 }));
    t.diagnostic(
      `open ${open.toFixed(0)} ms, sort and read ${sorted.toFixed(0)} ms, read again ${again.toFixed(0)} ms, ` +
        `sort the other way and read ${reversed.toFixed(0)} ms`,
    );
    assert.ok(open + sorted < 3000, `open and the first sorted read took ${(open + sorted).toFixed(0)} ms`);
    assert.ok(reversed < 3000, `the descending read took ${reversed.toFixed(0)} ms`);

    // The rows read are the smallest numbers, and descending starts with NaN, the greatest number.
    const numbers = Float64Array.from(values.filter((value): value is number => typeof value === "number")).sort();
    assert.deepEqual(
      first.rows.map((row) => row[0]),
      Array.from(numbers.subarray(0, 256)),
    );
    const nans = values.filter((value) => value === "NaN").length;
    assert.deepEqual(
      last.rows.slice(0, nans).map((row) => row[0]),
      Array(nans).fill("NaN"),
    );
    assert.deepEqual(
      last.rows.slice(nans).map((row) => row[0]),
      Array.from(numbers.subarray(numbers.length - (256 - nans)).reverse()),
    );
    // Nulls come last, in row ID order.
    const tail = await client.rows(info, desc, { start: ROWS - 3, end: ROWS });
    const lastNull = Math.floor((ROWS - 1) / 10_007) * 10_007;
    assert.deepEqual(tail.rowIds, [lastNull - 2 * 10_007, lastNull - 10_007, lastNull]);
    assert.deepEqual(tail.rows, [[null], [null], [null]]);
  });
