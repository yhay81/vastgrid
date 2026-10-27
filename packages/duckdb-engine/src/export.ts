/**
 * Exporting views (docs/spec.md §8.2): the rows of a view, in its order, written by DuckDB (`COPY`) as CSV, TSV or
 * Parquet, or streamed into JSON (`vastgrid-spec/export`) or a workbook (`vastgrid-spec/xlsx`), into a temporary file that is renamed once it is
 * complete. Nothing goes through the client: an export without a `target` is kept by the engine, for the host to
 * serve (`DuckDBEngine.exportFile`, and `<path>/exports/<name>` of the HTTP handler).
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, pipeline as streamPipeline } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib, { createDeflateRaw } from "node:zlib";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Column, JsonValue } from "vastgrid-spec";
import { writeJson } from "vastgrid-spec/export";
import { checkXlsxSize, writeXlsx, XLSX_MAX_TEXT } from "vastgrid-spec/xlsx";
import { quoteIdentifier, textSql } from "vastgrid-sql";
import { readExpression, readValue } from "./columns.js";
import { quoteLiteral } from "./session.js";
import type { View } from "./view.js";

export type ExportFormat = "csv" | "tsv" | "parquet" | "json" | "xlsx";

export const EXPORT_MEDIA_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  parquet: "application/vnd.apache.parquet",
  json: "application/json; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Compression of workbooks. Compressing takes most of the time: level 3 writes a million rows about twice as fast as
 * the default level 6, in a file about 10% larger.
 */
const DEFLATE_LEVEL = 3;

/** What an export writes: the view's columns, their headers (CSV, TSV, xlsx) and Excel formats (xlsx). */
export interface ExportJob {
  view: View;
  format: ExportFormat;
  columns: Column[];
  headers: string[];
  numberFormats?: (string | null)[];
  signal?: AbortSignal;
}

/** A field of a header line, quoted as DuckDB quotes fields. */
function headerField(text: string, delimiter: string) {
  return text === "" || /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Writes the rows of a view into a new file. A file that is not complete is the caller's to delete. */
export async function writeExport(connection: DuckDBConnection, job: ExportJob, file: string): Promise<void> {
  const { view, format, columns, headers } = job;
  const order = `ORDER BY ${view.position}`;
  if (format === "xlsx") {
    checkXlsxSize(view.rowCount, columns.length);
    await writeWorkbook(connection, job, file);
    return;
  }
  if (format === "json") {
    // DuckDB's JSON has NaN and Infinity, which JSON does not, float32 as the double it widens to, and
    // decimals of up to 18 digits as doubles (12.5 for 12.50): the rows are written here instead.
    await pipeline(
      Readable.from(writeJson(columns, rowsOf(connection, job))),
      createWriteStream(file, { flags: "wx" }),
    );
    return;
  }
  // DuckDB renames repeated names in a header ("x", "x_1"): a CSV or TSV file with repeated headers, or without
  // columns (whose rows DuckDB writes as a column NULL), gets its header line written here instead.
  const delimited = format === "csv" || format === "tsv";
  const delimiter = format === "tsv" ? "\t" : ",";
  const ownHeader = delimited && (columns.length === 0 || new Set(headers).size !== headers.length);
  const selected = columns.map((column, index) => {
    const name = quoteIdentifier(column.name);
    // DuckDB writes decimals without whole digits without their 0 (`.5`) and some 32-bit floats with all their
    // exact digits (5525.71875), unlike their text forms (§2.4), and a float of the view whose SQL keeps a FLOAT
    // (`abs` of a float32) as a FLOAT: as the view's type.
    let value = name;
    if (delimited && column.type === "decimal" && column.scale === column.precision) value = textSql(name, column);
    if (column.type === "float") value = `CAST(${name} AS ${column.bits === 32 ? "FLOAT" : "DOUBLE"})`;
    if (delimited && column.type === "float" && column.bits === 32) value = textSql(value, column);
    if (delimited && !ownHeader && headers[index] !== column.name)
      return `${value} AS ${quoteIdentifier(headers[index])}`;
    return value === name ? name : `${value} AS ${name}`;
  });
  const header = ownHeader ? "false" : "true";
  const options = {
    csv: `FORMAT csv, HEADER ${header}`,
    tsv: `FORMAT csv, HEADER ${header}, DELIMITER '\\t'`,
    // Without dictionaries when there are intervals: DuckDB's dictionaries keep one of the values that compare
    // equal, and "1 month" and "30 days" compare equal (§3.1), so one would be written for the other. A limit of
    // one byte leaves every column without one.
    parquet: columns.some((column) => column.type === "interval")
      ? "FORMAT parquet, COMPRESSION zstd, DICTIONARY_SIZE_LIMIT 1"
      : "FORMAT parquet, COMPRESSION zstd",
  }[format];
  const body = ownHeader ? `${file}.body` : file;
  try {
    await connection.run(
      `COPY (${view.sql.with} SELECT ${selected.length > 0 ? selected.join(", ") : "NULL"} FROM vg_view ${order}) TO ${quoteLiteral(body)} (${options})`,
      view.sql.params as never,
    );
    if (ownHeader) {
      await pipeline(
        async function* () {
          yield `${headers.map((text) => headerField(text, delimiter)).join(delimiter)}\n`;
          yield* createReadStream(body);
        },
        createWriteStream(file, { flags: "wx" }),
      );
    }
  } finally {
    if (ownHeader) await rm(body, { force: true });
  }
}

/** The view's rows as typed JSON, one chunk of rows from DuckDB at a time; text cut at `textLimit`. */
async function* rowsOf(connection: DuckDBConnection, job: ExportJob, textLimit = Number.MAX_SAFE_INTEGER) {
  const { view, columns, signal } = job;
  const outputs = columns.map((column) => readExpression(column, quoteIdentifier(column.name), textLimit));
  const result = await connection.stream(
    `${view.sql.with} SELECT ${outputs.length > 0 ? outputs.join(", ") : "NULL"} FROM vg_view ORDER BY ${view.position}`,
    view.sql.params as never,
  );
  for await (const rows of result.yieldRowsJs()) {
    if (signal?.aborted) throw signal.reason ?? new Error("The export was cancelled.");
    yield rows.map((row): JsonValue[] => columns.map((column, index) => readValue(column, row[index]).value));
  }
}

/** Streams the rows into a workbook: one chunk of rows from DuckDB at a time. */
async function writeWorkbook(connection: DuckDBConnection, job: ExportJob, file: string) {
  const { columns, headers, numberFormats, signal } = job;
  const workbook = writeXlsx(
    columns.map((column, index) => ({
      name: headers[index],
      type: column.type,
      numberFormat: numberFormats?.[index] ?? null,
    })),
    // Text is cut to Excel's limit in DuckDB already.
    rowsOf(connection, job, XLSX_MAX_TEXT),
    {
      // The callback form of `pipeline` gives the last stream, and passes an error of the rows on to it.
      deflate: (chunks) => streamPipeline(Readable.from(chunks), createDeflateRaw({ level: DEFLATE_LEVEL }), () => {}),
      ...(typeof zlib.crc32 === "function" ? { crc32: zlib.crc32 } : {}),
      signal,
    },
  );
  await pipeline(Readable.from(workbook), createWriteStream(file, { flags: "wx" }));
}

/** A file that an export without a `target` left for the host to serve. */
export interface KeptExport {
  /** Where the file is. */
  path: string;
  /** A name for the file when it is downloaded: the table's file name with the format's extension. */
  fileName: string;
  mediaType: string;
  size: number;
}

/**
 * The exports that the engine keeps, by name: at most `limit`, for at most `lifetime` milliseconds each; the oldest
 * go first. They are files of the session's folder, which the engine deletes when it closes.
 */
export class ExportStore {
  private readonly kept = new Map<string, KeptExport & { created: number }>();

  constructor(
    private readonly file: (name: string) => string,
    private readonly limit = 16,
    private readonly lifetime = 60 * 60 * 1000,
  ) {}

  /** A new file for an export of a format, and the name that it will be kept under. */
  reserve(format: ExportFormat): { name: string; path: string } {
    const name = `${randomBytes(12).toString("hex")}.${format}`;
    return { name, path: this.file(`export-${name}`) };
  }

  /** Keeps a complete export under its reserved name. */
  async keep(name: string, path: string, fileName: string, format: ExportFormat): Promise<void> {
    const { size } = await stat(path);
    this.kept.set(name, { path, fileName, mediaType: EXPORT_MEDIA_TYPES[format], size, created: Date.now() });
    await this.trim();
  }

  /** A kept export, or null when there is none of that name (any more). */
  get(name: string): KeptExport | null {
    const kept = this.kept.get(name);
    if (!kept || Date.now() - kept.created > this.lifetime) return null;
    return { path: kept.path, fileName: kept.fileName, mediaType: kept.mediaType, size: kept.size };
  }

  private async trim() {
    const now = Date.now();
    const entries = [...this.kept.entries()];
    for (const [index, [name, kept]] of entries.entries()) {
      if (entries.length - index <= this.limit && now - kept.created <= this.lifetime) continue;
      this.kept.delete(name);
      await rm(kept.path, { force: true });
    }
  }
}
