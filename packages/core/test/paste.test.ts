import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCellInput } from "../src/cell-input.ts";
import { parseHtmlTable, parseTsv, toTsv } from "../src/clipboard.ts";

test("tab-separated values are read as spreadsheets copy them", () => {
  assert.deepEqual(parseTsv(""), []);
  assert.deepEqual(parseTsv("a\tb\r\nc\td\r\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseTsv("one"), [["one"]]);
  // Quoted fields hold tabs, line breaks and quotes; empty cells stay empty.
  assert.deepEqual(parseTsv('"a\tb"\t"line 1\nline 2"\t"say ""hi"""\n\t\tz\n'), [
    ["a\tb", "line 1\nline 2", 'say "hi"'],
    ["", "", "z"],
  ]);
  assert.deepEqual(parseTsv('""\tx'), [["", "x"]]);
  // Quotes inside an unquoted field, and a quote that is not closed, are kept as they are.
  assert.deepEqual(parseTsv('5" disk\t"open'), [['5" disk', '"open']]);
  assert.deepEqual(parseTsv('"a"b\tc'), [['"a"b', "c"]]);
  // Line endings of other systems, and an empty last row before the final line break.
  assert.deepEqual(parseTsv("a\rb\n\n"), [["a"], ["b"], [""]]);
  const rows = [
    ["x", "tab\there", 'q"uote'],
    ["multi\nline", "", "end"],
  ];
  assert.deepEqual(parseTsv(toTsv(rows)), rows, "reads what the grid copies");
});

test("HTML tables are read without a DOM", () => {
  assert.equal(parseHtmlTable("<p>no table</p>"), null);
  const html = `<html><head><style>td { color: red }</style></head><body>
    <table border=1>
      <tr><th>Name</th><th colspan="2">Values</th></tr>
      <tr><td rowspan=2>A &amp; B</td><td x:num="1234.5">1,234.50</td><td>x<br>y</td></tr>
      <tr><td>&lt;3&gt;</td><td>  spaced
        out  </td></tr>
      <tr><td>&#x41;&#66;&nbsp;</td></tr>
    </table></body></html>`;
  assert.deepEqual(parseHtmlTable(html), [
    ["Name", "Values", ""],
    ["A & B", "1,234.50", "x\ny"],
    ["", "<3>", "spaced out"],
    ["AB"],
  ]);
});

test("pasted numbers may group their digits", () => {
  const column = { name: "n", type: "decimal" as const, sourceType: "DECIMAL(10,2)" };
  assert.deepEqual(parseCellInput("1,234.50", column, { grouping: true }), { ok: true, value: "1234.50" });
  assert.deepEqual(parseCellInput("1,234.50", column), { ok: false, error: "number" });
  assert.deepEqual(parseCellInput("12,34", column, { grouping: true }), { ok: false, error: "number" });
  assert.deepEqual(parseCellInput("1,234", { name: "s", type: "string" }, { grouping: true }), {
    ok: true,
    value: "1,234",
  });
});
