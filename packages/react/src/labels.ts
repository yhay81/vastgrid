import { type CellValue, type ColumnFormatter, type Filter, plainText } from "vastgrid-core";
import type { Messages } from "./messages.js";

/** Formats counts with the locale's grouping. */
export function countFormat(locale: string | undefined) {
  const format = new Intl.NumberFormat(locale);
  return (value: number) => format.format(value);
}

/** Formats summary numbers (sums, averages) with up to 6 fraction digits. */
export function numberFormat(locale: string | undefined) {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  return (value: number) => format.format(value);
}

function valueText(value: CellValue, formatter: ColumnFormatter | undefined, messages: Messages) {
  if (value === null || value === "") return messages.blank;
  return formatter ? formatter.format(value) : plainText(value);
}

/** A short description of a filter, for chips ("price ≥ 100", "city: Tokyo +2"). */
export function filterLabel(filter: Filter, formatter: ColumnFormatter | undefined, messages: Messages) {
  const name = formatter?.label ?? `#${filter.column}`;
  switch (filter.type) {
    case "values": {
      const shown = filter.values.slice(0, 2).map((value) => valueText(value, formatter, messages));
      const more = filter.values.length > 2 ? ` +${filter.values.length - 2}` : "";
      return `${name} ${filter.exclude ? "≠" : ":"} ${shown.join(", ")}${more}`;
    }
    case "compare": {
      const symbols = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" } as const;
      return `${name} ${symbols[filter.op]} ${plainText(filter.value)}`;
    }
    case "between":
      return `${name}: ${filter.min === undefined ? "" : plainText(filter.min)}–${filter.max === undefined ? "" : plainText(filter.max)}`;
    case "text":
      return `${name} ${messages.operators[filter.op]} “${filter.value}”`;
    case "blank":
      return `${name}: ${filter.blank ? messages.operators.blank : messages.operators.notBlank}`;
  }
}
