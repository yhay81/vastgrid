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
| ⌘/Ctrl + V | Paste from the selection's top-left cell (see [Pasting](#pasting)) |
| ⌘/Ctrl + Z · ⌘/Ctrl + Shift + Z (also Ctrl + Y) | Undo · redo the last write (see [Undo and redo](#undo-and-redo)) |

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

## Pasting

⌘/Ctrl + V (or "Paste" in the context menu, which may ask for permission to read the clipboard) pastes
what Excel, Numbers, Google Sheets or a web page copied:

- **What is read.** The clipboard's text as tab-separated values (`parseTsv`): rows end with a line
  break, quoted fields may hold tabs, line breaks and `""` quotes, and empty cells are blanks. Without
  text, the first HTML table (`parseHtmlTable`), with `colspan` and `rowspan` filled with empty cells.
- **Where it goes.** From the top-left cell of the selection, over the visible columns in display order.
  A selection that is a whole multiple of the pasted rows and columns is filled by repeating them, as in
  spreadsheets. One value fills every selected cell, also of several ranges; more values cannot be
  pasted into several ranges.
- **Past the end.** Rows and columns beyond the end of the view are left out, and the notice says how
  many; rows are never added.
- **Values.** Every value is checked first, as typed values are, except that numbers may group their
  digits with commas (`1,234.50`). One value that does not fit, a read-only column in the target, or a
  value `validateCell` refuses, refuses the whole paste, and the notice names the first cell and the
  number of cells. Nothing is written then.
- **One write.** The cells are written with one `updateCells` request, which the source saves together
  or not at all; a failure is shown as for one cell (Retry, Discard). At most 100,000 cells
  (`MAX_UPDATE_CELLS`) are pasted at once.
- **Rows not loaded.** Pasting into rows that are not loaded first reads their positions (a request
  without columns). Esc cancels the paste while it reads them; nothing is written then.

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

## Undo and redo

Every saved write — a typed value, a cleared selection, a paste — is one step of the history, so a paste
of thousands of cells is undone at once. ⌘/Ctrl + Z undoes it by writing the values before as a new
write; ⌘/Ctrl + Shift + Z (or Ctrl + Y) writes it again. The context menu has both, disabled when there
is nothing to do. Inside the cell editor, these keys undo typing in the editor instead.

- **Types and digits.** The history keeps the values as the source sent them (64-bit integers and
  decimals as text), and writes them back as they were. Before writing into cells whose values are not
  loaded or were cut for display, the grid reads their whole values, so that the write can be undone.
- **Saving and failures.** Undo and redo wait until no write is saving or failed. An undo is a write like
  others: when it fails it shows Retry and Discard, and it moves in the history only once it is saved.
- **Changes by others.** An undo carries the values it expects to find. When another user changed one of
  the cells meanwhile, nothing is written (`edit_conflict`); the user can **Overwrite** or **Discard**.
- **A new write** drops what could be redone. **A new revision** of the table (for example the file was
  read again) forgets the whole history, since row positions may name other records then.
- **Limits.** The history keeps at most 100 writes, 1,000,000 cells and 32,000,000 characters of text; the
  oldest writes are forgotten beyond them, and a single write larger than that cannot be undone.

The app reads the state with `onHistoryChange` (`canUndo`, `canRedo`, the number of steps and what the
next step is), and runs the steps with `undo()` and `redo()` on the grid's ref, for example from its own
toolbar. `EditHistory` in `vastgrid-core` is the same history without the grid.

```tsx
const grid = useRef<DataGridHandle>(null);
const [history, setHistory] = useState<GridHistoryState | null>(null);

<button disabled={!history?.canUndo} onClick={() => grid.current?.undo()}>Undo</button>
<DataGrid ref={grid} source={source} onHistoryChange={setHistory} />
```

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
