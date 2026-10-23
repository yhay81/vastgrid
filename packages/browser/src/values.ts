import { type CellValue, type ColumnType, isNumericType } from "vastgrid-core";

// Values are given as the text DuckDB casts them to, so that both engines show, sort and filter the same.

function pad(value: number | bigint, width: number) {
  return String(value).padStart(width, "0");
}

/** Year, month and day of a day count since 1970-01-01 (proleptic Gregorian calendar). */
function civil(days: number) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

/** `2024-01-31`, as DuckDB writes dates. */
export function dateText(days: number) {
  const { year, month, day } = civil(days);
  const text = `${pad(Math.abs(year), 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  return year <= 0 ? `${pad(1 - year, 4)}-${pad(month, 2)}-${pad(day, 2)} (BC)` : text;
}

/** `12:34:56.789` from nanoseconds since midnight: the fraction without trailing zeros, as DuckDB writes times. */
function clockText(nanos: number) {
  const seconds = Math.floor(nanos / 1e9);
  const fraction = nanos - seconds * 1e9;
  const text = `${pad(Math.floor(seconds / 3600), 2)}:${pad(Math.floor(seconds / 60) % 60, 2)}:${pad(seconds % 60, 2)}`;
  return fraction === 0 ? text : `${text}.${pad(fraction, 9).replace(/0+$/, "")}`;
}

/** Time of day from nanoseconds since midnight. */
export function timeText(nanos: bigint) {
  return clockText(Number(nanos));
}

const nanosPerDay = 86_400_000_000_000n;

/** `2024-01-31 12:34:56.5` from nanoseconds since 1970-01-01. */
export function timestampText(nanos: bigint) {
  let days = nanos / nanosPerDay;
  let rest = nanos % nanosPerDay;
  if (rest < 0n) {
    rest += nanosPerDay;
    days -= 1n;
  }
  // Nanoseconds of one day fit a number exactly.
  return `${dateText(Number(days))} ${clockText(Number(rest))}`;
}

/**
 * A UTC timestamp (`2024-01-01 00:00:00.5`) in the local time zone with its offset
 * (`2024-01-01 09:00:00.5+09`), as DuckDB writes `TIMESTAMP WITH TIME ZONE`.
 */
export function zonedText(utc: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(utc);
  if (!match) return utc;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second));
  const offset = -date.getTimezoneOffset();
  const local = timestampText(BigInt(date.getTime() + offset * 60_000) * 1_000_000n);
  const sign = offset < 0 ? "-" : "+";
  const hours = pad(Math.floor(Math.abs(offset) / 60), 2);
  const minutes = Math.abs(offset) % 60;
  return `${local}${fraction}${sign}${hours}${minutes ? `:${pad(minutes, 2)}` : ""}`;
}

/** Binary values as DuckDB casts BLOB to text: printable ASCII as it is, other bytes as `\xAB`. */
export function binaryText(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) {
    text +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return text;
}

/** Nested values (lists, structs, maps) as text, in the form DuckDB uses: `[1, 2]`, `{'a': x}`. */
export function nestedText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return binaryText(value);
  if (Array.isArray(value)) return `[${value.map(nestedText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `'${key}': ${nestedText(item)}`).join(", ")}}`;
  }
  return String(value);
}

/** A JavaScript value as a wire value: integers beyond 2^53 and non-finite numbers become text. */
export function wireNumber(value: number | bigint): CellValue {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Number.isFinite(value)) return value;
  return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
}

/** Cuts text longer than `limit` characters, ending it with "…", as the DuckDB engine does. */
export function limitText(values: CellValue[], type: ColumnType, limit: number) {
  if (isNumericType(type)) return values;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value === "string" && value.length > limit) values[index] = `${value.slice(0, limit)}…`;
  }
  return values;
}
