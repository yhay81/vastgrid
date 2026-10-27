/**
 * Views of plans that derive, filter or group (docs/spec.md §4.1): derive, where, aggregate, having, then
 * sort. The engine loads this module with the first such plan, so that pages whose plans only sort do not load
 * it, and gives it the functions of order that those pages load anyway.
 */
import type { CheckedPlan, Column, JsonValue } from "vastgrid-spec";
import { groupRows } from "./aggregate.js";
import { type ColumnReader, evaluate, filter } from "./evaluate.js";
import type { ColumnRanks, RankedKey } from "./order.js";
import { type Vector, vectorOf } from "./table.js";

/** A column that a view computes: a derived column by row ID, or a column of groups by group number. */
export interface ViewColumn {
  column: Column;
  values: JsonValue[];
}

/** What a view reads of its table, and the engine's functions of order (§3.3). */
export interface ViewContext {
  /** The rows of the table. */
  count: number;
  /** A column of the table: its values by row ID, and its ranks. */
  values(name: string): Vector;
  ranks(name: string): ColumnRanks;
  rankColumn(column: Column, values: Vector): ColumnRanks;
  sortRows(count: number, keys: readonly RankedKey[], rows: Uint32Array | null): Uint32Array | null;
  /** The plan's sort keys, by the ranks of the view's columns. */
  sortKeys(ranks: (name: string) => ColumnRanks): RankedKey[];
}

/** A view of a plan: its columns, the columns it computes, and its rows (row IDs or group numbers) in order. */
export interface ViewShape {
  columns: Column[];
  derived: Map<string, ViewColumn>;
  grouped: boolean;
  /** The rows of the table, or the groups. */
  tableRows: number;
  rowCount: number;
  order: Uint32Array | null;
}

export function planView(checked: CheckedPlan, context: ViewContext): ViewShape {
  const { count } = context;
  // Expressions read the table's columns and the derived ones before them.
  const derived = new Map<string, ViewColumn>();
  const valuesOf = (name: string): Vector => {
    const made = derived.get(name);
    return made ? vectorOf(made.values) : context.values(name);
  };
  const read: ColumnReader = (name) => {
    const values = valuesOf(name);
    return (row) => values.at(row);
  };
  for (const item of checked.derive) {
    derived.set(item.name, { column: item.column, values: evaluate(item.expr, read, count) });
  }
  const filtered = checked.where ? filter(checked.where, read, count) : null;
  const ranksOf = (columns: Map<string, ViewColumn>, name: string) => {
    const made = columns.get(name);
    return made ? context.rankColumn(made.column, vectorOf(made.values)) : context.ranks(name);
  };
  if (!checked.aggregate) {
    return {
      columns: checked.columns,
      derived,
      grouped: false,
      tableRows: count,
      rowCount: filtered ? filtered.length : count,
      order: context.sortRows(
        count,
        context.sortKeys((name) => ranksOf(derived, name)),
        filtered,
      ),
    };
  }
  const groups = groupRows(
    {
      aggregate: checked.aggregate,
      columns: checked.columns,
      rows: filtered,
      count,
      values: valuesOf,
      ranks: (name) => ranksOf(derived, name),
    },
    checked.having,
  );
  return {
    columns: groups.columns,
    derived: groups.values,
    grouped: true,
    tableRows: groups.count,
    rowCount: groups.kept ? groups.kept.length : groups.count,
    order: context.sortRows(
      groups.count,
      context.sortKeys((name) => ranksOf(groups.values, name)),
      groups.kept,
    ),
  };
}
