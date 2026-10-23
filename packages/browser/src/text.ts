import { abortError, type CellValue, type ColumnSchema, type ColumnType, isAbortError } from "vastgrid-core";
import type { ByteSource } from "./bytes.js";
import { errorMessage, loadFailed } from "./errors.js";
import type { ReaderState, TableReader } from "./reader.js";
import { nestedText, wireNumber } from "./values.js";

export type TextFormat = "csv" | "tsv" | "json";

export interface TextOptions {
  format: TextFormat;
  /** Field separator of CSV. Detected from the first line by default (`,`, `;`, `|` or a tab). */
  delimiter?: string;
  /** Whether the first line of a CSV or TSV holds the column names (default `true`). */
  header?: boolean;
  /** Bytes read at a time while indexing (default 4 MiB). */
  chunkBytes?: number;
}

/** Rows per block: the index keeps the byte offset of every block. */
const blockRows = 1024;
/** Blocks read together when scanning the whole table. */
const scanBlocks = 64;
/** Rows used to tell the column types. */
const sampleRows = 2048;
const defaultChunkBytes = 4 * 1024 * 1024;
const cachedBlocks = 64;

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;

const integerText = /^[+-]?\d+$/;
const floatText = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const dateText = /^\d{4}-\d{2}-\d{2}$/;
const timestampText = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;
const timeText = /^(\d{2}:\d{2}:\d{2})(\.\d+)?$/;
const booleanText = /^(true|false)$/i;

/** A fraction of seconds without trailing zeros, as DuckDB writes it. */
function fraction(text: string | undefined) {
  const trimmed = text?.replace(/0+$/, "") ?? "";
  return trimmed === "." ? "" : trimmed;
}

type Field = string | null;

/** The column type that fits all the text values (DuckDB's CSV sniffer tries them in this order). */
function textType(values: string[]): ColumnType {
  if (values.length === 0) return "string";
  const all = (pattern: RegExp) => values.every((value) => pattern.test(value));
  if (all(booleanText)) return "boolean";
  if (all(integerText)) return "bigint";
  if (all(floatText)) return "float";
  if (all(timeText)) return "time";
  if (all(dateText)) return "date";
  if (all(timestampText)) return "timestamp";
  return "string";
}

/** Converts the text of a field to a value of the column type; text that does not fit stays text. */
function textConverter(type: ColumnType): (text: Field) => CellValue {
  switch (type) {
    case "boolean":
      return (text) =>
        text === null || text === "" ? null : booleanText.test(text) ? text.toLowerCase() === "true" : text;
    case "bigint":
      return (text) => {
        if (text === null || text === "") return null;
        if (!integerText.test(text)) return text;
        return text.length < 16 ? Number(text) : wireNumber(BigInt(text));
      };
    case "float":
      return (text) => (text === null || text === "" ? null : floatText.test(text) ? Number(text) : text);
    case "timestamp":
      return (text) => {
        if (text === null || text === "") return null;
        const match = timestampText.exec(text);
        return match ? `${match[1]} ${match[2]}${fraction(match[3])}` : text;
      };
    case "time":
      return (text) => {
        if (text === null || text === "") return null;
        const match = timeText.exec(text);
        return match ? `${match[1]}${fraction(match[2])}` : text;
      };
    case "date":
      return (text) => (text === "" ? null : text);
    default:
      return (text) => text;
  }
}

/** The column type of JSON values: numbers, booleans, text (also dates and times in text), lists or objects. */
function jsonType(values: unknown[]): ColumnType {
  if (values.length === 0) return "string";
  const kinds = new Set(values.map((value) => (Array.isArray(value) ? "array" : typeof value)));
  if (kinds.size === 1) {
    const [kind] = kinds;
    if (kind === "boolean") return "boolean";
    if (kind === "number") return values.every((value) => Number.isInteger(value)) ? "bigint" : "float";
    if (kind === "string") {
      const type = textType(values as string[]);
      return type === "date" || type === "timestamp" || type === "time" ? type : "string";
    }
    if (kind === "array") return "list";
    if (kind === "object") return "struct";
  }
  if ([...kinds].every((kind) => kind === "number")) return "float";
  return "string";
}

function jsonConverter(type: ColumnType): (value: unknown) => CellValue {
  const text = textConverter(type);
  return (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return type === "string" ? JSON.stringify(value) : wireNumber(value);
    if (typeof value === "boolean") return type === "string" ? String(value) : value;
    if (typeof value === "string") return text(value);
    if (type === "string") return JSON.stringify(value);
    return nestedText(value);
  };
}

/**
 * Splits CSV text into rows of fields. Quotes switch quoting on and off wherever they are (a doubled quote
 * inside quotes is a quote), the same rule the line index follows, so both always agree on where rows end.
 * Empty lines are skipped. Unquoted empty fields are `null`.
 */
export function parseCsv(text: string, delimiter: string): Field[][] {
  const rows: Field[][] = [];
  let row: Field[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let start = 0;
  const separator = delimiter.charCodeAt(0);
  const endField = () => {
    row.push(field === "" && !quoted ? null : field);
    field = "";
    quoted = false;
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      field += text.slice(start, index);
      if (inQuotes && text.charCodeAt(index + 1) === QUOTE) {
        field += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
        quoted = true;
      }
      start = index + 1;
    } else if (!inQuotes && code === separator) {
      field += text.slice(start, index);
      endField();
      start = index + 1;
    } else if (!inQuotes && code === LF) {
      let end = index;
      if (end > start && text.charCodeAt(end - 1) === CR) end--;
      field += text.slice(start, end);
      if (row.length > 0 || field !== "" || quoted) {
        endField();
        rows.push(row);
      }
      row = [];
      field = "";
      quoted = false;
      start = index + 1;
    }
  }
  let end = text.length;
  if (end > start && text.charCodeAt(end - 1) === CR) end--;
  field += text.slice(start, end);
  if (row.length > 0 || field !== "" || quoted) {
    endField();
    rows.push(row);
  }
  return rows;
}

function parseJsonLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      rows.push(null);
    }
  }
  return rows;
}

/** The separator that splits the first line into the most fields. */
function detectDelimiter(line: string) {
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", "\t", ";", "|"]) {
    const count = parseCsv(line, candidate)[0]?.length ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A CSV, TSV or JSON Lines file. Opening reads the file once in chunks to index where every 1024th row
 * starts (8 bytes per 1024 rows), without keeping the rows; rows are then parsed from the blocks a request
 * needs. While the index grows, the rows found so far can be read.
 */
export class TextReader implements TableReader {
  readonly format: string;
  readonly loaded: Promise<void>;
  private offsets = new Float64Array(1024);
  private blocks = 0;
  private rows = 0;
  /** Where the first row not yet counted starts. */
  private scanned = 0;
  private finished = false;
  private error: string | null = null;
  private columns: ColumnSchema[] = [];
  private convert: ((value: unknown) => CellValue)[] = [];
  private delimiter: string;
  private readonly cache = new Map<number, unknown[]>();
  private readonly controller = new AbortController();
  private readonly decoder = new TextDecoder();
  private readonly notes: string[] = [];

  constructor(
    readonly bytes: ByteSource,
    private readonly options: TextOptions,
  ) {
    this.format = options.format;
    this.delimiter = options.delimiter ?? (options.format === "tsv" ? "\t" : "");
    this.loaded = this.index();
    // Failures are reported through `state()`.
    this.loaded.catch(() => {});
  }

  state(): ReaderState {
    const ready = this.columns.length > 0 || this.finished;
    return {
      columns: this.columns,
      rowCount: this.finished && !this.error ? this.rows : null,
      readableRows: ready ? this.rows : 0,
      status: this.error ? "error" : this.finished ? "ready" : "loading",
      progress: this.bytes.size > 0 ? Math.min(1, this.scanned / this.bytes.size) : 1,
      error: this.error ?? undefined,
      notes: this.notes.length > 0 ? this.notes : undefined,
    };
  }

  private addBlock(offset: number) {
    if (this.blocks === this.offsets.length) {
      const grown = new Float64Array(this.offsets.length * 2);
      grown.set(this.offsets);
      this.offsets = grown;
    }
    this.offsets[this.blocks++] = offset;
  }

  private async index() {
    const { signal } = this.controller;
    const size = this.bytes.size;
    const quoted = this.options.format !== "json";
    let header: [number, number] | null = null;
    let wantHeader = this.options.format !== "json" && this.options.header !== false;
    let lineStart = 0;
    let inQuotes = false;
    let previous = 0;
    const chunkBytes = this.options.chunkBytes ?? defaultChunkBytes;
    try {
      const head = await this.bytes.read(0, Math.min(size, 4), signal);
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) lineStart = 3;
      else if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
        throw loadFailed("UTF-16 text is not supported in the browser; save the file as UTF-8.");
      const endLine = (end: number, before: number) => {
        const length = end - lineStart;
        if (length > 1 || (length === 1 && before !== CR)) {
          if (wantHeader) {
            header = [lineStart, end];
            wantHeader = false;
          } else {
            if (this.rows % blockRows === 0) this.addBlock(lineStart);
            this.rows++;
          }
        }
        lineStart = end + 1;
      };
      for (let offset = lineStart; offset < size; offset += chunkBytes) {
        const chunk = await this.bytes.read(offset, Math.min(size, offset + chunkBytes), signal);
        let index = 0;
        let nextQuote = quoted ? chunk.indexOf(QUOTE) : -1;
        while (index < chunk.length) {
          const newline = chunk.indexOf(LF, index);
          const lineEnd = newline < 0 ? chunk.length : newline;
          // Quotes before the line break switch quoting.
          while (nextQuote >= 0 && nextQuote < lineEnd) {
            inQuotes = !inQuotes;
            nextQuote = chunk.indexOf(QUOTE, nextQuote + 1);
          }
          if (newline < 0) break;
          if (!inQuotes) endLine(offset + newline, newline > 0 ? chunk[newline - 1] : previous);
          index = newline + 1;
        }
        previous = chunk[chunk.length - 1] ?? previous;
        const last = offset + chunkBytes >= size;
        if (last && size > lineStart) endLine(size, previous);
        this.scanned = Math.min(size, lineStart);
        if (this.columns.length === 0 && (this.rows >= sampleRows || last)) await this.setUp(header, signal);
      }
      this.scanned = size;
      if (this.columns.length === 0) await this.setUp(header, signal);
      this.finished = true;
    } catch (error) {
      if (isAbortError(error)) return;
      this.error = errorMessage(error);
      this.finished = true;
      throw error;
    }
  }

  /** Reads the header and a sample of the rows, and settles the columns and their types. */
  private async setUp(header: [number, number] | null, signal: AbortSignal) {
    const sampleEnd = this.blocks > sampleRows / blockRows ? this.offsets[sampleRows / blockRows] : this.scanned;
    if (this.options.format === "json") {
      const start = this.blocks > 0 ? this.offsets[0] : sampleEnd;
      const rows = parseJsonLines(this.decoder.decode(await this.bytes.read(start, sampleEnd, signal)));
      const names: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
        for (const key of Object.keys(row)) {
          if (!seen.has(key)) {
            seen.add(key);
            names.push(key);
          }
        }
      }
      const types = names.map((name) =>
        jsonType(
          rows
            .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>)[name] : null))
            .filter((value) => value !== null && value !== undefined),
        ),
      );
      this.convert = types.map(jsonConverter);
      this.columns = names.map((name, index) => ({ name, type: types[index], sourceType: types[index].toUpperCase() }));
      return;
    }
    const headerText = header ? this.decoder.decode(await this.bytes.read(header[0], header[1], signal)) : null;
    const start = this.blocks > 0 ? this.offsets[0] : sampleEnd;
    const sampleText = this.decoder.decode(await this.bytes.read(start, sampleEnd, signal));
    if (!this.delimiter) {
      const firstLine = headerText ?? sampleText.slice(0, sampleText.indexOf("\n") >>> 0);
      this.delimiter = detectDelimiter(firstLine);
    }
    const names = headerText ? (parseCsv(headerText, this.delimiter)[0] ?? []) : [];
    const rows = parseCsv(sampleText, this.delimiter);
    const width = Math.max(names.length, headerText ? 0 : (rows[0]?.length ?? 0));
    const types: ColumnType[] = [];
    for (let column = 0; column < width; column++) {
      const values: string[] = [];
      for (const row of rows) {
        const value = row[column];
        if (value !== null && value !== undefined && value !== "") values.push(value);
      }
      types.push(textType(values));
    }
    const used = new Set<string>();
    this.columns = types.map((type, column) => {
      let name = names[column] || `column${column}`;
      while (used.has(name)) name = `${name}_${column}`;
      used.add(name);
      return { name, type, sourceType: type === "string" ? "VARCHAR" : type.toUpperCase() };
    });
    this.convert = types.map((type) => textConverter(type) as (value: unknown) => CellValue);
  }

  private blockEnd(block: number) {
    return block + 1 < this.blocks ? this.offsets[block + 1] : this.finished ? this.bytes.size : this.scanned;
  }

  private parse(text: string): unknown[] {
    return this.options.format === "json" ? parseJsonLines(text) : parseCsv(text, this.delimiter);
  }

  /** The rows of blocks `first` to `last` (inclusive). */
  private async readBlocks(first: number, last: number, signal?: AbortSignal): Promise<unknown[]> {
    if (last - first >= 4) {
      const bytes = await this.bytes.read(this.offsets[first], this.blockEnd(last), signal);
      return this.parse(this.decoder.decode(bytes));
    }
    const rows: unknown[] = [];
    for (let block = first; block <= last; block++) {
      let parsed = this.cache.get(block);
      if (parsed) {
        this.cache.delete(block);
      } else {
        const bytes = await this.bytes.read(this.offsets[block], this.blockEnd(block), signal);
        parsed = this.parse(this.decoder.decode(bytes));
      }
      // Blocks are complete once the next one starts or the file is read through.
      if (block + 1 < this.blocks || this.finished) {
        this.cache.set(block, parsed);
        for (const key of this.cache.keys()) {
          if (this.cache.size <= cachedBlocks) break;
          this.cache.delete(key);
        }
      }
      for (const row of parsed) rows.push(row);
    }
    return rows;
  }

  async read(start: number, end: number, columns: number[], signal?: AbortSignal): Promise<CellValue[][]> {
    end = Math.min(end, this.state().readableRows);
    if (end <= start || columns.length === 0) return columns.map(() => []);
    const first = Math.floor(start / blockRows);
    const last = Math.floor((end - 1) / blockRows);
    const rows = await this.readBlocks(first, last, signal);
    if (signal?.aborted) throw abortError();
    const offset = start - first * blockRows;
    const json = this.options.format === "json";
    return columns.map((column) => {
      const convert = this.convert[column];
      const name = this.columns[column]?.name;
      const values: CellValue[] = new Array(end - start);
      for (let index = 0; index < values.length; index++) {
        const row = rows[offset + index];
        const raw = json
          ? row && typeof row === "object" && name !== undefined
            ? (row as Record<string, unknown>)[name]
            : null
          : (row as Field[] | undefined)?.[column];
        values[index] = convert ? convert(raw ?? null) : null;
      }
      return values;
    });
  }

  granule(row: number): [number, number] {
    const start = Math.floor(row / blockRows) * blockRows;
    return [start, Math.min(start + blockRows, this.rows)];
  }

  scanRanges() {
    const ranges: [number, number][] = [];
    const size = blockRows * scanBlocks;
    const rows = this.state().readableRows;
    for (let start = 0; start < rows; start += size) ranges.push([start, Math.min(rows, start + size)]);
    return ranges;
  }

  close() {
    this.controller.abort();
    this.cache.clear();
  }
}
