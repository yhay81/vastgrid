import assert from "node:assert/strict";
import { test } from "node:test";
import { editText, type InputResult, readCellText, type ValueType } from "../src/index.ts";

const ok = (value: unknown): InputResult => ({ ok: true, value: value as never });
const no = (error: string): InputResult => ({ ok: false, error: error as never });

function reads(type: ValueType, cases: [string, InputResult][], grouping = false) {
  for (const [text, expected] of cases) {
    assert.deepEqual(readCellText(text, type, { grouping }), expected, `${type.type} ${JSON.stringify(text)}`);
  }
}

test("strings keep their text, and a text of only white space is null (§7.3)", () => {
  reads({ type: "string" }, [
    [" a ", ok(" a ")],
    ["", ok(null)],
    ["　\t", ok(null)],
    ["﻿", ok("﻿")],
  ]);
});

test("integers and bigints", () => {
  reads({ type: "integer" }, [
    [" 42 ", ok(42)],
    ["+7", ok(7)],
    ["-2147483648", ok(-2147483648)],
    ["2147483648", no("range")],
    ["1.5", no("integer")],
    ["1e3", no("integer")],
    ["0x10", no("number")],
    ["1_000", no("number")],
    ["", ok(null)],
  ]);
  reads({ type: "bigint" }, [
    ["9223372036854775807", ok("9223372036854775807")],
    ["9223372036854775808", no("range")],
    ["9007199254740991", ok(9007199254740991)],
    ["-9007199254740992", ok("-9007199254740992")],
  ]);
});

test("decimals have exactly their scale", () => {
  const type: ValueType = { type: "decimal", precision: 5, scale: 2 };
  reads(type, [
    ["1.5", ok("1.50")],
    ["-.5", ok("-0.50")],
    ["-0", ok("0.00")],
    ["001.20", ok("1.20")],
    ["1.500", ok("1.50")],
    ["1.005", no("scale")],
    ["1000", no("precision")],
    ["999.99", ok("999.99")],
    ["1e2", no("decimal")],
    ["abc", no("number")],
  ]);
  reads({ type: "decimal", precision: 3, scale: 0 }, [
    ["12.0", ok("12")],
    ["12.5", no("scale")],
  ]);
});

test("floats, with infinities, NaN and −0 read as 0", () => {
  reads({ type: "float" }, [
    ["0.1", ok(0.1)],
    ["-1e-5", ok(-0.00001)],
    ["inf", ok("Infinity")],
    ["-Infinity", ok("-Infinity")],
    ["+INF", ok("Infinity")],
    ["NaN", ok("NaN")],
    ["-0", ok(0)],
    ["1e400", no("range")],
    ["-nan", no("number")],
    ["1,5", no("number")],
  ]);
});

test("digit grouping is read when pasting", () => {
  reads(
    { type: "float" },
    [
      ["1,234.5", ok(1234.5)],
      ["12,34", no("number")],
    ],
    true,
  );
  reads({ type: "integer" }, [["-1,234,567", ok(-1234567)]], true);
  reads({ type: "integer" }, [["1,234", no("number")]], false);
  reads({ type: "string" }, [["1,234", ok("1,234")]], true);
});

test("booleans, dates and times", () => {
  reads({ type: "boolean" }, [
    ["TRUE", ok(true)],
    ["0", ok(false)],
    ["yes", no("boolean")],
  ]);
  reads({ type: "date" }, [
    ["2024-1-5", ok("2024-01-05")],
    ["2024/02/29", ok("2024-02-29")],
    ["2024.12.31", ok("2024-12-31")],
    ["2023-02-29", no("date")],
    ["24-01-05", no("date")],
    // Other years than 0000 to 9999 (§2.2), and the text form of §2.4 with its years BC.
    ["+010000-01-01", ok("+010000-01-01")],
    ["10000-1-1", ok("+010000-01-01")],
    ["-000001-12-31", ok("-000001-12-31")],
    ["0001-12-31 (BC)", ok("0000-12-31")],
    ["0002-01-01 bc", ok("-000001-01-01")],
    ["290309-12-22 (BC)", ok("-290308-12-22")],
    ["290309-12-21 (BC)", no("date")],
    ["0000-01-01 BC", no("date")],
    ["-000001-01-01 BC", no("date")],
  ]);
  reads({ type: "time" }, [
    ["9:05", ok("09:05:00")],
    ["23:59:59.500", ok("23:59:59.5")],
    ["00:00:00.000000", ok("00:00:00")],
    ["24:00", no("time")],
    ["12:00:00.1234567", no("time")],
  ]);
});

test("timestamps keep the digits of their unit, and timestamptz is UTC", () => {
  reads({ type: "timestamp" }, [
    ["2024-01-31", ok("2024-01-31 00:00:00")],
    ["2024-01-31T12:30", ok("2024-01-31 12:30:00")],
    ["2024-01-31 12:30:00.123456", ok("2024-01-31 12:30:00.123456")],
    ["2024-01-31 12:30:00.1234567", no("timestamp")],
    ["2024-01-31 12:30:00Z", no("timestamp")],
  ]);
  reads({ type: "timestamp" }, [
    ["0001-01-01 (BC) 12:00", ok("0000-01-01 12:00:00")],
    ["+010000-01-01T00:00:01", ok("+010000-01-01 00:00:01")],
  ]);
  reads({ type: "timestamp", unit: "ns" }, [["2024-01-31 12:30:00.123456789", ok("2024-01-31 12:30:00.123456789")]]);
  reads({ type: "timestamp", unit: "s" }, [["2024-01-31 12:30:00.5", no("timestamp")]]);
  reads({ type: "timestamptz" }, [
    ["2024-01-31 12:00:00+09", ok("2024-01-31 03:00:00+00")],
    ["2024-01-31 12:00:00-0530", ok("2024-01-31 17:30:00+00")],
    ["2024-01-31T00:30:00+01:00", ok("2024-01-30 23:30:00+00")],
    ["2024-01-31 12:00:00Z", ok("2024-01-31 12:00:00+00")],
    ["2024-01-31 12:00:00", ok("2024-01-31 12:00:00+00")],
    ["2024-01-31 12:00:00+24", no("timestamp")],
  ]);
});

test("timestamptz text without an offset is the time of day in the format's time zone (§7.3)", () => {
  const tz: ValueType = { type: "timestamptz" };
  const read = (text: string, timeZone: string) => readCellText(text, tz, { timeZone });
  assert.deepEqual(read("2024-01-31 12:00", "Asia/Tokyo"), ok("2024-01-31 03:00:00+00"));
  assert.deepEqual(read("2024-07-01 12:00", "America/New_York"), ok("2024-07-01 16:00:00+00"));
  assert.deepEqual(read("2024-01-31", "Asia/Kolkata"), ok("2024-01-30 18:30:00+00"));
  // An offset wins over the zone.
  assert.deepEqual(read("2024-01-31 12:00+01", "Asia/Tokyo"), ok("2024-01-31 11:00:00+00"));
  // A time that clocks skip is read with the offset before the change, and one they repeat is the earlier.
  assert.deepEqual(read("2024-03-10 02:30", "America/New_York"), ok("2024-03-10 07:30:00+00"));
  assert.deepEqual(read("2024-11-03 01:30", "America/New_York"), ok("2024-11-03 05:30:00+00"));
  assert.deepEqual(read("2024-01-31 12:00", "Not/AZone"), ok("2024-01-31 12:00:00+00"));

  assert.equal(editText("2024-01-31 03:00:00+00", tz, { timeZone: "Asia/Tokyo" }), "2024-01-31 12:00:00+09");
  assert.equal(editText("2024-01-31 03:00:00.5+00", tz, { timeZone: "Asia/Kolkata" }), "2024-01-31 08:30:00.5+05:30");
  assert.equal(editText("2024-11-03 06:30:00+00", tz, { timeZone: "America/New_York" }), "2024-11-03 01:30:00-05");
  assert.equal(editText("2024-01-31 03:00:00+00", tz, { timeZone: "Not/AZone" }), "2024-01-31 03:00:00+00");
  // The text an editor starts with reads back as the same instant, on either side of a change of clocks.
  for (const value of [
    "2024-11-03 05:30:00+00",
    "2024-11-03 06:30:00+00",
    "0001-01-01 00:00:00+00",
    "0000-01-01 00:00:00+00",
    "+010000-01-01 00:00:00+00",
  ]) {
    const text = editText(value, tz, { timeZone: "America/New_York" });
    assert.deepEqual(read(text, "America/New_York"), ok(value), text);
  }
});

test("UUIDs are lowercase with dashes; intervals and binary values are not typed", () => {
  reads({ type: "uuid" }, [
    ["A0EEBC999C0B4EF8BB6D6BB9BD380A11", ok("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")],
    ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1", no("uuid")],
  ]);
  reads({ type: "interval" }, [["1 day", no("type")]]);
  reads({ type: "binary" }, [["AA==", no("type")]]);
});

test("an editor starts with the text form, and with the empty string for null (§7.3)", () => {
  assert.equal(editText(null, { type: "integer" }), "");
  assert.equal(editText("12.50", { type: "decimal", precision: 4, scale: 2 }), "12.50");
  assert.equal(editText(1e21, { type: "float" }), "1e+21");
  assert.equal(editText(0.10000000149011612, { type: "float", bits: 32 }), "0.1");
  assert.equal(editText(true, { type: "boolean" }), "true");
  assert.equal(editText("AFw=", { type: "binary" }), "\\x00\\x5C");
});
