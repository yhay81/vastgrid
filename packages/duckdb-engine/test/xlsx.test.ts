import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { formatDateStyle, serialDate } from "vastgrid-spec/workbook";
import { tableFormatOf } from "../src/index.ts";
import { type Client, type Json, setUp } from "./client.ts";
import { cell, type FixtureWorkbook, row, writeWorkbook } from "./xlsx-fixture.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;

before(async () => {
  context = await setUp({ maxTables: 16 });
  client = context.client;
  workspace = context.workspace;
});

after(async () => {
  await context.tearDown();
});

async function workbook(name: string, content: FixtureWorkbook) {
  const file = path.join(workspace, name);
  await writeWorkbook(file, content);
  return name;
}

async function readAll(ref: string, read?: Json) {
  const info = await client.open(ref, read);
  assert.equal(info.status, "ready", info.error);
  const rows = (await client.rows(info)).rows;
  return { info, rows };
}

// Styles: 0 General, 1 date (14), 2 date and time (22), 3 time (21), 4 a Japanese date, 5 a percentage.
const styled: Pick<FixtureWorkbook, "numberFormats" | "cellStyles"> = {
  numberFormats: [
    { id: 164, code: 'yyyy"年"m"月"d"日"' },
    { id: 165, code: "0.0%" },
  ],
  cellStyles: [0, 14, 22, 21, 164, 165],
};

test("workbook files are recognised by their extension", () => {
  assert.equal(tableFormatOf("report.xlsx"), "xlsx");
  assert.equal(tableFormatOf("Macro.XLSM"), "xlsx");
  assert.equal(tableFormatOf("old.xls"), null);
  assert.equal(tableFormatOf("binary.xlsb"), null);
});

test("cells are read with one type per column, formulas show their saved values", async () => {
  const strings = ["id", "name", "price", "member", "day", "at", "time", "mixed", "formula", "label", "jp", "rate"];
  const file = await workbook("types.xlsx", {
    ...styled,
    sharedStrings: [...strings, "Apple", "Banana & <Cherry>", "x"],
    sheets: [
      {
        name: "Data",
        rows: [
          row(
            1,
            strings.map((_, index) => cell(`${String.fromCharCode(65 + index)}1`, { t: "s", v: index })),
          ),
          row(2, [
            cell("A2", { v: 1 }),
            cell("B2", { t: "s", v: 12 }),
            cell("C2", { v: 1.5 }),
            cell("D2", { t: "b", v: 1 }),
            cell("E2", { s: 1, v: 45306 }),
            cell("F2", { s: 2, v: 45306.5 }),
            cell("G2", { s: 3, v: 0.75 }),
            cell("H2", { v: 10 }),
            cell("I2", { f: "C2*2", v: 3 }),
            cell("J2", { t: "str", f: 'B2&"!"', v: "Apple!" }),
            cell("K2", { s: 4, v: 45306 }),
            cell("L2", { s: 5, v: 0.125 }),
          ]),
          row(3, [
            cell("A3", { v: 2 }),
            cell("B3", { t: "s", v: 13 }),
            cell("C3", { v: "2.25" }),
            cell("D3", { t: "b", v: 0 }),
            cell("E3", { s: 1, v: 45307 }),
            cell("F3", { s: 2, v: 45307 }),
            cell("G3", { s: 3, v: "0.5000000001" }),
            cell("H3", { t: "s", v: 14 }),
            cell("I3", { f: "1/0", t: "e", v: "#DIV/0!" }),
            cell("J3", { t: "inlineStr", is: "inline" }),
            cell("K3", { s: 4, v: 45307 }),
          ]),
          // Blank cells: no value, a style only, and empty text.
          row(4, [cell("A4", { v: 3 }), cell("B4", { s: 1 }), cell("H4", { t: "inlineStr", is: "" })]),
        ],
      },
    ],
  });
  const { info, rows } = await readAll(file);
  assert.equal(info.format, "xlsx");
  assert.equal(info.sheet, "Data");
  assert.deepEqual(info.sheets, [{ name: "Data" }]);
  assert.deepEqual(
    info.columns.map((column) => [column.name, column.type, column.sourceType]),
    [
      ["id", "bigint", "BIGINT"],
      ["name", "string", "VARCHAR"],
      ["price", "float", "DOUBLE"],
      ["member", "boolean", "BOOLEAN"],
      ["day", "date", "DATE"],
      ["at", "timestamp", "TIMESTAMP"],
      ["time", "time", "TIME"],
      ["mixed", "string", "VARCHAR"],
      ["formula", "string", "VARCHAR"],
      ["label", "string", "VARCHAR"],
      ["jp", "date", "DATE"],
      ["rate", "float", "DOUBLE"],
    ],
  );
  assert.deepEqual(rows, [
    [1, "Apple", 1.5, true, "2024-01-15", "2024-01-15 12:00:00", "18:00:00", "10", "3", "Apple!", "2024-01-15", 0.125],
    [
      2,
      "Banana & <Cherry>",
      2.25,
      false,
      "2024-01-16",
      "2024-01-16 00:00:00",
      "12:00:00",
      "x",
      "#DIV/0!",
      "inline",
      "2024-01-16",
      null,
    ],
    [3, null, null, null, null, null, null, null, null, null, null, null],
  ]);
  assert.equal(info.notes, undefined);
});

test("date serial numbers follow Excel's calendars", () => {
  const date = 1;
  const time = 2;
  assert.equal(serialDate(1, date, false).text, "1900-01-01");
  assert.equal(serialDate(59, date, false).text, "1900-02-28");
  // Excel counts a 29 February 1900; it does not exist, so 60 reads as the day after the 28th.
  assert.equal(serialDate(60, date, false).text, "1900-03-01");
  assert.equal(serialDate(61, date, false).text, "1900-03-01");
  assert.equal(serialDate(45306.25, date, false).text, "2024-01-15 06:00:00");
  assert.equal(serialDate(0, date, true).text, "1904-01-01");
  assert.equal(serialDate(0.5, time, false).text, "12:00:00");
  assert.equal(serialDate(1.5, time, false).text, "1900-01-01 12:00:00");
  assert.equal(serialDate(45306 + 1 / 86_400_000, date, false).text, "2024-01-15 00:00:00.001");
});

test("number formats are told apart from date and time formats", () => {
  for (const code of [
    "yyyy-mm-dd",
    'yyyy"年"m"月"d"日"',
    "[$-411]ge.m.d",
    "m/d",
    "mmm",
    "dddd, mmmm dd",
    "yyyy-mm-dd hh:mm",
  ])
    assert.equal(formatDateStyle(code), 1, code);
  for (const code of ["hh:mm", "h:mm:ss AM/PM", "[h]:mm:ss", "mm:ss", "[$-409]h:mm AM/PM"])
    assert.equal(formatDateStyle(code), 2, code);
  for (const code of ["General", "0.00", "#,##0", "0.00E+00", '#,##0 "days"', "[Red]0.00", "0%", "@", '_("$"* #,##0_)'])
    assert.equal(formatDateStyle(code), 0, code);
});

test("the 1904 date system is honoured", async () => {
  const file = await workbook("1904.xlsx", {
    ...styled,
    date1904: true,
    sharedStrings: ["day"],
    sheets: [{ name: "S", rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { s: 1, v: 0 })])] }],
  });
  assert.deepEqual((await readAll(file)).rows, [["1904-01-01"]]);
});

const sheets: FixtureWorkbook = {
  sharedStrings: ["name", "first", "second", "hidden"],
  chartSheet: "Chart",
  sheets: [
    {
      name: "Secret",
      state: "hidden",
      rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 3 })])],
    },
    { name: "First", rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 1 })])] },
    { name: "Second & more", rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 2 })])] },
  ],
};

test("the sheets are listed, the first visible one is read and others can be chosen", async () => {
  const file = await workbook("sheets.xlsx", sheets);
  const first = await readAll(file);
  assert.deepEqual(first.info.sheets, [{ name: "Secret", hidden: true }, { name: "First" }, { name: "Second & more" }]);
  assert.equal(first.info.sheet, "First");
  assert.deepEqual(first.rows, [["first"]]);
  const second = await readAll(file, { sheet: "Second & more" });
  assert.equal(second.info.sheet, "Second & more");
  assert.deepEqual(second.rows, [["second"]]);
  assert.deepEqual((await readAll(file, { sheet: "Secret" })).rows, [["hidden"]]);
  // Read options other than the sheet's do not make another table.
  const options = await client.open(file, { sheet: "First", keepEmptyRows: false });
  assert.equal(options.revision, first.info.revision);
  const missing = await client.open(file, { sheet: "Chart" });
  assert.equal(missing.status, "error");
  assert.equal(missing.error, 'The workbook has no sheet named "Chart".');
  assert.equal(missing.sheets?.length, 3);
});

test("the header row and empty rows and columns can be configured", async () => {
  const file = await workbook("layout.xlsx", {
    sharedStrings: ["Report title", "name", "", "name", "value", "a", "b"],
    sheets: [
      {
        name: "S",
        rows: [
          row(1, [cell("B1", { t: "s", v: 0 })]),
          row(3, [
            cell("B3", { t: "s", v: 1 }),
            cell("C3", { t: "s", v: 2 }),
            cell("D3", { t: "s", v: 3 }),
            cell("F3", { t: "s", v: 4 }),
          ]),
          row(4, [cell("B4", { t: "s", v: 5 }), cell("D4", { v: 1 }), cell("F4", { v: 10 })]),
          row(5, []),
          row(7, [cell("B7", { t: "s", v: 6 }), cell("C7", { v: 2 }), cell("F7", { v: 20 })]),
          row(9, [cell("A9", { s: 0 })]),
        ],
      },
    ],
  });
  // By default the first row with a value holds the names.
  const automatic = await readAll(file);
  assert.deepEqual(
    automatic.info.columns.map((column) => column.name),
    ["Report title", "C", "D", "F"],
  );
  const header = await readAll(file, { headerRow: 3 });
  // Empty names get the column's letters, repeated names a suffix; the empty column E is left out.
  assert.deepEqual(
    header.info.columns.map((column) => [column.name, column.type]),
    [
      ["name", "string"],
      ["C", "bigint"],
      ["name_2", "bigint"],
      ["value", "bigint"],
    ],
  );
  assert.deepEqual(header.rows, [
    ["a", null, 1, 10],
    ["b", 2, null, 20],
  ]);
  const kept = await readAll(file, { headerRow: 3, keepEmptyRows: true, keepEmptyColumns: true });
  assert.deepEqual(
    kept.info.columns.map((column) => column.name),
    ["name", "C", "name_2", "E", "value"],
  );
  // Rows 5 and 6 are empty (6 is not in the file); rows after the last value are not data.
  assert.deepEqual(kept.rows, [
    ["a", null, 1, null, 10],
    [null, null, null, null, null],
    [null, null, null, null, null],
    ["b", 2, null, null, 20],
  ]);
  const unnamed = await readAll(file, { headerRow: 0 });
  assert.deepEqual(
    unnamed.info.columns.map((column) => column.name),
    ["B", "C", "D", "F"],
  );
  assert.equal(unnamed.rows.length, 4);
  assert.deepEqual(unnamed.rows[0], ["Report title", null, null, null]);
});

test("merged cells and formulas without saved values are noted", async () => {
  const file = await workbook("notes.xlsx", {
    sharedStrings: ["group", "total", "both"],
    sheets: [
      {
        name: "S",
        merges: ["A2:B2"],
        rows: [
          row(1, [cell("A1", { t: "s", v: 0 }), cell("B1", { t: "s", v: 1 })]),
          row(2, [cell("A2", { t: "s", v: 2 }), cell("B2", { f: "SUM(C:C)" })]),
        ],
      },
    ],
  });
  const { info, rows } = await readAll(file);
  assert.deepEqual(info.notes, ["merged_cells", "formulas_without_values"]);
  // Only the top-left cell of a merged range has the value; formulas are not calculated.
  assert.deepEqual(rows, [["both", null]]);
});

test("rich text, phonetic guides, escapes and namespace prefixes are read", async () => {
  const file = await workbook("rich.xlsx", {
    sheets: [{ name: "S", rows: [] }],
    parts: {
      "xl/sharedStrings.xml":
        '<?xml version="1.0"?><x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:si><x:t>name</x:t></x:si>' +
        '<x:si><x:r><x:rPr><x:b/></x:rPr><x:t>東京</x:t></x:r><x:r><x:t xml:space="preserve"> 都</x:t></x:r><x:rPh sb="0" eb="2"><x:t>トウキョウ</x:t></x:rPh></x:si>' +
        "<x:si><x:t>tab_x0009_end &amp; &#x41;&#66;</x:t></x:si><x:si/></x:sst>",
      "xl/worksheets/sheet1.xml":
        '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
        '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c></x:row>' +
        '<x:row r="3"><x:c r="A3" t="s"><x:v>2</x:v></x:c></x:row><x:row r="4"><x:c r="A4" t="s"><x:v>3</x:v></x:c><x:c r="B4"><x:v>1</x:v></x:c></x:row>' +
        "</x:sheetData></x:worksheet>",
    },
  });
  const { info, rows } = await readAll(file);
  assert.deepEqual(
    info.columns.map((column) => column.name),
    ["name", "B"],
  );
  assert.deepEqual(rows, [
    ["東京 都", null],
    ["tab\tend & AB", null],
    [null, 1],
  ]);
});

test("damaged and unsupported workbooks fail with a reason", async () => {
  const failure = async (name: string, content: Buffer | string) => {
    await writeFile(path.join(workspace, name), content);
    const info = await client.open(name);
    assert.equal(info.status, "error", name);
    return info.error ?? "";
  };
  assert.match(await failure("text.xlsx", "id,name\n1,a\n"), /not a ZIP archive/);
  const ole = Buffer.alloc(512);
  ole.writeUInt32BE(0xd0cf11e0, 0);
  ole.writeUInt32BE(0xa1b11ae1, 4);
  assert.match(await failure("legacy.xlsx", ole), /encrypted or in the old \.xls format/);
  const good = await readFile(path.join(workspace, await workbook("good.xlsx", sheets)));
  assert.match(
    await failure("truncated.xlsx", good.subarray(0, Math.floor(good.length / 2))),
    /not a ZIP archive|damaged/,
  );
  // Damage inside the compressed sheet.
  const broken = Buffer.from(good);
  const sheet = broken.indexOf("xl/worksheets/sheet2.xml");
  for (let at = sheet + 30; at < sheet + 60; at++) broken[at] = 0xff;
  assert.match(await failure("corrupt.xlsx", broken), /damaged/);
  assert.match(await failure("empty.xlsx", ""), /not a ZIP archive/);
  assert.equal((await client.error("open", { ref: "data.xlsb" })).code, "load_failed");
  // A failed load is read again by the next open.
  assert.equal((await client.open("text.xlsx")).status, "error");
});

test("workbooks are opened by their real location only inside the allowed folders", async () => {
  const outside = path.join(context.root, "outside.xlsx");
  await writeWorkbook(outside, sheets);
  await symlink(outside, path.join(workspace, "link.xlsx"));
  assert.equal((await client.error("open", { ref: "link.xlsx" })).code, "not_allowed");
  assert.equal((await client.error("open", { ref: outside })).code, "not_allowed");
});

test("open checks its read options (§8.2), and the first answer lists the sheets", async () => {
  const file = await workbook("options.xlsx", sheets);
  const opened = await client.result<{ table: string; sheets?: unknown[]; sheet?: string }>("open", {
    ref: file,
    read: { sheet: "Second & more", headerRow: 1 },
  });
  assert.equal(opened.sheets?.length, 3);
  await context.engine.whenLoaded(opened.table);
  const info = await client.result<{ table: string; revision: string; sheet: string; columns: { name: string }[] }>(
    "info",
    {
      table: opened.table,
    },
  );
  assert.equal(info.sheet, "Second & more");
  assert.deepEqual((await client.rows(info as never)).rows, [["second"]]);
  for (const read of [{ sheet: 1 }, { headerRow: -1 }, { keepEmptyRows: "yes" }, "First"]) {
    const refused = await client.error("open", { ref: file, read });
    assert.equal(refused.code, "invalid_request", JSON.stringify(read));
  }
});

test("plans and summaries work on a sheet", async () => {
  const file = await workbook("query.xlsx", {
    ...styled,
    sharedStrings: ["n", "day"],
    sheets: [
      {
        name: "S",
        rows: [
          row(1, [cell("A1", { t: "s", v: 0 }), cell("B1", { t: "s", v: 1 })]),
          ...[5, 3, 9, 1].map((value, index) =>
            row(index + 2, [cell(`A${index + 2}`, { v: value }), cell(`B${index + 2}`, { s: 1, v: 45300 + value })]),
          ),
        ],
      },
    ],
  });
  const info = await client.open(file);
  const sorted = await client.rows(info, {
    plan: { where: { fn: "ge", args: [{ col: "n" }, { lit: 3 }] }, sort: [{ column: "day", direction: "desc" }] },
  });
  assert.deepEqual(sorted.view.rowCount, 3);
  assert.deepEqual(sorted.rows, [
    [9, "2024-01-18"],
    [5, "2024-01-14"],
    [3, "2024-01-12"],
  ]);
  const summary = await client.result("summarize", {
    table: info.table,
    revision: info.revision,
    plan: {},
    ranges: [[0, 4]],
    columns: ["n"],
  });
  assert.deepEqual(summary, { count: 4, numericCount: 4, sum: 18, min: 1, max: 9, average: 4.5 });
});
