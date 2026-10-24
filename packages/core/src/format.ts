import { isNumericType } from "./column-type.js";
import type {
  CellStyle,
  CellValue,
  ColumnAlign,
  ColumnFormat,
  ColumnSchema,
  ColumnType,
  CopyValues,
  DateFormat,
  NumberFormat,
} from "./types.js";

export interface FormatOptions {
  /** BCP 47 locale for number grouping. Defaults to the runtime locale. */
  locale?: string;
  /** Text shown for `null`. Defaults to an empty string. */
  nullText?: string;
  /** Longest text kept for display; longer text ends with "…". */
  maxLength?: number;
  /** Group digits (1,234,567). Defaults to `true`. */
  grouping?: boolean;
}

/** Converts a cell value to a JS number when it represents one (numbers, numeric strings of numeric columns). */
export function numericValue(value: CellValue, type?: ColumnType): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && (type === undefined || isNumericType(type))) {
    if (value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** Text of a value for the clipboard and exports: no grouping, no truncation. */
export function plainText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

const lineBreaks = /\r\n|[\n\r\u2028\u2029]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces.
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Formats cell values for display in one line. Create one per locale and reuse it. */
export class ValueFormatter {
  readonly locale: string | undefined;
  readonly nullText: string;
  readonly grouping: boolean;
  private readonly integerFormat: Intl.NumberFormat;
  private readonly floatFormat: Intl.NumberFormat;
  private readonly scientificFormat: Intl.NumberFormat;
  private readonly group: string;
  private readonly decimal: string;
  private readonly maxLength: number;

  constructor(options: FormatOptions = {}) {
    const locale = options.locale;
    this.locale = locale;
    this.grouping = options.grouping !== false;
    this.integerFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: this.grouping });
    this.floatFormat = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15, useGrouping: this.grouping });
    this.scientificFormat = new Intl.NumberFormat(locale, { notation: "scientific", maximumSignificantDigits: 15 });
    const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.5);
    this.group = parts.find((part) => part.type === "group")?.value ?? ",";
    this.decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    this.nullText = options.nullText ?? "";
    this.maxLength = options.maxLength ?? 1000;
  }

  /** Groups the digits of a decimal number given as a string ("-1234567.50" → "-1,234,567.50"). */
  private groupDigits(text: string) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) return text;
    const [, sign, integer, fraction] = match;
    const grouped = this.grouping ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, this.group) : integer;
    return `${sign}${grouped}${fraction === undefined ? "" : `${this.decimal}${fraction}`}`;
  }

  private formatNumber(value: number, type: ColumnType) {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "∞" : "-∞";
    if ((type === "integer" || type === "bigint") && Number.isInteger(value)) return this.integerFormat.format(value);
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude >= 1e16 || magnitude < 1e-7)) return this.scientificFormat.format(value);
    return this.floatFormat.format(value);
  }

  /** Shortens text and shows it in one line: line breaks, tabs and control characters become marks. */
  oneLine(value: string) {
    let text = value.length > this.maxLength ? `${value.slice(0, this.maxLength)}…` : value;
    text = text.replace(lineBreaks, " ↵ ").replace(/\t/g, " ⇥ ").replace(controls, "�");
    return text;
  }

  format(value: CellValue, type: ColumnType): string {
    if (value === null) return this.nullText;
    if (typeof value === "number") return this.formatNumber(value, type);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (isNumericType(type)) {
      if (value === "NaN") return "NaN";
      if (value === "Infinity" || value === "inf") return "∞";
      if (value === "-Infinity" || value === "-inf") return "-∞";
      return this.groupDigits(value);
    }
    return this.oneLine(value);
  }

  /** A formatter for one column with its display settings. Throws a `RangeError` for invalid settings. */
  column(schema: ColumnSchema, format: ColumnFormat = {}): ColumnFormatter {
    return new ColumnFormatter(this, schema, format);
  }
}

const decimalLiteral = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A value as input for `Intl.NumberFormat`, or null when it is not a finite number. Numeric strings
 * stay strings, which `Intl.NumberFormat` formats from their exact digits.
 */
function numberInput(value: CellValue): number | string | null {
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

/**
 * Formats the values of one column with its display settings (see `ColumnFormat`). Made by
 * `ValueFormatter.column`; make a new one when the settings or the locale change.
 */
export class ColumnFormatter {
  readonly schema: ColumnSchema;
  /** The name shown for the column: its `label`, or its schema name. */
  readonly label: string;
  readonly align: ColumnAlign;
  /** Whether the column shows numbers (its type is numeric or it has a number format). */
  readonly numeric: boolean;
  /** The column's display settings, for code that builds on them (exports, custom drawing). */
  readonly settings: ColumnFormat;
  /** The copy setting of the column, if it has one. */
  readonly copy: CopyValues | undefined;
  private readonly base: ValueFormatter;
  private readonly number: ((value: number | string) => string) | null;
  private readonly date: ((parts: DateParts) => string) | null;
  private readonly custom: ColumnFormat["format"];
  private readonly styler: ColumnFormat["style"];

  constructor(base: ValueFormatter, schema: ColumnSchema, format: ColumnFormat) {
    this.base = base;
    this.schema = schema;
    this.settings = format;
    this.label = format.label || schema.name;
    this.numeric = isNumericType(schema.type) || format.number !== undefined;
    this.align = format.align ?? (this.numeric ? "right" : "left");
    this.copy = format.copy;
    this.number = format.number ? numberFormatter(base.locale, format.number, base.grouping) : null;
    this.date = format.date ? dateFormatter(base.locale, format.date) : null;
    this.custom = format.format;
    this.styler = format.style;
  }

  /** Whether the column has a `style` setting. */
  get styled() {
    return this.styler !== undefined;
  }

  /** The colors of a cell from the column's `style` setting, or null for the defaults. `text` is the shown text. */
  style(value: CellValue, text: string = this.format(value)): CellStyle | null {
    return this.styler?.(value, { column: this.schema, text }) ?? null;
  }

  /** The text of a value from the number and date settings, or null to use the grid's default. */
  private formatted(value: CellValue): string | null {
    if (value === null) return null;
    if (this.number) {
      const input = numberInput(value);
      if (input !== null) return this.number(input);
    }
    if (this.date && typeof value === "string") {
      const parts = parseDate(value);
      if (parts) return this.date(parts);
    }
    return null;
  }

  /** The text of a value without settings: numbers as the grid shows them, text in full. */
  private plain(value: CellValue): string {
    if (value === null) return this.base.nullText;
    if (typeof value === "string" && !isNumericType(this.schema.type)) return value;
    return this.base.format(value, this.schema.type);
  }

  /** The text shown for a value in full: not shortened, line breaks kept. */
  text(value: CellValue): string {
    const text = this.formatted(value) ?? this.plain(value);
    return this.custom ? this.custom(value, { column: this.schema, text }) : text;
  }

  /** The text drawn in a cell: one line, long text shortened. */
  format(value: CellValue): string {
    if (!this.custom) {
      const formatted = this.formatted(value);
      return formatted === null ? this.base.format(value, this.schema.type) : this.base.oneLine(formatted);
    }
    return this.base.oneLine(this.text(value));
  }

  /** The text copied for a value: `raw` is the value itself (see `plainText`), `formatted` the shown text. */
  copyText(value: CellValue, values: CopyValues): string {
    return (this.copy ?? values) === "formatted" ? this.text(value) : plainText(value);
  }
}
