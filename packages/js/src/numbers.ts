/**
 * The numbers that hold the values of typed columns (`Vector.numbers`): of tables given as Arrow or as text files,
 * read by the modules of those tables and loaded with them.
 */
import { type Column, daysFromCivil, UNIT_PER_SECOND } from "vastgrid-spec";
import type { ColumnNumbers } from "vastgrid-spec/columns";
import { HIGH, int32Word, LOW, type NumberWriter, SIGN, TWO_32, writeFloat, writeInt64 } from "./order.js";

/** The first and the last day of the years 0001 to 9999, which dates and timestamps are written for (§2.2). */
const FIRST_DAY = daysFromCivil(1, 1, 1);
const LAST_DAY = daysFromCivil(9999, 12, 31);
const DAY_SECONDS = 86_400n;

/**
 * The first row of a column's numbers (`Vector.numbers`) whose value is not a value of the column's type
 * (§2.2), as `valueChecker` would find it in the value's JSON, or −1 when every value is: integers, bigints and
 * floats always are; dates and timestamps are within the years 0001 to 9999, times within a day, and decimals
 * of no more digits than their precision.
 */
export function firstInvalid(column: Column, numbers: ColumnNumbers, validity: Uint8Array | null): number {
  const length = numbers.length;
  const valid = (row: number) => validity === null || ((validity[row >> 3] >> (row & 7)) & 1) === 1;
  let low: bigint;
  let high: bigint;
  switch (column.type) {
    case "date": {
      const days = numbers as Int32Array;
      for (let row = 0; row < length; row++) {
        if ((days[row] < FIRST_DAY || days[row] > LAST_DAY) && valid(row)) return row;
      }
      return -1;
    }
    case "decimal":
      high = 10n ** BigInt(column.precision ?? 38) - 1n;
      low = -high;
      break;
    case "time":
      low = 0n;
      high = DAY_SECONDS * 1_000_000n - 1n;
      break;
    case "timestamp":
    case "timestamptz": {
      const perSecond = UNIT_PER_SECOND[column.type === "timestamp" ? (column.unit ?? "us") : "us"];
      low = BigInt(FIRST_DAY) * DAY_SECONDS * perSecond;
      high = (BigInt(LAST_DAY) + 1n) * DAY_SECONDS * perSecond - 1n;
      break;
    }
    default:
      return -1;
  }
  const counts = numbers as BigInt64Array;
  for (let row = 0; row < length; row++) {
    const count = counts[row];
    if ((count < low || count > high) && valid(row)) return row;
  }
  return -1;
}

/**
 * How the numbers that hold a column's values (`Vector.numbers`) become the words that `codecOf` writes for the
 * same values as JSON, without making the JSON; null for a column whose numbers are not written this way.
 */
export function numberWriter(column: Column, numbers: ColumnNumbers): NumberWriter | null {
  switch (column.type) {
    case "integer":
    case "date": {
      const integers = numbers as Int32Array;
      return (row, words, at) => {
        words[0][at] = int32Word(integers[row]);
      };
    }
    case "float": {
      const floats = numbers as Float32Array | Float64Array;
      return (row, words, at) => writeFloat(floats[row], words[0], words[1], at);
    }
    case "bigint":
    case "decimal":
    case "time": {
      // Signed 64-bit integers (decimals of up to 18 digits, unscaled; times in microseconds), read as halves.
      const halves = new Uint32Array(numbers.buffer, numbers.byteOffset, numbers.length * 2);
      return (row, words, at) => {
        words[0][at] = (halves[row * 2 + HIGH] ^ SIGN) >>> 0;
        words[1][at] = halves[row * 2 + LOW];
      };
    }
    case "timestamp":
    case "timestamptz": {
      // Seconds since 1970-01-01 and the nanoseconds of the second, as codecOf writes them, from counts of the
      // unit: in numbers while the counts are safe integers, and in BigInt beyond.
      const counts = numbers as BigInt64Array;
      const halves = new Uint32Array(numbers.buffer, numbers.byteOffset, numbers.length * 2);
      const big = UNIT_PER_SECOND[column.type === "timestamp" ? (column.unit ?? "us") : "us"];
      const perSecond = Number(big);
      const nanos = 1_000_000_000 / perSecond;
      return (row, words, at) => {
        const high = halves[row * 2 + HIGH] | 0;
        let seconds: number;
        let rest: number;
        if (high >= -0x20_0000 && high < 0x20_0000) {
          const count = high * TWO_32 + halves[row * 2 + LOW];
          seconds = Math.floor(count / perSecond);
          rest = count - seconds * perSecond;
          if (rest < 0) {
            seconds--;
            rest += perSecond;
          } else if (rest >= perSecond) {
            seconds++;
            rest -= perSecond;
          }
        } else {
          const count = counts[row];
          let whole = count / big;
          let part = count % big;
          if (part < 0n) {
            whole--;
            part += big;
          }
          seconds = Number(whole);
          rest = Number(part);
        }
        writeInt64(seconds, words[0], words[1], at);
        words[2][at] = rest * nanos;
      };
    }
    default:
      return null;
  }
}
