---
title: Editing cells
description: Sources that can write cells, the cell editor, how values are checked, and how saving works.
---

The grid edits cells of sources that can write them. Other sources stay read-only, as before:

| Source | Editing |
| --- | --- |
| `ArraySource` | With `editable: true`. Values are written into its arrays. |
| `RemoteSource` + `vastgrid-duckdb` | When the engine is created with `editable: true`. Written values are kept in the engine, apart from the file. |
| `BrowserSource` (`vastgrid-browser`) | Read-only. |
| Your own `TableSource` | When it reports `capabilities.edit` and has `updateCells`. |

A grid can stay read-only with `readOnly`. Columns marked `readOnly` in the schema, and columns whose type
cannot be typed (lists, structs, maps, binary values, intervals), stay read-only too.

```tsx
const source = useMemo(() => new ArraySource({ columns, rows, editable: true }), [rows]);

<DataGrid
  source={source}
  validateCell={(cell) => (cell.schema.name === "age" && Number(cell.value) < 0 ? "Age cannot be negative." : null)}
  onCellsChange={(event) => {
    if (event.status === "saved") console.log(`${event.changes.length} cells saved`);
  }}
/>
```

## Editing with the keyboard and the pointer

| Keys | Action |
| --- | --- |
| Typing a character (also with an IME) | Replace the active cell's value; the character goes into the editor |
| F2 · double click | Edit the value (the cursor goes to its end) |
| Enter · Shift + Enter | Save and move down · up |
| Tab · Shift + Tab | Save and move right · left |
| Alt + Enter (also ⌃↩ on a Mac) | New line in the editor |
| Esc | Cancel, keeping the value |
| Delete · Backspace | Clear the selected cells (every range) |

Clicking elsewhere saves too. Keys that end an IME composition (Enter, Esc) are left to the IME. The
editor is a text field over the cell, in the page rather than on the canvas, so it works with IMEs,
spell-checking and screen readers; its label names the cell, and a refused value is described next to it.

`onCellDoubleClick` is called first for a double click and for F2: `event.preventDefault()` keeps the
editor (and the cell inspector) closed. In a grid that edits, the inspector is in the context menu
("Show full value"), which also has "Edit cell" and "Clear contents". In a read-only grid, F2 and a double
click open the inspector, as before.

## How values are checked

Typed text is read as the column's type with `parseCellInput` from `vastgrid-core`, which sources also
use (`normalizeCellValue`), so the grid and the source accept the same values:

| Type | Accepted text | Written value |
| --- | --- | --- |
| `integer`, `bigint` | Digits with an optional sign, in the range of the engine's type (`TINYINT` … `UHUGEINT`) | A number, or text when a JS number cannot hold it exactly |
| `decimal` | Digits with an optional point; at most the scale and precision of `DECIMAL(p,s)` | Text with the digits as typed (never rounded) |
| `float` | A number, `NaN`, `Infinity` | A number (`"NaN"`, `"Infinity"` as text) |
| `boolean` | `true`, `false`, `1`, `0` | `true` or `false` |
| `date` | `yyyy-mm-dd` (also `/` or `.`) | `yyyy-mm-dd` |
| `time` | `hh:mm[:ss[.fraction]]` (with an offset for `TIME WITH TIME ZONE`) | `hh:mm:ss[.fraction]` |
| `timestamp`, `timestamptz` | A date, a space or `T`, and a time (with `Z` or an offset for `timestamptz`) | `yyyy-mm-dd hh:mm:ss[.fraction][offset]` |
| `uuid`, `json`, `string` | A UUID · valid JSON · any text | The same text |

An empty text (or only spaces) is a blank (`null`). Numbers are typed without grouping or the column's
display format; the editor starts with the value itself, not with its formatted text. Long text cut for
display is read whole before it is edited.

After the type, `validateCell` checks the value: return a message to refuse it, or nothing to accept it.
It may return a promise, for example to ask a server; the editor shows "Checking…" meanwhile. A refused
value keeps the editor open with the message.

## Saving

A change is sent with `TableSource.updateCells` as one request. Writes are sent one at a time, in the
order they were made:

- **While saving**, the cell shows the new value with a mark in its corner; the status line says so when
  saving takes more than a moment.
- **Saved**: the grid reads the rows again (showing the old values meanwhile, so nothing blinks). When the
  view's sort, filters or search use a written column, the view is created again and the grid returns to
  the same place; other views are kept. The selection summary, statistics, the detail panel and exports
  read the new values.
- **Failed**: the cell shows the value the source has again, with a red mark, and a line above the status
  bar says why, with **Retry** and **Discard**.
- **Conflict**: each change carries the value it was made from. When another user changed the cell
  meanwhile, nothing is written (`edit_conflict`), the cells are read again, and the user can
  **Overwrite** or **Discard**.
- **Another revision**: a write carries the table's `revision`. Once the file was read again
  (`revision_changed`), row positions may name other records, so the write can only be discarded.

`onCellsChange` reports each write once it is saved or failed, with its cells (`rowId`, `column`,
`value`, `previous`), the reason (`edit`, `clear`, …) and the error.

Cells are named by the row's position in the table (`rowId`), which stays the same while the view is
sorted or filtered again and while cells are written, so checked rows stay checked. Writes keep the
table's `revision` and change `info().edits.version` instead; other grids of the same source learn of
them through `subscribe` (`RemoteSource` asks the server every 2 seconds) and read the rows again.

## Writing to the DuckDB server

```ts
const engine = await TableEngine.create({ allowedDirectories: [dataDir], tempDirectory, editable: true });
```

Written values are checked, converted to the column's DuckDB type, and kept in a table per edited column
inside the engine. A view joins them to the file's rows, so rows, sorted and filtered views, statistics,
summaries, find and exports all read them; reading a block of a 5M-row table with 1,000 written cells
takes about as long as before (3–4 ms). Views whose rows or order may depend on the written columns are
dropped and created again on the next request. The file itself is not changed.

A table with written cells stays open: it is not closed to keep `maxTables`, nor opened again when its
file changes. Closing the table (`close`) or disposing the engine discards them.

## Your own source

Report `capabilities.edit`, mark columns you do not write with `readOnly`, and implement `updateCells`:

```ts
async updateCells({ updates, revision }: UpdateRequest): Promise<UpdateResult> {
  if (revision !== undefined && revision !== this.revision) throw new SourceError("revision_changed", "…", 409);
  for (const update of updates) {
    const checked = normalizeCellValue(update.value, this.columns[update.column]);
    if (!checked.ok) throw new SourceError("invalid_value", "…", 422);
    if (update.previous !== undefined && !sameCellValue(this.get(update), update.previous))
      throw new SourceError("edit_conflict", "…", 409);
  }
  // Write every update, or none of them.
  return { updated: updates.length, edits: { version: ++this.version, cells: this.edited } };
}
```

See [`TableSource`](/reference/table-source/#writing-cells) and the
[protocol](/reference/protocol/) for the `update` request.
