import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { BlockValueError, type Column, encodeBlock } from "vastgrid-spec";
import { test } from "vite-plus/test";
import { acceptKeyValue } from "../src/columns.ts";
import { readExpression, readValue, sourceExpression, tableColumn } from "../src/index.ts";

test("source column helpers are available to package consumers", () => {
  const source = { name: "amount", sqlType: "INTEGER" };
  const column = tableColumn(source);
  assert.equal(column.type, "integer");
  assert.equal(sourceExpression(source, column), '"amount"');
});

test("DuckDB intervals wider than Arrow fail with their position instead of wrapping", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const column: Column = { name: "span", type: "interval" };
    const read = await connection.runAndReadAll(`SELECT ${readExpression(column, "INTERVAL '2562048 hours'", 2000)}`);
    const value = readValue(column, read.getRows()[0][0]).value;
    assert.throws(
      () => encodeBlock([column], [[value]]),
      (error: unknown) => error instanceof BlockValueError && error.path === "/rows/0/0",
    );
    const sRead = await connection.runAndReadAll(
      `SELECT ${readExpression({ name: "ts", type: "timestamp", unit: "s" }, "TIMESTAMP_S '2024-01-01 00:00:01'", 2000)}, ${readExpression({ name: "tm", type: "timestamp", unit: "ms" }, "TIMESTAMP_MS '2024-01-01 00:00:00.250'", 2000)}`,
    );
    assert.equal(
      readValue({ name: "ts", type: "timestamp", unit: "s" }, sRead.getRows()[0][0]).value,
      "2024-01-01 00:00:01",
    );
    assert.equal(
      readValue({ name: "tm", type: "timestamp", unit: "ms" }, sRead.getRows()[0][1]).value,
      "2024-01-01 00:00:00.25",
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

test("acceptKeyValue normalizes exact decimal and interval keys without rounding", () => {
  const dec2: Column = { name: "d", type: "decimal", precision: 4, scale: 2 };
  const dec0: Column = { name: "d0", type: "decimal", precision: 4, scale: 0 };
  const span: Column = { name: "s", type: "interval" };
  assert.equal(acceptKeyValue(null, dec2), null);
  assert.equal(acceptKeyValue(12 as never, dec2), null);
  assert.equal(acceptKeyValue("abc", dec2), null);
  assert.equal(acceptKeyValue("1.2300", dec2), "1.23");
  assert.equal(acceptKeyValue("-00.0", dec2), "0.00");
  assert.equal(acceptKeyValue("0", dec0), "0");
  assert.equal(acceptKeyValue("-12", dec0), "-12");
  assert.equal(acceptKeyValue("1.234", dec2), null);
  assert.equal(acceptKeyValue("123.45", dec2), null);
  assert.equal(acceptKeyValue(5 as never, span), null);
  assert.equal(acceptKeyValue("bad", span), null);
  assert.equal(acceptKeyValue("00:00:00.000000001", span), null);
  assert.equal(acceptKeyValue("1 year 2 months 3 days 04:05:06.5", span), "1 year 2 months 3 days 04:05:06.5");
});
