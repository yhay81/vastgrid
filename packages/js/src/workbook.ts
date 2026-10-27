/**
 * Excel workbooks as tables: a sheet is read with `vastgrid-spec/workbook` into lines of CSV kept as a `Blob`, which
 * `readFile` of text.ts then reads as it reads a CSV file, within `maxBytes`, with the columns and types that the
 * DuckDB engine reads the sheet with.
 */
import type { Column } from "vastgrid-spec";
import { blobSource, convertSheet, type ReadOptions, WorkbookError } from "vastgrid-spec/workbook";
import { type CheckedTable, type FileTable, TableProblem, type TextFile } from "./table.js";
import { readFile } from "./text.js";

/** The platform's `Blob`, which keeps the sheet's lines out of the heap where it can (in a page, on disk). */
declare const Blob: new (parts: (string | TextFile)[]) => TextFile;

/** The options of `open` that change how a workbook is read (§8.2), with only those given, in one order. */
export function readOptionsOf(read: unknown): ReadOptions {
  const options: ReadOptions = {};
  if (read === null || typeof read !== "object") return options;
  const { sheet, headerRow, keepEmptyRows, keepEmptyColumns } = read as ReadOptions;
  if (sheet !== undefined) options.sheet = sheet;
  if (headerRow !== undefined) options.headerRow = headerRow;
  if (keepEmptyRows) options.keepEmptyRows = true;
  if (keepEmptyColumns) options.keepEmptyColumns = true;
  return options;
}

/** Reads the sheet of a workbook that `read` chooses, the first visible one by default. */
export async function readSheet(table: FileTable, read: ReadOptions): Promise<CheckedTable> {
  const { file } = table;
  if (
    file === null ||
    typeof file !== "object" ||
    typeof file.size !== "number" ||
    typeof (file as { slice?: unknown }).slice !== "function"
  ) {
    throw new TableProblem("/file", "file is a Blob or a File.");
  }
  const parts: TextFile[] = [];
  let sheet: Awaited<ReturnType<typeof convertSheet>>;
  try {
    sheet = await convertSheet(
      blobSource(file),
      (text) => {
        parts.push(new Blob([text]));
      },
      read,
    );
  } catch (error) {
    if (error instanceof WorkbookError) throw new TableProblem("/file", error.message);
    throw error;
  }
  const fields: (Column | null)[] = new Array(sheet.fields).fill(null);
  for (const column of sheet.columns) fields[column.field] = { name: column.name, type: column.type };
  const lines: FileTable = { file: new Blob(parts), format: "csv", delimiter: ",", header: false };
  if (table.maxBytes !== undefined) lines.maxBytes = table.maxBytes;
  const checked = await readFile(lines, undefined, fields);
  return { ...checked, workbook: { sheets: sheet.sheets, sheet: sheet.sheet, notes: sheet.notes } };
}
