/**
 * Evaluating expressions (docs/spec.md §3, §4.3, §4.4) for the rows of a table: a checked expression becomes a
 * function of a row ID that gives its value as typed JSON (§2.2) of the expression's type.
 *
 * Exact numbers are computed as integers scaled by their scale, with BigInt where a JavaScript number would not
 * be exact; floats as 64-bit numbers. Errors and numbers that are not finite give null (§3.6).
 */
import {
  type CallExpr,
  compareTemporalText,
  dateLength,
  dateText,
  type ExprType,
  FIRST_DAY,
  floatJson,
  floatOf,
  fromBase64,
  infinityOf,
  isDateText,
  isValueOf,
  type JsonValue,
  LAST_DAY,
  normalizeInterval,
  parseDateText,
  parseTimestampText,
  sameType,
  type TypedExpr,
  textOf,
  timestampText,
  trimSpaces,
  UNIT_PER_SECOND,
  type ValueType,
  yearOf,
} from "vastgrid-spec";

/** The value of an expression, or of a column, at a row ID. */
export type RowValue = (row: number) => JsonValue;

/** The values of a column of the rows by its name: a column of the table or a derived column before it. */
export type ColumnReader = (name: string) => RowValue;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const POWERS: bigint[] = [1n];
/** 10^n as a BigInt. */
function power10(n: number): bigint {
  while (POWERS.length <= n) POWERS.push(POWERS[POWERS.length - 1] * 10n);
  return POWERS[n];
}

function isExact(type: ValueType) {
  return type.type === "integer" || type.type === "bigint" || type.type === "decimal";
}

function scaleOf(type: ValueType): number {
  return type.type === "decimal" ? (type.scale ?? 0) : 0;
}

/** An exact number as its integer at the scale of its type: the decimal `"-0.10"` is −10. */
export function unscaled(value: JsonValue, type: ValueType): bigint {
  if (typeof value === "number") return BigInt(value);
  const text = value as string;
  return type.type === "decimal" && (type.scale ?? 0) > 0 ? BigInt(text.replace(".", "")) : BigInt(text);
}

/** The text of a decimal from its integer at a scale: −10 at scale 2 is `"-0.10"`. */
export function decimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  if (scale === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(scale + 1, "0");
  const point = padded.length - scale;
  return `${negative ? "-" : ""}${padded.slice(0, point)}.${padded.slice(point)}`;
}

/** The typed JSON of an exact number of a type from its integer at the type's scale; null when it does not fit. */
export function exactJson(value: bigint, type: ValueType): JsonValue {
  switch (type.type) {
    case "integer":
      return value >= INT32_MIN && value <= INT32_MAX ? Number(value) : null;
    case "bigint":
      if (value < INT64_MIN || value > INT64_MAX) return null;
      return value >= -9_007_199_254_740_991n && value <= 9_007_199_254_740_991n ? Number(value) : value.toString();
    default: {
      const limit = power10(type.precision ?? 38);
      return value > -limit && value < limit ? decimalText(value, type.scale ?? 0) : null;
    }
  }
}

/** A number as a 64-bit float; the exact side of a comparison is rounded to the nearest float (§3.1). */
export function toFloat(value: JsonValue, type: ValueType): number {
  if (typeof value === "number") return value;
  return type.type === "float" ? floatOf(value) : Number(value);
}

/** A float result: null when it is not finite (§3.6). */
function finite(value: number): JsonValue {
  return Number.isFinite(value) ? value : null;
}

/** `value / 10^digits` rounded half away from zero (§4.4). */
function roundHalfAway(value: bigint, digits: number): bigint {
  if (digits <= 0) return value;
  const divisor = power10(digits);
  const quotient = value / divisor;
  const rest = value % divisor;
  const twice = (rest < 0n ? -rest : rest) * 2n;
  return twice >= divisor ? quotient + (value < 0n ? -1n : 1n) : quotient;
}

/** `value / 10^digits` rounded down or up. */
function floorOrCeil(value: bigint, digits: number, up: boolean): bigint {
  const divisor = power10(digits);
  const quotient = value / divisor;
  const rest = value % divisor;
  if (rest === 0n) return quotient;
  if (up) return rest > 0n ? quotient + 1n : quotient;
  return rest < 0n ? quotient - 1n : quotient;
}

/** Compares two strings by their code points (§3.1), which for Unicode text is the order of their UTF-8 bytes. */
function compareText(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let at = 0; at < length; at++) {
    let x = a.charCodeAt(at);
    let y = b.charCodeAt(at);
    if (x === y) continue;
    // Units from U+E000 come before surrogates, which hold the code points from U+10000.
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let at = 0; at < length; at++) if (a[at] !== b[at]) return a[at] - b[at];
  return a.length - b.length;
}

function compareBigInts(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Floats by §3.1: NaN equals NaN and is greater than every other number, and −0.0 equals 0.0. */
function compareFloats(x: number, y: number): number {
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The text of a date or a timestamp as a timestamp, which compares by its text (§3.1). */
function asTimestampText(value: string, type: ValueType): string {
  return type.type === "date" && infinityOf(value) === 0 ? `${value} 00:00:00` : value;
}

/**
 * How two values that are not null of comparable types compare (§3.1): negative, 0 or positive. Times and UUIDs
 * compare by their text, whose fields have fixed widths, and dates and timestamps by their years, then the rest.
 */
export function comparer(a: ValueType, b: ValueType): (x: JsonValue, y: JsonValue) => number {
  if (isExact(a) && isExact(b)) {
    const sa = scaleOf(a);
    const sb = scaleOf(b);
    const scale = Math.max(sa, sb);
    const fa = power10(scale - sa);
    const fb = power10(scale - sb);
    return (x, y) => {
      if (typeof x === "number" && typeof y === "number" && sa === 0 && sb === 0) return x - y;
      return compareBigInts(unscaled(x, a) * fa, unscaled(y, b) * fb);
    };
  }
  if (a.type === "float" || b.type === "float") return (x, y) => compareFloats(toFloat(x, a), toFloat(y, b));
  switch (a.type) {
    case "boolean":
      return (x, y) => Number(x) - Number(y);
    case "string":
    case "time":
    case "uuid":
      return (x, y) => compareText(x as string, y as string);
    case "date":
    case "timestamp":
    case "timestamptz":
      if (a.type === b.type) return (x, y) => compareTemporalText(x as string, y as string);
      return (x, y) => compareTemporalText(asTimestampText(x as string, a), asTimestampText(y as string, b));
    case "binary":
      return (x, y) => compareBytes(fromBase64(x as string), fromBase64(y as string));
    case "interval":
      return (x, y) => {
        const p = normalizeInterval(x as string) as [bigint, bigint, bigint];
        const q = normalizeInterval(y as string) as [bigint, bigint, bigint];
        return compareBigInts(p[0], q[0]) || compareBigInts(p[1], q[1]) || compareBigInts(p[2], q[2]);
      };
    default:
      throw new TypeError(`${a.type} and ${b.type} values are not compared.`);
  }
}

/** A value of one type as a value of another that holds it: a common type of §4.4. */
function caster(from: ValueType, to: ValueType): (value: JsonValue) => JsonValue {
  if (sameType(from, to)) return (value) => value;
  if (to.type === "float") return (value) => (value === null ? null : floatJson(toFloat(value, from)));
  if (isExact(from) && isExact(to)) {
    const factor = power10(scaleOf(to) - scaleOf(from));
    return (value) => (value === null ? null : exactJson(unscaled(value, from) * factor, to));
  }
  if (to.type === "timestamp") {
    const unit = to.unit ?? "us";
    // Counted in the source's unit, which holds its values (a date at midnight in microseconds), then in the
    // result's.
    const source = from.type === "timestamp" ? (from.unit ?? "us") : "us";
    const [a, b] = [UNIT_PER_SECOND[source], UNIT_PER_SECOND[unit]];
    return (value) => {
      if (value === null) return null;
      // An infinity is the same in every unit.
      if (infinityOf(value as string) !== 0) return value;
      const count = parseTimestampText(asTimestampText(value as string, from), source) as bigint;
      const result = timestampText(b >= a ? count * (b / a) : floorDivide(count, a / b), unit);
      return isValueOf(result, to) ? result : null;
    };
  }
  return (value) => value;
}

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n ? quotient - 1n : quotient;
}

// Simple case mappings that DuckDB 2.0 (utf8proc) makes where JavaScript maps a code point to several (§3.4).
const LOWER_SPECIAL = new Map<number, string>([[0x130, "i"]]);
const UPPER_SPECIAL = new Map<number, string>([
  [0xdf, "ẞ"],
  [0x1fb3, "ᾼ"],
  [0x1fc3, "ῌ"],
  [0x1ff3, "ῼ"],
]);
for (let code = 0x1f80; code <= 0x1faf; code++) {
  // Greek letters with ypogegrammeni map to the same letters with prosgegrammeni, 8 code points on.
  if ((code & 0xf) < 8) UPPER_SPECIAL.set(code, String.fromCodePoint(code + 8));
  else UPPER_SPECIAL.set(code, String.fromCodePoint(code));
}
const ASCII = /^[\0-\x7f]*$/;
const lowerCache = new Map<string, string>();
const upperCache = new Map<string, string>();

/** The string with each code point mapped by itself to lower or upper case (§3.4). */
export function mapCase(text: string, upper: boolean): string {
  if (ASCII.test(text)) return upper ? text.toUpperCase() : text.toLowerCase();
  const cache = upper ? upperCache : lowerCache;
  const special = upper ? UPPER_SPECIAL : LOWER_SPECIAL;
  let result = "";
  for (const point of text) {
    let mapped = cache.get(point);
    if (mapped === undefined) {
      const code = point.codePointAt(0) as number;
      mapped = special.get(code);
      if (mapped === undefined) {
        const plain = upper ? point.toUpperCase() : point.toLowerCase();
        // A code point that JavaScript maps to several stays as it is, as in utf8proc's simple mappings.
        mapped = plain.length === point.length || [...plain].length === 1 ? plain : point;
      }
      if (cache.size < 4096) cache.set(point, mapped);
    }
    result += mapped;
  }
  return result;
}

/** The number of code points of a string. */
function codePoints(text: string): number {
  let count = text.length;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit < 0xdc00) count--;
  }
  return count;
}

/** The UTF-16 offset of the code point at `points` from the start (the length when there are fewer). */
function offsetOf(text: string, points: number): number {
  let at = 0;
  for (let point = 0; point < points && at < text.length; point++) {
    const unit = text.charCodeAt(at);
    at += unit >= 0xd800 && unit < 0xdc00 ? 2 : 1;
  }
  return at;
}

/** A whole number argument as a JavaScript number; bigints beyond 2^53 are far beyond every string. */
function whole(value: JsonValue): number {
  return typeof value === "number" ? value : Number(value);
}

const NUMBER = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const TIMESTAMP_TEXT = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?$/;

/** `to_timestamp` (§4.4): the fraction cut to microseconds, as DuckDB 2.0 casts it. */
function toTimestamp(text: string): JsonValue {
  const match = TIMESTAMP_TEXT.exec(text);
  if (!match) return null;
  const fraction = (match[4] ?? "").slice(0, 6).replace(/0+$/, "");
  const result = `${match[1]} ${match[2]}:${match[3] ?? "00"}${fraction ? `.${fraction}` : ""}`;
  return isValueOf(result, { type: "timestamp" }) ? result : null;
}

/** Days since 1970-01-01 of a date or of a timestamp's date. */
function daysOf(value: string): number {
  return parseDateText(value.slice(0, dateLength(value))) as number;
}

/** The type of an expression, which the checker has settled for every untyped null that has a place. */
function typeOf(type: ExprType): ValueType {
  return type.type === "null" ? { type: "string" } : (type as ValueType);
}

/**
 * Compiles a checked expression to a function of a row ID. `read` gives the values of the columns it names,
 * and of the table's own columns, which `search` reads.
 */
export function compile(expr: TypedExpr, read: ColumnReader): RowValue {
  switch (expr.kind) {
    case "column":
      return read(expr.name);
    case "literal": {
      const value = expr.value;
      return () => value;
    }
    case "search": {
      const needle = mapCase(expr.text, false);
      const columns = expr.columns.map((column) => ({ column, values: read(column.name) }));
      return (row) => {
        for (const { column, values } of columns) {
          const value = values(row);
          if (value === null) continue;
          const text = column.type === "string" ? (value as string) : (textOf(value, column) as string);
          if (mapCase(text, false).includes(needle)) return true;
        }
        return false;
      };
    }
    case "call":
      return call(expr, read);
  }
}

function call(expr: CallExpr, read: ColumnReader): RowValue {
  const args = expr.args.map((arg) => compile(arg, read));
  const types = expr.args.map((arg) => typeOf(arg.type));
  const type = expr.type;
  const [a, b, c] = args;
  switch (expr.fn) {
    case "and":
      return (row) => {
        let unknown = false;
        for (const arg of args) {
          const value = arg(row);
          if (value === false) return false;
          if (value === null) unknown = true;
        }
        return unknown ? null : true;
      };
    case "or":
      return (row) => {
        let unknown = false;
        for (const arg of args) {
          const value = arg(row);
          if (value === true) return true;
          if (value === null) unknown = true;
        }
        return unknown ? null : false;
      };
    case "not":
      return (row) => {
        const value = a(row);
        return value === null ? null : !value;
      };
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      const compare = comparer(types[0], types[1]);
      const test = {
        eq: (n: number) => n === 0,
        ne: (n: number) => n !== 0,
        lt: (n: number) => n < 0,
        le: (n: number) => n <= 0,
        gt: (n: number) => n > 0,
        ge: (n: number) => n >= 0,
      }[expr.fn];
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        return y === null ? null : test(compare(x, y));
      };
    }
    case "in": {
      const items = expr.args.slice(1).map((arg, index) => ({
        value: (arg as { value: JsonValue }).value,
        compare: comparer(types[0], types[index + 1]),
      }));
      // Strings are looked up in a set: in may have many literals.
      if (types[0].type === "string") {
        const set = new Set(items.map((item) => item.value));
        return (row) => {
          const value = a(row);
          return value === null ? null : set.has(value);
        };
      }
      return (row) => {
        const value = a(row);
        if (value === null) return null;
        return items.some((item) => item.compare(value, item.value) === 0);
      };
    }
    case "is_null":
      return (row) => a(row) === null;
    case "is_blank": {
      const strings = types[0].type === "string";
      return (row) => {
        const value = a(row);
        return value === null || (strings && value === "");
      };
    }
    case "if": {
      const [then, otherwise] = [caster(types[1], type), caster(types[2], type)];
      return (row) => (a(row) === true ? then(b(row)) : otherwise(c(row)));
    }
    case "coalesce": {
      const casts = types.map((from) => caster(from, type));
      return (row) => {
        for (let index = 0; index < args.length; index++) {
          const value = args[index](row);
          if (value !== null) return casts[index](value);
        }
        return null;
      };
    }
    case "least":
    case "greatest": {
      const casts = types.map((from) => caster(from, type));
      const compare = comparer(type, type);
      const greatest = expr.fn === "greatest";
      return (row) => {
        let best: JsonValue = null;
        for (let index = 0; index < args.length; index++) {
          const raw = args[index](row);
          if (raw === null) continue;
          const value = casts[index](raw);
          if (value === null) continue;
          if (best === null) best = value;
          else {
            const order = compare(value, best);
            if (greatest ? order > 0 : order < 0) best = value;
          }
        }
        return best;
      };
    }
    case "add":
    case "sub":
    case "mul":
    case "mod":
      return arithmetic(expr.fn, a, b, types[0], types[1], type);
    case "div":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null) return null;
        const p = toFloat(x, types[0]);
        const q = toFloat(y, types[1]);
        return Number.isFinite(p) && Number.isFinite(q) ? finite(p / q) : null;
      };
    case "neg":
    case "abs": {
      const negate = expr.fn === "neg";
      if (type.type === "float") {
        return (row) => {
          const x = a(row);
          if (x === null) return null;
          const number = toFloat(x, types[0]);
          return Number.isFinite(number) ? (negate ? -number : Math.abs(number)) : null;
        };
      }
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const value = unscaled(x, types[0]);
        return exactJson(negate || value < 0n ? -value : value, type);
      };
    }
    case "round": {
      const digits = expr.args.length === 2 ? ((expr.args[1] as { value: number }).value as number) : 0;
      if (type.type === "float") {
        const factor = 10 ** Math.abs(digits);
        return float1(a, types[0], (x) => {
          const magnitude = Math.abs(x);
          const rounded =
            digits >= 0 ? Math.round(magnitude * factor) / factor : Math.round(magnitude / factor) * factor;
          return x < 0 ? -rounded : rounded;
        });
      }
      const scale = scaleOf(types[0]);
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const value = unscaled(x, types[0]);
        if (digits >= scale) return exactJson(value, type);
        const rounded = roundHalfAway(value, scale - digits);
        return exactJson(digits < 0 ? rounded * power10(-digits) : rounded, type);
      };
    }
    case "floor":
    case "ceil": {
      const up = expr.fn === "ceil";
      if (type.type === "float") return float1(a, types[0], up ? Math.ceil : Math.floor);
      const scale = scaleOf(types[0]);
      if (scale === 0) return a;
      return (row) => {
        const x = a(row);
        return x === null ? null : exactJson(floorOrCeil(unscaled(x, types[0]), scale, up), type);
      };
    }
    case "bin": {
      // The greatest multiple of the width that is not above the number (§4.4).
      const width = (expr.args[1] as { value: number }).value;
      if (type.type === "float") return float1(a, types[0], (x) => Math.floor(x / width) * width);
      const [whole, fraction = ""] = String(width).split(".");
      const step = BigInt(whole + fraction.padEnd(scaleOf(types[0]), "0"));
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const value = unscaled(x, types[0]);
        const rest = value % step;
        return exactJson(value - (rest < 0n ? rest + step : rest), type);
      };
    }
    case "sqrt":
      return float1(a, types[0], Math.sqrt);
    case "exp":
      return float1(a, types[0], Math.exp);
    case "ln":
      return float1(a, types[0], Math.log);
    case "log10":
      return float1(a, types[0], Math.log10);
    case "power":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null) return null;
        const p = toFloat(x, types[0]);
        const q = toFloat(y, types[1]);
        return Number.isFinite(p) && Number.isFinite(q) ? finite(p ** q) : null;
      };
    case "sign":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const number = toFloat(x, types[0]);
        if (!Number.isFinite(number)) return null;
        return number > 0 ? 1 : number < 0 ? -1 : 0;
      };
    case "to_number":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const text = trimSpaces(x as string);
        return NUMBER.test(text) ? finite(Number(text)) : null;
      };
    case "concat":
      return (row) => {
        let result = "";
        for (let index = 0; index < args.length; index++) result += textOf(args[index](row), types[index]) ?? "";
        return result;
      };
    case "text":
      return (row) => textOf(a(row), types[0]);
    case "length":
      return string1(a, codePoints);
    case "lower":
      return string1(a, (text) => mapCase(text, false));
    case "upper":
      return string1(a, (text) => mapCase(text, true));
    case "trim":
      return string1(a, trimSpaces);
    case "left":
    case "right": {
      const left = expr.fn === "left";
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null) return null;
        const text = x as string;
        const count = Math.max(0, whole(y));
        if (left) return text.slice(0, offsetOf(text, count));
        const total = codePoints(text);
        return count >= total ? text : text.slice(offsetOf(text, total - count));
      };
    }
    case "substr":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null) return null;
        const text = x as string;
        const start = offsetOf(text, Math.max(1, whole(y)) - 1);
        if (!c) return text.slice(start);
        const z = c(row);
        if (z === null) return null;
        const rest = text.slice(start);
        return rest.slice(0, offsetOf(rest, Math.max(0, whole(z))));
      };
    case "replace":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null) return null;
        const z = c(row);
        if (z === null) return null;
        return y === "" ? x : (x as string).split(y as string).join(z as string);
      };
    case "contains":
    case "starts_with":
    case "ends_with": {
      const test =
        expr.fn === "contains"
          ? (x: string, y: string) => x.includes(y)
          : expr.fn === "starts_with"
            ? (x: string, y: string) => x.startsWith(y)
            : (x: string, y: string) => x.endsWith(y);
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        return y === null ? null : test(x as string, y as string);
      };
    }
    case "to_date":
      // `YYYY-MM-DD` only, as DuckDB's engine reads it (§4.4).
      return string1(a, (text) => (text.length === 10 && isDateText(text) ? text : null));
    case "to_timestamp":
      return string1(a, toTimestamp);
    case "year":
      return finite1(a, yearOf);
    case "month":
      return finite1(a, (text) => Number(text.slice(dateLength(text) - 5, dateLength(text) - 3)));
    case "day":
      return finite1(a, (text) => Number(text.slice(dateLength(text) - 2, dateLength(text))));
    case "isodow":
      return finite1(a, (text) => ((((daysOf(text) + 3) % 7) + 7) % 7) + 1);
    case "hour":
    case "minute":
    case "second": {
      const offset = { hour: 0, minute: 3, second: 6 }[expr.fn];
      if (types[0].type === "time") return string1(a, (text) => Number(text.slice(offset, offset + 2)));
      return finite1(a, (text) => {
        const at = dateLength(text) + 1 + offset;
        return Number(text.slice(at, at + 2));
      });
    }
    case "date_diff_days":
      return (row) => {
        const x = a(row);
        if (x === null) return null;
        const y = b(row);
        if (y === null || infinityOf(x as string) !== 0 || infinityOf(y as string) !== 0) return null;
        return daysOf(y as string) - daysOf(x as string);
      };
    case "add_days":
      return (row) => {
        const x = a(row);
        if (x === null || infinityOf(x as string) !== 0) return null;
        const y = b(row);
        if (y === null) return null;
        const count = whole(y);
        if (count < INT32_MIN || count > INT32_MAX) return null;
        const days = daysOf(x as string) + count;
        // The dates of §2.2; a timestamp keeps its time of day, and its unit's range.
        if (days < FIRST_DAY || days > LAST_DAY) return null;
        const result = dateText(days) + (x as string).slice(dateLength(x as string));
        return isValueOf(result, type) ? result : null;
      };
  }
}

/** A function of the text of a date, a time or a timestamp that gives null for null and for an infinity (§3.6). */
function finite1(a: RowValue, apply: (text: string) => JsonValue): RowValue {
  return string1(a, (text) => (infinityOf(text) === 0 ? apply(text) : null));
}

/** A function of one string that gives null for null. */
function string1(a: RowValue, apply: (text: string) => JsonValue): RowValue {
  return (row) => {
    const value = a(row);
    return value === null ? null : apply(value as string);
  };
}

/** A function of one number computed as a float: null for null, for numbers that are not finite and results. */
function float1(a: RowValue, type: ValueType, apply: (x: number) => number): RowValue {
  return (row) => {
    const value = a(row);
    if (value === null) return null;
    const number = toFloat(value, type);
    return Number.isFinite(number) ? finite(apply(number)) : null;
  };
}

/** `add`, `sub`, `mul` and `mod` (§3.7): exact for exact numbers, null when the result does not fit its type. */
function arithmetic(
  fn: "add" | "sub" | "mul" | "mod",
  a: RowValue,
  b: RowValue,
  ta: ValueType,
  tb: ValueType,
  type: ValueType,
): RowValue {
  if (type.type === "float") {
    const op = {
      add: (x: number, y: number) => x + y,
      sub: (x: number, y: number) => x - y,
      mul: (x: number, y: number) => x * y,
      mod: (x: number, y: number) => x % y,
    }[fn];
    return (row) => {
      const x = a(row);
      if (x === null) return null;
      const y = b(row);
      if (y === null) return null;
      const p = toFloat(x, ta);
      const q = toFloat(y, tb);
      return Number.isFinite(p) && Number.isFinite(q) ? finite(op(p, q)) : null;
    };
  }
  // Operands at the result's scale; mul's scale is the sum of theirs.
  const scale = scaleOf(type);
  const fa = fn === "mul" ? 1n : power10(scale - scaleOf(ta));
  const fb = fn === "mul" ? 1n : power10(scale - scaleOf(tb));
  const op = {
    add: (x: bigint, y: bigint) => x + y,
    sub: (x: bigint, y: bigint) => x - y,
    mul: (x: bigint, y: bigint) => x * y,
    mod: (x: bigint, y: bigint) => (y === 0n ? null : x % y),
  }[fn];
  const quick = {
    add: (x: number, y: number) => x + y,
    sub: (x: number, y: number) => x - y,
    mul: (x: number, y: number) => x * y,
    mod: (x: number, y: number) => (y === 0 ? Number.NaN : x % y),
  }[fn];
  const whole = type.type === "bigint";
  return (row) => {
    const x = a(row);
    if (x === null) return null;
    const y = b(row);
    if (y === null) return null;
    if (whole && typeof x === "number" && typeof y === "number") {
      const result = quick(x, y);
      // An integer has no −0, which JavaScript makes of 0 × −1.
      if (Number.isSafeInteger(result)) return result + 0;
      if (Number.isNaN(result)) return null;
    }
    const result = op(unscaled(x, ta) * fa, unscaled(y, tb) * fb);
    return result === null ? null : exactJson(result, type);
  };
}

/** The values of a derived column, or of a condition, for every row of a table. */
export function evaluate(expr: TypedExpr, read: ColumnReader, count: number): JsonValue[] {
  const value = compile(expr, read);
  const values: JsonValue[] = new Array(count);
  for (let row = 0; row < count; row++) values[row] = value(row);
  return values;
}

/** The row IDs, in order, for which a condition is true (§3.6). */
export function filter(expr: TypedExpr, read: ColumnReader, count: number): Uint32Array {
  const test = compile(expr, read);
  const kept = new Uint32Array(count);
  let length = 0;
  for (let row = 0; row < count; row++) if (test(row) === true) kept[length++] = row;
  return kept.slice(0, length);
}
