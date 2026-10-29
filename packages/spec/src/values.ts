/**
 * Rules of values (docs/spec.md §2): how JSON writes them, their text form, literals, and when two are the same
 * value (§3.1).
 */
import { parseIntervalText, parseTimestampText } from "./calendar.js";
import type { JsonValue, TimestampUnit, ValueType } from "./types.js";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

const integerText = /^-?(0|[1-9][0-9]*)$/;
const decimalText = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const uuidText = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const base64Text = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const surrogate = /[\uD800-\uDFFF]/;
const loneSurrogate = /\p{Cs}/u;
// Unicode category Zs, which `trim` removes (§4.4).
const spaceSeparators = /^[\p{Zs}]+|[\p{Zs}]+$/gu;

/** Digits after the point that each unit of timestamps keeps. */
const unitDigits: Record<TimestampUnit, number> = { s: 0, ms: 3, us: 6, ns: 9 };

/** Whether a value is a JSON object: not null and not an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a value is blank (§3.2): null, or an empty string of a string column. */
export function isBlank(value: JsonValue, type: ValueType): boolean {
  return value === null || (type.type === "string" && value === "");
}

/** The string without its leading and trailing space separators (Unicode category Zs), as `trim` (§4.4). */
export function trimSpaces(text: string): string {
  return text.replace(spaceSeparators, "");
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isDay(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= (month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]);
}

// Dates and times are read character by character: tables check millions of them, and a match of a regular
// expression would make arrays for each.

/** The number that the two digits at `at` write, or −1 when they are not two digits. */
function twoDigits(text: string, at: number): number {
  const tens = text.charCodeAt(at) - 48;
  const ones = text.charCodeAt(at + 1) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

/** Whether `text` from `at` to `end` is `YYYY-MM-DD`, naming a real day. */
function dateAt(text: string, at: number, end: number): boolean {
  if (end - at !== 10 || text.charCodeAt(at + 4) !== 45 || text.charCodeAt(at + 7) !== 45) return false;
  const century = twoDigits(text, at);
  const years = twoDigits(text, at + 2);
  if (century < 0 || years < 0 || (century === 0 && years === 0)) return false;
  return isDay(century * 100 + years, twoDigits(text, at + 5), twoDigits(text, at + 8));
}

/** Whether `text` from `at` to `end` is `HH:MM:SS`, then a point and at most `digits` digits not ending in 0. */
function timeAt(text: string, at: number, end: number, digits: number): boolean {
  const length = end - at;
  if (length < 8 || text.charCodeAt(at + 2) !== 58 || text.charCodeAt(at + 5) !== 58) return false;
  const hour = twoDigits(text, at);
  const minute = twoDigits(text, at + 3);
  const second = twoDigits(text, at + 6);
  if (hour < 0 || minute < 0 || second < 0 || hour >= 24 || minute >= 60 || second >= 60) return false;
  if (length === 8) return true;
  // Fractions have no trailing zeros (§2.2).
  if (text.charCodeAt(at + 8) !== 46 || length - 9 < 1 || length - 9 > digits) return false;
  for (let index = at + 9; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return text.charCodeAt(end - 1) !== 48;
}

/** Whether `text` up to `end` is a date, a space and a time with at most `digits` digits after the point. */
function timestampAt(text: string, end: number, digits: number): boolean {
  return text.charCodeAt(10) === 32 && dateAt(text, 0, 10) && timeAt(text, 11, end, digits);
}

/** Whether the text is a date as §2.2 writes it: `YYYY-MM-DD`, naming a real day. */
export function isDateText(text: string): boolean {
  return dateAt(text, 0, text.length);
}

/** Whether the text is a time as §2.2 writes it, with at most `digits` digits after the point. */
export function isTimeText(text: string, digits = 6): boolean {
  return timeAt(text, 0, text.length, digits);
}

/** Whether the text is a timestamp as §2.2 writes it, for a unit. */
export function isTimestampText(text: string, unit: TimestampUnit = "us"): boolean {
  return timestampAt(text, text.length, unitDigits[unit]) && (unit !== "ns" || parseTimestampText(text, unit) !== null);
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
        ? Number.isFinite(value) && (type.bits !== 32 || Math.fround(value) === value)
        : value === "NaN" || value === "Infinity" || value === "-Infinity";
    case "string":
      return typeof value === "string" && (!surrogate.test(value) || !loneSurrogate.test(value));
    case "interval":
      return typeof value === "string" && parseIntervalText(value) !== null;
    case "date":
      return typeof value === "string" && isDateText(value);
    case "time":
      return typeof value === "string" && isTimeText(value);
    case "timestamp":
      return typeof value === "string" && isTimestampText(value, type.unit);
    case "timestamptz":
      return typeof value === "string" && value.endsWith("+00") && timestampAt(value, value.length - 3, unitDigits.us);
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

/** Whether two values of a type are the same value (§3.1), whichever JSON writes them (§2.2). */
export function sameCellValue(a: JsonValue, b: JsonValue, type: ValueType): boolean {
  if (a === null || b === null) return a === b;
  switch (type.type) {
    case "integer":
    case "bigint":
      return BigInt(a as number | string) === BigInt(b as number | string);
    case "float": {
      const x = floatOf(a);
      const y = floatOf(b);
      return Number.isNaN(x) ? Number.isNaN(y) : x === y;
    }
    default:
      return a === b;
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

const float32 = new DataView(new ArrayBuffer(4));

/** The exact digits of a positive 32-bit float, and the power of ten of the last: a 24-bit mantissa × 2^shift. */
function exactDigits(magnitude: number): { digits: string; power: number } {
  float32.setFloat32(0, magnitude);
  const bits = float32.getUint32(0);
  const biased = bits >>> 23;
  const fraction = BigInt(bits & 0x7fffff);
  const mantissa = biased === 0 ? fraction : fraction | 0x800000n;
  const shift = (biased === 0 ? 1 : biased) - 150;
  if (shift >= 0) return { digits: (mantissa << BigInt(shift)).toString(), power: 0 };
  return { digits: (mantissa * 5n ** BigInt(-shift)).toString(), power: shift };
}

/**
 * Exact digits rounded to `count` digits, halves to even, as Python and DuckDB's `printf` round them; with `other`,
 * rounded the other way.
 */
function roundedDigits(
  exact: { digits: string; power: number },
  count: number,
  other = false,
): { digits: string; exponent: number } {
  const { digits, power } = exact;
  let head = BigInt(digits.slice(0, count));
  const rest = digits.slice(count);
  const half = /^50*$/.test(rest);
  const up = (rest > "5" && !half) || (half && head % 2n === 1n);
  if (up !== other) head += 1n;
  const text = head.toString();
  return { digits: text.replace(/0+$/, "") || "0", exponent: text.length - 1 + power + rest.length };
}

/**
 * The shortest digits and exponent of a float that read back as the same float of its bits (§2.4.1); of two
 * that are as short, the nearer, and of two as near, the even one.
 */
function shortestDigits(value: number, bits: 32 | 64): { digits: string; exponent: number } {
  const magnitude = Math.abs(value);
  if (bits === 32) {
    const exact = exactDigits(magnitude);
    for (let count = 1; count < exact.digits.length; count++) {
      // At a power of two the float below is nearer than the float above, so the nearer digits can read back as
      // the float below while the others read back as this one.
      for (const other of [false, true]) {
        const rounded = roundedDigits(exact, count, other);
        const read = Number(`${rounded.digits}e${rounded.exponent - rounded.digits.length + 1}`);
        if (Math.fround(read) === magnitude) return rounded;
      }
    }
    return roundedDigits(exact, exact.digits.length);
  }
  const [mantissa, exponent] = magnitude.toExponential().split("e");
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
      return type.bits === 32 ? Math.fround(Number(text)) : Number(text);
    default:
      return text;
  }
}

/** The number of a float written as JSON (§2.2): a number, or one of `NaN`, `Infinity` and `-Infinity`. */
export function floatOf(value: JsonValue): number {
  if (typeof value === "number") return value;
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  throw new TypeError(`${JSON.stringify(value)} is not a float.`);
}

/** The JSON of a float (§2.2). */
export function floatJson(value: number): JsonValue {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value;
}

/** Bytes as base64 (RFC 4648, with padding). */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(text);
}

/** The bytes of base64 text. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** DuckDB's text of bytes: printable ASCII as it is, and `\xHH` for a backslash and the other bytes. */
function bytesText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text +=
      byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return text;
}

/** The text form of a value (§2.4), or null for null. */
export function textOf(value: JsonValue, type: ValueType): string | null {
  if (value === null) return null;
  switch (type.type) {
    case "boolean":
      return value === true ? "true" : "false";
    case "float":
      return floatText(floatOf(value), type.bits ?? 64);
    case "binary":
      return bytesText(fromBase64(String(value)));
    default:
      return String(value);
  }
}
