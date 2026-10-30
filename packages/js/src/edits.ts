/**
 * Writes of the memory engine (docs/spec.md §7.2): cells of tables that the host makes editable, written into the
 * engine's own values, while the host's rows, Arrow columns and files stay as they were.
 */
import { type JsonValue, keyText, type RowKey, sameCellValue } from "vastgrid-spec";
import { cellsOf, readColumns, setCell, type Table, valuesOf } from "./open-table.js";
import { Failure, type Json, type Running } from "./running.js";
import { shown, TableProblem } from "./table.js";

/** The row ID of a row key (§5.3): `{ rowId }`, or `{ value }` of `rowKey`'s column; null when no row has it. */
function rowOf(table: Table, key: RowKey, column: number | undefined): number | null {
  if ("rowId" in key) return Number.isSafeInteger(key.rowId) && key.rowId < table.rowCount ? key.rowId : null;
  if (column === undefined) return null;
  let byText = table.keys.get(column);
  if (!byText) {
    const values = valuesOf(table, column);
    byText = new Map();
    for (let row = values.length - 1; row >= 0; row--) {
      const value = values.at(row);
      if (value !== null) byText.set(keyText({ value }), row);
    }
    table.keys.set(column, byText);
  }
  return byText.get(keyText(key)) ?? null;
}

/**
 * Writes cells (§7.2): every update or none. Values are checked as their column's type, `previous` against the
 * cell's value now, and the written rows replace the host's rows in the engine's own list of rows.
 */
export async function write(table: Table, request: Json, running: Running) {
  const updates = request.updates as { key: RowKey; column: string; value: JsonValue; previous?: JsonValue }[];
  let keyColumn: number | undefined;
  if (request.rowKey !== undefined) {
    keyColumn = table.index.get(request.rowKey as string);
    if (keyColumn === undefined) {
      throw new Failure("invalid_request", `The table has no column ${shown(request.rowKey)}.`, {
        path: "/rowKey",
        reason: "syntax",
      });
    }
  }
  if (keyColumn !== undefined && updates.some((update) => "value" in update.key)) {
    await readColumns(table, [keyColumn], running);
  }
  const width = table.columns.length;
  const changes: { row: number; index: number; value: JsonValue }[] = [];
  for (const [at, update] of updates.entries()) {
    const index = table.index.get(update.column);
    const column = index === undefined ? undefined : table.columns[index];
    if (
      index === undefined ||
      !column ||
      !table.editable ||
      column.readOnly ||
      column.type === "interval" ||
      column.type === "binary"
    ) {
      throw new Failure("read_only", `The cells of ${shown(update.column)} are not written (§7.1).`, {
        details: { column: update.column },
      });
    }
    const row = rowOf(table, update.key, keyColumn);
    if (row === null) {
      throw new Failure("edit_conflict", "No row has this key now.", { details: { update: at } });
    }
    try {
      table.checkers[index](update.value, row);
    } catch (error) {
      if (!(error instanceof TableProblem)) throw error;
      throw new Failure("invalid_value", `${shown(update.value)} is not a value of ${shown(update.column)}.`, {
        path: `/updates/${at}/value`,
        reason: "type",
        details: { update: at },
      });
    }
    const [now] = await cellsOf(table, index, [row]);
    if (update.previous !== undefined && !sameCellValue(now, update.previous, column)) {
      throw new Failure("edit_conflict", "The cell holds another value now.", { details: { update: at } });
    }
    changes.push({ row, index, value: update.value });
  }
  if (changes.length === 0) return { updated: 0, edits: { ...table.edits } };
  // The host's rows, Arrow columns and files stay as they were: writes change the engine's own values.
  for (const { row, index, value } of changes) {
    setCell(table, row, index, value);
    table.written.add(row * width + index);
    table.ranks[index] = undefined;
    table.keys.delete(index);
  }
  table.views.clear();
  table.edits = { version: table.edits.version + 1, cells: table.written.size };
  return { updated: changes.length, edits: { ...table.edits } };
}
