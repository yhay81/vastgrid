/**
 * Measures over the rows of a view (§4.5 of the specification), for the column statistics and the totals row: both
 * are an `aggregate` without keys over the plan's rows (Appendix A), read with `rows` like any view.
 */
import {
  type Capabilities,
  type Column,
  checkPlan,
  type DisplayedColumn,
  type Measure,
  type MeasureName,
  measureTakes,
  type Plan,
  planOptions,
} from "vastgrid-spec";
import type { TableInfo } from "./types.js";

/** The rows of a plan before grouping: its derived columns and `where`. Null when the plan groups rows. */
function rowsPlan(plan: Plan): Plan | null {
  if (plan.aggregate) return null;
  return { ...(plan.derive ? { derive: plan.derive } : {}), ...(plan.where ? { where: plan.where } : {}) };
}

/** Whether the engine evaluates a measure (§4.10: absent `measures` are all of them). */
export function offers(capabilities: Capabilities | undefined, fn: MeasureName): boolean {
  if (capabilities?.plan?.aggregate === false) return false;
  return capabilities?.measures?.includes(fn) ?? true;
}

/** A statistic of a column: what it is, and the measure that gives it. */
export interface Statistic {
  kind: "rows" | "values" | "distinct" | "min" | "max" | "sum" | "average" | "median" | "stddev";
  measure: Measure;
}

const STATISTICS: [Statistic["kind"], MeasureName, number?][] = [
  ["values", "count"],
  ["distinct", "count_distinct"],
  ["min", "min"],
  ["max", "max"],
  ["sum", "sum"],
  ["average", "avg"],
  ["median", "quantile", 0.5],
  ["stddev", "stddev"],
];

/** The statistics of a column that the engine evaluates and that take its type, with the number of rows first. */
export function statisticsOf(column: Column, capabilities: Capabilities | undefined): Statistic[] {
  if (!offers(capabilities, "count")) return [];
  const list: Statistic[] = [{ kind: "rows", measure: { name: "rows", fn: "count" } }];
  for (const [kind, fn, p] of STATISTICS) {
    if (!offers(capabilities, fn) || !measureTakes(fn, column)) continue;
    list.push({ kind, measure: { name: kind, fn, column: column.name, ...(p === undefined ? {} : { p }) } });
  }
  return list;
}

/** The measures of the totals row (§5.1): one per displayed column with a total, named after the column. */
export function totalMeasures(displayed: readonly DisplayedColumn[]): Measure[] {
  return displayed.flatMap(({ column, setting }) =>
    setting.total
      ? [
          {
            name: column.name,
            fn: setting.total.fn,
            column: column.name,
            ...(setting.total.p === undefined ? {} : { p: setting.total.p }),
          },
        ]
      : [],
  );
}

/** The plan of measures over the rows of a plan, or null when it groups rows. */
export function measuresPlan(plan: Plan, measures: Measure[]): Plan | null {
  const rows = rowsPlan(plan);
  return rows && { ...rows, aggregate: { keys: [], measures } };
}

/** The measures that a total can be, for a column's type, in the order the menu offers them. */
export const TOTALS: MeasureName[] = ["sum", "avg", "count", "count_distinct", "min", "max"];

/** A measure's name as 0.1 wrote it, `sum(amount)` or `count(*)`, with ` (2)`, ` (3)`, … when it is taken. */
export function measureName(fn: MeasureName, column: string | undefined, taken: ReadonlySet<string>): string {
  const base = `${fn}(${column ?? "*"})`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
  return name;
}

/** The columns of the rows before grouping: the table's and the derived ones, or the table's when the plan fails. */
export function rowColumns(plan: Plan | undefined, table: TableInfo): readonly Column[] {
  try {
    return checkPlan(rowsPlan({ ...plan, aggregate: undefined }) ?? {}, table.columns, planOptions(table.capabilities))
      .rows;
  } catch {
    return table.columns;
  }
}
