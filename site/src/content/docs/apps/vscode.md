---
title: VS Code
description: Open CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid in VS Code, and edit and save CSV and TSV files with VS Code's own Save.
---

The extension `vastgrid-vscode` opens CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid, as an
editor of VS Code. DuckDB reads the file in the extension's process, in Node.js; the editor's webview shows
`DataGrid` and reads rows from it through the webview's messages. Cells of CSV and TSV files are edited and saved
with VS Code's own Save, with the bytes that were not edited kept as they are.

## Installing

Download `vastgrid-vscode-0.2.1-<target>.vsix` for your OS and architecture from the
[GitHub release](https://github.com/yhay81/vastgrid/releases/tag/v0.2.1), then choose **Extensions: Install from
VSIX…** in VS Code, or install the downloaded file from a terminal (this example is for Apple silicon):

```sh
code --install-extension vastgrid-vscode-0.2.1-darwin-arm64.vsix
```

Marketplace publication is deferred for 0.2.1. It needs VS Code 1.100 or later, on macOS (Apple silicon or Intel), Linux (x64 or arm64; Alpine x64) or Windows
(x64 or arm64): the platforms of DuckDB's Node.js bindings, each with a package of its own. It does not run in
vscode.dev or on 32-bit Arm Linux, where the bindings do not run.

## Opening files

Parquet and Excel files open in vastgrid when you open them. CSV, TSV and JSON Lines files open as text, as
before: open them in vastgrid with "Open With…", the editor's "Open in vastgrid" button, or "Open in vastgrid" in
the explorer.

| Format | Files | In vastgrid |
| --- | --- | --- |
| CSV, TSV | `.csv`, `.tsv`, `.tab` | edited and saved |
| CSV, TSV compressed | `.csv.gz`, `.csv.zst`, `.tsv.gz`, `.tsv.zst` | read |
| JSON Lines | `.jsonl`, `.ndjson` (also `.gz`) | read |
| Parquet | `.parquet`, `.pq` | read, by default |
| Excel | `.xlsx`, `.xlsm` | read, by default; a bar above the grid, or "vastgrid: Choose Sheet", chooses the sheet |

The grid takes VS Code's theme colors and font, and its language (English or Japanese).

## Editing and saving

- The grid writes cells as it does elsewhere: typing, pasting, clearing and filling (see
  [Editing cells](/guides/editing/)). Each step is an edit on VS Code's stack, so the Edit menu's Undo and Redo,
  and ⌘Z, ⇧⌘Z or Ctrl+Y, undo and redo it in the grid that made it. The editor is dirty while the stack is away
  from the point where the file was saved: undoing every write makes it clean again.
- VS Code's Save (⌘S or Ctrl+S, also while a cell is being edited, which is written first) saves the written
  cells into the file, rewriting only the edited fields. A file changed on disk by someone else since it was read
  is not saved over: the editor stays dirty with its cells, Save As writes them elsewhere, and Revert (or the
  toolbar's "Discard edits and reload") reads the file as it is now.
- Save As writes the whole table, with the written cells, as CSV, TSV, Parquet, JSON or Excel, by the new name's
  extension. It is also the way to keep the cells written into a file that is only read.
- Revert drops the written cells: the editors open the file anew and keep their sorts, filters and columns.
- The grid's Export menu writes the view or the whole table where a save dialog says.
- The grid has no Save button of its own: VS Code saves, so that its dirty state follows the file.

## Editors and their lifetimes

- A file has one engine, made when one of its editors first asks for rows and closed, with its temporary files,
  when VS Code closes the file. The engine may read that file and no other.
- Every editor of a file (split editors, editors in other groups) is a client of the same engine with its own view
  and selection. What one writes, the others show.
- A grid keeps its rows and its place while its tab is hidden, and a webview that loads again shows the same
  view, selection and sheet.
- When VS Code closes with unsaved cells (hot exit), it keeps them in a backup. An editor restored from it writes
  them again, unless the file changed since.

## Trust and the page

- In a workspace that VS Code does not trust, files open read-only: the grid writes no cells and nothing is
  saved. Once you trust the workspace, CSV and TSV files open again, editable, with their views.
- The extension opens files on disk only (`file:`; in a remote window, the remote's disk, where the extension
  runs).
- The page loads only the extension's own script and styles, under a Content Security Policy of
  `default-src 'none'`: no network, no WebAssembly, no workers.

## From other extensions

The extension returns an API: `dispatch(uri, command)` applies a [command](/reference/commands/) in the grid of a
file open in vastgrid (its active editor, or the first), as the person's keys and menus do, and gives its output.

```ts
const vastgrid = vscode.extensions.getExtension("yhay81.vastgrid-vscode");
const api = await vastgrid?.activate();
await api?.dispatch(uri, { command: "sort.set", keys: [{ column: "price", direction: "desc" }] });
```

## Not yet

- The extension is not in Open VSX.
- Files of other schemes than `file:` (a remote file system of another extension, vscode.dev) do not open.

[vscode.md](https://github.com/yhay81/vastgrid/blob/main/docs/vscode.md) on GitHub has the details: the messages
between the page and the extension, packaging and testing.
