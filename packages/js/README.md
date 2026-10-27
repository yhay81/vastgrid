# vastgrid-js

The JavaScript engine of [vastgrid v2](../../docs/v2-spec.md): it answers the messages of the specification
(§8) over tables in memory. It is a draft and is not published yet.

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({
  tables: {
    orders: {
      columns: [
        { name: "id", type: "bigint" },
        { name: "price", type: "decimal", precision: 10, scale: 2 },
      ],
      rows: [
        [1, "12.50"],
        [2, "8.00"],
      ],
    },
  },
});
const info = await engine.handle({ v: 2, id: 1, op: "open", ref: "orders" });
```

- `memoryEngine({ tables })` takes the tables that `open` opens, by their `ref`: columns of §2.1 and rows of
  typed JSON values (§2.2) in row ID order. The form of a table (its columns and rows of one value per column)
  is checked when it is first opened, and its values as they are read (a column whole before it is sorted or
  summed), so that opening a table of millions of rows takes milliseconds; a table that does not follow §2 is
  answered with `load_failed` and the JSON Pointer of the place at fault. Its rows are read as they are,
  without a copy, so they must not change afterwards.
- A table may also be given as Arrow: `{ arrow }`, the bytes of an Arrow IPC stream or file of any number of
  record batches (as `tableToIPC` of Flechette or Apache Arrow writes them), with `editable` as for rows. Its
  columns have the logical types of their Arrow types (§2.3), and none is `readOnly`. The engine keeps them as
  Arrow holds them, without a copy: integers, floats, dates, bigints, decimals of up to 18 digits, times and
  timestamps as typed arrays, which checks and sorts read as numbers, and the other values read from their
  buffers when they are asked for (`decodeColumns` of `vastgrid-spec/columns`). A million rows of integers,
  floats, dates, decimals, timestamps and strings take 258 MB as Arrow against 494 MB as rows, the host's rows
  included, and sort by a date, a decimal or a timestamp in 50–70 ms against 170–250 ms. Bytes that are not
  Arrow, Arrow types that have no logical type (lists, structs, …) and names that two columns share fail with
  `load_failed` at `/arrow`; values that have no typed JSON (text that is not UTF-8, dates after 9999-12-31)
  fail when they are read, at `/rows/{row}/{column}`. The code that reads Arrow loads with the first such table.
- A table may also be a text file: `{ file, format }`, with `file` a `Blob` or a `File` of CSV, TSV or JSON Lines
  in UTF-8, in a Web Worker or the page, and `format` `csv`, `tsv` or `jsonl`, by default from the file's name
  (`.csv`, `.tsv` or `.tab`, `.jsonl` or `.ndjson`); `editable` as for rows. It is read when it is first opened, in
  slices of 4 MiB and twice: once to find its columns, the types that all their values fit and the memory they
  take, then into typed columns, numbers in typed arrays (sorted as an Arrow table's are) and text as UTF-8,
  without making rows of JSON. The open waits for both; opens of a file share one reading, and a table that every
  ID has closed is read again. A CSV file of a million rows of six columns (55 MB) opens in about 0.9 seconds into
  32 MB, where the same rows as JSON take 248 MB. The code that reads files loads with the first such table.
- A table may also be a sheet of an Excel workbook (`.xlsx`, `.xlsm`): `{ file, format: "xlsx" }`, the format by
  default from the file's name. `open`'s `read` (§8.2) chooses the sheet (the first visible one by default), the
  row of the names (`headerRow`: by default the first row with a value; `0` for none, which names the columns by
  their letters) and whether empty rows and columns are kept (`keepEmptyRows`, `keepEmptyColumns`); `TableInfo`
  lists the workbook's `sheets`, the `sheet` read and `notes` (`merged_cells`, `formulas_without_values`). The sheet
  is read with `vastgrid-spec/workbook`, as the DuckDB engine reads it: a column has one type (`bigint`, `float`,
  `boolean`, `date`, `timestamp`, `time` or `string`) by its cells and their number formats, a formula its saved
  value, and a date the workbook's calendar. Its rows are kept as lines of CSV in a `Blob` and read as a CSV file
  is, within `maxBytes`; each set of `read` options is a table of its own, and other tables ignore `read`. A file
  that is not a workbook, and one that is encrypted or in the old `.xls` format, fail with `load_failed` at
  `/file`. The code that reads workbooks loads with the first such table.
- A file's column has the first of these types that every value of it fits, and is a `string` otherwise:
  `boolean` (`true` and `false` in any case), `integer` and `bigint` by their range, `float` (with `nan`, `inf`
  and `infinity`), `time` (`HH:MM:SS` with up to 6 fraction digits), `date` (`YYYY-MM-DD` of the years 0001 to
  9999), `timestamp` (a date, a space or `T` and a time; dates fit too) and `timestamptz` (a timestamp with `Z`,
  `+HH`, `+HH:MM` or `+HHMM`, kept in UTC). Text that is almost a value (`24:00:00`, ` 1`, `2023-02-29`) makes a
  string column, which keeps every value as it is written.
- CSV and TSV: the first line names the columns unless `header: false` (empty names are `column0`, `column1`, …,
  and a repeated name gets `_1`, `_2`, …). CSV's separator is `delimiter`, or the one of `,`, tab, `;` and `|` that
  splits the first line into the most fields. A quote switches quoting on and off wherever it is, so that quotes
  hold separators and line breaks and `""` within them is a quote; lines end with LF or CRLF, and empty lines are
  no rows. An empty field is null, and so are the fields that a row shorter than the others lacks; a quoted empty
  field (`""`) is an empty string, and null in a column of another type.
- JSON Lines: an object per line, and a column per key in the order the keys first come, null where a line lacks
  it. Numbers are what `JSON.parse` reads (integers beyond 2^53 are floats), strings are strings unless they are
  times, dates or timestamps, and a column of objects and lists only is their JSON text (`sourceType: "JSON"`,
  `readOnly: true`); a column of other values mixed is strings, with numbers and booleans as their JSON.
- A UTF-8 byte order mark is left out. A file in UTF-16, text that is not UTF-8 (at `/rows/{row}/{column}`; §2.2
  does not allow replacing it), a line of JSON Lines that is not an object (at `/rows/{row}`) and a file that cannot
  be read fail with `load_failed`. Answering the first rows while a file loads (§9) is a later step.
- `maxBytes` (default 1 GiB) is the most memory that a file's columns may take. A file whose columns would take
  more is not kept, as v1's browser engine kept none: its first reading notes where every 1,024th row starts, and
  the open answers then. Rows are read by those blocks, wherever they lie in a view, and the last 32 MiB of blocks
  read are kept; a sort, a filter, a group, a summary, `find`, `export` and `locate` by value read the columns they
  go through whole, in a reading of the file, while they fit `maxBytes`. A column read whole stays so until a
  request needs its room while no request reads it: the least recently used are forgotten first, and read again
  when a request needs them. A request that would read more at once fails with `load_failed` at `/maxBytes`, and
  the table stays open. The 10-million-row CSV file of the benchmarks (701 MB)
  opens so in 5 to 6 seconds into no memory with a `maxBytes` of 256 MiB, where kept it opens in 10 seconds into
  590 MB.
- A table may also be a Parquet file: `{ parquet }`, a `Blob` or a `File`, or the URL of a file whose server answers
  HTTP range requests (`headers` such as `Authorization` go with every request, and `fetch` replaces the global
  one); `editable` as for rows. Opening it reads its footer only. `rows` reads the row groups that hold its rows,
  column by column (hyparquet, with the codecs of hyparquet-compressors), and keeps them in a cache of 4 million
  cells; a sort, a filter, a group or a summary reads the columns it names whole into typed arrays, a row group at
  a time, and `find`, `export` and `locate` by value the columns they go through. The rows of a view that lie in
  more than two row groups, as a sorted or filtered view's do, read their columns whole too, so that scrolling
  the view reads memory rather than every row group again. `maxBytes` (default 1 GiB) is about the most memory
  that the columns read whole may take (numbers in typed arrays, booleans in a byte, text as strings, which the rows
  of a dictionary's value share), and columns read whole are forgotten as a text file's are: a request that would
  read more at once fails with `load_failed` at `/maxBytes`, the table stays open, and its rows are read by row
  groups. A million rows of eight columns (13 MB of Parquet) open in
  30 ms into 2 MB, show their first rows in 0.2 seconds, and take 130 MB once every column is read
  ([measurements](../../docs/v2-memory-engine-benchmark.md)).
- A Parquet file's columns have the types that DuckDB reads them as, with DuckDB's names as `sourceType`: integers
  by their width and sign (UINTEGER as `bigint`, UBIGINT as `decimal(38, 0)`), FLOAT and DOUBLE, decimals,
  BOOLEAN, DATE, TIME, timestamps of their unit (`timestamptz` when adjusted to UTC), INTERVAL, UUID, VARCHAR and
  enums as strings, BLOB as `binary`, and JSON as `readOnly` strings. Lists, structs and maps are `readOnly`
  strings of their JSON text, named as DuckDB names them (`INTEGER[]`, `STRUCT(a INTEGER)`). A URL's first answer
  gives its size and its `ETag` or `Last-Modified`, which every later answer must match: a file that changed fails
  with `file_changed`. Ranges read are kept in a cache of 32 MiB; a server that ignores `Range` sends the file
  whole, which is kept when it is at most 16 MiB and fails with `load_failed` otherwise. A server of another
  origin must expose `Content-Length`, `Content-Range` and `ETag` by CORS. The code that reads Parquet loads with
  the first such table.
- Float32 table values and writes must already be binary32 numbers (`Math.fround(0.1)`, not `0.1`);
  `readCellText` converts typed input to them. Invalid timestamps, intervals and lone Unicode surrogates
  are rejected by the same specification checks used to write Arrow blocks. An invalid write changes
  no cells and identifies the offending value with `/updates/{index}/value`.
- `engine.handle(message)` answers a request with its response or error, with blocks in the structured
  encoding (`{ bytes }`, §8.8), and never throws; `cancel` has no answer. `engine.subscribe(listener)` listens
  to the events of §8.5: `changed` after every write.
- The engine offers what `MEMORY_CAPABILITIES` reports (§4.10): every plan of §4.1 (derive, `where`, search,
  `aggregate` with `pivot`, `having` and sort), with every function of §4.4 and every measure of §4.5,
  `summarize`, `find`, `locate`, `export` of CSV, TSV, JSON and xlsx, and `write` for tables given with
  `editable: true` (§7.2: by row ID or by `rowKey`, every update or none, with `previous` checked, and a `changed`
  event). Written values are kept apart from the host's rows, bytes or file, which stay as they were: the engine keeps
  them by row and column over the column, without a copy of it, so that a write takes the memory of the values
  written. A table that holds them keeps them when it is closed. Other plans fail with
  `invalid_plan` (`unsupported`) only when they name functions or members that a later version adds, `write` on
  other tables with `read_only`, `save` with `save_unsupported`, and an `export` of Parquet with `invalid_request`
  at `/format`.
- `find` goes through the view's cells row by row from the cell after `from` and compares their text forms (§2.4)
  by `lower`, as the DuckDB engine does. `export` answers the file's bytes as `data` (`delivery` `data`, §8.2) and
  takes no `target`: CSV, TSV and JSON as DuckDB's `COPY` writes them (`vastgrid-spec/export`) and workbooks with
  `vastgrid-spec/xlsx`, compressed with the platform's `CompressionStream`. The file is made in memory, a batch of
  rows at a time, so it takes about its size besides the table; a grid downloads it as a file
  (`URL.createObjectURL`). That is how a page saves: the engine writes no file, and the `File` that a table was
  opened from stays as it was.
- A request that goes through many rows (`find`, `export`), reads a file's columns whole or ranks the text of the
  columns that a view sorts or groups by lets other messages in every 40 ms or so, so that a `cancel` of it is read:
  it then stops with `cancelled` (§8.6) within a few milliseconds. The rest of a view (ranking numbers, sorting,
  filtering, grouping and deriving) runs to its end, and the view is kept; a cancel of it answers `cancelled` after.
- Expressions are compiled once per view to functions of a row ID (§3.6, §3.7, §4.4): exact numbers are
  computed as integers at their scale, with BigInt where a number would not be exact, so a result that does not
  fit its type is null rather than rounded; floats are 64-bit, and results that are not finite are null.
  Strings compare by code point, and `lower` and `upper` map code points one by one as DuckDB 1.5 does (`İ` →
  `i`, `ß` → `ẞ`). Derived columns are computed for every row of the table, then `where` keeps the rows of the
  view; `locate` gives null for rows that it leaves out. A million rows derive a decimal product, filter by it
  and sort by it in about 0.7 seconds.
- Groups are made from the ranks of their keys, so that values equal by §3.1 make one group (every NaN, −0.0 and
  0.0) and groups come in the order of §3.9; each measure keeps its state per group, or per group and pivot
  combination. Sums of exact numbers are exact, and null when they do not fit decimal(38, s); averages come
  from the exact sum; `stddev` is Welford's sample standard deviation and `quantile` interpolates as DuckDB's
  `quantile_cont`. Approximate measures are computed exactly. A view of groups has no row IDs: `rows` answers
  `rowIds` null, `locate` finds values of a key of the view (by `rowKey`) and nothing by row ID. A million rows
  group by 1,000 keys with four measures and sort in about 0.5 seconds.
- Plans that derive, filter or group are run by a module of their own, loaded with the first such plan, so that
  pages whose plans only sort do not load it.
- Views are in the order of §3.3. Each column's values are ranked once, by a radix sort of their bits for
  values of fixed width and by code point for strings; a view is then one counting sort per sort key. A
  million floats sort in about 0.2 seconds. Intervals compare as DuckDB 1.5 compares them (`normalizeInterval`
  of `vastgrid-spec`): whole days of the time go into the days, then whole 30-day months of the days into the
  months, truncating, and the parts compare in that order.
- `locate` finds a value of `rowKey` at its first position in the view; `summarize` counts each cell of
  `ranges` × `columns` once, sums exact numbers exactly, and gives floats that are not finite as cells but
  not as numbers.

The tests run every case of the conformance corpus of [`vastgrid-spec`](../spec), with its tables as rows and as
Arrow, check the order of both against a comparison of values one pair at a time on generated tables, and check
every response with `checkResponse`. Files are read in slices of every size from 1 byte, and a generated CSV file
answers sorts, filters, groups and summaries as the same rows given as typed JSON. The
DuckDB engine's tests compare this engine's answers with its own on a generated table and generated plans
(`packages/duckdb-engine/test/memory-engine.test.ts`), with the table as a Parquet file that DuckDB wrote too: the
same columns, and the same answers. Another test serves a Parquet file over HTTP and counts the bytes that opening,
reading rows and sorting read. `packages/duckdb-engine/bench/memory-engine.ts` measures a million rows as CSV and as
Parquet ([results](../../docs/v2-memory-engine-benchmark.md)).
