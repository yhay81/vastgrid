# Changelog

## Unreleased

vastgrid 0.2.0 replaces 0.1.x with a new design, specified by [spec.md](docs/spec.md) and
[react.md](docs/react.md): engines answer the same messages wherever they run (in memory in the page or a Web
Worker, or DuckDB in Node.js), and the React grid shows the views it asks them for. It opens CSV, TSV, JSON Lines,
Parquet and Excel files of any size as a spreadsheet does, edits them, and saves CSV and TSV files with every byte
that was not edited kept. [From 0.1 to 0.2](docs/migrating-from-0.1.md) is the migration guide.

### Breaking changes

- The npm packages are `vastgrid` (the React grid, with `vastgrid/core`, `vastgrid/server` and
  `vastgrid/styles.css`), `vastgrid-js` (the memory engine), `vastgrid-duckdb` (the DuckDB engine for Node.js),
  `vastgrid-spec`, `vastgrid-sql`, `vastgrid-cli` and `vastgrid-mcp`, released together at one version and
  depending on each other at exactly that version. The VS Code extension and the Python package `vastgrid` are
  released with them.
- `vastgrid-core` and `vastgrid-browser` end at 0.1.1: `vastgrid/core` and `vastgrid-js` replace them.
  `vastgrid-duckdb` keeps its name with a new API (`DuckDBEngine`, `createHttpHandler`).
- `DataGrid` reads a table of an engine through a transport (`transport`, `table`) instead of a source
  (`source`), and its state is a document and a session (`document`, `session`) instead of `GridState`.
  `migrateGridState` of `vastgrid-spec` migrates 0.1's saved states, and formulas keep 0.1's language. Props are
  renamed (`frozenColumns` is `pin` in the document, `checkboxSelection` is `checkboxes`, `maxLines` is
  `wrapLines`) or gone (`validateCell`, `copyLimit`, `nullText`, `followTail`): the migration guide maps each.
- The grid needs React 19.3 or later (0.1: 18), an optional peer; the packages need Node.js 20 or later.
- 0.1's code is removed from the repository, with its example (the playground); it stays in the history at the
  tag `v0.1.1`. 0.1's changes after 0.1.1 were not released.

### Release

- One tag releases every package: the npm packages with provenance from GitHub Actions, the Python package on
  PyPI and the VS Code extension on the Marketplace (its packages for each platform are on the GitHub release).
  Pre-releases are `0.2.0-next.N` on npm's `next` tag and `0.2.0rcN` on PyPI (CONTRIBUTING.md).
- `npm run pack-check` installs the packed packages in a new project and runs what their READMEs show: the stores
  over both engines, `DataGrid` rendered on the server and bundled for a browser, the command line's page and the
  MCP server's tools. CI and the release run it.
- `vastgrid-mcp`: the server and its App give the package's version to the host instead of 0.0.0.
- `vastgrid-cli` and `vastgrid-mcp` have READMEs, and the READMEs and the site describe 0.2 in English and
  Japanese, with pages for the apps and for migrating from 0.1.
- `vastgrid-spec` reads Arrow with `@uwdata/flechette` 2.7.0, which installs `@uwdata/wk-geojson` with it.

### New in 0.2

- `vastgrid-duckdb` and `vastgrid-sql` run on DuckDB 2.0 (`@duckdb/node-api` 2.0.0-r.1), and the Python package on
  `duckdb` 2.0 or later. CSV and TSV files with line breaks in quotes are read in parallel when every record has the
  header's fields, and in one thread otherwise, which DuckDB 2.0 needs to pad them; `vastgrid-duckdb` keeps the
  statements that read blocks of rows prepared, which DuckDB 2.0 takes longer to plan; sums and averages of decimals
  of more than 18 digits stay exact beyond 38 digits (a sum beyond them is null), and a `stddev` beyond the largest
  float is null, as in the memory engine.
- `vastgrid-spec`, `vastgrid-js`: intervals compare by their length (§3.1), as DuckDB 2.0 compares them:
  `1 month -1 day` equals `29 days` (DuckDB 1.5 put it above).
- `vastgrid-notebook` (the Python package `vastgrid` in `packages/notebook/python`): vastgrid's grid in
  JupyterLab 4 and Jupyter Notebook 7 as an anywidget, with DuckDB in the kernel. `vastgrid.show` opens a pandas or
  Polars DataFrame, a PyArrow table, a DuckDB relation, or a CSV, TSV, JSON, JSON Lines, Parquet or Excel file; the
  page reads rows over the widget's custom messages with their bytes as buffers (`workerTransport`), and the notebook
  reads the written cells (`edits`, `plan`, `to_pandas`, `to_polars`, `to_arrow`, `view=True` for the grid's view) and
  exports them (`export`). The engine answers `save` false and exports as data. A grid closes with its cell's output
  and when its cell runs again, and keeps the notebook's keys of command mode off while it has the focus. The corpus,
  pytest and a comparison with vastgrid-js's memory engine test it (docs/notebook.md). docs/entries.md and
  docs/entries.ja.md compare the six places 0.2 opens files: formats, editing, saving, exporting and installing.
- `vastgrid`: a grid given rows read on a server (`initial`, from `readInitialView`) reads its totals row once the
  table is open; before, the totals row stayed empty until the view, its edits or the totals changed. A totals row
  that fails to read goes to `onError` and the snapshot's `error`, as other reads do (react.md §4.2), instead of
  staying empty without a word.
- `vastgrid`: `httpTransport` sends requests once its stream of events is open (or has failed). A table that
  finished loading before the stream connected stayed "loading" for its grid, without the menu items that need
  the whole table.
- `vastgrid`: the grid follows a theme that the host marks on the body, as VS Code's webviews (`vscode-dark`) and
  JupyterLab (`data-jp-theme-light`) do, and draws again when its own `className` or `style` changes.
  `workerTransport` is documented for anything that carries messages as a worker does (react.md §4.4).
- `vastgrid-spec`: of two shortest digits of a 32-bit float that read back as it, the text form
  (§2.4.1) takes the nearer, and of two as near the even one (5525.71875 is `5525.7188`, -5096.53125 `-5096.5312`);
  `excelSerial` reads the years 0 to 99 as themselves. The corpus searches 32-bit floats by their text forms.
- `vastgrid-sql`: `textSql` writes 32-bit floats with their shortest digits, not DuckDB's exact ones.
- `vastgrid-duckdb`: CSV and TSV exports write 32-bit floats as their text forms.
- `vastgrid-site`: the page `/open/` (`/ja/open/`) opens a CSV, TSV, JSON Lines, Parquet or Excel file that is
  dropped or chosen, or a sample of 1,000,000 rows, with 0.2's grid and memory engine in a Web Worker: the file
  stays in the browser, is sorted, filtered, edited and exported as CSV, TSV, JSON or Excel, and a workbook's sheet
  is chosen. `e2e/open.spec.ts` tests it on the built site.
- `vastgrid-js`: the memory engine opens sheets of Excel workbooks (`.xlsx`, `.xlsm`) given as a
  `Blob` or a `File`, with `open`'s `read` (`sheet`, `headerRow`, `keepEmptyRows`, `keepEmptyColumns`) and the
  workbook's `sheets`, `sheet` and `notes` in `TableInfo`, and with the columns, types and values that the DuckDB
  engine reads. A sheet is kept as lines of CSV and read within `maxBytes` as a CSV file is.
- `vastgrid-spec`: `vastgrid-spec/workbook` reads workbooks through a `WorkbookSource` (`blobSource`
  for a `Blob`), moved from `vastgrid-duckdb` so that both engines read them alike.
- `vastgrid-duckdb`: workbooks are read with `vastgrid-spec/workbook`, and the test of the
  memory engine against DuckDB opens the same workbooks with the same read options in both engines.
- `vastgrid-js`: the memory engine opens Parquet files, `{ parquet }` with a `Blob`, a `File` or the
  URL of a file whose server answers range requests (`headers`, `fetch`), read with hyparquet: opening reads the
  footer, `rows` the row groups of its rows (a cache of 4 million cells), and sorts, filters, groups, summaries,
  `find`, `export` and the rows of a sorted view the columns they need whole, within `maxBytes` (default 1 GiB,
  else `load_failed` at `/maxBytes`). Columns have the types and `sourceType` that DuckDB gives them; a URL whose
  `ETag` or `Last-Modified` changes fails with `file_changed`. Written values are kept by cell over the columns of
  every table rather than in a copy of the column. A text file whose columns would take more than `maxBytes` opens
  instead of failing: as 0.1's browser engine did, its rows are read by blocks of 1,024 rows from where its first
  reading found them, and its columns whole as requests need them, within `maxBytes`. Columns read whole that no
  request reads are forgotten, the least recently used first, when a request needs their room. Reading columns
  whole and ranking text can be cancelled between row groups, slices or steps, and a cancel is read as soon as a
  view is made. The ranks of a sorted column keep 4 bytes a row and its distinct values, where those of text kept
  every row's string and those of numbers the column. A million rows of eight columns open from Parquet in 30 ms and
  from CSV in about a second
  ([measurements](docs/memory-engine-benchmark.md)).
- `vastgrid-spec`: `integerJson` and `decimalJson` are exported.
- `vastgrid-duckdb`: the test of the memory engine against DuckDB opens the generated table as
  a Parquet file too, and a test reads a Parquet file over HTTP and counts its bytes;
  `bench/memory-engine.ts` measures the memory engine on CSV and Parquet files.
- `vastgrid-js`: the memory engine offers `find` and `export` (§8.2). Exports of CSV, TSV, JSON and
  xlsx are answered as the file's bytes (`capabilities.export.delivery` `data`), written as the DuckDB engine writes
  them. `find` and `export` let a `cancel` in while they go through the rows, and stop with `cancelled`.
- `vastgrid-spec`: `vastgrid-spec/xlsx` writes workbooks (moved from `vastgrid-duckdb`, with
  `webDeflate` for `CompressionStream`), and `vastgrid-spec/export` writes CSV, TSV and JSON from rows of typed
  JSON, so that every engine writes the same files.
- `vastgrid-duckdb`: JSON exports are JSON: floats that are not finite are `"nan"` and
  `"inf"` instead of `NaN` and `Infinity`, float32 values are not widened (`0.1`, not `0.10000000149011612`), and
  decimals keep all their digits (`12.50`, not `12.5`). CSV and TSV write decimals without whole digits with their
  0 (`0.5`, not `.5`), floats at the view's width, and a header line for a view without columns.
- `vastgrid`: the export menu downloads exports that the engine answers as data, named after
  the table.
- `vastgrid-vscode`: VS Code's Undo and Redo (the Edit menu and the keys) undo and redo the grid's
  writes, each a step on VS Code's stack, and the editor is clean again when they are undone back to the saved file.
  Cells not saved are kept in VS Code's backups (hot exit) and written again when the window opens, unless the file
  changed since. Files opened read-only in a workspace not trusted open anew, editable, once VS Code trusts it.
  "vastgrid: Choose Sheet" chooses the sheet of a workbook from the command palette.
- `vastgrid-vscode`: a save of a file changed on disk since it was read fails with `file_changed`
  and keeps the written cells, which Save As writes. Before, the save found no written cells in the file read again,
  succeeded without writing, and the editor lost them.
- `vastgrid-vscode`: `npm run package -w vastgrid-vscode -- <target>` makes the extension's package
  for a platform with DuckDB's bindings for it, and CI tests the packages of Linux, macOS and Windows installed in
  VS Code (docs/vscode.md).
- `vastgrid-duckdb`: `export`, `find` and `summarize` of a table that is still loading wait
  until it has loaded (§9). Before, an export wrote only the rows read so far: Save As of a large CSV file in VS Code
  wrote its first rows.
- `vastgrid`: a command whose view was replaced while it ran (a `changed` event after a write
  of another editor) is applied again to the new view instead of failing with `cancelled`.
- `vastgrid`: a write that fails stays in the snapshot's `failedWrite`, and the status bar says
  why with Retry (Overwrite after an `edit_conflict`, which writes over the other change) and Discard, as 0.1 did;
  `GridStore.retryWrite` and `discardWrite` do the same. An undo or a redo pressed while a write is still being sent
  waits for it, so that it undoes that write and not the one before.
- `vastgrid-mcp`: the tables that an App opened in the engine are closed once the App stops asking
  (its conversation was closed) and when its grid closes; before, they stayed open as long as the server ran.
- `vastgrid-mcp`: each App of a grid and each `grid_rows` keep their request ids apart. The Apps of
  a grid and the agent's reads shared one client of the engine, so that an App's `cancel` of its request 1 could
  stop another App's request 1, and an App could not cancel a request while the agent read rows. `Grid` takes the
  server's `RequestIds` and gives each of them a client of its own.
- `vastgrid-cli`: one command opens files in 0.2's grid in the browser. `vastgrid [--save]
  [<file or folder>…]` starts DuckDB in Node.js and a page of one HTML file, on 127.0.0.1, and opens it in the
  browser; the page lists the files named and the table files of the folders named, and opens no others. The
  printed address holds a random token that the page keeps in an `HttpOnly`, `SameSite=Strict` cookie of the port,
  and other names of the host are refused, so that other sites, other people on the computer and DNS rebinding
  reach nothing. The address keeps the file and the sheet shown. With `--save`, ⌘S or Ctrl+S saves edited cells
  into CSV and TSV files; exports are downloaded. Ctrl+C stops DuckDB, which deletes its temporary files.
- `vastgrid-duckdb`: `findTableFiles` lists the table files of folders, two folders deep, as
  the MCP server's `list_files` does.
- `vastgrid-js`: the memory engine opens text files. A table `{ file }` with a `Blob` or a `File`
  of CSV, TSV or JSON Lines in UTF-8 (the format from `format` or the file's name), in a Web Worker or the page, is
  read in slices when it is first opened into typed columns, without rows of JSON. Each column has the first of
  boolean, integer, bigint, float, time, date, timestamp and timestamptz that every value of it fits, and is a
  string otherwise; objects and lists of JSON are their JSON text. Quoting, CRLF and byte order marks are read as
  0.1 read them, and empty fields are null; text that is not UTF-8 fails to load at its row and column, and
  `maxBytes` (default 1 GiB) limits the memory a file's columns may take. A CSV file of a million rows and six
  columns (55 MB) opens in about 0.9 seconds into 32 MB, where the same rows as JSON take 248 MB. The code that
  reads files loads with the first such table.
- `vastgrid-js`: the memory engine takes tables as Arrow, `{ arrow }` with the bytes of an IPC
  stream or file of any number of record batches, and keeps their columns as Arrow holds them: values of fixed
  width in typed arrays, checked and sorted as numbers, and the others read when they are asked for. A million
  rows of six columns take half the memory of the same rows as JSON (258 MB against 494 MB), and sort by a date,
  a decimal or a timestamp in 50–70 ms instead of 170–250 ms. Every case of the conformance corpus passes with its
  tables as Arrow too. Writes no longer copy the host's rows; they change the engine's own copy of a column. The
  code that reads Arrow loads with the first such table.
- `vastgrid-spec`: `decodeColumns` of `vastgrid-spec/columns` reads the columns of an Arrow IPC
  stream or file of any number of record batches: typed JSON by row, read when it is asked for, and the typed
  arrays that hold values of fixed width.
- `vastgrid-duckdb`: exports to Parquet keep intervals as they are. DuckDB
  1.5's Parquet dictionaries keep one of the values that compare equal, so a column of "1 month" and "30 days" was
  written with one in place of the other; a Parquet export with an interval column is now written without
  dictionaries.
- `vastgrid-js`, `vastgrid-sql`, `vastgrid-duckdb`: a test sends generated plans to the memory
  engine and the DuckDB engine and compares their answers, which found and fixed these. The memory engine reads a
  date as a timestamp of any unit (it failed for dates that nanoseconds do not hold), and keeps −0.0 in float
  results. Plans as DuckDB SQL: `left`, `right` and `substr` take counts beyond 2^32; `add_days` gives null for
  days that are not an integer and for years beyond 1 to 9999, instead of failing or sorting what reads as null;
  `if`, `coalesce`, `least` and `greatest` give null for a value that does not fit their common type; `round` and
  `quantile` of 32-bit floats compute in 64 bits; a decimal(38, s) sum beyond 38 digits is null; and a pivot
  without keys or combinations no longer fails. Sums and averages of decimals of more than 18 digits whose partial
  sums overflow, and `stddev` of floats near the largest, still fail in the DuckDB engine.
- `vastgrid`: `npm run size` fails over 200 KB with gzip instead of 100 KB, so that features
  are not shaped by the budget before 0.2 is complete.
- `vastgrid-js`: the memory engine evaluates every plan of §4.1: `derive`, `where` and `search` with
  every function of §4.4, sorts by derived columns, and groups with `aggregate`, every measure of §4.5, `pivot`
  (`too_many_columns` beyond `maxColumns`) and `having`. Exact numbers are computed exactly (BigInt beyond 2^53;
  sums that do not fit decimal(38, s) are null), strings compare and change case by code point, and errors give
  null (§3.6). `locate` and `summarize` work on the rows a view keeps and on groups, which have no row IDs. Every
  case of the conformance corpus passes; a million rows derive, filter and sort, or group by 1,000 keys, in under
  a second. Plans other than sorts load their code when first used.
- `vastgrid-spec`: `normalizeInterval` gives the parts by which DuckDB 2.0 compares intervals
  (§3.1), before in `vastgrid-js`.
- `vastgrid-vscode`: a VS Code extension (docs/vscode.md). CSV, TSV, Parquet, JSON Lines and Excel
  files of any size open in a grid as a custom editor, read by DuckDB in the extension's process; Parquet and Excel
  files open in it by default, and a bar chooses an Excel file's sheet. Cells of CSV and TSV files are edited in a
  trusted workspace and saved with VS Code's Save, keeping the bytes that were not edited; writes make the editor
  dirty, Revert drops them, and Save As writes the table as CSV, TSV, Parquet, JSON or Excel. Each file has an
  engine of its own, shared by its editors (split editors read what each writes) and closed with its last editor.
  The webview carries the messages of §8 with blocks as bytes, under a CSP without network.
- `vastgrid`: `RequestIds` (in `vastgrid/core`, before in `vastgrid-mcp`) gives the requests of several
  clients of one engine ids of their own.
- `vastgrid-mcp`: an MCP server with an MCP App (docs/mcp-app.md). `vastgrid-mcp [--save] <folder>…`
  opens CSV, TSV, Parquet, JSON Lines and Excel files of the folders in a grid that the host shows in the chat
  (`open_grid`), read by DuckDB on the server. The agent reads the grid's state and rows (`grid_state`,
  `grid_rows`) and applies the commands of the specification (`grid_command`), the person works in the same grid,
  and each sees what the other does: the App carries its requests through the host's tool calls
  (`vastgrid_message`) and keeps its document and session in step with the grid's (`grid_sync`). The page is one
  HTML file without WebAssembly, workers or network, for the hosts' default CSP. `registerVastgrid` adds the tools
  to another MCP server.
- `vastgrid-spec`, `vastgrid-js`, `vastgrid-duckdb`: messages are checked to their limits
  (§8.1) all through, plans, keys and values included: names and strings of at most 1,000,000 code points, 256
  levels of objects and lists, and 1,000,000 items in a list or members in an object. Errors follow the limits
  themselves: messages are cut to 1,000 code points and quote names shortened (`quoted`), and a path to a name
  beyond the limit names the object that holds it; paths escape `~` and `/`. A message without a valid `id` is
  answered with the `id` null instead of 0, which a request may have (`answerId`, `errorResponse`; the HTTP
  handler too). The DuckDB engine's `summarize` counts the cells of a column named twice once, as the memory
  engine does.
- `vastgrid-spec`: formulas (§4.11). `compileFormula` compiles 0.1's formula language, with every
  function of §4.4 by its name and literals of every type (`DATE '2024-01-31'`), to a plan expression, converting
  values as 0.1 did and reporting errors with a reason of §4.7 and the characters at fault; `formulaText` writes any
  expression of a derived column back as a formula that compiles to it. `migrateGridState` migrates 0.1's formulas
  into `plan.derive`, ordered by what they use, with the filters, sort keys, groups and measures that use them, and
  gives a reason for each part it drops (`reasons`). `checkExpression` checks one expression.
- `vastgrid`: the column and cell menus, the toolbar's menus, the find bar and the detail panel
  load when they first open, which takes 18 KB with gzip off what a page loads first; the toolbar's menus start
  from the state as it is when they open. Keys leave an IME's composition alone, and closing the detail panel from
  inside it (× or Esc) gives the focus back to the grid. `npm run size` (`scripts/bundle-size.mjs`) measures what a
  page loads first and fails over 100 KB with gzip; CI runs it.
- `vastgrid`: a find bar (⌘F or Ctrl+F; `GridStore.find`), a cell menu (right click,
  Shift+F10) that copies, filters to a value or excludes it, shows a value in full (`GridStore.fullValue`) and opens
  the details, and moving columns by dragging their headers; a click on a header sorts on release.
- `vastgrid`: column groups in header rows (`columnGroups`), whose headers select their
  columns; `cellText`, `cellStyle`, `drawCell` and `cellAction` with `onCellAction` (links and buttons in cells);
  ⌘/Ctrl+D and R to fill; `wrapLines`; and `detailPanel` with Alt+Enter for the detail panel. docs/migrating-from-0.1.md
  maps 0.1's features to 0.2.
- `vastgrid`: checked rows (`checkboxes`): a check box for each row and for every row of the view,
  Space to check the active row, rows kept by key across sorts and filters, and their count in the status bar; and a
  detail panel of the active row, opened from the toolbar's Details button (`detail.open`, `detail.close`).
- `vastgrid`: column formats (§5.1): number and date formats as in 0.1, alignment, labels,
  wrapped text (rows take two lines while a column wraps) and conditional colors, whose rules the grid evaluates for
  each cell and whose descriptions screen readers read. The column menu's Format… edits them (`column.format`).
- `vastgrid`: a Conditions menu in the toolbar edits the conditions of the view across columns,
  in nested groups of AND and OR (`filter.set`); a Columns menu shows, hides and moves columns; and the Group menu
  makes pivots (§4.6). A view that fails to read (a pivot with too many columns) keeps the view before and shows why
  in the status bar.
- `vastgrid`: column statistics (rows, values, empty, distinct, minimum, maximum, sum,
  average, median, standard deviation), a totals row at the bottom of the grid set from each column's menu
  (`column.total`), and grouping: from a column's menu, and the toolbar's Group menu of keys and measures
  (`group.set`, `group.clear`). The engine computes all of them as aggregates. `GridStore.aggregate` reads
  measures, and the snapshot's `totals` holds the totals row.
- `vastgrid`: a column menu, from the arrow at the right of each header, a right click or
  Alt+↓: sorting by the column, its filter (a list of its values with how many rows have each, read by the engine
  under the other filters, and a condition on typed text) as `filter.column`, and fitting, pinning and hiding the
  column. `GridStore.values` lists a column's values. Filtered columns show a funnel in their header.
- `vastgrid`: the toolbar's Formulas menu adds, changes, renames and removes derived columns
  written as formulas (`derive.add`, `derive.update`, `derive.remove`), and shows why a formula does not compile.
  The accessibility rows follow columns that come and go.
- `vastgrid-sql`, `vastgrid-duckdb`: decimals without whole digits, such as a
  `DECIMAL(1,1)` column, read and have the text form `0.5` (DuckDB writes `.5`, which failed to read), also in
  `text`, `concat`, search, `find` and pivot names (`textSql`); and `left`, `right` and `substr` give null for a
  null count or start (§3.6) instead of reading it as 0. Reads that began on the first rows of a file still loading
  (§9) no longer fail with a missing table when the whole file has loaded: its preview is kept until the table is
  closed.
- `vastgrid-duckdb`: `export` writes views as CSV, TSV, Parquet, JSON and Excel workbooks
  (§8.2), with the written cells, on the server: DuckDB writes the first four, and workbooks are streamed by a
  writer ported from 0.1 (numbers, dates and booleans as such cells, text never as a formula, Excel's limits as
  `export_too_large`). Files are complete or not there. The option `resolveTarget` lets exports be written where
  the host allows, never over a file that a table reads; without a target the engine keeps the file, which
  `exportFile` and the HTTP handler (`GET <path>/exports/<name>`) serve as a download.
- `vastgrid-spec`: the `export` command takes `rows: "table"` for every row of the table, and gives
  workbooks the Excel codes of the columns' number and date formats (`excelNumberFormat`).
- `vastgrid`: the toolbar's Export menu exports the view or the whole table in the engine's
  formats, and `httpTransport` downloads the file (`Transport.exportUrl`, `store.exportUrl`).
- `vastgrid-duckdb`: `save` writes the written cells into CSV and TSV files with the new
  option `saveFiles` (§7.5). Only the fields that changed are written anew, in the file's encoding and date
  formats; every other byte stays. The file is replaced through a temporary file next to it, and files changed by
  someone else since they were read (`file_changed`), links that lead elsewhere (`not_allowed`) and other formats
  (`save_unsupported`) are refused. After a save the table keeps its revision, row IDs and history.
- `vastgrid-spec`, `vastgrid-duckdb`, `vastgrid-js`: files that change on disk are followed
  (§7.6). The DuckDB engine watches the folders of open files (option `watchFiles`, on by default) and checks them
  on `changes` and `open`; a table without written cells is loaded again and its handles move to the new revision
  once it has loaded, while one with written cells is kept with `fileChanged: true` (in `TableInfo`, `changes` and
  the `changed` event). The new `reload` request moves a handle to the file as it is now.
- `vastgrid`: a file that changes on disk is shown anew; with unsaved edits, the status bar says
  that the file changed and the toolbar offers "Discard edits and reload" (`store.reload()`).
- `vastgrid`: ⌘S or Ctrl+S saves (from the cell editor too), the toolbar has a Save button,
  and the status bar counts the cells not saved and shows the outcome of the last save.
- `vastgrid-duckdb`: `write` writes cells of open files (§7.2). Written cells are kept
  apart from the file, in tables of the session read through a view over the file's values, so that rows, plans,
  summaries and find see them; writes are atomic, check `previous` and the revision, wait for a file that is
  still loading, and report `changed` events and the edits of `info`, `changes` and `rows`. Handles of a file
  share its written cells until the last one closes. Timestamps in nanoseconds beyond DuckDB's range are
  `invalid_value`, and keys and values of such timestamps are given to DuckDB as exact counts.
- `vastgrid-spec`, `vastgrid-js`, `vastgrid-duckdb`: reject out-of-range timestamp
  and interval counts, lone Unicode surrogates, and non-binary32 typed values before Arrow conversion.
  Float32 editing rounds to the declared type and rejects numeric overflow; invalid writes remain atomic.
  Read DuckDB nanosecond timestamps by their exact counts to avoid its text-cast overflow near the lower bound.
- `vastgrid-duckdb`: DuckDB saves sorted and filtered view positions instead of recomputing them for every scroll. Large
  inputs store only row IDs; smaller inputs and aggregates keep their output columns. Sort previews share the
  final order, the grid follows completion and cancels old reads, and queued plans wait until files finish
  loading. Shared builds, LRU cleanup and a configurable 8 GB spill limit bound their work. See
  [measurements and limits](docs/views-benchmark.md).

## 0.1.1 — 2026-10-23

Fixes.

- `vastgrid-duckdb`: decimal comparison and range filters preserve bounds finer than the column's
  scale instead of rounding them, including 38-digit columns and bounds outside the column's range.
- `vastgrid-core`: `ArraySource` preserves decimal digits when sorting, comparing, filtering ranges,
  and finding minimum and maximum values, including decimals beyond JavaScript's number precision.
- `vastgrid`: reloading a file follows column names when reapplying sort and filter conditions, even
  before the new schema is available; conditions on removed columns are cleared.
- `vastgrid-duckdb`: BOM-marked UTF-16 CSV files are decoded in their actual byte order, fixing
  corrupted column names and missing rows in UTF-16BE files.
- `vastgrid-duckdb`: column statistics with `NaN` or infinities compute the mean, standard deviation,
  quartiles and histogram over finite values, instead of failing the whole statistics request.
- `vastgrid-duckdb`: empty strings sort last in both directions alongside nulls, with secondary sort
  keys still applied, matching `ArraySource`.
- `vastgrid-duckdb`: files are opened by their real location (links followed), which must be inside the
  allowed directories, before the engine reads them itself to detect and convert their encoding. A
  Shift_JIS file outside them, or a link to one, could be read through the conversion. Exports are
  written to the real location of their folder, which must be allowed too. Refused paths answer
  `not_allowed` (403), and missing files `not_found` (404) instead of `internal_error`.
- `vastgrid-duckdb`: columns named `rowid` (or like the engine's own `__vg_row` and `__vg_position`)
  are read under another name in SQL and keep their names for clients and exports. Such a column used
  to empty every read or break sorting.
- `vastgrid-duckdb`: `distinct` counts and sends whole values, so values that share their first 4,096
  characters are no longer merged into one that filters to nothing; the most common values in column
  statistics are counted by whole values too.
- `vastgrid-core`: `ArraySource` compares and sorts integers beyond 2^53 exactly, finds the minimum and
  maximum of decimals given as text by value, and computes the standard deviation of large numbers
  without losing digits.
- `vastgrid-core`: `RowCache.read` reads whole text and stays on the view it started in, so copies are no
  longer cut at 2,000 characters or mixed from two orders when the view changes meanwhile.
- `vastgrid`: the filter panel sends integers beyond 2^53 and decimals as text, which servers compare
  exactly; copying a cell cut for display, and filtering by its value, use its whole text.
- `vastgrid`: a column widened for long numbers stops at 600 px without redrawing on every frame, and
  reading a changed file again keeps each column's width and visibility with that column and clears the
  selection summary.

- `vastgrid-duckdb`: a file that fails to load is reported to clients that poll `info`. It used to be
  loaded again on every poll, so the grid showed "Loading" forever while the server kept rereading the
  file. The `info` after the failure loads the file again (a retry).
- `vastgrid-duckdb`: view requests no longer cancel each other, so several grids or people can sort and
  filter one file at the same time. A request is cancelled by its own signal, also while it waits for
  its turn or for a connection.
- `vastgrid-duckdb`: error messages sent to clients leave out the server's folders and the SQL that
  DuckDB quotes.
- `vastgrid-duckdb`: a `rows` request reads at most 1,000,000 cells, and lists of columns must not repeat
  a column. One request could make the server run out of memory.
- `vastgrid-duckdb`: requests that open a changed file at the same time share one new table.
- `vastgrid-core`: `RemoteSource` recreates a view the server forgot for every request that waits for
  it, also when the request that started it gives up. Rows on screen used to stay blank after a server
  restart if the grid scrolled meanwhile.
- `vastgrid-core`: `RowCache` asks for failed blocks again by itself after `retryDelay` and never leaves
  a block loading without a request; `read` asks for about 200,000 cells per request, also for wide
  tables.
- `vastgrid`: a view that the server cancelled on its own is asked for once more and otherwise reported
  with a Retry button; when the server is loading the table again, the grid follows that load and then
  applies the view. The grid used to stay "Building view" with the sort shown but not applied.

Additions.

- `vastgrid-core`: `ErrorCodes` names every error code of the protocol, also `method_not_allowed`,
  `not_file` and `disposed`, which servers already answered and the protocol document now lists.
  `filtersRows(query)` tells whether a query leaves out rows rather than only sorting them, and
  `MAX_TEXT_LIMIT` is the `textLimit` that reads whole values.

## 0.1.0 — 2026-10-20

First release.

- `vastgrid`: canvas `DataGrid` for React with virtual scrolling beyond the browser's element-size
  limit, spreadsheet selection and keyboard, copy (TSV, HTML, Markdown), multi-column sort, filters
  (value list and conditions), search, find, column statistics, selection summary, column resize /
  fit / hide / freeze / reorder, Japanese and English texts, light and dark themes.
- `vastgrid-core`: table protocol, `RemoteSource`, `ArraySource`, row cache, selection and scroll
  models, formatting.
- `vastgrid-duckdb`: DuckDB table server for CSV, TSV, Parquet and JSON Lines (Shift_JIS and EUC-JP
  converted), views as sorted copies or position lists, sandboxed file access, Fetch API handler.
