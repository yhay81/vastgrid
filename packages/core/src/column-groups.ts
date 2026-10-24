import type { ColumnGroup } from "./types.js";

/** Groups nested at most this deep. */
export const MAX_GROUP_DEPTH = 8;

/**
 * Consecutive visible columns under one group in one header row. A group whose columns are not side by
 * side (moved apart, or split by frozen columns) has one span for each run of its columns.
 */
export interface ColumnGroupSpan {
  group: ColumnGroup;
  /** Header row of groups, 0 for the outermost groups. */
  level: number;
  /** First and last visible column, inclusive. */
  start: number;
  end: number;
}

/**
 * Checks group definitions and returns the groups of each schema column name, outermost first. Throws a
 * `RangeError` when a group has no name or no children list, groups nest deeper than `MAX_GROUP_DEPTH`,
 * or a column is in more than one group.
 */
export function columnGroupPaths(groups: readonly ColumnGroup[]): Map<string, ColumnGroup[]> {
  const paths = new Map<string, ColumnGroup[]>();
  const visit = (group: ColumnGroup, path: ColumnGroup[]) => {
    if (!group || typeof group !== "object" || typeof group.name !== "string" || !Array.isArray(group.children)) {
      throw new RangeError("A column group needs a name and a list of children.");
    }
    if (path.length >= MAX_GROUP_DEPTH) throw new RangeError(`Column groups nest at most ${MAX_GROUP_DEPTH} deep.`);
    const inner = [...path, group];
    for (const child of group.children) {
      if (typeof child !== "string") {
        visit(child, inner);
      } else if (paths.has(child)) {
        throw new RangeError(`The column "${child}" is in more than one group.`);
      } else {
        paths.set(child, inner);
      }
    }
  };
  for (const group of groups) visit(group, []);
  return paths;
}

/**
 * Header rows the groups need: how deep they nest. It depends only on the definitions, so that hiding
 * or moving columns never changes the height of the header.
 */
export function columnGroupDepth(groups: readonly ColumnGroup[]): number {
  let depth = 0;
  const visit = (group: ColumnGroup, level: number) => {
    depth = Math.max(depth, level + 1);
    for (const child of group.children) if (typeof child !== "string") visit(child, level + 1);
  };
  for (const group of groups) visit(group, 0);
  return depth;
}

/**
 * The spans of each header row of groups, from the outermost row. `paths[col]` are the groups of the
 * visible column `col` (from `columnGroupPaths`). A span ends where the next column is not in its
 * group, and at each of `breaks`: the first column of a region that scrolls apart (the first scrolling
 * column after frozen ones), so that each region shows its own part of a group.
 */
export function columnGroupSpans(
  paths: readonly (readonly ColumnGroup[] | undefined)[],
  depth: number,
  breaks: readonly number[] = [],
): ColumnGroupSpan[][] {
  const rows: ColumnGroupSpan[][] = [];
  for (let level = 0; level < depth; level++) {
    const row: ColumnGroupSpan[] = [];
    let open: ColumnGroupSpan | null = null;
    for (let col = 0; col < paths.length; col++) {
      const group = paths[col]?.[level];
      if (open && open.group === group && !breaks.includes(col)) {
        open.end = col;
        continue;
      }
      open = group ? { group, level, start: col, end: col } : null;
      if (open) row.push(open);
    }
    rows.push(row);
  }
  return rows;
}

/** The span covering a visible column in a header row, by binary search, or null. */
export function spanAt(spans: readonly ColumnGroupSpan[], col: number): ColumnGroupSpan | null {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (col < span.start) high = middle - 1;
    else if (col > span.end) low = middle + 1;
    else return span;
  }
  return null;
}
