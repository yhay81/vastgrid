/**
 * The undo and redo stacks of written cells. Each entry is one write (a typed value, a paste, a fill),
 * with the values before and after, so that it is undone by writing the values before as one write.
 * Cells are named by their row's position in the table (`RowBlock.rowIds`) and the schema column,
 * which are valid for one `TableInfo.revision`: clear the history when the revision changes.
 *
 * The history keeps at most `maxEntries` entries, `maxCells` cells and `maxText` characters of text
 * values over both stacks; the oldest entries are dropped beyond them, and an entry larger than the
 * limits on its own is not kept (the history is cleared instead, since older entries can no longer be
 * undone in order).
 */

import type { CellValue } from "./types.js";

/** One cell of an entry. */
export interface HistoryChange {
  /** The row's position in the table. */
  row: number;
  /** Schema column index. */
  column: number;
  value: CellValue;
  previous: CellValue;
}

export interface HistoryEntry<Reason extends string = string> {
  reason: Reason;
  changes: HistoryChange[];
}

export interface EditHistoryOptions {
  /** Entries kept over both stacks. Defaults to 100. */
  maxEntries?: number;
  /** Cells kept over both stacks. Defaults to 1,000,000. */
  maxCells?: number;
  /** Characters of text values kept over both stacks. Defaults to 32,000,000. */
  maxText?: number;
}

function sizeOf(entry: HistoryEntry) {
  let text = 0;
  for (const change of entry.changes) {
    if (typeof change.value === "string") text += change.value.length;
    if (typeof change.previous === "string") text += change.previous.length;
  }
  return { cells: entry.changes.length, text };
}

export class EditHistory<Reason extends string = string> {
  private readonly undoStack: HistoryEntry<Reason>[] = [];
  private readonly redoStack: HistoryEntry<Reason>[] = [];
  private readonly maxEntries: number;
  private readonly maxCells: number;
  private readonly maxText: number;
  private cells = 0;
  private text = 0;

  constructor(options: EditHistoryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.maxCells = Math.max(1, options.maxCells ?? 1_000_000);
    this.maxText = Math.max(0, options.maxText ?? 32_000_000);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Entries that can be undone and redone. */
  get undoSize() {
    return this.undoStack.length;
  }

  get redoSize() {
    return this.redoStack.length;
  }

  /** The entry `undo` would undo, or null. */
  peekUndo(): HistoryEntry<Reason> | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  /** The entry `redo` would write again, or null. */
  peekRedo(): HistoryEntry<Reason> | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  /** Records a new write. The entries that could be redone are dropped: a new change starts a new branch. */
  record(entry: HistoryEntry<Reason>) {
    for (const dropped of this.redoStack.splice(0)) this.remove(dropped);
    const size = sizeOf(entry);
    if (size.cells > this.maxCells || size.text > this.maxText) {
      this.clear();
      return false;
    }
    this.undoStack.push(entry);
    this.add(entry);
    this.trim();
    return true;
  }

  /** Moves the entry from the undo stack to the redo stack, once its values before were written again. */
  undone(entry: HistoryEntry<Reason>) {
    if (this.peekUndo() !== entry) return false;
    this.undoStack.pop();
    this.redoStack.push(entry);
    return true;
  }

  /** Moves the entry from the redo stack back to the undo stack, once its values were written again. */
  redone(entry: HistoryEntry<Reason>) {
    if (this.peekRedo() !== entry) return false;
    this.redoStack.pop();
    this.undoStack.push(entry);
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.cells = 0;
    this.text = 0;
  }

  private add(entry: HistoryEntry<Reason>) {
    const size = sizeOf(entry);
    this.cells += size.cells;
    this.text += size.text;
  }

  private remove(entry: HistoryEntry<Reason>) {
    const size = sizeOf(entry);
    this.cells -= size.cells;
    this.text -= size.text;
  }

  /** Drops the oldest undo entries beyond the limits (redo entries are newer). */
  private trim() {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length + this.redoStack.length > this.maxEntries ||
        this.cells > this.maxCells ||
        this.text > this.maxText)
    ) {
      const oldest = this.undoStack.shift();
      if (oldest) this.remove(oldest);
    }
  }
}
