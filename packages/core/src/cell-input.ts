/**
 * Values typed into cells, checked against their column's type. Values keep their exact digits:
 * 64-bit integers and decimals stay strings, as they arrive from sources, and are never rounded. Dates
 * and times are ISO-like text. A source writes what `normalizeCellValue` returns, so that the grid and
 * the source accept the same values.
 */

import type { CellValue, ColumnSchema, ColumnType } from "./types.js";

/**
 * Why a typed value does not fit its column. `integer`: not a whole number; `range`: outside the
 * column's range; `number`: not a number; `decimal`: not a decimal number; `scale`: more fraction
 * digits than the column keeps; `precision`: more digits than the column keeps; `boolean`, `date`,
 * `time`, `timestamp`, `uuid`, `json`: not a value of that type; `type`: the column's type cannot be
 * written.
 */
export type CellInputError =
  | "integer"
  | "range"
  | "number"
  | "decimal"
  | "scale"
  | "precision"
  | "boolean"
  | "date"
  | "time"
  | "timestamp"
  | "uuid"
  | "json"
  | "type";

export type CellInputResult = { ok: true; value: CellValue } | { ok: false; error: CellInputError };

export interface CellInputOptions {
  /**
   * Accept numbers with their digits grouped by commas (`1,234.5`), as spreadsheets copy formatted
   * numbers. The commas must group three digits each.
   */
  grouping?: boolean;
}

const writable = new Set<ColumnType>([
  "integer",
  "bigint",
  "float",
  "decimal",
  "boolean",
  "string",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
  "json",
]);

/** Whether values of a type can be typed and written. Lists, structs, maps, binary values and intervals cannot. */
export function editableType(type: ColumnType) {
  return writable.has(type);
}

/** Whether the grid may write a column: its type can be written and the source does not mark it read-only. */
export function editableColumn(column: ColumnSchema) {
  return column.readOnly !== true && editableType(column.type);
}

function isNumericColumn(type: ColumnType) {
  return type === "integer" || type === "bigint" || type === "float" || type === "decimal";
}

/** Ranges of integer types by their engine name; others are checked as 64-bit (bigint) or exact JS integers. */
const integerRanges: Record<string, [bigint, bigint]> = {
  TINYINT: [-128n, 127n],
  SMALLINT: [-32768n, 32767n],
  INTEGER: [-2147483648n, 2147483647n],
  BIGINT: [-9223372036854775808n, 9223372036854775807n],
  HUGEINT: [-(2n ** 127n), 2n ** 127n - 1n],
  UTINYINT: [0n, 255n],
  USMALLINT: [0n, 65535n],
  UINTEGER: [0n, 4294967295n],
  UBIGINT: [0n, 18446744073709551615n],
  UHUGEINT: [0n, 2n ** 128n - 1n],
};

function integerRange(column: ColumnSchema): [bigint, bigint] | null {
  const name = column.sourceType?.toUpperCase().trim();
  if (name && integerRanges[name]) return integerRanges[name];
  if (name === "BIGNUM" || name === "VARINT") return null;
  return column.type === "integer"
    ? [BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)]
    : integerRanges.BIGINT;
}

/** Precision and scale of `DECIMAL(p,s)`, or null when the engine did not say. */
function decimalShape(column: ColumnSchema): { precision: number; scale: number } | null {
  const match = /^\s*(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*$/i.exec(column.sourceType ?? "");
  if (!match) return null;
  return { precision: Number(match[1]), scale: Number(match[2] ?? 0) };
}

function parseInteger(text: string, column: ColumnSchema): CellInputResult {
  const match = /^([+-]?)0*(\d+)$/.exec(text);
  if (!match) return { ok: false, error: /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) ? "integer" : "number" };
  const digits = match[2];
  const sign = match[1] === "-" && digits !== "0" ? "-" : "";
  const value = BigInt(`${sign}${digits}`);
  const range = integerRange(column);
  if (range && (value < range[0] || value > range[1])) return { ok: false, error: "range" };
  const number = Number(value);
  // Integers that a JS number holds exactly are numbers, as sources send them; the others stay text.
  return { ok: true, value: Number.isSafeInteger(number) ? number : value.toString() };
}

function parseFloatText(text: string): CellInputResult {
  if (/^[+-]?(inf|infinity)$/i.test(text)) return { ok: true, value: text.startsWith("-") ? "-Infinity" : "Infinity" };
  if (/^nan$/i.test(text)) return { ok: true, value: "NaN" };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return { ok: false, error: "number" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "range" };
  return { ok: true, value };
}

function parseDecimal(text: string, column: ColumnSchema): CellInputResult {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || !(match[2] || match[3])) {
    return { ok: false, error: /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(text) ? "decimal" : "number" };
  }
  const whole = match[2].replace(/^0+(?=\d)/, "") || "0";
  const fraction = match[3] ?? "";
  const shape = decimalShape(column);
  if (shape) {
    // Trailing zeros of the fraction do not count against the scale (1.50 fits DECIMAL(3,1)).
    if (fraction.replace(/0+$/, "").length > shape.scale) return { ok: false, error: "scale" };
    if (whole.replace(/^0+/, "").length > shape.precision - shape.scale) return { ok: false, error: "precision" };
  }
  const zero = /^0*$/.test(whole + fraction);
  const sign = match[1] === "-" && !zero ? "-" : "";
  // The digits as typed, without a plus sign or leading zeros; the source keeps its own scale.
  return { ok: true, value: `${sign}${whole}${fraction ? `.${fraction}` : ""}` };
}

function parseBoolean(text: string): CellInputResult {
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "1") return { ok: true, value: true };
  if (lower === "false" || lower === "0") return { ok: true, value: false };
  return { ok: false, error: "boolean" };
}

function pad(value: string | number, length: number) {
  return String(value).padStart(length, "0");
}

/** `yyyy-MM-dd` (also with `/` or `.` between the parts and without leading zeros), normalized. */
function dateText(text: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const days = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const leap = month === 2 && day === 29;
  if (leap ? !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) : day > days) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `HH:mm[:ss[.fraction]]`, normalized to `HH:mm:ss[.fraction]`. */
function timeText(text: string): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(text);
  if (!match) return null;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  // 24:00:00 is the end of a day, which SQL times accept.
  const end = hour === 24 && minute === 0 && second === 0 && !/[1-9]/.test(match[4] ?? "");
  if ((hour > 23 && !end) || minute > 59 || second > 59) return null;
  return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${match[4] ? `.${match[4]}` : ""}`;
}

const offsetPattern = /(Z|[+-]\d{2}(?::?\d{2})?)$/i;

function parseTime(text: string, column: ColumnSchema): CellInputResult {
  const zoned = /TIME WITH TIME ZONE|TIMETZ/i.test(column.sourceType ?? "");
  const offset = zoned ? (offsetPattern.exec(text)?.[0] ?? "") : "";
  const time = timeText(offset ? text.slice(0, -offset.length).trim() : text);
  return time ? { ok: true, value: `${time}${offset.toUpperCase()}` } : { ok: false, error: "time" };
}

function parseTimestamp(text: string, zoned: boolean): CellInputResult {
  const offset = zoned ? (offsetPattern.exec(text)?.[0] ?? "") : "";
  const rest = offset ? text.slice(0, -offset.length).trim() : text;
  const match = /^(\S+?)(?:[ T](\S+))?$/.exec(rest);
  const date = match ? dateText(match[1]) : null;
  const time = match?.[2] === undefined ? "00:00:00" : timeText(match[2]);
  if (!date || !time) return { ok: false, error: "timestamp" };
  return { ok: true, value: `${date} ${time}${offset.toUpperCase()}` };
}

/**
 * Reads a value typed into a cell of `column`: the text without the spaces around it, checked and
 * normalized for the column's type. An empty text is a blank (`null`), also in text columns. Numbers
 * are written in plain digits (no grouping or locale), booleans as `true`/`false`/`1`/`0`, dates as
 * `yyyy-MM-dd` (or `yyyy/MM/dd`), times as `HH:mm[:ss[.fff]]`, timestamps as a date, a space or `T`,
 * and a time (with an offset or `Z` for `timestamptz`).
 */
export function parseCellInput(text: string, column: ColumnSchema, options: CellInputOptions = {}): CellInputResult {
  if (!editableType(column.type)) return { ok: false, error: "type" };
  // Text keeps its spaces, unless it is only spaces.
  if (column.type === "string") return { ok: true, value: text.trim() === "" ? null : text };
  let trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (options.grouping && /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(trimmed) && isNumericColumn(column.type)) {
    trimmed = trimmed.replaceAll(",", "");
  }
  switch (column.type) {
    case "integer":
    case "bigint":
      return parseInteger(trimmed, column);
    case "float":
      return parseFloatText(trimmed);
    case "decimal":
      return parseDecimal(trimmed, column);
    case "boolean":
      return parseBoolean(trimmed);
    case "date": {
      const date = dateText(trimmed);
      return date ? { ok: true, value: date } : { ok: false, error: "date" };
    }
    case "time":
      return parseTime(trimmed, column);
    case "timestamp":
      return parseTimestamp(trimmed, false);
    case "timestamptz":
      return parseTimestamp(trimmed, true);
    case "uuid":
      return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(trimmed)
        ? {
            ok: true,
            value: trimmed
              .replaceAll("-", "")
              .toLowerCase()
              .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
          }
        : { ok: false, error: "uuid" };
    case "json":
      try {
        JSON.parse(trimmed);
        return { ok: true, value: trimmed };
      } catch {
        return { ok: false, error: "json" };
      }
    default:
      return { ok: false, error: "type" };
  }
}

/**
 * Checks a value written by a program (for example in `UpdateRequest`) against its column, as
 * `parseCellInput` checks typed text: numbers, booleans and text are read as the column's type.
 * Sources call it before writing, so that a cell never holds a value of another type.
 */
export function normalizeCellValue(value: CellValue, column: ColumnSchema): CellInputResult {
  if (value === null) return editableType(column.type) ? { ok: true, value: null } : { ok: false, error: "type" };
  if (column.type === "string") return { ok: true, value: typeof value === "string" ? value : String(value) };
  if (typeof value === "boolean") {
    return column.type === "boolean"
      ? { ok: true, value }
      : { ok: false, error: column.type === "json" ? "json" : "number" };
  }
  if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, error: "number" };
  // A number has the digits JS gives it; integers beyond 2^53 have to arrive as text to be exact.
  const text = typeof value === "number" ? String(value) : value;
  if (typeof value === "number" && /e/i.test(text) && (column.type === "integer" || column.type === "bigint")) {
    return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: "range" };
  }
  if (typeof value === "string" && column.type !== "json" && value.trim() === "") return { ok: true, value: null };
  return parseCellInput(text, column);
}

/** The text a cell editor starts with for a value: its digits or text, without the column's display format. */
export function editText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** Whether two cell values are the same value (a number and its digits as text count as the same). */
export function sameCellValue(a: CellValue | undefined, b: CellValue | undefined) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "boolean" || typeof b === "boolean") return false;
  return String(a) === String(b);
}
