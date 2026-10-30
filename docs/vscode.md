# vastgrid in VS Code

`vastgrid-vscode` (`packages/vscode`) is an extension for VS Code: CSV, TSV, Parquet, JSON Lines and Excel files of any
size open in a grid as a custom editor. DuckDB reads the file in the extension's process, in Node.js; the editor's
webview shows `DataGrid` (react.md) and reads rows from it through the webview's messages. Cells of CSV and TSV
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
| Excel | `.xlsx`, `.xlsm` | read, by default; a bar above the grid, or "vastgrid: Choose Sheet", chooses the sheet |

## Editing and saving

- The grid writes cells as it does elsewhere (§6.5, §7.2): typing, pasting, clearing and filling. Each new step of
  the grid's history (§7.4) is an edit on VS Code's stack (`CustomDocumentEditEvent`), which VS Code undoes and
  redoes in the grid that made it (`history.undo`, `history.redo`): the Edit menu's Undo and Redo, and the keys
  (⌘Z, ⇧⌘Z or Ctrl+Y), which the page leaves to VS Code outside the fields it types in. The editor is dirty while
  the stack is away from the point where the file was saved: undoing every write back to it makes it clean again.
- VS Code's Save (⌘S or Ctrl+S, also while a cell is edited, which is written first) saves the written cells into
  the file (`save`, §7.5). A file changed on disk by someone else since it was read is not saved over: the save
  fails with `file_changed`, the editor stays dirty with its cells, Save As writes them elsewhere, and Revert (or
  the toolbar's "Discard edits and reload") reads the file as it is now (§7.6).
- Save As writes the whole table, with the written cells, as CSV, TSV, Parquet, JSON or Excel, by the new name's
  extension (`export` of the plan `{}`, §8.2). It is also the way to save the cells of a file that is only read.
- Revert drops the written cells: the file's engine closes and the editors open the file anew, keeping their
  document (sorts, filters, columns).
- The grid's Export menu writes the view or the table where a save dialog says.
- The grid does not save by itself (`capabilities.save` is false in the webview) and offers no Save button: VS Code
  saves, so that its dirty state follows the file.

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
- Written cells live in the engine, in a table that a handle of the extension's own keeps open for the engine's
  life (§7.2): pages that load again close theirs. Save, Save As and backups use that handle, which holds the
  written cells also when the file changed on disk since (§7.6). A page reaches only the handles it opened.
- A backup (hot exit, `backupCustomDocument`) holds the writes since the file was read or saved, as updates without
  `previous`, with the size and modification time of the file they were written on. An editor restored from one
  opens the file and writes them again, as new steps of nothing (the history starts empty), so that the editor is
  dirty with them; when the file changed since, it writes none and says how many were not restored.

## Messages

The webview and the extension exchange the messages of §8 as they are, with blocks as bytes (the structured
encoding of §8.8): VS Code carries `Uint8Array`s between the extension and its webviews without copying them into
text. The page's transport is `workerTransport` over the webview's `postMessage`. Besides those, the extension and
the page send messages with a `vastgrid` member (`src/messages.ts`): `ready` when the page loads, `listening` when
its grid takes commands, `save`, `undo` and `redo` for the keys that VS Code acts on, `edit` for a new step of the
grid's history, `sheets` and `sheet` for the sheets of a workbook, `restart` after a revert, and `dispatch` and
`answer` for the extension's commands.

The extension returns an API to other extensions: `dispatch(uri, command)` applies a command of §6 in the grid of
a file open in vastgrid (its active editor, or the first), as the person's keys and menus do, and gives its output.

## Trust, files and the page

- In a workspace that VS Code does not trust, files open read-only (`untrustedWorkspaces: limited`): the grid
  writes no cells and nothing is saved. When VS Code trusts the workspace, the CSV and TSV files open read-only
  open anew, editable, keeping their documents.
- The extension opens files on disk only (`file:` URIs; in a remote window, the remote's disk, where the extension
  runs). The engine reads the file where it really is, links followed.
- The page is `dist/webview.js` and `dist/webview.css` of the extension, the only files it may load. Its CSP is
  `default-src 'none'`, scripts with a nonce, styles, images and fonts from the extension: no network, no WebAssembly,
  no workers. The grid takes VS Code's theme colors and font, and its language (English, Japanese, Chinese, Korean,
  Spanish, Portuguese, French or German).

## Platforms and packaging

The extension needs VS Code 1.100 or later, on the platforms of DuckDB's Node.js bindings. `npm run build -w
vastgrid-vscode` bundles `dist/extension.cjs` with esbuild and leaves `@duckdb/node-bindings` outside, and `npm run
package -w vastgrid-vscode -- <target>` (`scripts/package.mjs`) makes the package of one platform,
`dist/vastgrid-vscode-<version>-<target>.vsix`, with the bindings of that platform in `dist/node_modules`
(`@duckdb/node-bindings`, `@duckdb/node-bindings-<platform>` and `detect-libc`): those installed, or fetched from
npm at the version installed for another platform. Without a target, it is this machine's.

| VS Code target | DuckDB's bindings | Tested in CI |
| --- | --- | --- |
| `darwin-arm64` | `darwin-arm64` | yes (macOS) |
| `darwin-x64` | `darwin-x64` | |
| `linux-x64` | `linux-x64` | yes (Ubuntu) |
| `linux-arm64` | `linux-arm64` | |
| `alpine-x64` | `linux-x64-musl` | |
| `alpine-arm64` | `linux-arm64-musl` | |
| `win32-x64` | `win32-x64` | yes (Windows) |
| `win32-arm64` | `win32-arm64` | |

There is no package for the web (vscode.dev) nor for 32-bit Arm Linux: DuckDB's bindings do not run there. CI makes
the packages of macOS, Linux and Windows and tests each in VS Code (below); they are kept as the workflow's
artifacts.

A release (CONTRIBUTING.md, "Releasing") makes packages for its configured targets and attaches them to the
GitHub release; for a version that is not a pre-release with Marketplace publishing enabled, it publishes them with `vsce publish
--packagePath`, and the Marketplace serves each platform its package. With `OPEN_VSX_ENABLED`, it publishes them to
Open VSX as well, by trusted publishing (`ovsx publish --trusted-publishing --packagePath`). To try a package of a release by hand:
`code --install-extension vastgrid-vscode-<version>-<target>.vsix`, and `VASTGRID_VSIX=<package>.vsix npm run
test:vscode -w vastgrid-vscode` runs the suite on it.

Version 0.2.0 ships seven VSIX files on [GitHub](https://github.com/yhay81/vastgrid/releases/tag/v0.2.0): Linux
x64/arm64, Alpine x64, macOS x64/arm64 and Windows x64/arm64. Its Marketplace listing is deferred.

## Testing

- `packages/vscode/test/table-file.test.ts` runs `TableFile` without VS Code: grids of `vastgrid` talk to it
  through messages as the page does. Two editors reading and writing one file, VS Code's undo and redo, saving, a
  file changed on disk, Save As, revert, backups, trust, read-only files, exports, the extension's commands, and the
  engine's lifetime.
- `npm run test:vscode -w vastgrid-vscode` runs the built extension in VS Code (`VSCODE_PATH`, or a stable VS Code
  that @vscode/test-electron downloads), in a window and a profile of its own: open, edit, save, VS Code's Undo and
  Redo with the dirty state, a file changed on disk that is not saved over, open again, revert, two editors of one
  file, TSV saved, JSON Lines, Parquet and Excel read-only, a sheet chosen in a workbook and its last row of
  200,000, the last row of CSV and Parquet files of a million rows, and the engines closed with their editors.
  With `VASTGRID_VSIX`, VS Code installs that package and the suite runs on it.

## Not yet

- The extension is not in Open VSX yet: the release workflow publishes it there once the namespace has its trusted
  publisher. Pre-releases are only on the GitHub releases.
- Files of other schemes than `file:` (a remote file system of another extension, vscode.dev) do not open.
