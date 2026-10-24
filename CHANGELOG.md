# Changelog

## Unreleased

- `vastgrid-duckdb`: with `saveFiles` (and `editable`), `saveEdits` and the `save` request write edited
  cells back into the CSV or TSV file. Only the edited fields of records with cells written since the
  last save are written anew; every other byte stays — the byte order mark, the header, other records
  (also with quoted line breaks), the other fields of edited records, delimiters, line breaks and the
  final line break — in the file's encoding (UTF-8, UTF-16, Shift_JIS, EUC-JP, Latin-1). The file is
  written to a temporary file next to it and renamed over it; a file changed by someone else meanwhile is
  not saved (`file_changed`), a failed or cancelled save leaves it as it was, and only files at their real
  location in the allowed folders are saved. Compressed files, files read as irregular text, files with
  comments and other formats are refused (`save_unsupported`). The table keeps its revision and rows.
- `vastgrid-core`: `TableSource.saveEdits`, `capabilities.save`, `SaveResult`, the `save` request and the
  error codes `file_changed` and `save_unsupported`; `RemoteSource.saveEdits`.
- `vastgrid`: while edited cells are not saved into a source that saves, a line above the status bar says
  how many, with "Save to file"; ⌘/Ctrl + S and the ref's `save()` save them.

- `vastgrid`: ⌘/Ctrl + D fills down and ⌘/Ctrl + R fills right in a grid that edits (also "Fill down" and
  "Fill right" in the context menu): the first row (column) of each selected range is copied into the
  rest of it, and a range of one row (column) takes the one above (left of) it. Values are copied as
  they are, never extended into a series, checked for their target columns, and written as one write that
  one undo reverts, also into rows that are not loaded, up to `copyLimit` cells. There is no fill handle.

- `vastgrid`: ⌘/Ctrl + Z undoes the last saved write in a grid that edits, and ⌘/Ctrl + Shift + Z (or
  Ctrl + Y) redoes it, also from the context menu. Each write is one step (a paste or a cleared range at
  once), and undoing writes the values before, with their types and digits, as a new write: a cell
  changed meanwhile by someone else is a conflict to overwrite or discard. Undo and redo wait for writes
  that are saving or failed; a new write drops the redo steps, and a new revision forgets the history.
  Values not loaded are read before they are overwritten, so that every write can be undone.
  `onHistoryChange` and the ref's `undo()`, `redo()` and `history` let apps offer them.
- `vastgrid-core`: `EditHistory` keeps undo and redo steps of written cells, bounded to 100 writes,
  1,000,000 cells and 32,000,000 characters.

- `vastgrid`: ⌘/Ctrl + V (and "Paste" in the context menu) pastes cells copied from Excel, Numbers, Google
  Sheets or web pages into a grid that edits: from the selection's top-left cell, repeated over a
  selection that is a whole multiple of them, one value into every selected cell of several ranges, and
  without the rows and columns past the end of the table (never adding rows). Every value is checked
  first (numbers may group digits with commas); one value that does not fit refuses the paste. The cells
  are written as one write of at most 100,000 cells, and Esc cancels a paste that reads rows first.
- `vastgrid-core`: `parseTsv` and `parseHtmlTable` read the clipboard's tab-separated values (quoted
  fields with tabs and line breaks) and HTML tables (`colspan`, `rowspan`) without a DOM;
  `parseCellInput` takes `{ grouping: true }` for grouped digits.

- `vastgrid`: cells can be edited in grids whose source can write them (`capabilities.edit`). Typing
  replaces the active cell's value (also with an IME: the editor is a text field over the cell), F2 or a
  double click edits it, Enter and Tab save and move, Alt+Enter starts a new line, Esc cancels, and Delete
  clears the selected cells. Values are checked against the column's type and by `validateCell` (also
  asynchronous); writes show while they save, and failed writes and conflicts with changes made meanwhile
  offer Retry, Overwrite or Discard. After a write the grid reads the rows again without blinking and,
  when its sort, filters or search use the written column, creates its view again in place. `readOnly`
  keeps a grid read-only, and `onCellsChange` reports saved and failed writes. In a grid that edits, F2
  and a double click open the editor instead of the cell inspector (which stays in the context menu);
  `onCellDoubleClick` can prevent both. Read-only sources work as before.
- `vastgrid-core`: `TableSource.updateCells` writes cells of sources that report `capabilities.edit`, all
  or none, by the row's position in the table (`rowIds`) and its `revision`, refusing values that do not
  fit (`invalid_value`), cells changed meanwhile (`edit_conflict`), other revisions (`revision_changed`)
  and read-only columns (`ColumnSchema.readOnly`). Writes change `TableInfo.edits` instead of the
  revision, so checked rows stay checked. `ArraySource` writes with `editable: true`; `RemoteSource` and
  the protocol carry the `update` request and report other clients' writes. `parseCellInput` and
  `normalizeCellValue` check values without losing digits (64-bit integers and decimals stay text).
  `RowCache.invalidate()` reads rows again while showing the old ones, and `RowCache.patch()` sets a
  loaded cell.
- `vastgrid-duckdb`: `TableEngine` writes cells with `editable: true`. Written values are kept in the
  engine, apart from the file, and every request (rows, views, statistics, summaries, find, exports)
  reads them; reading rows of a 5M-row table stays at 3–4 ms per block. Views that depend on a written
  column are dropped. A table with written cells is not closed to keep `maxTables`, nor opened again when
  its file changes.

- `vastgrid`: `checkboxSelection` adds row checkboxes, separate from the cell selection. Checked rows
  are kept by key — the row's position in the file for one `revision`, or the values of a `rowKey`
  column — so the same records stay checked when the view is sorted or filtered. The corner checkbox
  checks every row (or every row matching the filters) without listing keys. `rowSelection`,
  `onRowSelectionChange`, `getRowSelection()` and `setRowSelection()` let the app read, set and follow
  them; a new revision (also from appended rows) unchecks rows keyed by position. Space and ⌘/Ctrl +
  Shift + Space check rows from the keyboard (Space on a `cellAction` link or button only clicks it),
  and screen readers hear the active row's checkbox.
- `vastgrid-core`: `RowSelection`, `RowKey`, `RowSelectionModel` and `parseRowSelection`. Row positions
  (`rowIds`) are documented to stay stable for a table's `revision`.
- `vastgrid`: an "Export" button in the toolbar opens a panel to choose the format, the rows (the current
  view with its filters, search and sort, or the whole table), the columns (shown, in display order, or
  all), whether to use the labels and formats of `columnFormats`, and the file name. It offers the formats
  of the source, shows progress, failures and Excel's limits, and cancels. `exportOptions` lets the app
  decide the target (`target`) and receive the result (`onExported`); without it, data returned by the
  source is downloaded. `exportOptions={false}` hides the panel and `openExport()` opens it. `runExport`,
  `exportRequest`, `exportSupport` and `downloadBlob` build other export UIs.
- `vastgrid-core`: exports can write Excel files (`format: "xlsx"`). `ExportRequest` takes `headers` and
  (for xlsx) `numberFormats`; `TableInfo.exports` lists the formats and whether the source writes a file
  (`delivery: "file"`) or returns its data (`"data"`, `ExportResult.data`); `export_too_large` refuses
  results that do not fit in an Excel sheet. The protocol, `parseProtocolRequest` and `RemoteSource` carry
  them.
- `vastgrid-core`: `ArraySource` exports CSV, TSV, JSON and xlsx as a `Blob` (`capabilities.export` is now
  `true`). `writeXlsx`, `writeTableFile`, `excelNumberFormat` and `browserDeflate` write files without
  dependencies, as streams. Excel files keep numbers that a double cannot hold as text, write dates as
  Excel dates (timestamps with a zone in UTC), never write text as a formula, and cut text at 32,767
  characters.
- `vastgrid-duckdb`: `exportView` writes xlsx from a stream of DuckDB chunks (a million rows of eight
  columns in about 7 s and 58 MB, with the memory of a CSV export), writes `headers` into CSV and TSV
  files, refuses more than 1,048,575 rows or 16,384 columns for xlsx, and deletes the partial file when an
  export is cancelled. An export of a file that changes (the table is closed and opened again, or the
  file's revision differs when it ends) is stopped with `cancelled`, and the grid's panel reports
  `ExportInterruptedError` when the source reports a change during an export. `info` reports `exports`,
  and leaves it out when the handler has no `resolveTarget`.
- `vastgrid`: a detail panel shows every column of the active row, with the columns' labels and
  formatted values, beside the grid (below it when the grid is narrow); rows keep their height. It follows
  the active cell, reads cut values in full for that row and cancels the read when you move on, and shows
  the new active row after sorting, filtering or reloading. `detailOpen`, `defaultDetailOpen`,
  `onDetailOpenChange`, `openDetail()` and `closeDetail()`, Alt+Enter and the cell menu open and close it,
  and `detailPanel` replaces its content with a component (`DetailPanelProps`). `DetailTracker` reads the
  record outside React.
- `vastgrid`: `wrap` in a column's format wraps its text onto up to `maxLines` lines (a new prop, 3 by
  default), breaking at spaces, between CJK characters (with Japanese line-breaking rules for
  punctuation and brackets) and at line breaks in the value; longer text ends with "…". Rows keep one
  height for all rows, `rowHeight` plus `--vg-line-height` for each further line while a visible column
  wraps, and the first visible row stays in place when it changes. The controller has `rowHeight`,
  `maxLines`, `setMaxLines` and `setLineHeight`.
- `vastgrid-core`: `ColumnFormat.wrap`, `ColumnFormatter.wrap` (its `format` then keeps line breaks)
  and `ValueFormatter.lines`.
- `vastgrid`: `onSelectionChange`, `onColumnsChange`, `onCellClick` and `onCellDoubleClick` report the
  selection, changes of the columns' width, order, visibility and freezing, and clicks on cells (Space
  and F2 from the keyboard; `preventDefault()` keeps the cell inspector closed). Events give a cell's row
  in the view, its row in the original table and its column both in display order and in the schema,
  and are sent only for changes, not for scrolling or drawing. The controller offers the same events.
- `vastgrid`: `getState()`, `applyState(state)`, `initialState` and `onStateChange` save and restore the
  query and the columns' order, set widths, visibility and freezing as versioned JSON. Columns are kept
  by name, so a state applies after the file's columns changed; a state applied before the table has
  loaded waits for its columns.
- `vastgrid-core`: `GridState`, `parseGridState` (checks values from storage and reads a saved
  `ViewQuery` as a state), `resolveGridState` and `parseViewQuery`.
- `vastgrid`: `columnFormats` sets a column's label, number format (fraction digits, currency, percent,
  notation, prefix and suffix), date format (a pattern such as `yyyy/MM/dd HH:mm`, or `Intl` options and
  a time zone), alignment and a format function, by schema name. Sorting, filters, statistics and
  exports keep working on the values; changed settings redraw the column and fit its width again
  unless it was sized by hand. `copyValues` (and a column's `copy`) chooses whether copies hold the
  values (the default) or the shown text.
- `vastgrid-core`: `ColumnFormat`, `NumberFormat`, `DateFormat` and `ColumnFormatter`
  (`ValueFormatter.column(schema, format)`), which formats 64-bit integers and decimals from their
  digits without converting them to JavaScript numbers.
- `vastgrid`: a column's `style` in `columnFormats` colors cells by value (text color, background, and a
  description for screen readers) and keeps the standard drawing. `drawCell` draws the visible loaded
  cells on the canvas with their rectangle, value, type, text, selection state and theme, and can call
  the standard drawing (`drawDefault`). `cellAction` makes cells links or buttons: a pointer cursor, links
  underlined in the new `--vg-link-fg`, the `link` or `button` role on the active cell for screen
  readers, and `onCellClick` on a click or Space. Frames of 1,349 cells take as long as before.
- `vastgrid-core`: `CellStyle`, `ColumnFormat.style` and `ColumnFormatter.style(value)`.
- `vastgrid`: copies cover every selected range. Ranges with the same rows are copied side by side and
  ranges with the same columns one below the other, in the grid's order and with overlaps once; other
  combinations are refused with a message and `CopyRangesError`. `copyLimit` counts all ranges, cells
  that are not loaded are read, and Escape cancels a copy that is still reading.
- `vastgrid-core`: `copyLayout(ranges)` gives the rows and columns that a copy of several ranges writes.
- `vastgrid-duckdb`: sorts of tables with at least `viewPreviewMinRows` rows (1M by default) answer
  requests that accept a preview with their first `viewPreviewRows` rows (1,000), read with a top-N
  query in the order of the finished view (ties broken by the position in the file), and build the rest
  of the view in the background. Builds that nobody follows stop when another view of the table waits
  (`abandonedViewTimeout`). While a view builds, rows past the first ones, `find`, `export`, summaries
  past the first rows and the statistics of filtered views answer `not_ready`.
- `vastgrid-core`: the protocol's `view` request takes `preview`, a new `status` request returns the
  state of a view, and `ViewInfo` has `status`, `readableRows` and `error`. `TableSource.createView`
  takes `{ preview }` and sources may implement `viewInfo`; `RemoteSource` does both, and recreates a
  forgotten view as a preview.
- `vastgrid`: a sort shows its first rows as soon as the source has them ("Sorting… showing the first
  1,000 of 100,000,000 rows") and the rest once the view is ready, without moving the rows shown.
  Copies past the first rows and find say that they wait for the sort, the selection summary waits, and
  statistics of a filtered view are disabled until then. `ViewBuildingError` is exported.
- `vastgrid-duckdb`: Excel workbooks (`.xlsx`, `.xlsm`) open like other table files. The engine reads
  them itself, with no dependency or DuckDB extension: the sheet is streamed into a CSV file with one type
  per column (integers, numbers, booleans, dates, timestamps, times or text), which DuckDB loads. Formulas
  show their saved values and are never calculated; merged cells keep their value in the top-left cell.
  Encrypted, `.xls` and `.xlsb` workbooks and damaged files fail with a reason. A 1M-row, 8-column
  workbook opens in about 8 s.
- `vastgrid-core`: the `info` request takes `read` (`ReadOptions`: `sheet`, `headerRow`, `keepEmptyRows`,
  `keepEmptyColumns`), validated by `parseProtocolRequest`; `RemoteSource` sends its `read` option.
  `TableInfo` has `sheets` and `sheet` for workbooks, and the notes `merged_cells` and
  `formulas_without_values`.
- `vastgrid`: the status bar explains the new notes in English and Japanese.
- `vastgrid-browser` (new): `BrowserSource` reads local Parquet, CSV, TSV and JSON Lines files, and
  Parquet files at a URL with HTTP Range requests, in a Web Worker, with no server. Local files can be
  sorted, filtered, searched and summarized in the worker, with the same results as `ArraySource` and
  `vastgrid-duckdb`; URLs read only what the grid shows, check the file's `ETag`, and handle servers
  without `Range` or `HEAD`, unknown sizes and authentication headers. Requests can be cancelled, and
  `close()` ends the worker.
- `vastgrid-core`: `TableSource.subscribe(listener)`, optional, reports that a whole table changed
  (`TableChange`, with the new revision when known); single rows are not reported. `RemoteSource` watches
  its table while it has subscribers with a replaceable `changes` transport: `pollChanges()` (the
  default, every 2 seconds) sends the new `revision` request, reports each new revision once, catches up
  after failed requests and stops for servers without the request; `changes: false` turns it off.
- `vastgrid-duckdb`: the `revision` request answers a file's current revision, and `OpenTable` has
  `currentRevision()`. A file's revision (`fileRevision`) now includes a hash of its first 64 KiB, so a
  rewrite with the same size and modification time is seen too.
- `vastgrid`: a grid whose source reports a change reads the table again, merging changes within
  `changeDelay` (300 ms), and stops listening when it stops or unmounts. Reloads, including `reloadKey`,
  keep the query, the column settings, the scroll position and the active cell instead of going back
  to the first row. `followTail` shows the new end after a change when the last row was shown.
- `vastgrid-browser`: files at a URL are watched while a grid subscribes, by a `HEAD` request comparing
  their `ETag`, `Last-Modified` or size every `changeInterval` milliseconds (5,000); a changed file is
  opened again. Local files cannot be watched.
- `vastgrid-core`: `ViewQuery.where`, a condition tree (`FilterNode`: filters and `and` / `or` groups)
  that is combined with `filters` by AND. It expresses OR across columns, nested groups and several
  conditions on one column. `parseProtocolRequest` validates it (at most 8 levels, 256 groups and
  conditions and 100,000 listed values) and drops empty groups; `TableCapabilities.conditions` tells
  whether a source evaluates trees. `ArraySource`, `RemoteSource`, saved states (`parseGridState`,
  `resolveGridState` map the tree's columns by name) and the helpers `matchesFilterNode`,
  `pruneFilterNode`, `mapFilterNode`, `filterLeaves`, `queryFilters` and `queryCondition` support it.
- `vastgrid-core`: in `ArraySource` value lists, `""` no longer matches a missing value (`null`), and
  numbers match by value (`"1.5"` matches the decimal `1.50`), as the DuckDB engine does.
- `vastgrid-duckdb`: evaluates condition trees in parameterized SQL, with the same meaning for blanks,
  text, numbers, decimals, 64-bit integers, dates and times as `ArraySource`. Value lists that mix
  numbers and text on 64-bit integer columns compare exactly.
- `vastgrid-browser`: evaluates condition trees when the table can be scanned (`fullScan`).
- `vastgrid`: a condition builder ("Conditions…" in the toolbar, and "Add condition (AND / OR)" in a
  column's filter panel) builds AND / OR groups, and the toolbar shows the conditions to change or remove
  them. Columns used in the conditions show the filter mark. The builder is offered only for sources that
  report `capabilities.conditions`. The controller has `condition`, `setCondition()` and `isFiltered()`.

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
