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
import { MAX_FORMULA_LENGTH, MAX_FORMULA_NAME_LENGTH, MAX_FORMULAS } from "./formula.js";
import { parseViewQuery } from "./protocol.js";
import type { FormulaColumn, ViewQuery } from "./types.js";

export const GRID_STATE_VERSION = 1;

export interface GridColumnSetting {
  /** The column's name in the table. */
  name: string;
  /** Width in pixels set by the user. Left out, the grid fits the column to its values. */
  width?: number;
  hidden?: boolean;
}

export interface GridState {
  version: typeof GRID_STATE_VERSION;
  /**
   * The grid's column names when the state was saved, in order: the table's columns, then the formula
   * columns that could be evaluated. `query` refers to these.
   */
  schema?: string[];
  /**
   * Formula columns (see `FormulaColumn`), also ones that cannot be evaluated now (for example because a
   * column they use is gone). They use columns by name, so they follow the columns when the file changes.
   */
  formulas?: FormulaColumn[];
  /** Sort, filters, the condition tree and search. Column indexes are positions in `schema`. */
  query?: ViewQuery;
  /**
   * Columns in display order. Columns of the table that are not listed (for example added to the file
   * later) keep their current settings and follow the listed ones in their current order (table order
   * in a new grid), before the columns frozen at the right; listed columns that the table no longer has
   * are skipped. At least one column stays visible.
   */
  columns?: GridColumnSetting[];
  /** Visible columns frozen at the left. */
  frozenColumns?: number;
  /** Visible columns frozen at the right. States saved before right freezing existed leave it out. */
  frozenRightColumns?: number;
}

/** A state mapped onto a table's columns, with schema indexes instead of names. */
export interface ResolvedGridState {
  query?: ViewQuery;
  /**
   * The listed columns that the table has, in display order. The table's other columns follow them,
   * with their current settings.
   */
  columns?: { index: number; width?: number; hidden: boolean }[];
  frozenColumns?: number;
  frozenRightColumns?: number;
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
  if (Array.isArray(value.formulas)) {
    state.formulas = value.formulas
      .flatMap((item): FormulaColumn[] =>
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.expression === "string" &&
        item.name.length <= MAX_FORMULA_NAME_LENGTH &&
        item.expression.length <= MAX_FORMULA_LENGTH
          ? [{ name: item.name, expression: item.expression }]
          : [],
      )
      .slice(0, MAX_FORMULAS);
  }
  const query = value.query === undefined ? undefined : viewQuery(value.query);
  if (query) {
    // The grid's formulas are the state's own part.
    delete query.formulas;
    state.query = query;
  }
  if (Array.isArray(value.columns)) {
    state.columns = value.columns.flatMap((item): GridColumnSetting[] => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      const width = item.width;
      const setting: GridColumnSetting = { name: item.name };
      if (typeof width === "number" && Number.isFinite(width) && width > 0) setting.width = width;
      if (item.hidden === true) setting.hidden = true;
      return [setting];
    });
  }
  const frozen = value.frozenColumns;
  if (typeof frozen === "number" && Number.isSafeInteger(frozen) && frozen >= 0) state.frozenColumns = frozen;
  const frozenRight = value.frozenRightColumns;
  if (typeof frozenRight === "number" && Number.isSafeInteger(frozenRight) && frozenRight >= 0) {
    state.frozenRightColumns = frozenRight;
  }
  return state;
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
  let frozenRightPositions: Set<number> | null = null;
  if (state.columns) {
    const available = namePositions(names);
    const columns: NonNullable<ResolvedGridState["columns"]> = [];
    // Positions in `columns` of the saved frozen columns, at the left and at the right.
    const frozen = new Set<number>();
    const frozenRight = new Set<number>();
    const visibleCount = state.columns.filter((setting) => !setting.hidden).length;
    let visibleSaved = 0;
    for (const setting of state.columns) {
      const position = setting.hidden ? -1 : visibleSaved++;
      const savedFrozen = position >= 0 && position < (state.frozenColumns ?? 0);
      const savedFrozenRight = position >= 0 && position >= visibleCount - (state.frozenRightColumns ?? 0);
      const index = available.get(setting.name)?.shift();
      if (index === undefined) continue;
      if (savedFrozen) frozen.add(columns.length);
      if (savedFrozenRight) frozenRight.add(columns.length);
      columns.push({
        index,
        hidden: setting.hidden === true,
        ...(setting.width === undefined ? {} : { width: setting.width }),
      });
    }
    result.columns = columns;
    frozenPositions = frozen;
    frozenRightPositions = frozenRight;
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
  if (state.frozenRightColumns !== undefined) {
    if (result.columns && frozenRightPositions) {
      let count = 0;
      for (let position = result.columns.length - 1; position >= 0; position--) {
        if (result.columns[position].hidden) continue;
        if (!frozenRightPositions.has(position)) break;
        count++;
      }
      result.frozenRightColumns = count;
    } else {
      result.frozenRightColumns = state.frozenRightColumns;
    }
  }
  return result;
}
