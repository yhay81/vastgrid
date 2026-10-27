---
title: State and your own controls
description: Save and restore the view as a JSON document, control it from React, and drive the grid with commands from your own buttons.
---

Everything a grid shows comes from two pieces of plain JSON, and every change to them is a command. Your app
keeps the JSON where it likes, and dispatches the same commands as the grid's menus and keys.

- The **document** is the view: the plan (derived columns, conditions, groups, sort) and the column settings
  (width, hidden, pin, format, total), with `rowKey`. It is what a person saves, shares or gives an agent.
- The **session** is where the person is: the active cell, the selection, the scroll position, the checked rows,
  the detail panel, an open editor and the undo history.

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "plan": {
    "where": { "fn": "eq", "args": [{ "col": "region" }, { "lit": "EU" }] },
    "sort": [{ "column": "total", "direction": "desc" }]
  },
  "columns": [{ "name": "id", "pin": "left" }, { "name": "total", "width": 120, "total": { "fn": "sum" } }]
}
```

[§5 of the specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#5-state) has every member;
`GridDocument` and `GridSession` are their types, exported by `vastgrid`.

## Keep the view

Give the grid a document to start with, and save the one it reports:

```tsx
import { DataGrid, type GridDocument } from "vastgrid";

function load(): GridDocument | undefined {
  const text = localStorage.getItem("orders-view");
  return text ? (JSON.parse(text) as GridDocument) : undefined;
}

export function Orders() {
  return (
    <DataGrid
      transport={transport}
      table="orders"
      defaultDocument={load()}
      onDocumentChange={(document) => localStorage.setItem("orders-view", JSON.stringify(document))}
    />
  );
}
```

`defaultDocument` is read when the grid makes its store; the grid then keeps the document itself and calls
`onDocumentChange` after each change. A document saved for a table whose columns have changed since is repaired
when it is opened: conditions, groups, sort keys and derived columns that no longer fit the table are removed,
and the rest is kept
([§5.5](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#55-repairing-a-document-for-a-table)).

A document is version 2. A saved state of vastgrid 0.1 is not read as it is: `migrateGridState` of
`vastgrid-spec` turns it into a document ([Migrating from v1](/migrating-from-v1/)).

## Control the view

With `document`, the grid shows the prop. A command reports the document it would make to `onDocumentChange`,
and the grid shows it once you pass it back:

```tsx
const [document, setDocument] = useState<GridDocument>(initial);

<DataGrid transport={transport} table="orders" document={document} onDocumentChange={setDocument} />;
```

- Pass back something else to change the view from outside: a saved view, a view from a link, a view an agent
  made. Pass back nothing, and the command does not take effect.
- Two commands in one event both take effect: the second applies to the document the first reported.
- `session`, `defaultSession` and `onSessionChange` work the same way. `onSessionChange` is called on every move
  of the active cell, so a parent that keeps the session in state should render little with it, or read it
  through `useDeferredValue`.

## Your own controls

`useCreateGridStore` makes a store for the life of a component. Give it to the grid with `store` and to your own
components with `GridProvider`; inside it, `useGridSelector` reads the state and `useGridDispatch` changes it:

```tsx
import { DataGrid, GridProvider, useCreateGridStore, useGridDispatch, useGridSelector } from "vastgrid";

function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <ClearSort />
      <DataGrid store={store} toolbar={false} />
    </GridProvider>
  );
}

function ClearSort() {
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const dispatch = useGridDispatch();
  return (
    <button type="button" disabled={!sort} onClick={() => dispatch({ command: "sort.clear" })}>
      Clear sort
    </button>
  );
}
```

A command is an object with its name and its arguments, checked by TypeScript:

```ts
dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
dispatch({ command: "filter.column", column: "region", where: { fn: "eq", args: [{ col: "region" }, { lit: "EU" }] } });
dispatch({ command: "column.pin", name: "id", side: "left" });
dispatch({ command: "select", row: 0, column: "total" });
```

`dispatch` changes the state at once, sends what the command needs to the engine, and resolves to
`{ ok: true, output }` or `{ ok: false, error }`. It never rejects, and a command that fails changes nothing.
[Commands](/reference/commands/) lists every command.

The grid's own components, and components you render inside `DataGrid` (a detail panel), read the same store
without a provider. Outside, `ref` gives the handle: `{ store, dispatch, focus }`.

### What a snapshot holds

`useGridSelector(selector)` runs `selector` on the store's snapshot, which is never changed in place:

| Member | Holds |
| --- | --- |
| `document`, `session` | the state above |
| `table` | the open table: its id, columns, row count, revision, whether it is still loading, and the engine's capabilities; null until it opens |
| `view` | the view on screen: its row count, whether it is exact, its columns, and `status` `"building"` or `"ready"` |
| `displayed` | the displayed columns in order, with their settings |
| `pending` | a plan whose view is being read, while the old view stays on screen |
| `status` | `"idle"`, `"opening"`, `"ready"` or `"error"` |
| `error`, `failedWrite` | the last failure that belongs to no command, and the last write that failed |
| `totals` | the totals row's values, or null |

A selector should be cheap and should not make a new object, unless you pass an `isEqual` that compares it:
`useGridSelector((snapshot) => [snapshot.status, snapshot.view?.rowCount], shallowEqual)`. Rows are not in the
snapshot; `useGridRows` reads them ([Charts](/guides/charts/) uses it).

## Without React

`vastgrid/core` has the store with no React: for a host in another framework, a test, or a server.

```ts
import { createGridStore } from "vastgrid/core";

const store = createGridStore({ transport, table: "orders" });
const disconnect = store.connect(); // opens the table and reads the view
const stop = store.subscribe(() => console.log(store.getSnapshot().view?.rowCount));

const outcome = await store.dispatch({ command: "search.set", text: "Tokyo" });

stop();
disconnect(); // closes the table
```

Making a store opens nothing; `connect` does, and the function it returns closes the table again.
`setDocument` and `setSession` show a state given from outside. [vastgrid/core](/reference/core/) has the rest of
the store.
