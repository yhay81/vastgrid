import { isNumericType } from "./column-type.js";
import type { CellValue, ExportFormat } from "./types.js";
import { browserDeflate, type ExportColumn, writeXlsx, type XlsxOptions } from "./xlsx-writer.js";

/** Formats `writeTableFile` can write. Parquet needs an engine (for example `vastgrid-duckdb`). */
export const TABLE_FILE_FORMATS = ["csv", "tsv", "json", "xlsx"] as const satisfies readonly ExportFormat[];

export type TableFileFormat = (typeof TABLE_FILE_FORMATS)[number];

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: ".csv",
  tsv: ".tsv",
  parquet: ".parquet",
  json: ".json",
  xlsx: ".xlsx",
};

export const EXPORT_MEDIA_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  parquet: "application/vnd.apache.parquet",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function delimited(value: CellValue, delimiter: string) {
  if (value === null) return "";
  const text = String(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function jsonValue(value: CellValue, numeric: boolean) {
  // Numeric text (64-bit integers, decimals) keeps its digits as a JSON number.
  if (numeric && typeof value === "string" && jsonNumber.test(value)) return value;
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  return JSON.stringify(value);
}

/**
 * Writes rows as a file, for sources that export in the browser or in their own process. `rows` come
 * in batches (arrays of rows, each an array of values in column order); the bytes come out as they
 * are made, so that a stream can be written without holding the whole file.
 *
 * `csv` and `tsv`: a header row, then the values as text (RFC 4180 quoting; `null` is empty). `json`:
 * an array of objects keyed by column name. `xlsx`: see `writeXlsx`.
 */
export async function* writeTableFile(
  format: TableFileFormat,
  columns: ExportColumn[],
  rows: AsyncIterable<CellValue[][]> | Iterable<CellValue[][]>,
  options: XlsxOptions = {},
): AsyncGenerator<Uint8Array> {
  if (format === "xlsx") {
    yield* writeXlsx(columns, rows, { deflate: browserDeflate(), ...options });
    return;
  }
  const encoder = new TextEncoder();
  const signal = options.signal;
  if (format === "json") {
    const keys = columns.map((column) => `${JSON.stringify(column.name)}:`);
    const numeric = columns.map((column) => isNumericType(column.type));
    let first = true;
    yield encoder.encode("[");
    for await (const batch of rows) {
      if (signal?.aborted) throw signal.reason;
      let text = "";
      for (const row of batch) {
        text += `${first ? "\n" : ",\n"}{${keys.map((key, index) => key + jsonValue(row[index] ?? null, numeric[index])).join(",")}}`;
        first = false;
      }
      yield encoder.encode(text);
    }
    yield encoder.encode(first ? "]\n" : "\n]\n");
    return;
  }
  const delimiter = format === "tsv" ? "\t" : ",";
  yield encoder.encode(`${columns.map((column) => delimited(column.name, delimiter)).join(delimiter)}\n`);
  for await (const batch of rows) {
    if (signal?.aborted) throw signal.reason;
    let text = "";
    for (const row of batch) {
      text += `${columns.map((_, index) => delimited(row[index] ?? null, delimiter)).join(delimiter)}\n`;
    }
    yield encoder.encode(text);
  }
}
