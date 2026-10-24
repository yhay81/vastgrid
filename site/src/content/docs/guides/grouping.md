---
title: Grouping and totals
description: Group rows by columns with counts, sums, averages, minimums and maximums, and a totals row, computed by the source.
---

The grid can show the rows grouped by one or more columns, with aggregates of each group, and a totals
row at the bottom. The source computes both (`TableSource.group`), over the rows that the current
filters, condition tree and search keep, so a table of a hundred million rows sends only its groups to
the browser.

| Source | Grouping and totals |
| --- | --- |
| `ArraySource` | Yes, in memory. |
| `RemoteSource` + `vastgrid-duckdb` | Yes, as one parameterless SQL statement generated from column indexes. |
| `BrowserSource` (`vastgrid-browser`) | With `fullScan` (local files, by default): one pass over the file in the worker. |
| Your own source | When it implements `group` and reports `capabilities.group`. |

The grid offers the features only when the source reports `capabilities.group`.

## In the grid

- **Group**: the toolbar's "Group" button opens a panel. Pick the columns to group by (in the order you
  pick them) and the values: count of rows, or count, sum, average, minimum or maximum of a column. Only
  functions that fit a column's type are offered. "Group by this column" in a column's menu groups by it
  and counts the rows.
- The grid then shows the groups as a table: the key columns, then one column per value, named like
  `sum(amount)`. A chip in the toolbar says what the rows are grouped by, whether they were filtered first,
  and how many groups there are; its × (or "Show rows" in the panel) shows the rows again, with the filters,
  sort and columns they had.
- **Totals row**: "Total in the bottom row…" in a column's menu picks the column's aggregate in a row
  that stays at the bottom of the grid. Clicking a total opens the same menu, which can also copy it. It
  follows the current view: filters, condition tree and search, not the selection.

## What the groups mean

- **Rows**: the rows of the current view. Its sort does not matter.
- **Keys**: a null value is a group of its own, and so is the empty string; they are different values,
  as in SQL. Numbers group by value (`1.5` and `1.50` of a decimal column are one group). Lists, structs,
  maps, binary, JSON and unknown types cannot be keys.
- **Functions**: `count` without a column counts rows, with one the values that are not null. `sum` and
  `avg` take numeric columns; `min` and `max` also take text, booleans, dates, times and UUIDs. Null
  values are left out, and so are NaN and infinities of floating-point columns. A function over no values
  is blank, except `count`, which is 0.
- **Order**: groups are sorted by the keys ascending, blanks (null and empty text) last. Floating-point
  keys that are not finite sort as in DuckDB: -Infinity first, then the numbers, Infinity and NaN. Sorting a column
  of the grouped table sorts the groups by it, blanks last in both directions, ties by the keys.
- **Types and precision**: `count` is an integer. `sum` of integers is an exact integer, also beyond
  2^53 (it arrives as text then); `sum` of decimals is an exact decimal with the column's scale; `sum` of
  floating-point numbers and every `avg` are floating-point numbers. `min` and `max` have the column's
  type, so they show with its format.
- **How many**: at most 1,000 groups are read (`limit`, up to 100,000). When there are more, the grid shows
  the first ones of the current order and says how many there are; sorting reads the first ones of the
  new order from the source.
- **Statistics, filters, find and export** work on the grouped table as on any table: column statistics,
  filters and the search of the groups, and exports of the groups to CSV, TSV, JSON or Excel (downloaded
  by the browser). They are offered only when every group was read; with more groups than the limit,
  sorting, find and the selection summary remain.
- **Checked rows** (`checkboxSelection`) belong to the rows of the table: groups have no checkboxes.
- **Formula columns** of the rows (see [Formula columns](/guides/formulas/)) are columns like the
  table's: they can be keys, values, column-axis columns and totals. The grouped table has no formula
  columns of its own; `formulas` and `setFormulas` keep applying to the rows, and changing them groups the
  rows again.
- **Column groups and freezing**: the grid's `columnGroups` describe the table's columns and do not apply to
  the grouped table, and neither do `frozenColumns` and `frozenRightColumns`. The grouped table freezes its
  key columns at the left; a cross tabulation groups its generated columns under headers of their values,
  each labeled by its aggregate. Its own freezing, widths and sort are kept in `group.state`.

## Cross tabulations

"Columns from values (cross tabulation)" in the panel turns the values of one or more columns into
columns, after the key columns: one column per value and aggregate, named like `Tokyo / sum(amount)`
(`2024 / Tokyo / count(*)` with two columns; `(null)` and `(empty)` for null and empty text). Sources that
make them report `capabilities.pivot` (`ArraySource`, `vastgrid-duckdb`, and `vastgrid-browser` with
`fullScan`).

- The value columns are in the order of the values: ascending, blanks last. Within a value, the
  aggregates keep their order.
- A cell whose group has no rows with that value is blank, except a count, which is 0.
- A cross tabulation makes at most 200 columns. Settings that would make more are refused with a notice,
  and the grid keeps what it showed: filter the rows, or pick columns with fewer values.
- The names are the same for the same settings and data, so the grouped table's column settings (widths,
  totals, sort) are kept by them in the state. `GroupResult.pivot` gives each generated column's values,
  for apps that draw multi-level headers themselves.
- No subtotal or grand total rows or columns are added: the totals row gives the totals of each column.
  To see the rows of a cell, filter the rows by its values and show the rows again.

## What the totals row is

- It is not a row of the grid. It is not selected, copied (except with "Copy total") or exported with the
  rows, and the arrow keys do not reach it. Its cells are buttons in the tab order after the grid, so the
  keyboard reaches them with Tab; screen readers read the column, the function and the value.
- A total uses the column's format when it is a value of the column (sum, min, max), and plain numbers
  for counts.
- The totals of a grouped table are totals of its groups (the sum of a `sum` column is the total of all
  rows; the sum of a `count(*)` column is the number of rows).

## Saving the settings

`getState()` keeps both:

```json
{
  "version": 1,
  "schema": ["region", "product", "amount"],
  "query": { "filters": [{ "type": "compare", "column": 2, "op": "gt", "value": 0 }] },
  "columns": [{ "name": "amount", "total": "sum" }],
  "group": {
    "keys": ["region"],
    "aggregates": [{ "fn": "count" }, { "fn": "sum", "column": "amount" }],
    "pivot": ["year"],
    "state": { "version": 1, "schema": ["region", "count(*)", "sum(amount)"], "query": { "sort": [{ "column": 2, "direction": "desc" }] } }
  }
}
```

- `columns[].total` is a column's aggregate in the totals row.
- `group` names the key, value and column-axis (`pivot`) columns by name; `group.state` is the grouped table's own settings
  (sort, filters, widths, totals), by the names of its columns. `query` and `columns` remain those of the
  rows, which the grid shows again when the grouping ends. `"group": null` shows the rows.
- Applying a state with `group` reads the groups first; columns the table no longer has are dropped.

## From code

`group` is a method of the source, so an app can use it without the grid, for example to
[draw a chart](/guides/charts/):

```ts
const view = await source.createView({ filters: [{ type: "compare", column: 2, op: "gt", value: 0 }] });
const result = await source.group({
  view: view.id,
  keys: [0],
  aggregates: [{ fn: "count" }, { fn: "sum", column: 2 }],
  sort: [{ column: 2, direction: "desc" }],
  limit: 20,
});
// result.columns: [{ name: "region", type: "string" }, { name: "count(*)", type: "bigint" }, { name: "sum(amount)", type: "decimal" }]
// result.rows: [["Tokyo", 120, "53210.50"], …], result.groups: 47, result.truncated: true
```

Without `keys`, the result is one row of totals. With `pivot: { columns: [1] }`, it is a cross
tabulation; a request that would make more than `maxColumns` (200) columns fails with
`too_many_columns`. `GroupedSource` shows a result as a table of its own,
for a second grid or for your own UI:

```tsx
<DataGrid source={new GroupedSource(source, { keys: [0], aggregates: [{ fn: "count" }], query })} />
```

A `GroupedSource` reads its groups again when the base table reports a change or a new `revision`;
`reload()` makes it read them again otherwise (the grid's `reload()` and `reloadKey` call it).

The [protocol](/reference/protocol/#groups-and-totals) defines the request and the result exactly.
