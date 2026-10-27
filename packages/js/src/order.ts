/**
 * The order of values and views (docs/v2-spec.md §3.1, §3.3).
 *
 * Each column's values are ranked once: its distinct values that are not blank are numbered from 0 in
 * ascending order, the empty string of a string column ranks `distinct` and null `distinct + 1`. A view is
 * sorted by the ranks of its sort keys, with one stable counting sort per key from the last key to the first,
 * starting from row ID order: blanks come last in both directions and tie with each other, ties go to the
 * next key, and rows equal for every key stay in row ID order.
 *
 * Values of fixed width are ranked through 32-bit words compared as unsigned integers, most significant
 * first, with a radix sort; strings and bytes are ranked with a comparison sort.
 */
import {
  type Column,
  daysFromCivil,
  floatOf,
  fromBase64,
  isValueOf,
  type JsonValue,
  normalizeInterval,
} from "vastgrid-spec";

/** The ranks of one column's values. */
export interface ColumnRanks {
  /** The rank of each row's value. */
  ranks: Uint32Array;
  /** The number of distinct values that are not blank; blanks rank from here. */
  distinct: number;
  /**
   * The rank of a value written as §2.2 writes the column's values, or −1 when no row holds a value equal to
   * it (§3.1). Exact numbers are equal whatever their scales, so the decimal `"1.5"` finds `"1.50"`.
   */
  rankOf(value: JsonValue): number;
}

/** The values of a column by row ID. */
type Values = readonly JsonValue[];

/** How the values of a column of fixed width become words. */
interface WordCodec {
  width: number;
  /** Writes the words of a value of the column, or of a value that `accept` gave, at a row of `words`. */
  write(value: JsonValue, words: readonly Uint32Array[], at: number): void;
  /** A value to look up in the column as `write` takes it, or null when no row can hold a value equal to it. */
  accept(value: JsonValue): JsonValue | null;
}

const TWO_32 = 4_294_967_296;
const MASK_32 = 0xffff_ffffn;
const SIGN = 0x8000_0000;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A signed 32-bit integer as a word whose unsigned order is the integer's order. */
function int32Word(value: number): number {
  return (value ^ SIGN) >>> 0;
}

/** Writes a safe integer as a signed 64-bit integer, in two words. */
function writeInt64(value: number, high: Uint32Array, low: Uint32Array, at: number) {
  const upper = Math.floor(value / TWO_32);
  high[at] = int32Word(upper);
  low[at] = value - upper * TWO_32;
}

/** Writes a signed 64-bit integer in two words. */
function writeBigInt64(value: bigint, high: Uint32Array, low: Uint32Array, at: number) {
  const bits = BigInt.asUintN(64, value);
  high[at] = int32Word(Number(bits >> 32n));
  low[at] = Number(bits & MASK_32);
}

/** Writes a signed 128-bit integer in four words. */
function writeBigInt128(value: bigint, words: readonly Uint32Array[], at: number) {
  const bits = BigInt.asUintN(128, value);
  words[0][at] = int32Word(Number(bits >> 96n));
  words[1][at] = Number((bits >> 64n) & MASK_32);
  words[2][at] = Number((bits >> 32n) & MASK_32);
  words[3][at] = Number(bits & MASK_32);
}

const floatBits = new Float64Array(1);
const floatWords = new Uint32Array(floatBits.buffer);
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const HIGH = littleEndian ? 1 : 0;
const LOW = littleEndian ? 0 : 1;

/**
 * Writes a float in two words: the bits of a positive number with the sign bit set, and those of a negative
 * number inverted, so that the words order as the numbers do. −0.0 is written as 0.0, and every NaN as the
 * greatest words, above Infinity (§3.1).
 */
function writeFloat(value: number, high: Uint32Array, low: Uint32Array, at: number) {
  if (Number.isNaN(value)) {
    high[at] = 0xffff_ffff;
    low[at] = 0xffff_ffff;
    return;
  }
  floatBits[0] = value === 0 ? 0 : value;
  const upper = floatWords[HIGH];
  const lower = floatWords[LOW];
  if (upper >= SIGN) {
    high[at] = ~upper >>> 0;
    low[at] = ~lower >>> 0;
  } else {
    high[at] = (upper | SIGN) >>> 0;
    low[at] = lower;
  }
}

/** The number of the decimal digits of `text` from `start`, `length` of them. */
function digitsAt(text: string, start: number, length: number): number {
  let number = 0;
  for (let index = start; index < start + length; index++) number = number * 10 + text.charCodeAt(index) - 48;
  return number;
}

/**
 * The fraction of a second whose point is at `start`, as a count of 10^−`places` seconds: 0 without a point.
 * The digits end at the end of the text or at its time zone.
 */
function fractionAt(text: string, start: number, places: number): number {
  if (text.charCodeAt(start) !== 46) return 0;
  let number = 0;
  let place = 0;
  for (let index = start + 1; place < places; index++, place++) {
    const digit = text.charCodeAt(index) - 48;
    if (!(digit >= 0 && digit <= 9)) break;
    number = number * 10 + digit;
  }
  for (; place < places; place++) number *= 10;
  return number;
}

/** Days since 1970-01-01 of `YYYY-MM-DD` at `start` (§2.2). */
function daysAt(text: string, start: number): number {
  return daysFromCivil(digitsAt(text, start, 4), digitsAt(text, start + 5, 2), digitsAt(text, start + 8, 2));
}

/** Seconds since midnight of `HH:MM:SS` at `start` (§2.2). */
function secondsAt(text: string, start: number): number {
  return digitsAt(text, start, 2) * 3600 + digitsAt(text, start + 3, 2) * 60 + digitsAt(text, start + 6, 2);
}

/**
 * The digits of a decimal's unscaled integer at a scale, with its sign: `"-12.5"` at scale 2 is `"-1250"`.
 * Null when the text is not a decimal, or has digits other than 0 beyond the scale.
 */
export function unscaledDigits(text: string, scale: number): string | null {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > scale && !/^0*$/.test(fraction.slice(scale))) return null;
  return `${match[1]}${match[2]}${fraction.slice(0, scale).padEnd(scale, "0")}`;
}

function codecOf(column: Column): WordCodec {
  const accept = (value: JsonValue) => (isValueOf(value, column) ? value : null);
  switch (column.type) {
    case "boolean":
      return {
        width: 1,
        write: (value, words, at) => {
          words[0][at] = value === true ? 1 : 0;
        },
        accept,
      };
    case "integer":
      return {
        width: 1,
        write: (value, words, at) => {
          words[0][at] = int32Word(value as number);
        },
        accept,
      };
    case "bigint":
      return {
        width: 2,
        write: (value, words, at) => {
          if (typeof value === "number") writeInt64(value, words[0], words[1], at);
          else writeBigInt64(BigInt(value as string), words[0], words[1], at);
        },
        accept,
      };
    case "decimal": {
      const scale = column.scale ?? 0;
      const precision = column.precision ?? 38;
      // Unscaled integers of up to 18 digits fit 64 bits; those of up to 15 digits are safe integers.
      const wide = precision > 18;
      return {
        width: wide ? 4 : 2,
        write: (value, words, at) => {
          const digits = (value as string).replace(".", "");
          if (wide) writeBigInt128(BigInt(digits), words, at);
          else if (digits.length <= 15) writeInt64(Number(digits), words[0], words[1], at);
          else writeBigInt64(BigInt(digits), words[0], words[1], at);
        },
        // A key is looked up by its unscaled digits at the column's scale.
        accept: (value) => {
          const digits = typeof value === "string" ? unscaledDigits(value, scale) : null;
          return digits !== null && digits.replace(/^-?0*/, "").length <= precision ? digits : null;
        },
      };
    }
    case "float": {
      // The values of 32-bit columns are the 32-bit floats that blocks carry (§8.4).
      const single = column.bits === 32;
      return {
        width: 2,
        write: (value, words, at) => {
          const number = floatOf(value);
          writeFloat(single ? Math.fround(number) : number, words[0], words[1], at);
        },
        accept,
      };
    }
    case "date":
      return {
        width: 1,
        write: (value, words, at) => {
          words[0][at] = int32Word(daysAt(value as string, 0));
        },
        accept,
      };
    case "time":
      return {
        width: 2,
        write: (value, words, at) => {
          const text = value as string;
          writeInt64(secondsAt(text, 0) * 1_000_000 + fractionAt(text, 8, 6), words[0], words[1], at);
        },
        accept,
      };
    case "timestamp":
    case "timestamptz":
      // Seconds since 1970-01-01 in two words, then the nanoseconds of the second, whatever the unit.
      return {
        width: 3,
        write: (value, words, at) => {
          const text = value as string;
          writeInt64(daysAt(text, 0) * 86_400 + secondsAt(text, 11), words[0], words[1], at);
          words[2][at] = fractionAt(text, 19, 9);
        },
        accept,
      };
    case "interval":
      // The months (64 bits), the days (−29 to 29) and the nanoseconds (64 bits) of normalizeInterval.
      return {
        width: 5,
        write: (value, words, at) => {
          const [months, days, nanos] = normalizeInterval(value as string) as [bigint, bigint, bigint];
          writeBigInt64(months, words[0], words[1], at);
          words[2][at] = int32Word(Number(days));
          writeBigInt64(nanos, words[3], words[4], at);
        },
        accept: (value) => {
          const parts = typeof value === "string" ? normalizeInterval(value) : null;
          return parts && parts[0] >= INT64_MIN && parts[0] <= INT64_MAX ? value : null;
        },
      };
    case "uuid":
      return {
        width: 4,
        write: (value, words, at) => {
          const hex = (value as string).replaceAll("-", "");
          for (let word = 0; word < 4; word++) {
            words[word][at] = Number.parseInt(hex.slice(word * 8, word * 8 + 8), 16);
          }
        },
        accept,
      };
    default:
      throw new TypeError(`${column.type} values are not written as words.`);
  }
}

/**
 * Sorts rows by their words, most significant first, compared as unsigned integers: a least significant digit
 * radix sort with 16-bit digits, which keeps the order of `rows` among rows with the same words.
 */
function radixSort(rows: Uint32Array, words: readonly Uint32Array[]): Uint32Array {
  const length = rows.length;
  let order = rows.slice();
  if (length < 2) return order;
  let spare = new Uint32Array(length);
  const counts = new Uint32Array(65_536);
  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index];
    for (let shift = 0; shift < 32; shift += 16) {
      counts.fill(0);
      for (let at = 0; at < length; at++) counts[(word[order[at]] >>> shift) & 0xffff]++;
      // A digit that every row shares changes nothing.
      if (counts[(word[order[0]] >>> shift) & 0xffff] === length) continue;
      let total = 0;
      for (let digit = 0; digit < 65_536; digit++) {
        const count = counts[digit];
        counts[digit] = total;
        total += count;
      }
      for (let at = 0; at < length; at++) {
        const row = order[at];
        spare[counts[(word[row] >>> shift) & 0xffff]++] = row;
      }
      [order, spare] = [spare, order];
    }
  }
  return order;
}

/** Ranks a column of fixed width through its words. */
function rankWords(column: Column, values: Values): ColumnRanks {
  const codec = codecOf(column);
  const count = values.length;
  const words = Array.from({ length: codec.width }, () => new Uint32Array(count));
  const filled = new Uint32Array(count);
  let present = 0;
  for (let row = 0; row < count; row++) {
    const value = values[row];
    if (value === null) continue;
    codec.write(value, words, row);
    filled[present++] = row;
  }
  const order = radixSort(filled.subarray(0, present), words);
  const ranks = new Uint32Array(count);
  // The words of each distinct value, in ascending order, for rankOf.
  const distinctWords = words.map(() => new Uint32Array(present));
  let distinct = 0;
  for (let at = 0; at < present; at++) {
    const row = order[at];
    const previous = at > 0 ? order[at - 1] : -1;
    if (previous < 0 || words.some((word) => word[row] !== word[previous])) {
      for (let which = 0; which < words.length; which++) distinctWords[which][distinct] = words[which][row];
      distinct++;
    }
    ranks[row] = distinct - 1;
  }
  for (let row = 0; row < count; row++) if (values[row] === null) ranks[row] = distinct + 1;
  const key = words.map(() => new Uint32Array(1));
  return {
    ranks,
    distinct,
    rankOf(value) {
      const accepted = value === null ? null : codec.accept(value);
      if (accepted === null) return -1;
      codec.write(accepted, key, 0);
      let low = 0;
      let high = distinct - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        let difference = 0;
        for (let which = 0; which < key.length && difference === 0; which++) {
          difference = distinctWords[which][middle] - key[which][0];
        }
        if (difference === 0) return middle;
        if (difference < 0) low = middle + 1;
        else high = middle - 1;
      }
      return -1;
    },
  };
}

const SURROGATE = /[\uD800-\uDFFF]/;
const HIGH_UNITS = /[\uD800-￿]/g;

/**
 * The string with its UTF-16 units from U+D800 moved so that comparing units compares code points (§3.1):
 * units from U+E000 go down by 0x800 and surrogates up by 0x2000, after every other unit. For Unicode text
 * (surrogates in pairs), the first unit that differs then decides as the code points do.
 */
function codePointKey(text: string): string {
  return text.replace(HIGH_UNITS, (unit) => {
    const code = unit.charCodeAt(0);
    return String.fromCharCode(code >= 0xe000 ? code - 0x800 : code + 0x2000);
  });
}

/** Bytes as a string of one unit per byte, which compares as the bytes do. */
function byteString(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return text;
}

/** Ranks a column of strings by their code points, or of binary values by their bytes. */
function rankTexts(column: Column, values: Values): ColumnRanks {
  const strings = column.type === "string";
  const count = values.length;
  const keys: string[] = new Array(count);
  const filled = new Uint32Array(count);
  let present = 0;
  let empty = false;
  let surrogates = false;
  for (let row = 0; row < count; row++) {
    const value = values[row];
    if (value === null) continue;
    if (strings && value === "") {
      empty = true;
      continue;
    }
    const text = value as string;
    if (strings && !surrogates) surrogates = SURROGATE.test(text);
    keys[row] = strings ? text : byteString(fromBase64(text));
    filled[present++] = row;
  }
  // Without surrogates, comparing UTF-16 units already compares code points.
  if (surrogates) {
    for (let at = 0; at < present; at++) keys[filled[at]] = codePointKey(keys[filled[at]]);
  }
  const order = filled.subarray(0, present).sort((a, b) => {
    const x = keys[a];
    const y = keys[b];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const ranks = new Uint32Array(count);
  const distinctKeys: string[] = [];
  for (let at = 0; at < present; at++) {
    const key = keys[order[at]];
    if (at === 0 || key !== distinctKeys[distinctKeys.length - 1]) distinctKeys.push(key);
    ranks[order[at]] = distinctKeys.length - 1;
  }
  const distinct = distinctKeys.length;
  for (let row = 0; row < count; row++) {
    const value = values[row];
    if (value === null) ranks[row] = distinct + 1;
    else if (strings && value === "") ranks[row] = distinct;
  }
  return {
    ranks,
    distinct,
    rankOf(value) {
      if (typeof value !== "string" || !isValueOf(value, column)) return -1;
      if (strings && value === "") return empty ? distinct : -1;
      let key = strings ? value : byteString(fromBase64(value));
      if (surrogates) key = codePointKey(key);
      let low = 0;
      let high = distinct - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const other = distinctKeys[middle];
        if (other === key) return middle;
        if (other < key) low = middle + 1;
        else high = middle - 1;
      }
      return -1;
    },
  };
}

/**
 * Ranks the values of a column by row ID in the order of §3.1; blanks rank after the other values (§3.2).
 */
export function rankColumn(column: Column, values: Values): ColumnRanks {
  return column.type === "string" || column.type === "binary" ? rankTexts(column, values) : rankWords(column, values);
}

/** A sort key of a view: the ranks of its column and its direction. */
export interface RankedKey {
  ranks: ColumnRanks;
  descending: boolean;
}

/**
 * Sorts rows by one key, keeping the order of `order` (row ID order when null) among rows that are equal for
 * it: a counting sort whose buckets hold the values in the key's direction, then the blanks (§3.3).
 */
function sortByKey(order: Uint32Array | null, count: number, key: RankedKey): Uint32Array {
  const { ranks, distinct } = key.ranks;
  const last = distinct - 1;
  const descending = key.descending;
  const starts = new Uint32Array(distinct + 2);
  for (let at = 0; at < count; at++) {
    const rank = ranks[order ? order[at] : at];
    starts[(rank > last ? distinct : descending ? last - rank : rank) + 1]++;
  }
  for (let bucket = 1; bucket <= distinct + 1; bucket++) starts[bucket] += starts[bucket - 1];
  const sorted = new Uint32Array(count);
  for (let at = 0; at < count; at++) {
    const row = order ? order[at] : at;
    const rank = ranks[row];
    sorted[starts[rank > last ? distinct : descending ? last - rank : rank]++] = row;
  }
  return sorted;
}

/**
 * The row IDs of `count` rows in the order of the keys (§3.3): by the first key, ties by the next, and rows
 * equal for every key in row ID order. The rows are the row IDs from 0, or those of `rows` (in row ID order)
 * when it is given. Without keys, the rows as they are: null for the row IDs from 0.
 */
export function sortRows(
  count: number,
  keys: readonly RankedKey[],
  rows: Uint32Array | null = null,
): Uint32Array | null {
  let order = rows;
  const length = rows ? rows.length : count;
  for (let index = keys.length - 1; index >= 0; index--) order = sortByKey(order, length, keys[index]);
  return order;
}
