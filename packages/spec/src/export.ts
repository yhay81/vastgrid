/**
 * Writes the text formats of `export` (docs/spec.md §8.2) from rows of typed JSON (§2.2), as a stream of bytes so
 * that only one batch of rows is in memory at a time; every engine writes them alike.
 *
 * CSV and TSV are written as DuckDB's `COPY` writes them: a header line, values as their text forms (§2.4), quoted
 * when they are the empty string or hold a quote, the separator or a line break, null as an empty field, lines
 * ending with LF. JSON is an array of objects by column name, one object to a line: integers, bigints and
 * decimals are JSON numbers with all their digits, floats as their text forms (`30.0`, `1e+21`) and those that are
 * not finite as text (`"nan"`, `"inf"`), booleans as such, and the other values as text.
 */
import type { Column, JsonValue } from "./types.js";
import { textOf } from "./values.js";

/** Rows in batches, each an array of rows of values in column order. */
export type RowBatches = AsyncIterable<JsonValue[][]> | Iterable<JsonValue[][]>;

/** A field of CSV or TSV, quoted as DuckDB quotes fields. */
export function delimitedField(text: string, delimiter: string): string {
  return text === "" || /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A value as JSON text, as `writeJson` writes it. */
export function jsonValueText(value: JsonValue, column: Column): string {
  if (value === null) return "null";
  switch (column.type) {
    case "boolean":
      return value === true ? "true" : "false";
    case "integer":
    case "bigint":
    case "decimal":
      return String(value);
    case "float": {
      const text = textOf(value, column) as string;
      return /^-?(?:nan|inf)$/.test(text) ? `"${text}"` : text;
    }
    default:
      return JSON.stringify(textOf(value, column));
  }
}

/** Writes CSV (`,`) or TSV (tab): a header line of `headers`, then the rows. */
export async function* writeDelimited(
  columns: Column[],
  headers: string[],
  rows: RowBatches,
  delimiter: "," | "\t",
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  yield encoder.encode(`${headers.map((text) => delimitedField(text, delimiter)).join(delimiter)}\n`);
  for await (const batch of rows) {
    let text = "";
    for (const values of batch) {
      for (let index = 0; index < columns.length; index++) {
        if (index > 0) text += delimiter;
        const value = values[index] ?? null;
        if (value !== null) text += delimitedField(textOf(value, columns[index]) as string, delimiter);
      }
      text += "\n";
    }
    yield encoder.encode(text);
  }
}

/** Writes JSON: an array of objects by column name, with the layout of DuckDB's `COPY (FORMAT json, ARRAY true)`. */
export async function* writeJson(columns: Column[], rows: RowBatches): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const keys = columns.map((column) => `${JSON.stringify(column.name)}:`);
  let first = true;
  yield encoder.encode("[\n");
  for await (const batch of rows) {
    let text = "";
    for (const values of batch) {
      text += first ? "\t{" : ",\n\t{";
      first = false;
      for (let index = 0; index < columns.length; index++) {
        if (index > 0) text += ",";
        text += keys[index] + jsonValueText(values[index] ?? null, columns[index]);
      }
      text += "}";
    }
    yield encoder.encode(text);
  }
  yield encoder.encode(first ? "]\n" : "\n]\n");
}
