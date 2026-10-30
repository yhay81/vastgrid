import assert from "node:assert/strict";
import { test } from "node:test";
import { type Column, type Expr, formatterFor, type JsonValue } from "vastgrid-spec";
import { compileRule } from "../src/core/evaluate.ts";
import { filterParts } from "../src/core/filters.ts";

const columns: Column[] = [
  { name: "city", type: "string" },
  { name: "qty", type: "integer" },
  { name: "price", type: "decimal", precision: 10, scale: 2 },
  { name: "rate", type: "float", bits: 64 },
  { name: "day", type: "date" },
  { name: "at", type: "timestamptz" },
];

const reader = (row: Record<string, JsonValue>) => (name: string) => row[name];

test("numbers and dates show by their format; other formats leave the text form", () => {
  const price = formatterFor(columns[2], { number: { style: "currency", currency: "JPY" } }, "ja-JP");
  assert.equal(price?.("1234.50"), "￥1,235");
  const exact = formatterFor(columns[2], { number: { fractionDigits: 2, prefix: "≈" } }, "en-US");
  assert.equal(exact?.("12345678901234567.25"), "≈12,345,678,901,234,567.25");
  assert.equal(
    formatterFor(columns[3], { number: { style: "percent", fractionDigits: 1 } }, "en-US")?.(0.125),
    "12.5%",
  );
  assert.equal(
    formatterFor(columns[4], { date: { pattern: "yyyy/MM/dd (EEE)" } }, "en-US")?.("2024-02-29"),
    "2024/02/29 (Thu)",
  );
  assert.equal(
    formatterFor(
      columns[5],
      { date: { pattern: "yyyy-MM-dd HH:mm", timeZone: "Asia/Tokyo" } },
      "en-US",
    )?.("2024-01-31 20:00:00+00"),
    "2024-02-01 05:00",
  );
  assert.equal(formatterFor(columns[0], { number: { style: "percent" } }, "en-US"), null);
  assert.equal(formatterFor(columns[1], {}, "en-US"), null);
  // A currency that Intl does not know leaves the text form.
  assert.equal(formatterFor(columns[1], { number: { style: "currency" } }, "en-US"), null);
});

test("date patterns: text in quotes, two quotes as a quote, 12-hour clocks, fractions and short years", () => {
  const timestamp: Column = { name: "t", type: "timestamp" };
  const show = (pattern: string, value: string, column = timestamp) =>
    formatterFor(column, { date: { pattern } }, "en-US")?.(value);
  assert.equal(show("yyyy''MM", "2024-02-29 00:00:00"), "2024'02");
  assert.equal(show("h 'o''clock'", "2024-02-29 15:00:00"), "3 o'clock");
  assert.equal(show("'yyyy' yyyy", "2024-02-29 00:00:00"), "yyyy 2024");
  // Midnight and noon are 12 on a 12-hour clock.
  assert.equal(show("hh:mm a", "2024-02-29 00:05:00"), "12:05 AM");
  assert.equal(show("hh:mm a", "2024-02-29 12:00:00"), "12:00 PM");
  assert.equal(show("H:m:s", "2024-02-29 09:05:07"), "9:5:7");
  // Fraction digits are cut, not rounded, and filled with zeros.
  assert.equal(show("ss.SSS", "2024-02-29 10:00:05.25"), "05.250");
  assert.equal(show("ss.S", "2024-02-29 10:00:05.999"), "05.9");
  assert.equal(show("yy/M/d", "2009-01-05 00:00:00"), "09/1/5");
  assert.equal(show("yyyy-MM-dd", "0099-12-31", columns[4]), "0099-12-31");
});

test("style rules evaluate the conditions that the menus write, with nulls as §3.6 has them", () => {
  const rule = (when: Expr) => {
    const compiled = compileRule(when, columns);
    if (!compiled) throw new Error("compiles");
    return compiled.rule;
  };
  const parts = (column: Column, operator: string, first: string, second = "") =>
    filterParts({ kind: "condition", operator, first, second } as never, column);
  const and = (list: Expr[]): Expr => (list.length === 1 ? list[0] : { fn: "and", args: list });
  const row = { city: "Tokyo", qty: 5, price: "10.50", rate: Number.NaN, day: "2024-03-01", at: null };
  assert.equal(rule(and(parts(columns[1], "gt", "4")))(reader(row)), true);
  assert.equal(rule(and(parts(columns[2], "between", "10.5", "10.50")))(reader(row)), true);
  assert.equal(rule(and(parts(columns[2], "lt", "9.99")))(reader(row)), false);
  assert.equal(rule(and(parts(columns[0], "contains", "KY")))(reader(row)), true);
  assert.equal(rule(and(parts(columns[0], "notContains", "ky")))(reader(row)), false);
  assert.equal(rule(and(parts(columns[4], "ge", "2024-02-29")))(reader(row)), true);
  // NaN is the greatest number; a null compares to nothing.
  assert.equal(rule(and(parts(columns[3], "gt", "1e308")))(reader(row)), true);
  assert.equal(rule(and(parts(columns[5], "notBlank", "")))(reader(row)), false);
  assert.equal(
    rule({ fn: "gt", args: [{ col: "at" }, { lit: "2024-01-01 00:00:00+00", type: "timestamptz" }] })(reader(row)),
    null,
  );
  assert.equal(
    rule({ fn: "or", args: [{ fn: "gt", args: [{ col: "at" }, { lit: "x" }] }, { lit: true }] })(reader(row)),
    true,
  );
  assert.equal(rule({ fn: "in", args: [{ col: "city" }, { lit: "Osaka" }, { lit: "Tokyo" }] })(reader(row)), true);
  // Values not read yet, and expressions the grid does not evaluate.
  assert.equal(
    rule(and(parts(columns[1], "gt", "4")))(() => undefined),
    undefined,
  );
  assert.equal(compileRule({ fn: "gt", args: [{ fn: "length", args: [{ col: "city" }] }, { lit: 3 }] }, columns), null);
  assert.equal(compileRule({ fn: "gt", args: [{ col: "nothing" }, { lit: 3 }] }, columns), null);
  assert.deepEqual(compileRule(and(parts(columns[1], "gt", "4")), columns)?.columns, ["qty"]);
});
