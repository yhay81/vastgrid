import assert from "node:assert/strict";
import { test } from "node:test";
import { toHtmlTable, toMarkdownTable, toTsv } from "../src/clipboard.ts";
import { numericValue, plainText, ValueFormatter } from "../src/format.ts";

test("formats numbers with grouping and exact big values", () => {
  const format = new ValueFormatter({ locale: "en-US" });
  assert.equal(format.format(1234567, "integer"), "1,234,567");
  assert.equal(format.format(0.1 + 0.2, "float"), "0.3");
  assert.equal(format.format(1234.5, "float"), "1,234.5");
  assert.equal(format.format("9007199254740993", "bigint"), "9,007,199,254,740,993");
  assert.equal(format.format("-1234567.50", "decimal"), "-1,234,567.50");
  assert.equal(format.format("NaN", "float"), "NaN");
  assert.equal(format.format("Infinity", "float"), "∞");
  assert.equal(format.format(1e20, "float"), "1E20");
  assert.equal(format.format(null, "integer"), "");
  assert.equal(new ValueFormatter({ nullText: "NULL" }).format(null, "string"), "NULL");
  assert.equal(new ValueFormatter({ locale: "de-DE" }).format(1234.5, "float"), "1.234,5");
});

test("shows text on one line and cuts long text", () => {
  const format = new ValueFormatter({ maxLength: 5 });
  assert.equal(format.format("ab\ncdef", "string"), "ab ↵ cd…");
  assert.equal(new ValueFormatter().format("a\tb", "string"), "a ⇥ b");
  assert.equal(new ValueFormatter().format(true, "boolean"), "TRUE");
});

test("reads numbers from numeric values only", () => {
  assert.equal(numericValue("12.5", "decimal"), 12.5);
  assert.equal(numericValue("12.5", "string"), null);
  assert.equal(numericValue("", "decimal"), null);
  assert.equal(numericValue(Number.NaN), null);
  assert.equal(plainText(null), "");
  assert.equal(plainText(false), "FALSE");
});

test("clipboard formats quote like Excel", () => {
  assert.equal(
    toTsv([
      ["a", "b\tc"],
      ['say "hi"', "x\ny"],
    ]),
    'a\t"b\tc"\n"say ""hi"""\t"x\ny"',
  );
  assert.equal(
    toHtmlTable([["<b>", "a&b"]], 1),
    '<meta charset="utf-8"><table><tr><th>&lt;b&gt;</th><th>a&amp;b</th></tr></table>',
  );
  assert.equal(toMarkdownTable(["a|b"], [["1\n2"]]), "| a\\|b |\n| --- |\n| 1<br>2 |");
});

test("columns of the same type take different number formats", () => {
  const format = new ValueFormatter({ locale: "en-US" });
  const price = format.column({ name: "price", type: "float" }, { number: { style: "currency", currency: "USD" } });
  const rate = format.column({ name: "rate", type: "float" }, { number: { style: "percent", fractionDigits: 1 } });
  const plain = format.column({ name: "count", type: "float" }, { number: { fractionDigits: 3, grouping: false } });
  assert.equal(price.format(1234.5), "$1,234.50");
  assert.equal(rate.format(0.1234), "12.3%");
  assert.equal(plain.format(1234.5), "1234.500");
  assert.equal(
    format
      .column({ name: "c", type: "float" }, { number: { style: "currency", currency: "USD", fractionDigits: 0 } })
      .format(2.5),
    "$3",
  );
  assert.equal(
    format.column({ name: "w", type: "float" }, { number: { maximumFractionDigits: 1, suffix: " kg" } }).format(2.25),
    "2.3 kg",
  );
  assert.equal(
    format
      .column({ name: "s", type: "integer" }, { number: { notation: "scientific", maximumFractionDigits: 2 } })
      .format(123456),
    "1.23E5",
  );
  assert.throws(() => format.column({ name: "x", type: "float" }, { number: { style: "currency" } }), RangeError);
});

test("number formats keep the digits of 64-bit integers and decimals", () => {
  const format = new ValueFormatter({ locale: "en-US" });
  const big = format.column({ name: "id", type: "bigint" }, { number: { fractionDigits: 2 } });
  assert.equal(big.format("9007199254740993"), "9,007,199,254,740,993.00");
  const money = format.column(
    { name: "amount", type: "decimal" },
    { number: { style: "currency", currency: "JPY", currencyDisplay: "code" } },
  );
  assert.equal(money.format("12345678901234567890").replace(/\s/g, " "), "JPY 12,345,678,901,234,567,890");
  const exact = format.column({ name: "d", type: "decimal" }, { number: { fractionDigits: 2 } });
  // 0.125 rounds half away from zero from its exact digits, and 38 digits stay exact.
  assert.equal(exact.format("0.125"), "0.13");
  assert.equal(
    exact.format("-12345678901234567890123456789012345.675"),
    "-12,345,678,901,234,567,890,123,456,789,012,345.68",
  );
  // Values that are not finite numbers keep the grid's own text.
  assert.equal(exact.format("NaN"), "NaN");
  assert.equal(exact.format("-inf"), "-∞");
  assert.equal(exact.format(null), "");
  // Text in a column read as text is formatted when it is a number.
  const text = format.column({ name: "t", type: "string" }, { number: { fractionDigits: 1 } });
  assert.equal(text.format("12"), "12.0");
  assert.equal(text.format("n/a"), "n/a");
  assert.equal(text.align, "right");
});

test("columns of the same type take different date formats", () => {
  const format = new ValueFormatter({ locale: "en-US" });
  const day = format.column({ name: "day", type: "date" }, { date: { pattern: "yyyy/MM/dd (EEE)" } });
  const month = format.column({ name: "month", type: "date" }, { date: { pattern: "MMMM yyyy" } });
  const long = format.column({ name: "long", type: "date" }, { date: { dateStyle: "long" } });
  assert.equal(day.format("2024-03-04"), "2024/03/04 (Mon)");
  assert.equal(month.format("2024-03-04"), "March 2024");
  assert.equal(long.format("2024-03-04"), "March 4, 2024");
  const time = format.column(
    { name: "at", type: "timestamp" },
    { date: { pattern: "d.M.yy h:mm:ss.SSS a 'o''clock'" } },
  );
  assert.equal(time.format("2024-03-04 13:05:06.789123"), "4.3.24 1:05:06.789 PM o'clock");
  // Values without an offset are shown as they are, in no time zone.
  const wall = format.column({ name: "w", type: "timestamp" }, { date: { pattern: "HH:mm", timeZone: "Asia/Tokyo" } });
  assert.equal(wall.format("2024-03-04 23:30:00"), "23:30");
  // Values with an offset move to the time zone.
  const zoned = format.column(
    { name: "z", type: "timestamptz" },
    { date: { pattern: "yyyy-MM-dd HH:mm", timeZone: "Asia/Tokyo" } },
  );
  assert.equal(zoned.format("2024-03-04 20:30:00+00"), "2024-03-05 05:30");
  assert.equal(zoned.format("2024-03-04T20:30:00-05:00"), "2024-03-05 10:30");
  const intl = format.column({ name: "i", type: "timestamptz" }, { date: { timeStyle: "short", timeZone: "UTC" } });
  assert.equal(intl.format("2024-03-04 20:30:00+09"), "11:30 AM");
  const clock = format.column({ name: "c", type: "time" }, { date: { pattern: "h:mm a" } });
  assert.equal(clock.format("00:05:00"), "12:05 AM");
  // Text that is not a date keeps the grid's own text.
  assert.equal(day.format("infinity"), "infinity");
  assert.throws(() => format.column({ name: "x", type: "date" }, { date: { timeZone: "Nowhere/City" } }), RangeError);
});

test("column labels, alignment and format functions", () => {
  const format = new ValueFormatter({ locale: "en-US", nullText: "—" });
  const schema = { name: "flag", type: "boolean" } as const;
  const column = format.column(schema, {
    label: "Active",
    align: "center",
    format: (value, { column, text }) => (value === null ? text : `${column.name}: ${value ? "yes" : "no"}`),
  });
  assert.equal(column.label, "Active");
  assert.equal(column.align, "center");
  assert.equal(column.format(true), "flag: yes");
  assert.equal(column.format(null), "—");
  assert.equal(format.column({ name: "n", type: "integer" }).align, "right");
  assert.equal(format.column({ name: "n", type: "integer" }).label, "n");
  // The function's text is shown in one line, and copied as it is.
  const lines = format.column({ name: "l", type: "string" }, { format: (_, { text }) => `${text}\nend` });
  assert.equal(lines.format("a"), "a ↵ end");
  assert.equal(lines.copyText("a", "formatted"), "a\nend");
  assert.equal(lines.copyText("a", "raw"), "a");
});

test("copied text is the value or the shown text", () => {
  const format = new ValueFormatter({ locale: "en-US" });
  const price = format.column({ name: "price", type: "decimal" }, { number: { style: "currency", currency: "USD" } });
  assert.equal(price.copyText("1234.5", "raw"), "1234.5");
  assert.equal(price.copyText("1234.5", "formatted"), "$1,234.50");
  assert.equal(price.copyText(null, "raw"), "");
  const always = format.column({ name: "p", type: "decimal" }, { number: { fractionDigits: 0 }, copy: "formatted" });
  assert.equal(always.copyText("1234.5", "raw"), "1,235");
  // Without settings, a column formats like ValueFormatter.format.
  const plain = format.column({ name: "x", type: "bigint" });
  assert.equal(plain.format("9007199254740993"), format.format("9007199254740993", "bigint"));
  assert.equal(plain.text("9007199254740993"), "9,007,199,254,740,993");
});

test("a column's style setting colors cells by value and gets the shown text", () => {
  const base = new ValueFormatter({ locale: "en-US" });
  const seen: string[] = [];
  const formatter = base.column(
    { name: "amount", type: "integer" },
    {
      number: { prefix: "$" },
      style: (value, { column, text }) => {
        seen.push(`${column.name}:${text}`);
        return typeof value === "number" && value < 0 ? { color: "red", description: "Negative" } : null;
      },
    },
  );
  assert.equal(formatter.styled, true);
  assert.deepEqual(formatter.style(-1200), { color: "red", description: "Negative" });
  assert.equal(formatter.style(5), null);
  assert.equal(formatter.style(null), null);
  assert.deepEqual(seen, ["amount:$-1,200", "amount:$5", "amount:"]);
  const plain = base.column({ name: "other", type: "integer" }, {});
  assert.equal(plain.styled, false);
  assert.equal(plain.style(-1), null);
});
