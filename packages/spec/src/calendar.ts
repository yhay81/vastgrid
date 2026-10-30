/**
 * Dates and times as integers and as text (docs/spec.md §2.2): days since 1970-01-01 in the proleptic
 * Gregorian calendar, and counts of seconds, milliseconds, microseconds or nanoseconds. Dates are the days from
 * `-290308-12-22` to `+294247-01-10`, whose midnights a 64-bit count of microseconds holds; year 0 is 1 BC. DuckDB's
 * `infinity` and `-infinity` are counts that no date or timestamp has, as DuckDB stores them.
 */
import type { TimestampUnit } from "./types.js";

/** Counts of a unit in a second. */
export const UNIT_PER_SECOND: Record<TimestampUnit, bigint> = { s: 1n, ms: 1000n, us: 1_000_000n, ns: 1_000_000_000n };

/** Digits after the point that each unit keeps. */
export const UNIT_DIGITS: Record<TimestampUnit, number> = { s: 0, ms: 3, us: 6, ns: 9 };

const DAY_SECONDS = 86_400n;

/** The first and the last day that a date may be (§2.2), as days from 1970-01-01. */
export const FIRST_DAY = -106_751_991;
export const LAST_DAY = 106_751_991;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** DuckDB's `infinity` of dates, as days from 1970-01-01; `-infinity` is its negation. */
export const DATE_INFINITY = 2_147_483_647;
/** DuckDB's `infinity` of timestamps, as a count of any unit; `-infinity` is its negation. */
export const TIMESTAMP_INFINITY = INT64_MAX;

/** 1 for the text `infinity`, −1 for `-infinity`, and 0 for the text of another date or timestamp (§2.2). */
export function infinityOf(text: string): number {
  // Dates and timestamps start with a digit or a sign followed by a digit.
  if (text.charCodeAt(0) === 105) return text === "infinity" ? 1 : 0;
  return text.charCodeAt(1) === 105 && text === "-infinity" ? -1 : 0;
}

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

/** The year of a date's text (§2.2): four digits from 0000 to 9999, and otherwise a sign and six digits. */
function yearText(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? "-" : "+"}${pad(Math.abs(year), 6)}`;
}

/**
 * `YYYY-MM-DD` of a count of days, or `±YYYYYY-MM-DD` outside the years 0000 to 9999, and `infinity` or `-infinity`
 * for ±`DATE_INFINITY`. Throws outside the dates.
 */
export function dateText(days: number): string {
  if (days === DATE_INFINITY || days === -DATE_INFINITY) return days > 0 ? "infinity" : "-infinity";
  if (!(days >= FIRST_DAY && days <= LAST_DAY)) throw new RangeError(`${days} days from 1970-01-01 is not a date.`);
  const [year, month, day] = civilFromDays(days);
  return `${yearText(year)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const DATE_TEXT = /^([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})$/;

/** The count of days of the text of a date (§2.2), or null when it is not a real day that a date may be. */
export function parseDateText(text: string): number | null {
  const infinity = infinityOf(text);
  if (infinity !== 0) return infinity * DATE_INFINITY;
  const match = DATE_TEXT.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // The years 0000 to 9999 are written with four digits only; -000000 is not a year.
  if (match[1].length === 7 && year >= 0 && year <= 9999 && match[1][0] === "+") return null;
  if (match[1] === "-000000" || month < 1 || month > 12 || day < 1) return null;
  const days = daysFromCivil(year, month, day);
  const [y, m, d] = civilFromDays(days);
  return y === year && m === month && d === day && days >= FIRST_DAY && days <= LAST_DAY ? days : null;
}

/**
 * The length of the date at the start of the text of a date or a timestamp: 13 for a signed year, otherwise 10. The
 * text is not an infinity.
 */
export function dateLength(text: string): number {
  const first = text.charCodeAt(0);
  return first === 43 || first === 45 ? 13 : 10;
}

/** The year of the text of a date or a timestamp (§2.2) that is not an infinity. */
export function yearOf(text: string): number {
  return Number(text.slice(0, dateLength(text) - 6));
}

/**
 * How the texts of two dates, or of two timestamps, compare: negative, 0 or positive. The infinities come before
 * and after every other value, years compare as numbers, and the rest of the texts as text, whose fields have fixed
 * widths.
 */
export function compareTemporalText(x: string, y: string): number {
  const infinityX = infinityOf(x);
  const infinityY = infinityOf(y);
  if (infinityX !== 0 || infinityY !== 0) return infinityX - infinityY;
  const a = dateLength(x);
  const b = dateLength(y);
  if (a === 10 && b === 10) return x < y ? -1 : x > y ? 1 : 0;
  const years = yearOf(x) - yearOf(y);
  if (years !== 0) return years;
  const [p, q] = [x.slice(a - 6), y.slice(b - 6)];
  return p < q ? -1 : p > q ? 1 : 0;
}

/**
 * The text form (§2.4) of the text of a date, a timestamp or a timestamptz (§2.2), as DuckDB writes it: years after
 * 9999 without a sign or leading zeros (`10000-01-01`), and the years before 1 by their number BC
 * (`0001-12-31 (BC)` for year 0), before the time. The infinities are written the same.
 */
export function temporalTextForm(text: string): string {
  const first = text.charCodeAt(0);
  // The years 0001 to 9999 are written the same.
  if (first !== 43 && first !== 45 && !text.startsWith("0000")) return text;
  if (infinityOf(text) !== 0) return text;
  const dash = text.indexOf("-", 1);
  const year = Number(text.slice(0, dash));
  const date = `${pad(year > 0 ? year : 1 - year, 4)}${text.slice(dash, dash + 6)}`;
  return `${date}${year > 0 ? "" : " (BC)"}${text.slice(dash + 6)}`;
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

/**
 * The text of a timestamp (§2.2) from a count of its unit since 1970-01-01 00:00:00, and `infinity` or `-infinity`
 * for ±`TIMESTAMP_INFINITY`. Throws for −2^63, which is neither.
 */
export function timestampText(count: bigint, unit: TimestampUnit = "us"): string {
  if (count === TIMESTAMP_INFINITY || count === -TIMESTAMP_INFINITY) return count > 0n ? "infinity" : "-infinity";
  if (count < -TIMESTAMP_INFINITY) throw new RangeError("−2^63 is not a timestamp.");
  // `dateText` throws for a timestamp whose date is not a date.
  const perDay = DAY_SECONDS * UNIT_PER_SECOND[unit];
  const days = floorDiv(count, perDay);
  return `${dateText(Number(days))} ${clock(count - days * perDay, unit)}`;
}

/**
 * The count of the unit since 1970-01-01 00:00:00 of the text of a timestamp (§2.2), or null. The infinities are
 * ±`TIMESTAMP_INFINITY`, which no other timestamp is.
 */
export function parseTimestampText(text: string, unit: TimestampUnit = "us"): bigint | null {
  const infinity = infinityOf(text);
  if (infinity !== 0) return BigInt(infinity) * TIMESTAMP_INFINITY;
  const space = text.indexOf(" ");
  if (space !== 10 && space !== 13) return null;
  const days = parseDateText(text.slice(0, space));
  const time = parseClock(text.slice(space + 1), unit);
  if (days === null || time === null) return null;
  const count = BigInt(days) * DAY_SECONDS * UNIT_PER_SECOND[unit] + time;
  return count > -TIMESTAMP_INFINITY && count < TIMESTAMP_INFINITY ? count : null;
}

/** The text of a timestamptz (§2.2) from microseconds since 1970-01-01 00:00:00 UTC. */
export function timestamptzText(micros: bigint): string {
  const text = timestampText(micros, "us");
  return infinityOf(text) === 0 ? `${text}+00` : text;
}

/** Microseconds since 1970-01-01 00:00:00 UTC of the text of a timestamptz (§2.2), or null. */
export function parseTimestamptzText(text: string): bigint | null {
  if (infinityOf(text) !== 0) return parseTimestampText(text, "us");
  const timestamp = text.slice(0, -3);
  return text.endsWith("+00") && infinityOf(timestamp) === 0 ? parseTimestampText(timestamp, "us") : null;
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

const NANOS_PER_MONTH = 30n * NANOS_PER_DAY;

/**
 * The parts of an interval as DuckDB 2.0 compares them (§3.1): its length in nanoseconds, with months of 30 days
 * and days of 24 hours, as whole months, then the days (0 to 29) and the nanoseconds (less than a day) of the rest.
 * Intervals compare by these months, then days, then nanoseconds; `1 month` equals `30 days`, and `1 month -1 day`
 * equals `29 days`. Null when the text is not an interval.
 */
export function normalizeInterval(text: string): [bigint, bigint, bigint] | null {
  const parts = parseIntervalText(text);
  if (!parts) return null;
  const length = (BigInt(parts.months) * 30n + BigInt(parts.days)) * NANOS_PER_DAY + parts.nanos;
  // Division truncates toward zero: take a month more off a negative length, so that the rest is not negative.
  const months = length / NANOS_PER_MONTH - (length % NANOS_PER_MONTH < 0n ? 1n : 0n);
  const rest = length - months * NANOS_PER_MONTH;
  return [months, rest / NANOS_PER_DAY, rest % NANOS_PER_DAY];
}
