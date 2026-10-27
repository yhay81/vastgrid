/**
 * Dates and times as integers and as text (docs/v2-spec.md §2.2): days since 1970-01-01 in the proleptic
 * Gregorian calendar, and counts of seconds, milliseconds, microseconds or nanoseconds. Years are from 1 to
 * 9999, the years that the text of §2.2 writes.
 */
import type { TimestampUnit } from "./types.js";

/** Counts of a unit in a second. */
export const UNIT_PER_SECOND: Record<TimestampUnit, bigint> = { s: 1n, ms: 1000n, us: 1_000_000n, ns: 1_000_000_000n };

/** Digits after the point that each unit keeps. */
export const UNIT_DIGITS: Record<TimestampUnit, number> = { s: 0, ms: 3, us: 6, ns: 9 };

const DAY_SECONDS = 86_400n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** `a / b` rounded down, for a positive `b`. */
function floorDiv(a: bigint, b: bigint) {
  const quotient = a / b;
  return a % b !== 0n && a < 0n ? quotient - 1n : quotient;
}

/** Days from 1970-01-01 to a date (Howard Hinnant's `days_from_civil`). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The year, month and day of a count of days from 1970-01-01 (Howard Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function pad(value: number | bigint, length: number) {
  return String(value).padStart(length, "0");
}

/** `YYYY-MM-DD` of a count of days. Throws for years outside 1 to 9999. */
export function dateText(days: number): string {
  const [year, month, day] = civilFromDays(days);
  if (year < 1 || year > 9999) throw new RangeError(`The year ${year} is outside 1 to 9999.`);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The count of days of `YYYY-MM-DD`, or null when the text is not a real day of the years 1 to 9999. */
export function parseDateText(text: string): number | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const days = daysFromCivil(year, month, day);
  const [y, m, d] = civilFromDays(days);
  return y === year && m === month && d === day ? days : null;
}

/** `HH:MM:SS`, then the fraction of a second without trailing zeros, of a count of a unit within a day. */
function clock(count: bigint, unit: TimestampUnit): string {
  const perSecond = UNIT_PER_SECOND[unit];
  const seconds = count / perSecond;
  const fraction = count % perSecond;
  const hours = seconds / 3600n;
  const minutes = (seconds / 60n) % 60n;
  const rest = seconds % 60n;
  let text = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(rest, 2)}`;
  if (fraction !== 0n) text += `.${pad(fraction, UNIT_DIGITS[unit]).replace(/0+$/, "")}`;
  return text;
}

/** The text of a time of day (§2.2) from microseconds since midnight. */
export function timeText(micros: bigint): string {
  if (micros < 0n || micros >= DAY_SECONDS * 1_000_000n) throw new RangeError("A time is within one day.");
  return clock(micros, "us");
}

/** Reads `HH:MM:SS` with up to `digits` fraction digits as a count of the unit since midnight, or null. */
function parseClock(text: string, unit: TimestampUnit): bigint | null {
  const match = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const fraction = match[4] ?? "";
  if (hours > 23 || minutes > 59 || seconds > 59 || fraction.length > UNIT_DIGITS[unit]) return null;
  const perSecond = UNIT_PER_SECOND[unit];
  const whole = BigInt(hours * 3600 + minutes * 60 + seconds) * perSecond;
  return whole + (fraction ? BigInt(fraction.padEnd(UNIT_DIGITS[unit], "0")) : 0n);
}

/** Microseconds since midnight of the text of a time (§2.2), or null. */
export function parseTimeText(text: string): bigint | null {
  return parseClock(text, "us");
}

/** The text of a timestamp (§2.2) from a count of its unit since 1970-01-01 00:00:00. */
export function timestampText(count: bigint, unit: TimestampUnit = "us"): string {
  const perDay = DAY_SECONDS * UNIT_PER_SECOND[unit];
  const days = floorDiv(count, perDay);
  return `${dateText(Number(days))} ${clock(count - days * perDay, unit)}`;
}

/** The count of the unit since 1970-01-01 00:00:00 of the text of a timestamp (§2.2), or null. */
export function parseTimestampText(text: string, unit: TimestampUnit = "us"): bigint | null {
  const space = text.indexOf(" ");
  if (space !== 10) return null;
  const days = parseDateText(text.slice(0, space));
  const time = parseClock(text.slice(space + 1), unit);
  if (days === null || time === null) return null;
  const count = BigInt(days) * DAY_SECONDS * UNIT_PER_SECOND[unit] + time;
  return count >= INT64_MIN && count <= INT64_MAX ? count : null;
}

/** An interval (§2.1): months, days and nanoseconds. */
export interface IntervalParts {
  months: number;
  days: number;
  nanos: bigint;
}

function count(value: number, unit: string) {
  return `${value} ${unit}${value === 1 || value === -1 ? "" : "s"}`;
}

/**
 * DuckDB's text of an interval (§2.4): years and months, days, then the time as `HH:MM:SS` with the fraction
 * without trailing zeros, each left out when it is 0 (`00:00:00` when everything is), as
 * `1 year 2 months 3 days 04:05:06.789` or `-01:30:00`. Nanoseconds beyond DuckDB's microseconds add digits.
 */
export function intervalText({ months, days, nanos }: IntervalParts): string {
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  const rest = months - years * 12;
  if (years !== 0) parts.push(count(years, "year"));
  if (rest !== 0) parts.push(count(rest, "month"));
  if (days !== 0) parts.push(count(days, "day"));
  if (nanos !== 0n) {
    const negative = nanos < 0n;
    const magnitude = negative ? -nanos : nanos;
    const seconds = magnitude / 1_000_000_000n;
    const fraction = magnitude % 1_000_000_000n;
    let time = `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}:${pad(seconds % 60n, 2)}`;
    if (fraction !== 0n) time += `.${pad(fraction, 9).replace(/0+$/, "")}`;
    parts.push(`${negative ? "-" : ""}${time}`);
  }
  return parts.length === 0 ? "00:00:00" : parts.join(" ");
}

/** The parts of DuckDB's text of an interval, as `intervalText` writes it, or null. */
export function parseIntervalText(text: string): IntervalParts | null {
  const match =
    /^(?:(-?[0-9]+) years?(?: |$))?(?:(-?[0-9]+) months?(?: |$))?(?:(-?[0-9]+) days?(?: |$))?(?:(-?)([0-9]{2,}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?)?$/.exec(
      text,
    );
  if (!match || text === "" || text.endsWith(" ")) return null;
  const [years, months, days] = [match[1], match[2], match[3]].map((part) => BigInt(part ?? 0));
  if (Number(match[6] ?? 0) > 59 || Number(match[7] ?? 0) > 59) return null;
  let nanos = 0n;
  if (match[5] !== undefined) {
    const seconds = BigInt(match[5]) * 3600n + BigInt(match[6]) * 60n + BigInt(match[7]);
    nanos = seconds * 1_000_000_000n + BigInt((match[8] ?? "").padEnd(9, "0"));
    if (match[4] === "-") nanos = -nanos;
  }
  const total = years * 12n + months;
  if (total < -2147483648n || total > 2147483647n || days < -2147483648n || days > 2147483647n) return null;
  if (nanos < INT64_MIN || nanos > INT64_MAX) return null;
  return { months: Number(total), days: Number(days), nanos };
}

const NANOS_PER_DAY = 86_400_000_000_000n;

/**
 * The parts of an interval as DuckDB 1.5 compares them (§3.1): whole days of the nanoseconds go into the days,
 * then whole 30-day months of the days into the months, each by a division that truncates toward zero. Intervals
 * compare by these months, then days, then nanoseconds; `1 month` equals `30 days`, and `1 month -1 day` is
 * greater than `29 days`. Null when the text is not an interval.
 */
export function normalizeInterval(text: string): [bigint, bigint, bigint] | null {
  const parts = parseIntervalText(text);
  if (!parts) return null;
  const days = BigInt(parts.days) + parts.nanos / NANOS_PER_DAY;
  return [BigInt(parts.months) + days / 30n, days % 30n, parts.nanos % NANOS_PER_DAY];
}
