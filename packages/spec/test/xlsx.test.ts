import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { SpecError } from "../src/plan.ts";
import type { JsonValue } from "../src/types.ts";
import { checkXlsxSize, type ExportColumn, excelSerial, webDeflate, writeXlsx, XLSX_MAX_ROWS } from "../src/xlsx.ts";

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

const rows: JsonValue[][] = [
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

test("compresses the entries with the web's CompressionStream", async () => {
  const deflate = webDeflate();
  assert.ok(deflate, "Node.js has CompressionStream");
  const many = Array.from({ length: 2_000 }, (_, index): JsonValue[] => [`row ${index}`, index]);
  const two: ExportColumn[] = [
    { name: "name", type: "string" },
    { name: "n", type: "integer" },
  ];
  const stored = await collect(writeXlsx(two, [many]));
  const bytes = await collect(writeXlsx(two, [many], { deflate }));
  assert.ok(bytes.length < stored.length / 4, `${bytes.length} of ${stored.length} bytes`);
  const sheet = unzip(bytes).get("xl/worksheets/sheet1.xml") ?? "";
  assert.equal(sheet, unzip(stored).get("xl/worksheets/sheet1.xml"));
  assert.match(sheet, /<c r="A2001"[^>]*><is><t xml:space="preserve">row 1999<\/t>/);
});

test("cuts text to Excel's limit without splitting a character", async () => {
  const long = `${"a".repeat(32_766)}😀tail`;
  const sheet =
    unzip(await collect(writeXlsx([{ name: "t", type: "string" }], [[[long]]]))).get("xl/worksheets/sheet1.xml") ?? "";
  const text = /<c r="A2"[^>]*><is><t xml:space="preserve">(.*?)<\/t>/.exec(sheet)?.[1] ?? "";
  assert.equal(text, "a".repeat(32_766));
});

test("refuses rows and columns beyond an Excel sheet", async () => {
  assert.doesNotThrow(() => checkXlsxSize(XLSX_MAX_ROWS - 1, 16_384));
  for (const [rowCount, columnCount] of [
    [XLSX_MAX_ROWS, 1],
    [1, 16_385],
  ]) {
    assert.throws(
      () => checkXlsxSize(rowCount, columnCount),
      (error: unknown) => error instanceof SpecError && error.code === "export_too_large",
    );
  }
  // Rows that arrive past the limit stop the file.
  function* batches() {
    for (let start = 0; start < XLSX_MAX_ROWS; start += 65_536) yield Array.from({ length: 65_536 }, () => [1]);
  }
  await assert.rejects(collect(writeXlsx([{ name: "n", type: "integer" }], batches())), /at most 1048575 rows/);
});

test("converts dates to Excel serial numbers", () => {
  assert.equal(excelSerial("1900-03-01", "date"), 61);
  assert.equal(excelSerial("1900-02-28", "date"), null);
  assert.equal(excelSerial("2024-01-31", "date"), 45322);
  assert.equal(excelSerial("2024-01-31T00:00:00Z", "timestamptz"), 45322);
  assert.equal(excelSerial("2024-01-31 05:30:00+05:30", "timestamptz"), 45322);
  assert.equal(excelSerial("2024-01-30 19:00:00-0500", "timestamptz"), 45322);
  assert.equal(excelSerial("9999-12-31", "date"), 2_958_465);
  // Years 0 to 99 are those years, not 1900 to 1999 (as `Date.UTC` reads them), so Excel cannot show them.
  assert.equal(excelSerial("0050-03-01", "date"), null);
  assert.equal(excelSerial("0099-12-31 12:00:00", "timestamp"), null);
  assert.equal(excelSerial("06:00", "time"), 0.25);
  assert.equal(excelSerial("12:00:00+09", "time"), 0.5);
});
