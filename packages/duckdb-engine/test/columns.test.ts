import assert from "node:assert/strict";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { BlockValueError, type Column, encodeBlock } from "vastgrid-spec";
import { readExpression, readValue } from "../src/columns.ts";

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
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
