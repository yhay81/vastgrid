import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalTextType, floatText, isValueOf, trimSpaces, valueOfText } from "../src/index.ts";

test("floats are written as DuckDB and Python write them (§2.4.1)", () => {
  const cases: [number, string][] = [
    [1, "1.0"],
    [100, "100.0"],
    [0.5, "0.5"],
    [-1234.5, "-1234.5"],
    [0.1, "0.1"],
    [1 / 3, "0.3333333333333333"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [0.000123, "0.000123"],
    [1e-7, "1e-07"],
    [123456789012345.6, "123456789012345.6"],
    [1234567890123456.8, "1234567890123456.8"],
    [9999999999999998, "9999999999999998.0"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1e20, "1e+20"],
    [1.2345678901234567e19, "1.2345678901234567e+19"],
    [1e100, "1e+100"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [0, "0.0"],
    [-0, "-0.0"],
    [Number.NaN, "nan"],
    [Number.POSITIVE_INFINITY, "inf"],
    [Number.NEGATIVE_INFINITY, "-inf"],
  ];
  for (const [value, text] of cases) assert.equal(floatText(value), text, String(value));
});

test("32-bit floats have the shortest digits of 32 bits", () => {
  assert.equal(floatText(0.1, 32), "0.1");
  assert.equal(floatText(Math.fround(0.1), 32), "0.1");
  assert.equal(floatText(16777217, 32), "16777216.0");
  assert.equal(floatText(1e10, 32), "10000000000.0");
  assert.equal(floatText(3.4028234663852886e38, 32), "3.4028235e+38");
  assert.equal(floatText(1.5e-7, 32), "1.5e-07");
  assert.equal(floatText(Math.fround(0.1), 64), "0.10000000149011612");
});

test("decimal literals take their precision and scale from their digits (§2.5)", () => {
  assert.deepEqual(decimalTextType("12.50"), { precision: 4, scale: 2 });
  assert.deepEqual(decimalTextType("0.10"), { precision: 2, scale: 2 });
  assert.deepEqual(decimalTextType("-0.001"), { precision: 3, scale: 3 });
  assert.deepEqual(decimalTextType("7"), { precision: 1, scale: 0 });
  assert.deepEqual(decimalTextType("0"), { precision: 1, scale: 0 });
  assert.equal(decimalTextType("1.2.3"), null);
  assert.equal(decimalTextType("01.5"), null);
  assert.equal(decimalTextType("1e3"), null);
  assert.equal(decimalTextType("+1"), null);
  assert.equal(decimalTextType("1".repeat(39)), null);
});

test("values are checked as JSON writes them for their type (§2.2)", () => {
  const valid: [unknown, Parameters<typeof isValueOf>[1]][] = [
    [42, { type: "integer" }],
    ["9223372036854775807", { type: "bigint" }],
    [9007199254740991, { type: "bigint" }],
    ["12.50", { type: "decimal", precision: 4, scale: 2 }],
    ["-0.10", { type: "decimal", precision: 10, scale: 2 }],
    ["NaN", { type: "float" }],
    [0.1, { type: "float" }],
    ["2024-02-29", { type: "date" }],
    ["23:59:59.999999", { type: "time" }],
    ["2024-01-31 12:00:00.5", { type: "timestamp" }],
    ["2024-01-31 12:00:00.123456789", { type: "timestamp", unit: "ns" }],
    ["2024-01-31 03:00:00+00", { type: "timestamptz" }],
    ["00000000-0000-0000-0000-000000000001", { type: "uuid" }],
    ["AAEC", { type: "binary" }],
    [null, { type: "date" }],
  ];
  for (const [value, type] of valid) assert.ok(isValueOf(value as never, type), JSON.stringify([value, type]));
  const invalid: [unknown, Parameters<typeof isValueOf>[1]][] = [
    [1.5, { type: "integer" }],
    [2147483648, { type: "integer" }],
    ["9223372036854775808", { type: "bigint" }],
    [2 ** 53, { type: "bigint" }],
    ["12.5", { type: "decimal", precision: 4, scale: 2 }],
    ["123.50", { type: "decimal", precision: 4, scale: 2 }],
    [12.5, { type: "decimal", precision: 4, scale: 2 }],
    ["nan", { type: "float" }],
    ["2023-02-29", { type: "date" }],
    ["24:00:00", { type: "time" }],
    ["2024-01-31 12:00:00.50", { type: "timestamp" }],
    ["2024-01-31T12:00:00", { type: "timestamp" }],
    ["2024-01-31 12:00:00.1234567", { type: "timestamp" }],
    ["2024-01-31 12:00:00+09", { type: "timestamptz" }],
    ["0000000-0000-0000-0000-000000000001", { type: "uuid" }],
    ["AAE", { type: "binary" }],
    ["true", { type: "boolean" }],
  ];
  for (const [value, type] of invalid) assert.ok(!isValueOf(value as never, type), JSON.stringify([value, type]));
});

test("trim removes space separators only (§4.4)", () => {
  assert.equal(trimSpaces(" \t a \n "), "\t a \n");
  assert.equal(trimSpaces("　a　"), "a");
  assert.equal(trimSpaces("  a"), "a");
  assert.equal(trimSpaces("﻿a﻿"), "﻿a﻿");
  assert.equal(trimSpaces("​a"), "​a");
});

test("text forms read back as typed JSON", () => {
  assert.equal(valueOfText("nan", { type: "float" }), "NaN");
  assert.equal(valueOfText("-inf", { type: "float" }), "-Infinity");
  assert.equal(valueOfText("1.5", { type: "float" }), 1.5);
  assert.equal(valueOfText("9223372036854775807", { type: "bigint" }), "9223372036854775807");
  assert.equal(valueOfText("42", { type: "bigint" }), 42);
  assert.equal(valueOfText("true", { type: "boolean" }), true);
  assert.equal(valueOfText("1.50", { type: "decimal", precision: 10, scale: 2 }), "1.50");
  assert.equal(valueOfText(null, { type: "string" }), null);
});
