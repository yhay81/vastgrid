# Changelog

## Unreleased

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
- `vastgrid`: copies cover every selected range. Ranges with the same rows are copied side by side and
  ranges with the same columns one below the other, in the grid's order and with overlaps once; other
  combinations are refused with a message and `CopyRangesError`. `copyLimit` counts all ranges, cells
  that are not loaded are read, and Escape cancels a copy that is still reading.
- `vastgrid-core`: `copyLayout(ranges)` gives the rows and columns that a copy of several ranges writes.

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
