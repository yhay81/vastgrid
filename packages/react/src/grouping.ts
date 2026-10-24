import {
  aggregateName,
  type ColumnFormat,
  type ColumnGroup,
  type ColumnSchema,
  type GroupAggregate,
  type GroupResult,
  pivotText,
} from "vastgrid-core";

/**
 * Header groups of a cross tabulation's generated columns: one per column-axis value (nested for several
 * column-axis columns), over the columns of its aggregates.
 */
export function pivotColumnGroups(result: GroupResult | null): ColumnGroup[] | undefined {
  if (!result?.pivot?.length) return undefined;
  const roots: ColumnGroup[] = [];
  for (const column of result.pivot) {
    let level = roots as (string | ColumnGroup)[];
    for (const value of column.values) {
      const name = pivotText(value);
      const last = level[level.length - 1];
      let group = typeof last === "object" && last.name === name ? last : null;
      if (!group) {
        group = { name, children: [] };
        level.push(group);
      }
      level = group.children as (string | ColumnGroup)[];
    }
    level.push(result.columns[column.column].name);
  }
  return roots;
}

/** Labels of a cross tabulation's generated columns: their aggregate, under the header of their value. */
export function pivotColumnFormats(
  grouping: { source: { result: GroupResult | null }; draft: { aggregates: GroupAggregate[] }; schema: ColumnSchema[] },
  formats: Record<string, ColumnFormat> | undefined,
) {
  const result = grouping.source.result;
  if (!result?.pivot?.length) return formats;
  const labeled: Record<string, ColumnFormat> = { ...formats };
  for (const column of result.pivot) {
    const name = result.columns[column.column].name;
    const aggregate = grouping.draft.aggregates[column.aggregate];
    labeled[name] = { label: aggregateName(aggregate, grouping.schema), ...formats?.[name] };
  }
  return labeled;
}
