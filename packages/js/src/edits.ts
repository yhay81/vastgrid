/**
 * Writes of the memory engine (docs/spec.md §7.2): cells of tables that the host makes editable, written into the
 * engine's own values, while the host's rows, Arrow columns and files stay as they were.
 */
import { isValueOf, type JsonValue, type RowKey, sameCellValue } from "vastgrid-spec";
import { cellsOf, ranksOf, readColumns, setCell, type Table, valuesOf } from "./open-table.js";
import { rankColumn } from "./order.js";
import { Failure, type Json, pause, type Running } from "./running.js";
import { shown, TableProblem } from "./table.js";

interface Update {
  key: RowKey;
  column: string;
  value: JsonValue;
  previous?: JsonValue;
}

/** Inserts a row into a min-heap, so duplicate values always name the first row by source ID. */
function addRow(heap: number[], row: number) {
  let at = heap.length;
  while (at > 0) {
    const parent = (at - 1) >>> 1;
    if (heap[parent] <= row) break;
    heap[at] = heap[parent];
    at = parent;
  }
  heap[at] = row;
}

function dropFirst(heap: number[]) {
  const last = heap.pop()!;
  if (!heap.length) return;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
    if (last <= heap[child]) break;
    heap[at] = heap[child];
    at = child;
  }
  heap[at] = last;
}

/** Value-key lookups, including the effects of earlier updates in this batch. */
function keyIndex(table: Table, index: number, updates: Update[]) {
  const column = table.columns[index];
  const lastLookup = updates.findLastIndex((update) => "value" in update.key);
  if (lastLookup < 0) return undefined;
  const proposed: JsonValue[] = [];
  for (let at = 0; at < lastLookup; at++) {
    const update = updates[at];
    if (update.column === column.name && isValueOf(update.value, column)) proposed.push(update.value);
  }
  if (!proposed.length) {
    const ranks = ranksOf(table, index);
    let first = table.keys.get(index);
    if (!first) {
      first = new Int32Array(ranks.distinct + 2).fill(-1);
      for (let row = 0; row < table.rowCount; row++) {
        const rank = ranks.ranks[row];
        if (first[rank] < 0) first[rank] = row;
      }
      table.keys.set(index, first);
    }
    return { find: (key: JsonValue) => first[ranks.rankOf(key)] ?? -1 };
  }
  // Rank original and incoming values once, using exactly the same equality as normal value-key lookups.
  const values = valuesOf(table, index);
  const ranks = rankColumn(column, {
    length: table.rowCount + proposed.length,
    at: (row) => (row < table.rowCount ? values.at(row) : proposed[row - table.rowCount]),
  });
  // Keep a heap only for a value looked up by this request. Original row IDs are already in heap order.
  const rows = new Map<number, number[]>();
  for (const { key } of updates) {
    if ("value" in key) rows.set(ranks.rankOf(key.value), []);
  }
  for (let row = 0; row < table.rowCount; row++) rows.get(ranks.ranks[row])?.push(row);
  return {
    find(key: JsonValue) {
      const rank = ranks.rankOf(key);
      const heap = rows.get(rank)!;
      while (heap.length && ranks.ranks[heap[0]] !== rank) dropFirst(heap);
      return heap[0] ?? -1;
    },
    move(row: number, value: JsonValue) {
      const rank = ranks.rankOf(value);
      if (rank === ranks.ranks[row]) return;
      ranks.ranks[row] = rank;
      const heap = rank >= 0 ? rows.get(rank) : undefined;
      if (heap) addRow(heap, row);
    },
  };
}

/**
 * Writes cells (§7.2): every update or none. Values are checked as their column's type, `previous` against the
 * cell's value now, and the written rows replace the host's rows in the engine's own list of rows.
 */
export async function write(table: Table, request: Json, running: Running) {
  const updates = request.updates as Update[];
  let keyColumn: number | undefined;
  if (request.rowKey !== undefined) {
    keyColumn = table.index.get(request.rowKey as string);
    if (keyColumn === undefined) {
      throw new Failure("invalid_request", `The table has no column ${shown(request.rowKey)}.`, {
        path: "/rowKey",
        reason: "syntax",
      });
    }
  } else if (updates.some((update) => "value" in update.key)) {
    throw new Failure("invalid_request", "Keys by value need rowKey, the column of their values (§5.3).", {
      path: "/rowKey",
      reason: "syntax",
    });
  }
  if (!table.editable) {
    throw new Failure("read_only", "This table is read-only (§7.1).");
  }
  if (keyColumn !== undefined && updates.some((update) => "value" in update.key)) {
    await readColumns(table, [keyColumn], running);
    valuesOf(table, keyColumn);
  }
  const width = table.columns.length;
  const staged = new Map<number, JsonValue>();
  const keys = keyColumn === undefined ? undefined : keyIndex(table, keyColumn, updates);
  for (const [at, update] of updates.entries()) {
    if (at > 0 && at % 1_024 === 0) await pause(running);
    const index = table.index.get(update.column);
    const column = index === undefined ? undefined : table.columns[index];
    if (index === undefined || !column || column.readOnly || column.type === "interval" || column.type === "binary") {
      throw new Failure("read_only", `The cells of ${shown(update.column)} are not written (§7.1).`, {
        details: { column: update.column },
      });
    }
    const row = "rowId" in update.key ? update.key.rowId : (keys?.find(update.key.value) ?? -1);
    if (row < 0 || row >= table.rowCount) {
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
    const cellKey = row * width + index;
    if (update.previous !== undefined) {
      const now = staged.has(cellKey) ? (staged.get(cellKey) as JsonValue) : (await cellsOf(table, index, [row]))[0];
      if (!sameCellValue(now, update.previous, column)) {
        throw new Failure("edit_conflict", "The cell holds another value now.", { details: { update: at } });
      }
    }
    // Row-backed writes materialize a whole column, which can uncover an invalid source value.
    if (!table.vectors) valuesOf(table, index);
    staged.set(cellKey, update.value);
    if (index === keyColumn) keys?.move?.(row, update.value);
  }
  if (updates.length === 0) return { updated: 0, edits: { ...table.edits } };
  // The host's rows, Arrow columns and files stay as they were: writes change the engine's own values.
  for (const [cellKey, value] of staged) {
    const index = cellKey % width;
    const row = (cellKey - index) / width;
    setCell(table, row, index, value);
    table.written.add(cellKey);
    table.ranks[index] = undefined;
    table.keys.delete(index);
  }
  table.views.clear();
  table.edits = { version: table.edits.version + 1, cells: table.written.size };
  return { updated: updates.length, edits: { ...table.edits } };
}
