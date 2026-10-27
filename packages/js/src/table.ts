/**
 * Tables in memory: what a host gives the engine, and the checks that make them tables of docs/v2-spec.md
 * §2: columns of §2.1 with unique names, and rows of typed JSON values (§2.2).
 */
import { type Column, isValueOf, type JsonValue, LOGICAL_TYPES, typeName } from "vastgrid-spec";
import type { ColumnNumbers } from "vastgrid-spec/columns";

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

/** A table that does not follow §2, which the engine answers with `load_failed` (§8.7). */
export class TableProblem extends Error {
  constructor(
    readonly path: string,
    message: string,
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

/**
 * Checks the form of a table given as rows against §2: its columns, with unique names, and rows of one value per
 * column. Gives copies of the columns. Throws a `TableProblem` with the JSON Pointer of the first member at fault.
 * The values are checked as they are read (`valueChecker`), so that opening a table of millions of rows costs
 * nothing per value.
 */
export function checkTable(table: unknown): CheckedTable {
  if (!isObject(table)) throw new TableProblem("", "A table is an object: { columns, rows } or { arrow }.");
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
