import assert from "node:assert/strict";
import { test } from "node:test";
import {
  civilFromDays,
  dateText,
  daysFromCivil,
  FIRST_DAY,
  intervalText,
  LAST_DAY,
  parseDateText,
  parseIntervalText,
  parseTimestampText,
  parseTimeText,
  temporalTextForm,
  timestampText,
  timeText,
} from "../src/index.ts";

test("days and dates agree over every date (§2.2)", () => {
  for (let days = FIRST_DAY; days <= LAST_DAY; days += 99_991) {
    const [year, month, day] = civilFromDays(days);
    assert.equal(daysFromCivil(year, month, day), days);
    assert.equal(parseDateText(dateText(days)), days);
  }
  assert.equal(dateText(0), "1970-01-01");
  assert.equal(dateText(-1), "1969-12-31");
  assert.equal(dateText(daysFromCivil(2000, 2, 29)), "2000-02-29");
  assert.equal(dateText(daysFromCivil(0, 12, 31)), "0000-12-31");
  assert.equal(dateText(daysFromCivil(-1, 1, 1)), "-000001-01-01");
  assert.equal(dateText(daysFromCivil(10000, 1, 1)), "+010000-01-01");
  assert.equal(dateText(FIRST_DAY), "-290308-12-22");
  assert.equal(dateText(LAST_DAY), "+294247-01-10");
  assert.throws(() => dateText(FIRST_DAY - 1), RangeError);
  assert.throws(() => dateText(LAST_DAY + 1), RangeError);
  assert.equal(parseDateText("1900-02-29"), null);
  assert.equal(parseDateText("0000-01-01"), daysFromCivil(0, 1, 1));
  // The years 0000 to 9999 have four digits only, and other years six.
  for (const text of ["+002024-01-01", "-000000-01-01", "10000-01-01", "+10000-01-01", "-290308-12-21"])
    assert.equal(parseDateText(text), null, text);
});

test("dates, timestamps and timestamptz have DuckDB's text form (§2.4)", () => {
  assert.equal(temporalTextForm("2024-01-01"), "2024-01-01");
  assert.equal(temporalTextForm("+010000-01-01"), "10000-01-01");
  assert.equal(temporalTextForm("0000-12-31"), "0001-12-31 (BC)");
  assert.equal(temporalTextForm("-000001-01-01 12:00:00"), "0002-01-01 (BC) 12:00:00");
  assert.equal(temporalTextForm("-290308-12-22 00:00:00+00"), "290309-12-22 (BC) 00:00:00+00");
  assert.equal(timestampText(parseTimestampText("+010000-01-01 00:00:01") as bigint), "+010000-01-01 00:00:01");
});

test("times and timestamps are written without trailing zeros (§2.2)", () => {
  assert.equal(timeText(0n), "00:00:00");
  assert.equal(timeText(86_399_999_999n), "23:59:59.999999");
  assert.equal(timeText(1_500_000n), "00:00:01.5");
  assert.throws(() => timeText(86_400_000_000n), RangeError);
  assert.equal(parseTimeText("12:00:00.25"), 43_200_250_000n);
  assert.equal(timestampText(-1n, "us"), "1969-12-31 23:59:59.999999");
  assert.equal(timestampText(-1n, "ns"), "1969-12-31 23:59:59.999999999");
  assert.equal(timestampText(1n, "s"), "1970-01-01 00:00:01");
  assert.equal(timestampText(1500n, "ms"), "1970-01-01 00:00:01.5");
  for (const text of ["0001-01-01 00:00:00", "9999-12-31 23:59:59.999999", "1969-07-20 20:17:40.5"]) {
    assert.equal(timestampText(parseTimestampText(text) as bigint), text);
  }
  assert.equal(parseTimestampText("2024-01-31 12:00:00.1234567", "us"), null);
  assert.equal(parseTimestampText("2024-01-31T12:00:00"), null);
});

test("intervals are written as DuckDB writes them (§2.4)", () => {
  const cases: [number, number, bigint, string][] = [
    [14, 3, 14_706_789_000_000n, "1 year 2 months 3 days 04:05:06.789"],
    [0, 0, -5_400_000_000_000n, "-01:30:00"],
    [0, 0, 0n, "00:00:00"],
    [0, 0, 129_600_000_000_000n, "36:00:00"],
    [1, 1, 0n, "1 month 1 day"],
    [-14, -1, 0n, "-1 year -2 months -1 day"],
    [12, 0, 1_000n, "1 year 00:00:00.000001"],
    [0, 2, 1n, "2 days 00:00:00.000000001"],
  ];
  for (const [months, days, nanos, text] of cases) {
    assert.equal(intervalText({ months, days, nanos }), text);
    assert.deepEqual(parseIntervalText(text), { months, days, nanos });
  }
  assert.deepEqual(parseIntervalText("2 years"), { months: 24, days: 0, nanos: 0n });
  assert.equal(parseIntervalText(""), null);
  assert.equal(parseIntervalText("1 week"), null);
  assert.equal(parseIntervalText("1 day "), null);
  assert.equal(parseIntervalText("01:60:00"), null);
});
