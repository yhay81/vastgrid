import { isNumericType, numericValue, plainText } from "./format.js";
import { abortError, isEmptyQuery, SourceError, type TableSource } from "./source.js";
import type {
  AggregateRequest,
  CellValue,
  ColumnSchema,
  ColumnStats,
  ColumnType,
  DistinctRequest,
  DistinctValues,
  Filter,
  FindRequest,
  FindResult,
  RowBlock,
  RowRequest,
  SelectionSummary,
  TableInfo,
  ViewInfo,
  ViewQuery,
} from "./types.js";

export interface ArraySourceOptions {
  /** Column names, or full schemas. Types are inferred from the values when only names are given. */
  columns: (string | ColumnSchema)[];
  /** Row-major data. Provide either `rows` or `columnData`. */
  rows?: CellValue[][];
  /** Column-major data: one array per column. */
  columnData?: CellValue[][];
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

function isBlank(value: CellValue) {
  return value === null || value === "";
}

/** Total order used for sorting: numbers, then booleans, then strings. Blanks are handled by the caller. */
function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
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

/**
 * A table held in JavaScript arrays. Sorting, filtering and statistics run on the main thread, so it
 * suits up to a few hundred thousand rows; use an engine-backed source for more.
 */
export class ArraySource implements TableSource {
  private readonly schema: ColumnSchema[];
  private readonly data: CellValue[][];
  private readonly rowTotal: number;
  private readonly views = new Map<string, View>();
  private nextView = 1;

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
    this.schema = options.columns.map((column, index) =>
      typeof column === "string" ? { name: column, type: inferType(this.data[index]) } : column,
    );
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
        export: false,
      },
    };
  }

  private view(id: string | null): View | null {
    if (id === null) return null;
    const view = this.views.get(id);
    if (!view) throw new SourceError("view_not_found", "The view no longer exists.", 404);
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
        const found = filter.values.some((candidate) =>
          candidate === null ? isBlank(value) : plainText(candidate) === plainText(value),
        );
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
        const left = numeric ? numericValue(value, type) : value;
        const cast = (bound: CellValue) => (numeric ? numericValue(bound, type) : bound);
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
    const search = query.search?.trim().toLowerCase();
    const kept: number[] = [];
    for (let row = 0; row < this.rowTotal; row++) {
      if (signal?.aborted) throw abortError();
      if (!filters.every((filter) => this.matches(filter, row))) continue;
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
      const numeric = sort.map((key) => isNumericType(this.schema[key.column]?.type ?? "string"));
      kept.sort((a, b) => {
        for (let index = 0; index < sort.length; index++) {
          const key = sort[index];
          let left = this.value(a, key.column);
          let right = this.value(b, key.column);
          if (numeric[index]) {
            left = numericValue(left);
            right = numericValue(right);
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
    let squares = 0;
    let numbers = 0;
    let minLength: number | null = null;
    let maxLength: number | null = null;
    const numericValues: number[] = [];
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
      if (min === undefined || compareValues(value, min) < 0) min = value;
      if (max === undefined || compareValues(value, max) > 0) max = value;
      const number = numericValue(value, type);
      if (number !== null && isNumericType(type)) {
        numbers++;
        sum += number;
        squares += number * number;
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
      stats.stddev = numbers > 1 ? Math.sqrt(Math.max(0, (squares - numbers * mean * mean) / (numbers - 1))) : null;
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
}
