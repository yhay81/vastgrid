import { MAX_TEXT_LIMIT, type TableSource } from "./source.js";
import type { CellStyle, CellValue } from "./types.js";

export interface RowCacheOptions {
  /** Rows per block. */
  blockRows?: number;
  /** Columns per block. Wide tables are fetched in column groups so that only visible columns load. */
  blockColumns?: number;
  /** Blocks kept in memory before the least recently used ones are dropped. */
  maxBlocks?: number;
  /** Requests in flight at the same time. */
  concurrency?: number;
  /** A failed block is retried when it is wanted again after this many milliseconds. */
  retryDelay?: number;
}

export type BlockState = "queued" | "loading" | "ready" | "error";

/** Rows `[start, end)` of the columns `[firstColumn, firstColumn + columns.length)`. */
export class CacheBlock {
  state: BlockState = "queued";
  values: CellValue[][] | null = null;
  rowIds: number[] | null = null;
  error: unknown = null;
  failedAt = 0;
  controller: AbortController | null = null;
  used = 0;
  priority = 0;
  /** Display text, filled lazily by a renderer. `textKey` tells which formatting produced it. */
  text: (string | undefined)[][] | null = null;
  /** Cell colors from the columns' `style` settings, filled with `text` and cleared with it (`null`: defaults). */
  styles: (CellStyle | null | undefined)[][] | null = null;
  textKey = "";

  constructor(
    readonly key: string,
    readonly rowBlock: number,
    readonly colBlock: number,
    readonly start: number,
    readonly end: number,
    readonly firstColumn: number,
    readonly columns: readonly number[],
  ) {}
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Caches rows of one view in blocks. The grid calls `want()` with the visible window on every
 * frame; the cache loads missing blocks around it (visible first, then one screen ahead and behind),
 * cancels requests that scrolled far away, and drops old blocks beyond `maxBlocks`.
 */
export class RowCache {
  readonly blockRows: number;
  readonly blockColumns: number;
  private readonly maxBlocks: number;
  private readonly concurrency: number;
  private readonly retryDelay: number;
  private readonly blocks = new Map<string, CacheBlock>();
  private readonly rowIdsByBlock = new Map<number, number[]>();
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private queue: CacheBlock[] = [];
  private inFlight = 0;
  private clock = 0;
  private notifyScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private viewId: string | null = null;
  private rows = 0;
  private readable = 0;
  private columnCount = 0;
  private generation = 0;

  constructor(
    private readonly source: TableSource,
    options: RowCacheOptions = {},
  ) {
    this.blockRows = options.blockRows ?? 256;
    this.blockColumns = options.blockColumns ?? 48;
    this.maxBlocks = options.maxBlocks ?? 600;
    this.concurrency = options.concurrency ?? 4;
    this.retryDelay = options.retryDelay ?? 2000;
  }

  get view() {
    return this.viewId;
  }

  get rowCount() {
    return this.rows;
  }

  get readableRows() {
    return this.readable;
  }

  /** Blocks currently held (for diagnostics and tests). */
  get size() {
    return this.blocks.size;
  }

  get pending() {
    return this.inFlight + this.queue.length;
  }

  /**
   * Points the cache at a view. A different view or column count clears the cache. While a table is
   * loading, only `readableRows` can be fetched; blocks cut short by that limit are fetched again
   * once more rows become readable.
   */
  setView(view: string | null, rowCount: number, readableRows: number, columnCount: number) {
    if (view !== this.viewId || columnCount !== this.columnCount) {
      this.clear();
      this.viewId = view;
      this.columnCount = columnCount;
    }
    const previousReadable = this.readable;
    this.rows = Math.max(0, rowCount);
    this.readable = clamp(readableRows, 0, this.rows);
    if (this.readable !== previousReadable) {
      for (const block of [...this.blocks.values()]) {
        const complete = Math.min((block.rowBlock + 1) * this.blockRows, this.readable);
        if (block.end < complete || block.start >= this.readable) this.drop(block);
      }
    }
  }

  /** Drops every block and cancels every request. */
  clear() {
    this.generation++;
    clearTimeout(this.retryTimer);
    for (const block of this.blocks.values()) block.controller?.abort();
    this.blocks.clear();
    this.rowIdsByBlock.clear();
    this.queue = [];
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Errors other than cancellation, for example a lost connection. */
  onError(listener: (error: unknown) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }

  private keyOf(rowBlock: number, colBlock: number) {
    return `${rowBlock}:${colBlock}`;
  }

  /** The block holding the cell, if it has been requested. */
  blockAt(row: number, column: number): CacheBlock | undefined {
    return this.blocks.get(this.keyOf(Math.floor(row / this.blockRows), Math.floor(column / this.blockColumns)));
  }

  /** The value of a loaded cell, or `undefined` while it is not loaded. */
  value(row: number, column: number): CellValue | undefined {
    const block = this.blockAt(row, column);
    if (block?.state !== "ready" || !block.values || row >= block.end) return undefined;
    return block.values[column - block.firstColumn]?.[row - block.start];
  }

  /** The row's position in the original table, when the view reports it. */
  rowId(row: number): number | undefined {
    const rowBlock = Math.floor(row / this.blockRows);
    return this.rowIdsByBlock.get(rowBlock)?.[row - rowBlock * this.blockRows];
  }

  private drop(block: CacheBlock) {
    block.controller?.abort();
    this.blocks.delete(block.key);
    if (block.state === "queued") this.queue = this.queue.filter((item) => item !== block);
  }

  private ensure(rowBlock: number, colBlock: number): CacheBlock | null {
    const key = this.keyOf(rowBlock, colBlock);
    const existing = this.blocks.get(key);
    if (existing) {
      if (existing.state === "error" && Date.now() - existing.failedAt > this.retryDelay) {
        this.blocks.delete(key);
      } else {
        return existing;
      }
    }
    const start = rowBlock * this.blockRows;
    const end = Math.min(start + this.blockRows, this.readable);
    const firstColumn = colBlock * this.blockColumns;
    const lastColumn = Math.min(firstColumn + this.blockColumns, this.columnCount);
    if (start >= end || firstColumn >= lastColumn) return null;
    const columns: number[] = [];
    for (let column = firstColumn; column < lastColumn; column++) columns.push(column);
    const block = new CacheBlock(key, rowBlock, colBlock, start, end, firstColumn, columns);
    this.blocks.set(key, block);
    this.queue.push(block);
    return block;
  }

  /**
   * Declares the visible rows `[rowStart, rowEnd)` and the visible schema columns. Loads what is
   * missing and prefetches one screen in both directions.
   */
  want(rowStart: number, rowEnd: number, columns: Iterable<number>) {
    const readable = this.readable;
    if (readable === 0 || this.columnCount === 0) return;
    const visibleStart = clamp(rowStart, 0, readable);
    const visibleEnd = clamp(rowEnd, visibleStart, readable);
    const margin = Math.max(visibleEnd - visibleStart, this.blockRows);
    const firstRowBlock = Math.floor(clamp(visibleStart - margin, 0, readable) / this.blockRows);
    const lastRowBlock = Math.floor((clamp(visibleEnd + margin, 0, readable) - 1) / this.blockRows);
    const colBlocks = new Set<number>();
    for (const column of columns) {
      if (column >= 0 && column < this.columnCount) colBlocks.add(Math.floor(column / this.blockColumns));
    }
    if (colBlocks.size === 0) colBlocks.add(0);
    const wanted = new Set<string>();
    const tick = ++this.clock;
    for (let rowBlock = firstRowBlock; rowBlock <= lastRowBlock; rowBlock++) {
      const blockStart = rowBlock * this.blockRows;
      const blockEnd = blockStart + this.blockRows;
      const distance =
        blockEnd <= visibleStart
          ? visibleStart - blockEnd + 1
          : blockStart >= visibleEnd
            ? blockStart - visibleEnd + 1
            : 0;
      for (const colBlock of colBlocks) {
        const block = this.ensure(rowBlock, colBlock);
        if (!block) continue;
        block.used = tick;
        block.priority = distance;
        wanted.add(block.key);
      }
    }
    // Requests for blocks that are no longer near the screen only delay the visible ones.
    for (const block of [...this.blocks.values()]) {
      if (wanted.has(block.key)) continue;
      if (block.state === "queued" || block.state === "loading") this.drop(block);
    }
    this.queue.sort((a, b) => a.priority - b.priority);
    this.evict(wanted);
    this.pump();
  }

  private evict(wanted: Set<string>) {
    if (this.blocks.size <= this.maxBlocks) return;
    const candidates = [...this.blocks.values()]
      .filter((block) => !wanted.has(block.key) && (block.state === "ready" || block.state === "error"))
      .sort((a, b) => a.used - b.used);
    for (const block of candidates) {
      if (this.blocks.size <= this.maxBlocks) break;
      this.blocks.delete(block.key);
      if (block.colBlock === 0 || !this.hasRowBlock(block.rowBlock)) this.rowIdsByBlock.delete(block.rowBlock);
    }
  }

  private hasRowBlock(rowBlock: number) {
    for (const block of this.blocks.values()) if (block.rowBlock === rowBlock && block.state === "ready") return true;
    return false;
  }

  private pump() {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const block = this.queue.shift();
      if (block?.state !== "queued") continue;
      this.load(block);
    }
  }

  private load(block: CacheBlock) {
    const generation = this.generation;
    const controller = new AbortController();
    block.state = "loading";
    block.controller = controller;
    this.inFlight++;
    this.source
      .readRows(
        { view: this.viewId, start: block.start, end: block.end, columns: [...block.columns] },
        controller.signal,
      )
      .then((result) => {
        if (generation !== this.generation || this.blocks.get(block.key) !== block) return;
        block.values = result.columns;
        block.rowIds = result.rowIds ?? null;
        block.state = "ready";
        if (block.rowIds) this.rowIdsByBlock.set(block.rowBlock, block.rowIds);
        this.notify();
      })
      .catch((error: unknown) => {
        // Only this block's own cancellation is silent. Anything else, also an AbortError from work
        // the source shared with a cancelled request, marks the block failed so that it is retried.
        if (controller.signal.aborted) return;
        if (generation !== this.generation || this.blocks.get(block.key) !== block) return;
        block.state = "error";
        block.error = error;
        block.failedAt = Date.now();
        for (const listener of this.errorListeners) listener(error);
        this.notify();
        // Tell the listeners again once the block may be retried, so that a grid asks for it by itself.
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.notify(), this.retryDelay + 10);
      })
      .finally(() => {
        block.controller = null;
        this.inFlight--;
        this.pump();
      });
  }

  /**
   * Reads rows `[start, end)` of the given schema columns directly from the source, in chunks, for
   * copying and exporting. Values are returned per column, in the order of `columns`, with their whole
   * text, and all of them from the view shown when the reading started.
   */
  async read(
    start: number,
    end: number,
    columns: readonly number[],
    signal?: AbortSignal,
    onProgress?: (done: number) => void,
  ): Promise<CellValue[][]> {
    const result: CellValue[][] = columns.map(() => []);
    if (columns.length === 0 || end <= start) return result;
    const view = this.viewId;
    // About 200,000 cells per request, also for wide tables: servers limit the cells of one request.
    const chunk = Math.max(1, Math.floor(200_000 / columns.length));
    for (let from = start; from < end; from += chunk) {
      const to = Math.min(end, from + chunk);
      const block = await this.source.readRows(
        { view, start: from, end: to, columns: [...columns], textLimit: MAX_TEXT_LIMIT },
        signal,
      );
      block.columns.forEach((values, index) => {
        const target = result[index];
        for (const value of values) target.push(value);
      });
      onProgress?.(to - start);
    }
    return result;
  }
}
