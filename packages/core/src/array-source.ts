import { editableType, normalizeCellValue, sameCellValue } from "./cell-input.js";
import { isNumericType } from "./column-type.js";
import { EXPORT_MEDIA_TYPES, TABLE_FILE_FORMATS, type TableFileFormat, writeTableFile } from "./export-file.js";
import { matchesFilterNode, pruneFilterNode } from "./filter-tree.js";
import { numericValue, plainText } from "./format.js";
import { ErrorCodes } from "./protocol.js";
import {
  abortError,
  isEmptyQuery,
  MAX_UPDATE_CELLS,
  SourceError,
  type TableChangeListener,
  type TableSource,
} from "./source.js";
import type {
  AggregateRequest,
  CellValue,
  ColumnSchema,
  ColumnStats,
  ColumnType,
  DistinctRequest,
  DistinctValues,
  ExportRequest,
  ExportResult,
  Filter,
  FindRequest,
  FindResult,
  RowBlock,
  RowRequest,
  SelectionSummary,
  TableEdits,
  TableInfo,
  UpdateRequest,
  UpdateResult,
  ViewInfo,
  ViewQuery,
} from "./types.js";
import { checkXlsxSize } from "./xlsx-writer.js";

export interface ArraySourceOptions {
  /** Column names, or full schemas. Types are inferred from the values when only names are given. */
  columns: (string | ColumnSchema)[];
  /** Row-major data. Provide either `rows` or `columnData`. */
  rows?: CellValue[][];
  /** Column-major data: one array per column. */
  columnData?: CellValue[][];
  /**
   * Lets the grid write cells (`updateCells`), into these arrays. Columns marked `readOnly`, and of types
   * that cannot be written (lists, structs, maps, binary values, intervals), stay read-only. Defaults to
   * `false`.
   */
  editable?: boolean;
}

function inferType(values: CellValue[]): ColumnType {
  let integer = true;
  let number = true;
  let boolean = true;
  let seen = false;
  for (let index = 0; index < values.length && index < 10_000; index++) {
    const value = values[index];
    if (value === null) continue;
    seen = true;
    if (typeof value !== "number") number = integer = false;
    else if (!Number.isInteger(value)) integer = false;
    if (typeof value !== "boolean") boolean = false;
    if (!number && !boolean) break;
  }
  if (!seen) return "string";
  if (boolean) return "boolean";
  if (integer) return "integer";
  if (number) return "float";
  return "string";
}

interface Decimal {
  negative: boolean;
  digits: string;
  exponent: number;
}

type OrderedValue = CellValue | bigint | Decimal;

function isBlank(value: OrderedValue) {
  return value === null || value === "";
}

const integerText = /^[+-]?\d+$/;

/** Keeps decimal digits and their power of ten without converting them to a floating-point number. */
function decimalOf(text: string): Decimal | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!match || !(match[2] || match[3])) return null;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "") || "0";
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  return { negative: digits !== "0" && match[1] === "-", digits, exponent: digits === "0" ? 0 : exponent };
}

/** Numeric values for exact comparisons; null when the value is not a number. */
function exactNumber(value: CellValue, type: ColumnType): number | bigint | Decimal | null {
  if (typeof value === "string" && integerText.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : BigInt(value);
  }
  if (type === "decimal" && typeof value === "string") return decimalOf(value);
  return numericValue(value, type);
}

function compareDecimals(a: number | bigint | Decimal, b: number | bigint | Decimal): number {
  if (typeof a === "number" && !Number.isFinite(a)) return a < 0 ? -1 : 1;
  if (typeof b === "number" && !Number.isFinite(b)) return b < 0 ? 1 : -1;
  const left = typeof a === "object" ? a : (decimalOf(String(a)) as Decimal);
  const right = typeof b === "object" ? b : (decimalOf(String(b)) as Decimal);
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let order = 0;
  if (left.digits === "0" || right.digits === "0") {
    order = left.digits === right.digits ? 0 : left.digits === "0" ? -1 : 1;
  } else {
    const leftSize = left.digits.length + left.exponent;
    const rightSize = right.digits.length + right.exponent;
    if (leftSize !== rightSize) order = leftSize < rightSize ? -1 : 1;
    else {
      const width = Math.max(left.digits.length, right.digits.length);
      const l = left.digits.padEnd(width, "0");
      const r = right.digits.padEnd(width, "0");
      order = l < r ? -1 : l > r ? 1 : 0;
    }
  }
  return left.negative ? -order : order;
}

/** Total order used for sorting: numbers, then booleans, then strings. Blanks are handled by the caller. */
function compareValues(a: OrderedValue, b: OrderedValue): number {
  const aNumber = typeof a === "number" || typeof a === "bigint" || (typeof a === "object" && a !== null);
  const bNumber = typeof b === "number" || typeof b === "bigint" || (typeof b === "object" && b !== null);
  if (aNumber && bNumber && (typeof a === "object" || typeof b === "object")) return compareDecimals(a, b);
  // Comparing numbers with BigInts is exact.
  if (aNumber && bNumber) return a < b ? -1 : a > b ? 1 : 0;
  if (aNumber) return -1;
  if (bNumber) return 1;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (typeof a === "boolean") return -1;
  if (typeof b === "boolean") return 1;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

interface View {
  id: string;
  rows: Uint32Array;
  query: ViewQuery;
}

/** Rows written per batch when exporting. */
const EXPORT_BATCH = 4096;

/**
 * A table held in JavaScript arrays. Sorting, filtering and statistics run on the main thread, so it
 * suits up to a few hundred thousand rows; use an engine-backed source for more.
 *
 * `exportView` writes `csv`, `tsv`, `json` and `xlsx` (not `parquet`) and returns the file as a `Blob`
 * (`ExportResult.data`); `target` is only its name.
 *
 * With `editable`, `updateCells` writes into the arrays given (`rows` are copied into columns first, so
 * write those through the source). Other grids of the same source learn of writes through `subscribe`.
 */
export class ArraySource implements TableSource {
  private readonly schema: ColumnSchema[];
  private readonly data: CellValue[][];
  private readonly rowTotal: number;
  private readonly views = new Map<string, View>();
  private nextView = 1;
  private readonly editable: boolean;
  private editVersion = 0;
  /** Cells written so far, as `row * columns + column`. */
  private readonly written = new Set<number>();
  private readonly listeners = new Set<TableChangeListener>();

  constructor(options: ArraySourceOptions) {
    const columnCount = options.columns.length;
    if (options.columnData) {
      this.data = options.columnData.slice(0, columnCount);
    } else {
      const rows = options.rows ?? [];
      this.data = Array.from({ length: columnCount }, (_, column) => rows.map((row) => row[column] ?? null));
    }
    while (this.data.length < columnCount) this.data.push([]);
    this.rowTotal = this.data.reduce((max, column) => Math.max(max, column.length), 0);
    this.editable = options.editable === true;
    this.schema = options.columns.map((column, index) => {
      const schema = typeof column === "string" ? { name: column, type: inferType(this.data[index]) } : column;
      return this.editable && !editableType(schema.type) && !schema.readOnly ? { ...schema, readOnly: true } : schema;
    });
  }

  private value(row: number, column: number): CellValue {
    return this.data[column]?.[row] ?? null;
  }

  async info(): Promise<TableInfo> {
    return {
      columns: this.schema,
      rowCount: this.rowTotal,
      readableRows: this.rowTotal,
      status: "ready",
      format: "array",
      capabilities: {
        sort: true,
        filter: true,
        search: true,
        stats: true,
        distinct: true,
        aggregate: true,
        find: true,
        export: true,
        conditions: true,
        ...(this.editable ? { edit: true } : {}),
      },
      exports: { formats: [...TABLE_FILE_FORMATS], delivery: "data" },
      ...(this.editable ? { edits: this.edits() } : {}),
    };
  }

  private edits(): TableEdits {
    return { version: this.editVersion, cells: this.written.size };
  }

  /**
   * Writes cells: every update, or none when one of them does not fit (see `TableSource.updateCells`).
   * Values are checked and normalized with `normalizeCellValue`.
   */
  async updateCells(request: UpdateRequest): Promise<UpdateResult> {
    if (!this.editable) throw new SourceError(ErrorCodes.readOnly, "This table is read-only.", 403);
    if (request.updates.length > MAX_UPDATE_CELLS) {
      throw new SourceError(ErrorCodes.invalidRequest, `Write at most ${MAX_UPDATE_CELLS} cells at a time.`, 400);
    }
    const values: CellValue[] = [];
    for (const update of request.updates) {
      const schema = this.schema[update.column];
      if (!schema) throw new SourceError(ErrorCodes.invalidRequest, `Column ${update.column} does not exist.`, 400);
      if (!Number.isSafeInteger(update.row) || update.row < 0 || update.row >= this.rowTotal) {
        throw new SourceError(ErrorCodes.invalidRequest, `Row ${update.row} does not exist.`, 400);
      }
      if (schema.readOnly) throw new SourceError(ErrorCodes.readOnly, `The column ${schema.name} is read-only.`, 403);
      const normalized = normalizeCellValue(update.value, schema);
      if (!normalized.ok) {
        throw new SourceError(
          ErrorCodes.invalidValue,
          `Row ${update.row + 1}: the value does not fit the column ${schema.name} (${normalized.error}).`,
          422,
        );
      }
      if (update.previous !== undefined && !sameCellValue(this.value(update.row, update.column), update.previous)) {
        throw new SourceError(
          ErrorCodes.editConflict,
          `Row ${update.row + 1} of ${schema.name} was changed meanwhile.`,
          409,
        );
      }
      values.push(normalized.value);
    }
    request.updates.forEach((update, index) => {
      const column = this.data[update.column];
      while (column.length < update.row) column.push(null);
      column[update.row] = values[index];
      this.written.add(update.row * this.schema.length + update.column);
    });
    this.editVersion++;
    const edits = this.edits();
    for (const listener of [...this.listeners]) listener({ edits: edits.version });
    return { updated: request.updates.length, edits };
  }

  /** Calls `listener` after each write (`updateCells`), also by another grid of this source. */
  subscribe(listener: TableChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private view(id: string | null): View | null {
    if (id === null) return null;
    const view = this.views.get(id);
    if (!view) throw new SourceError(ErrorCodes.viewNotFound, "The view no longer exists.", 404);
    return view;
  }

  private rowAt(view: View | null, position: number) {
    return view ? view.rows[position] : position;
  }

  private viewSize(view: View | null) {
    return view ? view.rows.length : this.rowTotal;
  }

  private matches(filter: Filter, row: number): boolean {
    const value = this.value(row, filter.column);
    const type = this.schema[filter.column]?.type ?? "string";
    switch (filter.type) {
      case "values": {
        // Numbers match by value ("1.5" matches the decimal 1.50), as in SQL.
        const number = isNumericType(type) && value !== null ? exactNumber(value, type) : null;
        const found = filter.values.some((candidate) => {
          if (candidate === null) return isBlank(value);
          // An empty string matches empty text, not a missing value, as in SQL.
          if (value === null) return false;
          const other = number === null || typeof candidate === "boolean" ? null : exactNumber(candidate, type);
          return other !== null && number !== null
            ? compareValues(number, other) === 0
            : plainText(candidate) === plainText(value);
        });
        return filter.exclude ? !found : found;
      }
      case "blank":
        return isBlank(value) === filter.blank;
      case "text": {
        if (value === null) return filter.op === "notContains" || filter.op === "notEquals";
        const text = filter.caseSensitive ? plainText(value) : plainText(value).toLowerCase();
        const needle = filter.caseSensitive ? filter.value : filter.value.toLowerCase();
        switch (filter.op) {
          case "contains":
            return text.includes(needle);
          case "notContains":
            return !text.includes(needle);
          case "startsWith":
            return text.startsWith(needle);
          case "endsWith":
            return text.endsWith(needle);
          case "equals":
            return text === needle;
          case "notEquals":
            return text !== needle;
        }
        return false;
      }
      case "compare":
      case "between": {
        if (value === null) return false;
        const numeric = isNumericType(type);
        // Numbers compare by value, exactly also for integers beyond 2^53.
        const left = numeric ? exactNumber(value, type) : value;
        const cast = (bound: CellValue) => (numeric ? exactNumber(bound, type) : bound);
        if (left === null) return false;
        if (filter.type === "between") {
          const min = filter.min === undefined ? null : cast(filter.min);
          const max = filter.max === undefined ? null : cast(filter.max);
          return (min === null || compareValues(left, min) >= 0) && (max === null || compareValues(left, max) <= 0);
        }
        const right = cast(filter.value);
        if (right === null) return false;
        const order = compareValues(left, right);
        switch (filter.op) {
          case "eq":
            return order === 0;
          case "ne":
            return order !== 0;
          case "lt":
            return order < 0;
          case "le":
            return order <= 0;
          case "gt":
            return order > 0;
          case "ge":
            return order >= 0;
        }
      }
    }
    return false;
  }

  async createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    if (isEmptyQuery(query)) return { id: null, rowCount: this.rowTotal, query: {} };
    const filters = query.filters ?? [];
    const where = pruneFilterNode(query.where);
    const search = query.search?.trim().toLowerCase();
    const kept: number[] = [];
    for (let row = 0; row < this.rowTotal; row++) {
      if (signal?.aborted) throw abortError();
      if (!filters.every((filter) => this.matches(filter, row))) continue;
      if (where && !matchesFilterNode(where, (filter) => this.matches(filter, row))) continue;
      if (
        search &&
        !this.data.some((column) =>
          plainText(column[row] ?? null)
            .toLowerCase()
            .includes(search),
        )
      )
        continue;
      kept.push(row);
    }
    const sort = query.sort ?? [];
    if (sort.length > 0) {
      const types = sort.map((key) => this.schema[key.column]?.type ?? "string");
      kept.sort((a, b) => {
        for (let index = 0; index < sort.length; index++) {
          const key = sort[index];
          const type = types[index];
          let left: OrderedValue = this.value(a, key.column);
          let right: OrderedValue = this.value(b, key.column);
          // Numbers sort by value, exactly also beyond 2^53; what is not a number counts as blank.
          if (isNumericType(type)) {
            left = exactNumber(left, type);
            right = exactNumber(right, type);
          }
          const leftBlank = isBlank(left);
          const rightBlank = isBlank(right);
          // Blanks go last in both directions, as in spreadsheets.
          if (leftBlank || rightBlank) {
            if (leftBlank && rightBlank) continue;
            return leftBlank ? 1 : -1;
          }
          const order = compareValues(left, right);
          if (order !== 0) return key.direction === "desc" ? -order : order;
        }
        return a - b;
      });
    }
    const id = `v${this.nextView++}`;
    const view: View = { id, rows: Uint32Array.from(kept), query };
    this.views.set(id, view);
    // Keep the few most recent views.
    for (const key of this.views.keys()) {
      if (this.views.size <= 4) break;
      this.views.delete(key);
    }
    return { id, rowCount: view.rows.length, query };
  }

  async readRows(request: RowRequest): Promise<RowBlock> {
    const view = this.view(request.view);
    const end = Math.min(request.end, this.viewSize(view));
    const start = Math.min(request.start, end);
    const columns = request.columns.map((column) => {
      const values: CellValue[] = [];
      for (let position = start; position < end; position++)
        values.push(this.value(this.rowAt(view, position), column));
      return values;
    });
    const rowIds = view ? Array.from(view.rows.subarray(start, end)) : null;
    return { start, end, columns, rowIds };
  }

  async columnStats(viewId: string | null, column: number): Promise<ColumnStats> {
    const view = this.view(viewId);
    const size = this.viewSize(view);
    const type = this.schema[column]?.type ?? "string";
    const counts = new Map<string, { value: CellValue; count: number }>();
    let nulls = 0;
    let min: CellValue | undefined;
    let max: CellValue | undefined;
    let sum = 0;
    let numbers = 0;
    let minLength: number | null = null;
    let maxLength: number | null = null;
    const numericValues: number[] = [];
    // Numbers compare by value, also decimals and large integers that arrive as text.
    const rank = (item: CellValue) => (isNumericType(type) ? (exactNumber(item, type) ?? item) : item);
    for (let position = 0; position < size; position++) {
      const value = this.value(this.rowAt(view, position), column);
      if (value === null) {
        nulls++;
        continue;
      }
      const key = plainText(value);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { value, count: 1 });
      if (min === undefined || compareValues(rank(value), rank(min)) < 0) min = value;
      if (max === undefined || compareValues(rank(value), rank(max)) > 0) max = value;
      const number = numericValue(value, type);
      if (number !== null && isNumericType(type)) {
        numbers++;
        sum += number;
        numericValues.push(number);
      }
      if (typeof value === "string") {
        minLength = minLength === null ? value.length : Math.min(minLength, value.length);
        maxLength = maxLength === null ? value.length : Math.max(maxLength, value.length);
      }
    }
    const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    const stats: ColumnStats = { column, rows: size, nulls, distinct: counts.size, min, max, top };
    if (numbers > 0) {
      const mean = sum / numbers;
      stats.mean = mean;
      // From the deviations, not from the sum of squares, which loses the digits of large numbers.
      let deviations = 0;
      for (const number of numericValues) deviations += (number - mean) ** 2;
      stats.stddev = numbers > 1 ? Math.sqrt(deviations / (numbers - 1)) : null;
      numericValues.sort((a, b) => a - b);
      const quantile = (q: number) =>
        numericValues[Math.min(numericValues.length - 1, Math.floor(q * (numericValues.length - 1)))];
      stats.quantiles = [quantile(0.25), quantile(0.5), quantile(0.75)];
      const low = numericValues[0];
      const high = numericValues[numericValues.length - 1];
      const binCount = low === high ? 1 : 20;
      const width = (high - low) / binCount || 1;
      const bins = Array.from({ length: binCount }, (_, index) => ({
        start: low + index * width,
        end: low + (index + 1) * width,
        count: 0,
      }));
      for (const number of numericValues) bins[Math.min(binCount - 1, Math.floor((number - low) / width))].count++;
      stats.histogram = bins;
    } else {
      stats.minLength = minLength;
      stats.maxLength = maxLength;
    }
    return stats;
  }

  async distinctValues(request: DistinctRequest): Promise<DistinctValues> {
    const view = this.view(request.view);
    const size = this.viewSize(view);
    const counts = new Map<string, { value: CellValue; count: number }>();
    const search = request.search?.toLowerCase();
    for (let position = 0; position < size; position++) {
      const value = this.value(this.rowAt(view, position), request.column);
      const key = value === null ? "\u0000null" : plainText(value);
      if (search && !key.toLowerCase().includes(search)) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { value, count: 1 });
    }
    const limit = request.limit ?? 1000;
    const values = [...counts.values()].sort((a, b) => b.count - a.count || compareValues(a.value, b.value));
    return { values: values.slice(0, limit), truncated: values.length > limit };
  }

  async aggregate(request: AggregateRequest): Promise<SelectionSummary> {
    const view = this.view(request.view);
    const size = this.viewSize(view);
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const range of request.ranges) {
      for (let position = range.start; position < Math.min(range.end, size); position++) {
        const row = this.rowAt(view, position);
        for (const column of range.columns) {
          const value = this.value(row, column);
          if (isBlank(value)) continue;
          count++;
          const number = numericValue(value, this.schema[column]?.type);
          if (number === null || typeof value === "boolean") continue;
          numericCount++;
          sum += number;
          if (number < min) min = number;
          if (number > max) max = number;
        }
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
  }

  async find(request: FindRequest): Promise<FindResult | null> {
    const view = this.view(request.view);
    const size = this.viewSize(view);
    const needle = request.caseSensitive ? request.text : request.text.toLowerCase();
    if (!needle || request.columns.length === 0 || size === 0) return null;
    const width = request.columns.length;
    const total = size * width;
    let position = request.row * width + request.column;
    for (let step = 0; step < total; step++) {
      position = (position + request.direction + total) % total;
      const row = Math.floor(position / width);
      const column = position % width;
      const text = plainText(this.value(this.rowAt(view, row), request.columns[column]));
      if ((request.caseSensitive ? text : text.toLowerCase()).includes(needle)) return { row, column };
    }
    return null;
  }

  async exportView(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult> {
    if (!(TABLE_FILE_FORMATS as readonly string[]).includes(request.format)) {
      throw new SourceError(ErrorCodes.invalidRequest, `This table cannot be exported as ${request.format}.`, 400);
    }
    const view = this.view(request.view);
    const size = this.viewSize(view);
    const indexes = request.columns ?? this.schema.map((_, index) => index);
    const columns = indexes.map((index, position) => {
      const schema = this.schema[index];
      if (!schema) throw new SourceError(ErrorCodes.invalidRequest, `Column ${index} does not exist.`, 400);
      const keepNames = request.format === "json";
      return {
        name: (!keepNames && request.headers?.[position]) || schema.name,
        type: schema.type,
        numberFormat: request.numberFormats?.[position] ?? null,
      };
    });
    if (request.format === "xlsx") checkXlsxSize(size, columns.length);
    const source = this;
    function* batches() {
      for (let start = 0; start < size; start += EXPORT_BATCH) {
        if (signal?.aborted) throw abortError();
        const rows: CellValue[][] = [];
        for (let position = start; position < Math.min(size, start + EXPORT_BATCH); position++) {
          const row = source.rowAt(view, position);
          rows.push(indexes.map((column) => source.value(row, column)));
        }
        yield rows;
      }
    }
    const parts: Uint8Array[] = [];
    try {
      for await (const chunk of writeTableFile(request.format as TableFileFormat, columns, batches(), { signal }))
        parts.push(chunk);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    }
    const data = new Blob(parts as BlobPart[], { type: EXPORT_MEDIA_TYPES[request.format] });
    return { target: request.target, rows: size, data };
  }
}
