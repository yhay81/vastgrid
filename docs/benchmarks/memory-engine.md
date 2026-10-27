# 0.2 memory engine: measurements / メモリーエンジンの計測

2026-10-27, Issue [#43](https://github.com/yhay81/vastgrid/issues/43). The memory engine of `vastgrid-js`, which
runs in the page or in a Web Worker, measured on the CSV and Parquet files of the benchmarks.

## Method

Apple M2 Pro, Node.js 24.22.1. `packages/duckdb-engine/bench/memory-engine.ts` generates the files of
`npm run bench` when they are missing (eight columns: id, name, city, price, quantity, sold_at, member, note;
DuckDB writes the Parquet file, in row groups of 122,880 rows compressed with ZSTD) and gives each to an engine as
a file on disk (`openAsBlob`), as a page gives it a `File`. Each request goes through `engine.handle` with its
messages checked, without a worker, a page or drawing; times are wall-clock milliseconds of one run. Memory is the
JavaScript heap and the buffers of typed arrays, after a garbage collection, a pause of 100 ms in which V8 frees the
buffers it collected, and another collection, less what was held before the table was opened.

Requests read 256 rows of every column, in this order on one table: the first rows, rows at the middle, a sort by
`price DESC` and its rows at the middle, a sort by `name`, `city = 'Tokyo'` sorted by `sold_at`, a group by city
of three measures, a summary of every column, a find of text in the last row, an export of every row as CSV, a find
of text that no cell holds in a view sorted by `member`, cancelled 200 ms after it starts, and `close`. A second
engine opens the file and cancels its first sorted view (by `note`) 50 ms after it starts; a third sorts by `city`,
writes a cell of it and sorts again.

## Results

Times are milliseconds. "1 GiB" is the default `maxBytes`; with 256 MiB the 10-million-row files do not fit, and
their columns are read whole as requests need them and forgotten when others need the room
([`maxBytes`](../../packages/js/README.md)).

| Request | 1M CSV | 1M Parquet | 10M CSV | 10M Parquet | 10M CSV, 256 MiB | 10M Parquet, 256 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| open | 1059 | 26 | 10499 | 38 | 4668 | 37 |
| first 256 rows | 9.3 | 201 | 6.8 | 206 | 11 | 205 |
| 256 rows at the middle | 2.4 | 173 | 1.9 | 169 | 4.9 | 165 |
| sort by price (a float) | 91 | 1078 | 881 | 8723 | 3562 | 11790 |
| the same view at the middle | 2.4 | 11 | 5.4 | 2.0 | 153 | 8525 |
| sort by name (a string) | 483 | 247 | 5040 | 2880 | 8084 | load_failed |
| filter by city and sort by a timestamp | 189 | 100 | 2470 | 1813 | 5840 | 9047 |
| group by city: sum, avg, count | 411 | 322 | 4974 | 3523 | 8009 | load_failed |
| summarize every column | 680 | 535 | 5262 | 5418 | load_failed | load_failed |
| find text in the last row | 7.7 | 5.6 | 7.7 | 5.5 | 3979 | load_failed |
| export CSV of every row | 1450 | 1324 | 14785 | 13653 | load_failed | load_failed |
| a find cancelled 200 ms after it starts: from then to `cancelled` | 10 | 40 | 48 | 140 | 13 | 6.2 |
| the first view sorted by text, cancelled 50 ms after it starts: the same | 15 | 9.0 | 544 | 19 | 4.1 | 17 |
| write a cell | 0.5 | 0.3 | 0.4 | 0.3 | 0.6 | 0.3 |
| sort by the written column | 414 | 257 | 4948 | 2833 | 5114 | 3093 |

The requests that fail answer `load_failed` at `/maxBytes` within 30 ms, before reading anything, and the table stays
open: a summary, a find and an export go through every column at once, which together take more than 256 MiB. Of
the Parquet file, `name` alone would take 468 MiB as strings, and the four columns of the group 290 MiB, where the
CSV file's columns hold their text as UTF-8 bytes.

| Memory (MB) | 1M CSV | 1M Parquet | 10M CSV | 10M Parquet | 10M CSV, 256 MiB | 10M Parquet, 256 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| file | 69 | 13 | 701 | 132 | 701 | 132 |
| after open | 58 | 1 | 590 | 2 | 0 | 2 |
| after the views, the find and the export | 107 | 129 | 1020 | 1264 | 695 | 574 |
| the write and the view sorted by it | 0 | 0 | 0 | 0 | 0 | 0 |
| after close | 0 | 2 | 0 | 2 | 0 | 2 |
| the exported CSV | 69 | 69 | 701 | 701 | — | — |

### In a page

`e2e/budgets.spec.ts` measures the grid of `examples/bench` on a million rows in Chromium (Playwright), with the
memory engine in the page and in a Web Worker (`workerEngine` of `vastgrid`), and 0.1 for comparison:

| | sort of a million rows | longest task of the page while it sorts | first rows | heap of the page |
| --- | ---: | ---: | ---: | ---: |
| 0.2, engine in a Web Worker | 209 ms | 0 ms | 57 ms | 10 MB |
| 0.2, engine in the page | 96 ms | 92 ms | — | 202 MB |
| 0.1 | 527 ms | 521 ms | — | — |

With the engine in a worker, the page draws and scrolls while the worker sorts, and holds none of the table.

## Limits

- `maxBytes` bounds the columns read whole, as the engine estimates them: for Parquet, from the sizes in the file's
  footer (numbers in typed arrays, booleans in a byte, text as strings, which the rows of a dictionary's value
  share). What requests make comes on top: the ranks of a sorted column (4 bytes a row and its distinct values),
  each view (4 bytes a row), the groups of a group and the block cache of a text file (32 MiB). The 10-million-row
  CSV file took 695 MB with a `maxBytes` of 256 MiB once five columns were ranked.
- A request that needs more columns at once than `maxBytes` holds fails with `load_failed`; the host then gives a
  larger `maxBytes` or uses the DuckDB engine, which spills to disk.
- Rows of a sorted view of a Parquet file whose columns do not fit come from row groups all over the file: 256 rows
  at the middle of the view sorted by price read the 82 row groups (8.5 seconds). With room, the columns that a view
  shows are read whole while the engine is idle, and the same rows take 2 ms.
- The first rows of a Parquet file read the row group that holds them, 122,880 rows here (0.2 seconds).
- A cancel is read between the steps of a request, every 40 ms or so: between slices of a file, row groups, rows of
  a find or an export, and steps of ranking text. The rest of a view runs to its end first (ranking numbers, sorting
  by ranks, filtering, grouping and deriving), so a cancel waits for it: half a second at most here, for the
  10-million-row CSV file sorted by `note`. The times above count from when the cancel is sent.
- An export makes the file in memory (701 MB for 10 million rows) and answers its bytes, which a page saves as a
  download: the engine writes no file, and the `File` that a table was opened from stays as it was. Closing the
  table frees everything, as the "after close" row shows.

## Reproduce

```bash
node --expose-gc --max-old-space-size=8192 --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/memory-engine.ts
```

`--rows=10000000` measures 10 million rows, and `--max-bytes=268435456` gives the engines a `maxBytes` of 256 MiB.
The page's numbers come from `npm run e2e -- e2e/budgets.spec.ts`, which prints them.

## 日本語での要点

- 100 万行は CSV で約 1 秒、Parquet で 30 ms で開き、並べ替え・絞り込み・集計・要約はどれも 0.1〜0.7 秒。
- 1,000 万行（CSV 701 MB、Parquet 132 MB）は既定の `maxBytes`（1 GiB）ですべての操作ができ、閉じるとメモリーは
  開く前に戻る。
- `maxBytes` を 256 MiB にすると、CSV は列を保持せずに 5〜6 秒で開き、列は要求が必要とするときに読み、
  使われていない列から忘れる。一度に `maxBytes` を超える列を読む要求（全列の要約・検索・出力、Parquet では
  `name` の並べ替えと集計も）は `load_failed` で失敗し、表は開いたまま。`maxBytes` が抑えるのは列だけで、
  並べ替えの順位やビューは別にかかる。
- キャンセルは送ってから 0.6 秒以内に `cancelled` で返る（文字列の順位付けも途中で止まる）。Web Worker で
  動かすとページは並べ替え中も止まらない（最長タスク 0 ms、ページのヒープ 10 MB）。
- 保存はブラウザーでは出力（ダウンロード）のみで、開いた `File` は書き換えない。
