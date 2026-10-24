/**
 * Rules of values (docs/v2-spec.md §2): how JSON writes them, their text form, and literals.
 */
import type { JsonValue, TimestampUnit, ValueType } from "./types.js";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

const integerText = /^-?(0|[1-9][0-9]*)$/;
const decimalText = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const dateText = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
// Fractions have no trailing zeros (§2.2).
const timeText = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*[1-9]))?$/;
const uuidText = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const base64Text = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Unicode category Zs, which `trim` removes (§4.4).
const spaceSeparators = /^[\p{Zs}]+|[\p{Zs}]+$/gu;

/** Digits after the point that each unit of timestamps keeps. */
const unitDigits: Record<TimestampUnit, number> = { s: 0, ms: 3, us: 6, ns: 9 };

/** The string without its leading and trailing space separators (Unicode category Zs), as `trim` (§4.4). */
export function trimSpaces(text: string): string {
  return text.replace(spaceSeparators, "");
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isDay(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/** Whether the text is a date as §2.2 writes it: `YYYY-MM-DD`, naming a real day. */
export function isDateText(text: string): boolean {
  const match = dateText.exec(text);
  return match !== null && isDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Whether the text is a time as §2.2 writes it, with at most `digits` digits after the point. */
export function isTimeText(text: string, digits = 6): boolean {
  const match = timeText.exec(text);
  if (!match) return false;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return hour < 24 && minute < 60 && second < 60 && (match[4]?.length ?? 0) <= digits;
}

/** Whether the text is a timestamp as §2.2 writes it, for a unit. */
export function isTimestampText(text: string, unit: TimestampUnit = "us"): boolean {
  const space = text.indexOf(" ");
  return space === 10 && isDateText(text.slice(0, space)) && isTimeText(text.slice(space + 1), unitDigits[unit]);
}

/** The precision and scale of a decimal written as text (§2.5), or null when the text is not a decimal. */
export function decimalTextType(text: string): { precision: number; scale: number } | null {
  const match = decimalText.exec(text);
  if (!match) return null;
  const scale = match[2]?.length ?? 0;
  const integerDigits = match[1] === "0" ? 0 : match[1].length;
  const precision = Math.max(1, integerDigits + scale);
  return precision > 38 ? null : { precision, scale };
}

/** Whether a JSON value is a value of the type, written as §2.2 writes it. Null is a value of every type. */
export function isValueOf(value: JsonValue, type: ValueType): boolean {
  if (value === null) return true;
  switch (type.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
    case "bigint":
      if (typeof value === "number") return Number.isSafeInteger(value);
      return (
        typeof value === "string" && integerText.test(value) && BigInt(value) >= INT64_MIN && BigInt(value) <= INT64_MAX
      );
    case "decimal": {
      if (typeof value !== "string") return false;
      const found = decimalTextType(value);
      const scale = type.scale ?? 0;
      return found !== null && found.scale === scale && found.precision - found.scale <= (type.precision ?? 38) - scale;
    }
    case "float":
      return typeof value === "number"
        ? Number.isFinite(value)
        : value === "NaN" || value === "Infinity" || value === "-Infinity";
    case "string":
    case "interval":
      return typeof value === "string";
    case "date":
      return typeof value === "string" && isDateText(value);
    case "time":
      return typeof value === "string" && isTimeText(value);
    case "timestamp":
      return typeof value === "string" && isTimestampText(value, type.unit);
    case "timestamptz":
      return typeof value === "string" && value.endsWith("+00") && isTimestampText(value.slice(0, -3));
    case "uuid":
      return typeof value === "string" && uuidText.test(value);
    case "binary":
      return typeof value === "string" && base64Text.test(value);
  }
}

/** Whether two types are the same, members included. */
export function sameType(a: ValueType, b: ValueType): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "decimal":
      return a.precision === b.precision && a.scale === b.scale;
    case "float":
      return (a.bits ?? 64) === (b.bits ?? 64);
    case "timestamp":
      return (a.unit ?? "us") === (b.unit ?? "us");
    default:
      return true;
  }
}

/** A type as people read it: `decimal(10, 2)`, `float(32)`, `timestamp(ns)`. */
export function typeName(type: ValueType): string {
  switch (type.type) {
    case "decimal":
      return `decimal(${type.precision ?? 38}, ${type.scale ?? 0})`;
    case "float":
      return type.bits === 32 ? "float(32)" : "float";
    case "timestamp":
      return type.unit && type.unit !== "us" ? `timestamp(${type.unit})` : "timestamp";
    default:
      return type.type;
  }
}

/** The shortest digits and exponent of a float that read back as the same float of its bits (§2.4.1). */
function shortestDigits(value: number, bits: 32 | 64): { digits: string; exponent: number } {
  const magnitude = Math.abs(value);
  let text = magnitude.toExponential();
  if (bits === 32) {
    for (let digits = 1; digits <= 9; digits++) {
      const candidate = magnitude.toExponential(digits - 1);
      if (Math.fround(Number(candidate)) === magnitude) {
        text = candidate;
        break;
      }
    }
  }
  const [mantissa, exponent] = text.split("e");
  return { digits: mantissa.replace(".", "").replace(/0+$/, "") || "0", exponent: Number(exponent) };
}

/**
 * The text form of a float (§2.4.1): the shortest digits that read back as the same float of `bits`, in
 * fixed notation when the exponent is from −4 to 15 and in exponent notation otherwise, as Python's `repr`
 * and DuckDB's `CAST(x AS VARCHAR)` write it.
 */
export function floatText(value: number, bits: 32 | 64 = 64): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const number = bits === 32 ? Math.fround(value) : value;
  const sign = number < 0 ? "-" : "";
  const { digits, exponent } = shortestDigits(number, bits);
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    return `${sign}${whole}.${digits.slice(exponent + 1) || "0"}`;
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const power = String(Math.abs(exponent)).padStart(2, "0");
  return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${power}`;
}

/** The typed JSON of a value given its text form (§2.4), for example the values of a pivot's combination. */
export function valueOfText(text: string | null, type: ValueType): JsonValue {
  if (text === null) return null;
  switch (type.type) {
    case "boolean":
      return text === "true";
    case "integer":
      return Number(text);
    case "bigint":
      return Number.isSafeInteger(Number(text)) ? Number(text) : text;
    case "float":
      if (text === "nan") return "NaN";
      if (text === "inf") return "Infinity";
      if (text === "-inf") return "-Infinity";
      return Number(text);
    default:
      return text;
  }
}
