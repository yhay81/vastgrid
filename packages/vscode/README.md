# vastgrid for VS Code

CSV, TSV, Parquet, JSON Lines and Excel files of any size open in a grid, read by DuckDB in the extension: scroll to
the last row of a file of millions of rows, sort, filter, group, find and summarize, and edit the cells of CSV and
TSV files and save them with VS Code's Save, with the bytes that were not edited kept as they are.

Install 0.3.0 from the [GitHub release](https://github.com/yhay81/vastgrid/releases/tag/v0.3.0): download the
`vastgrid-vscode-0.3.0-<target>.vsix` for your OS and architecture, then run `code --install-extension <file>.vsix`
or choose **Extensions: Install from VSIX…** in VS Code. Marketplace publication is deferred for this release.

| Format | Files | In vastgrid |
| --- | --- | --- |
| CSV, TSV | `.csv`, `.tsv`, `.tab` | edited and saved |
| CSV, TSV compressed | `.csv.gz`, `.csv.zst`, `.tsv.gz`, `.tsv.zst` | read |
| JSON Lines | `.jsonl`, `.ndjson` (also `.gz`) | read |
| Parquet | `.parquet`, `.pq` | read, by default |
| Excel | `.xlsx`, `.xlsm` | read, by default; the bar above the grid, or "vastgrid: Choose Sheet", chooses the sheet |

Parquet and Excel files open in vastgrid when they are opened. CSV, TSV and JSON Lines files open as text, as
before: vastgrid opens them with "Open With…", the editor's "Open in vastgrid" button, or the explorer's "Open in
vastgrid".

- **Editing**: type, paste, clear and fill cells. VS Code's Undo and Redo undo and redo them, and the editor is dirty
  while the cells differ from the file. Save writes only the edited fields; a file that someone else changed since
  it was read is not saved over. Save As writes the table, with its edits, as CSV, TSV, Parquet, JSON or Excel.
- **Hot exit**: the cells not saved are kept in VS Code's backups, and written again when the window opens, unless
  the file changed since.
- **Trust**: in a workspace that VS Code does not trust, files open read-only until it is trusted.
- **Platforms**: VS Code 1.100 or later on macOS (arm64, x64), Linux (x64, arm64; glibc and musl) and Windows (x64,
  arm64), each with a package of its own that carries DuckDB's bindings for it.

The extension reads files on disk only, and sends nothing over the network. More in
[docs/vscode.md](https://github.com/yhay81/vastgrid/blob/main/docs/vscode.md).
