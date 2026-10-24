/**
 * Reading typed text as a value of a column's type (docs/v2-spec.md §7.3), and the text an editor starts with.
 */
import { parseDateText, parseTimestampText, timestampText, UNIT_DIGITS, UNIT_PER_SECOND } from "./calendar.js";
import type { JsonValue, ValueType } from "./types.js";
import { textOf } from "./values.js";

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
  | "type";

export type InputResult = { ok: true; value: JsonValue } | { ok: false; error: InputError };

export interface InputOptions {
  /** Read numbers whose whole digits are grouped by commas in threes (`1,234.5`), as pasting does. */
  grouping?: boolean;
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

function readFloat(text: string): InputResult {
  if (/^[+-]?(?:inf|infinity)$/i.test(text))
    return { ok: true, value: text.startsWith("-") ? "-Infinity" : "Infinity" };
  if (/^nan$/i.test(text)) return { ok: true, value: "NaN" };
  if (!numberText.test(text)) return fail("number");
  const value = Number(text);
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

/** `YYYY-MM-DD` of a date with `-`, `/` or `.` between its parts, or null. */
function dayText(text: string): string | null {
  const match = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})$/.exec(text);
  if (!match) return null;
  const day = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return parseDateText(day) === null ? null : day;
}

const timestampInput =
  /^([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})(?:[ T]([0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?)\s*(Z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$/i;

function readTimestamp(text: string, type: ValueType): InputResult {
  const zoned = type.type === "timestamptz";
  const unit = zoned ? "us" : (type.unit ?? "us");
  const match = timestampInput.exec(text);
  if (!match || (match[3] && !zoned)) return fail("timestamp");
  const day = dayText(match[1]);
  const clock = match[2] === undefined ? "00:00:00" : clockText(match[2], UNIT_DIGITS[unit]);
  if (!day || !clock) return fail("timestamp");
  if (!zoned) return { ok: true, value: `${day} ${clock}` };
  let offsetMinutes = 0;
  const offset = /^([+-])([0-9]{2}):?([0-9]{2})?$/.exec(match[3] ?? "");
  if (offset) {
    if (Number(offset[2]) > 23 || Number(offset[3] ?? 0) > 59) return fail("timestamp");
    const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
    offsetMinutes = offset[1] === "-" ? -minutes : minutes;
  }
  const local = parseTimestampText(`${day} ${clock}`, "us");
  if (local === null) return fail("timestamp");
  const utc = local - BigInt(offsetMinutes) * 60n * UNIT_PER_SECOND.us;
  try {
    return { ok: true, value: `${timestampText(utc, "us")}+00` };
  } catch {
    return fail("timestamp");
  }
}

/**
 * Reads typed text as a value of the column's type (§7.3): white space around it is removed (except for
 * strings), an empty text is null, and the value is written as JSON writes it (§2.2).
 */
export function readCellText(text: string, type: ValueType, options: InputOptions = {}): InputResult {
  if (type.type === "string") return { ok: true, value: text.replace(whiteSpace, "") === "" ? null : text };
  if (type.type === "interval" || type.type === "binary") return fail("type");
  let trimmed = text.replace(whiteSpace, "");
  if (trimmed === "") return { ok: true, value: null };
  const numeric = type.type === "integer" || type.type === "bigint" || type.type === "decimal" || type.type === "float";
  if (options.grouping && numeric && groupedText.test(trimmed)) trimmed = trimmed.replaceAll(",", "");
  switch (type.type) {
    case "integer":
    case "bigint":
      return readInteger(trimmed, type.type);
    case "decimal":
      return readDecimal(trimmed, type.precision ?? 38, type.scale ?? 0);
    case "float":
      return readFloat(trimmed);
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
      return readTimestamp(trimmed, type);
    case "uuid":
      return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(trimmed)
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

/** The text an editor starts with for a value: its text form (§2.4), and the empty string for null. */
export function editText(value: JsonValue, type: ValueType): string {
  return textOf(value, type) ?? "";
}
