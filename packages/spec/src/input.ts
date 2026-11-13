/**
 * Reading typed text as a value of a column's type (docs/spec.md §7.3), and the text an editor starts with.
 */
import {
  civilFromDays,
  dateText,
  daysFromCivil,
  FIRST_DAY,
  floorDiv,
  LAST_DAY,
  parseTimestamptzText,
  parseTimeText,
  TIMESTAMP_INFINITY,
  temporalTextForm,
  timestampText,
  timestamptzText,
  UNIT_DIGITS,
  UNIT_PER_SECOND,
} from "./calendar.js";
import type { JsonValue, ValueType } from "./types.js";
import { isValueOf, textOf } from "./values.js";

/** Why typed text is not a value of its column's type (§7.3). */
export type InputError =
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
  | "unicode"
  | "type";

export type InputResult = { ok: true; value: JsonValue } | { ok: false; error: InputError };

export interface InputOptions {
  /** Read numbers whose whole digits are grouped by commas in threes (`1,234.5`), as pasting does. */
  grouping?: boolean;
  /**
   * The time zone (IANA) of a `timestamptz` column's `format.date.timeZone`: text without an offset is the time
   * of day there. UTC without it, or when Intl does not know the zone.
   */
  timeZone?: string;
}

const whiteSpace = /^\p{White_Space}+|\p{White_Space}+$/gu;
const numberText = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const groupedText = /^[+-]?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]*)?$/;
const ranges: Record<"integer" | "bigint", [bigint, bigint]> = {
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
};

function fail(error: InputError): InputResult {
  return { ok: false, error };
}

function readInteger(text: string, type: "integer" | "bigint"): InputResult {
  if (!/^[+-]?[0-9]+$/.test(text)) return fail(numberText.test(text) ? "integer" : "number");
  const value = BigInt(text);
  const [min, max] = ranges[type];
  if (value < min || value > max) return fail("range");
  const number = Number(value);
  return { ok: true, value: Number.isSafeInteger(number) ? number : value.toString() };
}

function readDecimal(text: string, precision: number, scale: number): InputResult {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/.exec(text);
  if (!match || !(match[2] || match[3])) return fail(numberText.test(text) ? "decimal" : "number");
  const whole = match[2].replace(/^0+/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) return fail("scale");
  if (whole.length > precision - scale) return fail("precision");
  const zero = /^0*$/.test(whole + fraction);
  const digits = `${whole || "0"}${scale > 0 ? `.${fraction.padEnd(scale, "0")}` : ""}`;
  return { ok: true, value: `${match[1] === "-" && !zero ? "-" : ""}${digits}` };
}

function readFloat(text: string, bits = 64): InputResult {
  if (/^[+-]?(?:inf|infinity)$/i.test(text))
    return { ok: true, value: text.startsWith("-") ? "-Infinity" : "Infinity" };
  if (/^nan$/i.test(text)) return { ok: true, value: "NaN" };
  if (!numberText.test(text)) return fail("number");
  const value = bits === 32 ? Math.fround(Number(text)) : Number(text);
  return Number.isFinite(value) ? { ok: true, value: Object.is(value, -0) ? 0 : value } : fail("range");
}

/** `HH:MM:SS` with the fraction (without trailing zeros) of `H:MM[:SS[.f]]`, or null. */
function clockText(text: string, digits: number): string | null {
  const match = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?$/.exec(text);
  if (!match) return null;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const fraction = match[4] ?? "";
  if (hour > 23 || minute > 59 || second > 59 || fraction.length > digits) return null;
  const kept = fraction.replace(/0+$/, "");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}:${pad(second)}${kept ? `.${kept}` : ""}`;
}

/**
 * The count of days from 1970-01-01 of a valid calendar day written with `-`, `/` or `.`, or null when it is not a
 * real calendar day (even before checking `[FIRST_DAY, LAST_DAY]`, so UTC offsets on boundary days can be applied).
 */
function civilDays(text: string): number | null {
  const match = /^([+-][0-9]{6}|[0-9]{4,6})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})( \(BC\)| BC)?$/i.exec(text);
  if (!match) return null;
  let year = Number(match[1]);
  if (match[4]) {
    if (!/^[0-9]/.test(match[1]) || year < 1) return null;
    year = 1 - year;
  } else if (match[1].length === 7 && year >= 0 && year <= 9999 && match[1][0] === "+") {
    return null;
  } else if (match[1] === "-000000") {
    return null;
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const days = daysFromCivil(year, month, day);
  const [y, m, d] = civilFromDays(days);
  return y === year && m === month && d === day ? days : null;
}

/**
 * The text of a date (§2.2) with `-`, `/` or `.` between its parts, or null. Its year is four to six digits, a sign
 * and six digits, or, followed by `BC` or `(BC)` as the text form writes it (§2.4), the number of a year BC.
 */
function dayText(text: string): string | null {
  const days = civilDays(text);
  if (days === null || days < FIRST_DAY || days > LAST_DAY) return null;
  return dateText(days);
}

const DAY_MS = 86_400_000;
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** How far the time of day in `timeZone` is ahead of UTC at an instant (ms since the epoch), in ms. */
function zoneOffset(instant: number, timeZone: string): number {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormats.set(timeZone, format);
  }
  const second = Math.floor(instant / 1000) * 1000;
  const parts: Record<string, number> = {};
  let bc = false;
  for (const part of format.formatToParts(second)) {
    if (part.type === "era") bc = part.value === "BC";
    else parts[part.type] = Number(part.value);
  }
  // Intl numbers years within their era: 1 BC is astronomical year 0.
  const year = bc ? 1 - parts.year : parts.year;
  const local =
    daysFromCivil(year, parts.month, parts.day) * DAY_MS +
    ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
  return local - second;
}

/**
 * The instant (µs) whose time of day in `timeZone` is `local` (µs): the earlier of two when clocks are set back,
 * and the one of the offset before the change when clocks skip it, as Temporal's `compatible` does.
 */
function zonedInstant(local: bigint, timeZone: string): bigint {
  const ms = Number(floorDiv(local, 1000n));
  const before = zoneOffset(ms - DAY_MS, timeZone);
  const after = zoneOffset(ms + DAY_MS, timeZone);
  const fitting = [before, after].filter((offset) => zoneOffset(ms - offset, timeZone) === offset);
  const offset = fitting.length > 0 ? Math.max(...fitting) : before;
  return local - BigInt(offset) * 1000n;
}

const timestampInput =
  /^((?:[+-][0-9]{6}|[0-9]{4,6})[-/.][0-9]{1,2}[-/.][0-9]{1,2}(?: \(BC\)| BC)?)(?:[ T]([0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?)\s*(Z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$/i;

function readTimestamp(text: string, type: ValueType, timeZone: string | undefined): InputResult {
  const zoned = type.type === "timestamptz";
  const unit = zoned ? "us" : (type.unit ?? "us");
  const match = timestampInput.exec(text);
  if (!match || (match[3] && !zoned)) return fail("timestamp");
  const days = civilDays(match[1]);
  const clock = match[2] === undefined ? "00:00:00" : clockText(match[2], UNIT_DIGITS[unit]);
  if (days === null || !clock) return fail("timestamp");
  if (!zoned) {
    if (days < FIRST_DAY || days > LAST_DAY) return fail("range");
    const value = `${dateText(days)} ${clock}`;
    return isValueOf(value, type) ? { ok: true, value } : fail("range");
  }
  let offsetMinutes = 0;
  const offset = /^([+-])([0-9]{2}):?([0-9]{2})?$/.exec(match[3] ?? "");
  if (offset) {
    if (Number(offset[2]) > 23 || Number(offset[3] ?? 0) > 59) return fail("timestamp");
    const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
    offsetMinutes = offset[1] === "-" ? -minutes : minutes;
  }
  const clockMicros = parseTimeText(clock);
  if (clockMicros === null) return fail("timestamp");
  const local = BigInt(days) * 86_400n * UNIT_PER_SECOND.us + clockMicros;
  let utc = local - BigInt(offsetMinutes) * 60n * UNIT_PER_SECOND.us;
  if (!match[3] && timeZone) {
    try {
      utc = zonedInstant(local, timeZone);
    } catch {
      // A zone that Intl does not know: UTC, as the grid then shows the text form.
    }
  }
  // An offset may move the instant onto or past the count of an infinity or the date bounds.
  if (utc >= TIMESTAMP_INFINITY || utc <= -TIMESTAMP_INFINITY) return fail("range");
  try {
    return { ok: true, value: timestamptzText(utc) };
  } catch {
    return fail("range");
  }
}

/**
 * Reads typed text as a value of the column's type (§7.3): white space around it is removed (except for
 * strings), an empty text is null, and the value is written as JSON writes it (§2.2).
 */
export function readCellText(text: string, type: ValueType, options: InputOptions = {}): InputResult {
  if (type.type === "string") {
    if (!isValueOf(text, type)) return fail("unicode");
    return { ok: true, value: text.replace(whiteSpace, "") === "" ? null : text };
  }
  let trimmed = text.replace(whiteSpace, "");
  if (trimmed === "") return { ok: true, value: null };
  if (type.type === "interval" || type.type === "binary") return fail("type");
  const numeric = type.type === "integer" || type.type === "bigint" || type.type === "decimal" || type.type === "float";
  if (options.grouping && numeric && groupedText.test(trimmed)) trimmed = trimmed.replaceAll(",", "");
  // DuckDB's infinities, in any letter case (§2.2).
  const temporal = type.type === "date" || type.type === "timestamp" || type.type === "timestamptz";
  if (temporal && /^-?infinity$/i.test(trimmed)) return { ok: true, value: trimmed.toLowerCase() };
  switch (type.type) {
    case "integer":
    case "bigint":
      return readInteger(trimmed, type.type);
    case "decimal":
      return readDecimal(trimmed, type.precision ?? 38, type.scale ?? 0);
    case "float":
      return readFloat(trimmed, type.bits);
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower === "true" || lower === "1") return { ok: true, value: true };
      if (lower === "false" || lower === "0") return { ok: true, value: false };
      return fail("boolean");
    }
    case "date": {
      const day = dayText(trimmed);
      return day ? { ok: true, value: day } : fail("date");
    }
    case "time": {
      const clock = clockText(trimmed, 6);
      return clock ? { ok: true, value: clock } : fail("time");
    }
    case "timestamp":
    case "timestamptz":
      return readTimestamp(trimmed, type, options.timeZone);
    case "uuid":
      return /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(trimmed)
        ? {
            ok: true,
            value: trimmed
              .replaceAll("-", "")
              .toLowerCase()
              .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
          }
        : fail("uuid");
  }
}

/**
 * The text an editor starts with for a value: its text form (§2.4), and the empty string for null. With a
 * `timeZone`, a `timestamptz` value is the time of day there with its offset (`2024-01-01 09:00:00+09`), which
 * reads back as the same instant.
 */
export function editText(value: JsonValue, type: ValueType, options: { timeZone?: string } = {}): string {
  const text = textOf(value, type) ?? "";
  if (type.type !== "timestamptz" || !options.timeZone || value === null) return text;
  const utc = typeof value === "string" ? parseTimestamptzText(value) : null;
  if (utc === null || utc === TIMESTAMP_INFINITY || utc === -TIMESTAMP_INFINITY) return text;
  try {
    const offset = zoneOffset(Number(floorDiv(utc, 1000n)), options.timeZone);
    // Offsets with seconds (local mean times before 1900) have no text that §7.3 reads.
    if (offset % 60_000 !== 0) return text;
    const localCount = utc + BigInt(offset) * 1000n;
    if (localCount <= -TIMESTAMP_INFINITY || localCount >= TIMESTAMP_INFINITY) return text;
    const local = temporalTextForm(timestampText(localCount, "us"));
    const minutes = Math.abs(offset / 60_000);
    const pad = (count: number) => String(count).padStart(2, "0");
    const hours = `${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}`;
    return `${local}${hours}${minutes % 60 === 0 ? "" : `:${pad(minutes % 60)}`}`;
  } catch {
    return text;
  }
}
