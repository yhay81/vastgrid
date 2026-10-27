/** Shared workloads: functional tests use small tables; isolated performance tests use a million rows.
 * Both check the results against independently computed values.
 */
import assert from "node:assert/strict";
import { encodeBlock, type JsonValue } from "vastgrid-spec";
import { Client, random, single } from "./client.ts";

export async function sortFloats(rowCount: number, form: "rows" | "Arrow") {
  const next = random(2026);
  const values: JsonValue[] = Array.from({ length: rowCount }, (_, row) =>
    row % 10_007 === 0 ? null : row % 10_009 === 0 ? "NaN" : (next() - 0.5) * 1e6,
  );
  const table = single({ type: "float" }, values);

  const client = new Client({ floats: form === "rows" ? table : { arrow: encodeBlock(table.columns, table.rows) } });
  const time = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const result = await work();
    return [result, performance.now() - start];
  };
  const [info, open] = await time(() => client.open("floats"));
  const asc = { sort: [{ column: "x", direction: "asc" as const }] };
  const desc = { sort: [{ column: "x", direction: "desc" as const }] };
  const [first, sorted] = await time(() => client.rows(info, asc, { start: 0, end: 256 }));
  const [, again] = await time(() =>
    client.rows(info, asc, { start: Math.floor(rowCount / 2), end: Math.floor(rowCount / 2) + 256 }),
  );
  const [last, reversed] = await time(() => client.rows(info, desc, { start: 0, end: 256 }));
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
  const nulls = Math.min(3, values.filter((value) => value === null).length);
  const tail = await client.rows(info, desc, { start: rowCount - nulls, end: rowCount });
  const lastNull = Math.floor((rowCount - 1) / 10_007) * 10_007;
  assert.deepEqual(
    tail.rowIds,
    Array.from({ length: nulls }, (_, index) => lastNull - (nulls - 1 - index) * 10_007),
  );
  assert.deepEqual(
    tail.rows,
    Array.from({ length: nulls }, () => [null]),
  );
  return { open, sorted, again, reversed };
}

export async function deriveRows(rowCount: number) {
  const next = random(43);
  const rows: JsonValue[][] = Array.from({ length: rowCount }, (_, row) => [
    row % 1_000 === 0 ? null : Math.floor(next() * 1_000),
    (next() * 100).toFixed(2),
  ]);
  const client = new Client({
    big: {
      columns: [
        { name: "qty", type: "integer" },
        { name: "price", type: "decimal", precision: 6, scale: 2 },
      ],
      rows,
    },
  });
  const info = await client.open("big");
  const plan = {
    derive: [{ name: "total", expr: { fn: "mul", args: [{ col: "qty" }, { col: "price" }] } }],
    where: { fn: "gt", args: [{ col: "total" }, { lit: "50000", type: "decimal" }] },
    sort: [{ column: "total", direction: "desc" }],
  };
  const start = performance.now();
  const read = await client.rows(info, plan, { start: 0, end: 3, columns: ["total"] });
  const time = performance.now() - start;
  const totals = rows
    .filter(([qty]) => qty !== null)
    .map(([qty, price]) => (qty as number) * Math.round(Number(price) * 100))
    .filter((cents) => cents > 5_000_000)
    .sort((a, b) => b - a);
  assert.equal(read.view.rowCount, totals.length);
  assert.deepEqual(
    read.rows.map(([total]) => total),
    totals.slice(0, 3).map((cents) => (cents / 100).toFixed(2)),
  );
  return time;
}

export async function groupRows(rowCount: number) {
  const next = random(44);
  const rows: JsonValue[][] = Array.from({ length: rowCount }, () => [
    Math.floor(next() * 1_000),
    (next() * 100).toFixed(2),
  ]);
  const client = new Client({
    big: {
      columns: [
        { name: "key", type: "integer" },
        { name: "price", type: "decimal", precision: 6, scale: 2 },
      ],
      rows,
    },
  });
  const info = await client.open("big");
  const plan = {
    aggregate: {
      keys: ["key"],
      measures: [
        { name: "n", fn: "count" },
        { name: "s", fn: "sum", column: "price" },
        { name: "a", fn: "avg", column: "price" },
        { name: "d", fn: "count_distinct", column: "price" },
      ],
    },
    sort: [{ column: "s", direction: "desc" }],
  };
  const start = performance.now();
  const read = await client.rows(info, plan, { start: 0, end: 1, columns: ["key", "n", "s"] });
  const time = performance.now() - start;
  assert.equal(read.view.rowCount, 1_000);
  const sums = new Map<number, number>();
  for (const [key, price] of rows) {
    sums.set(key as number, (sums.get(key as number) ?? 0) + Math.round(Number(price) * 100));
  }
  const [key, cents] = [...sums].sort((a, b) => b[1] - a[1])[0];
  assert.deepEqual(read.rows[0][0], key);
  assert.equal(read.rows[0][2], (cents / 100).toFixed(2));
  return time;
}
