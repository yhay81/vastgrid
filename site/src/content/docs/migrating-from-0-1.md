---
title: Migrating from 0.1
description: What changed from vastgrid 0.x (0.1) to vastgrid 0.2, and where the full migration guide is.
---

vastgrid 0.2 is a rebuild of the grid on a written specification. Most of 0.1's features are in it, with another
API. This page lists what changed; [the full migration guide](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md)
on GitHub maps each of 0.1's features to 0.2 and gives the breaking changes in detail.

## Packages

| 0.1 | vastgrid 0.2 |
| --- | --- |
| `vastgrid` (React 18 or later) | `vastgrid`, which needs React 19.3 or later; `vastgrid/core` has the store and transports without React |
| `vastgrid-core` | gone: its parts are in `vastgrid/core` and `vastgrid-spec` |
| 0.1's in-memory source | `memoryEngine` of [`vastgrid-js`](/guides/in-memory/) |
| `vastgrid-browser` | gone: `vastgrid-js` reads files and Parquet URLs, in a [Web Worker](/guides/browser/) |
| `vastgrid-duckdb`: `TableEngine`, `createTableHandler` | `vastgrid-duckdb`: `DuckDBEngine`, `createHttpHandler` (see [Files on a server](/guides/server/)) |

## The grid takes a transport

0.1's grid took a source object in its `source` prop. 0.2's takes a transport to an engine and the name of a
table, or a store made with `useCreateGridStore`:

```tsx
import { DataGrid, localTransport } from "vastgrid";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders: { columns, rows } } }));

<DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
```

Columns have the logical types of the specification and values are typed JSON: decimals and large integers are
strings that keep their digits. 0.1's remote source and its table server become `httpTransport` and the DuckDB
engine's HTTP handler, which speak 0.2's messages.

## State is a document, a session and commands

What 0.1 kept in its controller and gave through the ref's methods and its events is now plain JSON: the
**document** (the view and its columns: sorts, filters, groups, formulas, widths, pins, formats) and the
**session** (the selection, the scroll position, checked rows, the undo history). Both can be controlled with
`document` and `onDocumentChange`, `session` and `onSessionChange`. Every change is a typed command, which your
code dispatches as the grid's menus do. The ref gives only `{ store, dispatch, focus }`. See
[The document, the session and commands](/guides/state/).

0.1's saved `GridState` migrates into a document with `migrateGridState` of `vastgrid-spec`, given the table's
columns:

```ts
import { migrateGridState } from "vastgrid-spec";

// columns: the table's columns, as the engine reports them (snapshot.table.columns once it is open)
const { document, dropped, reasons } = migrateGridState(savedState, columns);
// <DataGrid … defaultDocument={document} />
```

`dropped` lists the JSON Pointers, into the 0.1 state, of what could not be migrated, and `reasons` says why.
Columns frozen at either side become `pin: "left"` and `pin: "right"`, and groups become the plan's `aggregate`
([§5.6 of the specification](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#56-versions-and-migration)).

## Formulas

0.1's formula language compiles in 0.2, with every function of 0.1, and formulas become derived columns of the plan.
0.1 computed every number as a 64-bit float; 0.2 keeps decimals exact and writes values in DuckDB's text forms, so a
few formulas give other results (`ROUND(0.285, 2)` is `0.29`, not `0.28`). [Formula columns](/guides/formulas/)
and [§4.11](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#411-formulas) list them.

## Not in 0.2

- A tree of rows, which 0.1 did not have either: data whose hierarchy is in columns is grouped by several keys.
- Resizing several columns at once: each column is resized, or fitted to its values from its menu.

[The full migration guide](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md) has every feature,
the breaking changes, and what to do for each.
