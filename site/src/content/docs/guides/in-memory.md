---
title: Data in memory
description: Show rows that are already in JavaScript, or an Arrow table, with the memory engine of vastgrid-js.
---

`vastgrid-js` is the memory engine. It answers the grid's messages over tables that are already in memory:
sorts, filters, groups, pivots, the totals row, find and exports all run in JavaScript, in the page or in a Web
Worker. Nothing goes to a server.

```bash
npm install vastgrid vastgrid-js
```

```tsx
import { DataGrid, localTransport } from "vastgrid";
import { memoryEngine } from "vastgrid-js";
import "vastgrid/styles.css";

const engine = memoryEngine({
  tables: {
    orders: {
      columns: [
        { name: "id", type: "bigint" },
        { name: "customer", type: "string" },
        { name: "ordered_at", type: "timestamp" },
        { name: "total", type: "decimal", precision: 12, scale: 2 },
        { name: "paid", type: "boolean" },
      ],
      rows: [
        [1, "Ada Lovelace", "2026-01-31 09:30:00", "120.50", true],
        [2, "Alan Turing", "2026-02-01 14:05:00", "8.00", false],
      ],
      editable: true,
    },
  },
});
const transport = localTransport(engine);

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

`memoryEngine({ tables })` takes the tables by the name that the grid's `table` prop gives. `localTransport`
carries the grid's messages to an engine in the same thread, as function calls.

## Columns and values

A column is `{ name, type }` with the members of its type
([§2.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#21-logical-types)), and optionally
`sourceType` (a type name to show, such as `DECIMAL(12,2)`) and `readOnly`. A row is an array with one value per
column, written as typed JSON
([§2.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#22-values-in-json)); `null` is no value.

| Type | Members | A value in `rows` |
| --- | --- | --- |
| `boolean` | | `true` |
| `integer` | | `42` (32-bit) |
| `bigint` | | `42`, or `"9223372036854775807"` beyond 2^53 − 1 |
| `decimal` | `precision`, `scale` | `"12.50"`: a string with exactly `scale` digits after the point |
| `float` | `bits` (32 or 64) | `0.1`, or `"NaN"`, `"Infinity"`, `"-Infinity"` |
| `string` | | `"Tokyo"` |
| `date` | | `"2026-01-31"` |
| `time` | | `"12:30:00"`, `"01:02:03.25"` |
| `timestamp` | `unit` (`s`, `ms`, `us`, `ns`) | `"2026-01-31 12:30:00.5"` |
| `timestamptz` | | `"2026-01-31 03:00:00+00"`, in UTC |
| `interval` | | `"01:30:00"`, `"1 year 2 months"` |
| `uuid` | | lowercase hex, `8-4-4-4-12` |
| `binary` | | base64 |

- **The rows are not copied.** The engine reads your arrays as they are, so they must not change afterwards.
  Opening a table of a million rows takes about 4 ms; values are checked when a request first reads them.
- A table that does not follow §2 fails to open with `load_failed` and the JSON Pointer of the value at fault.
- A `float` with `bits: 32` must already be a 32-bit number (`Math.fround(0.1)`, not `0.1`).

## Arrow tables

A table may be the bytes of an Arrow IPC stream or file, with any number of record batches, as `tableToIPC` of
Flechette or Apache Arrow writes them:

```ts
const response = await fetch("/orders.arrow");
const engine = memoryEngine({
  tables: { orders: { arrow: new Uint8Array(await response.arrayBuffer()) } },
});
```

The columns take the logical types of their Arrow types. The engine keeps the columns as Arrow holds them,
without a copy: numbers, dates and times as typed arrays, which sorts read directly. A million rows of integers,
floats, dates, decimals, timestamps and strings take 258 MB as Arrow against 494 MB as rows, and sort by a date,
a decimal or a timestamp in 50–70 ms against 170–250 ms (figures from the
[engine's README](https://github.com/yhay81/vastgrid/blob/main/packages/js/README.md)). Arrow types with no
logical type (lists, structs) and two columns with one name fail with `load_failed`.

## Editing

`editable: true` lets the grid write the table's cells ([Editing](/guides/editing/)). Written values are kept
apart from your rows, which stay as you gave them, and every later sort, filter and export sees them. The memory
engine does not save: written cells last as long as the engine, and an export keeps them.

## What the engine offers

The engine reports what it evaluates as capabilities
([§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#410-capabilities)), and the grid offers
only those. `MEMORY_CAPABILITIES` of `vastgrid-js` holds them:

| Capability | The memory engine |
| --- | --- |
| `plan` | every member: `derive`, `where`, `aggregate`, `pivot`, `having`, `sort`, `search` |
| `functions`, `measures` | every function and measure of the specification |
| `summarize`, `find`, `locate` | yes |
| `write` | for tables with `editable: true` |
| `save` | no |
| `export` | CSV, TSV, JSON and xlsx, as `data`: the bytes come back and the grid downloads them |
| `preview`, `partialViews` | no |
| `changes` | `"poll"`: the engine sends no events |

## How large

Measured on 2026-10-24 on an Apple M2 Pro in Chromium 156, with a table of 1,000,000 rows and 8 columns
([react.md, Appendix A.2](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#a2-in-the-browser)):

| | Engine in the page | Engine in a Web Worker |
| --- | ---: | ---: |
| From mount to the first rows on screen | 43–49 ms | 36–49 ms |
| Sort by a float until the sorted rows show | 85–98 ms | 112–113 ms |
| The page's longest task meanwhile | 81–93 ms | none |
| JavaScript heap of the page | 202 MB | 10 MB |

In the page, a million rows are fine, but each sort holds the page for about a tenth of a second and the table
lives in the page's heap. For larger tables, or to keep the page free while it sorts, run the engine in a Web
Worker ([Large files in the browser](/guides/browser/)). Data that does not fit in a tab belongs on a server
([Files on a server](/guides/server/)).

## When the data changes

The engine never sees changes to the rows you gave it. To show new data, make a new engine and a new transport
for it. A new transport, or a new `table`, makes the grid build a new store, which opens the table afresh.

Make the transport once per data, not on every render: outside the component, or with `useMemo`. The document
(sorts, filters, groups, column widths and formats) belongs to the store, so keep it outside to carry it over:

```tsx
import { useMemo, useState } from "react";
import { DataGrid, type GridDocument, localTransport } from "vastgrid";
import { type MemoryTable, memoryEngine } from "vastgrid-js";

export function Orders({ orders }: { orders: MemoryTable }) {
  const transport = useMemo(() => localTransport(memoryEngine({ tables: { orders } })), [orders]);
  const [doc, setDoc] = useState<GridDocument>();
  return (
    <DataGrid
      transport={transport}
      table="orders"
      defaultDocument={doc}
      onDocumentChange={setDoc}
      style={{ height: 480 }}
    />
  );
}
```

Each new store starts from the last document. A document names its columns, and is repaired for the new table
([§5.5](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#55-repairing-a-document-for-a-table)): a
sort or filter on a column that is gone is dropped. To hold the document in your own state all the time (to put
it in the URL, say), control it with `document` and `onDocumentChange` instead ([State](/guides/state/)).

## The demo's table

The table of the [demo](/demo/) is made this way:
[site/src/data/orders.ts](https://github.com/yhay81/vastgrid/blob/main/site/src/data/orders.ts) generates rows of
typed JSON for 13 columns (integers, a timestamp, strings, decimals and a boolean) and gives them to
`memoryEngine`.
