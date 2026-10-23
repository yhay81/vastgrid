import { isNumericType } from "./column-type.js";
import type { CellValue, ColumnType } from "./types.js";

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
  private readonly integerFormat: Intl.NumberFormat;
  private readonly floatFormat: Intl.NumberFormat;
  private readonly scientificFormat: Intl.NumberFormat;
  private readonly group: string;
  private readonly decimal: string;
  private readonly nullText: string;
  private readonly maxLength: number;
  private readonly grouping: boolean;

  constructor(options: FormatOptions = {}) {
    const locale = options.locale;
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

  private formatText(value: string) {
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
    return this.formatText(value);
  }
}
