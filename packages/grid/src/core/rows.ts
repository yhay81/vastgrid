import { type CheckedPlan, type Column, canonicalJson, decodeBlock, type Plan } from "vastgrid-spec";
import { BLOCK_ROWS, type Read, type ViewCache } from "./cache.js";
import type { GridClient } from "./client.js";
import type { RowsResult, TableInfo, ViewInfo } from "./types.js";

/** Where the canvas is: its first row, how many rows it shows and the columns it draws. */
export interface Viewport {
  top: number;
  rows: number;
  columns: readonly string[];
}

/** A view of the document's plan, being read or on screen. */
export interface View {
  readonly key: string;
  readonly plan: Plan;
  readonly checked: CheckedPlan;
  /** The table's revision and edits version that the view's rows belong to. */
  readonly revision: string | null;
  readonly edits: number;
  info: ViewInfo | null;
  readonly cache: ViewCache;
  readonly abort: AbortController;
}

/** Whether two lists of columns have the same names and types. */
export function sameColumns(a: readonly Column[], b: readonly Column[]) {
  return a.length === b.length && a.every((column, index) => canonicalJson(column) === canonicalJson(b[index]));
}

/** What a `RowReader` reads with: the views, the connection and the state of its store, and where rows go. */
export interface ReadHost {
  /** The view on screen. */
  current(): View | null;
  /** The view being made, which comes on screen once its first rows are read (§4.2 of v2-react.md). */
  next(): View | null;
  client(): GridClient | null;
  table(): TableInfo | null;
  /** Whether the table is open for the current connection. */
  opened(): boolean;
  /** The document's row key column (§5.3). */
  rowKey(): string | undefined;
  /** Whether the session's active cell has the key of its row (§5.2). */
  keyed(): boolean;
  /** A read changed the info of the view on screen. */
  showView(info: ViewInfo): void;
  /** Rows of the view on screen arrived. */
  showRows(): void;
  /** A read of the view on screen or of the one being made failed. */
  fail(error: unknown): void;
}

/**
 * Reads the rows of a store's views into their caches (§4.1 of v2-react.md): those on screen and a page around
 * them, within a budget of bytes, and those that the store asks for. Rows that come for a view that is no longer
 * on screen or being made are dropped.
 */
export class RowReader {
  /** What the canvas shows, as `setViewport` was told last. */
  viewport: Viewport = { top: 0, rows: 0, columns: [] };
  private scheduled = false;

  constructor(
    private readonly host: ReadHost,
    private readonly budget: number,
  ) {}

  /** Follows what the canvas shows, and reads those rows and a page around them. */
  setViewport(viewport: Viewport) {
    const before = this.viewport;
    if (
      before.top === viewport.top &&
      before.rows === viewport.rows &&
      before.columns.length === viewport.columns.length &&
      before.columns.every((column, index) => column === viewport.columns[index])
    ) {
      return;
    }
    this.viewport = viewport;
    this.schedule();
  }

  /** Reads rows `[start, end)` of `columns` of the view on screen if they are not read, for cells React renders. */
  ensure(start: number, end: number, columns: readonly string[]) {
    const view = this.host.current();
    if (!view?.info || !this.host.opened() || this.host.next() || view.abort.signal.aborted) return;
    for (const read of view.cache.reads(start, end, this.withKey(columns), view.info.rowCount)) {
      void this.read(view, read).catch(() => {});
    }
  }

  /** Reads the rows on screen once the current task is done, once for all the changes it makes. */
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.readVisible();
    });
  }

  /** The rows from `row` for a viewport, in whole blocks. */
  around(row: number, rowCount: number | null, columns: readonly string[]): Read {
    const start = Math.floor(row / BLOCK_ROWS) * BLOCK_ROWS;
    const rows = Math.max(this.viewport.rows, 1);
    let end = Math.ceil((row + rows) / BLOCK_ROWS) * BLOCK_ROWS;
    if (rowCount !== null) end = Math.min(end, Math.max(rowCount, start + 1));
    return { start, end: Math.max(end, start + 1), columns: [...columns] };
  }

  /** The columns of a view to read: those asked for that it has and its row key column, at least one. */
  withKeyFor(view: View, columns: readonly string[]): string[] {
    const names = new Set(view.checked.columns.map((column) => column.name));
    const wanted = columns.filter((column) => names.has(column));
    const key = this.host.rowKey();
    if (key !== undefined && names.has(key) && !wanted.includes(key)) wanted.push(key);
    if (wanted.length === 0 && view.checked.columns.length > 0) wanted.push(view.checked.columns[0].name);
    return wanted;
  }

  /** Reads the rows that a command needs (`not_loaded`, §6.1), in whole blocks. */
  async load(view: View, details: { rows: [number, number][]; columns: string[] }) {
    const rowCount = view.info?.rowCount ?? 0;
    const columns = this.withKeyFor(view, details.columns);
    const reads: Promise<void>[] = [];
    for (const [start, end] of details.rows) {
      const first = Math.floor(start / BLOCK_ROWS) * BLOCK_ROWS;
      const last = Math.min(rowCount, Math.ceil(end / BLOCK_ROWS) * BLOCK_ROWS);
      for (let at = first; at < last; at += BLOCK_ROWS * 16) {
        reads.push(this.read(view, { start: at, end: Math.min(last, at + BLOCK_ROWS * 16), columns }));
      }
    }
    await Promise.all(reads);
  }

  /** Reads rows of a view into its cache. */
  async read(view: View, read: Read): Promise<void> {
    const client = this.host.client();
    const table = this.host.table();
    if (!client || !table) return;
    view.cache.reading(read, true);
    try {
      const result = await client.request<RowsResult>(
        "rows",
        {
          table: table.table,
          revision: view.revision,
          plan: view.plan,
          start: read.start,
          end: read.end,
          columns: read.columns,
          // A keyed selection needs locate on the complete view before its position can change.
          ...(!view.info && table.capabilities.preview && !this.host.keyed() ? { preview: true } : {}),
        },
        view.abort.signal,
      );
      if (view !== this.host.current() && view !== this.host.next()) return;
      const block = decodeBlock(result.block.bytes);
      view.cache.receive(
        result.start,
        result.rowIds,
        block.columns.map((column) => column.name),
        block.rows,
        result.truncated,
      );
      const info = result.view;
      view.cache.reading(read, false);
      // A ready event can arrive before the response containing the preview.
      if (
        !(view.info?.status === "ready" && info.status === "building") &&
        (!view.info ||
          view.info.rowCount !== info.rowCount ||
          view.info.status !== info.status ||
          view.info.readableRows !== info.readableRows)
      ) {
        view.info =
          view.info && sameColumns(view.info.columns, info.columns) ? { ...info, columns: view.info.columns } : info;
        if (view === this.host.current()) this.host.showView(view.info);
      }
      if (view === this.host.current()) this.host.showRows();
    } catch (error) {
      view.cache.reading(read, false);
      if (view === this.host.current() || view === this.host.next()) this.host.fail(error);
      throw error;
    }
  }

  /** The columns to read: those asked for, and the row key column (§5.3), which commands need. */
  private withKey(columns: readonly string[]): string[] {
    const key = this.host.rowKey();
    const view = this.host.current()?.info?.columns ?? [];
    if (key === undefined || columns.includes(key) || !view.some((column) => column.name === key)) {
      return [...columns];
    }
    return [...columns, key];
  }

  private readVisible() {
    const view = this.host.current();
    if (!view?.info || !this.host.opened() || this.host.next() || view.abort.signal.aborted) return;
    const { top, rows, columns } = this.viewport;
    if (columns.length === 0) return;
    const margin = Math.max(rows, 32);
    const start = Math.max(0, top - margin);
    const readable = view.info.status === "building" ? view.info.readableRows : view.info.rowCount;
    const end = Math.min(readable, top + rows + margin);
    view.cache.touch(top, top + rows);
    for (const read of view.cache.reads(start, end, this.withKey(columns), readable)) {
      void this.read(view, read).catch(() => {});
    }
    view.cache.evict(this.budget, start, end);
  }
}
