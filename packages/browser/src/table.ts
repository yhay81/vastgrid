import {
  type AggregateRequest,
  ArraySource,
  abortError,
  type CellValue,
  type ColumnSchema,
  type ColumnStats,
  type ColumnType,
  type DistinctRequest,
  type DistinctValues,
  ErrorCodes,
  type Filter,
  type FindRequest,
  type FindResult,
  filterLeaves,
  GroupAccumulator,
  type GroupRequest,
  type GroupResult,
  isAbortError,
  isEmptyQuery,
  isNumericType,
  MAX_TEXT_LIMIT,
  numericValue,
  plainText,
  pruneFilterNode,
  type RowBlock,
  type RowRequest,
  type SelectionSummary,
  SourceError,
  type TableCapabilities,
  type TableInfo,
  type TableSource,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid-core";
import { BlobBytes, type ByteSource, HttpBytes, type HttpOptions, type Transfer } from "./bytes.js";
import { BrowserErrorCodes, errorMessage } from "./errors.js";
import { isParquet, ParquetReader } from "./parquet.js";
import type { TableReader } from "./reader.js";
import { type TextFormat, TextReader } from "./text.js";
import { limitText } from "./values.js";

export type BrowserFormat = "parquet" | TextFormat;

/** What to open: a local file (`File` or `Blob`), or a Parquet file at a URL. */
export type TableInput = { file: Blob; name?: string } | { url: string };

export interface BrowserTableOptions extends Omit<HttpOptions, "fetch"> {
  /** The file format. By default it comes from the file name (`.parquet`, `.csv`, `.tsv`, `.jsonl`, …) or the content. */
  format?: BrowserFormat;
  /** Field separator of CSV; detected by default. */
  delimiter?: string;
  /** Whether the first line of a CSV or TSV holds the column names (default `true`). */
  header?: boolean;
  /** Bytes of a CSV, TSV or JSON Lines file read at a time while counting its rows (default 4 MiB). */
  chunkBytes?: number;
  /**
   * Whether operations that read the whole table are offered: sorting, filters, search, statistics, value
   * lists, find and the selection summary (selecting a whole column reads all of its rows). Default
   * `true` for local files and `false` for URLs, where they would download the whole file.
   */
  fullScan?: boolean;
  /** Longest text sent for a cell unless a request asks otherwise (default 2000). */
  textLimit?: number;
}

const defaultTextLimit = 2000;
/** Rows read at a time by the selection summary and find. */
const batchRows = 16_384;
const keptViews = 8;

interface View {
  id: string;
  key: string;
  rows: Uint32Array;
  query: ViewQuery;
}

function formatOfName(name: string): BrowserFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(name.replace(/[?#].*$/, ""));
  switch (match?.[1].toLowerCase()) {
    case "parquet":
    case "pq":
      return "parquet";
    case "csv":
    case "txt":
      return "csv";
    case "tsv":
    case "tab":
      return "tsv";
    case "jsonl":
    case "ndjson":
    case "json":
      return "json";
    default:
      return null;
  }
}

async function openReader(input: TableInput, options: BrowserTableOptions & HttpOptions, signal: AbortSignal) {
  let bytes: ByteSource;
  let name: string;
  if ("url" in input) {
    bytes = await HttpBytes.open(input.url, options, signal);
    name = new URL(input.url, "http://localhost/").pathname;
  } else {
    bytes = new BlobBytes(input.file);
    name = input.name ?? (input.file as Partial<File>).name ?? "";
  }
  let format = options.format ?? formatOfName(name);
  if (!format) {
    const head = await bytes.read(0, Math.min(bytes.size, 4), signal);
    format = isParquet(head) ? "parquet" : head[0] === 0x7b ? "json" : "csv";
  }
  if (format === "parquet") return ParquetReader.open(bytes, signal);
  if ("url" in input) {
    throw new SourceError(
      ErrorCodes.unsupportedFormat,
      "Only Parquet files can be read from a URL in parts; open CSV, TSV and JSON Lines files as local files.",
      415,
    );
  }
  return new TextReader(bytes, {
    format,
    delimiter: options.delimiter,
    header: options.header,
    chunkBytes: options.chunkBytes,
  });
}

/** A growing list of row positions. */
class Positions {
  private data = new Uint32Array(1024);
  length = 0;

  push(value: number) {
    if (this.length === this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }

  values() {
    return this.data.slice(0, this.length);
  }
}

type SortValue = number | boolean | string | null;

/** Non-finite numbers, which arrive as text. They sort as in DuckDB: -∞ first, then ∞, then NaN. */
const nonFinite = new Map<CellValue, number>([
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["NaN", Number.NaN],
]);

/** Whether the values sort as plain numbers, booleans and text, without the exact comparisons of `ArraySource`. */
function plainSortable(values: CellValue[], type: ColumnType) {
  if (!isNumericType(type)) return true;
  return values.every((value) => typeof value !== "string" || nonFinite.has(value));
}

function rankOf(value: SortValue) {
  return typeof value === "number" ? 0 : typeof value === "boolean" ? 1 : 2;
}

/**
 * The order of positions 0…n-1 by the sort keys, the same as `ArraySource` sorts: blanks last in both
 * directions, numbers before booleans before text, ties in table order.
 */
async function sortOrder(
  keys: { values: CellValue[]; type: ColumnType; direction: "asc" | "desc"; column: number }[],
  count: number,
  schema: ColumnSchema[],
): Promise<Uint32Array> {
  if (!keys.every((key) => plainSortable(key.values, key.type))) {
    // Large integers and decimals arrive as text and need exact comparisons.
    const columnData: CellValue[][] = schema.map(() => []);
    for (const key of keys) columnData[key.column] = key.values;
    const source = new ArraySource({ columns: schema, columnData });
    const view = await source.createView({
      sort: keys.map((key) => ({ column: key.column, direction: key.direction })),
    });
    const rows = await source.readRows({ view: view.id, start: 0, end: count, columns: [] });
    return Uint32Array.from(rows.rowIds ?? []);
  }
  const normalized = keys.map((key) => {
    const numeric = isNumericType(key.type);
    return key.values.map((value): SortValue => {
      if (numeric) return typeof value === "number" ? value : (nonFinite.get(value) ?? null);
      return value === "" ? null : value;
    });
  });
  const order = new Uint32Array(count);
  for (let index = 0; index < count; index++) order[index] = index;
  return order.sort((a, b) => {
    for (let index = 0; index < normalized.length; index++) {
      const left = normalized[index][a];
      const right = normalized[index][b];
      if (left === null || right === null) {
        if (left === null && right === null) continue;
        return left === null ? 1 : -1;
      }
      let result = rankOf(left) - rankOf(right);
      if (result === 0) {
        if (typeof left === "boolean") result = Number(left) - Number(right);
        else if (Number.isNaN(left) || Number.isNaN(right))
          result = Number.isNaN(left) ? (Number.isNaN(right) ? 0 : 1) : -1;
        else result = left < right ? -1 : left > right ? 1 : 0;
      }
      if (result !== 0) return keys[index].direction === "desc" ? -result : result;
    }
    return a - b;
  });
}

/** Spreads the columns read for `columns` over a full-width column list, for `ArraySource`. */
function widen(schema: ColumnSchema[], columns: number[], data: CellValue[][]) {
  const wide: CellValue[][] = schema.map(() => []);
  columns.forEach((column, index) => {
    wide[column] = data[index];
  });
  return wide;
}

/**
 * A table read in the current thread, from a local file or a URL. `BrowserSource` runs one in a worker;
 * use this class directly in your own worker, or where blocking the thread does not matter (tests, Node.js).
 *
 * Views keep only the row positions (4 bytes per row). Sorting and filtering read the columns they need
 * once, in row groups or blocks of lines, and use the same comparisons as `ArraySource`.
 */
export class BrowserTable implements TableSource {
  private reader: TableReader | null = null;
  private opening: Promise<TableReader> | null = null;
  private controller = new AbortController();
  private readonly views = new Map<string, View>();
  private nextView = 1;
  private closed = false;

  constructor(
    private readonly input: TableInput,
    private readonly options: BrowserTableOptions & Pick<HttpOptions, "fetch"> = {},
  ) {}

  private get fullScan() {
    return this.options.fullScan ?? !("url" in this.input);
  }

  /** What the table offers once it is ready (nothing while it loads, as with the DuckDB engine). */
  private capabilities(ready: boolean): TableCapabilities {
    const scan = ready && this.fullScan;
    return {
      sort: scan,
      filter: scan,
      search: scan,
      stats: scan,
      distinct: scan,
      aggregate: scan,
      find: scan,
      export: false,
      conditions: scan,
      group: scan,
      pivot: scan,
      // Formula columns are not evaluated in the worker (see the browser guide).
      formulas: false,
    };
  }

  private open(): Promise<TableReader> {
    if (this.closed) return Promise.reject(new SourceError(ErrorCodes.tableNotFound, "The table is closed.", 404));
    if (this.reader) return Promise.resolve(this.reader);
    if (!this.opening) {
      const opening = openReader(this.input, this.options, this.controller.signal);
      this.opening = opening;
      opening.then(
        (reader) => {
          if (this.opening === opening) this.reader = reader;
          else reader.close();
        },
        () => {
          // The next call tries again.
          if (this.opening === opening) this.opening = null;
        },
      );
    }
    return this.opening;
  }

  /** Forgets the file after it changed: the next `info()` opens it again. */
  private reset() {
    this.reader?.close();
    this.reader = null;
    this.opening = null;
    this.views.clear();
  }

  /**
   * Files at a URL: asks the server whether the file changed (see `HttpBytes.changed`) and, when it did,
   * forgets it, so that the next `info()` opens the new file. Local files cannot be watched: a `File`
   * is a snapshot, which the browser refuses to read once the file on disk changed.
   */
  async checkChanges(signal?: AbortSignal): Promise<boolean> {
    const reader = this.reader;
    if (!reader || !(reader.bytes instanceof HttpBytes)) return false;
    const changed = (await reader.bytes.changed(signal)) === true;
    if (changed && this.reader === reader) this.reset();
    return changed;
  }

  /** Runs an operation on the open file, resetting the table when the file turns out to have changed. */
  private async use<T>(run: (reader: TableReader) => Promise<T>): Promise<T> {
    const reader = await this.open();
    try {
      return await run(reader);
    } catch (error) {
      if (error instanceof SourceError && error.code === BrowserErrorCodes.fileChanged && this.reader === reader)
        this.reset();
      throw error;
    }
  }

  /** Bytes read from the file or the network so far. */
  transfer(): Transfer {
    return { ...(this.reader?.bytes.transfer ?? { bytes: 0, requests: 0 }) };
  }

  async info(signal?: AbortSignal): Promise<TableInfo> {
    let reader: TableReader;
    try {
      reader = await abortable(this.open(), signal);
    } catch (error) {
      if (isAbortError(error) || this.closed) throw error;
      return {
        columns: [],
        rowCount: null,
        readableRows: 0,
        status: "error",
        error: errorMessage(error),
        capabilities: this.capabilities(false),
      };
    }
    const state = reader.state();
    return {
      ...state,
      format: reader.format,
      byteSize: reader.bytes.size,
      revision: reader.bytes.revision,
      capabilities: this.capabilities(state.status === "ready"),
    };
  }

  private requireScan(operation: string) {
    if (!this.fullScan) {
      throw new SourceError(
        ErrorCodes.invalidRequest,
        `${operation} reads the whole table, which this source does not do (fullScan is off).`,
        400,
      );
    }
  }

  private requireReady(reader: TableReader) {
    const state = reader.state();
    if (state.status === "error")
      throw new SourceError(ErrorCodes.loadFailed, state.error ?? "The file could not be read.", 422);
    if (state.status !== "ready") throw new SourceError(ErrorCodes.notReady, "The file is still loading.", 409);
    return state;
  }

  private checkColumns(reader: TableReader, columns: number[]) {
    const count = reader.state().columns.length;
    for (const column of columns) {
      if (!Number.isInteger(column) || column < 0 || column >= count)
        throw new SourceError(ErrorCodes.invalidRequest, `There is no column ${column}.`, 400);
    }
  }

  private view(id: string | null): View | null {
    if (id === null) return null;
    const view = this.views.get(id);
    if (!view) throw new SourceError(ErrorCodes.viewNotFound, "The view no longer exists.", 404);
    // Most recently used last.
    this.views.delete(id);
    this.views.set(id, view);
    return view;
  }

  private viewSize(reader: TableReader, view: View | null) {
    return view ? view.rows.length : reader.state().readableRows;
  }

  /** Values that cannot be compared with a numeric column fail, as they do in DuckDB. */
  private checkFilters(schema: ColumnSchema[], filters: Filter[]) {
    for (const filter of filters) {
      const type = schema[filter.column]?.type;
      if (!type || !isNumericType(type)) continue;
      const bounds =
        filter.type === "compare" ? [filter.value] : filter.type === "between" ? [filter.min, filter.max] : [];
      for (const bound of bounds) {
        if (bound !== undefined && numericValue(typeof bound === "boolean" ? null : bound, type) === null)
          throw new SourceError(ErrorCodes.queryFailed, `Conversion failed: "${bound}" is not a number.`, 400);
      }
    }
  }

  async createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    return this.use(async (reader) => {
      if (query.formulas?.length) {
        throw new SourceError(ErrorCodes.invalidRequest, "This source does not evaluate formula columns.", 400);
      }
      if (isEmptyQuery(query)) return { id: null, rowCount: reader.state().readableRows, query: {} };
      this.requireScan("Sorting and filtering");
      const state = this.requireReady(reader);
      const schema = state.columns;
      const filters = query.filters ?? [];
      const where = pruneFilterNode(query.where);
      const conditions = [...filters, ...filterLeaves(where)];
      const sort = query.sort ?? [];
      const search = query.search?.trim() ?? "";
      this.checkColumns(reader, [...conditions.map((filter) => filter.column), ...sort.map((key) => key.column)]);
      this.checkFilters(schema, conditions);
      const key = JSON.stringify({ filters, where, sort, search });
      for (const view of this.views.values()) {
        if (view.key === key) return { id: view.id, rowCount: view.rows.length, query: view.query };
      }
      const filterColumns = search
        ? schema.map((_, index) => index)
        : [...new Set(conditions.map((item) => item.column))];
      const sortColumns = [...new Set(sort.map((item) => item.column))];
      const columns = [...new Set([...filterColumns, ...sortColumns])];
      const kept = new Positions();
      const sortValues = sortColumns.map(() => [] as CellValue[]);
      const filtering = conditions.length > 0 || search !== "";
      for (const [start, end] of reader.scanRanges()) {
        if (signal?.aborted) throw abortError();
        const data = await reader.read(start, end, columns, signal);
        let local: ArrayLike<number> | null = null;
        if (filtering) {
          const chunk = new ArraySource({ columns: schema, columnData: widen(schema, columns, data) });
          const view = await chunk.createView({ filters, ...(where ? { where } : {}), search });
          local =
            view.id === null
              ? null
              : ((await chunk.readRows({ view: view.id, start: 0, end: view.rowCount, columns: [] })).rowIds ?? []);
        }
        const count = local ? local.length : end - start;
        for (let index = 0; index < count; index++) {
          const row = local ? local[index] : index;
          kept.push(start + row);
          sortColumns.forEach((column, key) => {
            sortValues[key].push(data[columns.indexOf(column)][row]);
          });
        }
      }
      let rows = kept.values();
      if (sort.length > 0) {
        const order = await sortOrder(
          sort.map((item) => ({
            values: sortValues[sortColumns.indexOf(item.column)],
            type: schema[item.column].type,
            direction: item.direction,
            column: item.column,
          })),
          rows.length,
          schema,
        );
        if (signal?.aborted) throw abortError();
        const sorted = new Uint32Array(order.length);
        for (let index = 0; index < order.length; index++) sorted[index] = rows[order[index]];
        rows = sorted;
      }
      const id = `v${this.nextView++}`;
      this.views.set(id, { id, key, rows, query });
      for (const old of this.views.keys()) {
        if (this.views.size <= keptViews) break;
        this.views.delete(old);
      }
      return { id, rowCount: rows.length, query };
    });
  }

  /** Reads the given table rows (in any order), reading each row group or block of lines once. */
  private async readIds(reader: TableReader, ids: ArrayLike<number>, columns: number[], signal?: AbortSignal) {
    const result = columns.map(() => new Array<CellValue>(ids.length));
    const order = Array.from({ length: ids.length }, (_, index) => index).sort((a, b) => ids[a] - ids[b]);
    let index = 0;
    while (index < order.length) {
      const first = ids[order[index]];
      const [, granuleEnd] = reader.granule(first);
      let last = index;
      while (last + 1 < order.length && ids[order[last + 1]] < granuleEnd) last++;
      const data = await reader.read(first, ids[order[last]] + 1, columns, signal);
      for (let item = index; item <= last; item++) {
        const position = order[item];
        const offset = ids[position] - first;
        for (let column = 0; column < columns.length; column++) result[column][position] = data[column][offset] ?? null;
      }
      index = last + 1;
    }
    return result;
  }

  /** Reads positions `start` to `end` of a view (or of the table). */
  private async readPositions(
    reader: TableReader,
    view: View | null,
    start: number,
    end: number,
    columns: number[],
    signal?: AbortSignal,
  ) {
    if (!view) return reader.read(start, end, columns, signal);
    return this.readIds(reader, view.rows.subarray(start, end), columns, signal);
  }

  async readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock> {
    return this.use(async (reader) => {
      const view = this.view(request.view);
      this.checkColumns(reader, request.columns);
      const size = this.viewSize(reader, view);
      const end = Math.max(0, Math.min(request.end, size));
      const start = Math.max(0, Math.min(request.start, end));
      const data = await this.readPositions(reader, view, start, end, request.columns, signal);
      if (signal?.aborted) throw abortError();
      const limit = Math.min(
        Math.max(1, request.textLimit ?? this.options.textLimit ?? defaultTextLimit),
        MAX_TEXT_LIMIT,
      );
      const schema = reader.state().columns;
      const columns = data.map((values, index) => limitText(values, schema[request.columns[index]].type, limit));
      return { start, end, columns, rowIds: view ? Array.from(view.rows.subarray(start, end)) : null };
    });
  }

  /** Every value of `column` in a view (or the table), in table order. */
  private async collect(reader: TableReader, view: View | null, column: number, signal?: AbortSignal) {
    const values: CellValue[] = [];
    const ids = view ? view.rows.slice().sort() : null;
    let next = 0;
    for (const [start, end] of reader.scanRanges()) {
      if (signal?.aborted) throw abortError();
      if (!ids) {
        for (const value of (await reader.read(start, end, [column], signal))[0]) values.push(value);
        continue;
      }
      let last = next;
      while (last < ids.length && ids[last] < end) last++;
      if (last === next) continue;
      const first = ids[next];
      const [data] = await reader.read(first, ids[last - 1] + 1, [column], signal);
      for (let index = next; index < last; index++) values.push(data[ids[index] - first]);
      next = last;
    }
    return values;
  }

  /** An `ArraySource` holding one column, to compute statistics the way it does. */
  private single(reader: TableReader, column: number, values: CellValue[]) {
    const schema = reader.state().columns;
    const columnData: CellValue[][] = schema.map(() => []);
    columnData[column] = values;
    return new ArraySource({ columns: schema, columnData });
  }

  async columnStats(viewId: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats> {
    return this.use(async (reader) => {
      this.requireScan("Column statistics");
      this.requireReady(reader);
      this.checkColumns(reader, [column]);
      const values = await this.collect(reader, this.view(viewId), column, signal);
      return this.single(reader, column, values).columnStats(null, column);
    });
  }

  async distinctValues(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues> {
    return this.use(async (reader) => {
      this.requireScan("Value lists");
      this.requireReady(reader);
      this.checkColumns(reader, [request.column]);
      const values = await this.collect(reader, this.view(request.view), request.column, signal);
      return this.single(reader, request.column, values).distinctValues({ ...request, view: null });
    });
  }

  async aggregate(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary> {
    return this.use(async (reader) => {
      const view = this.view(request.view);
      const size = this.viewSize(reader, view);
      const schema = reader.state().columns;
      let count = 0;
      let numericCount = 0;
      let sum = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const range of request.ranges) {
        this.checkColumns(reader, range.columns);
        const end = Math.min(range.end, size);
        for (let start = Math.max(0, range.start); start < end; start += batchRows) {
          if (signal?.aborted) throw abortError();
          const stop = Math.min(end, start + batchRows);
          const data = await this.readPositions(reader, view, start, stop, range.columns, signal);
          const chunk = new ArraySource({ columns: schema, columnData: widen(schema, range.columns, data) });
          const part = await chunk.aggregate({
            view: null,
            ranges: [{ start: 0, end: stop - start, columns: range.columns }],
          });
          count += part.count;
          numericCount += part.numericCount;
          sum += part.sum ?? 0;
          if (part.min !== null && part.min < min) min = part.min;
          if (part.max !== null && part.max > max) max = part.max;
        }
      }
      return {
        count,
        numericCount,
        sum: numericCount > 0 ? sum : null,
        min: numericCount > 0 ? min : null,
        max: numericCount > 0 ? max : null,
        average: numericCount > 0 ? sum / numericCount : null,
      };
    });
  }

  /** Groups in one pass over the file (or the view's rows), with the accumulator of `ArraySource`. */
  async group(request: GroupRequest, signal?: AbortSignal): Promise<GroupResult> {
    return this.use(async (reader) => {
      this.requireScan("Grouping");
      const state = this.requireReady(reader);
      const view = this.view(request.view);
      const accumulator = new GroupAccumulator(state.columns, request);
      const columns = accumulator.columns;
      const ids = view ? view.rows.slice().sort() : null;
      let next = 0;
      for (const [start, end] of reader.scanRanges()) {
        if (signal?.aborted) throw abortError();
        if (!ids) {
          accumulator.add(await reader.read(start, end, columns, signal), end - start, signal);
          continue;
        }
        let last = next;
        while (last < ids.length && ids[last] < end) last++;
        if (last === next) continue;
        const first = ids[next];
        const data = await reader.read(first, ids[last - 1] + 1, columns, signal);
        const picked = data.map((values) => {
          const kept: CellValue[] = [];
          for (let index = next; index < last; index++) kept.push(values[ids[index] - first] ?? null);
          return kept;
        });
        accumulator.add(picked, last - next, signal);
        next = last;
      }
      return accumulator.result();
    });
  }

  async find(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null> {
    return this.use(async (reader) => {
      this.requireScan("Find");
      this.checkColumns(reader, request.columns);
      const view = this.view(request.view);
      const size = this.viewSize(reader, view);
      const needle = request.caseSensitive ? request.text : request.text.toLowerCase();
      const width = request.columns.length;
      if (!needle || width === 0 || size === 0) return null;
      const total = size * width;
      let position = request.row * width + request.column;
      let window: { start: number; end: number; data: CellValue[][] } | null = null;
      for (let step = 0; step < total; step++) {
        position = (((position + request.direction) % total) + total) % total;
        const row = Math.floor(position / width);
        const column = position % width;
        if (!window || row < window.start || row >= window.end) {
          if (signal?.aborted) throw abortError();
          const start = request.direction === 1 ? row : Math.max(0, row - batchRows + 1);
          const end = request.direction === 1 ? Math.min(size, row + batchRows) : row + 1;
          window = { start, end, data: await this.readPositions(reader, view, start, end, request.columns, signal) };
        }
        const text = plainText(window.data[column][row - window.start]);
        if ((request.caseSensitive ? text : text.toLowerCase()).includes(needle)) return { row, column };
      }
      return null;
    });
  }

  close() {
    this.closed = true;
    this.controller.abort();
    this.reset();
  }
}

/** Waits for `promise`, but rejects with an AbortError as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
