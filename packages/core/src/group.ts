import { compareValues, type Decimal, decimalOf, exactNumber, type OrderedValue } from "./array-source.js";
import { isNumericType, isTemporalType } from "./column-type.js";
import { numericValue, plainText } from "./format.js";
import { ErrorCodes } from "./protocol.js";
import { abortError, SourceError } from "./source.js";
import type {
  AggregateFunction,
  CellValue,
  ColumnSchema,
  ColumnType,
  GroupAggregate,
  GroupRequest,
  GroupResult,
  PivotColumn,
  SortKey,
} from "./types.js";

/** Columns a `GroupRequest` may group by. */
export const MAX_GROUP_KEYS = 16;
/** Aggregates a `GroupRequest` may ask for. */
export const MAX_GROUP_AGGREGATES = 64;
/** Groups a `GroupResult` holds at most. */
export const MAX_GROUP_ROWS = 100_000;
/** Groups returned when a `GroupRequest` gives no `limit`. */
export const DEFAULT_GROUP_LIMIT = 1000;
/** Columns a cross tabulation may generate when its `maxColumns` is not given. */
export const DEFAULT_PIVOT_COLUMNS = 200;
/** Columns a cross tabulation may generate at most. */
export const MAX_PIVOT_COLUMNS = 1000;

export const AGGREGATE_FUNCTIONS: readonly AggregateFunction[] = ["count", "sum", "avg", "min", "max"];

/** Types whose values can be group keys: one value each, with an order. Nested and binary values cannot. */
export function isGroupableType(type: ColumnType) {
  return !(["list", "struct", "map", "binary", "unknown", "json"] as ColumnType[]).includes(type);
}

/** Whether `fn` applies to a column of `type` (`count` applies to every column). */
export function aggregateApplies(fn: AggregateFunction, type: ColumnType) {
  switch (fn) {
    case "count":
      return true;
    case "sum":
    case "avg":
      return isNumericType(type);
    case "min":
    case "max":
      return isNumericType(type) || isTemporalType(type) || type === "string" || type === "boolean" || type === "uuid";
  }
}

/** The name of an aggregate's result column, for example `sum(sales)` or `count(*)`. */
export function aggregateName(aggregate: GroupAggregate, schema: readonly ColumnSchema[]) {
  if (aggregate.column === undefined) return `${aggregate.fn}(*)`;
  return `${aggregate.fn}(${schema[aggregate.column]?.name ?? aggregate.column})`;
}

/** The scale of a decimal column from its source type (`DECIMAL(10,2)` → 2), or 0. */
export function decimalScale(column: ColumnSchema) {
  const match = /^(?:DECIMAL|NUMERIC)\(\s*\d+\s*,\s*(\d+)\s*\)$/i.exec(column.sourceType ?? "");
  return match ? Number(match[1]) : 0;
}

/** The schema of an aggregate's result column (its name is set by the caller). */
export function aggregateSchema(aggregate: GroupAggregate, schema: readonly ColumnSchema[], scale = 0): ColumnSchema {
  const column = aggregate.column === undefined ? undefined : schema[aggregate.column];
  switch (aggregate.fn) {
    case "count":
      return { name: "", type: "bigint", sourceType: "BIGINT" };
    case "avg":
      return { name: "", type: "float", sourceType: "DOUBLE" };
    case "sum":
      if (column?.type === "decimal") return { name: "", type: "decimal", sourceType: `DECIMAL(38,${scale})` };
      if (column?.type === "float") return { name: "", type: "float", sourceType: "DOUBLE" };
      return { name: "", type: "bigint", sourceType: "HUGEINT" };
    default:
      return {
        name: "",
        type: column?.type ?? "unknown",
        ...(column?.sourceType ? { sourceType: column.sourceType } : {}),
      };
  }
}

/** Makes names unique: a name an earlier column has gets " (2)", " (3)", … */
export function uniqueNames(names: string[]) {
  const used = new Set<string>();
  return names.map((name) => {
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name} (${n})`;
    used.add(unique);
    return unique;
  });
}

/**
 * The result columns of a request: the keys with their schema, then the aggregates (see
 * `GroupResult`), with unique names. `scaleOf` gives the scale of a decimal sum by aggregate index.
 */
export function groupColumns(
  schema: readonly ColumnSchema[],
  request: Pick<GroupRequest, "keys" | "aggregates">,
  scaleOf: (aggregate: number) => number = (aggregate) => {
    const index = request.aggregates[aggregate].column;
    return index === undefined || !schema[index] ? 0 : decimalScale(schema[index]);
  },
): ColumnSchema[] {
  const columns: ColumnSchema[] = [
    ...request.keys.map((key) => ({ ...schema[key] })),
    ...request.aggregates.map((aggregate, index) => ({
      ...aggregateSchema(aggregate, schema, scaleOf(index)),
      name: aggregateName(aggregate, schema),
    })),
  ];
  const names = uniqueNames(columns.map((column) => column.name));
  for (const [index, column] of columns.entries()) column.name = names[index];
  return columns;
}

/** The text of a column-axis value in the names of pivot columns. */
export function pivotText(value: CellValue) {
  if (value === null) return "(null)";
  if (value === "") return "(empty)";
  return plainText(value);
}

/**
 * The generated columns of a cross tabulation, after the key columns: one per combination of column-axis
 * values (in their order) and aggregate, named `Tokyo / sum(sales)`. Names are made unique together with
 * the key columns'.
 */
export function pivotColumns(
  schema: readonly ColumnSchema[],
  request: Pick<GroupRequest, "keys" | "aggregates">,
  combinations: readonly CellValue[][],
  scaleOf: (aggregate: number) => number,
): { columns: ColumnSchema[]; pivot: PivotColumn[] } {
  const columns: ColumnSchema[] = request.keys.map((key) => ({ ...schema[key] }));
  const pivot: PivotColumn[] = [];
  for (const values of combinations) {
    const prefix = values.map(pivotText).join(" / ");
    request.aggregates.forEach((aggregate, index) => {
      pivot.push({ column: columns.length, values, aggregate: index });
      columns.push({
        ...aggregateSchema(aggregate, schema, scaleOf(index)),
        name: `${prefix} / ${aggregateName(aggregate, schema)}`,
      });
    });
  }
  const names = uniqueNames(columns.map((column) => column.name));
  for (const [index, column] of columns.entries()) column.name = names[index];
  return { columns, pivot };
}

/** The most columns a cross tabulation may generate. */
export function pivotLimit(request: GroupRequest) {
  return Math.min(Math.max(1, Math.floor(request.pivot?.maxColumns ?? DEFAULT_PIVOT_COLUMNS)), MAX_PIVOT_COLUMNS);
}

/** The error of a cross tabulation that would make more columns than its limit allows. */
export function tooManyColumns(columns: number, limit: number) {
  return new SourceError(
    ErrorCodes.tooManyColumns,
    `The cross tabulation would make ${columns} columns; at most ${limit} are allowed.`,
    422,
  );
}

/** Checks that the result has the columns that `sort` names. */
export function checkGroupSort(request: Pick<GroupRequest, "sort">, width: number) {
  for (const key of request.sort ?? []) {
    if (!Number.isInteger(key.column) || key.column < 0 || key.column >= width)
      invalid(`Result column ${key.column} does not exist.`);
  }
}

function invalid(message: string): never {
  throw new SourceError(ErrorCodes.invalidRequest, message, 400);
}

/**
 * Checks a request against a table's columns, as every source does before grouping. Throws
 * `SourceError` with `invalid_request` for columns that do not exist or do not fit the function.
 */
export function checkGroupRequest(schema: readonly ColumnSchema[], request: GroupRequest) {
  const column = (index: number) => {
    const found = Number.isInteger(index) ? schema[index] : undefined;
    if (!found) invalid(`Column ${index} does not exist.`);
    return found;
  };
  if (request.keys.length > MAX_GROUP_KEYS) invalid(`Group by at most ${MAX_GROUP_KEYS} columns.`);
  if (request.aggregates.length > MAX_GROUP_AGGREGATES) invalid(`Ask for at most ${MAX_GROUP_AGGREGATES} aggregates.`);
  if (request.keys.length === 0 && request.aggregates.length === 0) invalid("Ask for a key or an aggregate.");
  if (new Set(request.keys).size !== request.keys.length) invalid("A key column is repeated.");
  for (const key of request.keys) {
    const schemaColumn = column(key);
    if (!isGroupableType(schemaColumn.type)) invalid(`Rows cannot be grouped by ${schemaColumn.name}.`);
  }
  for (const aggregate of request.aggregates) {
    if (!(AGGREGATE_FUNCTIONS as readonly string[]).includes(aggregate.fn)) invalid("Unknown aggregate.");
    if (aggregate.column === undefined) {
      if (aggregate.fn !== "count") invalid(`${aggregate.fn} needs a column.`);
      continue;
    }
    const schemaColumn = column(aggregate.column);
    if (!aggregateApplies(aggregate.fn, schemaColumn.type))
      invalid(`${aggregate.fn} does not apply to ${schemaColumn.name}.`);
  }
  const pivot = request.pivot;
  if (pivot) {
    if (pivot.columns.length === 0 || pivot.columns.length > MAX_GROUP_KEYS)
      invalid(`Pivot by 1 to ${MAX_GROUP_KEYS} columns.`);
    if (request.aggregates.length === 0) invalid("A pivot needs an aggregate.");
    if (new Set(pivot.columns).size !== pivot.columns.length) invalid("A pivot column is repeated.");
    for (const index of pivot.columns) {
      const schemaColumn = column(index);
      if (request.keys.includes(index)) invalid(`${schemaColumn.name} is both a key and a pivot column.`);
      if (!isGroupableType(schemaColumn.type)) invalid(`Rows cannot be pivoted by ${schemaColumn.name}.`);
    }
    if (pivot.maxColumns !== undefined && !(pivot.maxColumns >= 1 && pivot.maxColumns <= MAX_PIVOT_COLUMNS))
      invalid(`maxColumns must be from 1 to ${MAX_PIVOT_COLUMNS}.`);
    // The generated columns are known once the column-axis values are: sources check `sort` then.
    return;
  }
  checkGroupSort(request, request.keys.length + request.aggregates.length);
}

/** The number of groups to return for a request. */
export function groupLimit(request: GroupRequest) {
  return Math.min(Math.max(1, Math.floor(request.limit ?? DEFAULT_GROUP_LIMIT)), MAX_GROUP_ROWS);
}

/** An exact decimal: an integer and its number of fraction digits. */
interface Scaled {
  value: bigint;
  scale: number;
}

function scaledOf(decimal: Decimal): Scaled {
  const digits = BigInt(decimal.digits) * (decimal.negative ? -1n : 1n);
  return decimal.exponent >= 0
    ? { value: digits * 10n ** BigInt(decimal.exponent), scale: 0 }
    : { value: digits, scale: -decimal.exponent };
}

function rescale(value: bigint, from: number, to: number) {
  return to > from ? value * 10n ** BigInt(to - from) : value;
}

/** An integer as a wire value: a number when it is exact, else its digits. */
export function wireInteger(value: bigint | number): CellValue {
  const big = typeof value === "bigint" ? value : BigInt(value);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(big)
    : big.toString();
}

function decimalText(value: bigint, scale: number) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** Normalizes an integer value to its wire form (a number when exact), as engines send integers. */
function integerValue(value: CellValue, type: ColumnType): CellValue {
  const exact = exactNumber(value, type);
  if (typeof exact === "bigint") return wireInteger(exact);
  return exact === null || typeof exact === "object" ? value : exact;
}

interface AggregateState {
  count: number;
  /** Exact sum of integers and decimals. */
  exact: bigint;
  scale: number;
  /** Sum of floats. */
  float: number;
  best: CellValue | undefined;
  rank: OrderedValue | undefined;
}

interface Group {
  keys: CellValue[];
  /** The aggregates by combination of column-axis values (`""` without a pivot). */
  cells: Map<string, AggregateState[]>;
}

function newState(scale: number): AggregateState {
  return { count: 0, exact: 0n, scale, float: 0, best: undefined, rank: undefined };
}

/** A float that is not finite (`NaN`, `Infinity`, `-Infinity`, as a number or as its wire text), or null. */
function nonFinite(value: CellValue, type: ColumnType): number | null {
  if (type !== "float" || value === null || typeof value === "boolean") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isNaN(number) || number === Number.POSITIVE_INFINITY || number === Number.NEGATIVE_INFINITY
    ? number
    : null;
}

/** A key value as engines send it: floats that are not finite as their text (`NaN`, `Infinity`). */
function keyValue(value: CellValue, type: ColumnType): CellValue {
  const special = nonFinite(value, type);
  return special === null ? value : String(special);
}

/** Text that identifies a key value: numbers by value (1.5 and "1.50" are one group), others by type and text. */
function keyText(value: CellValue, type: ColumnType): string {
  if (value === null) return "n";
  const special = nonFinite(value, type);
  if (special !== null) return `f${special}`;
  if (isNumericType(type)) {
    const exact = exactNumber(value, type);
    if (exact !== null) {
      const decimal = typeof exact === "object" ? exact : decimalOf(String(exact));
      if (decimal) {
        const digits = decimal.digits.replace(/0+$/, "") || "0";
        const exponent = digits === "0" ? 0 : decimal.exponent + (decimal.digits.length - digits.length);
        return `d${decimal.negative ? "-" : ""}${digits}e${exponent}`;
      }
    }
  }
  return `${typeof value}:${plainText(value)}`;
}

/**
 * Groups rows fed in batches and computes the aggregates of `GroupRequest`, as `ArraySource` and the
 * browser source do. Feed it the values of `columns` (schema indexes), then read `result()`.
 */
export class GroupAccumulator {
  /** The schema columns to feed, in this order. */
  readonly columns: number[];
  private readonly schema: readonly ColumnSchema[];
  private readonly request: GroupRequest;
  private readonly keyAt: number[];
  private readonly pivotAt: number[];
  private readonly valueAt: (number | null)[];
  private readonly scales: number[];
  private readonly groups = new Map<string, Group>();
  /** The combinations of column-axis values seen, by their identity. */
  private readonly combinations = new Map<string, CellValue[]>();

  constructor(schema: readonly ColumnSchema[], request: GroupRequest) {
    checkGroupRequest(schema, request);
    this.schema = schema;
    this.request = request;
    const columns = [
      ...new Set([
        ...request.keys,
        ...(request.pivot?.columns ?? []),
        ...request.aggregates.flatMap((aggregate) => (aggregate.column === undefined ? [] : [aggregate.column])),
      ]),
    ];
    this.columns = columns;
    this.keyAt = request.keys.map((key) => columns.indexOf(key));
    this.pivotAt = (request.pivot?.columns ?? []).map((column) => columns.indexOf(column));
    this.valueAt = request.aggregates.map((aggregate) =>
      aggregate.column === undefined ? null : columns.indexOf(aggregate.column),
    );
    this.scales = request.aggregates.map((aggregate) => {
      const column = aggregate.column === undefined ? undefined : schema[aggregate.column];
      return column?.type === "decimal" ? decimalScale(column) : 0;
    });
    // Totals have one row, also without any rows.
    if (request.keys.length === 0) this.groups.set("", this.newGroup([]));
  }

  private newGroup(keys: CellValue[]): Group {
    return { keys, cells: new Map() };
  }

  private newStates() {
    return this.scales.map((scale) => newState(scale));
  }

  /** Adds `count` rows: `values[i]` holds the values of `columns[i]`. */
  add(values: CellValue[][], count: number, signal?: AbortSignal) {
    const { keys, aggregates } = this.request;
    const keyTypes = keys.map((key) => this.schema[key].type);
    const pivotTypes = (this.request.pivot?.columns ?? []).map((column) => this.schema[column].type);
    const pivoted = this.pivotAt.length > 0;
    const limit = pivoted ? Math.floor(pivotLimit(this.request) / aggregates.length) : 0;
    const types = aggregates.map((aggregate) =>
      aggregate.column === undefined ? "unknown" : this.schema[aggregate.column].type,
    );
    for (let row = 0; row < count; row++) {
      if ((row & 0xffff) === 0 && signal?.aborted) throw abortError();
      let group: Group | undefined;
      if (keys.length === 0) group = this.groups.get("");
      else {
        const parts = this.keyAt.map((at, index) => keyText(values[at][row] ?? null, keyTypes[index]));
        const id = parts.length === 1 ? parts[0] : JSON.stringify(parts);
        group = this.groups.get(id);
        if (!group) {
          group = this.newGroup(this.keyAt.map((at, index) => keyValue(values[at][row] ?? null, keyTypes[index])));
          this.groups.set(id, group);
        }
      }
      if (!group) continue;
      let cell = "";
      if (pivoted) {
        const parts = this.pivotAt.map((at, index) => keyText(values[at][row] ?? null, pivotTypes[index]));
        cell = parts.length === 1 ? parts[0] : JSON.stringify(parts);
        if (!this.combinations.has(cell)) {
          this.combinations.set(
            cell,
            this.pivotAt.map((at, index) => keyValue(values[at][row] ?? null, pivotTypes[index])),
          );
          // Refused as soon as it is known, without reading the rest.
          if (this.combinations.size > limit)
            throw tooManyColumns(this.combinations.size * aggregates.length, pivotLimit(this.request));
        }
      }
      let states = group.cells.get(cell);
      if (!states) {
        states = this.newStates();
        group.cells.set(cell, states);
      }
      for (let index = 0; index < aggregates.length; index++) {
        const at = this.valueAt[index];
        const state = states[index];
        if (at === null) {
          state.count++;
          continue;
        }
        const value = values[at][row] ?? null;
        if (value === null) continue;
        this.accumulate(aggregates[index].fn, types[index], state, value);
      }
    }
  }

  private accumulate(fn: AggregateFunction, type: ColumnType, state: AggregateState, value: CellValue) {
    if (fn === "count") {
      state.count++;
      return;
    }
    if (type === "float") {
      // NaN and infinities are left out, as in the column statistics.
      const number = numericValue(value, type);
      if (number === null) return;
      state.count++;
      if (fn === "sum" || fn === "avg") state.float += number;
      else this.keepBest(fn, state, value, number);
      return;
    }
    if (fn === "sum" || fn === "avg") {
      const exact = exactNumber(value, type);
      if (exact === null || (typeof exact === "number" && !Number.isFinite(exact))) return;
      const decimal = typeof exact === "object" ? exact : decimalOf(String(exact));
      if (!decimal) return;
      const scaled = scaledOf(decimal);
      if (scaled.scale > state.scale) {
        state.exact = rescale(state.exact, state.scale, scaled.scale);
        state.scale = scaled.scale;
      }
      state.exact += rescale(scaled.value, scaled.scale, state.scale);
      state.count++;
      return;
    }
    const rank = isNumericType(type) ? exactNumber(value, type) : value;
    if (rank === null) return;
    state.count++;
    this.keepBest(fn, state, value, rank);
  }

  private keepBest(fn: AggregateFunction, state: AggregateState, value: CellValue, rank: OrderedValue) {
    if (state.rank === undefined) {
      state.best = value;
      state.rank = rank;
      return;
    }
    const order = compareValues(rank, state.rank);
    if (fn === "min" ? order < 0 : order > 0) {
      state.best = value;
      state.rank = rank;
    }
  }

  private output(index: number, state: AggregateState): CellValue {
    const aggregate = this.request.aggregates[index];
    const type = aggregate.column === undefined ? "unknown" : this.schema[aggregate.column].type;
    switch (aggregate.fn) {
      case "count":
        return state.count;
      case "sum":
        if (state.count === 0) return null;
        if (type === "float") return state.float;
        if (type === "decimal") return decimalText(state.exact, state.scale);
        // Integer columns hold integers; a fraction (from a number put into one) is kept as a float.
        return state.scale > 0 ? Number(state.exact) / 10 ** state.scale : wireInteger(state.exact);
      case "avg":
        if (state.count === 0) return null;
        if (type === "float") return state.float / state.count;
        return Number(state.exact) / 10 ** state.scale / state.count;
      default: {
        if (state.best === undefined) return null;
        if (type === "integer" || type === "bigint") return integerValue(state.best, type);
        if (type === "float") return numericValue(state.best, type);
        return state.best;
      }
    }
  }

  /** The groups, sorted and limited as the request asks. */
  result(): GroupResult {
    const { keys, aggregates, pivot } = this.request;
    const groups = [...this.groups.values()];
    // Decimal sums have the scale of the column, or the most fraction digits of its values.
    const scales = aggregates.map((_, index) =>
      Math.max(
        this.scales[index],
        ...groups.flatMap((group) => [...group.cells.values()].map((states) => states[index].scale)),
      ),
    );
    // Combinations of column-axis values in their order: by each column ascending, blanks last.
    let cells = [""];
    let columns: ColumnSchema[];
    let pivoted: PivotColumn[] | undefined;
    if (pivot) {
      const combinations = [...this.combinations].map(([id, values]) => [...values, id]);
      const axis = pivot.columns.map((column) => this.schema[column]);
      sortGroupRows(combinations, axis, axis.length, groupSort({ keys: pivot.columns }));
      cells = combinations.map((combination) => combination[axis.length] as string);
      const made = pivotColumns(
        this.schema,
        this.request,
        combinations.map((combination) => combination.slice(0, axis.length)),
        (index) => scales[index],
      );
      columns = made.columns;
      pivoted = made.pivot;
      checkGroupSort(this.request, columns.length);
    } else {
      columns = groupColumns(this.schema, this.request, (index) => scales[index]);
    }
    const empty = this.newStates();
    const rows = groups.map((group) => {
      const row = [...group.keys];
      for (const cell of cells) {
        const states = group.cells.get(cell) ?? empty;
        states.forEach((state, index) => {
          const scale = scales[index];
          const decimalSum = aggregates[index].fn === "sum" && columns[row.length].type === "decimal";
          row.push(
            decimalSum && state.count > 0
              ? decimalText(rescale(state.exact, state.scale, scale), scale)
              : this.output(index, state),
          );
        });
      }
      return row;
    });
    if (keys.length > 0) sortGroupRows(rows, columns, keys.length, groupSort(this.request));
    const limit = groupLimit(this.request);
    return {
      columns,
      rows: rows.slice(0, limit),
      groups: rows.length,
      truncated: rows.length > limit,
      ...(pivoted ? { pivot: pivoted } : {}),
    };
  }
}

/** The order of groups: the request's sort, or the keys ascending. */
export function groupSort(request: Pick<GroupRequest, "keys" | "sort">): SortKey[] {
  return request.sort?.length ? request.sort : request.keys.map((_, column) => ({ column, direction: "asc" }));
}

/**
 * A value's rank in the order of the engines: numbers by value, with floats that are not finite as
 * DuckDB orders them (-Infinity first, Infinity after every number, NaN after Infinity). Null is blank,
 * and so is the empty string of a text column (and a value of a numeric column that is not a number).
 */
function rankOf(value: CellValue, type: ColumnType): OrderedValue {
  if (value === null || !isNumericType(type)) return value;
  const special = nonFinite(value, type);
  if (special !== null) return special;
  return exactNumber(value, type);
}

function isBlankRank(rank: OrderedValue, type: ColumnType) {
  return rank === null || (rank === "" && type === "string");
}

/** Compares ranks of one column; NaN comes after every other value, as in DuckDB. */
function compareRanks(left: OrderedValue, right: OrderedValue) {
  const leftNaN = typeof left === "number" && Number.isNaN(left);
  const rightNaN = typeof right === "number" && Number.isNaN(right);
  if (leftNaN || rightNaN) return leftNaN === rightNaN ? 0 : leftNaN ? 1 : -1;
  return compareValues(left, right);
}

/**
 * Sorts result rows by `sort` (blanks last in both directions), then by the first `keyCount` columns
 * ascending with nulls last (the empty string is a value there), as `ORDER BY` does in the engines.
 */
export function sortGroupRows(
  rows: CellValue[][],
  columns: readonly ColumnSchema[],
  keyCount: number,
  sort: SortKey[],
) {
  const types = columns.map((column) => column.type);
  rows.sort((a, b) => {
    for (const key of sort) {
      const type = types[key.column];
      const left = rankOf(a[key.column], type);
      const right = rankOf(b[key.column], type);
      const leftBlank = isBlankRank(left, type);
      const rightBlank = isBlankRank(right, type);
      if (leftBlank || rightBlank) {
        if (leftBlank && rightBlank) continue;
        return leftBlank ? 1 : -1;
      }
      const order = compareRanks(left, right);
      if (order !== 0) return key.direction === "desc" ? -order : order;
    }
    for (let column = 0; column < keyCount; column++) {
      const left = rankOf(a[column], types[column]);
      const right = rankOf(b[column], types[column]);
      if (left === null || right === null) {
        if (left === right) continue;
        return left === null ? 1 : -1;
      }
      const order = compareRanks(left, right);
      if (order !== 0) return order;
    }
    return 0;
  });
}
