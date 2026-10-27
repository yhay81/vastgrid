---
title: Your own engine
description: Answer the grid's messages from your own data store, offering as much of the specification as it can do, and test it against the conformance corpus.
---

The grid never reads data itself. It sends messages to an engine and draws what comes back. `vastgrid-js` and
`vastgrid-duckdb` are two engines; when your data lives elsewhere (another database, a search index, an API),
write your own.

## What an engine is

An engine is any object with a `handle(message)` method that answers the messages of the specification, and
optionally `subscribe(listener)` for its events. That is the `Engine` interface of `vastgrid/core`:

```ts
interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}
```

A transport carries the messages to it: `localTransport(engine)` in the same thread, `serveEngine` and
`workerTransport` across a Web Worker, an HTTP handler and `httpTransport` across a network. The engine is the same
in each.

## The messages

[§8 of the specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#8-messages) defines them:

| Part | What it says |
| --- | --- |
| [Envelope (§8.1)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#81-envelope) | a request is `{ v: 2, id, op, … }`; a response `{ v: 2, id, result }`; an error `{ v: 2, id, error: { code, message, path?, reason? } }`; an event `{ v: 2, event, … }` |
| [Operations (§8.2)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#82-operations) | `open`, `info`, `rows`, `summarize`, `find`, `locate`, `write`, `save`, `export`, `changes`, `reload`, `cancel`, `close` |
| `TableInfo` (§8.2) | what `open` answers: the table's id, `revision`, `edits`, `status`, `progress`, `rowCount`, `readableRows`, `columns` and `capabilities` |
| [Blocks (§8.4)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#84-blocks) | the values of `rows`: an Arrow IPC stream of one record batch, one field per column |
| [Events (§8.5)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#85-events) | `changed`, `progress` and `view` |
| [Cancellation (§8.6)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#86-cancellation) | `cancel`, or an aborted request; the engine answers `cancelled` or finishes |
| [Errors (§8.7)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#87-errors) | the error codes, with their HTTP statuses |
| [Encodings (§8.8)](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#88-transports) | a block as `{ bytes }` in function calls and workers, `{ base64 }` in text, attached over HTTP |

Views have no handles: each request names the table, its revision and the plan, and the engine may keep or
forget the views it made.

## Offering part of it

`TableInfo` carries the engine's capabilities
([§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#410-capabilities)). The grid offers only
what they report, and a plan that uses anything else fails with `invalid_plan` (`unsupported`). So an engine can
start small: a minimal one answers `open`, `rows` of the plan `{}` and `close`, and the grid shows the table and
scrolls it, with no sorting, filters, editing or exports.

| Capability | What the grid offers with it |
| --- | --- |
| `plan.sort` | sorting from the column menu |
| `plan.where`, `functions` | filters and conditions |
| `plan.search` | the search box |
| `plan.aggregate`, `plan.having`, `plan.pivot`, `measures` | grouping, the totals row and pivots |
| `plan.derive` | formula columns |
| `summarize`, `find`, `locate` | the selection's summary, the find bar, keeping the active row through a new view |
| `write`, `save` | editing, and the Save button |
| `export` | the Export menu, with `formats` and a `delivery` of `file` or `data` |
| `preview`, `partialViews`, `changes` | rows of a sort before it ends (§9), and how changes arrive |

## A minimal engine

This sketch serves one table of rows in their own order. Every name comes from `vastgrid-spec`:

```ts
import {
  answerId,
  type Capabilities,
  checkRequest,
  type Column,
  encodeBlock,
  errorResponse,
  type JsonValue,
  planHash,
  ProtocolError,
} from "vastgrid-spec";

// Rows in their own order only: no derived columns, filters, groups, sorts or search.
const capabilities: Capabilities = {
  plan: { derive: false, where: false, aggregate: false, pivot: false, having: false, sort: false, search: false },
};

export function rowsEngine(name: string, columns: Column[], rows: JsonValue[][]) {
  const edits = { version: 0, cells: 0 };
  const info = {
    table: name,
    revision: "1",
    edits,
    status: "ready",
    progress: 1,
    rowCount: rows.length,
    readableRows: rows.length,
    columns,
    capabilities,
  };

  return {
    async handle(message: unknown) {
      let request: ReturnType<typeof checkRequest>;
      try {
        request = checkRequest(message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        const { path, reason } = error;
        return errorResponse(answerId(message), "invalid_request", error.message, { path, reason });
      }
      const { id, op } = request;
      if (op === "cancel") return undefined;
      if (op === "open") {
        if (request.ref !== name) return errorResponse(id, "not_allowed", "There is no such table.");
        return { v: 2, id, result: info };
      }
      if (request.table !== name) return errorResponse(id, "table_not_found", "The table is not open.");
      if (op === "info") return { v: 2, id, result: info };
      if (op === "close") return { v: 2, id, result: null };
      if (op !== "rows") return errorResponse(id, "internal", `This engine does not answer ${op}.`);

      const [member] = Object.keys(request.plan as object);
      if (member !== undefined) {
        const reason = "unsupported";
        return errorResponse(id, "invalid_plan", `This engine has no ${member}.`, { path: `/plan/${member}`, reason });
      }
      if (request.revision !== info.revision) return errorResponse(id, "revision_changed", "The table changed.");
      const picked = (request.columns as string[]).map((column) => columns.findIndex((c) => c.name === column));
      const missing = picked.indexOf(-1);
      if (missing >= 0) {
        const path = `/columns/${missing}`;
        return errorResponse(id, "invalid_request", "No such column.", { path, reason: "syntax" });
      }
      const start = request.start as number;
      const end = Math.max(start, Math.min(request.end as number, rows.length));
      const view = {
        hash: await planHash({}),
        status: "ready",
        rowCount: rows.length,
        rowCountExact: true,
        readableRows: rows.length,
        columns,
        edits,
      };
      const values = rows.slice(start, end).map((row) => picked.map((index) => row[index]));
      const block = { bytes: encodeBlock(picked.map((index) => columns[index]), values) };
      const rowIds = values.map((_, offset) => start + offset);
      return { v: 2, id, result: { view, start, end, rowIds, block } };
    },
  };
}
```

```tsx
import { DataGrid, localTransport } from "vastgrid";

const transport = localTransport(rowsEngine("people", columns, rows));

export function People() {
  return <DataGrid transport={transport} table="people" style={{ height: 480 }} />;
}
```

A real engine does more: it reads only the rows asked for from its store, cuts strings longer than `textLimit`
and reports them in `truncated` (§8.4), answers a value that does not fit its type with `invalid_value`, and
sends `changed` events when its data changes.

## Tools

`vastgrid-spec` holds the checks and encodings that every engine needs:

| Name | For |
| --- | --- |
| `checkRequest`, `checkResponse`, `checkEvent` | the checks of §8, which the grid also runs on every answer |
| `errorResponse`, `answerId`, `ERROR_STATUS` | errors that follow §8.7, and their HTTP statuses |
| `checkPlan` | validates a plan against the table's columns (§4.7) |
| `planHash` | the hash of a view's plan |
| `encodeBlock`, `decodeBlock` | blocks from rows of typed JSON, and back |
| `toTextEncoding`, `toStructuredEncoding`, `frameAttached`, `readAttached` | the encodings of §8.8 |

For an engine over SQL, `vastgrid-sql` turns a checked plan into DuckDB SQL with the meaning of the
specification (blanks last, ties broken by row ID): `compileView(checkPlan(plan, columns), { relation, rowId })`,
then `rowsQuery(view, { start, end, columns })` and `countQuery(view)`. Values are always parameters and names
always quoted; the session's time zone must be UTC.

## Testing against the corpus

The conformance corpus ([§10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#10-conformance)) ships
with `vastgrid-spec`. Its plan cases give a table, a plan and the rows or error expected. `readCorpus()` from
`vastgrid-spec/conformance` reads them; run each through your engine (`open`, then `rows`), decode the block with
`decodeBlock`, and `compareResult(expect, got)` lists the differences. A case whose plan uses a member you do not
offer should get `invalid_plan` with the reason `unsupported`.
[The memory engine's test](https://github.com/yhay81/vastgrid/blob/main/packages/js/test/conformance.test.ts)
does exactly this. `readMessageCorpus` and `runMessageCase` check messages the same way.

## A transport of your own

When the host has its own channel, such as a webview's `postMessage` or a notebook's comm, `workerTransport` works
over anything with `postMessage` and `addEventListener`, with `serveEngine` on the other side. Otherwise implement
`Transport`: `send(request, { signal })` gives the engine's answer with blocks as bytes, and nothing for `cancel`.
`subscribe`, `cancels` (`"signal"` when aborting the signal cancels the request) and `exportUrl` are optional.

```ts
import type { Transport } from "vastgrid";
import { toStructuredEncoding } from "vastgrid-spec";

// `call` carries text to the engine and gives its answer in the text encoding (§8.8).
export function textTransport(call: (message: string) => Promise<string>): Transport {
  return {
    async send(request) {
      const answer = await call(JSON.stringify(request));
      return request.op === "cancel" ? undefined : toStructuredEncoding(JSON.parse(answer));
    },
  };
}
```

On the engine's side, `toTextEncoding(answer)` turns each answer but that of `cancel` into that form. The grid
checks every answer with `checkResponse`, so a mistake shows as an error instead of wrong rows.
