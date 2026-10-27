/**
 * Writes Excel workbooks (`.xlsx`) for `export` (docs/spec.md §8.2) without dependencies: one sheet, written as
 * a stream of bytes so that only one batch of rows is in memory at a time. The ZIP entries use data descriptors,
 * so their sizes need not be known in advance; they are compressed by `XlsxOptions.deflate`, or stored.
 *
 * Values are typed JSON (§2.2). Numbers are number cells, except numeric text that a double cannot hold exactly
 * (more than 15 significant digits, NaN, Infinity), which stays text so that no digit changes. Booleans are boolean
 * cells. Dates, times and timestamps are date serial numbers with a date format; values Excel cannot show as dates
 * (before 1900-03-01, after 9999) stay text, and timestamps with an offset are written in UTC. Text is always a text
 * cell, never a formula, also when it starts with `=`, `+`, `-` or `@`. Text longer than 32,767 characters is cut.
 * `null` leaves the cell empty. Ported from 0.1's `xlsx-writer.ts`; both engines write workbooks with it.
 */
import { columnLetters, serialOf } from "./excel.js";
import { SpecError } from "./plan.js";
import type { JsonValue, LogicalType } from "./types.js";

/** Rows of an Excel sheet, the header row included. */
export const XLSX_MAX_ROWS = 1_048_576;
/** Columns of an Excel sheet. */
export const XLSX_MAX_COLUMNS = 16_384;
/** Characters of an Excel cell. */
export const XLSX_MAX_TEXT = 32_767;

export interface ExportColumn {
  /** The header text. */
  name: string;
  type: LogicalType;
  /** An Excel number format code, for example `#,##0.00` or `yyyy-mm-dd`. Defaults by type. */
  numberFormat?: string | null;
}

export interface XlsxOptions {
  /** Defaults to `Sheet1`. Characters Excel does not allow are replaced and the name is cut to 31. */
  sheetName?: string;
  /**
   * Compresses the data of a ZIP entry (raw deflate, RFC 1951). Without it, entries are stored uncompressed.
   * `webDeflate` uses `CompressionStream` where it exists.
   */
  deflate?: ((chunks: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>) | null;
  /** Updates a CRC-32 with more data, for a faster native one (`zlib.crc32`). */
  crc32?: (data: Uint8Array, crc: number) => number;
  signal?: AbortSignal;
}

/** Refuses a table that does not fit in one Excel sheet (`export_too_large`, §8.7). */
export function checkXlsxSize(rows: number, columns: number) {
  if (rows + 1 > XLSX_MAX_ROWS || columns > XLSX_MAX_COLUMNS) {
    throw new SpecError(
      "export_too_large",
      `An Excel sheet holds at most ${XLSX_MAX_ROWS - 1} rows and ${XLSX_MAX_COLUMNS} columns; filter the rows or choose another format.`,
    );
  }
}

/** Raw deflate with the web `CompressionStream`, or `null` where it is not available. */
export function webDeflate(): ((chunks: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>) | null {
  const Stream = (globalThis as { CompressionStream?: new (format: string) => TransformStream }).CompressionStream;
  if (!Stream) return null;
  try {
    new Stream("deflate-raw");
  } catch {
    return null;
  }
  return (chunks) => ({
    async *[Symbol.asyncIterator]() {
      const stream = new Stream("deflate-raw");
      const writer = stream.writable.getWriter();
      const pump = (async () => {
        try {
          for await (const chunk of chunks) {
            await writer.ready;
            await writer.write(chunk);
          }
          await writer.close();
        } catch (error) {
          await writer.abort(error).catch(() => {});
          throw error;
        }
      })();
      const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
      await pump;
    },
  });
}

// ----- values -----

const temporal =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})?$/i;
const timeOfDay = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2}){0,2})?$/i;

/** Seconds east of UTC of an offset such as `Z`, `+09`, `+0930` or `-05:00`. */
function offsetSeconds(offset: string | undefined) {
  if (!offset || /^z$/i.test(offset)) return 0;
  const digits = offset.slice(1).replaceAll(":", "");
  const total =
    Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || 0) * 60 + Number(digits.slice(4, 6) || 0);
  return offset[0] === "-" ? -total : total;
}

/** The Excel serial number of an ISO-like date, time or timestamp, or `null` when Excel cannot show it. */
export function excelSerial(value: string, type: LogicalType): number | null {
  if (type === "time") {
    const match = timeOfDay.exec(value.trim());
    if (!match) return null;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(match[4] ?? 0);
    return seconds < 86_400 ? seconds / 86_400 : null;
  }
  const match = temporal.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0"] = match;
  // `setUTCFullYear`, unlike `Date.UTC`, reads the years 0 to 99 as themselves. Days and months beyond their
  // ranges roll over into the next ones.
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  const days = date.getTime() / 86_400_000;
  if (!Number.isFinite(days)) return null;
  const seconds =
    Number(hour) * 3600 + Number(minute) * 60 + Number(second) + Number(fraction) - offsetSeconds(match[8]);
  return serialOf(days, seconds);
}

const numericText = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A number for numeric text that a double holds exactly as written (at most 15 significant digits). */
function exactNumber(text: string): number | null {
  if (!numericText.test(text)) return null;
  const mantissa = text.replace(/^[+-]/, "").replace(/e.*$/i, "").replace(".", "");
  const significant = mantissa.replace(/^0+/, "").replace(/0+$/, "");
  if (significant.length > 15) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function escapeXml(text: string) {
  return text.replace(/[&<>"]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
  );
}

/** Lone surrogates and control characters other than tab, line feed and carriage return. */
const notXml =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text for a cell: cut to Excel's limit, with characters XML cannot hold written as `_xHHHH_` (and text
 * that looks like such an escape escaped itself), as the format defines.
 */
function cellText(value: string) {
  let text = value;
  if (text.length > XLSX_MAX_TEXT) {
    text = text.slice(0, XLSX_MAX_TEXT);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  text = text
    .replace(/_(x[0-9a-f]{4}_)/gi, "_x005F_$1")
    .replace(notXml, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`);
  return escapeXml(text);
}

function textCell(ref: string, text: string, style = 0) {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${cellText(text)}</t></is></c>`;
}

function numberCell(ref: string, value: number, style: number) {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
}

const NUMERIC = new Set<LogicalType>(["integer", "bigint", "decimal", "float"]);

function valueCell(ref: string, value: JsonValue, type: LogicalType, style: number): string {
  if (value === null) return "";
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? numberCell(ref, value, style) : textCell(ref, String(value));
  }
  if (typeof value !== "string") return textCell(ref, JSON.stringify(value));
  if (type === "date" || type === "timestamp" || type === "timestamptz" || type === "time") {
    const serial = excelSerial(value, type);
    return serial === null ? textCell(ref, value) : numberCell(ref, serial, style);
  }
  if (NUMERIC.has(type)) {
    const number = exactNumber(value.trim());
    return number === null ? textCell(ref, value) : numberCell(ref, number, style);
  }
  return textCell(ref, value);
}

const defaultFormats: Partial<Record<LogicalType, string>> = {
  date: "yyyy-mm-dd",
  timestamp: "yyyy-mm-dd hh:mm:ss",
  timestamptz: "yyyy-mm-dd hh:mm:ss",
  time: "hh:mm:ss",
};

// ----- ZIP -----

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(crc: number, data: Uint8Array) {
  let c = ~crc;
  for (let index = 0; index < data.length; index++) c = crcTable[(c ^ data[index]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

interface EntryRecord {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

const MAX_32 = 0xffffffff;

function tooLargeArchive() {
  return new SpecError(
    "export_too_large",
    "The workbook would be larger than 4 GB; filter the rows or choose another format.",
  );
}

class ZipWriter {
  offset = 0;
  readonly entries: EntryRecord[] = [];
  private readonly encoder = new TextEncoder();

  private readonly crc32: (data: Uint8Array, crc: number) => number;

  constructor(
    private readonly deflate: XlsxOptions["deflate"],
    crc: XlsxOptions["crc32"],
  ) {
    this.crc32 = crc ?? ((data, value) => crc32(value, data));
  }

  /** The bytes of one entry: local header, data and data descriptor. */
  async *entry(name: string, content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    const nameBytes = this.encoder.encode(name);
    const method = this.deflate ? 8 : 0;
    const record: EntryRecord = { name: nameBytes, method, crc: 0, compressed: 0, size: 0, offset: this.offset };
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0808, true); // sizes in the data descriptor; UTF-8 names
    view.setUint16(8, method, true);
    view.setUint16(12, 0x21, true); // 1980-01-01
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    yield this.count(header);
    const measured = async function* (this: ZipWriter) {
      for await (const chunk of content) {
        record.crc = this.crc32(chunk, record.crc);
        record.size += chunk.length;
        if (record.size > MAX_32) throw tooLargeArchive();
        yield chunk;
      }
    }.call(this);
    for await (const chunk of this.deflate ? this.deflate(measured) : measured) {
      record.compressed += chunk.length;
      yield this.count(chunk);
    }
    const descriptor = new Uint8Array(16);
    const tail = new DataView(descriptor.buffer);
    tail.setUint32(0, 0x08074b50, true);
    tail.setUint32(4, record.crc, true);
    tail.setUint32(8, record.compressed, true);
    tail.setUint32(12, record.size, true);
    yield this.count(descriptor);
    this.entries.push(record);
  }

  /** The central directory and its end record. */
  finish(): Uint8Array {
    const size = this.entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
    const bytes = new Uint8Array(size + 22);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (const entry of this.entries) {
      view.setUint32(at, 0x02014b50, true);
      view.setUint16(at + 4, 20, true);
      view.setUint16(at + 6, 20, true);
      view.setUint16(at + 8, 0x0808, true);
      view.setUint16(at + 10, entry.method, true);
      view.setUint16(at + 14, 0x21, true);
      view.setUint32(at + 16, entry.crc, true);
      view.setUint32(at + 20, entry.compressed, true);
      view.setUint32(at + 24, entry.size, true);
      view.setUint16(at + 28, entry.name.length, true);
      view.setUint32(at + 42, entry.offset, true);
      bytes.set(entry.name, at + 46);
      at += 46 + entry.name.length;
    }
    view.setUint32(at, 0x06054b50, true);
    view.setUint16(at + 8, this.entries.length, true);
    view.setUint16(at + 10, this.entries.length, true);
    view.setUint32(at + 12, size, true);
    view.setUint32(at + 16, this.offset, true);
    this.count(bytes);
    return bytes;
  }

  private count(chunk: Uint8Array) {
    this.offset += chunk.length;
    if (this.offset > MAX_32) throw tooLargeArchive();
    return chunk;
  }
}

// ----- parts -----

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function sheetNameOf(name: string | undefined) {
  const cleaned = (name ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in sheet names.
    .replace(/[[\]:*?/\\\u0000-\u001f]/g, "_")
    .replace(/^'+|'+$/g, "")
    .slice(0, 31);
  return cleaned.trim() ? cleaned : "Sheet1";
}

function staticParts(sheetName: string, formats: string[]) {
  const numFmts = formats.map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${escapeXml(code)}"/>`);
  const xfs = formats.map(
    (_, index) => `<xf numFmtId="${164 + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
  );
  return {
    "[Content_Types].xml": `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    // Style 1 is the bold header; styles 2… are the number formats.
    "xl/styles.xml": `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join("")}</numFmts>` : ""}<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${2 + xfs.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
}

function columnWidth(column: ExportColumn) {
  const typical: Partial<Record<LogicalType, number>> = { date: 11, timestamp: 20, timestamptz: 20, time: 10 };
  return Math.min(60, Math.max(8, typical[column.type] ?? 12, [...column.name].length + 2));
}

/**
 * Writes a workbook with one sheet: a header row with the column names, then `rows`, which come in
 * batches (arrays of rows, each an array of values in column order). Returns the bytes of the file as
 * they are made. Throws `SpecError` (`export_too_large`) when the rows do not fit in a sheet.
 */
export async function* writeXlsx(
  columns: ExportColumn[],
  rows: AsyncIterable<JsonValue[][]> | Iterable<JsonValue[][]>,
  options: XlsxOptions = {},
): AsyncGenerator<Uint8Array> {
  checkXlsxSize(0, columns.length);
  const formats: string[] = [];
  const styles = columns.map((column) => {
    const code = column.numberFormat ?? defaultFormats[column.type];
    if (!code) return 0;
    let index = formats.indexOf(code);
    if (index < 0) index = formats.push(code) - 1;
    return 2 + index;
  });
  const sheetName = sheetNameOf(options.sheetName);
  const zip = new ZipWriter(options.deflate, options.crc32);
  const encoder = new TextEncoder();
  const signal = options.signal;
  const parts = staticParts(sheetName, formats);
  for (const [name, text] of Object.entries(parts)) yield* zip.entry(name, [encoder.encode(text)]);

  const refs = columns.map((_, index) => columnLetters(index));
  async function* sheet(): AsyncGenerator<Uint8Array> {
    const cols = columns.map(
      (column, index) => `<col min="${index + 1}" max="${index + 1}" width="${columnWidth(column)}" customWidth="1"/>`,
    );
    const header = columns.map((column, index) => textCell(`${refs[index]}1`, column.name, 1)).join("");
    yield encoder.encode(
      `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${columns.length ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ""}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols.length ? `<cols>${cols.join("")}</cols>` : ""}<sheetData><row r="1">${header}</row>`,
    );
    let row = 1;
    for await (const batch of rows) {
      if (signal?.aborted) throw signal.reason ?? new Error("The export was cancelled.");
      if (row + batch.length > XLSX_MAX_ROWS) checkXlsxSize(row + batch.length, columns.length);
      let xml = "";
      for (const values of batch) {
        row++;
        xml += `<row r="${row}">`;
        for (let index = 0; index < columns.length; index++) {
          xml += valueCell(`${refs[index]}${row}`, values[index] ?? null, columns[index].type, styles[index]);
        }
        xml += "</row>";
      }
      yield encoder.encode(xml);
    }
    yield encoder.encode("</sheetData></worksheet>");
  }
  yield* zip.entry("xl/worksheets/sheet1.xml", sheet());
  yield zip.finish();
}
