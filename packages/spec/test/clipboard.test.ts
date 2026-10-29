import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHtmlTable, parseTsv, toHtmlTable, toMarkdownTable, toTsv } from "../src/index.ts";

test("TSV quotes fields with tabs, line breaks and quotes (§6.6)", () => {
  assert.equal(
    toTsv([
      ["a", "b\tc"],
      ['say "hi"', "x\ny"],
    ]),
    'a\t"b\tc"\n"say ""hi"""\t"x\ny"',
  );
});

test("a TSV whose last row is one empty field ends with a line feed, as pasting drops the last one (§6.6)", () => {
  assert.equal(toTsv([["Tokyo"], [""]]), "Tokyo\n\n");
  assert.equal(toTsv([[""], [""]]), "\n\n");
  assert.equal(toTsv([[""]]), "\n");
  // Other rows are not empty text: two empty fields are a tab.
  assert.equal(toTsv([["Tokyo"], ["", ""]]), "Tokyo\n\t");
  assert.equal(toTsv([[""], ["Tokyo"]]), "\nTokyo");
  assert.equal(toTsv([]), "");
});

test("TSV reads back what it writes", () => {
  const rows = [
    ["a", "b\tc", ""],
    ['say "hi"', "x\r\ny", "z"],
  ];
  assert.deepEqual(parseTsv(toTsv(rows)), rows);
  // Tables of up to four rows of up to three fields, made of the characters that TSV reads apart.
  const pieces = ["", "a", " ", "\t", "\n", "\r", "\r\n", '"', '""'];
  let seed = 1;
  const random = (count: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * count);
  };
  for (let index = 0; index < 5_000; index++) {
    const table = Array.from({ length: 1 + random(4) }, () =>
      Array.from({ length: 1 + random(3) }, () =>
        Array.from({ length: random(3) }, () => pieces[random(pieces.length)]).join(""),
      ),
    );
    assert.deepEqual(parseTsv(toTsv(table)), table, JSON.stringify(table));
  }
});

test("TSV rows end at CRLF, LF or CR, and the last line break ends the text", () => {
  assert.deepEqual(parseTsv("a\tb\r\nc\td\re\n"), [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(parseTsv("a\n\nb"), [["a"], [""], ["b"]]);
  assert.deepEqual(parseTsv(""), []);
  assert.deepEqual(parseTsv("\n"), [[""]]);
});

test("a quote that does not close a field is read as it is", () => {
  assert.deepEqual(parseTsv('"a"b\tc'), [['"a"b', "c"]]);
  assert.deepEqual(parseTsv('"open\tx'), [['"open', "x"]]);
  assert.deepEqual(parseTsv('5" screen'), [['5" screen']]);
});

test("HTML tables escape their text and use th for headers", () => {
  assert.equal(
    toHtmlTable(
      [
        ["a", "b"],
        ["<&>", 'x"\ny'],
      ],
      1,
    ),
    '<meta charset="utf-8"><table><tr><th>a</th><th>b</th></tr><tr><td>&lt;&amp;&gt;</td><td>x&quot;<br>y</td></tr></table>',
  );
});

test("the first table of HTML is read with spans filled, tags removed and entities decoded", () => {
  const html = `<p>x</p><table><tr><th colspan="2">A &amp; B</th><td rowspan=2>C</td></tr>
    <tr><td><b>1</b></td><td>two<br>lines&nbsp;&#x41;&#66;</td></tr></table><table><tr><td>other</td></tr></table>`;
  assert.deepEqual(parseHtmlTable(html), [
    ["A & B", "", "C"],
    ["1", "two\nlines AB", ""],
  ]);
  assert.equal(parseHtmlTable("<p>no table</p>"), null);
  assert.deepEqual(parseHtmlTable("<table><tr><td>  a \n b  </td></tr></table>"), [["a b"]]);
});

test("Markdown tables escape pipes and line breaks", () => {
  assert.equal(toMarkdownTable(["a|b", "c"], [["1\n2", "x"]]), "| a\\|b | c |\n| --- | --- |\n| 1<br>2 | x |");
  assert.equal(toMarkdownTable(["", ""], []), "|  |  |\n| --- | --- |");
});
