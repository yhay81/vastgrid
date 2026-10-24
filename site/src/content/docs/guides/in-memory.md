---
title: Data in memory
description: Show rows that are already in the browser with ArraySource.
---

`ArraySource` is a `TableSource` over JavaScript arrays. It does everything the grid asks for: sorting,
filters, search, find, column statistics, value lists and the summary of the selection. It also
exports CSV, TSV, JSON and Excel files, which the grid's export panel downloads (see
[Exporting](/guides/export/)).

```tsx
import { ArraySource, DataGrid } from "vastgrid";
import "vastgrid/styles.css";

const source = new ArraySource({
  columns: ["name", "born", "field"],
  rows: [
    ["Ada Lovelace", 1815, "Mathematics"],
    ["Grace Hopper", 1906, "Computer science"],
  ],
});

<div style={{ height: 400 }}>
  <DataGrid source={source} />
</div>;
```

## Rows or columns

Give the data row by row in `rows`, or column by column in `columnData`, one array per column:

```ts
const source = new ArraySource({
  columns: ["name", "born", "field"],
  columnData: [
    ["Ada Lovelace", "Grace Hopper"],
    [1815, 1906],
    ["Mathematics", "Computer science"],
  ],
});
```

`columnData` is used as it is, without a copy, so it is the cheaper choice for large tables. Missing
values at the end of a short row or column are blank.

## Values and types

A value is a `CellValue`: `string | number | boolean | null`. `null` is a blank cell.

With column names only, `ArraySource` infers each column's type from its first 10,000 values: `integer`,
`float`, `boolean`, or `string` for everything else. Give a `ColumnSchema` to set the type yourself:

```ts
const source = new ArraySource({
  columns: [
    { name: "order_id", type: "integer" },
    { name: "ordered_at", type: "timestamp" },
    { name: "total", type: "decimal", sourceType: "DECIMAL(12,2)" },
    { name: "paid", type: "boolean" },
  ],
  rows: [[100001, "2024-01-01 09:12:44", "19800.00", true]],
});
```

The type decides how values are aligned, formatted, sorted and summed:

- **Numbers** (`integer`, `bigint`, `float`, `decimal`) are right-aligned, grouped by the locale and
  summed in the selection. Give values that a JavaScript number cannot hold exactly, such as 64-bit
  integers beyond 2^53 or decimals that must keep their digits, as strings: `"9007199254740993"`,
  `"19800.00"`. They sort and filter by their exact value.
- **Dates and times** (`date`, `time`, `timestamp`, `timestamptz`) are strings in ISO form
  (`2024-01-31`, `2024-01-31 12:34:56`), which sort correctly as text.
- **Booleans** show as `TRUE` and `FALSE`.
- The `sourceType` is shown in the column's statistics, as the engine's own name for the type.

The demo's [table of orders](https://github.com/yhay81/vastgrid/blob/main/site/src/data/orders.ts) uses
each of these.

## How large

`ArraySource` sorts, filters and computes statistics on the main thread, and the page does not respond
while it does. It suits up to a few hundred thousand rows. A table of 300,000 rows and 13 columns, on an
Apple M2 Pro in Node.js 24:

| Operation | Time |
| --- | ---: |
| Sort by a decimal column | 0.55 s |
| Sort by a text column | 0.15 s |
| Search all columns | 0.13 s |
| Column statistics | 0.15 s |

Scrolling and selecting cost the same at any size: the grid reads only the rows on screen. For more rows,
serve files with [`vastgrid-duckdb`](/guides/server/), or move the work into a worker with a
[`TableSource` of your own](/guides/custom-source/).

## When the data changes

A source is a snapshot. When the data changes, create a new `ArraySource`; the grid starts again with
it, so the selection, sort and filters are reset. To keep the sort and filters, save the query and apply
it to the new grid:

```tsx
const grid = useRef<DataGridHandle>(null);
const query = useRef<ViewQuery>({});
const source = useMemo(() => new ArraySource({ columns, rows }), [rows]);

useEffect(() => {
  grid.current?.setQuery(query.current);
}, [source]);

<DataGrid ref={grid} source={source} onQueryChange={(next) => (query.current = next)} />;
```
