/**
 * Tables in memory: what a host gives the engine, and the checks that make them tables of docs/spec.md
 * §2: columns of §2.1 with unique names, and rows of typed JSON values (§2.2).
 */
import { type Column, isValueOf, type JsonValue, LOGICAL_TYPES, typeName } from "vastgrid-spec";
import type { ColumnNumbers } from "vastgrid-spec/columns";
import type { SheetInfo } from "vastgrid-spec/workbook";

/**
 * A column's values by row ID as typed JSON (§2.2): an array of them, or a column of an Arrow table
 * (`ColumnValues` of vastgrid-spec), whose numbers a sort reads without making JSON.
 */
export interface Vector {
  readonly length: number;
  at(row: number): JsonValue;
  readonly numbers?: ColumnNumbers | null;
  readonly validity?: Uint8Array | null;
}

/** An array of typed JSON as a vector, which arrays are: they have `length` and `at`. */
export function vectorOf(values: readonly JsonValue[]): Vector {
  return values as unknown as Vector;
}

/** A table in memory: its columns (§2.1), and its rows of typed JSON values (§2.2) in row ID order. */
export interface MemoryTable {
  columns: Column[];
  rows: JsonValue[][];
  /**
   * Whether `write` writes the table's cells (§7). Written values are kept apart from `rows`, which stay as the
   * host gave them, and every later request sees them.
   */
  editable?: boolean;
}

/**
 * A table as Apache Arrow (§2.3): the bytes of an IPC stream or file, of any number of record batches. Its
 * columns have the logical types of their Arrow types, and are kept as Arrow holds them: values of fixed width
 * as typed arrays, which sorts read as they are, and the others read when they are asked for.
 */
export interface ArrowTable {
  arrow: Uint8Array;
  /** Whether `write` writes the table's cells (§7), as for a `MemoryTable`. */
  editable?: boolean;
}

/** What a text file is read from: a `Blob` or a `File`, or anything that gives its bytes in slices as they do. */
export interface TextFile {
  readonly size: number;
  /** The file's name, whose extension tells its format when the table does not. */
  readonly name?: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** The formats of text files: CSV, TSV and JSON Lines; and `xlsx`, of Excel workbooks. */
export type TextFormat = "csv" | "tsv" | "jsonl" | "xlsx";

/**
 * A table as a text file: CSV, TSV or JSON Lines in UTF-8, read whole into typed columns when it is first opened.
 * Each column has the first of the types boolean, integer, bigint, float, time, date, timestamp and timestamptz
 * that every value of it fits, and otherwise is a string. Or a sheet of an Excel workbook (`.xlsx`, `.xlsm`), which
 * `open` chooses with `read` (§8.2): its columns have the types that the DuckDB engine reads them as.
 */
export interface FileTable {
  /** The file, a `Blob` or a `File`: in a Web Worker or the page, read in slices without a copy of it whole. */
  file: TextFile;
  /**
   * `csv`, `tsv`, `jsonl` or `xlsx`; by default from the file's name (`.csv`, `.tsv` or `.tab`, `.jsonl` or
   * `.ndjson`, `.xlsx` or `.xlsm`).
   */
  format?: TextFormat;
  /**
   * The field separator of a CSV file, one character; by default the one of `,`, tab, `;` and `|` that splits its
   * first line into the most fields.
   */
  delimiter?: string;
  /** Whether the first line of a CSV or TSV file names the columns (default true). */
  header?: boolean;
  /**
   * The most memory, in bytes, that the table's columns may take (default 1 GiB). A file whose columns would take
   * more is not kept: its rows are read by blocks, and its columns whole as requests need them, within this.
   */
  maxBytes?: number;
  /** Whether `write` writes the table's cells (§7), as for a `MemoryTable`. */
  editable?: boolean;
}

/** An answer of `fetch`, as the page, Web Workers and Node.js give it. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** `fetch`, or a function that answers as it does. */
export type HttpFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string> },
) => Promise<HttpResponse>;

/**
 * A table as a Parquet file, read by byte ranges: its footer when it is opened, then the row groups of the rows that
 * requests read, and whole only the columns that a view sorts, filters or groups by. Columns have the types that
 * DuckDB reads them as.
 */
export interface ParquetTable {
  /**
   * The file: a `Blob` or a `File`, or the URL of a file whose server answers range requests (HTTP `Range`), with
   * CORS that exposes `Content-Length`, `Content-Range` and `ETag` on another origin.
   */
  parquet: TextFile | string;
  /** Headers of every request for a URL, such as `Authorization`. */
  headers?: Record<string, string>;
  /** A `fetch` to use instead of the global one. */
  fetch?: HttpFetch;
  /**
   * About the most memory, in bytes, that the columns read whole may take (default 1 GiB). Those that no request
   * reads are forgotten when another needs their room; a request that would read more at once fails with
   * `load_failed`.
   */
  maxBytes?: number;
  /** Whether `write` writes the table's cells (§7), as for a `MemoryTable`. */
  editable?: boolean;
}

/**
 * A table that does not follow §2, or a file that cannot be read, which the engine answers with `load_failed`
 * (§8.7); a file that changed while it was open with `file_changed`.
 */
export class TableProblem extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly code: "load_failed" | "file_changed" = "load_failed",
  ) {
    super(message);
    this.name = "TableProblem";
  }
}

const COLUMN_MEMBERS = ["name", "type", "precision", "scale", "bits", "unit", "sourceType", "readOnly"];
const UNITS = ["s", "ms", "us", "ns"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** A value as a problem shows it: its JSON, cut to a length that reads. */
export function shown(value: unknown): string {
  const text = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Checks a column of a table (§2.1), and gives a copy of it. */
function checkColumn(value: unknown, path: string): Column {
  if (!isObject(value)) throw new TableProblem(path, "A column is an object: { name, type, … } (§2.1).");
  for (const key of Object.keys(value)) {
    if (!COLUMN_MEMBERS.includes(key))
      throw new TableProblem(`${path}/${key}`, `"${key}" is not a member of a column (§2.1).`);
  }
  const { name, type } = value;
  if (typeof name !== "string") throw new TableProblem(`${path}/name`, "A column's name is a string.");
  if (typeof type !== "string" || !(LOGICAL_TYPES as readonly string[]).includes(type)) {
    throw new TableProblem(`${path}/type`, `${shown(type)} is not a type of §2.1.`);
  }
  if (type === "decimal") {
    if (!isInteger(value.precision, 1, 38))
      throw new TableProblem(`${path}/precision`, "A decimal's precision is from 1 to 38.");
    if (!isInteger(value.scale, 0, value.precision))
      throw new TableProblem(`${path}/scale`, "A decimal's scale is from 0 to its precision.");
  } else {
    for (const member of ["precision", "scale"]) {
      if (value[member] !== undefined)
        throw new TableProblem(`${path}/${member}`, "Only decimals have a precision and a scale.");
    }
  }
  if (value.bits !== undefined && (type !== "float" || (value.bits !== 32 && value.bits !== 64))) {
    throw new TableProblem(`${path}/bits`, "bits is 32 or 64, for floats.");
  }
  if (value.unit !== undefined && (type !== "timestamp" || !UNITS.includes(value.unit as string))) {
    throw new TableProblem(`${path}/unit`, "unit is s, ms, us or ns, for timestamps.");
  }
  if (value.sourceType !== undefined && typeof value.sourceType !== "string") {
    throw new TableProblem(`${path}/sourceType`, "sourceType is a string.");
  }
  if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") {
    throw new TableProblem(`${path}/readOnly`, "readOnly is a boolean.");
  }
  return { ...value } as unknown as Column;
}

/** A table that the engine reads: its columns, and its host's rows or its Arrow columns. */
export interface CheckedTable {
  columns: Column[];
  rows: readonly (readonly JsonValue[])[] | null;
  vectors: Vector[] | null;
  rowCount: number;
  /** The file of a table whose columns are read when requests need them: a Parquet file, or a large text file. */
  reader?: import("./lazy.js").FileColumns;
  /** The sheets of a workbook, the one read, and what its reading changed (§8.2). */
  workbook?: { sheets: SheetInfo[]; sheet: string; notes: string[] };
}

/** Throws a `TableProblem` at `path(index)` for the first column whose name an earlier column has. */
export function checkNames(columns: readonly Column[], path: (index: number) => string) {
  const names = new Set<string>();
  columns.forEach((column, index) => {
    if (names.has(column.name)) throw new TableProblem(path(index), `"${column.name}" names two columns.`);
    names.add(column.name);
  });
}

/** Whether a host's table is given as Arrow (`ArrowTable`), which `checkArrow` of arrow.ts checks. */
export function isArrowTable(table: unknown): table is ArrowTable {
  return isObject(table) && "arrow" in table;
}

/** Whether a host's table is given as a Parquet file (`ParquetTable`), which parquet.ts reads. */
export function isParquetTable(table: unknown): table is ParquetTable {
  return isObject(table) && "parquet" in table;
}

/** Whether a host's table is given as a text file (`FileTable`), which `readFile` of text.ts reads. */
export function isFileTable(table: unknown): table is FileTable {
  return isObject(table) && "file" in table;
}

/** Whether a table given as a file is an Excel workbook, which workbook.ts reads. */
export function isWorkbook(table: FileTable): boolean {
  if (table.format !== undefined) return table.format === "xlsx";
  const name = isObject(table.file) ? table.file.name : undefined;
  return typeof name === "string" && /\.xls[xm]$/i.test(name);
}

/**
 * Checks the form of a table given as rows against §2: its columns, with unique names, and rows of one value per
 * column. Gives copies of the columns. Throws a `TableProblem` with the JSON Pointer of the first member at fault.
 * The values are checked as they are read (`valueChecker`), so that opening a table of millions of rows costs
 * nothing per value.
 */
export function checkTable(table: unknown): CheckedTable {
  if (!isObject(table))
    throw new TableProblem("", "A table is an object: { columns, rows }, { arrow }, { file } or { parquet }.");
  if (!Array.isArray(table.columns)) throw new TableProblem("/columns", "columns is a list of columns (§2.1).");
  const columns = table.columns.map((column, index) => checkColumn(column, `/columns/${index}`));
  checkNames(columns, (index) => `/columns/${index}/name`);
  const rows = table.rows;
  if (!Array.isArray(rows)) throw new TableProblem("/rows", "rows is a list of rows.");
  for (let row = 0; row < rows.length; row++) {
    const values = rows[row];
    if (!Array.isArray(values) || values.length !== columns.length) {
      throw new TableProblem(`/rows/${row}`, `A row is a list of ${columns.length} values, one per column.`);
    }
  }
  return { columns, rows, vectors: null, rowCount: rows.length };
}

/**
 * Checks the values of a column of a table (§2.2): a function of a value and its row that throws a
 * `TableProblem` at `/rows/{row}/{index}` for a value that is not of the column's type.
 */
export function valueChecker(column: Column, index: number): (value: unknown, row: number) => void {
  return (value, row) => {
    if (
      value !== null &&
      !(
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
        isValueOf(value, column)
      )
    ) {
      throw new TableProblem(
        `/rows/${row}/${index}`,
        `${shown(value)} is not a ${typeName(column)} value of column "${column.name}" (§2.2).`,
      );
    }
  };
}

/**
 * The value of a column of an Arrow table at a row. A value that has no typed JSON, such as text that is not
 * UTF-8 or a time beyond a day, throws a `TableProblem` at `/rows/{row}/{index}`.
 */
export function vectorValue(vector: Vector, column: Column, index: number, row: number): JsonValue {
  try {
    return vector.at(row);
  } catch (error) {
    throw new TableProblem(
      `/rows/${row}/${index}`,
      `the value is not a ${typeName(column)} value of column "${column.name}" (§2.2): ${(error as Error).message}`,
    );
  }
}
