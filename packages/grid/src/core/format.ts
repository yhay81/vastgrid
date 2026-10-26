/**
 * How cells show their values with the `number` and `date` of a column's format (§5.1 of the specification): v1's
 * `NumberFormat` and `DateFormat`, ported from `vastgrid-core` (Intl formats, with the exact digits of decimals,
 * and date patterns such as `yyyy/MM/dd`).
 */
import type { Column, ColumnFormat, DateFormat, JsonValue, NumberFormat } from "vastgrid-spec";

const decimalLiteral = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A value as input for `Intl.NumberFormat`, or null when it is not a finite number. Numeric strings
 * stay strings, which `Intl.NumberFormat` formats from their exact digits.
 */
function numberInput(value: JsonValue): number | string | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return decimalLiteral.test(text) ? text : null;
}

function numberFormatter(locale: string | undefined, format: NumberFormat, grouping: boolean) {
  const style = format.style ?? "decimal";
  if (style === "currency" && !format.currency) throw new RangeError("A currency format needs `currency`.");
  const options: Intl.NumberFormatOptions = {
    style,
    useGrouping: format.grouping ?? grouping,
    minimumFractionDigits: format.fractionDigits ?? format.minimumFractionDigits,
    maximumFractionDigits: format.fractionDigits ?? format.maximumFractionDigits,
  };
  if (style === "currency") {
    options.currency = format.currency;
    if (format.currencyDisplay) options.currencyDisplay = format.currencyDisplay;
  }
  if (format.notation) options.notation = format.notation;
  if (format.signDisplay) options.signDisplay = format.signDisplay;
  // A maximum below the style's default minimum (2 for USD, 0 for percent) lowers the minimum too.
  if (options.maximumFractionDigits !== undefined && options.minimumFractionDigits === undefined) {
    options.minimumFractionDigits = Math.min(
      options.maximumFractionDigits,
      new Intl.NumberFormat(locale, { ...options, maximumFractionDigits: undefined }).resolvedOptions()
        .minimumFractionDigits ?? 0,
    );
  }
  const intl = new Intl.NumberFormat(locale, options);
  const prefix = format.prefix ?? "";
  const suffix = format.suffix ?? "";
  // `format` takes exact decimal strings (Intl.NumberFormat v3); the types only list numbers.
  return (value: number | string) => `${prefix}${intl.format(value as number)}${suffix}`;
}

/** The parts of an ISO-like date, time or timestamp. */
interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fraction digits of the second, as written. */
  fraction: string;
  hasDate: boolean;
  hasTime: boolean;
  /** Offset from UTC in minutes, for values with one. */
  offset: number | null;
}

const isoDateTime =
  /^([+-]?\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const isoTime = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

function parseOffset(text: string | undefined) {
  if (!text) return null;
  if (text.toUpperCase() === "Z") return 0;
  const sign = text.startsWith("-") ? -1 : 1;
  const digits = text.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
}

function parseDate(text: string): DateParts | null {
  const date = isoDateTime.exec(text.trim());
  if (date) {
    const [, year, month, day, hour, minute, second, fraction, offset] = date;
    return {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour ?? 0),
      minute: Number(minute ?? 0),
      second: Number(second ?? 0),
      fraction: fraction ?? "",
      hasDate: true,
      hasTime: hour !== undefined,
      offset: parseOffset(offset),
    };
  }
  const time = isoTime.exec(text.trim());
  if (!time) return null;
  const [, hour, minute, second, fraction] = time;
  return {
    year: 1970,
    month: 1,
    day: 1,
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? 0),
    fraction: fraction ?? "",
    hasDate: false,
    hasTime: true,
    offset: null,
  };
}

/** The UTC time of the parts' wall clock (ignoring their offset). Years below 100 are kept. */
function wallClock(parts: DateParts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, Number(parts.fraction.slice(0, 3).padEnd(3, "0")));
  return date;
}

const patternToken = /'(?:[^']|'')*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|S+|a/g;

function dateFormatter(locale: string | undefined, format: DateFormat) {
  const { pattern, timeZone, ...options } = format;
  // Checks the time zone and the options now, not on the first value.
  new Intl.DateTimeFormat(locale, { ...options, timeZone });
  const custom = Object.keys(options).length > 0;
  const formats = new Map<string, Intl.DateTimeFormat>();
  const intl = (key: string, make: () => Intl.DateTimeFormat) => {
    let item = formats.get(key);
    if (!item) {
      item = make();
      formats.set(key, item);
    }
    return item;
  };
  /** The parts in the shown time zone: values with an offset move to `timeZone`. */
  const local = (parts: DateParts): DateParts => {
    if (parts.offset === null) return parts;
    const instant = new Date(wallClock(parts).getTime() - parts.offset * 60_000);
    const fields = intl(
      "parts",
      () =>
        new Intl.DateTimeFormat("en-US-u-nu-latn", {
          timeZone,
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          hourCycle: "h23",
          era: "short",
        }),
    ).formatToParts(instant);
    const field = (type: string) => Number(fields.find((part) => part.type === type)?.value ?? 0);
    const bc = fields.find((part) => part.type === "era")?.value.startsWith("B");
    return {
      ...parts,
      year: bc ? 1 - field("year") : field("year"),
      month: field("month"),
      day: field("day"),
      hour: field("hour"),
      minute: field("minute"),
      second: field("second"),
      offset: null,
    };
  };

  if (pattern !== undefined) {
    const tokens = pattern.match(patternToken) ?? [];
    const texts = pattern.split(patternToken);
    const name = (key: string, options: Intl.DateTimeFormatOptions, date: Date) =>
      intl(key, () => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })).format(date);
    const pad = (value: number, length: number) =>
      value < 0 ? `-${String(-value).padStart(length, "0")}` : String(value).padStart(length, "0");
    return (parts: DateParts) => {
      const shown = local(parts);
      const date = wallClock(shown);
      let text = texts[0];
      tokens.forEach((token, index) => {
        let part: string;
        switch (token) {
          case "yyyy":
            part = pad(shown.year, 4);
            break;
          case "yy":
            part = pad(Math.abs(shown.year) % 100, 2);
            break;
          case "MMMM":
            part = name("MMMM", { month: "long" }, date);
            break;
          case "MMM":
            part = name("MMM", { month: "short" }, date);
            break;
          case "MM":
            part = pad(shown.month, 2);
            break;
          case "M":
            part = String(shown.month);
            break;
          case "dd":
            part = pad(shown.day, 2);
            break;
          case "d":
            part = String(shown.day);
            break;
          case "EEEE":
            part = name("EEEE", { weekday: "long" }, date);
            break;
          case "EEE":
            part = name("EEE", { weekday: "short" }, date);
            break;
          case "HH":
            part = pad(shown.hour, 2);
            break;
          case "H":
            part = String(shown.hour);
            break;
          case "hh":
            part = pad(shown.hour % 12 || 12, 2);
            break;
          case "h":
            part = String(shown.hour % 12 || 12);
            break;
          case "a":
            part =
              intl("a", () => new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true, timeZone: "UTC" }))
                .formatToParts(date)
                .find((item) => item.type === "dayPeriod")?.value ?? (shown.hour < 12 ? "AM" : "PM");
            break;
          case "mm":
            part = pad(shown.minute, 2);
            break;
          case "m":
            part = String(shown.minute);
            break;
          case "ss":
            part = pad(shown.second, 2);
            break;
          case "s":
            part = String(shown.second);
            break;
          default:
            part = token.startsWith("S")
              ? shown.fraction.slice(0, token.length).padEnd(token.length, "0")
              : token.slice(1, -1).replaceAll("''", "'");
        }
        text += part + texts[index + 1];
      });
      return text;
    };
  }

  return (parts: DateParts) => {
    const zone = parts.offset !== null ? "z" : "";
    const shape = custom ? `custom${zone}` : `${parts.hasDate ? "d" : ""}${parts.hasTime ? "t" : ""}${zone}`;
    const item = intl(shape, () => {
      const defaults: Intl.DateTimeFormatOptions = custom ? options : {};
      if (!custom && parts.hasDate) Object.assign(defaults, { year: "numeric", month: "2-digit", day: "2-digit" });
      if (!custom && parts.hasTime) Object.assign(defaults, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      // Values without an offset are wall-clock times: show them as they are.
      return new Intl.DateTimeFormat(locale, { ...defaults, timeZone: parts.offset !== null ? timeZone : "UTC" });
    });
    const time = wallClock(parts).getTime() - (parts.offset ?? 0) * 60_000;
    return item.format(time);
  };
}

/** Whether a column holds numbers. */
export function isNumeric(column: Column) {
  return column.type === "integer" || column.type === "bigint" || column.type === "decimal" || column.type === "float";
}

const TEMPORAL = new Set(["date", "time", "timestamp", "timestamptz"]);

/**
 * The text of values of a column by its format, or null where the format says nothing about a value (the grid then
 * shows its text form, §2.4). Formats that Intl refuses (an unknown currency or time zone) give null for every value.
 */
export function formatterFor(
  column: Column,
  format: ColumnFormat | undefined,
  locale: string | undefined,
): ((value: JsonValue) => string | null) | null {
  if (!format?.number && !format?.date) return null;
  let number: ((value: number | string) => string) | null = null;
  let date: ((parts: DateParts) => string) | null = null;
  try {
    if (format.number && isNumeric(column)) number = numberFormatter(locale, format.number, true);
    if (format.date && TEMPORAL.has(column.type)) date = dateFormatter(locale, format.date);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  if (!number && !date) return null;
  return (value) => {
    if (value === null) return null;
    if (number) {
      const input = numberInput(value);
      return input === null ? null : number(input);
    }
    if (date && typeof value === "string") {
      const parts = parseDate(value.replace(/\+00$/, "Z"));
      return parts ? date(parts) : null;
    }
    return null;
  };
}
