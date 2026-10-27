/**
 * Columns of a file that are read when requests need them: a Parquet file's, and a text file's whose columns would
 * take more memory than `maxBytes`. Rows are read by the parts of the file that hold them (a Parquet file's row
 * groups, a text file's blocks of rows); a column is read whole when a request goes through every row of it, within
 * `maxBytes`, and stays so until a request needs its room while none reads it.
 */
import type { Column, JsonValue } from "vastgrid-spec";
import { type CheckedTable, TableProblem, type Vector } from "./table.js";

/** A column that is not read whole yet: requests read it by `FileColumns.cells`, or read it whole first. */
function unread(length: number, name: string): Vector {
  return {
    length,
    at() {
      throw new Error(`The column "${name}" of the file is read before its values are.`);
    },
  };
}

export abstract class FileColumns {
  /** Each column by row: `unread` until it is read whole. */
  readonly vectors: Vector[];
  /** Calls the engine when a column read whole is forgotten, so that it forgets what it made of it. */
  forgotten: (index: number) => void = () => {};
  /** The columns being read whole or read, which every request that needs them waits for. */
  private readonly reading = new Map<number, Promise<void>>();
  /** The columns read whole, which `vectors` hold, the least recently used first. */
  private readonly whole = new Set<number>();
  /** How many requests read each column whole now: those that no request reads may be forgotten. */
  private readonly holds = new Map<number, number>();
  /** The bytes that the columns read whole and being read take. */
  private used = 0;

  constructor(
    readonly columns: Column[],
    readonly rowCount: number,
    private readonly maxBytes: number,
  ) {
    this.vectors = columns.map((column) => unread(rowCount, column.name));
  }

  /** The table that the engine reads: the columns' values are read when a request needs them. */
  checked(): CheckedTable {
    return { columns: this.columns, rows: null, vectors: this.vectors, rowCount: this.rowCount, reader: this };
  }

  /** The part of the file that holds a row. */
  protected abstract partOf(row: number): number;
  /** The memory that a column read whole takes, `Infinity` for a column that cannot be. */
  protected abstract sizeOf(index: number): number;
  /** Reads columns whole, calling `pause` between parts of the file, and gives them by row. */
  protected abstract readWhole(indexes: number[], pause: () => Promise<void>): Promise<Vector[]>;
  /** The values of a column at rows, in their order, of the parts of the file that hold them. */
  protected abstract readCells(index: number, rows: ArrayLike<number>): Promise<JsonValue[]>;
  /** Forgets the parts read. */
  abstract close(): void;

  /**
   * Readies the columns of rows that a request is about to read. Rows in more than `spread` parts, as those of a
   * sorted or filtered view are, read their columns whole while `maxBytes` leaves room for them, so that the view's
   * other rows are read from memory rather than from every part again.
   */
  async prepare(indexes: Iterable<number>, rows: ArrayLike<number>, pause: () => Promise<void>): Promise<void> {
    const parts = new Set<number>();
    for (let at = 0; at < rows.length && parts.size <= this.spread; at++) parts.add(this.partOf(rows[at]));
    if (parts.size <= this.spread) return;
    let room = this.maxBytes - this.used;
    const fitting: number[] = [];
    for (const index of new Set(indexes)) {
      if (this.reading.has(index)) continue;
      const size = this.sizeOf(index);
      if (size > room) continue;
      fitting.push(index);
      room -= size;
    }
    if (fitting.length > 0) (await this.read(fitting, pause))();
  }

  /** The parts of the file that the rows of a request may lie in before `prepare` reads their columns whole. */
  protected get spread(): number {
    return 2;
  }

  /** The values of a column at rows, in their order: of the column read whole, or of the parts that hold them. */
  async cells(index: number, rows: ArrayLike<number>): Promise<JsonValue[]> {
    // A column that another request reads whole is read from memory once it is, or from its parts if that fails.
    await this.reading.get(index)?.catch(() => undefined);
    if (!this.whole.has(index)) return this.readCells(index, rows);
    this.touch(index);
    const vector = this.vectors[index];
    return Array.from(rows, (row) => vector.at(row));
  }

  /**
   * Reads columns whole, calling `pause` between parts of the file; `vectors` then hold them until the request
   * calls the function given back. Columns read whole stay so while `maxBytes` has room for them: those that no
   * request reads are forgotten, the least recently used first, when a request needs their room. Fails with a
   * `TableProblem` at `/maxBytes` when the columns that requests read whole would take more than `maxBytes`.
   */
  async read(indexes: Iterable<number>, pause: () => Promise<void>): Promise<() => void> {
    const wanted = [...new Set(indexes)];
    for (const index of wanted) this.holds.set(index, (this.holds.get(index) ?? 0) + 1);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      for (const index of wanted) {
        const count = (this.holds.get(index) as number) - 1;
        if (count === 0) this.holds.delete(index);
        else this.holds.set(index, count);
      }
    };
    try {
      const missing = wanted.filter((index) => !this.reading.has(index));
      if (missing.length > 0) {
        const total = missing.reduce((sum, index) => sum + this.sizeOf(index), 0);
        if (!this.makeRoom(total)) {
          const names = missing.map((index) => `"${this.columns[index].name}"`).join(", ");
          throw new TableProblem(
            "/maxBytes",
            Number.isFinite(total)
              ? `Reading ${names} whole would take ${megabytes(this.used - this.idle() + total)} in memory, more than maxBytes (${megabytes(this.maxBytes)}).`
              : `${names} cannot be read whole: a column's text is more than 4 GiB.`,
          );
        }
        this.used += total;
        const reading = this.readWhole(missing, pause).then((vectors) => {
          missing.forEach((index, at) => {
            this.vectors[index] = vectors[at];
            this.whole.add(index);
          });
        });
        for (const index of missing) this.reading.set(index, reading);
        reading.catch(() => {
          for (const index of missing) if (this.reading.get(index) === reading) this.reading.delete(index);
          this.used -= total;
        });
      }
      await Promise.all(wanted.map((index) => this.reading.get(index)));
      for (const index of wanted) this.touch(index);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Marks a column read whole as the most recently used. */
  private touch(index: number) {
    if (this.whole.delete(index)) this.whole.add(index);
  }

  /** The bytes of the columns read whole that no request reads now. */
  private idle(): number {
    let bytes = 0;
    for (const index of this.whole) if (!this.holds.has(index)) bytes += this.sizeOf(index);
    return bytes;
  }

  /**
   * Forgets columns read whole that no request reads, the least recently used first, until `maxBytes` has room
   * for `bytes` more; forgets none when it would not have room even so. Gives whether it has room.
   */
  private makeRoom(bytes: number): boolean {
    let over = this.used + bytes - this.maxBytes;
    if (over <= 0) return true;
    if (this.idle() < over) return false;
    for (const index of [...this.whole]) {
      if (over <= 0) break;
      if (this.holds.has(index)) continue;
      const size = this.sizeOf(index);
      this.whole.delete(index);
      this.reading.delete(index);
      this.vectors[index] = unread(this.rowCount, this.columns[index].name);
      this.used -= size;
      over -= size;
      this.forgotten(index);
    }
    return true;
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / 2 ** 20)} MiB`;
}
