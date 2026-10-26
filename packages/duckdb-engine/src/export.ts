/**
 * Exporting views (docs/v2-spec.md §8.2): the rows of a view, in its order, written by DuckDB (`COPY`) as CSV, TSV,
 * Parquet or JSON, or streamed into a workbook (`xlsx-writer.ts`), into a temporary file that is renamed once it is
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
import { quoteIdentifier } from "vastgrid-sql";
import { readExpression, readValue } from "./columns.js";
import { quoteLiteral } from "./session.js";
import type { View } from "./view.js";
import { checkXlsxSize, writeXlsx, XLSX_MAX_TEXT } from "./xlsx-writer.js";

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
  // DuckDB renames repeated names in a header ("x", "x_1"): a CSV or TSV file with repeated headers, or headers
  // that DuckDB would change, gets its header line written here instead.
  const delimited = format === "csv" || format === "tsv";
  const delimiter = format === "tsv" ? "\t" : ",";
  const ownHeader = delimited && new Set(headers).size !== headers.length;
  const selected = columns.map((column, index) => {
    const name = quoteIdentifier(column.name);
    return delimited && !ownHeader && headers[index] !== column.name
      ? `${name} AS ${quoteIdentifier(headers[index])}`
      : name;
  });
  const header = ownHeader ? "false" : "true";
  const options = {
    csv: `FORMAT csv, HEADER ${header}`,
    tsv: `FORMAT csv, HEADER ${header}, DELIMITER '\\t'`,
    parquet: "FORMAT parquet, COMPRESSION zstd",
    json: "FORMAT json, ARRAY true",
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

/** Streams the rows into a workbook: one chunk of rows from DuckDB at a time. */
async function writeWorkbook(connection: DuckDBConnection, job: ExportJob, file: string) {
  const { view, columns, headers, numberFormats, signal } = job;
  // Text is cut to Excel's limit in DuckDB already.
  const outputs = columns.map((column) => readExpression(column, quoteIdentifier(column.name), XLSX_MAX_TEXT));
  const result = await connection.stream(
    `${view.sql.with} SELECT ${outputs.length > 0 ? outputs.join(", ") : "NULL"} FROM vg_view ORDER BY ${view.position}`,
    view.sql.params as never,
  );
  async function* batches(): AsyncGenerator<JsonValue[][]> {
    for await (const rows of result.yieldRowsJs()) {
      yield rows.map((row) => columns.map((column, index) => readValue(column, row[index]).value));
    }
  }
  const workbook = writeXlsx(
    columns.map((column, index) => ({
      name: headers[index],
      type: column.type,
      numberFormat: numberFormats?.[index] ?? null,
    })),
    batches(),
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
