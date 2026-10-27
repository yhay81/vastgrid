import assert from "node:assert/strict";
import { test } from "node:test";
import { columnLetters, excelNumberFormat, MAX_SERIAL, serialOf, serialTime } from "../src/excel.ts";

test("maps column settings onto Excel number formats", () => {
  assert.equal(excelNumberFormat("float", undefined), null);
  assert.equal(excelNumberFormat("float", { label: "N" }), null);
  assert.equal(excelNumberFormat("float", { number: { fractionDigits: 2 } }), "#,##0.00");
  assert.equal(excelNumberFormat("float", { number: { fractionDigits: 2, grouping: false } }), "0.00");
  assert.equal(excelNumberFormat("float", { number: {} }), "#,##0.##########");
  assert.equal(excelNumberFormat("integer", { number: {} }), "#,##0");
  assert.equal(excelNumberFormat("float", { number: { style: "percent", fractionDigits: 1 } }), "#,##0.0%");
  assert.equal(
    excelNumberFormat("float", { number: { minimumFractionDigits: 1, maximumFractionDigits: 3, suffix: " kg" } }),
    '#,##0.0##" kg"',
  );
  assert.equal(
    excelNumberFormat("float", { number: { style: "currency", currency: "USD" } }, { locale: "en-US" }),
    '"$"#,##0.00',
  );
  assert.equal(
    excelNumberFormat("integer", { number: { style: "currency", currency: "JPY" } }, { locale: "ja-JP" }),
    '"￥"#,##0',
  );
  assert.equal(excelNumberFormat("float", { number: { notation: "scientific", fractionDigits: 2 } }), "0.00E+00");
  assert.equal(excelNumberFormat("float", { number: { notation: "compact" } }), null);
  assert.equal(
    excelNumberFormat("float", { number: { signDisplay: "always", fractionDigits: 0 } }),
    '"+"#,##0;"-"#,##0;"+"#,##0',
  );
  assert.equal(excelNumberFormat("timestamp", { date: { pattern: "yyyy/MM/dd HH:mm" } }), 'yyyy"/"mm"/"dd" "hh":"mm');
  assert.equal(
    excelNumberFormat("timestamp", { date: { pattern: "d MMM yyyy h:mm a" } }),
    'd" "mmm" "yyyy" "h":"mm" "AM/PM',
  );
  assert.equal(excelNumberFormat("timestamp", { date: { pattern: "HH:mm:ss.SSS 'Uhr'" } }), 'hh":"mm":"ss.000" Uhr"');
  assert.equal(excelNumberFormat("timestamp", { date: { pattern: "yyyy Q" } }), null);
  assert.equal(excelNumberFormat("float", { number: { prefix: 'a"b' } }), '"a"\\""b"#,##0.##########');
  assert.equal(excelNumberFormat("timestamp", { date: { dateStyle: "long" } }), null);
});

test("counts date serial numbers as Excel does", () => {
  const day = 86_400_000;
  assert.equal(serialTime(1, false), Date.UTC(1900, 0, 1));
  // Serial number 60 is the 29 February 1900 that did not exist.
  assert.equal(serialTime(60, false), Date.UTC(1900, 2, 1));
  assert.equal(serialTime(61, false), Date.UTC(1900, 2, 1));
  assert.equal(serialTime(45_322.25, false), Date.UTC(2024, 0, 31, 6));
  assert.equal(serialTime(0, true), Date.UTC(1904, 0, 1));
  assert.equal(serialOf(Date.UTC(2024, 0, 31) / day, 6 * 3600), 45_322.25);
  assert.equal(serialOf(Date.UTC(1900, 2, 1) / day, 0), 61);
  assert.equal(serialOf(Date.UTC(1900, 1, 28) / day, 0), null);
  assert.equal(serialOf(Date.UTC(9999, 11, 31) / day, 0), MAX_SERIAL - 1);
  assert.equal(serialOf(Date.UTC(10000, 0, 1) / day, 0), null);
});

test("names columns with Excel's letters", () => {
  assert.deepEqual([0, 25, 26, 701, 702, 16_383].map(columnLetters), ["A", "Z", "AA", "ZZ", "AAA", "XFD"]);
});
