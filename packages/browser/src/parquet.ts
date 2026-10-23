import {
  type AsyncBuffer,
  type FileMetaData,
  type ParquetParsers,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type SchemaElement,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { type CellValue, type ColumnSchema, type ColumnType, ErrorCodes, SourceError } from "vastgrid-core";
import type { ByteSource } from "./bytes.js";
import { errorMessage, isKnownError } from "./errors.js";
import type { ReaderState, TableReader } from "./reader.js";
import { binaryText, dateText, nestedText, timestampText, timeText, wireNumber, zonedText } from "./values.js";

const decoder = new TextDecoder();

/** Dates and times become the text DuckDB gives them (`hyparquet` would make `Date`s, which lose microseconds). */
const parsers: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (millis) => timestampText(BigInt(millis) * 1_000_000n),
  timestampFromMicroseconds: (micros) => timestampText(BigInt(micros) * 1000n),
  timestampFromNanoseconds: (nanos) => timestampText(BigInt(nanos)),
  dateFromDays: (days) => dateText(days),
  jsonFromBytes: (bytes) => bytes && decoder.decode(bytes),
  geometryFromBytes: (bytes) => bytes && binaryText(bytes),
  geographyFromBytes: (bytes) => bytes && binaryText(bytes),
};

/** The bytes as an `ArrayBuffer`, without copying when they fill one. */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const { buffer } = bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) return buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

/** The magic bytes at both ends of a Parquet file. */
export function isParquet(head: Uint8Array) {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31;
}

/** Signed big-endian two's complement bytes as an integer. */
function bigIntOf(bytes: Uint8Array) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (bytes.length > 0 && bytes[0] & 0x80) value -= 1n << BigInt(bytes.length * 8);
  return value;
}

/** `1.50` from the unscaled integer 150 and scale 2. */
export function decimalText(unscaled: bigint, scale: number) {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString();
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/** Parquet `INTERVAL` (months, days and milliseconds, little-endian) as DuckDB writes intervals. */
function intervalText(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const months = view.getUint32(0, true);
  const days = view.getUint32(4, true);
  const millis = view.getUint32(8, true);
  const parts: string[] = [];
  const unit = (count: number, name: string) => {
    if (count !== 0) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
  };
  unit(Math.floor(months / 12), "year");
  unit(months % 12, "month");
  unit(days, "day");
  if (millis !== 0 || parts.length === 0) parts.push(timeText(BigInt(millis) * 1_000_000n));
  return parts.join(" ");
}

/** Cells of decoded row groups kept for reading again (each row group column counts its rows). */
const cachedCells = 4_000_000;

interface Column {
  schema: ColumnSchema;
  convert: (value: unknown) => CellValue;
}

function textOf(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return binaryText(value);
  return nestedText(value);
}

function numberOf(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return wireNumber(value);
  return textOf(value);
}

function mapText(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return textOf(value);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);
  return `{${entries.map(([key, item]) => `${nestedText(key)}=${nestedText(item)}`).join(", ")}}`;
}

/**
 * The logical type of a top-level column and how to convert its values. Decimals and intervals lose their
 * annotations here, so that `hyparquet` hands over the exact stored values (it turns decimals into
 * floating-point numbers and refuses intervals).
 */
function columnOf(element: SchemaElement, children: number): Column {
  const name = element.name;
  const logical = element.logical_type;
  const converted = element.converted_type;
  const column = (type: ColumnType, sourceType: string, convert: Column["convert"]): Column => ({
    schema: { name, type, sourceType },
    convert,
  });
  if (children > 0 || element.type === undefined) {
    if (converted === "LIST" || logical?.type === "LIST") return column("list", "LIST", textOf);
    if (converted === "MAP" || converted === "MAP_KEY_VALUE" || logical?.type === "MAP")
      return column("map", "MAP", mapText);
    return column("struct", "STRUCT", textOf);
  }
  if (converted === "DECIMAL" || logical?.type === "DECIMAL") {
    const scale = element.scale ?? (logical?.type === "DECIMAL" ? logical.scale : 0) ?? 0;
    const precision = element.precision ?? (logical?.type === "DECIMAL" ? logical.precision : 0);
    element.converted_type = undefined;
    element.logical_type = undefined;
    return column("decimal", `DECIMAL(${precision},${scale})`, (value) => {
      if (value === null || value === undefined) return null;
      if (value instanceof Uint8Array) return decimalText(bigIntOf(value), scale);
      return decimalText(BigInt(value as number | bigint), scale);
    });
  }
  if (converted === "INTERVAL") {
    element.converted_type = undefined;
    return column("interval", "INTERVAL", (value) => (value instanceof Uint8Array ? intervalText(value) : null));
  }
  if (converted === "DATE" || logical?.type === "DATE") return column("date", "DATE", textOf);
  if (logical?.type === "TIME" || converted === "TIME_MILLIS" || converted === "TIME_MICROS") {
    const unit = logical?.type === "TIME" ? logical.unit : converted === "TIME_MILLIS" ? "MILLIS" : "MICROS";
    const factor = unit === "MILLIS" ? 1_000_000n : unit === "MICROS" ? 1000n : 1n;
    return column("time", "TIME", (value) =>
      value === null || value === undefined ? null : timeText(BigInt(value as number | bigint) * factor),
    );
  }
  if (logical?.type === "TIMESTAMP" || converted === "TIMESTAMP_MILLIS" || converted === "TIMESTAMP_MICROS") {
    if (logical?.type === "TIMESTAMP" && logical.isAdjustedToUTC) {
      return column("timestamptz", "TIMESTAMP WITH TIME ZONE", (value) =>
        typeof value === "string" ? zonedText(value) : textOf(value),
      );
    }
    return column("timestamp", "TIMESTAMP", textOf);
  }
  if (element.type === "INT96") return column("timestamp", "TIMESTAMP", textOf);
  if (converted === "JSON" || logical?.type === "JSON") return column("json", "JSON", textOf);
  if (logical?.type === "UUID") return column("uuid", "UUID", textOf);
  if (logical?.type === "FLOAT16") return column("float", "FLOAT", numberOf);
  if (converted === "UTF8" || converted === "ENUM" || logical?.type === "STRING" || logical?.type === "ENUM")
    return column("string", "VARCHAR", textOf);
  switch (element.type) {
    case "BOOLEAN":
      return column("boolean", "BOOLEAN", (value) => (value === undefined ? null : (value as boolean | null)));
    case "INT32":
      return column("integer", converted === "UINT_32" ? "UINTEGER" : "INTEGER", numberOf);
    case "INT64":
      return column("bigint", converted === "UINT_64" ? "UBIGINT" : "BIGINT", numberOf);
    case "FLOAT":
      return column("float", "FLOAT", numberOf);
    case "DOUBLE":
      return column("float", "DOUBLE", numberOf);
    default:
      return column("binary", "BLOB", textOf);
  }
}

/** A Parquet file read with `hyparquet`: the footer first, then only the row groups and columns asked for. */
export class ParquetReader implements TableReader {
  readonly format = "parquet";
  readonly loaded = Promise.resolve();
  private readonly groups: [number, number][] = [];
  private readonly rows: number;
  /** Decoded columns of row groups, by `group:column`. */
  private readonly cache = new Map<string, Promise<CellValue[]>>();
  private cached = 0;

  private constructor(
    readonly bytes: ByteSource,
    private readonly metadata: FileMetaData,
    private readonly columns: Column[],
  ) {
    let start = 0;
    for (const group of metadata.row_groups) {
      const end = start + Number(group.num_rows);
      this.groups.push([start, end]);
      start = end;
    }
    this.rows = Number(metadata.num_rows);
  }

  static async open(bytes: ByteSource, signal?: AbortSignal) {
    try {
      const metadata = await parquetMetadataAsync(ParquetReader.buffer(bytes, signal), {
        parsers,
        geoparquet: false,
        initialFetchSize: Math.min(bytes.size, 64 * 1024),
      });
      const tree = parquetSchema(metadata);
      const columns = tree.children.map((child) => columnOf(child.element, child.children.length));
      return new ParquetReader(bytes, metadata, columns);
    } catch (error) {
      if (isKnownError(error)) throw error;
      throw new SourceError(ErrorCodes.loadFailed, `Not a readable Parquet file: ${errorMessage(error)}`, 422);
    }
  }

  private static buffer(bytes: ByteSource, signal?: AbortSignal): AsyncBuffer {
    return {
      byteLength: bytes.size,
      slice: async (start, end) => arrayBufferOf(await bytes.read(start, end ?? bytes.size, signal)),
    };
  }

  state(): ReaderState {
    return {
      columns: this.columns.map((column) => column.schema),
      rowCount: this.rows,
      readableRows: this.rows,
      status: "ready",
    };
  }

  /** Decodes `columns` of rows `start` to `end`, which lie in one row group. */
  private async decode(start: number, end: number, columns: number[], signal?: AbortSignal) {
    const values = columns.map(() => new Array<CellValue>(end - start).fill(null));
    const index = new Map(columns.map((column, position) => [this.columns[column].schema.name, position]));
    try {
      await parquetRead({
        file: ParquetReader.buffer(this.bytes, signal),
        metadata: this.metadata,
        columns: [...index.keys()],
        rowStart: start,
        rowEnd: end,
        utf8: false,
        parsers,
        compressors,
        geoparquet: false,
        useOffsetIndex: true,
        // Column by column: no rows are assembled.
        onChunk: (chunk) => {
          const position = index.get(chunk.columnName);
          if (position === undefined) return;
          const { convert } = this.columns[columns[position]];
          const target = values[position];
          const from = Math.max(start, chunk.rowStart);
          const to = Math.min(end, chunk.rowEnd);
          for (let row = from; row < to; row++) target[row - start] = convert(chunk.columnData[row - chunk.rowStart]);
        },
      });
    } catch (error) {
      if (isKnownError(error)) throw error;
      throw new SourceError(ErrorCodes.loadFailed, `Could not read the Parquet file: ${errorMessage(error)}`, 422);
    }
    return values;
  }

  /** Whole columns of a row group, decoded once and kept while they fit in the cache. */
  private groupColumns(group: number, columns: number[], signal?: AbortSignal): Promise<CellValue[]>[] {
    const [start, end] = this.groups[group];
    const missing = columns.filter((column) => !this.cache.has(`${group}:${column}`));
    if (missing.length > 0) {
      const decoded = this.decode(start, end, missing, signal);
      missing.forEach((column, position) => {
        const key = `${group}:${column}`;
        const entry = decoded.then((values) => values[position]);
        this.cache.set(key, entry);
        this.cached += end - start;
        // A failed or cancelled read is not kept.
        entry.catch(() => {
          if (this.cache.get(key) === entry) {
            this.cache.delete(key);
            this.cached -= end - start;
          }
        });
      });
    }
    const result = columns.map((column) => {
      const key = `${group}:${column}`;
      const entry = this.cache.get(key) as Promise<CellValue[]>;
      // Most recently used last.
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry;
    });
    for (const key of this.cache.keys()) {
      if (this.cached <= cachedCells || this.cache.size <= columns.length) break;
      const [cachedGroup] = key.split(":").map(Number);
      this.cache.delete(key);
      this.cached -= this.groups[cachedGroup][1] - this.groups[cachedGroup][0];
    }
    return result;
  }

  async read(start: number, end: number, columns: number[], signal?: AbortSignal): Promise<CellValue[][]> {
    end = Math.min(end, this.rows);
    if (end <= start || columns.length === 0) return columns.map(() => []);
    const unique = [...new Set(columns)];
    const parts: CellValue[][][] = [];
    for (let group = this.groupOf(start); group < this.groups.length && this.groups[group][0] < end; group++) {
      const [groupStart, groupEnd] = this.groups[group];
      const from = Math.max(start, groupStart);
      const to = Math.min(end, groupEnd);
      if (from === groupStart && to === groupEnd) {
        // Whole row groups are what scans read: decoded for this request only, not cached.
        parts.push(await this.decode(from, to, unique, signal));
      } else {
        const whole = await Promise.all(this.groupColumns(group, unique, signal));
        parts.push(whole.map((values) => values.slice(from - groupStart, to - groupStart)));
      }
    }
    const values = unique.map((_, position) =>
      parts.length === 1 ? parts[0][position] : parts.flatMap((part) => part[position]),
    );
    return columns.map((column) => values[unique.indexOf(column)]);
  }

  private groupOf(row: number) {
    let low = 0;
    let high = this.groups.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.groups[middle][1] <= row) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  granule(row: number): [number, number] {
    return this.groups[this.groupOf(row)] ?? [row, row + 1];
  }

  scanRanges() {
    return this.groups.filter(([start, end]) => end > start);
  }

  close() {
    this.cache.clear();
    this.cached = 0;
  }
}
