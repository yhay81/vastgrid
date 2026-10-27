/**
 * The summary of cells that `summarize` answers (docs/spec.md §8.2): the cells that are not blank, and the
 * sum, minimum, maximum and average of the finite numbers among them, as floats.
 *
 * Exact numbers (integers, bigints, decimals) are summed exactly and rounded once; floats are summed with
 * compensation (Neumaier), and also scaled down by 2^64 so that an average stays finite when the sum is
 * beyond the largest float.
 */
import { type Column, floatJson, floatOf, type JsonValue } from "vastgrid-spec";
import { decimalText } from "./evaluate.js";
import type { Vector } from "./table.js";

/** What `summarize` answers (§8.2). */
export interface SummaryResult {
  count: number;
  numericCount: number;
  sum: JsonValue;
  min: JsonValue;
  max: JsonValue;
  average: JsonValue;
}

const SCALE_DOWN = 2 ** -64;
const SCALE_UP = 2 ** 64;

/** A sum of floats with Neumaier's compensation. */
class FloatSum {
  private sum = 0;
  private compensation = 0;
  private overflow = false;

  add(value: number) {
    const total = this.sum + value;
    if (!Number.isFinite(total)) this.overflow = true;
    else if (Math.abs(this.sum) >= Math.abs(value)) this.compensation += this.sum - total + value;
    else this.compensation += value - total + this.sum;
    this.sum = total;
  }

  /** The sum, or null when it went beyond the largest float on the way. */
  value(): number | null {
    return this.overflow ? null : this.sum + this.compensation;
  }
}

/** A sum of exact numbers at one scale: safe integers while they stay safe, then a bigint. */
class ExactSum {
  private small = 0;
  private big = 0n;

  add(value: number) {
    if (Math.abs(this.small) + Math.abs(value) <= Number.MAX_SAFE_INTEGER) this.small += value;
    else {
      this.big += BigInt(this.small);
      this.small = value;
    }
  }

  addBig(value: bigint) {
    this.big += value;
  }

  total(): bigint {
    return this.big + BigInt(this.small);
  }
}

/** Counts and sums the values of cells (§8.2). */
export class Summary {
  private count = 0;
  private numericCount = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  /** Exact sums by scale. */
  private readonly exact = new Map<number, ExactSum>();
  private readonly floats = new FloatSum();
  private readonly scaled = new FloatSum();

  private exactAt(scale: number): ExactSum {
    let sum = this.exact.get(scale);
    if (!sum) {
      sum = new ExactSum();
      this.exact.set(scale, sum);
    }
    return sum;
  }

  private number(value: number) {
    this.numericCount++;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  /** Adds the values of one column, by row ID, at the rows of `rows` (row IDs). */
  add(column: Column, values: Vector, rows: Uint32Array) {
    switch (column.type) {
      case "string":
        // The empty string is blank (§3.2).
        for (const row of rows) {
          const value = values.at(row);
          if (value !== null && value !== "") this.count++;
        }
        return;
      case "integer":
      case "bigint": {
        const sum = this.exactAt(0);
        for (const row of rows) {
          const value = values.at(row);
          if (value === null) continue;
          this.count++;
          if (typeof value === "number") {
            sum.add(value);
            this.number(value);
          } else {
            sum.addBig(BigInt(value as string));
            this.number(Number(value));
          }
        }
        return;
      }
      case "decimal": {
        const scale = column.scale ?? 0;
        const sum = this.exactAt(scale);
        for (const row of rows) {
          const value = values.at(row);
          if (value === null) continue;
          this.count++;
          const digits = (value as string).replace(".", "");
          if (digits.length <= 15) sum.add(Number(digits));
          else sum.addBig(BigInt(digits));
          this.number(Number(value));
        }
        return;
      }
      case "float": {
        const single = column.bits === 32;
        for (const row of rows) {
          const value = values.at(row);
          if (value === null) continue;
          this.count++;
          const number = single ? Math.fround(floatOf(value)) : floatOf(value);
          // NaN and the infinities count as cells but not as numbers.
          if (!Number.isFinite(number)) continue;
          this.floats.add(number);
          this.scaled.add(number * SCALE_DOWN);
          this.number(number);
        }
        return;
      }
      default:
        for (const row of rows) if (values.at(row) !== null) this.count++;
    }
  }

  /** The summary (§8.2): floats as §2.2 writes them, a sum beyond the largest float as `"Infinity"`. */
  result(): SummaryResult {
    const { count, numericCount } = this;
    if (numericCount === 0) return { count, numericCount, sum: null, min: null, max: null, average: null };
    // The exact sums at the finest of their scales, rounded once.
    const scale = Math.max(...this.exact.keys(), 0);
    let unscaled = 0n;
    for (const [at, sum] of this.exact) unscaled += sum.total() * 10n ** BigInt(scale - at);
    const exact = Number(decimalText(unscaled, scale));
    const floats = this.floats.value();
    const scaled = this.scaled.value() ?? 0;
    const sum = exact + (floats ?? scaled * SCALE_UP);
    const average = Number.isFinite(sum)
      ? sum / numericCount
      : ((exact * SCALE_DOWN + scaled) / numericCount) * SCALE_UP;
    // −0.0 equals 0.0 (§3.1); the answer writes 0.
    return {
      count,
      numericCount,
      sum: floatJson(sum + 0),
      min: this.min + 0,
      max: this.max + 0,
      average: floatJson(average + 0),
    };
  }
}
