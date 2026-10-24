/**
 * Helpers for condition trees (`ViewQuery.where`): walking, mapping and evaluating them the same way in
 * every source. Engines that compile conditions (for example to SQL) walk the tree themselves and give
 * each group the meaning described on `FilterGroup`.
 */

import type { Filter, FilterGroup, FilterNode, ViewQuery } from "./types.js";

/** Most levels of nested groups in a condition tree. */
export const MAX_FILTER_DEPTH = 8;
/** Most groups and conditions in a condition tree. */
export const MAX_FILTER_NODES = 256;
/** Most values in the value lists of a condition tree, together. */
export const MAX_FILTER_TREE_VALUES = 100_000;

export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return node.type === "and" || node.type === "or";
}

/** The tree without groups that have no conditions (also after removing theirs); undefined if nothing is left. */
export function pruneFilterNode(node: FilterNode | undefined): FilterNode | undefined {
  if (!node) return undefined;
  if (!isFilterGroup(node)) return node;
  const filters = node.filters.flatMap((child) => {
    const pruned = pruneFilterNode(child);
    return pruned ? [pruned] : [];
  });
  if (filters.length === 0) return undefined;
  return filters.length === node.filters.length && filters.every((child, index) => child === node.filters[index])
    ? node
    : { type: node.type, filters };
}

/**
 * Replaces each filter of a tree by `map`'s result; `null` removes it. Groups left without conditions
 * are removed too.
 */
export function mapFilterNode(node: FilterNode, map: (filter: Filter) => Filter | null): FilterNode | undefined {
  if (!isFilterGroup(node)) return map(node) ?? undefined;
  return pruneFilterNode({
    type: node.type,
    filters: node.filters.flatMap((child) => {
      const mapped = mapFilterNode(child, map);
      return mapped ? [mapped] : [];
    }),
  });
}

/** The filters of a tree, in order. */
export function filterLeaves(node: FilterNode | undefined): Filter[] {
  if (!node) return [];
  return isFilterGroup(node) ? node.filters.flatMap(filterLeaves) : [node];
}

/** Every filter a query uses: its `filters` and the filters of its `where` tree. */
export function queryFilters(query: ViewQuery): Filter[] {
  return [...(query.filters ?? []), ...filterLeaves(query.where)];
}

/** The whole condition of a query as one tree (`filters` and `where` under AND), or undefined. */
export function queryCondition(query: ViewQuery): FilterNode | undefined {
  const where = pruneFilterNode(query.where);
  const filters: FilterNode[] = [...(query.filters ?? [])];
  if (where) filters.push(where);
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : { type: "and", filters };
}

/**
 * Whether `test` holds for the tree: every condition of an AND group, at least one of an OR group.
 * Groups without conditions are left out (an empty tree holds).
 */
export function matchesFilterNode(node: FilterNode | undefined, test: (filter: Filter) => boolean): boolean {
  return node === undefined || evaluate(node, test) !== false;
}

/** The result of a tree; undefined for a group without conditions, which its parent leaves out. */
function evaluate(node: FilterNode, test: (filter: Filter) => boolean): boolean | undefined {
  if (!isFilterGroup(node)) return test(node);
  let counted = false;
  for (const child of node.filters) {
    const result = evaluate(child, test);
    if (result === undefined) continue;
    counted = true;
    if (result !== (node.type === "and")) return result;
  }
  return counted ? node.type === "and" : undefined;
}
