/**
 * Excel's number format codes for the display settings of columns (§5.1): `export` gives them to engines that
 * write workbooks (§6.6, §8.2), so that a workbook shows numbers and dates as the grid does.
 */
import type { ColumnFormat, NumberFormat } from "./state.js";
import type { LogicalType } from "./types.js";

const NUMERIC = new Set<LogicalType>(["integer", "bigint", "decimal", "float"]);

/** Literal text in a format code. Quotes cannot be escaped inside quotes, so they are written as `\"`. */
function quoted(text: string) {
  return text
    .split('"')
    .map((part) => (part ? `"${part}"` : ""))
    .join('\\"');
}

function fractionPart(min: number, max: number) {
  if (max <= 0) return "";
  return `.${"0".repeat(min)}${"#".repeat(Math.max(0, max - min))}`;
}

function excelNumberCode(format: NumberFormat, type: LogicalType, grouping: boolean, locale?: string) {
  const integer = type === "integer" || type === "bigint";
  const style = format.style ?? "decimal";
  let min = format.fractionDigits ?? format.minimumFractionDigits;
  let max = format.fractionDigits ?? format.maximumFractionDigits;
  if (min === undefined && max === undefined) {
    if (style === "currency" && format.currency) {
      const digits = new Intl.NumberFormat("en", { style: "currency", currency: format.currency }).resolvedOptions()
        .maximumFractionDigits;
      min = max = digits;
    } else if (style === "percent") {
      min = 0;
      max = 0;
    } else if (!integer) {
      // Shows the digits the value has, like `General`, but with grouping.
      min = 0;
      max = 10;
    }
  }
  min ??= 0;
  max = Math.max(max ?? min, min);
  let code: string;
  if (format.notation === "scientific" || format.notation === "engineering") {
    code = `${format.notation === "engineering" ? "##" : ""}0${fractionPart(min, max)}E+00`;
  } else {
    code = `${(format.grouping ?? grouping) ? "#,##0" : "0"}${fractionPart(min, max)}`;
  }
  if (style === "percent") code += "%";
  let prefix = format.prefix ?? "";
  let suffix = format.suffix ?? "";
  if (style === "currency" && format.currency) {
    let symbol = format.currency;
    try {
      const parts = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: format.currency,
        currencyDisplay: format.currencyDisplay === "name" ? "code" : (format.currencyDisplay ?? "symbol"),
      }).formatToParts(1);
      symbol = parts.find((part) => part.type === "currency")?.value ?? symbol;
      if (parts.findIndex((part) => part.type === "currency") > parts.findIndex((part) => part.type === "integer"))
        suffix = ` ${symbol}${suffix}`;
      else prefix = `${prefix}${symbol}`;
    } catch {
      prefix = `${prefix}${symbol} `;
    }
  }
  const positive = `${quoted(prefix)}${code}${quoted(suffix)}`;
  if (format.signDisplay === "always" || format.signDisplay === "exceptZero") {
    const zero = format.signDisplay === "always" ? `${quoted(`+${prefix}`)}${code}${quoted(suffix)}` : positive;
    return `${quoted(`+${prefix}`)}${code}${quoted(suffix)};${quoted(`-${prefix}`)}${code}${quoted(suffix)};${zero}`;
  }
  if (format.signDisplay === "never") return `${positive};${positive}`;
  return positive;
}

const patternTokens = /'([^']|'')*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|a|mm|m|ss|s|S+|[A-Za-z]/g;

/** The Excel code of a date pattern (see `DateFormat.pattern`), or `null` when it cannot be expressed. */
function excelDateCode(pattern: string): string | null {
  const mapped: Record<string, string> = {
    yyyy: "yyyy",
    yy: "yy",
    MMMM: "mmmm",
    MMM: "mmm",
    MM: "mm",
    M: "m",
    dd: "dd",
    d: "d",
    EEEE: "dddd",
    EEE: "ddd",
    HH: "hh",
    H: "h",
    hh: "hh",
    h: "h",
    a: "AM/PM",
    mm: "mm",
    m: "m",
    ss: "ss",
    s: "s",
  };
  let code = "";
  let literal = "";
  let last = 0;
  for (const match of pattern.matchAll(patternTokens)) {
    literal += pattern.slice(last, match.index);
    last = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith("'")) {
      literal += token === "''" ? "'" : token.slice(1, -1).replaceAll("''", "'");
      continue;
    }
    // Fraction digits follow the seconds and bring their own decimal point.
    if (token.startsWith("S")) literal = literal.replace(/[.,]$/, "");
    code += quoted(literal);
    literal = "";
    if (token.startsWith("S")) code += `.${"0".repeat(Math.min(token.length, 3))}`;
    else if (mapped[token]) code += mapped[token];
    else return null;
  }
  code += quoted(literal + pattern.slice(last));
  // Excel reads `h` as 12-hour only with AM/PM in the code.
  if (/h/.test(pattern.replace(/'([^']|'')*'/g, "")) && !code.includes("AM/PM")) code += " AM/PM";
  return code;
}

/**
 * The Excel number format code for a column's display settings, or `null` for the default of its type. Number
 * formats map onto codes such as `#,##0.00`, `0.0%` or `"$"#,##0.00`, date patterns onto codes such as
 * `yyyy/mm/dd hh:mm`. Settings Excel cannot express (compact notation, `Intl` date options) give `null`.
 */
export function excelNumberFormat(
  type: LogicalType,
  format: ColumnFormat | undefined,
  options: { locale?: string; grouping?: boolean } = {},
): string | null {
  if (!format) return null;
  if (NUMERIC.has(type) && format.number && format.number.notation !== "compact") {
    if (format.number.style === "currency" && !format.number.currency) return null;
    return excelNumberCode(format.number, type, options.grouping !== false, options.locale);
  }
  if (format.date && (type === "date" || type === "time" || type === "timestamp" || type === "timestamptz")) {
    return format.date.pattern === undefined ? null : excelDateCode(format.date.pattern);
  }
  return null;
}
