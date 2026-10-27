import type { JsonValue, LoadedRow, RowKey } from "vastgrid-spec";

/** Rows in a block of the cache: reads cover whole blocks. */
export const BLOCK_ROWS = 256;

/** A read of rows `[start, end)` of a view, for some of its columns. */
export interface Read {
  start: number;
  end: number;
  columns: string[];
}

/** Rows of a view that the engine gave, by column. */
interface Block {
  readonly index: number;
  /** Rows held: `BLOCK_ROWS`, fewer at the end of the view; 0 until a read answers. */
  length: number;
  /** Row IDs of the rows; null for views without them, undefined until a read answers. */
  rowIds: number[] | null | undefined;
  readonly values: Map<string, JsonValue[]>;
  /** Offsets of the values that the engine cut to the text limit (§8.4), by column. */
  readonly cut: Map<string, Set<number>>;
  /** Columns being read. */
  readonly reading: Set<string>;
  used: number;
  bytes: number;
}

/** Bytes that a value takes in the cache, roughly. */
function sizeOf(value: JsonValue): number {
  if (typeof value === "string") return 16 + value.length * 2;
  return 8;
}

/**
 * The rows of one view that the store has read, in blocks of `BLOCK_ROWS` rows, with a budget of bytes beyond
 * which the blocks used least recently leave (§4.1 of react.md: rows are not in snapshots).
 */
export class ViewCache {
  private readonly blocks = new Map<number, Block>();
  private clock = 0;
  /** Bytes the blocks take, roughly. */
  bytes = 0;
  /** Changes whenever rows arrive or leave. */
  version = 0;

  private block(row: number): Block | undefined {
    return this.blocks.get(Math.floor(row / BLOCK_ROWS));
  }

  private ensure(index: number): Block {
    let block = this.blocks.get(index);
    if (!block) {
      block = {
        index,
        length: 0,
        rowIds: undefined,
        values: new Map(),
        cut: new Map(),
        reading: new Set(),
        used: 0,
        bytes: 0,
      };
      this.blocks.set(index, block);
    }
    return block;
  }

  /** The value of a cell; undefined while it is not read. */
  value(row: number, column: string): JsonValue | undefined {
    const block = this.block(row);
    const offset = row - (block?.index ?? 0) * BLOCK_ROWS;
    if (!block || offset >= block.length) return undefined;
    return block.values.get(column)?.[offset];
  }

  /** Whether the engine cut the value of a cell to the text limit, so that the grid shows that it goes on. */
  isCut(row: number, column: string): boolean {
    const block = this.block(row);
    return block?.cut.get(column)?.has(row - block.index * BLOCK_ROWS) ?? false;
  }

  /** The row ID of a row; undefined while it is not read or in a view without row IDs. */
  rowId(row: number): number | undefined {
    const block = this.block(row);
    if (!block?.rowIds) return undefined;
    return block.rowIds[row - block.index * BLOCK_ROWS];
  }

  /** A row as commands read it (§6.1): its key and its values, or undefined while it is not read. */
  loaded(row: number, rowKey: string | undefined): LoadedRow | undefined {
    const block = this.block(row);
    const offset = row - (block?.index ?? 0) * BLOCK_ROWS;
    if (!block || block.rowIds === undefined || offset >= block.length) return undefined;
    let key: RowKey | undefined;
    const id = block.rowIds?.[offset];
    if (id !== undefined) {
      if (rowKey === undefined) key = { rowId: id };
      else {
        // A row whose key column is null is keyed by its row ID (§5.3).
        const value = block.values.get(rowKey)?.[offset];
        if (value !== undefined) key = value === null ? { rowId: id } : { value };
      }
    }
    const values = block.values;
    return {
      ...(key === undefined ? {} : { key }),
      has: (column) => values.has(column),
      get: (column) => values.get(column)?.[offset] ?? null,
    };
  }

  /**
   * What to read so that rows `[start, end)` have `columns`: reads of runs of blocks that lack the same columns,
   * each of at most `maxCells` cells, leaving out what is read or being read.
   */
  reads(start: number, end: number, columns: readonly string[], rowCount: number, maxCells = 262_144): Read[] {
    const reads: Read[] = [];
    if (end <= start || columns.length === 0) return reads;
    const last = Math.floor((Math.min(end, rowCount) - 1) / BLOCK_ROWS);
    let run: { first: number; last: number; columns: string[]; key: string } | null = null;
    const flush = () => {
      if (!run) return;
      reads.push({
        start: run.first * BLOCK_ROWS,
        end: Math.min((run.last + 1) * BLOCK_ROWS, rowCount),
        columns: run.columns,
      });
      run = null;
    };
    for (let index = Math.floor(start / BLOCK_ROWS); index <= last; index++) {
      const block = this.blocks.get(index);
      // A block read while the view was shorter (a table or view still being made, §9) is read again whole.
      const short =
        block !== undefined &&
        block.rowIds !== undefined &&
        block.length < Math.min(BLOCK_ROWS, rowCount - index * BLOCK_ROWS);
      const missing =
        block && !short
          ? columns.filter((column) => !block.values.has(column) && !block.reading.has(column))
          : columns.filter((column) => !block?.reading.has(column));
      if (missing.length === 0) {
        flush();
        continue;
      }
      const key = missing.join("\u0000");
      const blocks = Math.max(1, Math.floor(maxCells / (missing.length * BLOCK_ROWS)));
      if (run && run.key === key && index === run.last + 1 && run.last - run.first + 1 < blocks) {
        run.last = index;
      } else {
        flush();
        run = { first: index, last: index, columns: missing, key };
      }
    }
    flush();
    return reads;
  }

  /** Marks the columns of a read as being read, or no longer. */
  reading(read: Read, on: boolean) {
    for (let index = Math.floor(read.start / BLOCK_ROWS); index * BLOCK_ROWS < read.end; index++) {
      const block = this.ensure(index);
      for (const column of read.columns) {
        if (on) block.reading.add(column);
        else block.reading.delete(column);
      }
    }
  }

  /**
   * Takes the rows of a read, which starts at a block: `rows` holds the values of `columns` for rows `start` to
   * `start + rows.length`.
   */
  receive(
    start: number,
    rowIds: number[] | null,
    columns: readonly string[],
    rows: readonly (readonly JsonValue[])[],
    cut: Record<string, number[]> | undefined,
  ) {
    const end = start + rows.length;
    for (let index = Math.floor(start / BLOCK_ROWS); index * BLOCK_ROWS < end; index++) {
      const block = this.ensure(index);
      const before = block.bytes;
      const first = Math.max(start, index * BLOCK_ROWS);
      const stop = Math.min(end, (index + 1) * BLOCK_ROWS);
      block.length = Math.max(block.length, stop - index * BLOCK_ROWS);
      // A view that is still being made may have more rows in its last block at a later read (§9).
      const ids = rowIds === null ? null : rowIds.slice(first - start, stop - start);
      if (block.rowIds === undefined || (ids !== null && block.rowIds !== null && ids.length > block.rowIds.length)) {
        block.rowIds = ids;
      }
      columns.forEach((column, position) => {
        let values = block.values.get(column);
        if (!values) {
          values = new Array<JsonValue>(BLOCK_ROWS);
          block.values.set(column, values);
        }
        for (let row = first; row < stop; row++) {
          const value = rows[row - start][position] ?? null;
          const offset = row - index * BLOCK_ROWS;
          const old = values[offset];
          if (old !== undefined) block.bytes -= sizeOf(old);
          values[offset] = value;
          block.bytes += sizeOf(value);
        }
        block.reading.delete(column);
        const offsets = cut?.[column];
        if (offsets) {
          const set = block.cut.get(column) ?? new Set<number>();
          for (const offset of offsets) {
            const row = start + offset;
            if (row >= first && row < stop) set.add(row - index * BLOCK_ROWS);
          }
          block.cut.set(column, set);
        }
      });
      this.bytes += block.bytes - before;
    }
    this.version++;
  }

  /** Marks the blocks of rows `[start, end)` as used now, so that they leave last. */
  touch(start: number, end: number) {
    const time = ++this.clock;
    for (let index = Math.floor(start / BLOCK_ROWS); index * BLOCK_ROWS < end; index++) {
      const block = this.blocks.get(index);
      if (block) block.used = time;
    }
  }

  /** Removes the blocks used least recently until the cache fits `budget` bytes, keeping rows `[start, end)`. */
  evict(budget: number, start: number, end: number) {
    if (this.bytes <= budget) return;
    const first = Math.floor(start / BLOCK_ROWS);
    const last = Math.floor(Math.max(start, end - 1) / BLOCK_ROWS);
    const candidates = [...this.blocks.values()]
      .filter((block) => (block.index < first || block.index > last) && block.reading.size === 0)
      .sort((a, b) => a.used - b.used);
    for (const block of candidates) {
      if (this.bytes <= budget) break;
      this.blocks.delete(block.index);
      this.bytes -= block.bytes;
    }
    this.version++;
  }
}
