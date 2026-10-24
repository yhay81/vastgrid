/**
 * The saved settings of a grid: its query and its columns, as plain JSON that a host app keeps where
 * it likes (localStorage, a URL, a database) and applies to a new grid of the same table.
 *
 * Columns are kept by name, so that a state still applies after the file's columns were added,
 * removed or moved. The query's column indexes refer to `schema`, the column names when the state was
 * saved, and are mapped to the table's columns by name when the state is applied.
 *
 * Every part except `version` is optional: applying a state changes only the parts it has and keeps the
 * grid's current settings for the others. New settings are added as new optional parts within the same
 * version; `version` changes only when an existing part changes its meaning, and `parseGridState`
 * then converts older versions.
 */

import { mapFilterNode } from "./filter-tree.js";
import { AGGREGATE_FUNCTIONS } from "./group.js";
import { parseViewQuery } from "./protocol.js";
import type { AggregateFunction, ViewQuery } from "./types.js";

export const GRID_STATE_VERSION = 1;

export interface GridColumnSetting {
  /** The column's name in the table. */
  name: string;
  /** Width in pixels set by the user. Left out, the grid fits the column to its values. */
  width?: number;
  hidden?: boolean;
  /** The column's value in the totals row at the bottom of the grid. */
  total?: AggregateFunction;
}

/**
 * The grid shows the rows grouped (see `GroupRequest`): by the columns named in `keys`, with
 * `aggregates` of named columns (`column` left out counts rows). The state's `query` still decides
 * which rows are grouped, and its `columns` are those of the table, for when the grouping ends.
 */
export interface GridGroupState {
  keys: string[];
  aggregates: { fn: AggregateFunction; column?: string }[];
  /** A cross tabulation: the columns whose values become columns (see `GroupRequest.pivot`). */
  pivot?: string[];
  /** The settings of the grouped table: its sort, filters and columns, by the names of the result columns. */
  state?: GridState;
}

export interface GridState {
  version: typeof GRID_STATE_VERSION;
  /** The table's column names when the state was saved, in table order. `query` refers to these. */
  schema?: string[];
  /** Sort, filters, the condition tree and search. Column indexes are positions in `schema`. */
  query?: ViewQuery;
  /**
   * Columns in display order. Columns of the table that are not listed (for example added to the file
   * later) keep their current settings and follow the listed ones in their current order (table order
   * in a new grid); listed columns that the table no longer has are skipped. At least one column stays
   * visible.
   */
  columns?: GridColumnSetting[];
  /** Visible columns frozen at the left. */
  frozenColumns?: number;
  /** The rows are shown grouped; `null` shows them as they are. */
  group?: GridGroupState | null;
}

/** A state mapped onto a table's columns, with schema indexes instead of names. */
export interface ResolvedGridState {
  query?: ViewQuery;
  /**
   * The listed columns that the table has, in display order. The table's other columns follow them,
   * with their current settings.
   */
  columns?: { index: number; width?: number; hidden: boolean; total?: AggregateFunction }[];
  frozenColumns?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewQuery(value: unknown): ViewQuery | undefined {
  try {
    return parseViewQuery(value);
  } catch {
    return undefined;
  }
}

/**
 * Reads a state from untrusted JSON. Returns null for values that are not a state and for states of a
 * newer version than this package knows. Invalid parts are left out (so they keep the grid's current
 * settings), invalid columns are skipped, and a plain `ViewQuery` (as saved from `onQueryChange` or
 * `getQuery()` before states existed) becomes a state with that query.
 */
export function parseGridState(value: unknown): GridState | null {
  if (!isRecord(value)) return null;
  if (value.version === undefined) {
    // A query saved before states existed. Its columns are indexes into the table as it is now.
    const keys = Object.keys(value);
    if (!keys.every((key) => key === "sort" || key === "filters" || key === "where" || key === "search")) return null;
    const query = viewQuery(value);
    return query ? { version: GRID_STATE_VERSION, query } : null;
  }
  if (value.version !== GRID_STATE_VERSION) return null;
  const state: GridState = { version: GRID_STATE_VERSION };
  if (Array.isArray(value.schema) && value.schema.every((name) => typeof name === "string")) {
    state.schema = value.schema as string[];
  }
  const query = value.query === undefined ? undefined : viewQuery(value.query);
  if (query) state.query = query;
  if (Array.isArray(value.columns)) {
    state.columns = value.columns.flatMap((item): GridColumnSetting[] => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      const width = item.width;
      const setting: GridColumnSetting = { name: item.name };
      if (typeof width === "number" && Number.isFinite(width) && width > 0) setting.width = width;
      if (item.hidden === true) setting.hidden = true;
      if (isAggregateFunction(item.total)) setting.total = item.total;
      return [setting];
    });
  }
  const frozen = value.frozenColumns;
  if (typeof frozen === "number" && Number.isSafeInteger(frozen) && frozen >= 0) state.frozenColumns = frozen;
  if (value.group === null) state.group = null;
  else if (value.group !== undefined) {
    const group = groupState(value.group);
    if (group) state.group = group;
  }
  return state;
}

function isAggregateFunction(value: unknown): value is AggregateFunction {
  return typeof value === "string" && (AGGREGATE_FUNCTIONS as readonly string[]).includes(value);
}

function groupState(value: unknown): GridGroupState | null {
  if (!isRecord(value) || !Array.isArray(value.keys) || !Array.isArray(value.aggregates)) return null;
  if (!value.keys.every((name) => typeof name === "string")) return null;
  const aggregates = value.aggregates.flatMap((item): GridGroupState["aggregates"] => {
    if (!isRecord(item) || !isAggregateFunction(item.fn)) return [];
    if (typeof item.column === "string") return [{ fn: item.fn, column: item.column }];
    return item.fn === "count" && item.column === undefined ? [{ fn: item.fn }] : [];
  });
  const keys = value.keys as string[];
  if (keys.length === 0 && aggregates.length === 0) return null;
  const group: GridGroupState = { keys, aggregates };
  if (Array.isArray(value.pivot) && value.pivot.length > 0 && value.pivot.every((name) => typeof name === "string")) {
    // A cross tabulation needs an aggregate.
    if (aggregates.length === 0) return null;
    group.pivot = value.pivot as string[];
  }
  // The grouped table's own settings cannot be grouped again.
  const inner = value.state === undefined ? null : parseGridState(value.state);
  if (inner) {
    delete inner.group;
    group.state = inner;
  }
  return group;
}

/** Positions of names, so that the nth column of a repeated name maps to the nth column of that name. */
function namePositions(names: readonly string[]) {
  const positions = new Map<string, number[]>();
  names.forEach((name, index) => {
    const list = positions.get(name);
    if (list) list.push(index);
    else positions.set(name, [index]);
  });
  return positions;
}

/**
 * Maps a state onto a table with these column names. Query keys, conditions and columns whose name the
 * table no longer has are dropped. Without `schema` (a state made from a plain query), query indexes are kept
 * where the table has such a column.
 */
export function resolveGridState(state: GridState, names: readonly string[]): ResolvedGridState {
  const result: ResolvedGridState = {};
  if (state.query) {
    const saved = state.schema;
    let indexOf: (column: number) => number;
    if (saved) {
      const current = namePositions(names);
      const seen = new Map<string, number>();
      const occurrence = saved.map((name) => {
        const count = seen.get(name) ?? 0;
        seen.set(name, count + 1);
        return count;
      });
      indexOf = (column) => {
        const name = saved[column];
        return name === undefined ? -1 : (current.get(name)?.[occurrence[column]] ?? -1);
      };
    } else {
      indexOf = (column) => (column < names.length ? column : -1);
    }
    const query: ViewQuery = {};
    const sort = state.query.sort?.flatMap((key) => {
      const column = indexOf(key.column);
      return column < 0 ? [] : [{ ...key, column }];
    });
    const filters = state.query.filters?.flatMap((filter) => {
      const column = indexOf(filter.column);
      return column < 0 ? [] : [{ ...filter, column }];
    });
    // Conditions on columns the table no longer has are left out, and so are groups left without conditions.
    const where =
      state.query.where &&
      mapFilterNode(state.query.where, (filter) => {
        const column = indexOf(filter.column);
        return column < 0 ? null : { ...filter, column };
      });
    if (sort?.length) query.sort = sort;
    if (filters?.length) query.filters = filters;
    if (where) query.where = where;
    if (state.query.search) query.search = state.query.search;
    result.query = query;
  }
  let frozenPositions: Set<number> | null = null;
  if (state.columns) {
    const available = namePositions(names);
    const columns: NonNullable<ResolvedGridState["columns"]> = [];
    // Positions in `columns` of the saved frozen columns.
    const frozen = new Set<number>();
    let visibleSaved = 0;
    for (const setting of state.columns) {
      const savedFrozen = !setting.hidden && visibleSaved++ < (state.frozenColumns ?? 0);
      const index = available.get(setting.name)?.shift();
      if (index === undefined) continue;
      if (savedFrozen) frozen.add(columns.length);
      columns.push({
        index,
        hidden: setting.hidden === true,
        ...(setting.width === undefined ? {} : { width: setting.width }),
        ...(setting.total === undefined ? {} : { total: setting.total }),
      });
    }
    result.columns = columns;
    frozenPositions = frozen;
  }
  if (state.frozenColumns !== undefined) {
    if (result.columns && frozenPositions) {
      // Frozen columns that the table no longer has are not replaced by the next ones.
      let count = 0;
      for (const [position, column] of result.columns.entries()) {
        if (column.hidden) continue;
        if (!frozenPositions.has(position)) break;
        count++;
      }
      result.frozenColumns = count;
    } else {
      result.frozenColumns = state.frozenColumns;
    }
  }
  return result;
}
