/**
 * Reads Excel workbooks (`.xlsx`, `.xlsm`) on disk with `vastgrid-spec/workbook`: the ZIP archive is read with
 * `node:fs` and `node:zlib`, and the sheet is written to a CSV file with one type per column, which DuckDB then loads
 * like any other delimited file.
 */
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { createInflateRaw } from "node:zlib";
import {
  type ConvertOptions,
  convertSheet as convertSheetLines,
  type ReadOptions,
  readWorkbook as readWorkbookOf,
  type SheetInfo,
  type Workbook,
  type WorkbookSource,
} from "vastgrid-spec/workbook";
import { quoteIdentifier } from "vastgrid-sql";

export { sheetList, WorkbookError } from "vastgrid-spec/workbook";
export type { ReadOptions, SheetInfo, Workbook };

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

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

/** A workbook on disk, read by ranges with `node:fs` and inflated with `node:zlib`. */
async function fileSource(file: string): Promise<WorkbookSource> {
  const { size } = await stat(file);
  return {
    size,
    async bytes(start, end) {
      const handle = await open(file, "r");
      try {
        const bytes = Buffer.alloc(Math.max(0, Math.min(end, size) - start));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
        return bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async *text(start, end, deflated, onRead) {
      const input = createReadStream(file, { start, end: end - 1, highWaterMark: 256 * 1024 });
      if (onRead) input.on("data", (chunk) => onRead(chunk.length));
      const output = deflated ? pipeline(input, createInflateRaw({ chunkSize: 256 * 1024 }), () => undefined) : input;
      output.setEncoding("utf8");
      try {
        for await (const chunk of output) yield chunk as string;
      } finally {
        input.destroy();
      }
    },
  };
}

/** Reads the list of sheets and where the other parts of the workbook are. */
export async function readWorkbook(file: string): Promise<Workbook> {
  return readWorkbookOf(await fileSource(file));
}

/** One column of the sheet in the converted file. */
export interface WorkbookColumn {
  name: string;
  sqlType: string;
  /** The column's letters in the sheet. */
  letters: string;
}

export interface ConvertedSheet {
  sheets: SheetInfo[];
  sheet: string;
  columns: WorkbookColumn[];
  /** A `FROM` item (a subquery reading the CSV file as `$1`) with the columns in order. */
  reader: string;
  rows: number;
  notes: string[];
}

/**
 * Converts one sheet of a workbook to a CSV file (`target`) that DuckDB reads with `reader`: the lines of
 * `convertSheet` of `vastgrid-spec/workbook`, each starting with the row's number in the sheet.
 */
export async function convertSheet(
  file: string,
  target: string,
  options: ConvertOptions = {},
): Promise<ConvertedSheet> {
  const source = await fileSource(file);
  const output = createWriteStream(target);
  let sheet: Awaited<ReturnType<typeof convertSheetLines>>;
  try {
    sheet = await convertSheetLines(
      source,
      async (text) => {
        // `once` rejects when the file cannot be written.
        if (!output.write(text)) await once(output, "drain");
      },
      options,
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
    (column) => `${quoteIdentifier(`c${column.field - 1}`)} AS ${quoteIdentifier(column.name)}`,
  );
  const reader =
    `(SELECT ${selected.join(", ")} FROM read_csv($1, header=false, auto_detect=false, delim=',', quote='"', ` +
    `escape='"', null_padding=true, max_line_size=16777216, columns={${definitions.join(", ")}}))`;
  return {
    sheets: sheet.sheets,
    sheet: sheet.sheet,
    columns: columns.map(({ name, sqlType, letters }) => ({ name, sqlType, letters })),
    reader,
    rows: sheet.rows,
    notes: sheet.notes,
  };
}
