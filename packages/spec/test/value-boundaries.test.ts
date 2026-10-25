import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeBlock,
  encodeBlock,
  intervalText,
  isValueOf,
  type JsonValue,
  parseIntervalText,
  parseTimestampText,
  readCellText,
  type ValueType,
} from "../src/index.ts";

const min64 = -(2n ** 63n);
const max64 = 2n ** 63n - 1n;
const ns: ValueType = { type: "timestamp", unit: "ns" };
const f32: ValueType = { type: "float", bits: 32 };
const interval: ValueType = { type: "interval" };
const string: ValueType = { type: "string" };

const invalid: [ValueType, JsonValue][] = [
  [ns, "9999-12-31 23:59:59.999999999"],
  [ns, "1677-09-21 00:12:43.145224191"],
  [ns, "2262-04-11 23:47:16.854775808"],
  [f32, 1e39],
  [f32, -1e39],
  [f32, 0.1],
  [f32, 1e-50],
  [string, "\ud800"],
  [string, "a\udc00b"],
  [string, "\ud800\ud800"],
  [interval, intervalText({ months: 0, days: 0, nanos: min64 - 1n })],
  [interval, intervalText({ months: 0, days: 0, nanos: max64 + 1n })],
  [interval, "2147483648 months"],
  [interval, "-2147483649 days"],
  [interval, "9007199254740993 years"],
  [interval, "not an interval"],
  [{ type: "date" }, "0000-01-01"],
  [{ type: "timestamp" }, "0000-01-01 00:00:00"],
];

test("typed JSON rejects values that Arrow cannot preserve", () => {
  for (const [type, value] of invalid) {
    assert.equal(isValueOf(value, type), false, JSON.stringify([type, value]));
  }
});

test("block writers reject invalid values and identify their row and column", () => {
  for (const [type, value] of invalid) {
    assert.throws(
      () => encodeBlock([{ name: "value", ...type }], [[null], [value]]),
      (error: unknown) => error instanceof TypeError && "path" in error && error.path === "/rows/1/0",
      JSON.stringify([type, value]),
    );
  }
});

test("the limits themselves and valid Unicode survive blocks unchanged", () => {
  const valid: [ValueType, JsonValue][] = [
    [ns, "1677-09-21 00:12:43.145224192"],
    [ns, "2262-04-11 23:47:16.854775807"],
    [ns, "1969-12-31 23:59:59.999999999"],
    [f32, Math.fround(0.1)],
    [f32, 3.4028234663852886e38],
    [f32, -3.4028234663852886e38],
    [f32, 2 ** -149],
    [f32, -0],
    [f32, "NaN"],
    [f32, "Infinity"],
    [string, "日本語 😀 \ud800\udc00 \udbff\udfff ﻿"],
    [interval, intervalText({ months: -2147483648, days: -2147483648, nanos: min64 })],
    [interval, intervalText({ months: 2147483647, days: 2147483647, nanos: max64 })],
    [{ type: "date" }, "0001-01-01"],
    [{ type: "timestamp" }, "9999-12-31 23:59:59.999999"],
  ];
  for (const [type, value] of valid) {
    assert.ok(isValueOf(value, type), JSON.stringify([type, value]));
    assert.deepEqual(decodeBlock(encodeBlock([{ name: "value", ...type }], [[value]])).rows, [[value]]);
  }
});

test("calendar parsers refuse counts outside their Arrow integers", () => {
  assert.equal(parseTimestampText("1677-09-21 00:12:43.145224192", "ns"), min64);
  assert.equal(parseTimestampText("2262-04-11 23:47:16.854775807", "ns"), max64);
  assert.equal(parseTimestampText("1677-09-21 00:12:43.145224191", "ns"), null);
  assert.equal(parseTimestampText("2262-04-11 23:47:16.854775808", "ns"), null);
  assert.equal(parseIntervalText("2562047:47:16.854775808"), null);
  assert.equal(parseIntervalText("9007199254740993 years"), null);
  assert.deepEqual(parseIntervalText("9007199254740993 years -108086391056891915 months"), {
    months: 1,
    days: 0,
    nanos: 0n,
  });
});

test("editing rounds float32 before writing and refuses overflowing values", () => {
  for (const [text, value] of [
    ["0.1", Math.fround(0.1)],
    ["16777217", 16777216],
    ["1e-50", 0],
    ["-1e-50", 0],
  ] as const) {
    assert.deepEqual(readCellText(text, f32), { ok: true, value });
  }
  for (const text of ["1e39", "-1e39"]) assert.deepEqual(readCellText(text, f32), { ok: false, error: "range" });
  assert.deepEqual(readCellText("Infinity", f32), { ok: true, value: "Infinity" });
  assert.deepEqual(readCellText("9999-12-31 23:59:59.999999999", ns), { ok: false, error: "range" });
  assert.deepEqual(readCellText("\ud800", string), { ok: false, error: "unicode" });
});
