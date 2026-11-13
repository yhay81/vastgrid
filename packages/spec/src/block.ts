/**
 * Blocks (docs/spec.md §8.4): rows as an Apache Arrow IPC stream with one schema and one record batch,
 * and back. Values are written into and read from the Arrow buffers themselves, so that none changes on
 * the way: 64-bit integers, decimals, timestamps of every unit, intervals, and strings that start with
 * U+FEFF (Appendix B).
 */
import {
  Column as ArrowColumn,
  Batch,
  binary,
  bool,
  DateUnit,
  dateDay,
  decimal,
  Endianness,
  field,
  fixedSizeBinary,
  float32,
  float64,
  IntervalUnit,
  int32,
  int64,
  interval,
  Precision,
  Table,
  TimeUnit,
  Type,
  tableFromIPC,
  tableToIPC,
  time,
  timestamp,
  utf8,
  Version,
} from "@uwdata/flechette";
import {
  DATE_INFINITY,
  dateText,
  floorDiv,
  intervalText,
  parseDateText,
  parseIntervalText,
  parseTimestampText,
  parseTimestamptzText,
  parseTimeText,
  TIMESTAMP_INFINITY,
  timestampText,
  timestamptzText,
  timeText,
  UNIT_PER_SECOND,
} from "./calendar.js";
import type { Column, JsonValue, TimestampUnit, ValueType } from "./types.js";
import { floatJson, floatOf, fromBase64, isValueOf, toBase64, typeName } from "./values.js";

/** A value that cannot be written without loss; the path is relative to the block's rows. */
export class BlockValueError extends TypeError {
  readonly reason = "type";

  constructor(
    readonly path: string,
    type: ValueType,
  ) {
    super(`The value at ${path} is not a ${typeName(type)} value within the ranges of §2.2.`);
    this.name = "BlockValueError";
  }
}

/** The field metadata that marks a FixedSizeBinary(16) field as UUIDs (§8.4). */
export const UUID_EXTENSION = { key: "ARROW:extension:name", value: "arrow.uuid" } as const;

const UNITS = {
  s: TimeUnit.SECOND,
  ms: TimeUnit.MILLISECOND,
  us: TimeUnit.MICROSECOND,
  ns: TimeUnit.NANOSECOND,
} as const;

export const UNIT_NAMES: TimestampUnit[] = ["s", "ms", "us", "ns"];

// A string that starts with U+FEFF keeps it (§8.4).
const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

/** The JSON of a 64-bit integer (§2.2): a number when it is safe, otherwise its digits. */
export function integerJson(value: bigint): JsonValue {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

/** The decimal text of an unscaled integer (§2.2). */
export function decimalJson(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** The unscaled integer of a decimal's text with `scale` fraction digits (§2.2). */
function unscaledOf(value: JsonValue, scale: number): bigint {
  const match = typeof value === "string" ? /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value) : null;
  if (!match || (match[3] ?? "").length !== scale)
    throw new TypeError(`${JSON.stringify(value)} is not a decimal of scale ${scale}.`);
  const unscaled = BigInt(`${match[2]}${match[3] ?? ""}`);
  return match[1] === "-" ? -unscaled : unscaled;
}

function uuidBytes(value: JsonValue, into: Uint8Array, at: number) {
  const hex = typeof value === "string" ? value.replaceAll("-", "") : "";
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new TypeError(`${JSON.stringify(value)} is not a UUID.`);
  for (let index = 0; index < 16; index++) into[at + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

function uuidText(bytes: Uint8Array): string {
  return (
    `${HEX[bytes[0]]}${HEX[bytes[1]]}${HEX[bytes[2]]}${HEX[bytes[3]]}-` +
    `${HEX[bytes[4]]}${HEX[bytes[5]]}-` +
    `${HEX[bytes[6]]}${HEX[bytes[7]]}-` +
    `${HEX[bytes[8]]}${HEX[bytes[9]]}-` +
    `${HEX[bytes[10]]}${HEX[bytes[11]]}${HEX[bytes[12]]}${HEX[bytes[13]]}${HEX[bytes[14]]}${HEX[bytes[15]]}`
  );
}

function textOfValue(value: JsonValue, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${JSON.stringify(value)} is not ${what}.`);
  return value;
}

/** The Arrow type of a logical type (§8.4). */
function arrowType(type: ValueType) {
  switch (type.type) {
    case "boolean":
      return bool();
    case "integer":
      return int32();
    case "bigint":
      return int64();
    case "decimal":
      return decimal(type.precision ?? 38, type.scale ?? 0, 128);
    case "float":
      return type.bits === 32 ? float32() : float64();
    case "string":
      return utf8();
    case "date":
      return dateDay();
    case "time":
      return time(TimeUnit.MICROSECOND);
    case "timestamp":
      return timestamp(UNITS[type.unit ?? "us"], null);
    case "timestamptz":
      return timestamp(TimeUnit.MICROSECOND, "UTC");
    case "interval":
      return interval(IntervalUnit.MONTH_DAY_NANO);
    case "uuid":
      return fixedSizeBinary(16);
    case "binary":
      return binary();
  }
}

/** The validity bitmap and the buffers of one column's values. */
function buffers(column: Column, columnIndex: number, rows: readonly (readonly JsonValue[])[]) {
  const length = rows.length;
  let nullCount = 0;
  const bitmap = new Uint8Array(Math.ceil(length / 8));
  const readCell = (at: number): JsonValue => {
    const value = rows[at][columnIndex] ?? null;
    if (!isValueOf(value, column)) throw new BlockValueError(`/rows/${at}/${columnIndex}`, column);
    if (value === null) nullCount++;
    else bitmap[at >> 3] |= 1 << (at & 7);
    return value;
  };
  const validityOf = () => (nullCount === 0 ? new Uint8Array(0) : bitmap);
  const fixed = (width: number, write: (view: DataView, at: number, value: JsonValue) => void) => {
    const bytes = new Uint8Array(length * width);
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < length; at++) {
      const value = readCell(at);
      if (value !== null) write(view, at * width, value);
    }
    return bytes;
  };
  switch (column.type) {
    case "boolean": {
      const bits = new Uint8Array(Math.ceil(length / 8));
      for (let at = 0; at < length; at++) {
        if (readCell(at) === true) bits[at >> 3] |= 1 << (at & 7);
      }
      return { validity: validityOf(), nullCount, values: bits };
    }
    case "integer": {
      const values = new Int32Array(length);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value !== null) values[at] = Number(value);
      }
      return { validity: validityOf(), nullCount, values };
    }
    case "bigint": {
      const values = new BigInt64Array(length);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value !== null) values[at] = BigInt(value as number | string);
      }
      return { validity: validityOf(), nullCount, values };
    }
    case "decimal": {
      const scale = column.scale ?? 0;
      const bytes = fixed(16, (view, at, value) => {
        const unscaled = BigInt.asUintN(128, unscaledOf(value, scale));
        view.setBigUint64(at, unscaled & 0xffff_ffff_ffff_ffffn, true);
        view.setBigUint64(at + 8, unscaled >> 64n, true);
      });
      return { validity: validityOf(), nullCount, values: bytes };
    }
    case "float": {
      const values = column.bits === 32 ? new Float32Array(length) : new Float64Array(length);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value !== null) values[at] = floatOf(value);
      }
      return { validity: validityOf(), nullCount, values };
    }
    case "string":
    case "binary": {
      const offsets = new Int32Array(length + 1);
      const parts: Uint8Array[] = [];
      let byteLength = 0;
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value !== null) {
          const part =
            column.type === "string"
              ? encoder.encode(textOfValue(value, "a string"))
              : fromBase64(textOfValue(value, "base64"));
          parts.push(part);
          byteLength += part.length;
          if (byteLength > 2_147_483_647) throw new RangeError("A block holds at most 2 GiB of one column's text.");
        }
        offsets[at + 1] = byteLength;
      }
      const bytes = new Uint8Array(byteLength);
      let pos = 0;
      for (const part of parts) {
        bytes.set(part, pos);
        pos += part.length;
      }
      return { validity: validityOf(), nullCount, values: bytes, offsets };
    }
    case "date": {
      const values = new Int32Array(length);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value === null) continue;
        const days = parseDateText(textOfValue(value, "a date"));
        if (days === null) throw new TypeError(`${JSON.stringify(value)} is not a date.`);
        values[at] = days;
      }
      return { validity: validityOf(), nullCount, values };
    }
    case "time":
    case "timestamp":
    case "timestamptz": {
      const unit = column.type === "timestamp" ? (column.unit ?? "us") : "us";
      const values = new BigInt64Array(length);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value === null) continue;
        const text = textOfValue(value, `a ${column.type}`);
        const count =
          column.type === "time"
            ? parseTimeText(text)
            : column.type === "timestamptz"
              ? parseTimestamptzText(text)
              : parseTimestampText(text, unit);
        if (count === null) throw new TypeError(`${JSON.stringify(value)} is not a ${column.type}.`);
        values[at] = count;
      }
      return { validity: validityOf(), nullCount, values };
    }
    case "interval": {
      const bytes = fixed(16, (view, at, value) => {
        const parts = parseIntervalText(textOfValue(value, "an interval"));
        if (!parts) throw new TypeError(`${JSON.stringify(value)} is not an interval.`);
        view.setInt32(at, parts.months, true);
        view.setInt32(at + 4, parts.days, true);
        view.setBigInt64(at + 8, parts.nanos, true);
      });
      return { validity: validityOf(), nullCount, values: bytes };
    }
    case "uuid": {
      const bytes = new Uint8Array(length * 16);
      for (let at = 0; at < length; at++) {
        const value = readCell(at);
        if (value !== null) uuidBytes(value, bytes, at * 16);
      }
      return { validity: validityOf(), nullCount, values: bytes };
    }
  }
}

/** Writes rows (typed JSON, §2.2) of columns as a block (§8.4). */
export function encodeBlock(columns: readonly Column[], rows: readonly (readonly JsonValue[])[]): Uint8Array {
  const fields = columns.map((column) =>
    field(
      column.name,
      arrowType(column),
      true,
      column.type === "uuid" ? new Map([[UUID_EXTENSION.key, UUID_EXTENSION.value]]) : null,
    ),
  );
  const children = columns.map((column, index) => {
    const type = fields[index].type;
    const batch = new Batch({ length: rows.length, type, ...buffers(column, index, rows) } as ConstructorParameters<
      typeof Batch
    >[0]);
    return new ArrowColumn([batch], type);
  });
  const table = new Table({ version: Version.V5, endianness: Endianness.Little, fields, metadata: null }, children);
  return tableToIPC(table, { format: "stream" }) as Uint8Array;
}

export interface RawBatch {
  length: number;
  nullCount: number;
  validity?: Uint8Array;
  values?: ArrayBufferView;
  offsets?: Int32Array | BigInt64Array;
  data?: Uint8Array[];
}

export interface ArrowField {
  name: string;
  type: {
    typeId: number;
    bitWidth?: number;
    signed?: boolean;
    precision?: number;
    scale?: number;
    unit?: number;
    timezone?: string | null;
    stride?: number;
  };
  metadata?: Map<string, string> | null;
}

export function bytesOf(view: ArrayBufferView | undefined): Uint8Array {
  return view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(0);
}

/** The logical type of an Arrow field (§2.1, §8.4). */
export function logicalType(arrow: ArrowField): ValueType {
  const type = arrow.type;
  switch (type.typeId) {
    case Type.Bool:
      return { type: "boolean" };
    case Type.Int: {
      const bits = type.bitWidth ?? 32;
      if (type.signed === false)
        return bits <= 16
          ? { type: "integer" }
          : bits === 32
            ? { type: "bigint" }
            : { type: "decimal", precision: 38, scale: 0 };
      return bits <= 32 ? { type: "integer" } : { type: "bigint" };
    }
    case Type.Decimal:
      if ((type.precision ?? 0) > 38) break;
      return { type: "decimal", precision: type.precision ?? 38, scale: type.scale ?? 0 };
    case Type.Float:
      if (type.precision === Precision.HALF) break;
      return type.precision === Precision.SINGLE ? { type: "float", bits: 32 } : { type: "float" };
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Utf8View:
      return { type: "string" };
    case Type.Date:
      return { type: "date" };
    case Type.Time:
      return { type: "time" };
    case Type.Timestamp:
      if (type.timezone) return { type: "timestamptz" };
      return type.unit === TimeUnit.MICROSECOND
        ? { type: "timestamp" }
        : { type: "timestamp", unit: UNIT_NAMES[type.unit ?? 2] };
    case Type.Interval:
      return { type: "interval" };
    case Type.FixedSizeBinary:
      return arrow.metadata?.get(UUID_EXTENSION.key) === UUID_EXTENSION.value && type.stride === 16
        ? { type: "uuid" }
        : { type: "binary" };
    case Type.Binary:
    case Type.LargeBinary:
    case Type.BinaryView:
      return { type: "binary" };
  }
  throw new TypeError(`A block has no column type for the Arrow type ${type.typeId} of "${arrow.name}".`);
}

/** Reads the values of one batch of a field as typed JSON of a logical type: a function of a value's index. */
export function batchReader(arrow: ArrowField, batch: RawBatch, logical: ValueType): (index: number) => JsonValue {
  const type = arrow.type;
  const valid = (index: number) =>
    batch.nullCount === 0 ||
    !batch.validity ||
    batch.validity.length === 0 ||
    ((batch.validity[index >> 3] >> (index & 7)) & 1) === 1;
  const raw = bytesOf(batch.values);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const width = (type.bitWidth ?? 0) / 8;
  const offsetAt = (index: number) => Number(batch.offsets?.[index] ?? 0);
  // The bytes of value `index` of variable-length and view types.
  const variableBytes = (index: number): Uint8Array => {
    if (type.typeId === Type.Utf8View || type.typeId === Type.BinaryView) {
      const at = index * 16;
      const length = view.getInt32(at, true);
      if (length <= 12) return raw.subarray(at + 4, at + 4 + length);
      const data = batch.data?.[view.getInt32(at + 8, true)] ?? new Uint8Array(0);
      const start = view.getInt32(at + 12, true);
      return data.subarray(start, start + length);
    }
    return raw.subarray(offsetAt(index), offsetAt(index + 1));
  };
  const integer = (index: number): bigint => {
    switch (width) {
      case 1:
        return BigInt(type.signed === false ? view.getUint8(index) : view.getInt8(index));
      case 2:
        return BigInt(type.signed === false ? view.getUint16(index * 2, true) : view.getInt16(index * 2, true));
      case 4:
        return BigInt(type.signed === false ? view.getUint32(index * 4, true) : view.getInt32(index * 4, true));
      default:
        return type.signed === false ? view.getBigUint64(index * 8, true) : view.getBigInt64(index * 8, true);
    }
  };
  const perSecond = (unit: number | undefined) => UNIT_PER_SECOND[UNIT_NAMES[unit ?? 2]];
  const value = (index: number): JsonValue => {
    switch (type.typeId) {
      case Type.Bool:
        return ((raw[index >> 3] >> (index & 7)) & 1) === 1;
      case Type.Int: {
        const number = integer(index);
        return logical.type === "decimal" ? decimalJson(number, 0) : integerJson(number);
      }
      case Type.Decimal: {
        const bits = type.bitWidth ?? 128;
        let unscaled: bigint;
        if (bits === 32) unscaled = BigInt(view.getInt32(index * 4, true));
        else if (bits === 64) unscaled = view.getBigInt64(index * 8, true);
        else {
          const size = bits / 8;
          unscaled = 0n;
          for (let word = size / 8 - 1; word >= 0; word--) {
            unscaled = (unscaled << 64n) | view.getBigUint64(index * size + word * 8, true);
          }
          unscaled = BigInt.asIntN(bits, unscaled);
        }
        return decimalJson(unscaled, type.scale ?? 0);
      }
      case Type.Float:
        return floatJson(
          type.precision === Precision.SINGLE ? view.getFloat32(index * 4, true) : view.getFloat64(index * 8, true),
        );
      case Type.Utf8:
      case Type.LargeUtf8:
      case Type.Utf8View:
        return decoder.decode(variableBytes(index));
      case Type.Binary:
      case Type.LargeBinary:
      case Type.BinaryView:
        return toBase64(variableBytes(index));
      case Type.Date: {
        if (type.unit === DateUnit.DAY) return dateText(view.getInt32(index * 4, true));
        const millis = view.getBigInt64(index * 8, true);
        if (millis === BigInt(DATE_INFINITY) || millis === -BigInt(DATE_INFINITY)) return dateText(Number(millis));
        return dateText(Number(floorDiv(millis, 86_400_000n)));
      }
      case Type.Time: {
        const count =
          (type.bitWidth ?? 64) === 32 ? BigInt(view.getInt32(index * 4, true)) : view.getBigInt64(index * 8, true);
        const micros = floorDiv(count * 1_000_000n, perSecond(type.unit));
        return timeText(micros);
      }
      case Type.Timestamp: {
        const count = view.getBigInt64(index * 8, true);
        if (logical.type === "timestamptz") {
          const infinite = count === TIMESTAMP_INFINITY || count === -TIMESTAMP_INFINITY;
          return timestamptzText(infinite ? count : floorDiv(count * 1_000_000n, perSecond(type.unit)));
        }
        return timestampText(count, UNIT_NAMES[type.unit ?? 2]);
      }
      case Type.Interval: {
        if (type.unit === IntervalUnit.YEAR_MONTH)
          return intervalText({ months: view.getInt32(index * 4, true), days: 0, nanos: 0n });
        if (type.unit === IntervalUnit.DAY_TIME) {
          return intervalText({
            months: 0,
            days: view.getInt32(index * 8, true),
            nanos: BigInt(view.getInt32(index * 8 + 4, true)) * 1_000_000n,
          });
        }
        return intervalText({
          months: view.getInt32(index * 16, true),
          days: view.getInt32(index * 16 + 4, true),
          nanos: view.getBigInt64(index * 16 + 8, true),
        });
      }
      case Type.FixedSizeBinary: {
        const stride = type.stride ?? 0;
        const bytes = raw.subarray(index * stride, (index + 1) * stride);
        return logical.type === "uuid" ? uuidText(bytes) : toBase64(bytes);
      }
    }
    throw new TypeError(`A block has no reader for the Arrow type ${type.typeId}.`);
  };
  return (index) => (valid(index) ? value(index) : null);
}

/**
 * Reads top-level schema field names from an Arrow IPC stream or file with `ignoreBOM: true`, because
 * Flechette's FlatBuffer string reader uses `new TextDecoder()` without `ignoreBOM` and strips leading U+FEFF.
 */
export function schemaFieldNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos =
    bytes.byteLength >= 8 &&
    bytes[0] === 0x41 &&
    bytes[1] === 0x52 &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x4f &&
    bytes[4] === 0x57 &&
    bytes[5] === 0x31
      ? 8
      : 0;
  if (pos + 8 > bytes.byteLength) return null;
  let metaLength = view.getInt32(pos, true);
  pos += 4;
  if (metaLength === -1) {
    if (pos + 4 > bytes.byteLength) return null;
    metaLength = view.getInt32(pos, true);
    pos += 4;
  }
  if (metaLength <= 0 || pos + metaLength > bytes.byteLength) return null;
  const fieldOffset = (table: number, slot: number) => {
    const vtable = table - view.getInt32(table, true);
    const vtableLength = view.getUint16(vtable, true);
    const offset = 4 + slot * 2;
    if (offset >= vtableLength) return 0;
    const relative = view.getUint16(vtable + offset, true);
    return relative === 0 ? 0 : table + relative;
  };
  const message = pos + view.getInt32(pos, true);
  const headerType = fieldOffset(message, 1);
  if (headerType === 0 || view.getUint8(headerType) !== 1) return null;
  const headerRef = fieldOffset(message, 2);
  if (headerRef === 0) return null;
  const schema = headerRef + view.getInt32(headerRef, true);
  const fieldsRef = fieldOffset(schema, 1);
  if (fieldsRef === 0) return [];
  const vector = fieldsRef + view.getInt32(fieldsRef, true);
  const count = view.getInt32(vector, true);
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    const element = vector + 4 + index * 4;
    const item = element + view.getInt32(element, true);
    const nameRef = fieldOffset(item, 0);
    if (nameRef === 0) {
      names.push("");
      continue;
    }
    const str = nameRef + view.getInt32(nameRef, true);
    const length = view.getInt32(str, true);
    names.push(decoder.decode(bytes.subarray(str + 4, str + 4 + length)));
  }
  return names;
}

/**
 * Reads a block (§8.4): its columns, with the logical types of their Arrow types, and its rows as typed JSON
 * (§2.2).
 */
export function decodeBlock(bytes: Uint8Array): { columns: Column[]; rows: JsonValue[][] } {
  // Buffers of 64-bit values are read through typed arrays, which need aligned bytes.
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  const table = tableFromIPC(aligned);
  const fields = table.schema.fields as unknown as ArrowField[];
  const names = schemaFieldNames(aligned);
  const columns: Column[] = fields.map((arrow, index) => ({
    name: names?.[index] ?? arrow.name,
    ...logicalType(arrow),
  }));
  if (fields.length === 0) return { columns, rows: [] };
  const firstBatches = table.children[0].data as unknown as RawBatch[];
  let rowCount = 0;
  for (const batch of firstBatches) rowCount += batch.length;
  const colCount = fields.length;
  const rows: JsonValue[][] = Array.from({ length: rowCount }, () => new Array<JsonValue>(colCount));
  for (let col = 0; col < colCount; col++) {
    const arrow = fields[col];
    const column = columns[col];
    const batches = table.children[col].data as unknown as RawBatch[];
    let row = 0;
    for (const batch of batches) {
      const read = batchReader(arrow, batch, column);
      for (let at = 0; at < batch.length; at++) rows[row++][col] = read(at);
    }
  }
  return { columns, rows };
}
