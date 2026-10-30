# Changelog

## Unreleased

### New

- `vastgrid-spec`, `vastgrid-js`, `vastgrid-sql`, `vastgrid-duckdb` and the Python package `vastgrid`: `quantile`
  measures dates, times, timestamps and `timestamptz` values (§3.8), as DuckDB's `quantile_cont` does: in
  microseconds, rounded to the nearest one with halves away from zero, as a timestamp for dates and timestamps.
  The median of `2024-01-01` and `2024-01-02` is `2024-01-01 12:00:00`. `vastgrid`'s column statistics show the
  median of such columns.
- The Python package `vastgrid`: `.xlsm` workbooks open, as `.xlsx` ones do.
- `vastgrid-spec`: the specification settles what `vastgrid-js` answered as open questions: intervals compare by
  their length (§3.1); `locate` finds values equal by §3.1, at their first position; `summarize` MAY sum exact
  numbers exactly; an operation that the capabilities leave out is `unknown_op` (§8.7); and `planHash` needs a
  secure page (§4.8).
- `vastgrid-mcp`: the App's Export menu downloads its file through the host (ext-apps' `downloadFile`), from the
  App's new tool `grid_export_file`, up to 64 MB; the menu says when the host does not download files.
- `vastgrid`: `Transport.downloadExport` and `GridStore.downloadExport` download an export's file where a link to
  `exportUrl` cannot, and the Export menu uses them first.

### Fixes

- `vastgrid-js`, `vastgrid-sql`, `vastgrid-duckdb` and the Python package `vastgrid`: the key of the group of
  −0.0 and 0.0 is 0.0 whichever comes first (§3.9), and so are a pivot's values and the names of its columns
  (`0.0 / n`, not `-0.0 / n`), where the engines kept the first row's.

## 0.3.0 — 2026-10-30

### Breaking changes

- `vastgrid`: the grid's texts are English unless `messages` gives others, and each other language is its own
  import, so that a page bundles only the languages it shows: `<DataGrid locale="ja" messages={ja} />` with
  `import { ja } from "vastgrid/locales/ja"`. `locale` sets the formats of numbers and dates alone; a `locale` or a
  browser language of `ja` no longer shows Japanese texts by itself. `messagesFor` moved from `vastgrid` to
  `vastgrid/locales`, which gives every set. The first load of a page that shows English is 9.5 KB smaller (2.4 KB
  with gzip).

### New

- `vastgrid`: texts in Chinese in simplified and traditional characters (`vastgrid/locales/zh-Hans`, `zh-Hant`),
  Korean (`ko`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`) and German (`de`), besides Japanese
  (`ja`) and English (`en`). `messagesFor(locale)` of `vastgrid/locales` chooses one by a tag's language.
- `vastgrid-cli`, `vastgrid-mcp`, `vastgrid-vscode` and the Python package `vastgrid`: the grid follows the
  browser's, host's or VS Code's language, or the notebook's `locale`, in all nine languages.

### Release

- `vastgrid-vscode`: the extension's script is minified, 417 KB instead of 921 KB (113 KB instead of 165 KB with
  gzip), so that VS Code loads it faster.

## 0.2.2 — 2026-10-29

### Fixes

- `vastgrid-sql`, `vastgrid-duckdb` and the Python package `vastgrid`: a product of two decimals of up to 18 digits
  each keeps every digit of its type (§3.7) instead of being null past 18 digits, as DuckDB computes such products
  in 18 digits: `99999999.99 × 99999999.99` is `9999999998000000.0001`.
- `vastgrid-spec` and the Python package `vastgrid`: the text of a 32-bit float at a power of two whose nearest
  digits read back as the float below, such as 2⁻⁹⁶, has the shortest digits (§2.4.1), as DuckDB writes it:
  `1.2621775e-29`, not `1.26217745e-29`.
- `vastgrid-spec`: the TSV of a copy whose last row is one empty cell, such as an empty cell below a copied one, ends
  with one more line feed, so that pasting it gives that row back (§6.6): `Tokyo\n\n`, not `Tokyo\n`, and `\n` for
  an empty cell alone.
- `vastgrid-js`: `quantile` weighs the two closest ranks as DuckDB's `quantile_cont` does, so that a quantile
  between the largest floats of either sign is a number, not null.
- `vastgrid`: two single quotes in a date pattern show a quote, as the Excel export writes them. A click in the
  gutter below the last row no longer selects the last row or toggles its check box. The number of copied cells read
  out after a copy counts a cell with a tab or a line break as one cell.

## 0.2.1 — 2026-10-28

### Fixes

- `vastgrid-duckdb`: CSV and TSV files inside `key=value` folders keep their own columns and values. Quoted
  fields appearing after the sniff sample are decoded correctly, including doubled quotes, on reads and saves.
- `vastgrid-duckdb`: CSV uses comma and standard double quotes so that single quotes, semicolons and pipes in
  values are preserved. `open.read.delimiter` selects other separators; `open.read.headerRow` now applies to
  CSV and TSV too (`0` for no header, `1` for the first record). Both options survive saves and reloads.
- `vastgrid-duckdb`: gzip and zstd CSV/TSV files have their encoding detected and converted after decompression,
  including UTF-16 and Shift_JIS. Late invalid UTF-8 also converts decompressed text.
- `vastgrid-duckdb`: valid records longer than 64 MiB load with their column types. The line and buffer limits
  grow only when needed, using one reader thread and the configured memory limit.
- `vastgrid-duckdb`: a CSV or TSV file whose records DuckDB's strict parser refuses, such as one with line breaks
  of both kinds (a row appended with LF to a file of CRLF lines), keeps its column types: it is read without
  strict records (`strict_mode=false`) before being read as text. Only DuckDB's error of invalid UTF-8 converts a
  file with replacement characters (`invalid_utf8_replaced`); the error of a failed sniff no longer does. Such a
  file is not saved (`save_unsupported`), as a file read as text was not.
- `vastgrid-duckdb`: a CSV or TSV file with line breaks of both kinds and a line break in quotes opens: when
  DuckDB's strict sniffer refuses it while choosing how to read the file, it is read in one thread.

### Release

- All npm packages and the Python package are released at 0.2.1. The VS Code extension is available as
  platform-specific VSIX files on the GitHub release; Marketplace publication remains deferred.

## 0.2.0 — 2026-10-28

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

### New in 0.2

- `vastgrid-spec`: the specification as code. Types and values, plans (§4) with their checking, the document,
  the session and the commands (§5–§6), the messages between a grid and its engine (§8) with their JSON schemas and
  limits, formulas in 0.1's language (§4.11), and a conformance corpus that every engine answers.
- `vastgrid-js`: the memory engine, in the page or a Web Worker, in the browser or Node.js. It takes rows of typed
  JSON, Arrow, CSV, TSV and JSON Lines files, sheets of Excel workbooks, and Parquet from a `File` or a URL read by
  row groups over HTTP Range requests; it evaluates every plan, writes cells, finds, and exports as CSV, TSV, JSON
  and Excel.
- `vastgrid-duckdb` and `vastgrid-sql`: the DuckDB engine for Node.js, on DuckDB 2.0. Files of any size (Parquet
  in place, the others loaded with their first rows readable at once), inside the folders allowed only, with every
  value passed to SQL as a parameter. It writes cells, saves CSV and TSV files with only the edited fields written
  anew in the file's encoding, follows files that change on disk, exports as CSV, TSV, Parquet, JSON and Excel, and
  serves the messages over HTTP (`createHttpHandler`).
- `vastgrid`: the grid on a canvas, with a store in `vastgrid/core` and transports to an engine in the page, a
  worker, a server or a React Server Function. The toolbar's menus (Conditions, Columns, Formulas, Export, Save), a
  menu on every column (sort, filter, statistics, totals, group, pin, hide, formats), groups and pivots, a totals
  row, a find bar, a cell menu, column groups, checked rows and a detail panel. Edits are checked against the
  column's type, conflicts offer Retry, Overwrite or Discard, and writes can be undone. `readInitialView` of
  `vastgrid/server` renders the first rows on the server. English and Japanese, themes by CSS variables, and the
  ARIA grid pattern.
- The apps, each with DuckDB: `vastgrid-cli` opens files in the browser with one command, `vastgrid-mcp` is an MCP
  server whose App shows the agent's grid to the person, `vastgrid-vscode` is an editor for VS Code, and the Python
  package `vastgrid` is a Jupyter widget. The site's page `/open/` opens a file in the browser with the memory
  engine in a worker.

### Fixes

- `vastgrid`: loading-completion events received before the table's open response are retained, so sorting and
  filtering do not wait indefinitely when an HTTP event overtakes its response.
- `vastgrid`: grids sharing a worker transport keep their requests and tables separate; reading, editing and
  cancelling in one grid no longer reaches another grid's request. Clients of one engine use distinct request IDs.
- `vastgrid-duckdb`: malformed export URLs return 400, and a connection closed during a request body no longer
  terminates a server using `createHttpHandler` directly.
- `vastgrid-duckdb`: saving an empty string to CSV or TSV fails with `save_unsupported`, keeping the original
  file and pending edits. The current reader treats even quoted empty fields as null, so they cannot preserve
  an empty string; saves previously succeeded and silently changed the value on reopening.

### Release

- One tag builds every package: the npm packages, the Python package on PyPI and the VS Code extension's VSIX
  files for each platform on the GitHub release. Version 0.2.0's Marketplace listing is deferred; install its
  platform-specific VSIX from GitHub. The release workflow supports explicitly disabling Marketplace publication.
  Existing npm packages use trusted publishing with provenance; new package names require an initial manual
  publication before their trusted publisher can be configured (CONTRIBUTING.md).
  Pre-releases are `0.2.0-next.N` on npm's `next` tag and `0.2.0rcN` on PyPI (CONTRIBUTING.md).
  `npm run pack-check` tries the packed packages as their READMEs show them before each release.

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
