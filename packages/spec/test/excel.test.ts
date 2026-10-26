import assert from "node:assert/strict";
import { test } from "node:test";
import { excelNumberFormat } from "../src/excel.ts";

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
