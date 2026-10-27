/**
 * Exporting views (docs/v2-spec.md §8.2) as the bytes of a file, which the engine answers as `data`: CSV, TSV and
 * JSON by `vastgrid-spec/export` and workbooks by `vastgrid-spec/xlsx`, as the DuckDB engine writes them. The rows
 * go to the writer in batches, each written as its bytes, so that no text holds the whole file. Loaded with the
 * first export.
 */
import type { Column, JsonValue } from "vastgrid-spec";
import { writeDelimited, writeJson } from "vastgrid-spec/export";
import { checkXlsxSize, webDeflate, writeXlsx } from "vastgrid-spec/xlsx";

/** The formats that this engine writes; Parquet needs a writer that it does not have. */
export type MemoryExportFormat = "csv" | "tsv" | "json" | "xlsx";

/** Rows written at a time. */
const BATCH = 4_096;

export interface ExportJob {
  format: MemoryExportFormat;
  columns: Column[];
  headers: string[];
  numberFormats: (string | null)[] | null;
  rowCount: number;
  /** The values of the view's row at a position, in the order of `columns`. */
  row(position: number): JsonValue[];
  /** Called between batches: lets other messages in, and throws when the export was cancelled. */
  pause(): Promise<void>;
}

/** The rows of the view in batches. */
async function* batches(job: ExportJob): AsyncGenerator<JsonValue[][]> {
  for (let start = 0; start < job.rowCount; start += BATCH) {
    await job.pause();
    const end = Math.min(job.rowCount, start + BATCH);
    const batch: JsonValue[][] = new Array(end - start);
    for (let position = start; position < end; position++) batch[position - start] = job.row(position);
    yield batch;
  }
}

/** The file's bytes in chunks, as they are made. */
function chunks(job: ExportJob): AsyncIterable<Uint8Array> {
  const { format, columns, headers } = job;
  if (format === "json") return writeJson(columns, batches(job));
  if (format !== "xlsx") return writeDelimited(columns, headers, batches(job), format === "tsv" ? "\t" : ",");
  const deflate = webDeflate();
  return writeXlsx(
    columns.map((column, index) => ({
      name: headers[index],
      type: column.type,
      numberFormat: job.numberFormats?.[index] ?? null,
    })),
    batches(job),
    deflate ? { deflate } : {},
  );
}

/** Writes the view's rows as a file of `job.format`, and gives its bytes. */
export async function writeExport(job: ExportJob): Promise<Uint8Array> {
  if (job.format === "xlsx") checkXlsxSize(job.rowCount, job.columns.length);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks(job)) {
    parts.push(chunk);
    size += chunk.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
