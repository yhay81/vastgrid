---
title: Grouping and totals
description: Groups of rows with measures, pivots, conditions on groups, and the totals row, computed by the engine.
---

The grid can show groups instead of rows: one row for each combination of values of the key columns, with
measures of the group (count, sum, average, …). Under an ungrouped view it can also show a totals row. The engine
computes both over the whole table, so a table of a hundred million rows sends only its groups to the browser.

A grouped view is the plan's `aggregate`. Engines that group report `capabilities.plan.aggregate`, those that
pivot `capabilities.plan.pivot`, and those that keep groups by a condition `capabilities.plan.having`. The memory
engine and the DuckDB engine do all three, with the same results.

## In the grid

- **Group by this column** in a column's menu groups by the column alone and counts the rows (`count(*)`). On a
  grouped view, a key's menu has "Stop grouping by this column", and "Ungroup" shows the rows again.
- The toolbar's **Group** menu edits the grouping, and each change applies at once:
  - "Group by": the keys, in order, with "Add a column…".
  - "Measures": each a measure and a column ("(rows)" to count rows), with Add. A measure is named after them as
    v1 named it: `sum(qty)`, `count(*)`.
  - "Columns from values of", when the engine pivots: the columns whose values become columns
    (see [Pivots](#pivots)).
- The grouped view has the keys, then one column per measure. Sort it by any of them as any view; the search box
  and the Conditions menu filter the rows before they are grouped.
- [Formula columns](/guides/formulas/) can be keys and measures' columns, since they are computed before the
  rows are grouped.
- Groups are not rows of the table: they have no row IDs, their cells are not writable, and Filter…, Statistics…
  and the totals row are not offered. [Exports](/guides/export/) of the view write the groups.

The [charts guide](/guides/charts/) draws the groups that the grid shows.

## Measures

| Measure | Column | Result |
| --- | --- | --- |
| Count (`count`) | None: the rows; a column: its values that are not null | An integer |
| Distinct count (`count_distinct`) | An orderable column | An integer |
| Sum (`sum`) | A number column | Exact for integers and decimals; a float for floats |
| Average (`avg`) | A number column | A float, from the exact sum |
| Standard deviation (`stddev`) | A number column | A float: the sample standard deviation |
| Minimum, Maximum (`min`, `max`) | An orderable column: numbers, text, booleans, dates and times, UUIDs | The column's type, shown with its format |
| Quantile (`quantile`) | A number column, with `p` from 0 to 1 | A float, interpolated between the two closest values |

Quantile is set from code; the Group menu offers the others.

- Measures leave out nulls. Measures of floats other than the counts also leave out NaN and the infinities.
- Over no values, the counts are 0 and the other measures are null.
- Each distinct combination of keys is a group. Null and the empty string are two different groups, and all NaNs
  are one.
- Without a sort, groups are in the order of their keys, ascending, with the empty string before null.

The rules are in [§3.8](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#38-aggregates) and
[§3.9](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#39-groups) of the specification, and the same
in every engine.

## Pivots

A pivot makes a cross tabulation: after the keys, one column for each combination of the values of the pivot
columns, and in it each measure. With `region` as the key, `city` and `year` as the pivot columns and a `sales`
measure, the columns are `region`, `Tokyo / 2024 / sales`, `Tokyo / 2025 / sales` and so on. Null is written
`(null)` and the empty string `(empty)`. Cells without rows are 0 for counts and null for the other measures.

A pivot makes at most `maxColumns` columns: 200 by default, up to 1,000. A plan that would make more fails with
`too_many_columns` rather than being cut; the grid keeps the view before on screen and the status bar says why.
Since the pivot's columns come from the data, its sort and `having` may use only the keys.

## Conditions on groups

`having` keeps the groups for which a condition is true, as `where` keeps rows: for example the regions with at
least ten orders. It is set from code with `having.set`, only on a grouped view, and uses the keys and measures by
their names.

## The totals row

"Total…" in a column's menu picks a measure of the column for a row at the bottom of the grid: Sum, Average,
Count, Distinct count, Minimum or Maximum, those that fit the column's type, or "No total". The row stays in view
while the rows scroll, and the menu item then shows the measure ("Total: Sum").

Totals are computed over every row of the view (its filters and search, not the selection), again whenever the
view or its written cells change. They are kept in the document's column settings, and read into the snapshot's
`totals`. A grouped view shows no totals row.

## From code

The menus dispatch commands, which an app can dispatch too:

```ts
await store.dispatch({
  command: "group.set",
  aggregate: {
    keys: ["region"],
    measures: [
      { name: "orders", fn: "count" },
      { name: "sales", fn: "sum", column: "total" },
      { name: "median price", fn: "quantile", column: "price", p: 0.5 },
    ],
  },
});
await store.dispatch({ command: "having.set", having: { fn: "ge", args: [{ col: "orders" }, { lit: 10 }] } });
await store.dispatch({ command: "column.total", name: "total", total: { fn: "sum" } });
await store.dispatch({ command: "group.clear" });
```

| Command | Arguments |
| --- | --- |
| `group.set` | `aggregate`: `keys`, `measures` (`{ name, fn, column?, p? }`) and `pivot` (`{ columns, maxColumns? }`) |
| `group.clear` | None: shows the rows again |
| `having.set` | `having`: a condition, or null |
| `column.total` | `name`, and `total`: `{ fn, p? }` or null |

A grid can also start grouped, from a document whose plan has the aggregate ([State](/guides/state/)):

```ts
import type { GridDocument } from "vastgrid";

const byCategory: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: {
    aggregate: { keys: ["category"], measures: [{ name: "sales", fn: "sum", column: "total" }] },
    sort: [{ column: "sales", direction: "desc" }],
  },
};
```
