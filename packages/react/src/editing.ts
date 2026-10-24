/**
 * Editing cells: checking typed values, writing them through `TableSource.updateCells` and showing
 * the writes that are saving or failed. Cells are named by their row's position in the table
 * (`rowId`), which stays the same while the view is sorted or filtered again, and the schema column.
 *
 * A write is one request: its cells are saved together or not at all. Writes are sent one at a time,
 * in the order they were made. While a write is saving, its cells show the new values; when it fails,
 * they show the values again that the source has, and the write waits to be retried or discarded.
 */

import {
  type CellInputError,
  type CellValue,
  type ColumnSchema,
  ErrorCodes,
  editableColumn,
  isAbortError,
  MAX_UPDATE_CELLS,
  parseCellInput,
  sameCellValue,
  type UpdateResult,
} from "vastgrid-core";
import type { GridController } from "./controller.js";
import type { GridCell } from "./events.js";

/** What made a write: typing into a cell, clearing cells, pasting, filling, or undoing and redoing. */
export type GridEditReason = "edit" | "clear" | "paste" | "fill" | "undo" | "redo";

/** One cell of a write. */
export interface GridCellChange {
  /** The row's position in the table (`GridCell.rowId`). */
  rowId: number;
  /** Schema column index. */
  column: number;
  value: CellValue;
  /** The value the change was made from, when it is known (cut text is not). */
  previous: CellValue | undefined;
}

export interface GridCellsChangeEvent {
  reason: GridEditReason;
  /** `saved`: the source has the values. `failed`: it refused them, and nothing of the write was saved. */
  status: "saved" | "failed";
  changes: GridCellChange[];
  /** Why a write failed: the source's error code (see `ErrorCodes`) and message. */
  error?: { code: string | undefined; message: string };
}

/** What `validateCell` is given: the cell, its column, the checked value and the value it replaces. */
export interface GridCellValidation extends GridCell {
  schema: ColumnSchema;
  value: CellValue;
  /** The value before, or `undefined` when it is not known. */
  previous: CellValue | undefined;
  /** The text typed or pasted. */
  text: string;
  reason: GridEditReason;
}

/**
 * Checks a value before it is written, after its type was checked. Returns a message for the user to
 * refuse it, or nothing to accept it; it may return a promise (for example to ask a server).
 */
export type ValidateCell = (cell: GridCellValidation) => string | null | undefined | Promise<string | null | undefined>;

/** Why a cell cannot take a value: its type (`input`), the app's `validateCell`, or the column is read-only. */
export type CellProblem =
  | { kind: "input"; error: CellInputError }
  | { kind: "invalid"; message: string }
  | { kind: "readOnly" };

/** A cell to write, given by its view row and visible column, with the text typed or pasted. */
export interface CellInput {
  row: number;
  col: number;
  text: string;
  /** The value before, when known. */
  previous?: CellValue;
  /** The row's position in the table, when known; otherwise it is read from the loaded row. */
  rowId?: number;
  /** The schema column, when known; otherwise the visible column's. */
  column?: number;
}

/** A cell of the view with its row's position in the table and its schema column. */
export interface TargetCell {
  row: number;
  col: number;
  rowId: number;
  column: number;
  /** The loaded value, unless it is not loaded or may be cut for display. */
  previous: CellValue | undefined;
}

/** A change with the view row it was made in, to show it there while it is saving. */
interface PlacedChange extends GridCellChange {
  row: number;
}

export interface EditBatch {
  id: number;
  reason: GridEditReason;
  changes: PlacedChange[];
  /** The table's revision when the write was made. */
  revision: string | undefined;
  status: "saving" | "failed";
  error?: { code: string | undefined; message: string };
  /** Write without checking the previous values (after a conflict, the user chose to overwrite). */
  overwrite?: boolean;
}

/** The result of `GridEdits.prepare`: the changes to write, or the cells that cannot take their values. */
export type Prepared =
  | { ok: true; changes: PlacedChange[] }
  | { ok: false; problems: (CellInput & { problem: CellProblem })[] };

/** Where pasted values go (see `GridEdits.pasteTargets`). */
export interface PastePlan {
  /** The cells and their pasted text. */
  inputs: (TargetCell & { text: string })[];
  /** Rows and columns of the pasted values that fell outside the table and were left out. */
  cutRows: number;
  cutCols: number;
}

/** Values cannot be pasted into several ranges at once, unless they are one value. */
export class PasteRangesError extends Error {
  constructor() {
    super("Paste into one range, or paste a single value.");
  }
}

export class EditTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Write at most ${limit} cells at once.`);
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown) {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export class GridEdits {
  /** Writes that are saving or failed, oldest first. */
  readonly batches: EditBatch[] = [];
  /** The state of cells in those writes, by `rowId:column`. */
  private readonly cells = new Map<string, "saving" | "failed">();
  private readonly listeners = new Set<(event: GridCellsChangeEvent) => void>();
  private queue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly controller: GridController) {}

  /** Calls `listener` when a write was saved or failed. */
  onChange(listener: (event: GridCellsChangeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether the source can write cells now, and the app did not make the grid read-only. */
  get enabled() {
    const c = this.controller;
    return (
      !c.options.readOnly &&
      typeof c.source.updateCells === "function" &&
      c.info?.status === "ready" &&
      c.info.capabilities.edit === true
    );
  }

  /** Whether a column (by schema index) can be written. */
  columnEditable(column: number) {
    const schema = this.controller.schema[column];
    return this.enabled && schema !== undefined && editableColumn(schema);
  }

  /** Whether a cell of the view can be edited now: its column can be written and its row is loaded. */
  cellEditable(row: number, col: number) {
    const c = this.controller;
    const state = c.visible[col];
    return state !== undefined && this.columnEditable(state.index) && c.rowId(row) !== null && row < c.readableRows;
  }

  /** Cells being saved. */
  get saving() {
    let cells = 0;
    for (const batch of this.batches) if (batch.status === "saving") cells += batch.changes.length;
    return cells;
  }

  /** The oldest write that failed, which `retry` and `discard` act on. */
  get failed() {
    return this.batches.find((batch) => batch.status === "failed") ?? null;
  }

  /** Whether a cell (by its row in the table and schema column) is saving or failed. */
  stateOf(rowId: number | null, column: number) {
    if (rowId === null || this.cells.size === 0) return null;
    return this.cells.get(`${rowId}:${column}`) ?? null;
  }

  /**
   * Checks values for cells: the column can be written, the text fits the column's type
   * (`parseCellInput`), and `validateCell` accepts it. Returns the changes, without the cells whose
   * value stays the same, or every cell that cannot take its value.
   */
  async prepare(inputs: CellInput[], reason: GridEditReason, signal?: AbortSignal): Promise<Prepared> {
    const c = this.controller;
    if (inputs.length > MAX_UPDATE_CELLS) throw new EditTooLargeError(MAX_UPDATE_CELLS);
    const problems: (CellInput & { problem: CellProblem })[] = [];
    const checks: Promise<void>[] = [];
    const changes: PlacedChange[] = [];
    for (const input of inputs) {
      const index = input.column ?? c.visible[input.col]?.index ?? -1;
      const schema = c.schema[index];
      const rowId = input.rowId ?? c.rowId(input.row);
      if (!schema || rowId === null || !this.columnEditable(index)) {
        problems.push({ ...input, problem: { kind: "readOnly" } });
        continue;
      }
      // Pasted numbers may be formatted with grouped digits (1,234.5).
      const parsed = parseCellInput(input.text, schema, { grouping: reason === "paste" });
      if (!parsed.ok) {
        problems.push({ ...input, problem: { kind: "input", error: parsed.error } });
        continue;
      }
      const previous = input.previous;
      if (previous !== undefined && sameCellValue(previous, parsed.value) && typeof previous === typeof parsed.value)
        continue;
      const change: PlacedChange = { row: input.row, rowId, column: index, value: parsed.value, previous };
      const validate = c.options.validateCell;
      if (validate) {
        const cell: GridCellValidation = {
          ...c.cell(input.row, input.col),
          schema,
          value: parsed.value,
          previous,
          text: input.text,
          reason,
        };
        checks.push(
          Promise.resolve()
            .then(() => validate(cell))
            .then(
              (message) => {
                if (message) problems.push({ ...input, problem: { kind: "invalid", message } });
                else changes.push(change);
              },
              (error: unknown) => {
                problems.push({ ...input, problem: { kind: "invalid", message: messageOf(error) } });
              },
            ),
        );
      } else {
        changes.push(change);
      }
    }
    await Promise.all(checks);
    signal?.throwIfAborted();
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, changes };
  }

  /**
   * The cells of view rows `[start, end)` in the visible columns `cols` that can be written (with
   * `readOnly`, also the others), with their rows' positions in the table: from the loaded rows, or read
   * from the source for the others.
   */
  async targetCells(
    start: number,
    end: number,
    cols: number[],
    signal?: AbortSignal,
    readOnly = false,
  ): Promise<TargetCell[]> {
    const c = this.controller;
    const columns = cols.flatMap((col) => {
      const state = c.visible[col];
      return state && (readOnly || this.columnEditable(state.index)) ? [{ col, column: state.index }] : [];
    });
    if (columns.length === 0 || end <= start) return [];
    if ((end - start) * columns.length > MAX_UPDATE_CELLS) throw new EditTooLargeError(MAX_UPDATE_CELLS);
    const ids: number[] = [];
    let missing = false;
    for (let row = start; row < end; row++) {
      const id = c.rowId(row);
      if (id === null) missing = true;
      ids.push(id ?? -1);
    }
    if (missing) {
      // Only the rows' positions: no column is read.
      const block = await c.source.readRows({ view: c.view.id, start, end, columns: [] }, signal);
      const read = block.rowIds ?? (c.view.id === null ? null : []);
      for (let offset = 0; offset < end - start; offset++) ids[offset] = read ? (read[offset] ?? -1) : start + offset;
      if (ids.includes(-1)) throw new Error("The rows could not be read.");
    }
    const cells: TargetCell[] = [];
    for (let row = start; row < end; row++) {
      for (const { col, column } of columns) {
        const value = c.cache.value(row, column);
        const previous = value === undefined || (typeof value === "string" && value.endsWith("…")) ? undefined : value;
        cells.push({ row, col, rowId: ids[row - start], column, previous });
      }
    }
    return cells;
  }

  /**
   * The cells that pasted values (rows of cells, for example from `parseTsv`) go into, from the top-left
   * cell of the selection:
   *
   * - The values are pasted once, or repeated over a selection that is a whole multiple of their rows
   *   and columns (as spreadsheets do).
   * - A single value goes into every selected cell, also of several ranges; more values cannot be
   *   pasted into several ranges (`PasteRangesError`).
   * - Rows and columns past the end of the view are left out (`cutRows`, `cutCols`); rows are never added.
   * - Read-only columns are not skipped: their cells are returned, so that `prepare` refuses the paste.
   */
  async pasteTargets(values: string[][], signal?: AbortSignal): Promise<PastePlan> {
    const c = this.controller;
    const height = values.length;
    const width = values.reduce((most, row) => Math.max(most, row.length), 0);
    const ranges = c.selection.ranges;
    if (height === 0 || width === 0 || ranges.length === 0) return { inputs: [], cutRows: 0, cutCols: 0 };
    const single = height === 1 && width === 1;
    if (ranges.length > 1 && !single) throw new PasteRangesError();
    const areas = ranges.map((range) => {
      const rows = range.bottom - range.top + 1;
      const cols = range.right - range.left + 1;
      // A selection that holds the values a whole number of times is filled with them.
      const repeat = ranges.length > 1 || (rows % height === 0 && cols % width === 0);
      return { top: range.top, left: range.left, rows: repeat ? rows : height, cols: repeat ? cols : width };
    });
    let cutRows = 0;
    let cutCols = 0;
    let cells = 0;
    for (const area of areas) {
      cutRows = Math.max(cutRows, area.top + area.rows - c.rowCount);
      cutCols = Math.max(cutCols, area.left + area.cols - c.visible.length);
      area.rows = Math.max(0, Math.min(area.rows, c.rowCount - area.top));
      area.cols = Math.max(0, Math.min(area.cols, c.visible.length - area.left));
      cells += area.rows * area.cols;
    }
    if (cells > MAX_UPDATE_CELLS) throw new EditTooLargeError(MAX_UPDATE_CELLS);
    const inputs: (TargetCell & { text: string })[] = [];
    for (const area of areas) {
      const cols = Array.from({ length: area.cols }, (_, offset) => area.left + offset);
      const targets = await this.targetCells(area.top, area.top + area.rows, cols, signal, true);
      for (const target of targets) {
        const text = values[(target.row - area.top) % height]?.[(target.col - area.left) % width] ?? "";
        inputs.push({ ...target, text });
      }
    }
    return { inputs, cutRows: Math.max(0, cutRows), cutCols: Math.max(0, cutCols) };
  }

  /**
   * Writes changes as one write, after the writes made before. Their cells show the new values while
   * it is saving. Resolves whether it was saved.
   */
  write(changes: PlacedChange[], reason: GridEditReason): Promise<boolean> {
    if (changes.length === 0) return Promise.resolve(true);
    if (changes.length > MAX_UPDATE_CELLS) throw new EditTooLargeError(MAX_UPDATE_CELLS);
    const batch: EditBatch = {
      id: this.nextId++,
      reason,
      changes,
      revision: this.controller.info?.revision,
      status: "saving",
    };
    this.batches.push(batch);
    return this.enqueue(batch);
  }

  /** Sends a failed write again; with `overwrite`, without checking that the cells still hold their previous values. */
  retry(overwrite = false) {
    const batch = this.failed;
    if (!batch) return Promise.resolve(false);
    batch.status = "saving";
    batch.error = undefined;
    batch.overwrite = overwrite || batch.overwrite;
    return this.enqueue(batch);
  }

  /** Drops a failed write: its cells keep the values the source has. */
  discard() {
    const batch = this.failed;
    if (!batch) return;
    this.remove(batch);
    this.changed();
  }

  /** Whether a failed write can be sent again: the table still has the revision its rows were read with. */
  retryable(batch: EditBatch) {
    return batch.error?.code !== ErrorCodes.revisionChanged && batch.revision === this.controller.info?.revision;
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  private enqueue(batch: EditBatch) {
    this.mark(batch, "saving");
    this.show(batch, "value");
    this.changed();
    const run = this.queue.then(() => this.send(batch));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async send(batch: EditBatch): Promise<boolean> {
    const c = this.controller;
    const update = c.source.updateCells;
    let result: UpdateResult;
    try {
      if (!update) throw new Error("The table is read-only.");
      result = await update.call(c.source, {
        updates: batch.changes.map(({ rowId, column, value, previous }) =>
          previous === undefined || batch.overwrite
            ? { row: rowId, column, value }
            : { row: rowId, column, value, previous },
        ),
        ...(batch.revision === undefined ? {} : { revision: batch.revision }),
      });
    } catch (error) {
      if (this.disposed) return false;
      batch.status = "failed";
      batch.error = { code: isAbortError(error) ? ErrorCodes.cancelled : codeOf(error), message: messageOf(error) };
      this.mark(batch, "failed");
      this.show(batch, "previous");
      this.emit(batch, "failed");
      this.changed();
      // Read the cells again, so that they show what the source holds; after a conflict, the rows may also
      // have moved in a sorted or filtered view.
      if (batch.error.code === ErrorCodes.editConflict) c.editsChanged(null);
      else c.cache.invalidate();
      return false;
    }
    if (this.disposed) return true;
    this.remove(batch);
    this.emit(batch, "saved");
    c.editsChanged([...new Set(batch.changes.map((change) => change.column))], result.edits);
    return true;
  }

  private remove(batch: EditBatch) {
    const index = this.batches.indexOf(batch);
    if (index >= 0) this.batches.splice(index, 1);
    this.cells.clear();
    for (const other of this.batches) this.mark(other, other.status);
  }

  private mark(batch: EditBatch, state: "saving" | "failed") {
    for (const change of batch.changes) this.cells.set(`${change.rowId}:${change.column}`, state);
  }

  /** Shows the new or the previous values of a write in the cells of its rows that are loaded. */
  private show(batch: EditBatch, which: "value" | "previous") {
    const c = this.controller;
    for (const change of batch.changes) {
      const value = which === "value" ? change.value : change.previous;
      if (value === undefined || c.rowId(change.row) !== change.rowId) continue;
      c.cache.patch(change.row, change.column, value);
    }
  }

  private emit(batch: EditBatch, status: GridCellsChangeEvent["status"]) {
    const event: GridCellsChangeEvent = {
      reason: batch.reason,
      status,
      changes: batch.changes.map(({ rowId, column, value, previous }) => ({ rowId, column, value, previous })),
      ...(batch.error ? { error: batch.error } : {}),
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  private changed() {
    this.controller.requestRender();
    this.controller.emit();
  }
}
