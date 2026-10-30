/**
 * Columns of Arrow tables (docs/spec.md §2.3): their values by row as typed JSON, read when they are asked for,
 * and the numbers that hold the values of fixed width. A module of its own, `vastgrid-spec/columns`, which the
 * package's main module does not export, so that bundles that read only blocks do not load it.
 */
import { DateUnit, Precision, Type, tableFromIPC } from "@uwdata/flechette";
import {
  type ArrowField,
  batchReader,
  bytesOf,
  decimalJson,
  integerJson,
  logicalType,
  type RawBatch,
  UNIT_NAMES,
} from "./block.js";
import { dateText, timestampText, timestamptzText, timeText, UNIT_PER_SECOND } from "./calendar.js";
import type { Column, JsonValue, ValueType } from "./types.js";
import { floatJson } from "./values.js";

/** The numbers that hold the values of a column of fixed width (`ColumnValues.numbers`). */
export type ColumnNumbers = Int32Array | Float32Array | Float64Array | BigInt64Array;

/**
 * The values of a column of an Arrow table by row: typed JSON (§2.2), and for types of fixed width the numbers
 * that hold them, which a reader can sort or sum without making JSON.
 */
export interface ColumnValues {
  readonly length: number;
  /** The value at a row as typed JSON (§2.2). Throws a TypeError for a string that is not UTF-8. */
  at(row: number): JsonValue;
  /**
   * The values by row as numbers: integers as an Int32Array, dates as an Int32Array of days since 1970-01-01,
   * floats as a Float32Array or a Float64Array, and as a BigInt64Array bigints, decimals of up to 18 digits
   * (unscaled), times (microseconds), timestamps (in their unit) and timestamptz (microseconds). Null for the
   * other types. A row that is null holds a number that means nothing.
   */
  readonly numbers: ColumnNumbers | null;
  /** Whether each row holds a value, a bit per row as Arrow writes them; null when every row does. */
  readonly validity: Uint8Array | null;
}

/** The validity bits of a column of batches, made one when there are several; null when no value is null. */
function validityOf(batches: readonly RawBatch[], length: number): Uint8Array | null {
  const bitsOf = (batch: RawBatch) =>
    batch.nullCount === 0 || !batch.validity || batch.validity.length === 0 ? null : batch.validity;
  if (batches.every((batch) => bitsOf(batch) === null)) return null;
  if (batches.length === 1) return bitsOf(batches[0]);
  const validity = new Uint8Array((length + 7) >> 3);
  let row = 0;
  for (const batch of batches) {
    const bits = bitsOf(batch);
    for (let index = 0; index < batch.length; index++, row++) {
      if (!bits || ((bits[index >> 3] >> (index & 7)) & 1) === 1) validity[row >> 3] |= 1 << (row & 7);
    }
  }
  return validity;
}

/**
 * The numbers of a column of fixed width (`ColumnValues.numbers`): a view of the batch's values when they are
 * already those numbers, otherwise a copy. Null for other types, and for decimals whose values do not fit 64 bits.
 */
function numbersOf(arrow: ArrowField, batches: readonly RawBatch[], logical: ValueType, length: number) {
  const type = arrow.type;
  const perSecond = BigInt(UNIT_PER_SECOND[UNIT_NAMES[type.unit ?? 2]]);
  const width = (type.bitWidth ?? 0) / 8;
  type Read = (view: DataView, index: number) => number | bigint;
  let make: (length: number) => ColumnNumbers;
  let read: Read;
  let same: (values: ArrayBufferView | undefined) => boolean = () => false;
  switch (logical.type) {
    case "integer":
      if (type.typeId !== Type.Int) return null;
      make = (count) => new Int32Array(count);
      same = (values) => values instanceof Int32Array;
      read =
        width === 1
          ? type.signed === false
            ? (view, index) => view.getUint8(index)
            : (view, index) => view.getInt8(index)
          : width === 2
            ? type.signed === false
              ? (view, index) => view.getUint16(index * 2, true)
              : (view, index) => view.getInt16(index * 2, true)
            : (view, index) => view.getInt32(index * 4, true);
      break;
    case "bigint":
      if (type.typeId !== Type.Int) return null;
      make = (count) => new BigInt64Array(count);
      same = (values) => values instanceof BigInt64Array;
      read =
        width === 4
          ? (view, index) => BigInt(view.getUint32(index * 4, true))
          : (view, index) => view.getBigInt64(index * 8, true);
      break;
    case "decimal": {
      if (type.typeId !== Type.Decimal || (logical.precision ?? 38) > 18) return null;
      make = (count) => new BigInt64Array(count);
      same = (values) => width === 8 && values instanceof BigInt64Array;
      if (width === 4) read = (view, index) => BigInt(view.getInt32(index * 4, true));
      else if (width === 8) read = (view, index) => view.getBigInt64(index * 8, true);
      else {
        // The value is in the lowest 64 bits when the higher words only extend its sign; otherwise it is too large.
        read = (view, index) => {
          const low = view.getBigInt64(index * width, true);
          const sign = low < 0n ? -1n : 0n;
          for (let word = 8; word < width; word += 8) {
            if (view.getBigInt64(index * width + word, true) !== sign) throw new RangeError();
          }
          return low;
        };
      }
      break;
    }
    case "float":
      if (type.typeId !== Type.Float) return null;
      if (type.precision === Precision.SINGLE) {
        make = (count) => new Float32Array(count);
        same = (values) => values instanceof Float32Array;
        read = (view, index) => view.getFloat32(index * 4, true);
      } else {
        make = (count) => new Float64Array(count);
        same = (values) => values instanceof Float64Array;
        read = (view, index) => view.getFloat64(index * 8, true);
      }
      break;
    case "date":
      if (type.typeId !== Type.Date) return null;
      make = (count) => new Int32Array(count);
      if (type.unit === DateUnit.DAY) {
        same = (values) => values instanceof Int32Array;
        read = (view, index) => view.getInt32(index * 4, true);
      } else read = (view, index) => Number(view.getBigInt64(index * 8, true) / 86_400_000n);
      break;
    case "time": {
      if (type.typeId !== Type.Time) return null;
      make = (count) => new BigInt64Array(count);
      same = (values) => perSecond === 1_000_000n && width === 8 && values instanceof BigInt64Array;
      const count: Read =
        width === 4
          ? (view, index) => BigInt(view.getInt32(index * 4, true))
          : (view, index) => view.getBigInt64(index * 8, true);
      read = (view, index) => ((count(view, index) as bigint) * 1_000_000n) / perSecond;
      break;
    }
    case "timestamp":
    case "timestamptz":
      if (type.typeId !== Type.Timestamp) return null;
      make = (count) => new BigInt64Array(count);
      // Timestamps keep their unit; timestamptz values are microseconds (§2.1).
      if (logical.type === "timestamp" || perSecond === 1_000_000n) {
        same = (values) => values instanceof BigInt64Array;
        read = (view, index) => view.getBigInt64(index * 8, true);
      } else read = (view, index) => (view.getBigInt64(index * 8, true) * 1_000_000n) / perSecond;
      break;
    default:
      return null;
  }
  if (batches.length === 1 && same(batches[0].values)) return batches[0].values as ColumnNumbers;
  const numbers = make(length);
  let row = 0;
  for (const batch of batches) {
    const raw = bytesOf(batch.values);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const valid = (index: number) =>
      batch.nullCount === 0 ||
      !batch.validity ||
      batch.validity.length === 0 ||
      ((batch.validity[index >> 3] >> (index & 7)) & 1) === 1;
    for (let index = 0; index < batch.length; index++, row++) {
      if (!valid(index)) continue;
      try {
        numbers[row] = read(view, index) as never;
      } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
      }
    }
  }
  return numbers;
}

/** The typed JSON (§2.2) of a value of a logical type from the number that holds it (`ColumnValues.numbers`). */
function numberJson(type: ValueType): (value: number | bigint) => JsonValue {
  switch (type.type) {
    case "integer":
      return (value) => value as number;
    case "float":
      return (value) => floatJson(value as number);
    case "date":
      return (value) => dateText(value as number);
    case "bigint":
      return (value) => integerJson(value as bigint);
    case "decimal": {
      const scale = type.scale ?? 0;
      return (value) => decimalJson(value as bigint, scale);
    }
    case "time":
      return (value) => timeText(value as bigint);
    case "timestamp": {
      const unit = type.unit ?? "us";
      return (value) => timestampText(value as bigint, unit);
    }
    default:
      return (value) => timestamptzText(value as bigint);
  }
}

/** The values of a column of batches (`ColumnValues`). */
function columnValues(arrow: ArrowField, batches: readonly RawBatch[], logical: ValueType): ColumnValues {
  const starts: number[] = [];
  let length = 0;
  for (const batch of batches) {
    starts.push(length);
    length += batch.length;
  }
  const validity = validityOf(batches, length);
  const numbers = numbersOf(arrow, batches, logical, length);
  if (numbers) {
    const json = numberJson(logical);
    return {
      length,
      numbers,
      validity,
      at: validity
        ? (row) => (((validity[row >> 3] >> (row & 7)) & 1) === 1 ? json(numbers[row]) : null)
        : (row) => json(numbers[row]),
    };
  }
  const readers = batches.map((batch) => batchReader(arrow, batch, logical));
  return {
    length,
    numbers,
    validity,
    at(row) {
      // The batch that holds the row: the last that starts at or before it.
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (starts[middle] <= row) low = middle;
        else high = middle - 1;
      }
      return readers[low](row - starts[low]);
    },
  };
}

/**
 * Reads the columns of an Arrow IPC stream or file (§2.3, §8.4) of any number of record batches: their logical
 * types, and their values by row, read when they are asked for. The numbers of a column of one batch are views
 * of the bytes, which must not change afterwards; those of several batches are copied into one array. Throws a
 * TypeError for bytes that are not Arrow, and for Arrow types that have no logical type.
 */
export function decodeColumns(bytes: Uint8Array): { columns: Column[]; length: number; values: ColumnValues[] } {
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  const table = tableFromIPC(aligned);
  const fields = table.schema.fields as unknown as ArrowField[];
  const columns: Column[] = fields.map((arrow) => ({ name: arrow.name, ...logicalType(arrow) }));
  const values = fields.map((arrow, index) =>
    columnValues(arrow, table.children[index].data as unknown as RawBatch[], columns[index]),
  );
  return { columns, length: table.numRows, values };
}
