import type { CellValue, ColumnSchema, TableStatus } from "vastgrid-core";
import type { ByteSource } from "./bytes.js";

/** What a reader knows about its file so far. */
export interface ReaderState {
  columns: ColumnSchema[];
  /** `null` while rows are still being counted. */
  rowCount: number | null;
  readableRows: number;
  status: TableStatus;
  progress?: number | null;
  error?: string;
  notes?: string[];
}

/** Reads the rows of one file. The table (`BrowserTable`) builds views, statistics and searches on top. */
export interface TableReader {
  readonly format: string;
  readonly bytes: ByteSource;
  state(): ReaderState;
  /** Resolves when the file is read through (counted), or rejects with the reason it could not be. */
  readonly loaded: Promise<void>;
  /** Reads rows `start` (inclusive) to `end` (exclusive) of schema `columns`, one array per column. Text is whole. */
  read(start: number, end: number, columns: number[], signal?: AbortSignal): Promise<CellValue[][]>;
  /** The range of rows that is read together with `row` (a row group, a block of lines). */
  granule(row: number): [number, number];
  /** Row ranges for reading the whole table in order, each a few tens of thousands of rows. */
  scanRanges(): [number, number][];
  close(): void;
}
