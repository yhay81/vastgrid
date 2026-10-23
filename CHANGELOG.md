# Changelog

## Unreleased

Fixes.

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
