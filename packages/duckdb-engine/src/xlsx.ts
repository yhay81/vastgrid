/**
 * Reads Excel workbooks (`.xlsx`, `.xlsm`) without dependencies: the ZIP archive is read with
 * `node:zlib`, and the sheet is parsed as a stream and written to a CSV file with one type per column,
 * which DuckDB then loads like any other delimited file. Only the shared strings stay in memory.
 *
 * The values Excel saved are read as they are: formulas are not calculated again (their last
 * calculated value is shown), and formatting, merged cells and hidden rows are not reproduced.
 */
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { quoteIdentifier } from "vastgrid-sql";

/** How `open` reads a workbook (docs/v2-spec.md §8.2). */
export interface ReadOptions {
  /** The sheet to read, by name. Defaults to the first visible sheet. */
  sheet?: string;
  /** The 1-based row that holds the column names; rows above it are skipped. `0` reads without names. */
  headerRow?: number;
  /** Keep rows without any value between the first and the last data row. */
  keepEmptyRows?: boolean;
  /** Keep columns without any value (and no name) inside the used range. */
  keepEmptyColumns?: boolean;
}

/** A sheet of a workbook, as `TableInfo.sheets` lists it (§8.2). */
export interface SheetInfo {
  name: string;
  /** Hidden in the workbook (it can still be read). */
  hidden?: boolean;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Rows and columns a sheet can have in Excel. */
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
/** Largest ZIP central directory and largest workbook part (other than sheets) read into memory. */
const MAX_DIRECTORY = 64 * 1024 * 1024;
const MAX_PART = 2 * 1024 * 1024 * 1024;

/** A workbook that cannot be read; the message is meant for people. */
export class WorkbookError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** The entries of a ZIP archive, by lowercase name. */
async function readZipDirectory(file: string): Promise<Map<string, ZipEntry>> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    if (size >= 8) {
      const head = Buffer.alloc(8);
      await handle.read(head, 0, 8, 0);
      // The compound file format of `.xls` files, also used for encrypted workbooks.
      if (head.readUInt32BE(0) === 0xd0cf11e0 && head.readUInt32BE(4) === 0xa1b11ae1) {
        throw new WorkbookError(
          "The workbook is encrypted or in the old .xls format; only .xlsx and .xlsm workbooks are supported.",
        );
      }
    }
    let end = -1;
    for (let at = tailSize - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new WorkbookError("The file is not a valid workbook (it is not a ZIP archive).");
    let count = tail.readUInt16LE(end + 10);
    let directorySize = tail.readUInt32LE(end + 12);
    let directoryOffset = tail.readUInt32LE(end + 16);
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || count === 0xffff) {
      // ZIP64: the locator just before the end record points to the ZIP64 end record.
      const locator = end - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50)
        throw new WorkbookError("The workbook is damaged (its ZIP directory cannot be found).");
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
      if (record.readUInt32LE(0) !== 0x06064b50)
        throw new WorkbookError("The workbook is damaged (its ZIP directory cannot be found).");
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > size)
      throw new WorkbookError("The workbook is damaged (its ZIP directory is invalid).");
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries = new Map<string, ZipEntry>();
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50)
        throw new WorkbookError("The workbook is damaged (its ZIP directory is invalid).");
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      let compressedSize = directory.readUInt32LE(at + 20);
      let entrySize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      let offset = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      // ZIP64 sizes and offsets are in an extra field, in this order, for the values that overflowed.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (entrySize === 0xffffffff) {
            entrySize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (offset === 0xffffffff) offset = Number(directory.readBigUInt64LE(field));
        }
        extra += 4 + length;
      }
      if (flags & 1) throw new WorkbookError("The workbook is encrypted, which is not supported.");
      entries.set(name.toLowerCase(), { name, method, compressedSize, size: entrySize, offset });
      at = extraEnd + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Where the data of an entry starts: after its local header, whose name and extra field can differ from the directory's. */
async function dataOffset(file: string, entry: ZipEntry) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.offset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== 0x04034b50)
      throw new WorkbookError(`The workbook is damaged (${entry.name} cannot be found).`);
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

/** The text of an entry as a stream of chunks. `onRead` receives the compressed bytes read. */
async function* entryText(file: string, entry: ZipEntry, onRead?: (bytes: number) => void): AsyncGenerator<string> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new WorkbookError(`The workbook uses a compression method that is not supported (${entry.method}).`);
  }
  const start = await dataOffset(file, entry);
  const input = createReadStream(file, { start, end: start + entry.compressedSize - 1, highWaterMark: 256 * 1024 });
  if (onRead) input.on("data", (chunk) => onRead(chunk.length));
  const output =
    entry.method === 8 ? pipeline(input, createInflateRaw({ chunkSize: 256 * 1024 }), () => undefined) : input;
  output.setEncoding("utf8");
  try {
    for await (const chunk of output) yield chunk as string;
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    throw new WorkbookError(`The workbook is damaged (${entry.name} cannot be read: ${(error as Error).message}).`);
  } finally {
    input.destroy();
  }
}

interface XmlHandler {
  /** `attributes` is the raw text after the tag name. */
  open(name: string, attributes: string, selfClosing: boolean): void;
  close(name: string): void;
  /** Raw text between tags (entities not decoded). */
  text(text: string): void;
}

/**
 * Parses the XML of an entry as a stream of tags and text. Enough for the parts of a workbook:
 * namespace prefixes are dropped, and comments, processing instructions and declarations are skipped.
 */
async function scanXml(
  chunks: AsyncIterable<string>,
  handler: XmlHandler,
  hooks: { cancelled?: () => boolean; afterChunk?: () => Promise<void> | undefined } = {},
) {
  let buffer = "";
  for await (const chunk of chunks) {
    if (hooks.cancelled?.()) throw new WorkbookError("The workbook was closed while it loaded.");
    buffer = buffer.length === 0 ? chunk : buffer + chunk;
    let position = 0;
    for (;;) {
      const open = buffer.indexOf("<", position);
      if (open < 0) break;
      if (buffer.startsWith("<!--", open)) {
        const end = buffer.indexOf("-->", open + 4);
        if (end < 0) break;
        position = end + 3;
        continue;
      }
      if (buffer.startsWith("<![CDATA[", open)) {
        const end = buffer.indexOf("]]>", open + 9);
        if (end < 0) break;
        if (open > position) handler.text(buffer.slice(position, open));
        handler.text(escapeText(buffer.slice(open + 9, end)));
        position = end + 3;
        continue;
      }
      const close = buffer.indexOf(">", open + 1);
      if (close < 0) break;
      if (open > position) handler.text(buffer.slice(position, open));
      position = close + 1;
      const first = buffer.charCodeAt(open + 1);
      if (first === 63 || first === 33) continue; // <? and <!
      if (first === 47) {
        handler.close(localName(buffer.slice(open + 2, close).trim()));
        continue;
      }
      const selfClosing = buffer.charCodeAt(close - 1) === 47;
      const tag = buffer.slice(open + 1, selfClosing ? close - 1 : close);
      let space = 0;
      while (space < tag.length && tag.charCodeAt(space) > 32) space++;
      if (space === tag.length) space = -1;
      const name = space < 0 ? tag : tag.slice(0, space);
      handler.open(localName(name), space < 0 ? "" : tag.slice(space), selfClosing);
      if (selfClosing) handler.close(localName(name));
    }
    buffer = buffer.slice(position);
    const waiting = hooks.afterChunk?.();
    if (waiting) await waiting;
  }
}

function localName(name: string) {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function escapeText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** The value of an attribute in the raw attribute text of a tag, decoded, or `undefined`. */
function attribute(attributes: string, name: string): string | undefined {
  let at = 0;
  for (;;) {
    at = attributes.indexOf(name, at);
    if (at < 0) return undefined;
    const before = attributes.charCodeAt(at - 1);
    let equals = at + name.length;
    while (attributes.charCodeAt(equals) === 32) equals++;
    // The name must stand alone; a namespace prefix (`r:id` for `id`) is allowed.
    if (
      (before === 32 || before === 10 || before === 13 || before === 9 || before === 58) &&
      attributes[equals] === "="
    ) {
      let quote = equals + 1;
      while (attributes.charCodeAt(quote) === 32) quote++;
      const mark = attributes[quote];
      const end = attributes.indexOf(mark, quote + 1);
      if (end < 0) return undefined;
      return decodeXml(attributes.slice(quote + 1, end));
    }
    at += name.length;
  }
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes XML entities and Excel's `_xHHHH_` escapes (used for control characters). */
function decodeXml(text: string): string {
  let result = text;
  if (result.includes("&")) {
    result = result.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return entities[name] ?? match;
    });
  }
  if (result.includes("_x")) {
    result = result.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return result;
}

function partFor(entries: Map<string, ZipEntry>, name: string) {
  return entries.get(name.toLowerCase());
}

async function readPart(file: string, entries: Map<string, ZipEntry>, name: string, handler: XmlHandler) {
  const entry = partFor(entries, name);
  if (!entry) return false;
  if (entry.size > MAX_PART) throw new WorkbookError(`The workbook part ${entry.name} is too large to read.`);
  await scanXml(entryText(file, entry), handler);
  return true;
}

/** The relationships of a part, as id → { type, target path inside the archive }. */
async function relationships(file: string, entries: Map<string, ZipEntry>, part: string) {
  const folder = path.posix.dirname(part);
  const relsPath = path.posix.join(folder, "_rels", `${path.posix.basename(part)}.rels`);
  const result = new Map<string, { type: string; target: string }>();
  await readPart(file, entries, relsPath, {
    open(name, attributes) {
      if (name !== "Relationship") return;
      const id = attribute(attributes, "Id");
      const target = attribute(attributes, "Target");
      if (!id || !target || attribute(attributes, "TargetMode") === "External") return;
      const resolved = target.startsWith("/") ? target.slice(1) : path.posix.join(folder, target);
      result.set(id, { type: attribute(attributes, "Type") ?? "", target: path.posix.normalize(resolved) });
    },
    close() {},
    text() {},
  });
  return result;
}

interface WorkbookSheet extends SheetInfo {
  part: string;
}

export interface Workbook {
  sheets: WorkbookSheet[];
  date1904: boolean;
  sharedStrings?: string;
  styles?: string;
  entries: Map<string, ZipEntry>;
}

/** Reads the list of sheets and where the other parts of the workbook are. */
export async function readWorkbook(file: string): Promise<Workbook> {
  const entries = await readZipDirectory(file);
  const root = await relationships(file, entries, "");
  const officeDocument = [...root.values()].find((relation) => relation.type.endsWith("/officeDocument"));
  const workbookPart = officeDocument?.target ?? "xl/workbook.xml";
  if (!partFor(entries, workbookPart)) {
    throw new WorkbookError(
      partFor(entries, "xl/workbook.bin")
        ? "Binary workbooks (.xlsb) are not supported."
        : "The file is not a valid workbook (it has no workbook part).",
    );
  }
  const relations = await relationships(file, entries, workbookPart);
  const sheets: WorkbookSheet[] = [];
  let date1904 = false;
  await readPart(file, entries, workbookPart, {
    open(name, attributes) {
      if (name === "workbookPr") {
        const value = attribute(attributes, "date1904");
        date1904 = value === "1" || value === "true";
      } else if (name === "sheet") {
        const relation = relations.get(attribute(attributes, "id") ?? "");
        // Chart sheets and dialog sheets have no cells.
        if (!relation?.type.endsWith("/worksheet")) return;
        const state = attribute(attributes, "state");
        sheets.push({
          name: attribute(attributes, "name") ?? "",
          ...(state === "hidden" || state === "veryHidden" ? { hidden: true } : {}),
          part: relation.target,
        });
      }
    },
    close() {},
    text() {},
  });
  const typed = (suffix: string) => [...relations.values()].find((relation) => relation.type.endsWith(suffix))?.target;
  return {
    sheets,
    date1904,
    sharedStrings:
      typed("/sharedStrings") ?? (partFor(entries, "xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : undefined),
    styles: typed("/styles") ?? (partFor(entries, "xl/styles.xml") ? "xl/styles.xml" : undefined),
    entries,
  };
}

/** Text of `<t>` elements inside `<si>` / `<is>`, without phonetic runs (`<rPh>`). */
class RichText {
  private inText = false;
  private phonetic = false;
  value = "";

  open(name: string, selfClosing: boolean) {
    if (name === "rPh") this.phonetic = !selfClosing;
    else if (name === "t" && !this.phonetic && !selfClosing) this.inText = true;
  }

  close(name: string) {
    if (name === "rPh") this.phonetic = false;
    else if (name === "t") this.inText = false;
  }

  text(text: string) {
    if (this.inText) this.value += text;
  }

  take() {
    const value = decodeXml(this.value);
    this.value = "";
    return value;
  }
}

async function readSharedStrings(file: string, workbook: Workbook): Promise<string[]> {
  const strings: string[] = [];
  if (!workbook.sharedStrings) return strings;
  const rich = new RichText();
  let inItem = false;
  await readPart(file, workbook.entries, workbook.sharedStrings, {
    open(name, _attributes, selfClosing) {
      if (name === "si") {
        inItem = !selfClosing;
        if (selfClosing) strings.push("");
      } else if (inItem) rich.open(name, selfClosing);
    },
    close(name) {
      if (name === "si" && inItem) {
        strings.push(rich.take());
        inItem = false;
      } else if (inItem) rich.close(name);
    },
    text(text) {
      if (inItem) rich.text(text);
    },
  });
  return strings;
}

/** How a number format shows values. */
enum DateStyle {
  None = 0,
  Date = 1,
  /** Shows a time of day only (no date). */
  Time = 2,
}

/** Built-in number formats that show dates or times (including those of East Asian locales). */
function builtInDateStyle(id: number): DateStyle {
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47) || id === 32 || id === 33) return DateStyle.Time;
  if ((id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return DateStyle.Date;
  return DateStyle.None;
}

/** Whether a custom number format code shows a date or a time. */
export function formatDateStyle(code: string): DateStyle {
  // Only the first section (positive numbers) matters. Quoted text, escaped characters, padding,
  // colors, conditions, locales and the exponent of `0.00E+00` are not date parts; `[h]`, `[m]` and
  // `[s]` (elapsed time) are.
  const cleaned = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\.|_.|\*./g, "")
    .split(";")[0]
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .replace(/General|E[+-]/gi, "");
  const date = /[ydge]/i.test(cleaned);
  const time = /[hs]/i.test(cleaned);
  // `m` is minutes next to hours or seconds, months otherwise.
  if (time) return date ? DateStyle.Date : DateStyle.Time;
  return date || /m/i.test(cleaned) ? DateStyle.Date : DateStyle.None;
}

async function readStyles(file: string, workbook: Workbook): Promise<DateStyle[]> {
  const styles: DateStyle[] = [];
  if (!workbook.styles) return styles;
  const custom = new Map<number, DateStyle>();
  let inCellFormats = false;
  await readPart(file, workbook.entries, workbook.styles, {
    open(name, attributes, selfClosing) {
      if (name === "numFmt") {
        const id = Number(attribute(attributes, "numFmtId"));
        custom.set(id, formatDateStyle(attribute(attributes, "formatCode") ?? ""));
      } else if (name === "cellXfs") {
        inCellFormats = !selfClosing;
      } else if (name === "xf" && inCellFormats) {
        const id = Number(attribute(attributes, "numFmtId") ?? 0);
        styles.push(custom.get(id) ?? builtInDateStyle(id));
      }
    },
    close(name) {
      if (name === "cellXfs") inCellFormats = false;
    },
    text() {},
  });
  return styles;
}

/** The 0-based column of a cell reference such as `AB12`, or -1. */
function columnOf(reference: string) {
  let column = 0;
  let at = 0;
  for (; at < reference.length; at++) {
    const code = reference.charCodeAt(at) & ~32; // upper case
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return at === 0 ? -1 : column - 1;
}

/** The letters of a 0-based column (`0` → `A`). */
export function columnLetters(column: number) {
  let letters = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  return letters;
}

/** Kinds of values seen in a column, as bits. */
const Kind = {
  integer: 1,
  number: 2,
  boolean: 4,
  date: 8,
  dateTime: 16,
  time: 32,
  text: 64,
} as const;

/** The DuckDB type of a column from the kinds of its values: one type, or text when they are mixed. */
function sqlTypeOf(kinds: number) {
  switch (kinds) {
    case Kind.integer:
      return "BIGINT";
    case Kind.number:
    case Kind.integer | Kind.number:
      return "DOUBLE";
    case Kind.boolean:
      return "BOOLEAN";
    case Kind.date:
      return "DATE";
    case Kind.dateTime:
    case Kind.date | Kind.dateTime:
      return "TIMESTAMP";
    case Kind.time:
      return "TIME";
    default:
      return "VARCHAR";
  }
}

const DAY = 86_400_000;
/** Excel's day 0 in the 1900 date system, for serial numbers from 61 (1900-03-01) on. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
/** For serial numbers below 61: Excel counts a 29 February 1900 that did not exist. */
const EPOCH_1900_EARLY = Date.UTC(1899, 11, 31);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** 9999-12-31 in the 1900 date system. */
const MAX_SERIAL = 2_958_466;

function two(value: number) {
  return value < 10 ? `0${value}` : String(value);
}

function timeText(date: Date) {
  const milliseconds = date.getUTCMilliseconds();
  const base = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return milliseconds === 0 ? base : `${base}.${String(milliseconds).padStart(3, "0")}`;
}

function dateText(date: Date) {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/**
 * A date serial number as text, with its kind: a time of day (`HH:MM:SS`) when the format shows only
 * a time and the value is below one day, a date when it has no time part, otherwise a timestamp.
 * Times are rounded to milliseconds.
 */
export function serialDate(serial: number, style: DateStyle, date1904: boolean): { kind: number; text: string } {
  const epoch = date1904 ? EPOCH_1904 : serial < 61 ? EPOCH_1900_EARLY : EPOCH_1900;
  const date = new Date(epoch + Math.round(serial * DAY));
  if (style === DateStyle.Time && serial < 1) return { kind: Kind.time, text: timeText(date) };
  if (date.getTime() % DAY === 0) return { kind: Kind.date, text: dateText(date) };
  return { kind: Kind.dateTime, text: `${dateText(date)} ${timeText(date)}` };
}

function csvText(text: string) {
  return `"${text.replaceAll('"', '""')}"`;
}

function numberText(value: number) {
  return Object.is(value, -0) ? "0" : String(value);
}

/** One column of the sheet in the converted file. */
export interface WorkbookColumn {
  name: string;
  sqlType: string;
  /** The column's letters in the sheet. */
  letters: string;
}

export interface ConvertedSheet {
  sheets: SheetInfo[];
  sheet: string;
  columns: WorkbookColumn[];
  /** A `FROM` item (a subquery reading the CSV file as `$1`) with the columns in order. */
  reader: string;
  rows: number;
  notes: string[];
}

export interface ConvertOptions extends ReadOptions {
  /** Receives the share of the sheet read so far (0–1). */
  onProgress?: (share: number) => void;
  /** Stops the conversion when it returns `true`. */
  cancelled?: () => boolean;
  /** The workbook as `readWorkbook` read it, when it was read already. */
  workbook?: Workbook;
}

/** The sheets of a workbook, for clients. */
export function sheetList(workbook: Workbook): SheetInfo[] {
  return workbook.sheets.map(({ part: _part, ...sheet }) => sheet);
}

/**
 * Converts one sheet of a workbook to a CSV file (`target`) that DuckDB reads with `reader`. Each line
 * starts with the row's number in the sheet; then come the cells from column `A`, numbers, booleans and
 * dates unquoted and text quoted. Blank cells and empty text are empty fields.
 */
export async function convertSheet(
  file: string,
  target: string,
  options: ConvertOptions = {},
): Promise<ConvertedSheet> {
  const workbook = options.workbook ?? (await readWorkbook(file));
  const sheets = sheetList(workbook);
  if (workbook.sheets.length === 0) throw new WorkbookError("The workbook has no worksheets.");
  const chosen =
    options.sheet === undefined
      ? (workbook.sheets.find((sheet) => !sheet.hidden) ?? workbook.sheets[0])
      : workbook.sheets.find((sheet) => sheet.name === options.sheet);
  if (!chosen) throw new WorkbookError(`The workbook has no sheet named "${options.sheet}".`);
  const entry = partFor(workbook.entries, chosen.part);
  if (!entry) throw new WorkbookError(`The workbook is damaged (the sheet "${chosen.name}" is missing).`);
  const [strings, styles] = await Promise.all([readSharedStrings(file, workbook), readStyles(file, workbook)]);

  const headerRow = options.headerRow;
  const keepEmptyRows = options.keepEmptyRows === true;
  const output = createWriteStream(target);
  let pending: string[] = [];
  let pendingLength = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    const text = pending.join("");
    pending = [];
    pendingLength = 0;
    // `once` rejects when the file cannot be written.
    if (!output.write(text)) await once(output, "drain");
  };
  const writeLine = (line: string) => {
    pending.push(line);
    pendingLength += line.length;
  };

  const kinds: number[] = [];
  const header = new Map<number, string>();
  /** Whether the header row has been passed (or there is none). */
  let headerDone = headerRow === 0;
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastColumn = -1;
  let rows = 0;
  /** Empty rows seen since the last data row, written only when another data row follows. */
  let emptyRows: number[] = [];
  let merged = false;
  let formulasWithoutValues = false;
  /** The cells of the current row as people see them, for the header. */
  let headerTexts: string[] = [];

  // The row being read.
  let rowNumber = 0;
  let rowCells: number[] = [];
  let rowFields: string[] = [];
  let rowKinds: number[] = [];
  // The cell being read.
  let cellColumn = -1;
  let cellType = "n";
  let cellStyle = 0;
  let inCell = false;
  let inValue = false;
  let value = "";
  let hasValue = false;
  let hasFormula = false;
  let inInline = false;
  const inline = new RichText();
  let lastCellColumn = -1;

  const startRow = (attributes: string) => {
    const reference = attribute(attributes, "r");
    rowNumber = reference ? Number(reference) : rowNumber + 1;
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS)
      throw new WorkbookError(`The sheet "${chosen.name}" is damaged (a row number is out of range).`);
    rowCells = [];
    rowFields = [];
    rowKinds = [];
    lastCellColumn = -1;
  };

  const endCell = () => {
    inCell = false;
    let field: string | null = null;
    let kind = 0;
    let text = "";
    const raw = hasValue ? value : "";
    if (cellType === "s") {
      text = strings[Number(raw)] ?? "";
      kind = Kind.text;
    } else if (cellType === "inlineStr") {
      text = inline.take();
      kind = Kind.text;
    } else if (cellType === "str" || cellType === "e") {
      // Formula results that are text, and errors such as #DIV/0!.
      text = decodeXml(raw);
      kind = Kind.text;
    } else if (cellType === "b") {
      if (raw !== "") {
        field = raw.trim() === "1" || raw.trim() === "true" ? "TRUE" : "FALSE";
        kind = Kind.boolean;
      }
    } else if (cellType === "d") {
      const iso = decodeXml(raw).trim().replace(/Z$/, "");
      if (iso !== "") {
        const [day, time] = iso.split("T");
        // Times with an offset from UTC have no column type here: they are read as text.
        if (time && /^\d{4}-\d\d-\d\d$/.test(day) && /^\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(time)) {
          field = `${day} ${time}`;
          kind = Kind.dateTime;
        } else if (/^\d{4}-\d\d-\d\d$/.test(iso)) {
          field = iso;
          kind = Kind.date;
        } else {
          text = iso;
          kind = Kind.text;
        }
      }
    } else if (raw.trim() !== "") {
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        text = decodeXml(raw);
        kind = Kind.text;
      } else {
        const style = styles[cellStyle] ?? DateStyle.None;
        if (style !== DateStyle.None && number >= 0 && number < MAX_SERIAL) {
          const date = serialDate(number, style, workbook.date1904);
          field = date.text;
          kind = date.kind;
        } else {
          field = numberText(number);
          kind = Number.isSafeInteger(number) ? Kind.integer : Kind.number;
        }
      }
    }
    if (kind === Kind.text) {
      if (text === "") kind = 0;
      else field = csvText(text);
    }
    if (field === null || kind === 0) {
      if (hasFormula && !hasValue) formulasWithoutValues = true;
      return;
    }
    rowCells.push(cellColumn);
    rowFields.push(field);
    rowKinds.push(kind);
    headerTexts.push(kind === Kind.text ? text : field);
  };

  const emitRow = () => {
    const empty = rowCells.length === 0;
    if (!headerDone) {
      const isHeader = headerRow === undefined ? !empty : rowNumber >= headerRow;
      if (isHeader) {
        headerDone = true;
        if (headerRow === undefined || rowNumber === headerRow) {
          for (let index = 0; index < rowCells.length; index++) {
            header.set(rowCells[index], headerTexts[index]);
            firstColumn = Math.min(firstColumn, rowCells[index]);
            lastColumn = Math.max(lastColumn, rowCells[index]);
          }
          headerTexts = [];
          return;
        }
        // The header row is missing from the sheet: this row is already data.
      } else {
        headerTexts = [];
        return;
      }
    }
    headerTexts = [];
    if (empty) {
      if (keepEmptyRows && rows > 0) emptyRows.push(rowNumber);
      return;
    }
    for (const number of emptyRows) writeLine(`${number}\n`);
    rows += emptyRows.length + 1;
    emptyRows = [];
    let line = String(rowNumber);
    let column = -1;
    for (let index = 0; index < rowCells.length; index++) {
      const cell = rowCells[index];
      line += ",".repeat(cell - column);
      line += rowFields[index];
      column = cell;
      kinds[cell] = (kinds[cell] ?? 0) | rowKinds[index];
    }
    firstColumn = Math.min(firstColumn, rowCells[0]);
    lastColumn = Math.max(lastColumn, column);
    writeLine(`${line}\n`);
  };

  /** Rows missing from the file between two rows are empty rows. */
  const gapRows = (previous: number, next: number) => {
    if (!headerDone || !keepEmptyRows || rows === 0) return;
    for (let number = previous + 1; number < next; number++) emptyRows.push(number);
  };

  let read = 0;
  try {
    await scanXml(
      entryText(file, entry, (bytes) => {
        read += bytes;
        options.onProgress?.(entry.compressedSize > 0 ? Math.min(1, read / entry.compressedSize) : 1);
      }),
      {
        open(name, attributes, selfClosing) {
          if (inInline) {
            inline.open(name, selfClosing);
            return;
          }
          switch (name) {
            case "row": {
              const previous = rowNumber;
              startRow(attributes);
              if (rowNumber <= previous)
                throw new WorkbookError(`The sheet "${chosen.name}" is damaged (its rows are out of order).`);
              gapRows(previous, rowNumber);
              if (selfClosing) emitRow();
              break;
            }
            case "c": {
              const reference = attribute(attributes, "r");
              cellColumn = reference ? columnOf(reference) : lastCellColumn + 1;
              if (cellColumn < 0 || cellColumn >= MAX_COLUMNS || cellColumn <= lastCellColumn)
                throw new WorkbookError(`The sheet "${chosen.name}" is damaged (a cell reference is invalid).`);
              lastCellColumn = cellColumn;
              cellType = attribute(attributes, "t") ?? "n";
              cellStyle = Number(attribute(attributes, "s") ?? 0);
              inCell = true;
              value = "";
              hasValue = false;
              hasFormula = false;
              if (selfClosing) endCell();
              break;
            }
            case "v":
              if (inCell) {
                inValue = !selfClosing;
                hasValue = true;
              }
              break;
            case "f":
              if (inCell) hasFormula = true;
              break;
            case "is":
              if (inCell && !selfClosing) {
                inInline = true;
                hasValue = true;
              }
              break;
            case "mergeCell":
              merged = true;
              break;
          }
        },
        close(name) {
          if (inInline) {
            if (name === "is") inInline = false;
            else inline.close(name);
            return;
          }
          if (name === "v") inValue = false;
          else if (name === "c" && inCell) endCell();
          else if (name === "row") emitRow();
        },
        text(text) {
          if (inValue) value += text;
          else if (inInline) inline.text(text);
        },
      },
      {
        cancelled: options.cancelled,
        // Writing in parts as the sheet is read keeps memory flat.
        afterChunk: () => (pendingLength > 1024 * 1024 ? flush() : undefined),
      },
    );
    await flush();
  } catch (error) {
    output.destroy();
    throw error;
  }
  output.end();
  await once(output, "finish");

  const physical = Math.max(lastColumn + 1, 1);
  const columns: (WorkbookColumn & { index: number })[] = [];
  const taken = new Set<string>();
  const start = Number.isFinite(firstColumn) ? firstColumn : 0;
  for (let index = start; index <= lastColumn; index++) {
    const name = header.get(index);
    if (!options.keepEmptyColumns && !kinds[index] && name === undefined) continue;
    const letters = columnLetters(index);
    let unique = name === undefined || name.trim() === "" ? letters : name;
    if (taken.has(unique.toLowerCase())) {
      let suffix = 2;
      while (taken.has(`${unique}_${suffix}`.toLowerCase())) suffix++;
      unique = `${unique}_${suffix}`;
    }
    taken.add(unique.toLowerCase());
    columns.push({ name: unique, sqlType: sqlTypeOf(kinds[index] ?? 0), letters, index });
  }
  if (columns.length === 0) columns.push({ name: "A", sqlType: "VARCHAR", letters: "A", index: 0 });
  const definitions = [`${quoteLiteral("r")}: 'BIGINT'`];
  const used = new Map(columns.map((column) => [column.index, column]));
  for (let index = 0; index < physical; index++) {
    definitions.push(`${quoteLiteral(`c${index}`)}: ${quoteLiteral(used.get(index)?.sqlType ?? "VARCHAR")}`);
  }
  const selected = columns.map((column) => `${quoteIdentifier(`c${column.index}`)} AS ${quoteIdentifier(column.name)}`);
  const reader =
    `(SELECT ${selected.join(", ")} FROM read_csv($1, header=false, auto_detect=false, delim=',', quote='"', ` +
    `escape='"', null_padding=true, max_line_size=16777216, columns={${definitions.join(", ")}}))`;
  const notes: string[] = [];
  if (merged) notes.push("merged_cells");
  if (formulasWithoutValues) notes.push("formulas_without_values");
  return {
    sheets,
    sheet: chosen.name,
    columns: columns.map(({ index: _index, ...column }) => column),
    reader,
    rows,
    notes,
  };
}
