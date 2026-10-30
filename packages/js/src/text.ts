/**
 * Tables given as text files (CSV, TSV and JSON Lines in UTF-8), read by a module of their own that the engine
 * loads with the first such table, so that pages whose tables are rows do not load it. A file is read in slices,
 * first to find its columns, the types that all their values fit, the memory they take and where every 1,024th row
 * starts. When its columns fit `maxBytes`, it is read again to keep its values in typed columns, numbers in typed
 * arrays and text as UTF-8, without making rows of JSON; otherwise its rows are read by blocks of 1,024 rows as
 * requests need them, and columns whole only when a request goes through every row of them (lazy.ts).
 */
import {
  type Column,
  dateText,
  daysFromCivil,
  FIRST_DAY,
  floatJson,
  type JsonValue,
  LAST_DAY,
  timestampText,
  timeText,
} from "vastgrid-spec";
import type { ColumnNumbers } from "vastgrid-spec/columns";
import { FileColumns } from "./lazy.js";
import { HIGH, LOW, TWO_32 } from "./order.js";
import {
  type CheckedTable,
  type FileTable,
  isObject,
  shown,
  TableProblem,
  type TextFile,
  type TextFormat,
  type Vector,
} from "./table.js";

/** Bytes read at a time. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Rows of a block, the part of a file that rows are read by when its columns are not kept. */
const BLOCK_ROWS = 1024;
/** The bytes of the blocks read for rows that are kept, the most recently used. */
const CACHE_BYTES = 32 * 1024 * 1024;
/** The memory that a table's columns may take by default (`FileTable.maxBytes`). */
const MAX_BYTES = 2 ** 30;

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
/** `e`, which a byte ORed with 0x20 is when it is `e` or `E`. */
const LOWER_E = 0x65;

/** The types that a value fits, as bits. */
const BOOLEAN = 1;
const INTEGER = 2;
const BIGINT = 4;
const FLOAT = 8;
const TIME = 16;
const DATE = 32;
const TIMESTAMP = 64;
const TIMESTAMPTZ = 128;
const TEMPORAL = TIME | DATE | TIMESTAMP | TIMESTAMPTZ;
const EVERY = 255;

/** The types of a column in the order they are tried: the first that every value of the column fits. */
const TYPES: readonly [number, Column["type"]][] = [
  [BOOLEAN, "boolean"],
  [INTEGER, "integer"],
  [BIGINT, "bigint"],
  [FLOAT, "float"],
  [TIME, "time"],
  [DATE, "date"],
  [TIMESTAMP, "timestamp"],
  [TIMESTAMPTZ, "timestamptz"],
];

const FORMATS = new Map<string, TextFormat>([
  ["csv", "csv"],
  ["tsv", "tsv"],
  ["tab", "tsv"],
  ["jsonl", "jsonl"],
  ["ndjson", "jsonl"],
]);

/** The words of floats that are not numbers, as DuckDB reads them. */
const FLOAT_WORDS = new Map<string, number>(
  ["", "+", "-"].flatMap((sign) => [
    [`${sign}nan`, Number.NaN],
    [`${sign}inf`, sign === "-" ? -Infinity : Infinity],
    [`${sign}infinity`, sign === "-" ? -Infinity : Infinity],
  ]),
);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const DAY_MICROS = 86_400_000_000;
/** The microseconds of the last date's day that a timestamp holds, before 64 bits overflow. */
const LAST_DAY_MICROS = Number(INT64_MAX - BigInt(LAST_DAY) * BigInt(DAY_MICROS));

// The page, Web Workers and Node.js all have these; the package is typed without the DOM or Node.js.
declare const TextDecoder: new (
  label: string,
  options: { ignoreBOM: boolean; fatal: boolean },
) => { decode(bytes: Uint8Array): string };
declare const TextEncoder: new () => { encodeInto(text: string, bytes: Uint8Array): { written: number } };

/** Text of fields and lines, which the first reading has checked as UTF-8; it keeps a byte order mark. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

/** What the first reading found of a column. */
interface Found {
  /** The column's name: of the header of a CSV file, or a key of JSON Lines. */
  name: string;
  /** The types that every value so far fits. */
  fits: number;
  /** Values that are not null or empty. */
  values: number;
  /** Quoted empty fields of CSV (`""`), empty strings of a string column and nulls of the others. */
  empty: number;
  /** The bytes of the values as UTF-8 text. */
  bytes: number;
  /** Objects and lists of JSON. */
  nested: number;
}

function found(name: string): Found {
  return { name, fits: EVERY, values: 0, empty: 0, bytes: 0, nested: 0 };
}

/**
 * Reads a table given as a text file into typed columns. Throws a `TableProblem` at the member of the table at
 * fault, or at `/rows/{row}/{column}` (`/rows/{row}` for a line of JSON Lines) for text that is not UTF-8 or a
 * line that is not JSON. `fields` gives the column of each field of a CSV file, whose values fit its type, or null
 * for a field that is left out (workbook.ts); by default each field is a column of the type its values fit.
 */
export async function readFile(
  table: FileTable,
  chunkBytes = CHUNK_BYTES,
  fields?: readonly (Column | null)[],
): Promise<CheckedTable> {
  const { file } = table;
  if (
    file === null ||
    typeof file !== "object" ||
    typeof file.size !== "number" ||
    typeof (file as { slice?: unknown }).slice !== "function"
  ) {
    throw new TableProblem("/file", "file is a Blob or a File.");
  }
  const format = formatOf(table);
  if (format !== "csv" && format !== "tsv" && format !== "jsonl") {
    throw new TableProblem(
      "/format",
      table.format === undefined
        ? `The file's name (${shown(file.name ?? null)}) does not tell its format: give format, csv, tsv, jsonl or xlsx.`
        : "format is csv, tsv, jsonl or xlsx.",
    );
  }
  const { delimiter, header = true, maxBytes = MAX_BYTES } = table;
  if (delimiter !== undefined) {
    const code = typeof delimiter === "string" && delimiter.length === 1 ? delimiter.charCodeAt(0) : -1;
    if (format !== "csv" || code < 0 || code >= 0x80 || code === QUOTE || code === CR || code === LF) {
      throw new TableProblem(
        "/delimiter",
        "delimiter is one ASCII character other than a quote or a line break, for CSV.",
      );
    }
  }
  if (typeof header !== "boolean") throw new TableProblem("/header", "header is a boolean.");
  if (typeof maxBytes !== "number" || !(maxBytes > 0)) {
    throw new TableProblem("/maxBytes", "maxBytes is a number of bytes.");
  }

  const csv =
    format === "jsonl" ? null : { separator: format === "tsv" ? TAB : (delimiter?.charCodeAt(0) ?? null), header };
  const survey = csv ? await surveyCsv(file, csv, chunkBytes) : await surveyJson(file, chunkBytes);
  const { rows } = survey;
  const fieldOf = fields
    ? fields.flatMap((column, field) => (column ? [field] : []))
    : survey.found.map((_, field) => field);
  const kept = fieldOf.map((field) => survey.found[field] ?? found(""));
  const columns = fields ? fieldOf.map((field) => ({ ...(fields[field] as Column) })) : kept.map(columnOf);
  const total = columns.reduce((sum, column, index) => sum + sizeOf(column, kept[index], rows), 0);
  if (total > maxBytes) {
    const text: TextOf = csv ? { separator: survey.separator, header: csv.header } : null;
    return new TextColumns(file, text, columns, { ...survey, found: kept }, fieldOf, maxBytes, chunkBytes).checked();
  }
  const built = columns.map((column, index) => build(column, kept[index], rows));
  const read = csv
    ? await keepCsv(file, survey.separator, csv.header, byField(built, fieldOf), rows, chunkBytes)
    : await keepJson(file, built, rows, chunkBytes);
  if (read !== rows) throw changed();
  return { columns, rows: null, vectors: built.map((column) => vectorOf(column, rows)), rowCount: rows };
}

/** The format of a table given as a text file: its own, or the one of its file's name. */
function formatOf(table: FileTable): TextFormat | undefined {
  return table.format ?? FORMATS.get(/\.([^.]+)$/.exec(String(table.file.name ?? ""))?.[1].toLowerCase() ?? "");
}

/**
 * The first rows of a text file larger than `bytes`, read as the file is from the lines that end in its first
 * `bytes` (§9). The last of them is left out, since a line break in quotes may have cut it, and their columns have
 * the types that those rows fit. Null for a smaller file, and for one whose start cannot be read: the reading of the
 * whole file tells why.
 */
export async function readPreview(table: FileTable, bytes: number): Promise<CheckedTable | null> {
  const { file } = table;
  if (!isObject(file) || typeof file.size !== "number" || file.size <= bytes || typeof file.slice !== "function") {
    return null;
  }
  try {
    const head = new Uint8Array(await file.slice(0, bytes).arrayBuffer());
    const end = head.lastIndexOf(LF) + 1;
    if (end === 0) return null;
    const lines: TextFile = {
      size: end,
      slice: (start = 0, stop = end) => ({ arrayBuffer: async () => head.slice(start, stop).buffer }),
    };
    const read = await readFile({ ...table, format: formatOf(table), file: lines });
    return read.reader ? null : { ...read, rowCount: Math.max(0, read.rowCount - 1) };
  } catch {
    return null;
  }
}

/** The columns of a CSV file's fields, by field: null for the fields that are not columns. */
function byField<T>(columns: (T | null)[], fieldOf: readonly number[]): (T | null)[] {
  const fields: (T | null)[] = new Array(fieldOf.length === 0 ? 0 : Math.max(...fieldOf) + 1).fill(null);
  fieldOf.forEach((field, index) => {
    fields[field] = columns[index];
  });
  return fields;
}

function changed() {
  return new TableProblem("/file", "The file changed while it was read.");
}

/** What the first reading of a file found: its columns and rows, CSV's separator, and where its blocks start. */
interface Survey {
  separator: number;
  found: Found[];
  rows: number;
  /** Where each block of `BLOCK_ROWS` rows starts in the file. */
  starts: number[];
}

/** How a text file is read: as CSV or TSV, with its separator and whether its first line names the columns, or as JSON Lines (null). */
type TextOf = { separator: number; header: boolean } | null;

/**
 * A text file whose columns would take more than `maxBytes`: its rows are read by blocks of `BLOCK_ROWS` rows, from
 * where the first reading found that each starts, and its columns whole when a request goes through every row of
 * them, within `maxBytes`.
 */
class TextColumns extends FileColumns {
  private readonly found: Found[];
  private readonly starts: number[];
  /** Blocks of rows read, the most recently used last, and the bytes of the file that they hold. */
  private readonly cache = new Map<number, Promise<Vector[]>>();
  private cached = 0;

  constructor(
    private readonly file: TextFile,
    private readonly text: TextOf,
    columns: Column[],
    survey: Survey,
    /** The field of a CSV file that each column is. */
    private readonly fieldOf: readonly number[],
    maxBytes: number,
    private readonly chunkBytes: number,
  ) {
    super(columns, survey.rows, maxBytes);
    this.found = survey.found;
    this.starts = survey.starts;
  }

  protected partOf(row: number): number {
    return Math.floor(row / BLOCK_ROWS);
  }

  /** The rows of a view are read by blocks wherever they lie: a block is small, and reading a column whole reads the file. */
  protected override get spread(): number {
    return Number.POSITIVE_INFINITY;
  }

  protected sizeOf(index: number): number {
    return sizeOf(this.columns[index], this.found[index], this.rowCount);
  }

  /** The bytes of the file that a block's rows lie in. */
  private spanOf(block: number): { start: number; end: number } {
    return { start: this.starts[block], end: this.starts[block + 1] ?? this.file.size };
  }

  /** A block's columns, read once and kept while they fit the cache. */
  private block(block: number): Promise<Vector[]> {
    const span = this.spanOf(block);
    const size = span.end - span.start;
    let entry = this.cache.get(block);
    if (entry) {
      this.cache.delete(block);
    } else {
      const rows = Math.min(BLOCK_ROWS, this.rowCount - block * BLOCK_ROWS);
      // A column's text takes the block's bytes at most, and is cut to its length once read.
      const built = this.columns.map((column, index) =>
        build(column, { ...this.found[index], values: 0, empty: 0, bytes: size }, rows),
      );
      entry = this.keep(built, rows, span).then(() =>
        built.map((column) => {
          if (column.text) column.text = column.text.slice(0, column.cursor);
          return vectorOf(column, rows);
        }),
      );
      this.cached += size;
      // A failed read is not kept.
      entry.catch(() => {
        if (this.cache.get(block) === entry) {
          this.cache.delete(block);
          this.cached -= size;
        }
      });
    }
    this.cache.set(block, entry);
    for (const [old] of this.cache) {
      if (this.cached <= CACHE_BYTES || old === block) break;
      const { start, end } = this.spanOf(old);
      this.cache.delete(old);
      this.cached -= end - start;
    }
    return entry;
  }

  /** Reads rows of the file into the columns that are not null, and fails when they are not the rows it had. */
  private async keep(built: (Built | null)[], rows: number, span: Span): Promise<void> {
    const { file, text, chunkBytes } = this;
    const read = text
      ? await keepCsv(
          file,
          text.separator,
          text.header && span.start === undefined,
          byField(built, this.fieldOf),
          rows,
          chunkBytes,
          span,
        )
      : await keepJson(file, built, rows, chunkBytes, span);
    if (read !== rows) throw changed();
  }

  protected async readCells(index: number, rows: ArrayLike<number>): Promise<JsonValue[]> {
    const blocks = new Map<number, Promise<Vector[]>>();
    for (let at = 0; at < rows.length; at++) {
      const block = this.partOf(rows[at]);
      if (!blocks.has(block)) blocks.set(block, this.block(block));
    }
    const read = new Map<number, Vector>();
    for (const [block, columns] of blocks) read.set(block, (await columns)[index]);
    return Array.from(rows, (row) => (read.get(this.partOf(row)) as Vector).at(row % BLOCK_ROWS));
  }

  protected async readWhole(indexes: number[], pause: () => Promise<void>): Promise<Vector[]> {
    const built: (Built | null)[] = this.columns.map(() => null);
    for (const index of indexes) built[index] = build(this.columns[index], this.found[index], this.rowCount);
    await this.keep(built, this.rowCount, { pause });
    return indexes.map((index) => vectorOf(built[index] as Built, this.rowCount));
  }

  close(): void {
    this.cache.clear();
    this.cached = 0;
  }
}

/** A column of the values that the first reading found. */
function columnOf(column: Found): Column {
  const { name } = column;
  if (column.values > 0) {
    for (const [bit, type] of TYPES) if (column.fits & bit) return { name, type };
    // Objects and lists of JSON, and only they, make a column of their JSON text (§2.1).
    if (column.nested === column.values) return { name, type: "string", sourceType: "JSON", readOnly: true };
  }
  return { name, type: "string" };
}

/** The values of a column that are not null. */
function present(column: Column, found: Found) {
  return column.type === "string" ? found.values + found.empty : found.values;
}

/** The bytes that a column's values take in memory, `Infinity` for text of more than 4 GiB, which is not kept. */
function sizeOf(column: Column, found: Found, rows: number): number {
  return column.type === "string" && found.bytes > 0xffff_ffff ? Infinity : memoryOf(column, found, rows);
}

/** The bytes that a column's values take in memory. */
function memoryOf(column: Column, found: Found, rows: number): number {
  const validity = present(column, found) < rows ? Math.ceil(rows / 8) : 0;
  switch (column.type) {
    case "boolean":
      return rows + validity;
    case "integer":
    case "date":
      return 4 * rows + validity;
    case "string":
      return 4 * (rows + 1) + found.bytes + validity;
    default:
      return 8 * rows + validity;
  }
}

/** A column's values as the second reading keeps them. */
interface Built {
  column: Column;
  /** Whether each row holds a value, a bit per row as Arrow writes them; null when every row does. */
  validity: Uint8Array | null;
  numbers: ColumnNumbers | null;
  /** The numbers of a column of 64-bit integers as halves, which safe integers are written as without a BigInt. */
  halves: Uint32Array | null;
  /** Booleans, 1 for true. */
  flags: Uint8Array | null;
  /** Where the text of each row starts in `text`, and where the last ends. */
  offsets: Uint32Array | null;
  text: Uint8Array | null;
  /** Where the next text goes in `text`. */
  cursor: number;
}

function build(column: Column, found: Found, rows: number): Built {
  const validity = present(column, found) < rows ? new Uint8Array(Math.ceil(rows / 8)) : null;
  const built: Built = {
    column,
    validity,
    numbers: null,
    halves: null,
    flags: null,
    offsets: null,
    text: null,
    cursor: 0,
  };
  switch (column.type) {
    case "boolean":
      built.flags = new Uint8Array(rows);
      break;
    case "integer":
    case "date":
      built.numbers = new Int32Array(rows);
      break;
    case "float":
      built.numbers = new Float64Array(rows);
      break;
    case "string":
      built.offsets = new Uint32Array(rows + 1);
      built.text = new Uint8Array(found.bytes);
      break;
    default:
      built.numbers = new BigInt64Array(rows);
      built.halves = new Uint32Array(built.numbers.buffer);
  }
  return built;
}

/** The JSON (§2.2) of a value of a logical type from the number that holds it. */
function numberJson(type: Column["type"]): (value: number | bigint) => JsonValue {
  switch (type) {
    case "integer":
      return (value) => value as number;
    case "float":
      return (value) => floatJson(value as number);
    case "date":
      return (value) => dateText(value as number);
    case "bigint":
      return (value) => (Number.isSafeInteger(Number(value)) ? Number(value) : (value as bigint).toString());
    case "time":
      return (value) => timeText(value as bigint);
    case "timestamp":
      return (value) => timestampText(value as bigint);
    default:
      return (value) => `${timestampText(value as bigint)}+00`;
  }
}

/** The text of UTF-8 bytes; short text of ASCII without a decoder. */
function textOf(bytes: Uint8Array, start: number, end: number): string {
  if (end - start <= 32) {
    let text = "";
    for (let index = start; index < end; index++) {
      const code = bytes[index];
      if (code >= 0x80) return decoder.decode(bytes.subarray(start, end));
      text += String.fromCharCode(code);
    }
    return text;
  }
  return decoder.decode(bytes.subarray(start, end));
}

function vectorOf(built: Built, rows: number): Vector {
  const { validity } = built;
  const valid = (row: number) => validity === null || ((validity[row >> 3] >> (row & 7)) & 1) === 1;
  const { numbers, flags, offsets, text } = built;
  let at: (row: number) => JsonValue;
  if (numbers) {
    const json = numberJson(built.column.type);
    at = (row) => (valid(row) ? json(numbers[row]) : null);
  } else if (flags) {
    at = (row) => (valid(row) ? flags[row] === 1 : null);
  } else {
    const ends = offsets as Uint32Array;
    const bytes = text as Uint8Array;
    at = (row) => (valid(row) ? textOf(bytes, ends[row], ends[row + 1]) : null);
  }
  return { length: rows, numbers, validity, at };
}

/** Sets a row's bit of validity. */
function mark(built: Built, row: number) {
  if (built.validity) built.validity[row >> 3] |= 1 << (row & 7);
}

/** Where a reading of a file starts and ends, and what it calls between slices (a request's `pause`). */
interface Span {
  /** The first byte read; by default the one after the file's byte order mark. */
  start?: number;
  end?: number;
  pause?: () => Promise<void>;
}

/**
 * Reads a file in slices from after its byte order mark, giving each to `read` after the bytes that the last one
 * left, with where they start in the file: `read` gives how many of them it used. A row longer than a slice makes
 * the next slice as long, so that its bytes are not read again and again.
 */
async function eachSlice(
  file: TextFile,
  chunkBytes: number,
  read: (bytes: Uint8Array, last: boolean, base: number) => number,
  span: Span = {},
) {
  const size = span.end ?? file.size;
  const bytesOf = async (start: number, end: number) => {
    try {
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    } catch (error) {
      throw new TableProblem("/file", `The file cannot be read: ${(error as Error).message}`);
    }
  };
  let offset = span.start ?? 0;
  if (span.start === undefined) {
    const head = await bytesOf(0, Math.min(size, 3));
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offset = 3;
    else if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
      throw new TableProblem("/file", "The file is UTF-16 text; save it as UTF-8.");
    }
  }
  let rest: Uint8Array | null = null;
  for (let first = true; ; first = false) {
    if (!first) await span.pause?.();
    const end = Math.min(size, offset + Math.max(chunkBytes, rest?.length ?? 0));
    let bytes = await bytesOf(offset, end);
    if (rest) {
      const joined = new Uint8Array(rest.length + bytes.length);
      joined.set(rest);
      joined.set(bytes, rest.length);
      bytes = joined;
    }
    const last = end >= size;
    const used = read(bytes, last, end - bytes.length);
    if (last) return;
    rest = used < bytes.length ? bytes.subarray(used) : null;
    offset = end;
  }
}

/**
 * The length of the UTF-8 sequence that starts with a byte of 0x80 or more at `index`: 2 to 4 bytes, 0 when the
 * bytes are not UTF-8 (overlong forms, surrogates and code points beyond U+10FFFF are not), −1 when `end` cuts it.
 */
function sequenceLength(bytes: Uint8Array, index: number, end: number): number {
  const lead = bytes[index];
  let length: number;
  let low = 0x80;
  let high = 0xbf;
  if (lead < 0xc2) return 0;
  if (lead < 0xe0) length = 2;
  else if (lead < 0xf0) {
    length = 3;
    if (lead === 0xe0) low = 0xa0;
    else if (lead === 0xed) high = 0x9f;
  } else if (lead < 0xf5) {
    length = 4;
    if (lead === 0xf0) low = 0x90;
    else if (lead === 0xf4) high = 0x8f;
  } else return 0;
  for (let next = 1; next < length; next++) {
    if (index + next >= end) return -1;
    const byte = bytes[index + next];
    if (byte < low || byte > high) return 0;
    low = 0x80;
    high = 0xbf;
  }
  return length;
}

/** The fields of a row of CSV: where each starts and ends in the bytes, and whether it holds a quote. */
class Fields {
  starts = new Int32Array(16);
  ends = new Int32Array(16);
  quoted = new Uint8Array(16);
  count = 0;

  add(start: number, end: number, quoted: number) {
    if (this.count === this.starts.length) {
      const grow = <T extends Int32Array | Uint8Array>(array: T, make: (length: number) => T) => {
        const grown = make(array.length * 2);
        grown.set(array);
        return grown;
      };
      this.starts = grow(this.starts, (length) => new Int32Array(length));
      this.ends = grow(this.ends, (length) => new Int32Array(length));
      this.quoted = grow(this.quoted, (length) => new Uint8Array(length));
    }
    this.starts[this.count] = start;
    this.ends[this.count] = end;
    this.quoted[this.count] = quoted;
    this.count++;
  }
}

/** Bytes that are not UTF-8, in the row being read, in its field `field`. */
class NotUtf8 {
  constructor(readonly field: number) {}
}

/**
 * Reads the rows of CSV bytes, calling `row` with each row's fields, and gives where the first row that is not
 * whole starts (all of the bytes when they are the last). A quote switches quoting on and off wherever it is, so
 * that a doubled quote within quotes is a quote; a line break outside quotes ends a row, without a carriage return
 * before it, and an empty line is no row. Throws `NotUtf8` for bytes that are not UTF-8.
 */
function scanCsv(bytes: Uint8Array, separator: number, last: boolean, fields: Fields, row: () => void): number {
  const end = bytes.length;
  let rowStart = 0;
  let fieldStart = 0;
  let inQuotes = false;
  let quoted = 0;
  const endRow = (fieldEnd: number) => {
    fields.add(fieldStart, fieldEnd > fieldStart && bytes[fieldEnd - 1] === CR ? fieldEnd - 1 : fieldEnd, quoted);
    if (fields.count > 1 || fields.ends[0] > fields.starts[0] || quoted) row();
    fields.count = 0;
    quoted = 0;
  };
  fields.count = 0;
  for (let index = 0; index < end; index++) {
    const code = bytes[index];
    if (code === QUOTE) {
      inQuotes = !inQuotes;
      quoted = 1;
    } else if (code >= 0x80) {
      const length = sequenceLength(bytes, index, end);
      if (length > 0) index += length - 1;
      else if (length < 0 && !last) return rowStart;
      else throw new NotUtf8(fields.count);
    } else if (!inQuotes) {
      if (code === separator) {
        fields.add(fieldStart, index, quoted);
        fieldStart = index + 1;
        quoted = 0;
      } else if (code === LF) {
        endRow(index);
        fieldStart = rowStart = index + 1;
      }
    }
  }
  if (!last) return rowStart;
  if (fieldStart < end || fields.count > 0 || quoted) endRow(end);
  return end;
}

/** Where `unquote` writes the text of a field. */
let unquoted = new Uint8Array(256);

/**
 * Writes the text of a field that holds a quote into `unquoted`, and gives its length: quotes switch quoting, and
 * a doubled quote within quotes is a quote.
 */
function unquote(bytes: Uint8Array, start: number, end: number): number {
  if (unquoted.length < end - start) unquoted = new Uint8Array(Math.max(end - start, unquoted.length * 2));
  let length = 0;
  let inQuotes = false;
  for (let index = start; index < end; index++) {
    const code = bytes[index];
    if (code !== QUOTE) unquoted[length++] = code;
    else if (inQuotes && index + 1 < end && bytes[index + 1] === QUOTE) {
      unquoted[length++] = QUOTE;
      index++;
    } else inQuotes = !inQuotes;
  }
  return length;
}

/** The separator of `,`, tab, `;` and `|` that splits the first line into the most fields; `,` when none does. */
function detectSeparator(bytes: Uint8Array): number {
  const candidates = [0x2c, TAB, 0x3b, 0x7c];
  const counts = [0, 0, 0, 0];
  let inQuotes = false;
  for (let index = 0; index < bytes.length; index++) {
    const code = bytes[index];
    if (code === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (code === LF) break;
      const at = candidates.indexOf(code);
      if (at >= 0) counts[at]++;
    }
  }
  let best = 0;
  for (let at = 1; at < counts.length; at++) if (counts[at] > counts[best]) best = at;
  return candidates[best];
}

/** ASCII bytes as text. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return end - start > 64 ? decoder.decode(bytes.subarray(start, end)) : textOf(bytes, start, end);
}

function isDigit(code: number) {
  return code >= ZERO && code <= NINE;
}

/** The value of the text of an integer of no more than 15 digits. */
function integerValue(bytes: Uint8Array, start: number, end: number): number {
  let index = start;
  const negative = bytes[index] === MINUS;
  if (negative || bytes[index] === PLUS) index++;
  let value = 0;
  for (; index < end; index++) value = value * 10 + (bytes[index] - ZERO);
  return negative ? -value : value;
}

/** Powers of ten that are floats exactly. */
const POWERS = Array.from({ length: 23 }, (_, power) => Number(`1e${power}`));

/**
 * The float of the text of a number: a decimal of up to 15 digits without an exponent is its digits divided by a
 * power of ten, both exact, which rounds once as `Number` does (Clinger's fast path); others are read by `Number`.
 */
function floatValue(bytes: Uint8Array, start: number, end: number): number {
  let index = start;
  const negative = bytes[index] === MINUS;
  if (negative || bytes[index] === PLUS) index++;
  let mantissa = 0;
  let count = 0;
  let scale = 0;
  for (; index < end && isDigit(bytes[index]); index++, count++) mantissa = mantissa * 10 + bytes[index] - ZERO;
  if (index < end && bytes[index] === DOT) {
    for (index++; index < end && isDigit(bytes[index]); index++, count++, scale++) {
      mantissa = mantissa * 10 + bytes[index] - ZERO;
    }
  }
  if (index < end || count > 15) {
    const text = ascii(bytes, start, end);
    const value = Number(text);
    return Number.isNaN(value) ? (FLOAT_WORDS.get(text.toLowerCase()) ?? value) : value;
  }
  const value = mantissa / POWERS[scale];
  return negative ? -value : value;
}

/** The types that the text of an integer fits, with its digits from `digits`. */
function integerFits(bytes: Uint8Array, start: number, digits: number, end: number): number {
  let first = digits;
  while (first < end - 1 && bytes[first] === ZERO) first++;
  const count = end - first;
  if (count <= 9) return INTEGER | BIGINT | FLOAT;
  if (count <= 15) {
    const value = integerValue(bytes, start, end);
    return value >= -0x8000_0000 && value <= 0x7fff_ffff ? INTEGER | BIGINT | FLOAT : BIGINT | FLOAT;
  }
  if (count <= 19) {
    const value = BigInt(ascii(bytes, start, end));
    return value >= INT64_MIN && value <= INT64_MAX ? BIGINT | FLOAT : FLOAT;
  }
  return FLOAT;
}

/** Whether the text from `index`, after the whole digits of a number, ends it as a float: a fraction, an exponent. */
function floatRest(bytes: Uint8Array, index: number, end: number, whole: boolean): boolean {
  let at = index;
  let fraction = 0;
  if (bytes[at] === DOT) {
    const from = ++at;
    while (at < end && isDigit(bytes[at])) at++;
    fraction = at - from;
  }
  if (!whole && fraction === 0) return false;
  if (at < end && (bytes[at] | 0x20) === LOWER_E) {
    at++;
    if (at < end && (bytes[at] === PLUS || bytes[at] === MINUS)) at++;
    const from = at;
    while (at < end && isDigit(bytes[at])) at++;
    if (at === from) return false;
  }
  return at === end;
}

/**
 * The types that the text of a field fits, of those in `wanted`: booleans (`true`, `false` in any case), integers
 * by their range, floats (with `nan`, `inf` and `infinity`), and times, dates and timestamps (`temporalFits`).
 */
function textFits(bytes: Uint8Array, start: number, end: number, wanted: number): number {
  const first = bytes[start];
  const signed = first === PLUS || first === MINUS;
  let index = signed ? start + 1 : start;
  const digits = index;
  while (index < end && isDigit(bytes[index])) index++;
  const whole = index - digits;
  if (index === end) return whole > 0 ? wanted & integerFits(bytes, start, digits, end) : 0;
  const next = bytes[index];
  if (wanted & FLOAT && (next === DOT || (next | 0x20) === LOWER_E) && floatRest(bytes, index, end, whole > 0)) {
    return FLOAT;
  }
  if (
    wanted & TEMPORAL &&
    (signed ? whole === 6 && next === MINUS : (whole === 2 && next === COLON) || (whole === 4 && next === MINUS)) &&
    end - start <= 40
  ) {
    return wanted & temporalFits(bytes, start, end);
  }
  if (wanted & (BOOLEAN | FLOAT) && whole === 0 && end - start <= 9) {
    const word = ascii(bytes, start, end).toLowerCase();
    if (word === "true" || word === "false") return wanted & BOOLEAN;
    if (FLOAT_WORDS.has(word)) return wanted & FLOAT;
  }
  return 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const FRACTION_SCALE = [100_000, 10_000, 1000, 100, 10, 1];
const SPACE = 0x20;
const UPPER_T = 0x54;
const UPPER_Z = 0x5a;

/** The days and the microseconds of the day of the text that `temporalFits` last read, and where its clock ended. */
let readDays = 0;
let readMicros = 0;
let clockEnd = 0;

/** The number of two digits at `at`, or −1. */
function twoDigits(bytes: Uint8Array, at: number): number {
  const tens = bytes[at] - ZERO;
  const ones = bytes[at + 1] - ZERO;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

/**
 * Microseconds since midnight of `HH:MM:SS` with up to 6 fraction digits at `at`, before `end`, or −1; sets
 * `clockEnd` to where it ends.
 */
function clockAt(bytes: Uint8Array, at: number, end: number): number {
  if (end - at < 8 || bytes[at + 2] !== COLON || bytes[at + 5] !== COLON) return -1;
  const hours = twoDigits(bytes, at);
  const minutes = twoDigits(bytes, at + 3);
  const seconds = twoDigits(bytes, at + 6);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return -1;
  let micros = (hours * 3600 + minutes * 60 + seconds) * 1_000_000;
  let index = at + 8;
  if (index < end && bytes[index] === DOT) {
    const from = ++index;
    while (index < end && isDigit(bytes[index])) {
      if (index - from === 6) return -1;
      micros += (bytes[index] - ZERO) * FRACTION_SCALE[index - from];
      index++;
    }
    if (index === from) return -1;
  }
  clockEnd = index;
  return micros;
}

/**
 * The type of the text of a time (`HH:MM:SS` with up to 6 fraction digits), a date (`YYYY-MM-DD`, or
 * `±YYYYYY-MM-DD` for other years than 0000 to 9999, which also fits timestamps), a timestamp (a date, a space or
 * `T`, and a time) or a timestamp with `Z` or an offset (`+HH`, `+HH:MM` or `+HHMM`), which is an instant; 0 for
 * other text. Keeps the value in `readDays` and `readMicros`, in UTC for an instant.
 */
function temporalFits(bytes: Uint8Array, start: number, end: number): number {
  if (bytes[start + 2] === COLON) {
    const micros = clockAt(bytes, start, end);
    if (micros < 0 || clockEnd !== end) return 0;
    readMicros = micros;
    return TIME;
  }
  // A signed year has six digits, which move the rest by three.
  const signed = bytes[start] === PLUS || bytes[start] === MINUS;
  const at = signed ? start + 3 : start;
  if (end - at < 10 || bytes[at + 4] !== MINUS || bytes[at + 7] !== MINUS) return 0;
  const century = twoDigits(bytes, at);
  const decade = twoDigits(bytes, at + 2);
  const month = twoDigits(bytes, at + 5);
  const day = twoDigits(bytes, at + 8);
  if (century < 0 || decade < 0 || month < 1 || month > 12 || day < 1) return 0;
  let year = century * 100 + decade;
  if (signed) {
    // The first two of six digits; `century` and `decade` are the other four.
    const high = twoDigits(bytes, start + 1);
    if (high < 0) return 0;
    year += high * 10_000;
    if (bytes[start] === MINUS) year = -year;
    // The years 0000 to 9999 have four digits only.
    if (year >= 0 && year <= 9999) return 0;
  }
  const leap = month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > MONTH_DAYS[month - 1] + (leap ? 1 : 0)) return 0;
  const days = daysFromCivil(year, month, day);
  if (days < FIRST_DAY || days > LAST_DAY) return 0;
  if (end - at === 10) {
    readDays = days;
    readMicros = 0;
    return DATE | TIMESTAMP;
  }
  const separator = bytes[at + 10];
  if (separator !== SPACE && separator !== UPPER_T) return 0;
  let micros = clockAt(bytes, at + 11, end);
  if (micros < 0) return 0;
  let index = clockEnd;
  if (index === end) {
    if (days === LAST_DAY && micros > LAST_DAY_MICROS) return 0;
    readDays = days;
    readMicros = micros;
    return TIMESTAMP;
  }
  const sign = bytes[index];
  if (sign === UPPER_Z) {
    if (index + 1 !== end) return 0;
  } else {
    if ((sign !== PLUS && sign !== MINUS) || end - index < 3) return 0;
    const hours = twoDigits(bytes, index + 1);
    let minutes = 0;
    index += 3;
    if (index < end) {
      if (bytes[index] === COLON) index++;
      minutes = end - index === 2 ? twoDigits(bytes, index) : -1;
    }
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return 0;
    micros -= (sign === MINUS ? -1 : 1) * (hours * 3600 + minutes * 60) * 1_000_000;
  }
  const shift = Math.floor(micros / DAY_MICROS);
  readDays = days + shift;
  readMicros = micros - shift * DAY_MICROS;
  if (readDays === LAST_DAY && readMicros > LAST_DAY_MICROS) return 0;
  return readDays >= FIRST_DAY && readDays <= LAST_DAY ? TIMESTAMPTZ : 0;
}

/** Where `temporalText` writes a string. */
const temporal = new Uint8Array(40);

/** `temporalFits` of a string of JSON. */
function temporalText(text: string): number {
  if (text.length > temporal.length) return 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x80) return 0;
    temporal[index] = code;
  }
  return temporalFits(temporal, 0, text.length);
}

/** Reads a CSV or TSV file the first time: its separator, its columns with what their values fit, and its rows. */
async function surveyCsv(
  file: TextFile,
  options: { separator: number | null; header: boolean },
  chunkBytes: number,
): Promise<Survey> {
  const fields = new Fields();
  const columns: Found[] = [];
  const starts: number[] = [];
  let header: string[] | null = options.header ? null : [];
  let separator = options.separator;
  let rows = 0;
  let bytes: Uint8Array = new Uint8Array(0);
  let base = 0;
  const row = () => {
    if (header === null) {
      header = [];
      for (let index = 0; index < fields.count; index++) {
        const start = fields.starts[index];
        const end = fields.ends[index];
        header.push(
          fields.quoted[index]
            ? decoder.decode(unquoted.subarray(0, unquote(bytes, start, end)))
            : decoder.decode(bytes.subarray(start, end)),
        );
      }
      return;
    }
    // A row's first field starts where the row does.
    if (rows % BLOCK_ROWS === 0) starts.push(base + fields.starts[0]);
    for (let index = 0; index < fields.count; index++) {
      columns[index] ??= found("");
      const column = columns[index];
      let source = bytes;
      let start = fields.starts[index];
      let end = fields.ends[index];
      if (fields.quoted[index]) {
        end = unquote(bytes, start, end);
        start = 0;
        source = unquoted;
        if (end === 0) {
          column.empty++;
          continue;
        }
      } else if (start === end) continue;
      column.values++;
      column.bytes += end - start;
      if (column.fits !== 0) column.fits &= textFits(source, start, end, column.fits);
    }
    rows++;
  };
  await eachSlice(file, chunkBytes, (slice, last, at) => {
    bytes = slice;
    base = at;
    separator ??= detectSeparator(slice);
    try {
      return scanCsv(slice, separator, last, fields, row);
    } catch (error) {
      if (!(error instanceof NotUtf8)) throw error;
      throw header === null
        ? new TableProblem("/file", "The first line, which names the columns, is not UTF-8 text.")
        : new TableProblem(`/rows/${rows}/${error.field}`, "The text is not UTF-8 (§2.2).");
    }
  });
  const names = (header ?? []) as string[];
  const width = Math.max(names.length, columns.length);
  const used = new Set<string>();
  for (let index = 0; index < width; index++) {
    const base = names[index] || `column${index}`;
    let name = base;
    for (let suffix = 1; used.has(name); suffix++) name = `${base}_${suffix}`;
    used.add(name);
    columns[index] = columns[index] ?? found("");
    columns[index].name = name;
  }
  return { separator: separator ?? 0x2c, found: columns, rows, starts };
}

/** Writes the text of a field into a column as its type, from the first reading's finding that it fits. */
function putText(built: Built, bytes: Uint8Array, start: number, end: number, row: number) {
  switch (built.column.type) {
    case "boolean":
      (built.flags as Uint8Array)[row] = (bytes[start] | 0x20) === 0x74 ? 1 : 0;
      break;
    case "integer":
      (built.numbers as Int32Array)[row] = integerValue(bytes, start, end);
      break;
    case "bigint":
      if (end - start <= 15) putInt64(built, row, integerValue(bytes, start, end));
      else (built.numbers as BigInt64Array)[row] = BigInt(ascii(bytes, start, end));
      break;
    case "float":
      (built.numbers as Float64Array)[row] = floatValue(bytes, start, end);
      break;
    case "string":
      (built.text as Uint8Array).set(bytes.subarray(start, end), built.cursor);
      built.cursor += end - start;
      break;
    default:
      if (!temporalFits(bytes, start, end)) throw changed();
      putTemporal(built, row);
  }
  mark(built, row);
}

/** Writes what `temporalFits` last read into a column of a time, a date or a timestamp. */
function putTemporal(built: Built, row: number) {
  if (built.column.type === "date") (built.numbers as Int32Array)[row] = readDays;
  else if (built.column.type === "time") putInt64(built, row, readMicros);
  else {
    // Microseconds since 1970-01-01 are safe integers for about 285 years either side of it.
    const micros = readDays * DAY_MICROS + readMicros;
    if (Number.isSafeInteger(micros)) putInt64(built, row, micros);
    else (built.numbers as BigInt64Array)[row] = BigInt(readDays) * BigInt(DAY_MICROS) + BigInt(readMicros);
  }
}

/** Writes a safe integer into a column of 64-bit integers, as its halves. */
function putInt64(built: Built, row: number, value: number) {
  const halves = built.halves as Uint32Array;
  const high = Math.floor(value / TWO_32);
  halves[row * 2 + HIGH] = high;
  halves[row * 2 + LOW] = value - high * TWO_32;
}

/**
 * Reads a CSV or TSV file the second time, or a span of it, keeping its values in the columns that are not null;
 * gives the rows read.
 */
async function keepCsv(
  file: TextFile,
  separator: number,
  header: boolean,
  built: (Built | null)[],
  rowCount: number,
  chunkBytes: number,
  span?: Span,
): Promise<number> {
  const fields = new Fields();
  const strings = built.filter((column) => column?.offsets) as Built[];
  let skip = header;
  let rows = 0;
  let bytes: Uint8Array = new Uint8Array(0);
  const row = () => {
    if (skip) {
      skip = false;
      return;
    }
    if (rows === rowCount) throw changed();
    const count = Math.min(fields.count, built.length);
    for (let index = 0; index < count; index++) {
      const column = built[index];
      if (!column) continue;
      let source = bytes;
      let start = fields.starts[index];
      let end = fields.ends[index];
      if (fields.quoted[index]) {
        end = unquote(bytes, start, end);
        start = 0;
        source = unquoted;
        // A quoted empty field is an empty string, and null in a column of another type.
        if (end === 0 && !column.offsets) continue;
      } else if (start === end) continue;
      putText(column, source, start, end, rows);
    }
    for (const column of strings) (column.offsets as Uint32Array)[rows + 1] = column.cursor;
    rows++;
  };
  await eachSlice(
    file,
    chunkBytes,
    (slice, last) => {
      bytes = slice;
      return scanCsv(slice, separator, last, fields, row);
    },
    span,
  );
  return rows;
}

/** The bytes of a string as UTF-8, or −1 when it holds a lone surrogate. */
function utf8Length(text: string): number {
  let length = text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) length += 1;
    else if (code < 0xd800 || code > 0xdfff) length += 2;
    else if (code < 0xdc00 && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      length += 2;
      index++;
    } else return -1;
  }
  return length;
}

/**
 * Calls `line` with each whole line of the bytes, without its line break, and gives where the first line that is
 * not whole starts (all of the bytes when they are the last).
 */
function eachLine(bytes: Uint8Array, last: boolean, line: (start: number, end: number) => void): number {
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(LF, start);
    const end = newline < 0 ? bytes.length : newline;
    if (newline < 0 && !last) return start;
    if (newline >= 0 || start < end) line(start, end > start && bytes[end - 1] === CR ? end - 1 : end);
    if (newline < 0) return bytes.length;
    start = newline + 1;
  }
}

/** The object of a line of JSON Lines, or null for a line of white space. */
function parseLine(bytes: Uint8Array, start: number, end: number, row: number): Record<string, unknown> | null {
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(start, end));
  } catch {
    throw new TableProblem(`/rows/${row}`, "The line is not UTF-8 text (§2.2).");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (text.trim() === "") return null;
    throw new TableProblem(`/rows/${row}`, `The line is not JSON: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TableProblem(`/rows/${row}`, "A line of JSON Lines is an object of the row's values by column name.");
  }
  return value as Record<string, unknown>;
}

/** The types that a number of JSON fits. */
function numberFits(value: number): number {
  if (!Number.isInteger(value)) return FLOAT;
  if (value >= -0x8000_0000 && value <= 0x7fff_ffff) return INTEGER | BIGINT | FLOAT;
  return Number.isSafeInteger(value) ? BIGINT | FLOAT : FLOAT;
}

/** The text of a value of JSON in a string column: strings as they are, other values as JSON. */
function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Reads a file of JSON Lines the first time: its columns by first appearance, with what their values fit, and its rows. */
async function surveyJson(file: TextFile, chunkBytes: number): Promise<Survey> {
  const columns: Found[] = [];
  const index = new Map<string, number>();
  const starts: number[] = [];
  let rows = 0;
  let bytes: Uint8Array = new Uint8Array(0);
  let base = 0;
  const line = (start: number, end: number) => {
    if (start === end) return;
    const object = parseLine(bytes, start, end, rows);
    if (!object) return;
    if (rows % BLOCK_ROWS === 0) starts.push(base + start);
    for (const key in object) {
      let at = index.get(key);
      if (at === undefined) {
        if (utf8Length(key) < 0) throw new TableProblem(`/rows/${rows}`, "A name holds a lone surrogate (§2.2).");
        at = columns.length;
        index.set(key, at);
        columns.push(found(key));
      }
      const value = object[key];
      if (value === null) continue;
      const column = columns[at];
      column.values++;
      if (typeof value === "object") {
        column.fits = 0;
        column.nested++;
        column.bytes += utf8Length(JSON.stringify(value));
        continue;
      }
      if (typeof value === "string") {
        const length = utf8Length(value);
        if (length < 0) {
          throw new TableProblem(
            `/rows/${rows}/${at}`,
            "The string holds a lone surrogate, which is not Unicode text (§2.2).",
          );
        }
        column.bytes += length;
        if (column.fits !== 0) column.fits &= temporalText(value);
      } else {
        column.bytes += jsonText(value).length;
        column.fits &= typeof value === "boolean" ? BOOLEAN : numberFits(value as number);
      }
    }
    rows++;
  };
  await eachSlice(file, chunkBytes, (slice, last, at) => {
    bytes = slice;
    base = at;
    return eachLine(slice, last, line);
  });
  return { separator: 0, found: columns, rows, starts };
}

/**
 * Reads a file of JSON Lines the second time, or a span of it, keeping its values in the columns that are not null;
 * gives the rows read.
 */
async function keepJson(
  file: TextFile,
  built: (Built | null)[],
  rowCount: number,
  chunkBytes: number,
  span?: Span,
): Promise<number> {
  const index = new Map(built.flatMap((column, at) => (column ? [[column.column.name, at] as const] : [])));
  const strings = built.filter((column) => column?.offsets) as Built[];
  let rows = 0;
  let bytes: Uint8Array = new Uint8Array(0);
  const line = (start: number, end: number) => {
    if (start === end) return;
    const object = parseLine(bytes, start, end, rows);
    if (!object) return;
    if (rows === rowCount) throw changed();
    for (const key in object) {
      const value = object[key];
      const at = index.get(key);
      if (value === null || at === undefined) continue;
      const column = built[at] as Built;
      switch (column.column.type) {
        case "boolean":
          (column.flags as Uint8Array)[rows] = value ? 1 : 0;
          break;
        case "integer":
        case "float":
          (column.numbers as Int32Array | Float64Array)[rows] = value as number;
          break;
        case "bigint":
          putInt64(column, rows, value as number);
          break;
        case "string": {
          const { written } = encoder.encodeInto(jsonText(value), (column.text as Uint8Array).subarray(column.cursor));
          column.cursor += written;
          break;
        }
        default:
          if (!temporalText(value as string)) throw changed();
          putTemporal(column, rows);
      }
      mark(column, rows);
    }
    for (const column of strings) (column.offsets as Uint32Array)[rows + 1] = column.cursor;
    rows++;
  };
  await eachSlice(
    file,
    chunkBytes,
    (slice, last) => {
      bytes = slice;
      return eachLine(slice, last, line);
    },
    span,
  );
  return rows;
}
