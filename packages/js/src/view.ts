/**
 * Views of the memory engine's tables (docs/spec.md §4.2, §8.3): the rows of a plan in order, kept by the plan's
 * hash, and the positions of rows in them.
 */
import { type CheckedPlan, type Column, checkPlan, planHash } from "vastgrid-spec";
import { PLAN_OPTIONS } from "./capabilities.js";
import { rankPausing, ranksOf, readColumns, type Table, valuesOf } from "./open-table.js";
import { type ColumnRanks, type RankedKey, rankColumn, sortRows } from "./order.js";
import type { ViewColumn, ViewShape } from "./plan.js";
import { Failure, pause, type Running } from "./running.js";
import { isObject, shown, type Vector, vectorOf } from "./table.js";

/** Views that a table keeps, the least recently used forgotten first (§8.3). */
const KEPT_VIEWS = 8;

/** A view of a table (§4.2): its rows in order. */
export interface View {
  hash: string;
  columns: Column[];
  /** The derived columns by name; in a view of groups, every column of the view, by group number. */
  derived: Map<string, ViewColumn>;
  /** Whether the view's rows are groups (§4.2), which have no row IDs. */
  grouped: boolean;
  /** The rows of the table when the view was made; the groups of a view of groups. */
  tableRows: number;
  rowCount: number;
  /** The row ID (group number) at each position; null when the view is every row of the table (every group) in order. */
  order: Uint32Array | null;
  /** The position of each row ID, made when `locate` first needs it. */
  positions?: Uint32Array;
  /** For each column that `locate` looked values up in, by its name: the first position of each rank. */
  firsts: Map<string, Int32Array>;
}

/** A column that a request reads: a table's column at its index, or a derived column with its values. */
export interface Source {
  name: string;
  column: Column;
  /** The index of a table's column; −1 for a derived column. */
  index: number;
  values: Vector | null;
}

/**
 * Adds the names of columns that a plan names (§4.1) to `names`: in expressions, keys, measures, pivots and sorts.
 * True when it searches (§3.5), which reads every column.
 */
function planNames(value: unknown, names: Set<string>): boolean {
  if (Array.isArray(value)) return value.reduce<boolean>((search, item) => planNames(item, names) || search, false);
  if (!isObject(value)) return false;
  let search = typeof value.search === "string";
  for (const [key, item] of Object.entries(value)) {
    if ((key === "col" || key === "column") && typeof item === "string") names.add(item);
    else if ((key === "keys" || key === "columns") && Array.isArray(item)) {
      for (const name of item) if (typeof name === "string") names.add(name);
    } else if (planNames(item, names)) search = true;
  }
  return search;
}

/** The position of a row that a view leaves out, in `View.positions`. */
const NO_POSITION = 0xffff_ffff;

/** The names that a plan sorts or groups by, or counts the distinct values of; derived columns are left out. */
function rankedNames(plan: CheckedPlan["plan"]): string[] {
  const { aggregate } = plan;
  const names = aggregate
    ? [
        ...aggregate.keys,
        ...(aggregate.pivot?.columns ?? []),
        ...aggregate.measures.flatMap((measure) =>
          measure.fn === "count_distinct" && measure.column ? [measure.column] : [],
        ),
      ]
    : (plan.sort ?? []).map((key) => key.column);
  const derived = new Set((plan.derive ?? []).map((item) => item.name));
  return names.filter((name) => !derived.has(name));
}

/** The view of a request's plan (§4.7, §8.3): checked against the table, kept by its hash. */
export async function viewOf(table: Table, plan: unknown, running: Running): Promise<View> {
  const checked: CheckedPlan = checkPlan(plan, table.columns, PLAN_OPTIONS);
  const hash = await planHash(checked.plan);
  if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
  const kept = table.views.get(hash);
  if (kept) {
    table.views.delete(hash);
    table.views.set(hash, kept);
    return kept;
  }
  if (table.reader) {
    const names = new Set<string>();
    const every = planNames(checked.plan, names);
    const named = [...names].filter((name) => table.index.has(name));
    await readColumns(
      table,
      every ? table.columns.keys() : named.map((name) => table.index.get(name) as number),
      running,
    );
  }
  // The columns that the view sorts or groups by are ranked first, which a cancel stops.
  for (const name of rankedNames(checked.plan)) {
    const index = table.index.get(name);
    if (index !== undefined) await rankPausing(table, index, running);
  }
  const count = table.rowCount;
  const ranks = (name: string) => ranksOf(table, table.index.get(name) as number);
  let shape: ViewShape;
  if (checked.derive.length > 0 || checked.where || checked.aggregate) {
    const { planView } = await import("./plan.js");
    shape = planView(checked, {
      count,
      values: (name) => valuesOf(table, table.index.get(name) as number),
      ranks,
      rankColumn,
      sortRows,
      sortKeys: (ranksOf) => sortKeys(checked, ranksOf),
    });
  } else {
    shape = {
      columns: checked.columns,
      derived: new Map(),
      grouped: false,
      tableRows: count,
      rowCount: count,
      order: sortRows(count, sortKeys(checked, ranks), null),
    };
  }
  const view: View = { hash, ...shape, firsts: new Map() };
  table.views.set(hash, view);
  if (table.views.size > KEPT_VIEWS) table.views.delete(table.views.keys().next().value as string);
  // A view is made to its end, and kept; a cancel that came while it was made stops the request after it.
  await pause(running);
  return view;
}

/** The sort keys of a plan (§3.3); a key on a column that an earlier key sorted by cannot break a tie. */
function sortKeys(checked: CheckedPlan, ranksOf: (name: string) => ColumnRanks): RankedKey[] {
  const used = new Set<string>();
  const keys: RankedKey[] = [];
  for (const key of checked.sort) {
    const name = key.column.name;
    if (used.has(name)) continue;
    used.add(name);
    keys.push({ ranks: ranksOf(name), descending: key.direction === "desc" });
  }
  return keys;
}

/**
 * The columns that a request names, which must be columns of the view: the index of a table's column, or the
 * values of a derived one or of a column of groups.
 */
export function columnsOf(table: Table, view: View, names: string[]): Source[] {
  return names.map((name, at) => {
    const derived = view.derived.get(name);
    if (derived) return { name, column: derived.column, index: -1, values: vectorOf(derived.values) };
    const index = table.index.get(name);
    if (index === undefined || !view.columns.some((column) => column.name === name)) {
      throw new Failure("invalid_request", `The view has no column ${shown(name)}.`, {
        path: `/columns/${at}`,
        reason: "syntax",
      });
    }
    return { name, column: table.columns[index], index, values: null };
  });
}

/** The position of a row in a view, or null when the view does not have it. */
export function positionOf(view: View, rowId: number): number | null {
  if (rowId >= view.tableRows) return null;
  if (!view.order) return rowId;
  if (!view.positions) {
    // Rows that the view leaves out have no position.
    const positions = new Uint32Array(view.tableRows).fill(NO_POSITION);
    view.order.forEach((row, position) => {
      positions[row] = position;
    });
    view.positions = positions;
  }
  const position = view.positions[rowId];
  return position === NO_POSITION ? null : position;
}

/** The first position in a view of each rank of a column, −1 for ranks that no row of the view has. */
export function firstsOf(view: View, column: string, ranks: ColumnRanks): Int32Array {
  let firsts = view.firsts.get(column);
  if (!firsts) {
    firsts = new Int32Array(ranks.distinct + 2).fill(-1);
    for (let position = 0; position < view.rowCount; position++) {
      const rank = ranks.ranks[view.order ? view.order[position] : position];
      if (firsts[rank] < 0) firsts[rank] = position;
    }
    view.firsts.set(column, firsts);
  }
  return firsts;
}
