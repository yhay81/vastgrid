# vastgrid in VS Code

`vastgrid-vscode` (`packages/vscode`) is an extension for VS Code: CSV, TSV, Parquet, JSON Lines and Excel files of any
size open in a grid as a custom editor. DuckDB reads the file in the extension's process, in Node.js; the editor's
webview shows `DataGrid` (v2-react.md) and reads rows from it through the webview's messages. Cells of CSV and TSV
files are edited and saved with VS Code's own Save, with the bytes that were not edited kept as they are (§7.5 of
the specification).

## Running it

Build the packages, then start VS Code with the extension:

```sh
npm install
npm run build
code --extensionDevelopmentPath="$PWD/packages/vscode" /path/to/data
```

Parquet and Excel files open in vastgrid when they are opened. CSV, TSV and JSON Lines files open as text, as before:
vastgrid opens them with "Open With…", the editor's "Open in vastgrid" button, or the explorer's "Open in vastgrid".

| Format | Files | In vastgrid |
| --- | --- | --- |
| CSV, TSV | `.csv`, `.tsv`, `.tab` | edited and saved |
| CSV, TSV compressed | `.csv.gz`, `.csv.zst`, `.tsv.gz`, `.tsv.zst` | read |
| JSON Lines | `.jsonl`, `.ndjson` (also `.gz`) | read |
| Parquet | `.parquet`, `.pq` | read, by default |
| Excel | `.xlsx`, `.xlsm` | read, by default; a bar above the grid chooses the sheet |

## Editing and saving

- The grid writes cells as it does elsewhere (§6.5, §7.2): typing, pasting, clearing and filling. A write makes
  the editor dirty. Undo and redo (⌘Z, ⇧⌘Z or Ctrl+Y) are the grid's: each editor undoes the writes it made (§7.4).
- VS Code's Save (⌘S or Ctrl+S, also while a cell is edited, which is written first) saves the written cells into
  the file (`save`, §7.5). A file changed on disk by someone else since it was read is not saved: VS Code shows
  `file_changed`, and the toolbar's "Discard edits and reload" reads the file as it is now (§7.6).
- Save As writes the whole table, with the written cells, as CSV, TSV, Parquet, JSON or Excel, by the new name's
  extension (`export` of the plan `{}`, §8.2). It is also the way to save the cells of a file that is only read.
- Revert drops the written cells: the file's engine closes and the editors open the file anew, keeping their
  document (sorts, filters, columns).
- The grid's Export menu writes the view or the table where a save dialog says.
- The grid does not save by itself (`capabilities.save` is false in the webview) and offers no Save button: VS Code
  saves, so that its dirty state follows the file. A file whose cells were all undone stays dirty until it is saved
  or reverted; saving it then writes nothing.

## Lifetimes

- A file opened in vastgrid has an engine of its own (`TableFile`, `DuckDBEngine`), made at the first request of
  one of its editors and closed, with its database and its folder in the system's temporary folder, when VS Code
  closes the file (all its editors). The engine may read the file and no other: its folder is the only allowed one,
  and the `ref` that it opens is the file's name.
- Each editor of a file (split editors, editors in other groups) is a client of the same engine, with request ids
  of its own (`RequestIds`, §8.1), its own handle of the table, document and session. What one writes, the others
  read: the engine's events (§8.5) go to every editor of the file. Closing an editor closes its handles and stops
  its requests.
- A grid keeps its rows and place while its tab is hidden (`retainContextWhenHidden`). The page keeps its document,
  session and sheet in the webview's state, so that a page that loads again (Developer: Reload Webviews, or VS Code
  restoring the editor) shows them again; the handles of the page before are closed.
- Written cells live in the engine: they do not outlive VS Code's window. A backup (hot exit) holds nothing, and an
  editor restored from one opens the file as it is on disk.

## Messages

The webview and the extension exchange the messages of §8 as they are, with blocks as bytes (the structured
encoding of §8.8): VS Code carries `Uint8Array`s between the extension and its webviews without copying them into
text. The page's transport is `workerTransport` over the webview's `postMessage`. Besides those, the extension and
the page send messages with a `vastgrid` member (`src/messages.ts`): `ready` when the page loads, `listening` when
its grid takes commands, `save` for the key that saves, `restart` after a revert, and `dispatch` and `answer` for the
extension's commands.

The extension returns an API to other extensions: `dispatch(uri, command)` applies a command of §6 in the grid of
a file open in vastgrid (its active editor, or the first), as the person's keys and menus do, and gives its output.

## Trust, files and the page

- In a workspace that VS Code does not trust, files open read-only (`untrustedWorkspaces: limited`): the grid
  writes no cells and nothing is saved. Opening a file in a workspace trusted later still opens it read-only until
  it is opened again.
- The extension opens files on disk only (`file:` URIs; in a remote window, the remote's disk, where the extension
  runs). The engine reads the file where it really is, links followed.
- The page is `dist/webview.js` and `dist/webview.css` of the extension, the only files it may load. Its CSP is
  `default-src 'none'`, scripts with a nonce, styles, images and fonts from the extension: no network, no
  WebAssembly, no workers. The grid takes VS Code's theme colors and font, and its language (English or Japanese).

## Platforms and packaging

The extension needs VS Code 1.100 or later, on the platforms of DuckDB's Node.js bindings: macOS (arm64, x64),
Linux (x64, arm64, glibc and musl) and Windows (x64, arm64). `npm run build -w vastgrid-vscode` bundles
`dist/extension.cjs` with esbuild and leaves `@duckdb/node-bindings` outside: a package of the extension is made
for each platform (`vsce package --target darwin-arm64`, and so on) with the bindings of that platform in its
`node_modules` (`@duckdb/node-bindings`, `@duckdb/node-bindings-<platform>` and `detect-libc`). The extension is not
published yet.

## Testing

- `packages/vscode/test/table-file.test.ts` runs `TableFile` without VS Code: grids of `vastgrid-grid` talk to it
  through messages as the page does. Two editors reading and writing one file, saving, Save As, revert, read-only
  files, exports, the extension's commands, and the engine's lifetime.
- `npm run test:vscode -w vastgrid-vscode` runs the built extension in VS Code (`VSCODE_PATH`, or a stable VS Code
  that @vscode/test-electron downloads), in a window and a profile of its own: open, edit, save, open again,
  revert, two editors of one file, Parquet and Excel files read-only, and the engines closed with their editors.

## Not yet

- Undo and redo are not on VS Code's own stack (the Edit menu's Undo does not reach the grid), and the dirty state
  does not follow undo back to the file's values.
- Written cells are not kept in backups.
- The extension is not in the Marketplace, and no `.vsix` is built in CI.
