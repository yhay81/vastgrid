---
title: Editing cells
description: When cells are writable, the editor, how typed text is read, pasting, filling, undo, failed writes and saving into the file.
---

The grid edits like a spreadsheet: type into a cell, paste a range, clear, fill, undo. The engine keeps written
values apart from the file, and every later read sees them: sorts, filters, groups, find and exports. The DuckDB
engine can also save them into the CSV or TSV file they came from.

## When cells are writable

A cell is writable when the engine writes (`capabilities.write`), its column is a column of the table (not a
[formula](/guides/formulas/) column) that is not `readOnly` and not of type `interval` or `binary`, and the view
is not [grouped](/guides/grouping/). Typing into another cell says "This cell is not written."

| Engine | Writes | Saves into the file |
| --- | --- | --- |
| Memory engine (`vastgrid-js`) | Tables given with `editable: true` | No: written values stay in memory, apart from the `rows` you gave |
| DuckDB engine (`vastgrid-duckdb`) | Every table | With `saveFiles: true`, for CSV and TSV files that are not compressed |

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({ tables: { orders: { columns, rows, editable: true } } });
```

```ts
import { DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
  saveFiles: true,
});
```

The DuckDB engine's written values belong to the table: every grid that has the same file open through the same
engine sees them, and they are dropped, unless saved, when the last of them closes.

## The editor

- Typing a character opens the editor with that character in it. An IME composition starts in the editor too, so
  Japanese, Chinese or Korean text goes in whole.
- F2 or a double click opens it with the cell's value as text (`2024-01-31`, `1234.50`).
- Enter writes and moves down (Shift + Enter up), and Tab writes and moves right (Shift + Tab left). In a
  selection of several cells, they walk through it.
- Alt + Enter (⌃ + Return on a Mac) starts a new line. Esc cancels. Clicking elsewhere in the page writes.
- Text that is not a value of the column keeps the editor open and says so ("This is not a value of price.").

The grid shows a written value at once, before the engine answers. If the write fails, the cell shows its value
again and the status bar says why (see [When a write fails](#when-a-write-fails)).

## How typed text is read

| Type | Accepted |
| --- | --- |
| `string` | The text as typed; text of only white space is null |
| `integer`, `bigint` | Digits with an optional sign, within the type's range |
| `decimal` | `12.5`, `.5`: no more fraction digits than the column's scale, no exponent |
| `float` | `1.5`, `1.5e3`, `inf`, `-infinity`, `nan` |
| `boolean` | `true`, `false`, `1`, `0`, in any letter case |
| `date` | `2024-01-31`, `2024/1/31`, `2024.1.31`, naming a real day |
| `time` | `9:05`, `09:05:30`, `09:05:30.25` (up to 6 fraction digits) |
| `timestamp` | A date, then a space or `T` and a time |
| `timestamptz` | A timestamp, then `Z` or an offset such as `+09:00`; without one, the time zone of the column's date format (`format.date.timeZone`), or UTC |
| `uuid` | 32 hex digits, with or without dashes |
| `interval`, `binary` | Not typed |

White space around the text is removed, except for strings, and empty text is null for every type. Pasted numbers
may group their digits with commas (`1,234.5`). The full rules are in
[§7.3](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#73-reading-typed-text) of the specification.

## Pasting, clearing and filling

- **Paste** (⌘/Ctrl + V) writes the clipboard's tab-separated text, or the first table of its HTML, from the
  top-left cell of each range. The values repeat over a range whose rows and columns are whole multiples of
  theirs. A single value goes into every selected cell, also of several ranges; several values cannot go into
  several ranges. Rows and columns beyond the view are left out, and rows are never added.
- **Clear** (Delete or Backspace) writes null into the selected cells that are writable and not blank.
- **Fill down** (⌘/Ctrl + D) and **fill right** (⌘/Ctrl + R) copy the first row or column of each range into the
  rest. A range of one row takes the row above it, and one of one column the column to its left. Values keep
  their type when the two columns have the same one, and are read from their text otherwise.

Each write is atomic, every cell or none, and holds at most 100,000 cells (`too_many_cells`).

## Undo and redo

⌘/Ctrl + Z undoes the last write (a typed value, a paste, a clear or a fill), and ⌘/Ctrl + Shift + Z, or Ctrl + Y
off Apple platforms, redoes it. Writes name cells by row key, so an undo finds its cells after a sort or a filter.
The history is the session's (`session.history`): at most 100 steps and 1,000,000 cells, emptied when the table is
read again as another revision. An undo waits for the writes sent before it.

## When a write fails

Each write carries the value its cells had (`previous`). When one of them was changed meanwhile, by another tab,
another person on the same server or an agent, the engine refuses the write with `edit_conflict`; the cells show
their values now, and the status bar says "Not written: the cells were changed meanwhile. Their values now are
shown." with buttons:

| Button | When | What it does |
| --- | --- | --- |
| Retry | The connection was lost, or the engine failed (`internal`, `cancelled`, `not_ready`, `table_not_found`) | Sends the same write again (`store.retryWrite()`) |
| Overwrite | After `edit_conflict` | Writes over the cells; an undo gives back the values written over |
| Discard | Always | Forgets the write (`store.discardWrite()`) |

A write refused for its values or cells (`invalid_value`, `read_only`), or because the table was read again
(`revision_changed`), can only be discarded. Until then the write is in the snapshot's `failedWrite`, with its
command, its cells, its error and `retry` (`"retry"`, `"overwrite"` or null), for an app that shows it its own way.

## Saving into the file

With `saveFiles: true`, the DuckDB engine saves written cells into the CSV or TSV file they came from:

- The toolbar's **Save** button is shown while cells are unsaved, and ⌘/Ctrl + S saves too, also from the editor,
  which writes its text first. The status bar says "Unsaved 3", then "Saving…" and "Saved rows: 2".
- Only the edited fields of the edited records are written. Every other byte stays as it was: byte order mark,
  header, other records and fields, quoting, delimiters, line breaks and encoding. A value is written as the file
  reads it back (dates in the file's format), quoted when it needs it, into a new file that replaces the old one
  once complete.
- A file that someone else changed since it was read is not saved over: the status bar says "Not saved: the file
  was changed by someone else…" and the edits are kept.
- An empty string written through the API cannot be saved: even a quoted empty field reads back as null.
  Saving returns `save_unsupported` and keeps the original file and all pending edits. Null can be saved;
  clearing a cell in the grid writes null.
- Parquet, JSON Lines, Excel and compressed files are never written. Their cells can still be edited, and
  [exported](/guides/export/) with the edits.

The memory engine does not save. To keep its written values, [export](/guides/export/) the whole table: exports
hold the written values.

## Files that change on disk

The DuckDB engine follows the files of open tables
([§7.6](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#76-files-that-change-on-disk)):

- A table without written cells is read again, and the grid shows the file as it is now. The history is emptied,
  since its row keys belong to the old revision.
- A table with written cells stays as it was read, so that the edits are not lost. The status bar says "The file
  changed on disk. Your unsaved edits are kept.", saving is refused, and the toolbar's **Discard edits and
  reload** reads the file as it is now, without them (`store.reload()`).

## Writing from code

A write from code is the commands that a person's keys dispatch, with the same checks, history and failures:

```tsx
import { useRef } from "react";
import { DataGrid, type DataGridHandle, type Transport } from "vastgrid";

export function Orders({ transport }: { transport: Transport }) {
  const grid = useRef<DataGridHandle>(null);

  async function setPrice(row: number, text: string) {
    const dispatch = grid.current!.dispatch;
    await dispatch({ command: "select", row, column: "price" });
    await dispatch({ command: "edit.begin", text });
    const outcome = await dispatch({ command: "edit.commit", move: null });
    if (!outcome.ok) console.error(outcome.error.code, outcome.error.message);
  }

  return <DataGrid ref={grid} transport={transport} table="orders" />;
}
```

`row` is a position in the view, and the text is read as a person's typing is. The other writes:

| Command | Writes |
| --- | --- |
| `{ command: "edit.clear" }` | Null into the selected cells |
| `dispatch({ command: "edit.paste" }, { clipboard: { text: "1\t2\n3\t4" } })` | The text into the selection; the output is `{ cutRows, cutColumns }` |
| `{ command: "edit.fill", direction: "down" }` | The first row of each range into the rest (`"right"`: the first column) |
| `{ command: "history.undo" }`, `{ command: "history.redo" }` | The values before or after the last step |
| `{ command: "save" }` | The written cells into the file; `unsupported` when the engine does not save |

The store reads the rows that a command needs before it writes them. Like a person's writes, those from code
carry `previous`, so a write over a cell that changed meanwhile fails with `edit_conflict` instead of losing the
other change. The commands are listed in [Commands](/reference/commands/).
