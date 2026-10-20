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
