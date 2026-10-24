---
title: Your own TableSource
description: Connect the grid to any engine by implementing the TableSource interface.
---

The grid reads everything through a `TableSource`. `ArraySource` and `RemoteSource` are two of them;
anything that can answer "which columns, how many rows, and the values of these rows" can be a third: a
worker running DuckDB-WASM, a database behind your own API, an IndexedDB store, or a function.

## The smallest source

Three methods are required: `info`, `createView` and `readRows`. The demo's table of a billion rows is
one: it stores nothing and computes each cell when the grid reads it.

```ts
import type { CellValue, RowBlock, RowRequest, TableInfo, TableSource, ViewInfo } from "vastgrid";

export class ComputedSource implements TableSource {
  readonly rowCount = 1_000_000_000;

  async info(): Promise<TableInfo> {
    return {
      columns: [
        { name: "row", type: "bigint" },
        { name: "square_root", type: "float" },
      ],
      rowCount: this.rowCount,
      readableRows: this.rowCount,
      status: "ready",
      capabilities: {
        sort: false,
        filter: false,
        search: false,
        stats: false,
        distinct: false,
        aggregate: false,
        find: false,
        export: false,
      },
    };
  }

  async createView(): Promise<ViewInfo> {
    // Without sort or filter capabilities, the grid only asks for the table itself.
    return { id: null, rowCount: this.rowCount, query: {} };
  }

  async readRows({ start, end, columns }: RowRequest): Promise<RowBlock> {
    end = Math.min(end, this.rowCount);
    const values = columns.map((column) => {
      const list: CellValue[] = [];
      for (let row = start; row < end; row++) list.push(column === 0 ? row + 1 : Math.sqrt(row + 1));
      return list;
    });
    return { start, end, columns: values };
  }
}
```

The [demo's version](https://github.com/yhay81/vastgrid/blob/main/site/src/data/computed.ts) has eight
columns of timestamps, text, numbers and blanks. The grid reads blocks of 256 rows by 48 columns around
what is on screen, so its cost does not depend on the number of rows.

## What the grid asks for

- **`info(signal?)`** opens the table and returns its columns, its size and what it can do. While
  `status` is `"loading"`, the grid polls it and reads only rows below `readableRows`, which lets a
  source show the beginning of a table while the rest loads. `rowCount` may be `null` until it is
  known. On `"error"`, put the reason in `error`.
- **`createView(query, signal?)`** applies a sort, filters and a search. Return `id: null` for an empty
  query (the table in its original order) and an id of your choice otherwise; the grid passes it back as
  `view` in the other requests. The grid creates a new view for every change of the query and stops
  using the old one, so keeping a few recent views is enough (`ArraySource` keeps four).
- **`readRows(request, signal?)`** returns the values of rows `start` to `end` (exclusive) of a view, one
  array per requested column, in the order of `request.columns`. Columns are indexes into the schema
  of `info`, never display positions, so hiding and moving columns in the grid does not change them.
  For views, `rowIds` are the rows' positions in the original table, which the row header shows.
- Text longer than `request.textLimit` may be cut and end with `…`; copies and the cell inspector ask
  for `MAX_TEXT_LIMIT` to read whole values.

## Optional methods

Each optional method turns on a feature. Set the matching capability to `true` in `info` as well.

| Method | Capability | Feature |
| --- | --- | --- |
| `createView` with `sort` | `sort` | Sorting by one or more columns. |
| `createView` with `filters` | `filter` | Filters by value and by condition. |
| `createView` with `search` | `search` | The search box, over all columns. |
| `columnStats(view, column, signal?)` | `stats` | Column statistics: blanks, distinct values, minimum, maximum, quartiles, a histogram, the most common values. |
| `distinctValues(request, signal?)` | `distinct` | The searchable list of values in the filter panel. |
| `aggregate(request, signal?)` | `aggregate` | Count, sum, average, minimum and maximum of the selection, in the status bar. |
| `find(request, signal?)` | `find` | Find (⌘/Ctrl+F): the next cell containing a text. |
| `exportView(request, signal?)` | `export` | Writing a view to a file, for your app to call. |
| `subscribe(listener)` | | Reports that the whole table changed; the grid then reads it again with `info`, keeping its query, column settings and scroll position. Return a function that stops; the grid calls it when it stops or unmounts. Changes close together are read once, and only the whole table is reported, never single rows. Sources whose data does not change leave it out. |
| `close()` | | Releases the table. Your app calls it when it no longer uses the source; the grid does not. |

The [`TableSource` reference](/reference/table-source/) lists every request and result type.

## Cancellation and errors

- Every method gets an `AbortSignal`. The grid aborts requests for rows that scrolled far away and
  views that a newer query replaced. Stop the work and reject with an `AbortError`
  (`abortError()` makes one) when it aborts.
- Reject with a `SourceError(code, message, status)` to report a problem. The grid shows the message;
  `ErrorCodes` has the codes that the grid and `RemoteSource` act on, such as `view_not_found`.
- Values are `CellValue`s: `string | number | boolean | null`. Send numbers that a JavaScript number
  cannot hold exactly, such as 64-bit integers or decimals, as strings.

## Speaking the protocol instead

To serve tables from a server that is not Node.js, implement the [table protocol](/reference/protocol/)
in that server and use `RemoteSource` in the browser. `parseProtocolRequest` in `vastgrid-core`
validates requests, and `vastgrid-duckdb`'s handler is a complete implementation to compare with.
