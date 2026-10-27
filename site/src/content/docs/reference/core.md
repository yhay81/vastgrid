---
title: vastgrid/core and vastgrid/server
description: The grid's store, transports and errors, which run without React, and readInitialView for server rendering.
---

`vastgrid/core` is the grid without React: the store that holds its state, the client of the messages and the
transports that carry them to an engine. It runs in browsers, Web Workers and servers. `vastgrid/server` reads
the first rows of a table on a server, for server rendering. React code imports the same names from `vastgrid`,
which re-exports `vastgrid/core`; workers and servers import from `vastgrid/core`.
[§4 of the React specification](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#4-the-store) is
the source of this page.

## The store

```ts
import { createGridStore, httpTransport } from "vastgrid/core";

const store = createGridStore({ transport: httpTransport("/api", { events: "/api/events" }), table: "orders.csv" });
const disconnect = store.connect();
```

`createGridStore(options)` gives a `GridStore` (also exported as a class, `new GridStore(options)`). `DataGrid`
makes one when it is not given one.

### `GridStoreOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `transport` | `Transport` | (required) | Where the engine is. |
| `table` | `string` | (required) | The `ref` of the table to open (§8.2). |
| `open` | `OpenOptions` | | The `read` options of `open`: `sheet`, `headerRow`, `keepEmptyRows`, `keepEmptyColumns`. |
| `document` | `GridDocument` | the empty document | The document to start with ([§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#51-document)). |
| `session` | `GridSession` | the empty session | The session to start with ([§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#52-session)). |
| `initial` | `InitialView` | | Rows read on a server (`readInitialView`), shown before the first read. |
| `cacheBytes` | `number` | `CACHE_BYTES` (64 MiB) | Bytes of rows to keep. |

### Lifecycle

- Making a store has no side effects: it opens nothing, starts no timer and subscribes to nothing.
- `connect()` opens the table (`open`), follows the engine's events and reads the view of the document's plan. The
  function it returns undoes all of it and closes the table. A store connects again after it disconnects, as
  React's Strict Mode does in development.
- A disconnected store keeps its last snapshot and reads nothing.

### Methods

| Method | Description |
| --- | --- |
| `getSnapshot()` | The state now, a `GridSnapshot`. The same object until the state changes. |
| `subscribe(listener)` | Calls `listener` when the snapshot changes. Returns the function that stops. |
| `on(event, listener)` | Follows `"document"` and `"session"` changes (reported also when they are controlled) and `"error"`s. Returns the function that stops. |
| `connect()` | Opens the table and starts reading. Returns the function that disconnects. |
| `dispatch(command, options?)` | Applies a command ([Commands](/reference/commands/)). Resolves to a `CommandOutcome` and never rejects. The same function for the life of the store. |
| `dispatchSync(command, options?)` | Applies a command at once, as a `copy` event needs. A command that needs rows that are not read fails with `not_loaded`, and its requests are sent. |
| `control(part, controlled)` | Makes `"document"` or `"session"` controlled: commands report what they make of it, and only `setDocument` or `setSession` show it. |
| `setDocument(document)`, `setSession(session)` | Shows a document or a session given by the host: a controlled prop, a saved view, an agent. |
| `cell(row, column)` | The value of a cell of the view on screen; `undefined` while it is not read. |
| `isCut(row, column)` | Whether the engine cut a cell's text to its limit (§8.4). |
| `fullValue(row, column, signal?)` | The whole value of a cell, also when its text was cut, and its column: `{ value, column }`. |
| `rowKey(row)`, `rowId(row)` | The key (§5.3) and the row ID of a row of the view on screen. |
| `getRowsVersion()`, `subscribeRows(listener)` | A number that changes when rows of the view on screen arrive or leave, and the way to follow it. Rows are not in snapshots. |
| `setViewport({ top, rows, columns })` | Tells the store what is on screen, so that it reads those rows and a page around them. |
| `ensure(start, end, columns)` | Reads rows `[start, end)` of `columns` if they are not read. |
| `summarize(ranges, columns, signal?)` | Counts and sums cells of ranges of rows: `{ count, numericCount, sum, min, max, average }`. |
| `values(column, { search?, limit? }?, signal?)` | A column's values with how many rows have each, the most common first, at most `limit` (1,000): `{ values: { value, count }[], truncated }`. |
| `aggregate(measures, signal?)` | Measures (§4.5) over the rows of the document's plan: `{ values, columns }`. Fails with `invalid_plan` for a plan that groups rows. |
| `find(text, { from, direction?, caseSensitive? }, signal?)` | The next cell after `from` (before it with `direction` −1) whose text contains `text`, in the displayed columns, wrapping around: `{ row, column }` or null. |
| `retryWrite()` | Sends the last write that failed (`failedWrite`) again; after an `edit_conflict`, over what the cells hold now. |
| `discardWrite()` | Forgets the failed write: its cells show what the engine holds. |
| `reload()` | Reads the table's file as it is now, for a file that changed on disk while it had written cells (`fileChanged`). |
| `exportUrl(target)` | Where the file of an export without a target is downloaded, from the transport, or null. |
| `exportName(format)` | A file name for an export answered as data: the table's name with the format's extension. |

## Snapshots

```ts
interface GridSnapshot {
  document: GridDocument; // §5.1
  session: GridSession; // §5.2
  table: TableInfo | null; // null until the table is open
  view: ViewInfo | null; // the view on screen
  displayed: DisplayedColumn[]; // the columns on screen, in order
  pending: { plan: Plan } | null; // a plan whose view is read to replace the one on screen
  status: "idle" | "opening" | "ready" | "error";
  error: GridError | null;
  failedWrite: FailedWrite | null; // the last write that failed
  totals: { values: Record<string, JsonValue>; columns: Record<string, Column> } | null; // the totals row
}
```

- A snapshot never changes. A command keeps every member of the document and the session that it does not change,
  so selectors stay cheap: moving the active cell gives a new session with the same `document`, `checked` and
  `history`.
- `TableInfo` is the answer of `open`: `table` (the handle), `revision`, `status` (`loading`, `ready`, `error`),
  `progress`, `rowCount` (null while unknown), `readableRows`, `columns`, `capabilities`
  ([Engines](/reference/engines/#capabilities)), and when they apply `format`, `byteSize`, `notes`, `sheets`,
  `sheet`, `error` and `fileChanged`.
- `ViewInfo` is a view's `hash`, `status` (`building`, `ready`), `rowCount`, `rowCountExact`, `readableRows`,
  `columns` and `edits`.
- `FailedWrite` holds the `command`, the `updates`, the `error` and `retry`: `"retry"`, `"overwrite"` (after an
  `edit_conflict`) or null.

## Dispatching

```ts
const outcome = await store.dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
if (!outcome.ok) console.warn(outcome.error.code, outcome.error.message);
```

1. The snapshot changes at once and subscribers are told, so that a key press shows in the same frame.
2. The requests that the command gives are sent. The core's own commands
   ([§6.7](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#67-commands-of-the-core)) are applied as
   their answers arrive.
3. When the plan changed, the store reads the new view while the old one stays on screen with `pending` set, then
   shows the new rows in one step. A newer plan cancels the reads of an older one.
4. A command that fails with `not_loaded` reads the rows it names and is applied again.

| Type | Definition |
| --- | --- |
| `DispatchOptions` | `{ clipboard?: { text?: string; html?: string } }`: what `edit.paste` pastes. |
| `CommandOutcome` | `{ ok: true; output?: unknown }` or `{ ok: false; error: CommandError \| GridError }`. A command that fails changes nothing. |

`copy` gives `{ tsv, html, markdown }` as its output, and `edit.paste` gives `{ cutRows, cutColumns }`
(`CommandOutputs` of `vastgrid-spec`). Failures that belong to no command (a read that fails, a table that cannot
be read) go to `snapshot.error` and to `on("error")`.

## Errors

`GridError` is an `Error` with a `code`, and when they apply a `reason`, a `path` (a JSON Pointer), `details` and
the `op` of the request. A command that cannot be applied fails with a `CommandError` of `vastgrid-spec` instead,
whose `code` is `invalid_command` ([Commands](/reference/commands/#when-a-command-fails)).

| `code` | When | HTTP |
| --- | --- | ---: |
| `invalid_request` | a message that does not follow §8, with `path` and `reason` | 400 |
| `invalid_plan` | a plan that does not check (§4.7), with `path` and `reason` | 400 |
| `table_not_found` | the table is closed or unknown | 404 |
| `not_ready` | the table is still loading and the request needs all of it | 409 |
| `revision_changed` | the table changed since the request's revision | 409 |
| `edit_conflict` | a cell no longer holds the value a write expected | 409 |
| `file_changed` | the file changed on disk since it was read | 409 |
| `read_only` | a write to a cell that cannot be written | 403 |
| `not_allowed` | a `ref` or `target` outside what the host allows | 403 |
| `invalid_value` | a value that does not fit its column, or one a block cannot hold | 422 |
| `too_many_columns` | a pivot with too many columns (§4.6) | 422 |
| `save_unsupported` | the engine cannot save this table | 422 |
| `load_failed` | the table could not be read | 422 |
| `export_too_large` | a result that does not fit the format (Excel: 1,048,575 rows, 16,384 columns) | 413 |
| `cancelled` | the request was cancelled | 499 |
| `internal` | anything else | 500 |

[§8.7](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#87-errors) is the list; `ERROR_STATUS` of
`vastgrid-spec` maps the codes to the HTTP statuses.

## Transports

A transport carries the messages of [§8](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#8-messages)
to an engine. Blocks of rows travel as bytes (the structured encoding) or, over HTTP, attached after the JSON.

| Transport | Engine |
| --- | --- |
| `localTransport(engine)` | In the same thread, such as the memory engine of `vastgrid-js`. |
| `workerTransport(worker)` | In a Web Worker where `serveEngine(engine, self)` answers, or behind anything that carries messages as a worker does (`WorkerLike`: a `MessagePort`, a VS Code webview, a notebook widget). Buffers are transferred. Its `close()` stops listening. |
| `httpTransport(url, options?)` | On a server, such as `createHttpHandler` of `vastgrid-duckdb`. Each request is a `POST`, and `rows` and `export` come back with their blocks attached. Aborting a request aborts its HTTP request. |
| `serverFunctionTransport(action)` | Behind a `"use server"` function that passes each request to an engine. The function must check the request (`checkRequest` of `vastgrid-spec`). |

```ts
// worker.ts
import { serveEngine } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

serveEngine(memoryEngine({ tables: { people: { columns, rows } } }), self);
```

```ts
// main.ts
import { workerTransport } from "vastgrid/core";

const transport = workerTransport(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
```

### `HttpTransportOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `fetch` | `typeof fetch` | the global `fetch` | The function that sends requests. |
| `headers` | `Record<string, string>` | | Headers sent with every request, such as an authorization. |
| `events` | `string` | | The URL of the Server-Sent Events that carry the engine's events. Without it, the grid does not hear of writes made by others. Requests wait until the stream is open (or fails), so that no event of a table the grid opens is missed. |
| `exports` | `string` | `<url>/exports/` | The URL under which exports without a target are downloaded. |

### `Transport` and `Engine`

A host with a channel of its own implements `Transport`: the MCP App sends each request as a call of its tool.

```ts
interface Transport {
  send(request: RequestMessage, options: { signal?: AbortSignal }): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
  cancels?: "message" | "signal"; // how a request is cancelled: a `cancel` message (default) or the signal
  exportUrl?(target: string): string;
}

interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}
```

`RequestMessage` is `{ v: 2, id, op, … }` (§8.1). [Engines](/reference/engines/) describes the two that come with
vastgrid, and [Your own engine](/guides/custom-engine/) how to write one.

### `GridClient` and `RequestIds`

- `new GridClient(transport)` sends requests with ids of its own and checks every response and event
  (`checkResponse`, `checkEvent`): `request(op, members, signal?)` resolves to the result or rejects with a
  `GridError`, and sends `cancel` when the signal aborts. The store uses one; a host rarely needs it.
- `new RequestIds(engine).client()` gives each of several clients of one engine a `Handler` whose request ids
  are unique in the engine, and gives the answers their own ids back, so that one client's `cancel` never stops
  another's request. The MCP App and the VS Code extension serve several grids from one engine this way.

### Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `BLOCK_ROWS` | `256` | Rows in a block that the store reads and keeps. |
| `CACHE_BYTES` | `64 * 1024 * 1024` | The bytes of rows a store keeps by default (`cacheBytes`). |

## `vastgrid/server`

`readInitialView(transport, options)` opens a table, reads the view of the document's plan and its first rows, and
closes the table. Its result is an `InitialView`: `{ table, plan, rows }`, with the block of rows as a
`Uint8Array`, which Server Components pass to client components. Given to `DataGrid` as `initial`, or to the store, the first frame draws
these rows; given as a promise, the page streams and the grid suspends until it resolves. It imports no React.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `table` | `string` | (required) | The `ref` of the table to open. |
| `open` | `OpenOptions` | | The `read` options of `open`. |
| `document` | `GridDocument` | the empty document | The document the grid starts with; its plan is the view read. |
| `rows` | `number` | `100` | The rows to read. |
| `signal` | `AbortSignal` | | Cancels the reads. |

```tsx
// app/orders/page.tsx, a Server Component
import { httpTransport } from "vastgrid/core";
import { readInitialView } from "vastgrid/server";
import { OrdersGrid } from "./orders-grid"; // a client component that renders <DataGrid initial={initial} … />

export default function Page() {
  const initial = readInitialView(httpTransport("http://localhost:8080/api"), { table: "orders.csv" });
  return <OrdersGrid initial={initial} />;
}
```

See [Files on a server](/guides/server/) and
[§7 of the React specification](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#7-server-rendering-and-server-components).

## A store without React

The store is the whole grid but the screen: commands, selection, undo, writes and exports all work in it. The MCP
App keeps each grid as such a store on its server, applies the agent's commands to it, and reads the state back
for the agent:

```ts
import { createGridStore, GridError, type GridSnapshot, type GridStore, localTransport } from "vastgrid/core";
import { DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });
const store = createGridStore({ transport: localTransport(engine), table: "orders.csv" });
const disconnect = store.connect();

// Waits until the table is open and the view of the document is on screen.
function settled(store: GridStore): Promise<GridSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === "error") {
        reject(snapshot.error ?? new GridError("load_failed", snapshot.table?.error ?? "The table could not be read."));
      } else if (snapshot.status === "ready" && snapshot.view && !snapshot.pending) {
        resolve(snapshot);
      } else {
        return;
      }
      stop();
    };
    const stop = store.subscribe(check);
    check();
  });
}

await settled(store);
await store.dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
await settled(store);
store.ensure(0, 20, ["id", "total"]);
```

Rows arrive after `ensure`; `subscribeRows` tells when, and `cell(row, column)` reads them. `disconnect()` closes
the table; `engine.dispose()` closes the engine.
