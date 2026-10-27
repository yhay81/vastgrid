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
  be read fail with `load_failed`. `maxBytes` (default 1 GiB) is the most memory that the table's columns may take:
  a file whose columns would take more fails before any of them is kept. Parquet files read by HTTP range requests,
  and answering the first rows while a file loads (§9), are later steps.
- Float32 table values and writes must already be binary32 numbers (`Math.fround(0.1)`, not `0.1`);
  `readCellText` converts typed input to them. Invalid timestamps, intervals and lone Unicode surrogates
  are rejected by the same specification checks used to write Arrow blocks. An invalid write changes
  no cells and identifies the offending value with `/updates/{index}/value`.
- `engine.handle(message)` answers a request with its response or error, with blocks in the structured
  encoding (`{ bytes }`, §8.8), and never throws; `cancel` has no answer. `engine.subscribe(listener)` listens
  to the events of §8.5: `changed` after every write.
- The engine offers what `MEMORY_CAPABILITIES` reports (§4.10): every plan of §4.1 (derive, `where`, search,
  `aggregate` with `pivot`, `having` and sort), with every function of §4.4 and every measure of §4.5,
  `summarize` and `locate`, and `write` for tables given with `editable: true` (§7.2: by row ID or by `rowKey`, every update or none, with
  `previous` checked, and a `changed` event). Written values are kept apart from the host's rows or bytes, which
  stay as they were: a write changes the engine's own copy of a column. A table that holds them keeps them when it
  is closed. Other plans fail with `invalid_plan`
  (`unsupported`) only when they name functions or members that a later version adds, `write` on other tables with `read_only`, `save` with `save_unsupported`, and `find` and
  `export` with `invalid_request` (`unknown_op`).
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
(`packages/duckdb-engine/test/memory-engine.test.ts`).
