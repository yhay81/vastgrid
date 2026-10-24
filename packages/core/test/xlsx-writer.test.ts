import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  ArraySource,
  browserDeflate,
  type CellValue,
  checkXlsxSize,
  type ExportColumn,
  excelNumberFormat,
  excelSerial,
  parseProtocolRequest,
  SourceError,
  writeTableFile,
  writeXlsx,
  XLSX_MAX_ROWS,
} from "../src/index.ts";

/**
 * Reads a ZIP archive by its central directory, independently of the writer: checks each entry's
 * local header, size and CRC-32, and returns the entries' text by name.
 */
function unzip(bytes: Uint8Array): Map<string, string> {
  const data = Buffer.from(bytes);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(at), 0x02014b50);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extra = data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    const offset = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;
    assert.equal(data.readUInt32LE(offset), 0x04034b50, `local header of ${name}`);
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    const raw = data.subarray(start, start + compressed);
    const content = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(content.length, size, `size of ${name}`);
    assert.equal(crc32(content), crc, `CRC of ${name}`);
    entries.set(name, content.toString("utf8"));
  }
  return entries;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/** The cells of a sheet by reference, as their XML. */
function cells(sheet: string) {
  const result = new Map<string, string>();
  for (const match of sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>.*?<\/c>)/g)) result.set(match[1], match[0]);
  return result;
}

const columns: ExportColumn[] = [
  { name: "name", type: "string" },
  { name: "amount", type: "decimal" },
  { name: "id", type: "bigint" },
  { name: "day", type: "date" },
  { name: "at", type: "timestamptz" },
  { name: "time", type: "time" },
  { name: "ok", type: "boolean" },
  { name: "ratio", type: "float", numberFormat: "0.0%" },
];

const rows: CellValue[][] = [
  ["=SUM(A1:A9)", "12.50", "9007199254740993", "2024-01-31", "2024-01-31 09:00:00+09", "12:30:00", true, 0.125],
  ["+1 & <b>", "0.1000000000000000055", 42, "1899-12-31", "2024-01-31 12:34:56.5", "23:59:59.5", false, "NaN"],
  [null, null, null, null, null, null, null, null],
  ["tab\tbell\u0007 _x0041_ ok", "-3", "12", "not a date", "10000-01-01 00:00:00", "25:00:00", null, 1e21],
];

test("writes values by the documented rules", async () => {
  const file = await collect(writeXlsx(columns, [rows.slice(0, 2), rows.slice(2)], { sheetName: "Data: [1]" }));
  const entries = unzip(file);
  assert.deepEqual(
    [...entries.keys()].sort(),
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ].sort(),
  );
  assert.match(entries.get("xl/workbook.xml") ?? "", /<sheet name="Data_ _1_"/);
  const sheet = entries.get("xl/worksheets/sheet1.xml") ?? "";
  assert.doesNotMatch(sheet, /<f>/, "no formulas");
  const cell = cells(sheet);
  // Header: bold text.
  assert.equal(cell.get("A1"), '<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">name</t></is></c>');
  // Text that looks like a formula stays text.
  assert.match(cell.get("A2") ?? "", /t="inlineStr".*=SUM\(A1:A9\)/);
  assert.match(cell.get("A3") ?? "", /\+1 &amp; &lt;b&gt;/);
  // Exact decimals are numbers; digits a double cannot hold stay text.
  assert.match(cell.get("B2") ?? "", /<v>12.5<\/v>/);
  assert.match(cell.get("B3") ?? "", /inlineStr.*0\.1000000000000000055/);
  assert.match(cell.get("C2") ?? "", /inlineStr.*9007199254740993/);
  assert.match(cell.get("C3") ?? "", /<v>42<\/v>/);
  assert.match(cell.get("C5") ?? "", /<v>12<\/v>/);
  // Dates and times are serial numbers with a date format; offsets are converted to UTC.
  assert.match(cell.get("D2") ?? "", /s="\d+"><v>45322<\/v>/);
  assert.match(cell.get("D3") ?? "", /inlineStr.*1899-12-31/);
  assert.match(cell.get("E2") ?? "", /<v>45322<\/v>/);
  assert.match(cell.get("E3") ?? "", /<v>45322\.52426/);
  assert.match(cell.get("E5") ?? "", /inlineStr.*10000-01-01/);
  assert.match(cell.get("F2") ?? "", /<v>0\.5208333/);
  assert.match(cell.get("F5") ?? "", /inlineStr.*25:00:00/);
  assert.match(cell.get("D5") ?? "", /inlineStr.*not a date/);
  // Booleans; NaN as text; the column's number format.
  assert.match(cell.get("G2") ?? "", /t="b"><v>1<\/v>/);
  assert.match(cell.get("G3") ?? "", /t="b"><v>0<\/v>/);
  assert.match(cell.get("H2") ?? "", /s="\d+"><v>0.125<\/v>/);
  assert.match(cell.get("H3") ?? "", /inlineStr.*NaN/);
  assert.match(cell.get("H5") ?? "", /<v>1e\+21<\/v>/);
  // null leaves the cell out; the row is still written.
  assert.match(sheet, /<row r="4"><\/row>/);
  // Control characters and text that looks like an escape are escaped.
  assert.match(cell.get("A5") ?? "", /tab\tbell_x0007_ _x005F_x0041_ ok/);
  const styles = entries.get("xl/styles.xml") ?? "";
  for (const code of ["yyyy-mm-dd", "yyyy-mm-dd hh:mm:ss", "hh:mm:ss", "0.0%"]) {
    assert.ok(styles.includes(`formatCode="${code}"`), code);
  }
  // The header row is frozen.
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2"[^>]*state="frozen"\/>/);
});

test("cuts text to Excel's limit without splitting a character", async () => {
  const long = `${"a".repeat(32_766)}😀tail`;
  const sheet =
    unzip(await collect(writeXlsx([{ name: "t", type: "string" }], [[[long]]]))).get("xl/worksheets/sheet1.xml") ?? "";
  const text = /<c r="A2"[^>]*><is><t xml:space="preserve">(.*?)<\/t>/.exec(sheet)?.[1] ?? "";
  assert.equal(text, "a".repeat(32_766));
});

test("compresses with CompressionStream where it exists", async () => {
  const deflate = browserDeflate();
  if (!deflate) return;
  const many = Array.from({ length: 5000 }, (_, index) => [`row ${index}`, index]);
  const stored = await collect(
    writeXlsx(
      [
        { name: "a", type: "string" },
        { name: "b", type: "integer" },
      ],
      [many],
    ),
  );
  const compressed = await collect(
    writeXlsx(
      [
        { name: "a", type: "string" },
        { name: "b", type: "integer" },
      ],
      [many],
      { deflate },
    ),
  );
  assert.ok(compressed.length < stored.length / 4, `${compressed.length} < ${stored.length} / 4`);
  assert.equal(unzip(compressed).get("xl/worksheets/sheet1.xml"), unzip(stored).get("xl/worksheets/sheet1.xml"));
});

test("refuses rows and columns beyond an Excel sheet", async () => {
  assert.doesNotThrow(() => checkXlsxSize(XLSX_MAX_ROWS - 1, 16_384));
  for (const [rowCount, columnCount] of [
    [XLSX_MAX_ROWS, 1],
    [1, 16_385],
  ]) {
    assert.throws(
      () => checkXlsxSize(rowCount, columnCount),
      (error: unknown) => error instanceof SourceError && error.code === "export_too_large" && error.status === 413,
    );
  }
  // Rows that arrive past the limit stop the file.
  function* batches() {
    for (let start = 0; start < XLSX_MAX_ROWS; start += 65_536) yield Array.from({ length: 65_536 }, () => [1]);
  }
  await assert.rejects(collect(writeXlsx([{ name: "n", type: "integer" }], batches())), /at most 1048575 rows/);
});

test("maps column settings onto Excel number formats", () => {
  const number = { name: "n", type: "float" } as const;
  const integer = { name: "i", type: "integer" } as const;
  const date = { name: "d", type: "timestamp" } as const;
  assert.equal(excelNumberFormat(number, undefined), null);
  assert.equal(excelNumberFormat(number, { label: "N" }), null);
  assert.equal(excelNumberFormat(number, { number: { fractionDigits: 2 } }), "#,##0.00");
  assert.equal(excelNumberFormat(number, { number: { fractionDigits: 2, grouping: false } }), "0.00");
  assert.equal(excelNumberFormat(number, { number: {} }), "#,##0.##########");
  assert.equal(excelNumberFormat(integer, { number: {} }), "#,##0");
  assert.equal(excelNumberFormat(number, { number: { style: "percent", fractionDigits: 1 } }), "#,##0.0%");
  assert.equal(
    excelNumberFormat(number, { number: { minimumFractionDigits: 1, maximumFractionDigits: 3, suffix: " kg" } }),
    '#,##0.0##" kg"',
  );
  assert.equal(
    excelNumberFormat(number, { number: { style: "currency", currency: "USD" } }, { locale: "en-US" }),
    '"$"#,##0.00',
  );
  assert.equal(
    excelNumberFormat(integer, { number: { style: "currency", currency: "JPY" } }, { locale: "ja-JP" }),
    '"￥"#,##0',
  );
  assert.equal(excelNumberFormat(number, { number: { notation: "scientific", fractionDigits: 2 } }), "0.00E+00");
  assert.equal(excelNumberFormat(number, { number: { notation: "compact" } }), null);
  assert.equal(
    excelNumberFormat(number, { number: { signDisplay: "always", fractionDigits: 0 } }),
    '"+"#,##0;"-"#,##0;"+"#,##0',
  );
  assert.equal(excelNumberFormat(date, { date: { pattern: "yyyy/MM/dd HH:mm" } }), 'yyyy"/"mm"/"dd" "hh":"mm');
  assert.equal(excelNumberFormat(date, { date: { pattern: "d MMM yyyy h:mm a" } }), 'd" "mmm" "yyyy" "h":"mm" "AM/PM');
  assert.equal(excelNumberFormat(date, { date: { pattern: "HH:mm:ss.SSS 'Uhr'" } }), 'hh":"mm":"ss.000" Uhr"');
  assert.equal(excelNumberFormat(date, { date: { pattern: "yyyy Q" } }), null);
  assert.equal(excelNumberFormat(number, { number: { prefix: 'a"b' } }), '"a"\\""b"#,##0.##########');
  assert.equal(excelNumberFormat(date, { date: { dateStyle: "long" } }), null);
  // A format function cannot be expressed; the default of the type is used.
  assert.equal(excelNumberFormat(number, { format: (value) => String(value) }), null);
});

test("converts dates to Excel serial numbers", () => {
  assert.equal(excelSerial("1900-03-01", "date"), 61);
  assert.equal(excelSerial("1900-02-28", "date"), null);
  assert.equal(excelSerial("2024-01-31", "date"), 45322);
  assert.equal(excelSerial("2024-01-31T00:00:00Z", "timestamptz"), 45322);
  assert.equal(excelSerial("2024-01-31 05:30:00+05:30", "timestamptz"), 45322);
  assert.equal(excelSerial("2024-01-30 19:00:00-0500", "timestamptz"), 45322);
  assert.equal(excelSerial("9999-12-31", "date"), 2_958_465);
  assert.equal(excelSerial("06:00", "time"), 0.25);
  assert.equal(excelSerial("12:00:00+09", "time"), 0.5);
});

test("ArraySource exports CSV, TSV, JSON and xlsx as data", async () => {
  const source = new ArraySource({
    columns: [
      { name: "name", type: "string" },
      { name: "n", type: "bigint" },
      { name: "day", type: "date" },
    ],
    rows: [
      ['Ada, "the first"', "9007199254740993", "1815-12-10"],
      ["Grace\nHopper", 2, "1906-12-09"],
      ["Linus", null, null],
    ],
  });
  const info = await source.info();
  assert.equal(info.capabilities.export, true);
  assert.deepEqual(info.exports, { formats: ["csv", "tsv", "json", "xlsx"], delivery: "data" });
  const view = await source.createView({ sort: [{ column: 0, direction: "desc" }] });
  const text = async (format: "csv" | "tsv" | "json", extra = {}) => {
    const result = await source.exportView({ view: view.id, format, target: `out.${format}`, ...extra });
    assert.equal(result.rows, 3);
    assert.equal(result.target, `out.${format}`);
    return (await result.data?.text()) ?? "";
  };
  assert.equal(
    await text("csv", { columns: [1, 0], headers: ["Number", "Name"] }),
    'Number,Name\n,Linus\n2,"Grace\nHopper"\n9007199254740993,"Ada, ""the first"""\n',
  );
  assert.equal(await text("tsv", { columns: [0] }), 'name\nLinus\n"Grace\nHopper"\n"Ada, ""the first"""\n');
  // JSON keeps the schema names and the digits of large integers.
  const json = await text("json", { columns: [1, 2], headers: ["x", "y"] });
  assert.equal(
    json,
    '[\n{"n":null,"day":null},\n{"n":2,"day":"1906-12-09"},\n{"n":9007199254740993,"day":"1815-12-10"}\n]\n',
  );
  const xlsx = await source.exportView({
    view: null,
    format: "xlsx",
    target: "out.xlsx",
    headers: ["Name", "N", "Day"],
  });
  assert.equal(xlsx.data?.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const sheet = unzip(new Uint8Array(await (xlsx.data as Blob).arrayBuffer())).get("xl/worksheets/sheet1.xml") ?? "";
  assert.match(sheet, /<t xml:space="preserve">Name<\/t>.*<t xml:space="preserve">Day<\/t>/);
  assert.match(sheet, /Ada, &quot;the first&quot;/);
  // 1815 is before the first date Excel shows: text.
  assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">1815-12-10/);
  await assert.rejects(
    source.exportView({ view: null, format: "parquet", target: "x" }),
    /cannot be exported as parquet/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.exportView({ view: null, format: "csv", target: "x" }, controller.signal), {
    name: "AbortError",
  });
});

test("writeTableFile writes empty tables", async () => {
  const text = async (format: "csv" | "json") =>
    (await collect(writeTableFile(format, [{ name: "a", type: "string" }], []))).toString("utf8");
  assert.equal(await text("csv"), "a\n");
  assert.equal(await text("json"), "[]\n");
});

test("validates export requests", () => {
  const base = { op: "export", table: "t", view: null, target: "x.xlsx" };
  assert.deepEqual(
    parseProtocolRequest({
      ...base,
      format: "xlsx",
      columns: [2, 0],
      headers: ["B", "A"],
      numberFormats: [null, "0.00"],
    }),
    { ...base, format: "xlsx", columns: [2, 0], headers: ["B", "A"], numberFormats: [null, "0.00"] },
  );
  assert.throws(() => parseProtocolRequest({ ...base, format: "xls" }), /format is invalid/);
  assert.throws(
    () => parseProtocolRequest({ ...base, format: "csv", columns: [0], headers: ["a", "b"] }),
    /one item per column/,
  );
  assert.throws(() => parseProtocolRequest({ ...base, format: "csv", headers: [1] }), /headers\[0\] must be a string/);
  assert.throws(
    () => parseProtocolRequest({ ...base, format: "xlsx", numberFormats: ["x".repeat(256)] }),
    /numberFormats\[0\]/,
  );
});
