import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { TextEncoding } from "./encoding.js";

/**
 * Writes edited cells back into a delimited file (docs/spec.md §7.5), keeping every byte of the file that holds no edited
 * cell: the bytes before the first record (a byte order mark), the header, every record without an edited
 * cell, and in an edited record the fields that were not edited, the delimiters and the line break. Only
 * the edited fields are written anew, quoted when they need it, in the file's encoding.
 *
 * Records are found as DuckDB reads them: fields are separated by `delimiter`; a field that starts with
 * `quote` ends at a quote that is not escaped (by `escape`, or by doubling it when `escape` is the quote),
 * and may hold delimiters and line breaks; records end with `\n`, `\r\n` or `\r` outside quotes. Empty lines
 * are not records unless the table has one column (DuckDB reads them as blanks then). The records found
 * must be as many as the table's rows, so that the n-th record is the row at position n; otherwise
 * nothing is written.
 */

export interface CsvDialect {
  delimiter: string;
  quote: string;
  /** The escape character inside quoted fields; the quote itself when quotes are doubled. */
  escape: string;
  header: boolean;
  /** Lines before the header, as DuckDB skips them. */
  skipRows: number;
  /** The `strptime` formats DuckDB read dates and timestamps with, or "" for ISO text. */
  dateFormat?: string;
  timestampFormat?: string;
}

/** Why a file cannot be saved, as a stable code with a message. */
export class CsvSaveError extends Error {
  constructor(
    readonly code: "unsupported" | "layout" | "encoding",
    message: string,
  ) {
    super(message);
  }
}

/** New field text by row position, then by field (column) index. `null` writes an empty field (a blank). */
export type CsvEdits = Map<number, Map<number, string | null>>;

export interface CsvRewrite {
  /** The original file. */
  source: string;
  /** A new file to write (it must not exist). */
  target: string;
  encoding: TextEncoding;
  dialect: CsvDialect;
  /** The table's columns and rows, which the file's records must match. */
  columns: number;
  rows: number;
  edits: CsvEdits;
  signal?: AbortSignal;
}

/** Bytes of one edited record: where it starts, where its fields are, and where its content ends. */
interface RecordLayout {
  start: number;
  /** Start and end of each field, as byte offsets in the file. */
  fields: [number, number][];
  end: number;
}

const CHUNK = 4 * 1024 * 1024;

function unitWidth(encoding: TextEncoding) {
  return encoding.startsWith("utf-16") ? 2 : 1;
}

function littleEndian(encoding: TextEncoding) {
  return encoding !== "utf-16be";
}

/** Characters whose bytes may also be the second byte of a double-byte character in Shift_JIS. */
function unsafeInShiftJis(char: string) {
  return char !== "" && char.charCodeAt(0) >= 0x40;
}

/**
 * Finds the records of the file and the layout of the edited ones. Throws `CsvSaveError` when the
 * records do not match the table's rows.
 */
async function scan(handle: FileHandle, job: CsvRewrite): Promise<Map<number, RecordLayout>> {
  const { dialect, encoding } = job;
  const width = unitWidth(encoding);
  const little = littleEndian(encoding);
  const delimiter = dialect.delimiter.charCodeAt(0);
  const quote = dialect.quote ? dialect.quote.charCodeAt(0) : -1;
  const escapeChar = dialect.escape ? dialect.escape.charCodeAt(0) : quote;
  const layouts = new Map<number, RecordLayout>();
  const size = (await handle.stat()).size;
  const buffer = Buffer.alloc(CHUNK);
  // A byte order mark is not part of the first record.
  let offset = 0;
  const head = Buffer.alloc(3);
  await handle.read(head, 0, 3, 0);
  if (encoding === "utf-8" && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offset = 3;
  if (width === 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) offset = 2;

  let state = 0; // 0 field start, 1 unquoted, 2 quoted, 3 quote in quoted, 4 escaped, 5 after \r
  let line = 0; // records (lines) seen, including skipped lines and the header
  let row = 0; // data records
  let recordStart = offset;
  let fieldStart = offset;
  let fieldCount = 0;
  const firstData = dialect.skipRows + (dialect.header ? 1 : 0);
  /** The fields of the current record, kept only when it is an edited row. */
  let fields: [number, number][] | null = firstData === 0 && job.edits.has(0) ? [] : null;

  const endField = (end: number) => {
    fields?.push([fieldStart, end]);
    fieldCount++;
  };
  const endRecord = (end: number) => {
    const empty = fieldCount === 0 && end === recordStart;
    endField(end);
    if (line >= firstData && !(empty && job.columns > 1)) {
      if (fields) layouts.set(row, { start: recordStart, fields, end });
      row++;
    }
    line++;
    fieldCount = 0;
    fields = line >= firstData && job.edits.has(row) ? [] : null;
  };

  let position = offset;
  while (position < size) {
    job.signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - position), position);
    if (bytesRead === 0) break;
    // Whole units only; a unit split by the chunk is read with the next one.
    const usable = bytesRead - (bytesRead % width);
    for (let index = 0; index < usable; index += width) {
      const unit =
        width === 1
          ? buffer[index]
          : little
            ? buffer[index] | (buffer[index + 1] << 8)
            : (buffer[index] << 8) | buffer[index + 1];
      const at = position + index;
      if (state === 5) {
        // After a \r: a \n belongs to the same line break.
        state = 0;
        recordStart = fieldStart = unit === 10 ? at + width : at;
        if (unit === 10) continue;
      }
      switch (state) {
        case 2:
          if (unit === escapeChar && escapeChar !== quote) state = 4;
          else if (unit === quote) state = 3;
          continue;
        case 4:
          state = 2;
          continue;
        case 3:
          if (unit === quote && escapeChar === quote) {
            state = 2;
            continue;
          }
          break;
        case 0:
          if (unit === quote) {
            state = 2;
            continue;
          }
          break;
      }
      // Outside quotes: a field start, an unquoted field, or after a closing quote.
      if (unit === delimiter) {
        endField(at);
        fieldStart = at + width;
        state = 0;
      } else if (unit === 10 || unit === 13) {
        endRecord(at);
        if (unit === 13) state = 5;
        else {
          state = 0;
          recordStart = fieldStart = at + width;
        }
      } else if (state === 0 || state === 3) {
        state = 1;
      }
    }
    position += usable;
    if (usable === 0) break;
  }
  if (state === 2 || state === 4) throw new CsvSaveError("layout", "The file ends inside a quoted field.");
  // The last record, when the file does not end with a line break.
  if (state !== 5 && (fieldCount > 0 || position > recordStart)) endRecord(position);
  if (row !== job.rows) {
    throw new CsvSaveError(
      "layout",
      `The file has ${row} records where the table has ${job.rows} rows; it may have changed, or be read differently.`,
    );
  }
  return layouts;
}

/** Encodes text in the file's encoding, or throws `CsvSaveError` for characters it cannot hold. */
function encoder(encoding: TextEncoding): (text: string) => Buffer {
  if (encoding === "utf-8") return (text) => Buffer.from(text, "utf8");
  if (encoding === "utf-16le" || encoding === "utf-16" || encoding === "utf-16be") {
    const little = littleEndian(encoding);
    return (text) => {
      const bytes = Buffer.from(text, "utf16le");
      if (!little) bytes.swap16();
      return bytes;
    };
  }
  const table = reverseTable(encoding);
  return (text) => {
    const parts: number[] = [];
    for (const char of text) {
      const bytes = table.get(char);
      if (!bytes) {
        throw new CsvSaveError("encoding", `"${char}" cannot be written in the file's encoding (${encoding}).`);
      }
      parts.push(...bytes);
    }
    return Buffer.from(parts);
  };
}

const reverseTables = new Map<string, Map<string, number[]>>();

/** Characters and their bytes in a single- or double-byte encoding, from the decoder itself. */
function reverseTable(encoding: TextEncoding) {
  let table = reverseTables.get(encoding);
  if (table) return table;
  table = new Map<string, number[]>();
  const label = encoding === "latin-1" ? "windows-1252" : encoding;
  const decoder = new TextDecoder(label, { fatal: true });
  const add = (bytes: number[]) => {
    let text: string;
    try {
      text = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    // One character per sequence; the first sequence of a character is the one it is written with.
    if ([...text].length === 1 && !table?.has(text)) table?.set(text, bytes);
  };
  for (let byte = 0; byte < 0x80; byte++) add([byte]);
  if (encoding === "latin-1") {
    for (let byte = 0x80; byte < 0x100; byte++) add([byte]);
  } else if (encoding === "shift_jis") {
    for (let byte = 0xa1; byte <= 0xdf; byte++) add([byte]);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) if (trail !== 0x7f) add([lead, trail]);
    }
  } else if (encoding === "euc-jp") {
    for (let byte = 0xa1; byte <= 0xdf; byte++) add([0x8e, byte]);
    for (let lead = 0xa1; lead <= 0xfe; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) add([lead, trail]);
  }
  reverseTables.set(encoding, table);
  return table;
}

/** A field's text as the dialect writes it: quoted when it holds a delimiter, a quote, an escape or a line break. */
function fieldText(value: string | null, dialect: CsvDialect) {
  if (value === null) return "";
  // read_csv uses allow_quoted_nulls=true: even a quoted empty string reads back as null. Refuse it rather
  // than saving a different value and clearing the edit (§7.5).
  if (value === "") {
    throw new CsvSaveError("unsupported", "An empty string cannot be saved without being read back as null.");
  }
  const quote = dialect.quote || '"';
  const escapeChar = dialect.escape || quote;
  const special = [dialect.delimiter, quote, escapeChar, "\n", "\r"];
  if (!special.some((char) => value.includes(char))) return value;
  if (!dialect.quote) {
    throw new CsvSaveError("unsupported", "The file does not quote fields, and a value needs quotes.");
  }
  let escaped = value;
  if (escapeChar !== quote) escaped = escaped.replaceAll(escapeChar, escapeChar + escapeChar);
  escaped = escaped.replaceAll(quote, escapeChar + quote);
  return `${quote}${escaped}${quote}`;
}

/** Checks that the dialect can be scanned byte by byte in the file's encoding. */
function checkDialect(dialect: CsvDialect, encoding: TextEncoding) {
  for (const [name, char] of [
    ["delimiter", dialect.delimiter],
    ["quote", dialect.quote],
    ["escape", dialect.escape],
  ] as const) {
    if (char.length > 1 || (name === "delimiter" && char.length === 0)) {
      throw new CsvSaveError("unsupported", `Files with a ${name} of more than one character cannot be saved.`);
    }
    if (char && char.charCodeAt(0) >= 0x80) {
      throw new CsvSaveError("unsupported", `Files with a ${name} beyond ASCII cannot be saved.`);
    }
    if (encoding === "shift_jis" && unsafeInShiftJis(char)) {
      throw new CsvSaveError("unsupported", `Shift_JIS files with "${char}" as the ${name} cannot be saved.`);
    }
  }
}

/**
 * Writes `target` from `source` with the edits (see the module's description). Returns the records
 * written anew. `target` is left for the caller to rename or delete.
 */
export async function rewriteCsv(job: CsvRewrite): Promise<{ records: number }> {
  checkDialect(job.dialect, job.encoding);
  const encode = encoder(job.encoding);
  const handle = await open(job.source, "r");
  const output = await open(job.target, "wx");
  try {
    const layouts = await scan(handle, job);
    const ordered = [...layouts.entries()].sort((a, b) => a[1].start - b[1].start);
    const width = unitWidth(job.encoding);
    const delimiter = encode(job.dialect.delimiter);
    let cursor = 0;
    const copy = async (end: number) => {
      // Unchanged bytes are copied as they are.
      if (end <= cursor) return;
      const stream = createReadStream("", {
        fd: handle.fd,
        start: cursor,
        end: end - 1,
        autoClose: false,
        highWaterMark: CHUNK,
      });
      for await (const chunk of stream) {
        job.signal?.throwIfAborted();
        await output.write(chunk as Buffer);
      }
      cursor = end;
    };
    for (const [row, layout] of ordered) {
      const edits = job.edits.get(row);
      if (!edits) continue;
      await copy(layout.start);
      const parts: Buffer[] = [];
      const count = Math.max(layout.fields.length, ...[...edits.keys()].map((field) => field + 1));
      for (let field = 0; field < count; field++) {
        if (field > 0) parts.push(delimiter);
        if (edits.has(field)) {
          parts.push(encode(fieldText(edits.get(field) ?? null, job.dialect)));
        } else if (field < layout.fields.length) {
          const [start, end] = layout.fields[field];
          const raw = Buffer.alloc(end - start);
          if (raw.length > 0) await handle.read(raw, 0, raw.length, start);
          parts.push(raw);
        }
        // Fields missing from a short record (read as blanks) are written empty.
      }
      await output.write(Buffer.concat(parts));
      cursor = layout.end;
      if (width === 2 && cursor % 2 !== 0) throw new CsvSaveError("layout", "The file's records are not aligned.");
    }
    await copy((await handle.stat()).size);
    await output.sync();
    return { records: ordered.length };
  } finally {
    await output.close();
    await handle.close();
  }
}
