/**
 * Tables given as Parquet files, read by a module of their own that the engine loads with the first such table,
 * so that pages whose tables are rows do not load it. A file is read with hyparquet in byte ranges: of a `Blob`
 * by its slices, and of a URL by HTTP range requests. Opening it reads its footer only; the rows that a request
 * reads are read by their row groups, and the columns that a view sorts, filters or groups by are read whole, and
 * only they, into typed arrays as a text file's are. Columns have the types that DuckDB reads them as.
 */
import {
  type AsyncBuffer,
  type ColumnMetaData,
  type FileMetaData,
  type ParquetParsers,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type SchemaTree,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  type Column,
  dateText,
  daysFromCivil,
  decimalJson,
  floatJson,
  integerJson,
  intervalText,
  type JsonValue,
  type TimestampUnit,
  timestampText,
  timeText,
  toBase64,
  UNIT_PER_SECOND,
} from "vastgrid-spec";
import type { ColumnNumbers } from "vastgrid-spec/columns";
import { FileColumns } from "./lazy.js";
import { type HttpFetch, type ParquetTable, TableProblem, type Vector, vectorOf } from "./table.js";

// The page, Web Workers and Node.js all have these; the package is typed without the DOM or Node.js.
declare const TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(bytes: Uint8Array): string };
declare const fetch: HttpFetch;

/** The memory that the columns read whole may take by default (`ParquetTable.maxBytes`). */
const MAX_BYTES = 2 ** 30;
/** The most bytes of a file that is downloaded whole when its server does not answer range requests. */
const MAX_DOWNLOAD = 16 * 1024 * 1024;
/** Bytes of answered ranges kept for reading again. */
const CACHE_BYTES = 32 * 1024 * 1024;
/** Cells of row groups decoded for reading rows, kept for reading again. */
const CACHE_CELLS = 4_000_000;
const FIRST_DAY = daysFromCivil(1, 1, 1);
const LAST_DAY = daysFromCivil(9999, 12, 31);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Bytes and reads of a file so far: what was taken from the disk or the network. */
export interface Transfer {
  bytes: number;
  requests: number;
}

/** A file read in byte ranges. */
interface Bytes {
  readonly size: number;
  readonly transfer: Transfer;
  /** Bytes `start` (inclusive) to `end` (exclusive). */
  read(start: number, end: number): Promise<Uint8Array>;
}

function problem(message: string, code: TableProblem["code"] = "load_failed"): TableProblem {
  return new TableProblem("/parquet", message, code);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `Blob` or a `File`, read by its slices. */
function blobBytes(blob: ParquetTable["parquet"] & object): Bytes {
  const transfer = { bytes: 0, requests: 0 };
  return {
    size: blob.size,
    transfer,
    async read(start, end) {
      const buffer = await blob.slice(start, end).arrayBuffer();
      transfer.bytes += buffer.byteLength;
      transfer.requests++;
      if (buffer.byteLength !== end - start) throw problem("The file changed while it was read.", "file_changed");
      return new Uint8Array(buffer);
    },
  };
}

/** The `ETag`, or else the `Last-Modified`, of an answer; a server on another origin must expose them (CORS). */
function validatorOf(response: Awaited<ReturnType<HttpFetch>>): string | null {
  return response.headers.get("etag") ?? response.headers.get("last-modified");
}

/**
 * A file on a web server, read by HTTP range requests (`Range: bytes=…`). Its size comes from a `HEAD` request, or
 * from the `Content-Range` of a range of one byte; every answer is checked against the first `ETag` (or
 * `Last-Modified`), so that a file replaced while it is open fails with `file_changed` rather than mixing two of
 * them. A server that ignores ranges serves files of up to 16 MiB, downloaded once.
 */
async function httpBytes(url: string, table: ParquetTable): Promise<Bytes> {
  const send = table.fetch ?? fetch;
  const headers = table.headers ?? {};
  const transfer = { bytes: 0, requests: 0 };
  const cache = new Map<string, Uint8Array>();
  let cached = 0;
  let whole: Uint8Array | null = null;
  const request = async (init: { method?: string; headers: Record<string, string> }) => {
    transfer.requests++;
    try {
      return await send(url, init);
    } catch (error) {
      throw problem(
        `${url} could not be read (${errorText(error)}). A file on another origin is served with CORS: ` +
          "Access-Control-Allow-Origin, and Access-Control-Expose-Headers with Content-Length, Content-Range and ETag.",
      );
    }
  };
  const failed = (response: { status: number }) => problem(`${url} answered ${response.status}.`);
  const download = async (response: Awaited<ReturnType<HttpFetch>>) => {
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    if (length > MAX_DOWNLOAD) {
      throw problem(`${url} is served without range requests (HTTP Range) and is larger than 16 MiB.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    transfer.bytes += bytes.length;
    if (bytes.length > MAX_DOWNLOAD) {
      throw problem(`${url} is served without range requests (HTTP Range) and is larger than 16 MiB.`);
    }
    return bytes;
  };
  let size: number | null = null;
  let revision: string | null = null;
  const head = await request({ method: "HEAD", headers });
  // The Content-Length of a compressed answer is not the size of the file.
  if (head.ok && !head.headers.get("content-encoding") && /^\d+$/.test(head.headers.get("content-length") ?? "")) {
    size = Number(head.headers.get("content-length"));
    revision = validatorOf(head);
  } else if (head.status === 401 || head.status === 403 || head.status === 404) {
    throw failed(head);
  } else {
    // Some servers refuse HEAD; a range of one byte tells the size too.
    const first = await request({ headers: { ...headers, Range: "bytes=0-0" } });
    if (first.status === 206) {
      const total = /\/(\d+)\s*$/.exec(first.headers.get("content-range") ?? "");
      if (!total) {
        throw problem(
          `The size of ${url} is unknown: its server sent no Content-Range with the size (CORS must expose it).`,
        );
      }
      transfer.bytes += (await first.arrayBuffer()).byteLength;
      size = Number(total[1]);
      revision = validatorOf(first);
    } else if (first.ok) {
      whole = await download(first);
      size = whole.length;
    } else {
      throw failed(first);
    }
  }
  const length = size;
  return {
    size: length,
    transfer,
    async read(start, end) {
      if (whole) return whole.subarray(start, end);
      const key = `${start}-${end}`;
      const hit = cache.get(key);
      if (hit) {
        // The most recently used last.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const response = await request({ headers: { ...headers, Range: `bytes=${start}-${end - 1}` } });
      if (response.status === 416) throw problem(`${url} changed while it was open.`, "file_changed");
      if (!response.ok) throw failed(response);
      const validator = validatorOf(response);
      if (revision !== null && validator !== null && validator !== revision) {
        throw problem(`${url} changed while it was open.`, "file_changed");
      }
      if (response.status !== 206) {
        // The server stopped answering ranges, or never did and answered HEAD with the size.
        whole = await download(response);
        if (whole.length !== length) throw problem(`${url} changed while it was open.`, "file_changed");
        cache.clear();
        return whole.subarray(start, end);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      transfer.bytes += bytes.length;
      if (bytes.length !== end - start) throw problem(`${url} changed while it was open.`, "file_changed");
      if (bytes.length <= CACHE_BYTES) {
        cache.set(key, bytes);
        cached += bytes.length;
        for (const [old, value] of cache) {
          if (cached <= CACHE_BYTES) break;
          cache.delete(old);
          cached -= value.length;
        }
      }
      return bytes;
    },
  };
}

/** The bytes as an `ArrayBuffer`, without a copy when they are all of one. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const { buffer } = bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) return buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

/** Signed big-endian two's complement bytes as an integer. */
function bigIntOf(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return bytes.length > 0 && bytes[0] & 0x80 ? value - (1n << BigInt(bytes.length * 8)) : value;
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index++) text += bytes[index].toString(16).padStart(2, "0");
  return text;
}

/**
 * Values are given to the columns as hyparquet reads them, without its conversions: dates as days, timestamps as
 * counts of their unit, and strings checked as UTF-8 (§2.2 does not allow replacing text that is not).
 */
const parsers: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (count) => count,
  timestampFromMicroseconds: (count) => count,
  timestampFromNanoseconds: (count) => count,
  dateFromDays: (days) => days,
  stringFromBytes: (bytes) => bytes && utf8.decode(bytes),
  jsonFromBytes: (bytes) => bytes && utf8.decode(bytes),
  uuidFromBytes: (bytes) =>
    bytes && `${hex(bytes, 0, 4)}-${hex(bytes, 4, 6)}-${hex(bytes, 6, 8)}-${hex(bytes, 8, 10)}-${hex(bytes, 10, 16)}`,
  geometryFromBytes: (bytes) => bytes,
  geographyFromBytes: (bytes) => bytes,
};

/** Nested values (lists, structs and maps) as DuckDB casts them to text: `[1, 2]`, `{'a': 1}`, `{k=1}`. */
function nestedText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return `[${value.map(nestedText).join(", ")}]`;
  if (value instanceof Map)
    return `{${[...value].map(([key, item]) => `${nestedText(key)}=${nestedText(item)}`).join(", ")}}`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `'${key}': ${nestedText(item)}`).join(", ")}}`;
  }
  return String(value);
}

/** What typed arrays hold a column's values when it is read whole. */
type ArrayKind = "int32" | "float32" | "float64" | "int64" | null;

/** A column of the file: its column of §2.1, and how its values from hyparquet become typed JSON (§2.2). */
interface Kind {
  column: Column;
  array: ArrayKind;
  /** The number that holds a value, or null for null and for values that DuckDB reads as null; of `array` kinds. */
  number(value: unknown): number | bigint | null;
  /** The JSON of a number that `number` gave. */
  json(value: number | bigint): JsonValue;
  /** The JSON of a value from hyparquet. */
  read(value: unknown): JsonValue;
}

function typed(column: Column, array: ArrayKind, number: Kind["number"], json: Kind["json"]): Kind {
  return {
    column,
    array,
    number,
    json,
    read: (value) => {
      const held = number(value);
      return held === null ? null : json(held);
    },
  };
}

function untyped(column: Column, read: (value: unknown) => JsonValue): Kind {
  return {
    column,
    array: null,
    number: () => null,
    json: () => null,
    read: (value) => (value === null || value === undefined ? null : read(value)),
  };
}

/** Whether a count of `perDay` per day falls in the years 0001 to 9999, which DuckDB's engine reads (§2.2). */
function inYears(count: bigint, perDay: bigint): boolean {
  let day = count / perDay;
  if (count % perDay < 0n) day--;
  return day >= BigInt(FIRST_DAY) && day <= BigInt(LAST_DAY);
}

function isNull(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** DuckDB's name of a nested type, as `sourceType`: `INTEGER[]`, `STRUCT(a INTEGER)`, `MAP(VARCHAR, INTEGER)`. */
function nestedName(node: SchemaTree): string {
  const { element, children } = node;
  const logical = element.logical_type?.type;
  const converted = element.converted_type;
  if (converted === "LIST" || logical === "LIST") {
    const repeated = children[0];
    const item = repeated && repeated.children.length === 1 && repeated.children[0] ? repeated.children[0] : repeated;
    return `${item ? nestedName(item) : "NULL"}[]`;
  }
  if (converted === "MAP" || converted === "MAP_KEY_VALUE" || logical === "MAP") {
    const [key, value] = children[0]?.children ?? [];
    return `MAP(${key ? nestedName(key) : "NULL"}, ${value ? nestedName(value) : "NULL"})`;
  }
  if (children.length > 0 || element.type === undefined) {
    const name = (child: SchemaTree) =>
      /^[a-z_][a-z0-9_]*$/.test(child.element.name) ? child.element.name : JSON.stringify(child.element.name);
    return `STRUCT(${children.map((child) => `${name(child)} ${nestedName(child)}`).join(", ")})`;
  }
  return kindOf({ ...node, element: { ...node.element } }).column.sourceType ?? "BLOB";
}

/**
 * The kind of a top-level column of the file, with the type that DuckDB reads it as. Decimals, intervals and BSON
 * lose their annotations, so that hyparquet gives their stored values (it would make decimals floats and refuse
 * intervals).
 */
function kindOf(node: SchemaTree): Kind {
  const { element, children } = node;
  const name = element.name;
  const logical = element.logical_type;
  const converted = element.converted_type;
  if (children.length > 0 || element.type === undefined) {
    return untyped({ name, type: "string", sourceType: nestedName(node), readOnly: true }, nestedText);
  }
  if (converted === "DECIMAL" || logical?.type === "DECIMAL") {
    const scale = element.scale ?? (logical?.type === "DECIMAL" ? logical.scale : 0) ?? 0;
    const precision = element.precision ?? (logical?.type === "DECIMAL" ? logical.precision : 18) ?? 18;
    element.converted_type = undefined;
    element.logical_type = undefined;
    const column: Column = { name, type: "decimal", precision, scale, sourceType: `DECIMAL(${precision},${scale})` };
    const unscaled = (value: unknown) =>
      value instanceof Uint8Array ? bigIntOf(value) : BigInt(value as number | bigint);
    if (precision <= 18) {
      return typed(
        column,
        "int64",
        (value) => (isNull(value) ? null : unscaled(value)),
        (value) => decimalJson(value as bigint, scale),
      );
    }
    return untyped(column, (value) => decimalJson(unscaled(value), scale));
  }
  if (converted === "INTERVAL" || logical?.type === "INTERVAL") {
    element.converted_type = undefined;
    element.logical_type = undefined;
    return untyped({ name, type: "interval", sourceType: "INTERVAL" }, (value) => {
      const bytes = value as Uint8Array;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return intervalText({
        months: view.getInt32(0, true),
        days: view.getInt32(4, true),
        nanos: BigInt(view.getUint32(8, true)) * 1_000_000n,
      });
    });
  }
  if (converted === "BSON" || logical?.type === "BSON") {
    element.converted_type = undefined;
    element.logical_type = undefined;
    return untyped({ name, type: "binary", sourceType: "BLOB" }, (value) => toBase64(value as Uint8Array));
  }
  if (converted === "DATE" || logical?.type === "DATE") {
    return typed(
      { name, type: "date", sourceType: "DATE" },
      "int32",
      (value) =>
        isNull(value) || (value as number) < FIRST_DAY || (value as number) > LAST_DAY ? null : (value as number),
      (value) => dateText(value as number),
    );
  }
  if (converted === "TIME_MILLIS" || converted === "TIME_MICROS" || logical?.type === "TIME") {
    const unit = logical?.type === "TIME" ? logical.unit : converted === "TIME_MILLIS" ? "MILLIS" : "MICROS";
    return typed(
      { name, type: "time", sourceType: "TIME" },
      "int64",
      (value) => {
        if (isNull(value)) return null;
        const count = BigInt(value as number | bigint);
        const micros = unit === "MILLIS" ? count * 1000n : unit === "NANOS" ? count / 1000n : count;
        return micros >= 0n && micros < 86_400_000_000n ? micros : null;
      },
      (value) => timeText(value as bigint),
    );
  }
  const timestamp =
    logical?.type === "TIMESTAMP"
      ? logical
      : converted === "TIMESTAMP_MILLIS" || converted === "TIMESTAMP_MICROS"
        ? { isAdjustedToUTC: false, unit: converted === "TIMESTAMP_MILLIS" ? "MILLIS" : "MICROS" }
        : element.type === "INT96"
          ? { isAdjustedToUTC: false, unit: "INT96" }
          : null;
  if (timestamp) {
    // DuckDB reads milliseconds, and the nanoseconds of INT96, as microseconds; nanoseconds as TIMESTAMP_NS.
    const nanos = timestamp.unit === "NANOS" && !timestamp.isAdjustedToUTC;
    const unit: TimestampUnit = nanos ? "ns" : "us";
    const perDay = 86_400n * UNIT_PER_SECOND[unit];
    const scaled =
      timestamp.unit === "MILLIS"
        ? (count: bigint) => count * 1000n
        : timestamp.unit === "INT96" || (timestamp.unit === "NANOS" && !nanos)
          ? (count: bigint) => (count < 0n && count % 1000n !== 0n ? count / 1000n - 1n : count / 1000n)
          : (count: bigint) => count;
    const column: Column = timestamp.isAdjustedToUTC
      ? { name, type: "timestamptz", sourceType: "TIMESTAMP WITH TIME ZONE" }
      : nanos
        ? { name, type: "timestamp", unit: "ns", sourceType: "TIMESTAMP_NS" }
        : { name, type: "timestamp", sourceType: "TIMESTAMP" };
    return typed(
      column,
      "int64",
      (value) => {
        if (isNull(value)) return null;
        const count = scaled(BigInt(value as number | bigint));
        return inYears(count, perDay) ? count : null;
      },
      timestamp.isAdjustedToUTC
        ? (value) => `${timestampText(value as bigint)}+00`
        : (value) => timestampText(value as bigint, unit),
    );
  }
  if (converted === "JSON" || logical?.type === "JSON") {
    return untyped({ name, type: "string", sourceType: "JSON", readOnly: true }, (value) => value as string);
  }
  if (logical?.type === "UUID") return untyped({ name, type: "uuid", sourceType: "UUID" }, (value) => value as string);
  if (converted === "UTF8" || converted === "ENUM" || logical?.type === "STRING" || logical?.type === "ENUM") {
    return untyped({ name, type: "string", sourceType: "VARCHAR" }, (value) =>
      value instanceof Uint8Array ? utf8.decode(value) : (value as string),
    );
  }
  const integer = logical?.type === "INTEGER" ? logical : null;
  const unsigned = converted?.startsWith("UINT_") || (integer !== null && !integer.isSigned);
  const bits = integer?.bitWidth ?? (converted ? Number(/\d+$/.exec(converted)?.[0] ?? 0) : 0);
  switch (element.type) {
    case "BOOLEAN":
      return untyped({ name, type: "boolean", sourceType: "BOOLEAN" }, (value) => value as boolean);
    case "INT32": {
      if (unsigned && bits === 32) {
        return typed(
          { name, type: "bigint", sourceType: "UINTEGER" },
          "int64",
          (value) => (isNull(value) ? null : BigInt(value as number)),
          (value) => integerJson(value as bigint),
        );
      }
      const sourceType =
        bits === 8
          ? unsigned
            ? "UTINYINT"
            : "TINYINT"
          : bits === 16
            ? unsigned
              ? "USMALLINT"
              : "SMALLINT"
            : "INTEGER";
      return typed(
        { name, type: "integer", sourceType },
        "int32",
        (value) => (isNull(value) ? null : (value as number)),
        (value) => value as number,
      );
    }
    case "INT64":
      if (unsigned) {
        return untyped({ name, type: "decimal", precision: 38, scale: 0, sourceType: "UBIGINT" }, (value) =>
          BigInt(value as bigint).toString(),
        );
      }
      return typed(
        { name, type: "bigint", sourceType: "BIGINT" },
        "int64",
        (value) => (isNull(value) ? null : BigInt(value as bigint)),
        (value) => integerJson(value as bigint),
      );
    case "FLOAT":
      return typed(
        { name, type: "float", bits: 32, sourceType: "FLOAT" },
        "float32",
        (value) => (isNull(value) ? null : (value as number)),
        (value) => floatJson(value as number),
      );
    case "DOUBLE":
      return typed(
        { name, type: "float", sourceType: "DOUBLE" },
        "float64",
        (value) => (isNull(value) ? null : (value as number)),
        (value) => floatJson(value as number),
      );
    default:
      if (logical?.type === "FLOAT16") {
        return typed(
          { name, type: "float", bits: 32, sourceType: "FLOAT" },
          "float32",
          (value) => (isNull(value) ? null : Math.fround(value as number)),
          (value) => floatJson(value as number),
        );
      }
      return untyped({ name, type: "binary", sourceType: "BLOB" }, (value) => toBase64(value as Uint8Array));
  }
}

/** A column read whole: typed arrays of numbers and validity, or an array of typed JSON. */
interface Whole {
  vector: Vector;
  set(row: number, value: unknown): void;
}

function wholeOf(kind: Kind, rows: number): Whole {
  if (kind.column.type === "boolean") {
    // A byte per row: 0 for false, 1 for true and 2 for null.
    const flags = new Uint8Array(rows).fill(2);
    return {
      vector: { length: rows, at: (row) => (flags[row] === 2 ? null : flags[row] === 1) },
      set: (row, value) => {
        const held = kind.read(value);
        if (held !== null) flags[row] = held ? 1 : 0;
      },
    };
  }
  if (kind.array === null) {
    const values: JsonValue[] = new Array(rows).fill(null);
    return {
      vector: vectorOf(values),
      set: (row, value) => {
        values[row] = kind.read(value);
      },
    };
  }
  const numbers: ColumnNumbers =
    kind.array === "int32"
      ? new Int32Array(rows)
      : kind.array === "float32"
        ? new Float32Array(rows)
        : kind.array === "float64"
          ? new Float64Array(rows)
          : new BigInt64Array(rows);
  const validity = new Uint8Array(Math.ceil(rows / 8)).fill(0xff);
  const json = kind.json;
  return {
    vector: {
      length: rows,
      numbers,
      validity,
      at: (row) => (((validity[row >> 3] >> (row & 7)) & 1) === 1 ? json(numbers[row]) : null),
    },
    set: (row, value) => {
      const held = kind.number(value);
      if (held === null) validity[row >> 3] &= ~(1 << (row & 7));
      else numbers[row] = held as never;
    },
  };
}

/** The bytes that a column of typed arrays takes when it is read whole. */
function arrayBytes(array: Exclude<ArrayKind, null>, rows: number): number {
  return (array === "int32" || array === "float32" ? 4 : 8) * rows + rows / 8;
}

/**
 * About the bytes that a chunk of a column of JSON values takes when it is read whole, from its size in the file
 * (`total_uncompressed_size`): a reference per value, and the values as JavaScript holds them, text in strings of
 * twice its UTF-8 at most. The values of a dictionary are its strings, which every row that holds them shares.
 */
function chunkBytes(meta: ColumnMetaData): number {
  const stored = Number(meta.total_uncompressed_size);
  const values = Number(meta.num_values);
  if (fromDictionary(meta)) return 8 * values + 4 * stored;
  // A string's header and its text; values of BYTE_ARRAY are stored after 4 bytes of their length.
  const text = meta.type === "BYTE_ARRAY" ? Math.max(0, stored - 4 * values) : stored;
  return 8 * values + 16 * values + 2 * text;
}

/** Whether every data page of a chunk holds indexes into its dictionary. */
function fromDictionary(meta: ColumnMetaData): boolean {
  if (meta.dictionary_page_offset === undefined) return false;
  const dictionary = (encoding: string) => encoding === "PLAIN_DICTIONARY" || encoding === "RLE_DICTIONARY";
  if (meta.encoding_stats) {
    return meta.encoding_stats.every((stat) => !stat.page_type.startsWith("DATA_PAGE") || dictionary(stat.encoding));
  }
  // Without the encodings of each page, PLAIN may be the dictionary's or a data page's.
  return !meta.encodings.includes("PLAIN") && meta.encodings.some(dictionary);
}

/** A Parquet file that is open: its columns, and what has been read of them. */
export class ParquetFile extends FileColumns {
  /** The first row of each row group, and the row count after the last. */
  private readonly starts: number[];
  private readonly buffer: AsyncBuffer;
  /** Columns of row groups decoded for reading rows, by `group:column`, the most recently used last. */
  private readonly cache = new Map<string, Promise<JsonValue[]>>();
  private cached = 0;

  private constructor(
    private readonly bytes: Bytes,
    private readonly metadata: FileMetaData,
    private readonly kinds: Kind[],
    maxBytes: number,
  ) {
    super(
      kinds.map((kind) => kind.column),
      Number(metadata.num_rows),
      maxBytes,
    );
    this.starts = [0];
    for (const group of metadata.row_groups)
      this.starts.push(this.starts[this.starts.length - 1] + Number(group.num_rows));
    this.buffer = {
      byteLength: bytes.size,
      slice: async (start, end) => bufferOf(await bytes.read(start, end ?? bytes.size)),
    };
  }

  /** Opens a file: reads its footer, and finds its columns. */
  static async open(table: ParquetTable): Promise<ParquetFile> {
    const { parquet, maxBytes = MAX_BYTES } = table;
    if (typeof maxBytes !== "number" || !(maxBytes > 0)) {
      throw new TableProblem("/maxBytes", "maxBytes is a number of bytes.");
    }
    let bytes: Bytes;
    if (typeof parquet === "string") bytes = await httpBytes(parquet, table);
    else if (parquet !== null && typeof parquet === "object" && typeof parquet.slice === "function") {
      bytes = blobBytes(parquet);
    } else {
      throw problem("parquet is a Blob, a File or the URL of a file.");
    }
    let metadata: FileMetaData;
    try {
      metadata = await parquetMetadataAsync(
        { byteLength: bytes.size, slice: async (start, end) => bufferOf(await bytes.read(start, end ?? bytes.size)) },
        { parsers, geoparquet: false, initialFetchSize: Math.min(bytes.size, 64 * 1024) } as never,
      );
    } catch (error) {
      if (error instanceof TableProblem) throw error;
      throw problem(`The file is not a Parquet file that can be read: ${errorText(error)}`);
    }
    const kinds = parquetSchema(metadata).children.map(kindOf);
    const names = new Set<string>();
    for (const kind of kinds) {
      if (names.has(kind.column.name)) throw problem(`"${kind.column.name}" names two columns.`);
      names.add(kind.column.name);
    }
    return new ParquetFile(bytes, metadata, kinds, maxBytes);
  }

  /** Bytes and reads of the file so far. */
  get transfer(): Transfer {
    return { ...this.bytes.transfer };
  }

  /** Decodes columns of rows `start` to `end` of the file, giving each value to `set`. */
  private async decode(
    start: number,
    end: number,
    indexes: number[],
    set: (at: number, row: number, value: unknown) => void,
  ): Promise<void> {
    const positions = new Map(indexes.map((index, at) => [this.columns[index].name, at]));
    try {
      await parquetRead({
        file: this.buffer,
        metadata: this.metadata,
        columns: [...positions.keys()],
        rowStart: start,
        rowEnd: end,
        utf8: false,
        parsers,
        compressors,
        geoparquet: false,
        useOffsetIndex: true,
        // Column by column: no rows are made.
        onChunk: (chunk) => {
          const at = positions.get(chunk.columnName);
          if (at === undefined) return;
          const data = chunk.columnData;
          for (let row = Math.max(start, chunk.rowStart); row < Math.min(end, chunk.rowEnd); row++) {
            set(at, row, data[row - chunk.rowStart]);
          }
        },
      });
    } catch (error) {
      if (error instanceof TableProblem) throw error;
      throw problem(`The file could not be read: ${errorText(error)}`);
    }
  }

  /** The row group of a row. */
  protected partOf(row: number): number {
    let low = 0;
    let high = this.starts.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= row) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** A column of a row group as typed JSON, decoded once and kept while it fits the cache. */
  private groupColumn(group: number, index: number): Promise<JsonValue[]> {
    const key = `${group}:${index}`;
    let entry = this.cache.get(key);
    const size = this.starts[group + 1] - this.starts[group];
    if (entry) {
      this.cache.delete(key);
    } else {
      const start = this.starts[group];
      const values: JsonValue[] = new Array(size).fill(null);
      const kind = this.kinds[index];
      entry = this.decode(start, start + size, [index], (_, row, value) => {
        values[row - start] = kind.read(value);
      }).then(() => values);
      this.cached += size;
      // A failed read is not kept.
      entry.catch(() => {
        if (this.cache.get(key) === entry) {
          this.cache.delete(key);
          this.cached -= size;
        }
      });
    }
    this.cache.set(key, entry);
    for (const [old] of this.cache) {
      if (this.cached <= CACHE_CELLS || old === key) break;
      const oldGroup = Number(old.slice(0, old.indexOf(":")));
      this.cache.delete(old);
      this.cached -= this.starts[oldGroup + 1] - this.starts[oldGroup];
    }
    return entry;
  }

  protected async readCells(index: number, rows: ArrayLike<number>): Promise<JsonValue[]> {
    const groups = new Map<number, Promise<JsonValue[]>>();
    for (let at = 0; at < rows.length; at++) {
      const group = this.partOf(rows[at]);
      if (!groups.has(group)) groups.set(group, this.groupColumn(group, index));
    }
    const read = new Map<number, JsonValue[]>();
    for (const [group, values] of groups) read.set(group, await values);
    return Array.from(rows, (row) => {
      const group = this.partOf(row);
      return (read.get(group) as JsonValue[])[row - this.starts[group]];
    });
  }

  /** About the memory that a column read whole takes. */
  protected sizeOf(index: number): number {
    const kind = this.kinds[index];
    if (kind.column.type === "boolean") return this.rowCount;
    if (kind.array !== null) return arrayBytes(kind.array, this.rowCount);
    const name = kind.column.name;
    let bytes = 0;
    for (const group of this.metadata.row_groups) {
      for (const chunk of group.columns) {
        if (chunk.meta_data?.path_in_schema[0] === name) bytes += chunkBytes(chunk.meta_data);
      }
    }
    return bytes;
  }

  protected async readWhole(indexes: number[], pause: () => Promise<void>): Promise<Vector[]> {
    const wholes = indexes.map((index) => wholeOf(this.kinds[index], this.rowCount));
    for (let group = 0; group < this.starts.length - 1; group++) {
      await pause();
      await this.decode(this.starts[group], this.starts[group + 1], indexes, (at, row, value) =>
        wholes[at].set(row, value),
      );
    }
    // Their row groups are read from the columns now.
    for (const index of indexes) {
      for (let group = 0; group < this.starts.length - 1; group++) {
        if (this.cache.delete(`${group}:${index}`)) this.cached -= this.starts[group + 1] - this.starts[group];
      }
    }
    return wholes.map((whole) => whole.vector);
  }

  /** Forgets what was read. */
  close(): void {
    this.cache.clear();
    this.cached = 0;
  }
}
