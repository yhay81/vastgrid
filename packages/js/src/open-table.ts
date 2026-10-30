/**
 * The tables that the memory engine has open (docs/spec.md §8.2): their checked columns and rows, the values that
 * requests read of them, checked as they are read (§2.2), the values written over them (§7.2) and the ranks that
 * views sort by (§3.3).
 */
import type { Column, JsonValue } from "vastgrid-spec";
import { type ColumnRanks, rankColumn, rankColumnPausing } from "./order.js";
import { Failure, pause, type Running } from "./running.js";
import { type CheckedTable, shown, TableProblem, type Vector, valueChecker, vectorOf, vectorValue } from "./table.js";
import type { View } from "./view.js";

/** A table that is open: its checked columns, its rows, and what the engine computed of them. */
export interface Table {
  ref: string;
  /** The key of the table among those prepared: its `ref`, and the options a workbook is read with. */
  key: string;
  columns: Column[];
  /** The index of each column by name. */
  index: Map<string, number>;
  /** The host's rows, of a table given as rows; null for a table given as Arrow or as a file. */
  rows: readonly (readonly JsonValue[])[] | null;
  /** The typed columns of a table given as Arrow or as a file; null for a table given as rows. */
  vectors: Vector[] | null;
  /** The file of a table given as Parquet, whose columns are read when requests need them. */
  reader: import("./lazy.js").FileColumns | null;
  /** The module that reads the numbers of typed columns, for a table given as Arrow or as a file. */
  typed: typeof import("./numbers.js") | null;
  rowCount: number;
  revision: string;
  editable: boolean;
  /** The edits version and the cells written so far (§8.2). */
  edits: { version: number; cells: number };
  /** Cells written, as `row * columns + column`. */
  written: Set<number>;
  /** Row IDs by the key text of a value of a column, made when `write` or `locate` first needs them. */
  keys: Map<number, Map<string, number>>;
  /** The ranks of each column, made when a view first needs them. */
  ranks: (ColumnRanks | undefined)[];
  /** Checks of each column's values (§2.2); a column is checked whole before anything reads all of it. */
  checkers: ((value: unknown, row: number) => void)[];
  /**
   * Each checked column's values by row ID, which ranks, summaries and expressions read: of a table given as rows,
   * an array of the engine's own, which writes change; of one given as Arrow or as a file, its typed column, with
   * the values written over it (`writtenVector`).
   */
  values: (Vector | undefined)[];
  /** The values written to each typed column by row ID, kept apart from the column, which is not copied. */
  overlays: (Map<number, JsonValue> | undefined)[];
  /** Views by plan hash, the most recently used last. */
  views: Map<string, View>;
  /** The table IDs open on it. */
  open: number;
  /** The sheets of a workbook, the one read, and what its reading changed (§8.2). */
  workbook: CheckedTable["workbook"] | null;
  /**
   * `loading` while a text file is read whole after its first rows, which the table holds until then (§9); `error`
   * when that reading failed.
   */
  status: "loading" | "ready" | "error";
  /** The share of the file read, while it loads. */
  progress: number;
  /** Why the file could not be read, of a table whose status is `error`. */
  error: Failure | null;
  /** Settles when a table that is loading has loaded, or failed to. */
  loaded: Promise<void> | null;
}

/** What a table holds of its rows and makes of them, which a file read whole replaces (§9). */
export function contentsOf(checked: CheckedTable) {
  const { columns } = checked;
  return {
    columns,
    index: new Map(columns.map((column, index) => [column.name, index])),
    rows: checked.rows,
    vectors: checked.vectors,
    reader: checked.reader ?? null,
    rowCount: checked.rowCount,
    keys: new Map<number, Map<string, number>>(),
    ranks: columns.map(() => undefined),
    checkers: columns.map((column, index) => valueChecker(column, index)),
    values: columns.map(() => undefined),
    overlays: columns.map(() => undefined),
    views: new Map<string, View>(),
  };
}

/** What the engine made of a column of a file that is forgotten, it makes again when a request reads it whole. */
export function forgets(table: Table) {
  if (table.reader) {
    table.reader.forgotten = (index) => {
      table.values[index] = undefined;
    };
  }
}

/** A typed column with the values written to it (§7.2) over it; it reads as JSON, as the host's rows do. */
function writtenVector(base: Vector, written: Map<number, JsonValue>): Vector {
  return {
    length: base.length,
    at: (row) => {
      const value = written.get(row);
      return value === undefined ? base.at(row) : value;
    },
  };
}

/** Answers `load_failed` for a value that does not follow §2.2, at its JSON Pointer in the table. */
export function loadFailed(table: Table, error: TableProblem): never {
  throw new Failure(error.code, `The table ${shown(table.ref)} cannot be read: at ${error.path}, ${error.message}`);
}

/**
 * Checks every value of a column, once, before something reads all of it, and gives its values by row ID: of a
 * table given as rows, an array of the engine's own; of one given as Arrow or as a file, its column.
 */
export function valuesOf(table: Table, index: number): Vector {
  const made = table.values[index];
  if (made) return made;
  const check = table.checkers[index];
  let values: Vector;
  try {
    if (table.vectors) {
      values = table.vectors[index];
      const column = table.columns[index];
      // Numbers are checked as numbers; a value found wrong is then read, which fails as its JSON would.
      if (values.numbers && table.typed) {
        const row = table.typed.firstInvalid(column, values.numbers, values.validity ?? null);
        if (row >= 0) check(vectorValue(values, column, index, row), row);
      } else {
        for (let row = 0; row < table.rowCount; row++) check(vectorValue(values, column, index, row), row);
      }
    } else {
      const rows = table.rows as readonly (readonly JsonValue[])[];
      const array: JsonValue[] = new Array(rows.length);
      for (let row = 0; row < rows.length; row++) {
        const value = rows[row][index];
        check(value, row);
        array[row] = value;
      }
      values = vectorOf(array);
    }
  } catch (error) {
    if (error instanceof TableProblem) loadFailed(table, error);
    throw error;
  }
  const written = table.overlays[index];
  if (written) values = writtenVector(values, written);
  table.values[index] = values;
  return values;
}

/**
 * Reads whole the columns that a request reads whole, before it reads them, of a table whose file is read as
 * requests need it (lazy.ts); the other tables hold all their columns.
 */
export async function readColumns(table: Table, indexes: Iterable<number>, running: Running): Promise<void> {
  if (!table.reader) return;
  try {
    running.releases.push(await table.reader.read(indexes, () => pause(running)));
  } catch (error) {
    if (error instanceof TableProblem) loadFailed(table, error);
    throw error;
  }
}

/**
 * The values of a table's column at rows, in their order, checked when its column is not (§2.2): of a table whose
 * file is read as requests need it, read by the parts of the file that hold them unless the column was read whole.
 */
export async function cellsOf(table: Table, index: number, rows: ArrayLike<number>): Promise<JsonValue[]> {
  if (table.values[index] || !table.reader) return Array.from(rows, (row) => cell(table, row, index));
  let read: JsonValue[];
  try {
    read = await table.reader.cells(index, rows);
    const written = table.overlays[index];
    const check = table.checkers[index];
    return Array.from(rows, (row, at) => {
      const value = written?.get(row);
      if (value !== undefined) return value;
      check(read[at], row);
      return read[at];
    });
  } catch (error) {
    if (error instanceof TableProblem) loadFailed(table, error);
    throw error;
  }
}

/** The value of a table's column at a row as the table holds it, checked when its column is not (§2.2). */
function cell(table: Table, row: number, index: number): JsonValue {
  const values = table.values[index];
  if (values) return values.at(row);
  const written = table.overlays[index]?.get(row);
  if (written !== undefined) return written;
  try {
    const value = table.vectors
      ? vectorValue(table.vectors[index], table.columns[index], index, row)
      : (table.rows as readonly (readonly JsonValue[])[])[row][index];
    table.checkers[index](value, row);
    return value;
  } catch (error) {
    if (error instanceof TableProblem) loadFailed(table, error);
    throw error;
  }
}

/**
 * Writes a cell: into the engine's own array of a column of a table given as rows, or over a typed column, which
 * stays as it was and is not copied.
 */
export function setCell(table: Table, row: number, index: number, value: JsonValue) {
  if (!table.vectors) {
    (valuesOf(table, index) as unknown as JsonValue[])[row] = value;
    return;
  }
  let written = table.overlays[index];
  if (!written) {
    written = new Map();
    table.overlays[index] = written;
    const made = table.values[index];
    if (made) table.values[index] = writtenVector(made, written);
  }
  written.set(row, value);
}

export function ranksOf(table: Table, index: number): ColumnRanks {
  let ranks = table.ranks[index];
  if (!ranks) {
    const column = table.columns[index];
    const values = valuesOf(table, index);
    // A typed column is ranked from its numbers, until a write makes it an array.
    const write = values.numbers && table.typed ? table.typed.numberWriter(column, values.numbers) : null;
    ranks = rankColumn(column, values, write);
    table.ranks[index] = ranks;
  }
  return ranks;
}

/**
 * Ranks a column as `ranksOf` does, with pauses while text is ranked: the ranks of a write's column made while the
 * write came are not kept.
 */
export async function rankPausing(table: Table, index: number, running: Running): Promise<void> {
  if (table.ranks[index]) return;
  const { version } = table.edits;
  const column = table.columns[index];
  const values = valuesOf(table, index);
  const write = values.numbers && table.typed ? table.typed.numberWriter(column, values.numbers) : null;
  const ranks = await rankColumnPausing(column, values, write, () => pause(running));
  if (table.edits.version === version) table.ranks[index] ??= ranks;
}
