/**
 * The record shown by the detail panel: every column of the active row, read in full. It follows the
 * active cell of the grid (the one in `GridSelectionEvent.active`), and is independent of React.
 *
 * Which row it shows:
 *
 * - The active row of the current view. Moving the active cell to another row shows that row; moving
 *   within the row, or moving, hiding, freezing or formatting columns, keeps the record.
 * - A new view (sort, filters, search) makes its first row active, and the record follows it.
 * - Reading the table again keeps the record when the table did not change (same revision); otherwise
 *   the grid makes the first row active and the record follows it.
 * - Without rows, there is no record.
 *
 * Values come from the rows the grid has loaded. Columns that are not loaded, and text that the source
 * cut for display (it ends with "…"), are read again in full for the row alone, after a short pause, so
 * that moving quickly through rows reads only the row where the cell stops. Moving on cancels the read.
 */

import { type CellValue, isAbortError, MAX_TEXT_LIMIT } from "vastgrid-core";
import type { GridController } from "./controller.js";

export type DetailStatus = "loading" | "ready" | "error";

export interface DetailRecord {
  /** Row in the current view. */
  row: number;
  /** Row in the original table, or `null` while the row of a view is not loaded. */
  rowId: number | null;
  /** Values by schema column index; `undefined` while a value is being read. */
  values: (CellValue | undefined)[];
  status: DetailStatus;
  /** Why reading the row failed, when `status` is `"error"`. */
  error: string | null;
}

export interface DetailTrackerOptions {
  /** Milliseconds the active row has to stay before its full values are read. Defaults to 120. */
  delay?: number;
}

/** Whether a loaded value may be text that the source cut for display (it then ends with "…"). */
function mayBeCut(value: CellValue | undefined) {
  return typeof value === "string" && value.endsWith("…");
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Follows the active row of a grid and reads its full record. Call `start()` to follow, `stop()` to end. */
export class DetailTracker {
  readonly controller: GridController;
  readonly delay: number;
  private current: DetailRecord | null = null;
  private key = "";
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(controller: GridController, options: DetailTrackerOptions = {}) {
    this.controller = controller;
    this.delay = options.delay ?? 120;
  }

  /** The record of the active row, or null when the grid has no row (or the tracker is stopped). */
  get record() {
    return this.current;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  /** Starts following the active row. */
  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.controller.subscribe(() => this.update());
    this.update();
  }

  /** Stops following and cancels the read. */
  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancel();
    this.key = "";
    this.set(null);
  }

  /** Reads the active row again, for example after an error. */
  retry() {
    this.key = "";
    this.update();
  }

  /** The row to show and what it depends on: a change of any of them starts a new record. */
  private rowKey() {
    const c = this.controller;
    if (c.info?.status !== "ready" && c.readableRows === 0) return "";
    if (c.rowCount === 0 || c.schema.length === 0) return "";
    const row = Math.min(c.selection.active.row, c.rowCount - 1);
    return `${c.view.id}|${c.info?.revision ?? ""}|${c.info?.status}|${c.schema.length}|${row}`;
  }

  private update() {
    const key = this.rowKey();
    if (key === this.key) {
      // The same row: its id may have arrived with the rows of a view.
      const record = this.current;
      if (record && record.rowId === null) {
        const rowId = this.controller.rowId(record.row);
        if (rowId !== null) this.set({ ...record, rowId });
      }
      return;
    }
    this.key = key;
    this.cancel();
    if (!key) {
      this.set(null);
      return;
    }
    const c = this.controller;
    const row = Math.min(c.selection.active.row, c.rowCount - 1);
    const values = c.schema.map((_, index) => c.cache.value(row, index));
    const missing = values.flatMap((value, index) => (value === undefined || mayBeCut(value) ? [index] : []));
    const rowId = c.rowId(row);
    if (missing.length === 0) {
      this.set({ row, rowId, values, status: "ready", error: null });
      return;
    }
    // Cut values are kept for now; they are replaced once read in full.
    this.set({ row, rowId, values, status: "loading", error: null });
    const abort = new AbortController();
    this.abort = abort;
    this.timer = setTimeout(() => void this.read(row, missing, abort), this.delay);
  }

  private async read(row: number, columns: number[], abort: AbortController) {
    const c = this.controller;
    try {
      const block = await c.source.readRows(
        { view: c.view.id, start: row, end: row + 1, columns, textLimit: MAX_TEXT_LIMIT },
        abort.signal,
      );
      if (abort.signal.aborted || !this.current) return;
      const values = [...this.current.values];
      columns.forEach((column, i) => {
        values[column] = block.columns[i]?.[0] ?? null;
      });
      const rowId = this.current.rowId ?? block.rowIds?.[0] ?? (c.view.id === null ? row : null);
      this.set({ ...this.current, rowId, values, status: "ready", error: null });
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error) || !this.current) return;
      this.set({ ...this.current, status: "error", error: messageOf(error) });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private cancel() {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = null;
  }

  private set(record: DetailRecord | null) {
    if (record === this.current) return;
    this.current = record;
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export type DetailKeyAction = "open" | "close" | "focusPanel" | "focusGrid";

/**
 * What a key does for the detail panel. In the grid, Alt+Enter opens the panel, or moves the focus to
 * it when it is open (Esc closes it, when Esc has nothing else to do). In the panel, Esc closes it and
 * Alt+Enter goes back to the grid; both return the focus to the grid.
 */
export function detailKeyAction(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  place: "grid" | "panel",
  open: boolean,
): DetailKeyAction | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (event.key === "Enter" && event.altKey && plain) {
    if (place === "panel") return "focusGrid";
    return open ? "focusPanel" : "open";
  }
  if (event.key === "Escape" && !event.altKey && plain && open) return "close";
  return null;
}
