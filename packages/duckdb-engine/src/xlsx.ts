/**
 * Reads Excel workbooks (`.xlsx`, `.xlsm`) on disk with `vastgrid-spec/workbook`: the ZIP archive is read with
 * `node:fs` and `node:zlib`, and the sheet is written to a CSV file with one type per column, which DuckDB then loads
 * like any other delimited file.
 */
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { pipeline, Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import {
  type ConvertOptions,
  convertSheet as convertSheetLines,
  type ReadOptions,
  readWorkbook as readWorkbookOf,
  type SheetInfo,
  sheetList,
  type WorkbookSource,
} from "vastgrid-spec/workbook";
import { quoteIdentifier } from "vastgrid-sql";
import { quoteLiteral } from "./session.js";

export { readOptionsOf, WorkbookError } from "vastgrid-spec/workbook";
export type { ReadOptions, SheetInfo };

/** The DuckDB types of the logical types that a sheet's columns have. */
const SQL_TYPES: Record<string, string> = {
  bigint: "BIGINT",
  float: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
  time: "TIME",
  string: "VARCHAR",
};

async function* readRange(handle: FileHandle, start: number, end: number, onRead?: (bytes: number) => void) {
  let offset = start;
  while (offset < end) {
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, end - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    onRead?.(bytesRead);
    yield buffer.subarray(0, bytesRead);
  }
}

/** Opens a workbook on disk once and reads ranges and streams from its file descriptor. */
async function withFileSource<T>(file: string, run: (source: WorkbookSource) => Promise<T>): Promise<T> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    return await run({
      size,
      async bytes(start, end) {
        const length = Math.max(0, Math.min(end, size) - start);
        const bytes = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(bytes, 0, length, start);
        return bytes.subarray(0, bytesRead);
      },
      async *text(start, end, deflated, onRead) {
        if (end <= start) return;
        const input = Readable.from(readRange(handle, start, end, onRead));
        const output = deflated ? pipeline(input, createInflateRaw({ chunkSize: 256 * 1024 }), () => undefined) : input;
        output.setEncoding("utf8");
        for await (const chunk of output) yield chunk as string;
      },
    });
  } finally {
    await handle.close();
  }
}

export interface ConvertedSheet {
  sheet: string;
  /** A `FROM` item (a subquery reading the CSV file as `$1`) with the columns in order. */
  reader: string;
  names: string[];
  notes: string[];
}

/**
 * Reads a workbook's sheet list and converts the chosen sheet to a CSV file (`target`) that DuckDB reads with
 * `reader`: the lines of `convertSheet` of `vastgrid-spec/workbook`, each starting with the row's number in the
 * sheet.
 */
export async function convertWorkbookSheet(
  file: string,
  target: string,
  onSheets: (sheets: SheetInfo[]) => void,
  onConvert: (convert: () => Promise<ConvertedSheet>) => Promise<ConvertedSheet>,
  options: Omit<ConvertOptions, "workbook"> = {},
): Promise<ConvertedSheet> {
  return withFileSource(file, async (source) => {
    const workbook = await readWorkbookOf(source);
    onSheets(sheetList(workbook));
    return onConvert(async () => {
      const output = createWriteStream(target);
      let sheet: Awaited<ReturnType<typeof convertSheetLines>>;
      try {
        sheet = await convertSheetLines(
          source,
          async (text) => {
            // `once` rejects when the file cannot be written.
            if (!output.write(text)) await once(output, "drain");
          },
          { ...options, workbook },
        );
      } catch (error) {
        output.destroy();
        throw error;
      }
      output.end();
      await once(output, "finish");
      const columns = sheet.columns.map((column) => ({ ...column, sqlType: SQL_TYPES[column.type] }));
      const definitions = [`${quoteLiteral("r")}: 'BIGINT'`];
      const used = new Map(columns.map((column) => [column.field, column]));
      for (let field = 1; field < sheet.fields; field++) {
        definitions.push(`${quoteLiteral(`c${field - 1}`)}: ${quoteLiteral(used.get(field)?.sqlType ?? "VARCHAR")}`);
      }
      const selected = columns.map(
        (column, index) => `${quoteIdentifier(`c${column.field - 1}`)} AS ${quoteIdentifier(`x${index}`)}`,
      );
      const reader =
        `(SELECT ${selected.join(", ")} FROM read_csv($1, header=false, auto_detect=false, delim=',', quote='"', ` +
        `escape='"', null_padding=true, max_line_size=16777216, columns={${definitions.join(", ")}}))`;
      return {
        sheet: sheet.sheet,
        reader,
        names: columns.map((column) => column.name),
        notes: sheet.notes,
      };
    });
  });
}
