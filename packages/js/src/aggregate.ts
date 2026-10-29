/**
 * Groups (docs/spec.md §3.8, §3.9, §4.5, §4.6): the rows that `where` keeps, one group for each combination
 * of the ranks of their keys, with the measures of each group and the generated columns of a pivot.
 *
 * Ranks make groups by §3.1 equality (all NaNs are one value, −0.0 and 0.0 are one) and order them as §3.9 does:
 * values ascending, then the empty string, then null. Groups are numbered in that order, so a view without
 * `sort` is the groups in number order, and a sort is stable over them.
 */
import {
  type CheckedAggregate,
  type CheckedMeasure,
  type Column,
  type JsonValue,
  SpecError,
  type TypedExpr,
  textOf,
  uniqueName,
  type ValueType,
  valueType,
} from "vastgrid-spec";
import { comparer, decimalText, exactJson, filter, toFloat, unscaled } from "./evaluate.js";
import type { ColumnRanks } from "./order.js";
import type { Vector } from "./table.js";

/** What grouping reads: the columns of the rows before grouping, by name, and the rows that `where` keeps. */
export interface GroupInput {
  aggregate: CheckedAggregate;
  /** The view's columns that the checked plan knows: the keys, then the measures unless there is a pivot. */
  columns: Column[];
  /** The row IDs that `where` keeps, in order; null for every row of the table. */
  rows: Uint32Array | null;
  /** The rows of the table. */
  count: number;
  /** A column's values by row ID: a column of the table or a derived one. */
  values(name: string): Vector;
  /** A column's ranks by row ID (§3.3). */
  ranks(name: string): ColumnRanks;
}

/** A column of groups: its values by group number. */
export interface GroupColumn {
  column: Column;
  values: JsonValue[];
}

/** The groups of a view: its columns, their values by group number, and the groups that `having` keeps. */
export interface Groups {
  columns: Column[];
  values: Map<string, GroupColumn>;
  count: number;
  /** The groups that `having` keeps, in order; null without `having`. */
  kept: Uint32Array | null;
}

/** Combinations of the ranks of some columns among rows: their numbers in §3.9 order. */
interface Combinations {
  /** The number of each row's combination, by its position among the rows. */
  of: Uint32Array;
  /** The first row ID of each combination. */
  firsts: number[];
}

/** Numbers the combinations of the ranks of columns among the rows, in the order of their ranks. */
function combine(ranks: readonly ColumnRanks[], rows: Uint32Array | null, count: number): Combinations {
  const length = rows ? rows.length : count;
  const of = new Uint32Array(length);
  if (ranks.length === 0) return { of, firsts: length > 0 ? [rows ? rows[0] : 0] : [] };
  // Each combination as one number while their product fits, otherwise as text.
  const sizes = ranks.map((item) => item.distinct + 2);
  const numeric = sizes.reduce((product, size) => product * size, 1) <= Number.MAX_SAFE_INTEGER;
  const found = new Map<number | string, number>();
  const firsts: number[] = [];
  for (let at = 0; at < length; at++) {
    const row = rows ? rows[at] : at;
    let key: number | string;
    if (ranks.length === 1) key = ranks[0].ranks[row];
    else if (numeric) {
      key = 0;
      for (let which = 0; which < ranks.length; which++) key = key * sizes[which] + ranks[which].ranks[row];
    } else key = ranks.map((item) => item.ranks[row]).join(",");
    let id = found.get(key);
    if (id === undefined) {
      id = firsts.length;
      found.set(key, id);
      firsts.push(row);
    }
    of[at] = id;
  }
  // Renumber in the order of the ranks.
  const order = firsts.map((_, id) => id);
  order.sort((a, b) => {
    for (const item of ranks) {
      const difference = item.ranks[firsts[a]] - item.ranks[firsts[b]];
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const renumbered = new Uint32Array(order.length);
  order.forEach((id, place) => {
    renumbered[id] = place;
  });
  for (let at = 0; at < length; at++) of[at] = renumbered[of[at]];
  return { of, firsts: order.map((id) => firsts[id]) };
}

/** A measure's state in each cell (a group, or a group and a pivot's combination). */
interface Accumulator {
  add(cell: number, row: number): void;
  result(cell: number): JsonValue;
}

/** Whether a value counts for a measure (§3.8): not null, and for floats, finite except for counts. */
function counted(column: ValueType, measure: CheckedMeasure): (value: JsonValue) => boolean {
  if (column.type !== "float" || measure.fn === "count" || measure.fn === "count_distinct") {
    return (value) => value !== null;
  }
  return (value) => value !== null && typeof value === "number";
}

function accumulator(measure: CheckedMeasure, input: GroupInput, cells: number): Accumulator {
  const column = measure.column;
  if (!column) {
    const counts = new Float64Array(cells);
    return {
      add: (cell) => {
        counts[cell]++;
      },
      result: (cell) => counts[cell],
    };
  }
  const values = input.values(column.name);
  const takes = counted(column, measure);
  switch (measure.fn) {
    case "count": {
      const counts = new Float64Array(cells);
      return {
        add: (cell, row) => {
          if (values.at(row) !== null) counts[cell]++;
        },
        result: (cell) => counts[cell],
      };
    }
    case "count_distinct": {
      const { ranks, distinct } = input.ranks(column.name);
      const seen: (Set<number> | undefined)[] = new Array(cells);
      return {
        add: (cell, row) => {
          const rank = ranks[row];
          if (rank > distinct) return;
          let set = seen[cell];
          if (!set) {
            set = new Set();
            seen[cell] = set;
          }
          set.add(rank);
        },
        result: (cell) => seen[cell]?.size ?? 0,
      };
    }
    case "sum":
    case "avg":
      return column.type === "float" ? floatSum(measure, values, cells) : exactSum(measure, column, values, cells);
    case "stddev": {
      // Welford's running mean and sum of squared differences.
      const counts = new Float64Array(cells);
      const means = new Float64Array(cells);
      const squares = new Float64Array(cells);
      return {
        add: (cell, row) => {
          const value = values.at(row);
          if (!takes(value)) return;
          const number = toFloat(value, column);
          const count = ++counts[cell];
          const delta = number - means[cell];
          means[cell] += delta / count;
          squares[cell] += delta * (number - means[cell]);
        },
        result: (cell) => (counts[cell] < 2 ? null : finite(Math.sqrt(squares[cell] / (counts[cell] - 1)))),
      };
    }
    case "min":
    case "max": {
      const compare = comparer(column, column);
      const greatest = measure.fn === "max";
      const best: JsonValue[] = new Array(cells).fill(null);
      return {
        add: (cell, row) => {
          const value = values.at(row);
          if (!takes(value)) return;
          const now = best[cell];
          if (now === null || (greatest ? compare(value, now) > 0 : compare(value, now) < 0)) best[cell] = value;
        },
        result: (cell) => best[cell],
      };
    }
    case "quantile": {
      const p = measure.p ?? 0.5;
      const numbers: (number[] | undefined)[] = new Array(cells);
      return {
        add: (cell, row) => {
          const value = values.at(row);
          if (!takes(value)) return;
          let list = numbers[cell];
          if (!list) {
            list = [];
            numbers[cell] = list;
          }
          list.push(toFloat(value, column));
        },
        // Linear interpolation between the two closest ranks, weighing each as DuckDB's quantile_cont does: the
        // difference of the two would overflow between the largest floats of either sign.
        result: (cell) => {
          const list = numbers[cell];
          if (!list) return null;
          const sorted = Float64Array.from(list).sort();
          const place = p * (sorted.length - 1);
          const low = Math.floor(place);
          const high = Math.ceil(place);
          const weight = place - low;
          return finite(sorted[low] * (1 - weight) + sorted[high] * weight);
        },
      };
    }
  }
}

function finite(value: number): JsonValue {
  return Number.isFinite(value) ? value + 0 : null;
}

/** `sum` and `avg` of floats, leaving out NaN and the infinities (§3.8). */
function floatSum(measure: CheckedMeasure, values: Vector, cells: number): Accumulator {
  const counts = new Float64Array(cells);
  const sums = new Float64Array(cells);
  return {
    add: (cell, row) => {
      const value = values.at(row);
      if (typeof value !== "number") return;
      counts[cell]++;
      sums[cell] += value;
    },
    result: (cell) => {
      if (counts[cell] === 0) return null;
      return measure.fn === "avg" ? finite(sums[cell] / counts[cell]) : finite(sums[cell]);
    },
  };
}

/**
 * `sum` and `avg` of exact numbers: an exact sum, in numbers while they stay exact and in BigInt beyond; a sum
 * that does not fit decimal(38, s) is null, and the average is computed from the exact sum (§3.8).
 */
function exactSum(measure: CheckedMeasure, column: ValueType, values: Vector, cells: number): Accumulator {
  const scale = column.type === "decimal" ? (column.scale ?? 0) : 0;
  const counts = new Float64Array(cells);
  const small = new Float64Array(cells);
  const large: (bigint | undefined)[] = new Array(cells);
  return {
    add: (cell, row) => {
      const value = values.at(row);
      if (value === null) return;
      counts[cell]++;
      let number = Number.NaN;
      if (typeof value === "number") number = value;
      else if ((value as string).length <= 16)
        number = Number(scale === 0 ? value : (value as string).replace(".", ""));
      const total = small[cell] + number;
      if (Number.isSafeInteger(number) && Number.isSafeInteger(total)) small[cell] = total;
      else large[cell] = (large[cell] ?? 0n) + unscaled(value, column);
    },
    result: (cell) => {
      if (counts[cell] === 0) return null;
      const total = BigInt(small[cell]) + (large[cell] ?? 0n);
      if (measure.fn === "avg") return finite(Number(decimalText(total, scale)) / counts[cell]);
      return exactJson(total, measure.type);
    },
  };
}

/**
 * The groups of the rows that `where` keeps, with the measures of each, or with a pivot's generated columns, and
 * those that `having` keeps. Throws a `SpecError` (`too_many_columns`) for a pivot that would make more columns
 * than `maxColumns`.
 */
export function groupRows(input: GroupInput, having: TypedExpr | null): Groups {
  const { columns, values, count } = groupColumns(input);
  const byName = new Map<string, GroupColumn>();
  for (const column of columns) byName.set(column.name, { column, values: values.get(column.name) as JsonValue[] });
  const read = (name: string) => {
    const found = (byName.get(name) as GroupColumn).values;
    return (group: number) => found[group];
  };
  return { columns, values: byName, count, kept: having ? filter(having, read, count) : null };
}

function groupColumns(input: GroupInput): { columns: Column[]; values: Map<string, JsonValue[]>; count: number } {
  const { aggregate, rows, count } = input;
  const { keys, measures, pivot } = aggregate;
  const length = rows ? rows.length : count;
  const groups = combine(
    keys.map((key) => input.ranks(key.name)),
    rows,
    count,
  );
  // Without keys, one group, also over no rows.
  const groupCount = keys.length === 0 ? 1 : groups.firsts.length;
  const combinations = pivot
    ? combine(
        pivot.columns.map((column) => input.ranks(column.name)),
        rows,
        count,
      )
    : null;
  const width = combinations ? combinations.firsts.length : 1;
  if (pivot && width * measures.length > pivot.maxColumns) {
    throw new SpecError("too_many_columns", `The pivot makes more than ${pivot.maxColumns} columns (§4.6).`);
  }
  const accumulators = measures.map((measure) => accumulator(measure, input, groupCount * width));
  for (let at = 0; at < length; at++) {
    const row = rows ? rows[at] : at;
    const cell = groups.of[at] * width + (combinations ? combinations.of[at] : 0);
    for (const item of accumulators) item.add(cell, row);
  }

  const columns = [...input.columns];
  const values = new Map<string, JsonValue[]>();
  for (const key of keys) {
    const source = input.values(key.name);
    values.set(
      key.name,
      groups.firsts.map((row) => source.at(row)),
    );
  }
  const results = (measure: number, combination: number) =>
    Array.from({ length: groupCount }, (_, group) => accumulators[measure].result(group * width + combination));
  if (!pivot || !combinations) {
    measures.forEach((measure, index) => {
      values.set(measure.name, results(index, 0));
    });
    return { columns, values, count: groupCount };
  }
  const taken = new Set(columns.map((column) => column.name));
  combinations.firsts.forEach((row, combination) => {
    const combinationValues = pivot.columns.map((column) => input.values(column.name).at(row));
    const labels = combinationValues.map((value, index) => {
      const text = textOf(value, pivot.columns[index]);
      return text === null ? "(null)" : text === "" ? "(empty)" : text;
    });
    measures.forEach((measure, index) => {
      const name = uniqueName([...labels, measure.name].join(" / "), taken);
      columns.push({
        name,
        ...valueType(measure.type),
        pivot: { values: combinationValues, measure: measure.name },
      });
      values.set(name, results(index, combination));
    });
  });
  return { columns, values, count: groupCount };
}
