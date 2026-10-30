import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decimalTextType,
  floatText,
  isDateText,
  isTimestampText,
  isTimeText,
  isValueOf,
  parseTimestampText,
  trimSpaces,
  valueOfText,
} from "../src/index.ts";

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
  // The smallest and the largest 32-bit floats, and the smallest normal one.
  assert.equal(floatText(2 ** -149, 32), "1e-45");
  assert.equal(floatText(-(2 ** -149), 32), "-1e-45");
  assert.equal(floatText(2 ** -126, 32), "1.1754944e-38");
  assert.equal(floatText(-3.4028234663852886e38, 32), "-3.4028235e+38");
});

test("32-bit powers of two take the shortest digits on the far side of their nearer neighbor", () => {
  // The float below a power of two is twice as near as the float above it: the nearest eight digits of 2^-96 read
  // back as the float below, and the other eight digits as 2^-96 itself.
  assert.equal(floatText(2 ** -96, 32), "1.2621775e-29");
  assert.equal(floatText(2 ** 87, 32), "1.5474251e+26");
  assert.equal(floatText(2 ** 90, 32), "1.2379401e+27");
  assert.equal(floatText(-(2 ** 90), 32), "-1.2379401e+27");
  // Every 32-bit power of two reads back as itself, with no more digits than it needs.
  for (let power = -149; power <= 127; power++) {
    const text = floatText(2 ** power, 32);
    assert.equal(Math.fround(Number(text)), 2 ** power, text);
    const digits = text
      .replace(/e.*$/, "")
      .replace(/[-.]/g, "")
      .replace(/^0+|0+$/g, "");
    assert.ok(digits.length <= 9, text);
  }
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
  assert.equal(valueOfText("0.1", { type: "float", bits: 32 }), Math.fround(0.1));
  assert.equal(valueOfText("nan", { type: "float" }), "NaN");
  assert.equal(valueOfText("-inf", { type: "float" }), "-Infinity");
  assert.equal(valueOfText("1.5", { type: "float" }), 1.5);
  assert.equal(valueOfText("9223372036854775807", { type: "bigint" }), "9223372036854775807");
  assert.equal(valueOfText("42", { type: "bigint" }), 42);
  assert.equal(valueOfText("true", { type: "boolean" }), true);
  assert.equal(valueOfText("1.50", { type: "decimal", precision: 10, scale: 2 }), "1.50");
  assert.equal(valueOfText(null, { type: "string" }), null);
});

test("dates, times and timestamps read as the regular expressions of §2.2 read them", () => {
  // The forms as they were written before they were read character by character.
  const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = (year: number, month: number, date: number) =>
    month >= 1 &&
    month <= 12 &&
    date >= 1 &&
    date <= [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const dateForm = (text: string) => {
    const match = /^([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})$/.exec(text);
    if (match === null || match[1] === "-000000" || (match[1][0] === "+" && Number(match[1]) <= 9999)) return false;
    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // From -290308-12-22 to +294247-01-10.
    const order = year * 10_000 + month * 100 + date;
    return day(year, month, date) && order >= -2_903_080_000 + 1222 && order <= 2_942_470_110;
  };
  const timeForm = (text: string, digits: number) => {
    const match = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*[1-9]))?$/.exec(text);
    return (
      match !== null &&
      Number(match[1]) < 24 &&
      Number(match[2]) < 60 &&
      Number(match[3]) < 60 &&
      (match[4]?.length ?? 0) <= digits
    );
  };
  const units = { s: 0, ms: 3, us: 6, ns: 9 } as const;
  const timestampForm = (text: string, unit: keyof typeof units) => {
    const space = text.indexOf(" ");
    return (
      (space === 10 || space === 13) &&
      dateForm(text.slice(0, space)) &&
      timeForm(text.slice(space + 1), units[unit]) &&
      (unit !== "ns" || parseTimestampText(text, unit) !== null)
    );
  };
  const samples = [
    "2024-02-29",
    "2023-02-29",
    "1900-02-29",
    "2000-02-29",
    "0000-01-01",
    "0000-02-29",
    "9999-12-31",
    "10000-01-01",
    "+010000-01-01",
    "+002024-01-01",
    "-000000-01-01",
    "-000001-02-29",
    "-000004-02-29",
    "+294247-01-10",
    "+294247-01-11",
    "-290308-12-22",
    "-290308-12-21",
    "-290308-12-22 00:00:00",
    "+010000-01-01 12:00:00.5",
    "2024-13-01",
    "2024-00-10",
    "2024-01-00",
    "2024-1-01",
    "2024-01-1",
    "２０２４-01-01",
    "2024/01/01",
    "2024-01-01 ",
    "",
    "23:59:59",
    "24:00:00",
    "00:60:00",
    "00:00:60",
    "01:02:03.5",
    "01:02:03.50",
    "01:02:03.",
    "01:02:03.123456",
    "01:02:03.1234567",
    "1:02:03",
    "01:02:03.12a",
    "2024-01-31 12:00:00",
    "2024-01-31 12:00:00.5",
    "2024-01-31T12:00:00",
    "2024-01-31  12:00:00",
    "2024-01-31 12:00:00.123456789",
    "2024-01-31 12:00:00.1234567890",
    "2024-01-31 12:00:00+00",
  ];
  let seed = 1;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const alphabet = "0123456789:-. 0123456789";
  for (let index = 0; index < 20_000; index++) {
    const base = samples[Math.floor(random() * samples.length)];
    const chars = [...base];
    const edits = 1 + Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit++) {
      const at = Math.floor(random() * (chars.length + 1));
      const char = alphabet[Math.floor(random() * alphabet.length)];
      if (random() < 0.5) chars.splice(at, 1, char);
      else chars.splice(at, 0, char);
    }
    samples.push(chars.join(""));
  }
  for (const text of samples) {
    assert.equal(isDateText(text), dateForm(text), `date ${JSON.stringify(text)}`);
    for (const digits of [0, 3, 6, 9])
      assert.equal(isTimeText(text, digits), timeForm(text, digits), `time ${JSON.stringify(text)}`);
    for (const unit of ["s", "ms", "us", "ns"] as const) {
      assert.equal(isTimestampText(text, unit), timestampForm(text, unit), `timestamp ${unit} ${JSON.stringify(text)}`);
    }
  }
});
