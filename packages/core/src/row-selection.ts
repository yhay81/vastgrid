/**
 * Rows checked by the user, kept by a key of the record rather than by a position in the view, so that
 * the same records stay checked when the view is sorted or filtered. This is separate from the cell
 * selection (`SelectionModel`), which is a set of view positions.
 *
 * A key is, by default, the row's position in the original table (`RowBlock.rowIds`). Positions are
 * stable while the table's `revision` stays the same; a source whose data changes must change its
 * revision. A host app can instead name a column whose values identify records (a primary key); such
 * keys stay valid across revisions.
 *
 * Checking every row needs no list of keys: an `exclude` selection is every row except the listed ones,
 * either of the whole table or of the rows matching a filter (`query`).
 */

import { isFilterGroup, pruneFilterNode } from "./filter-tree.js";
import { parseViewQuery } from "./protocol.js";
import type { CellValue, Filter, FilterNode, FormulaColumn, ViewQuery } from "./types.js";

/** Identifies a record: its position in the table, or its value in the key column. */
export type RowKey = string | number;

/**
 * The filters, condition tree and search that limit an `exclude` selection. Column indexes are schema
 * indexes; indexes after the table's columns are the formula columns in `formulas`.
 */
export interface RowSelectionQuery {
  formulas?: FormulaColumn[];
  filters?: Filter[];
  where?: FilterNode;
  search?: string;
}

export type RowSelection =
  /** The rows with these keys. */
  | { type: "include"; keys: RowKey[] }
  /**
   * Every row except the ones with these keys: every row of the table, or with `query`, every row
   * that matches it. Rows that match it later (for example after the data changed) are included.
   */
  | { type: "exclude"; keys: RowKey[]; query?: RowSelectionQuery };

/**
 * The parts of a view query that choose rows (filters, condition tree and search), or undefined when it
 * keeps every row.
 */
export function rowSelectionQuery(query: ViewQuery): RowSelectionQuery | undefined {
  const filters = query.filters ?? [];
  const where = pruneFilterNode(query.where);
  const search = query.search?.trim() ?? "";
  if (filters.length === 0 && !where && !search) return undefined;
  return {
    ...(query.formulas?.length ? { formulas: query.formulas } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(where ? { where } : {}),
    ...(search ? { search } : {}),
  };
}

/** A condition tree as text that is the same for the same conditions in the same order. */
function treeKey(node: FilterNode | undefined): string {
  if (!node) return "";
  return isFilterGroup(node) ? JSON.stringify([node.type, node.filters.map(treeKey)]) : filterKey(node);
}

/** A filter as text that is the same for the same condition: keys sorted, options left at their default left out. */
function filterKey(filter: Filter) {
  const entries = Object.entries(filter).filter(
    ([name, value]) => value !== undefined && !((name === "exclude" || name === "caseSensitive") && value === false),
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Whether two selection queries choose the same rows by the same conditions. */
export function sameRowQuery(a: RowSelectionQuery | undefined, b: RowSelectionQuery | undefined) {
  const key = (query: RowSelectionQuery | undefined) =>
    JSON.stringify([
      query?.formulas ?? [],
      (query?.filters ?? []).map(filterKey),
      treeKey(pruneFilterNode(query?.where)),
      query?.search?.trim() ?? "",
    ]);
  return key(a) === key(b);
}

/**
 * Whether every row of a view with `view`'s query matches `query`: the view has every filter of it,
 * the same condition tree when it has one, and its search contains its search (a column containing
 * "abc" also contains "ab").
 */
export function impliesRowQuery(view: ViewQuery, query: RowSelectionQuery | undefined) {
  if (!query) return true;
  // Filters on formula columns mean the same only with the same formulas.
  if (query.formulas?.length && JSON.stringify(query.formulas) !== JSON.stringify(view.formulas ?? [])) return false;
  const where = pruneFilterNode(query.where);
  if (where && treeKey(where) !== treeKey(pruneFilterNode(view.where))) return false;
  const filters = new Set((view.filters ?? []).map(filterKey));
  if (!(query.filters ?? []).every((filter) => filters.has(filterKey(filter)))) return false;
  const search = query.search?.trim().toLowerCase() ?? "";
  return !search || (view.search?.trim().toLowerCase() ?? "").includes(search);
}

/** The key of a value of the key column, or null for a blank. Booleans become text. */
export function rowKeyOf(value: CellValue | undefined): RowKey | null {
  if (value === null || value === undefined) return null;
  return typeof value === "boolean" ? String(value) : value;
}

function isKey(value: unknown): value is RowKey {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Checks a row selection from outside the program (for example from storage). Returns null when it is
 * not one.
 */
export function parseRowSelection(value: unknown): RowSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.keys) || !record.keys.every(isKey)) return null;
  const keys = record.keys as RowKey[];
  if (record.type === "include") return { type: "include", keys };
  if (record.type !== "exclude") return null;
  if (record.query === undefined) return { type: "exclude", keys };
  let query: ViewQuery;
  try {
    query = parseViewQuery(record.query);
  } catch {
    return null;
  }
  const rows = rowSelectionQuery(query);
  return rows ? { type: "exclude", keys, query: rows } : { type: "exclude", keys };
}

/**
 * The checked rows of a grid. `include` keeps the checked keys; `exclude` keeps the unchecked keys of
 * every row (of the table, or matching `query`).
 */
export class RowSelectionModel {
  private mode: RowSelection["type"] = "include";
  private readonly keys = new Set<RowKey>();
  private scope: RowSelectionQuery | undefined;

  get type() {
    return this.mode;
  }

  /** The listed keys: checked ones for `include`, unchecked ones for `exclude`. */
  get size() {
    return this.keys.size;
  }

  /** The rows an `exclude` selection is limited to. */
  get query() {
    return this.mode === "exclude" ? this.scope : undefined;
  }

  /** No row is checked. */
  get empty() {
    return this.mode === "include" && this.keys.size === 0;
  }

  value(): RowSelection {
    const keys = [...this.keys];
    if (this.mode === "include") return { type: "include", keys };
    return this.scope ? { type: "exclude", keys, query: this.scope } : { type: "exclude", keys };
  }

  /** Whether the selection is this one (keys in any order). */
  equals(selection: RowSelection) {
    if (selection.type !== this.mode || new Set(selection.keys).size !== this.keys.size) return false;
    if (!selection.keys.every((key) => this.keys.has(key))) return false;
    return selection.type === "include" || sameRowQuery(selection.query, this.scope);
  }

  set(selection: RowSelection) {
    this.mode = selection.type;
    this.keys.clear();
    for (const key of selection.keys) this.keys.add(key);
    this.scope = selection.type === "exclude" && selection.query ? rowSelectionQuery(selection.query) : undefined;
  }

  clear() {
    this.set({ type: "include", keys: [] });
  }

  /** Checks every row of a view with this query: every row of the table without filters or a search. */
  selectAll(view: ViewQuery) {
    const query = rowSelectionQuery(view);
    this.set(query ? { type: "exclude", keys: [], query } : { type: "exclude", keys: [] });
  }

  /**
   * Whether the rows of a view with this query can be told checked or not. They cannot when every row
   * matching a query is checked and the view also has rows that may not match it.
   */
  covers(view: ViewQuery) {
    return this.mode === "include" || impliesRowQuery(view, this.scope);
  }

  /** Whether a row of a view with this query is checked, or null when it cannot be told (see `covers`). */
  has(key: RowKey, view: ViewQuery): boolean | null {
    if (this.mode === "include") return this.keys.has(key);
    return this.covers(view) ? !this.keys.has(key) : null;
  }

  /** Checks or unchecks rows of a view. Returns false, changing nothing, when they cannot be told (see `covers`). */
  setRows(keys: Iterable<RowKey>, checked: boolean, view: ViewQuery) {
    if (!this.covers(view)) return false;
    // In an `exclude` selection the listed keys are the unchecked rows.
    const listed = this.mode === "include" ? checked : !checked;
    for (const key of keys) {
      if (listed) this.keys.add(key);
      else this.keys.delete(key);
    }
    return true;
  }

  /**
   * Every row of a view with this query is checked (`true`), none is (`false`), or some are (`"mixed"`,
   * also when it cannot be told).
   */
  state(view: ViewQuery): boolean | "mixed" {
    if (this.empty) return false;
    return this.mode === "exclude" && this.keys.size === 0 && this.covers(view) ? true : "mixed";
  }

  /**
   * Checked rows, given the number of rows an `exclude` selection covers (`rows`, null when unknown).
   * The unchecked keys of an `exclude` selection are taken to be rows it covers.
   */
  count(rows: number | null): number | null {
    if (this.mode === "include") return this.keys.size;
    return rows === null ? null : Math.max(0, rows - this.keys.size);
  }
}
