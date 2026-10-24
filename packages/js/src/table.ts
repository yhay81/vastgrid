/**
 * Tables in memory: what a host gives the engine, and the checks that make them tables of docs/v2-spec.md
 * §2: columns of §2.1 with unique names, and rows of typed JSON values (§2.2).
 */
import {
  type Column,
  isValueOf,
  type JsonValue,
  LOGICAL_TYPES,
  parseIntervalText,
  parseTimestampText,
  typeName,
} from "vastgrid-spec";

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
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const SURROGATE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE = /\p{Cs}/u;

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

/**
 * Whether a value is one of a column's (§2.2), beyond what `isValueOf` checks: strings are Unicode text
 * (§2.1), and intervals and timestamps in nanoseconds fit the 64 bits that blocks give them (§8.4).
 */
function valueCheck(column: Column): (value: unknown) => boolean {
  const typed = (value: unknown) =>
    value === null ||
    ((typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
      isValueOf(value, column));
  switch (column.type) {
    case "string":
      return (value) =>
        value === null || (typeof value === "string" && (!SURROGATE.test(value) || !LONE_SURROGATE.test(value)));
    case "interval":
      return (value) => {
        if (value === null) return true;
        const parts = typeof value === "string" ? parseIntervalText(value) : null;
        return parts !== null && parts.nanos >= INT64_MIN && parts.nanos <= INT64_MAX;
      };
    case "timestamp":
      if (column.unit !== "ns") return typed;
      return (value) => {
        if (!typed(value)) return false;
        const count = value === null ? 0n : parseTimestampText(value as string, "ns");
        return count !== null && count >= INT64_MIN && count <= INT64_MAX;
      };
    default:
      return typed;
  }
}

/**
 * Checks the form of a table against §2: its columns, with unique names, and rows of one value per column.
 * Gives copies of the columns. Throws a `TableProblem` with the JSON Pointer of the first member at fault.
 * The values are checked as they are read (`valueChecker`), so that opening a table of millions of rows costs
 * nothing per value.
 */
export function checkTable(table: unknown): Column[] {
  if (!isObject(table)) throw new TableProblem("", "A table is an object: { columns, rows }.");
  if (!Array.isArray(table.columns)) throw new TableProblem("/columns", "columns is a list of columns (§2.1).");
  const columns = table.columns.map((column, index) => checkColumn(column, `/columns/${index}`));
  const names = new Set<string>();
  columns.forEach((column, index) => {
    if (names.has(column.name)) throw new TableProblem(`/columns/${index}/name`, `"${column.name}" names two columns.`);
    names.add(column.name);
  });
  const rows = table.rows;
  if (!Array.isArray(rows)) throw new TableProblem("/rows", "rows is a list of rows.");
  for (let row = 0; row < rows.length; row++) {
    const values = rows[row];
    if (!Array.isArray(values) || values.length !== columns.length) {
      throw new TableProblem(`/rows/${row}`, `A row is a list of ${columns.length} values, one per column.`);
    }
  }
  return columns;
}

/**
 * Checks the values of a column of a table (§2.2): a function of a value and its row that throws a
 * `TableProblem` at `/rows/{row}/{index}` for a value that is not of the column's type.
 */
export function valueChecker(column: Column, index: number): (value: unknown, row: number) => void {
  const valid = valueCheck(column);
  return (value, row) => {
    if (!valid(value)) {
      throw new TableProblem(
        `/rows/${row}/${index}`,
        `${shown(value)} is not a ${typeName(column)} value of column "${column.name}" (§2.2).`,
      );
    }
  };
}
