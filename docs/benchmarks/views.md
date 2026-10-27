# 0.2 saved views: measurements / 大容量ビューの計測

2026-10-25, Issue [#35](https://github.com/yhay81/vastgrid/issues/35). Baseline: main
`740b00e54097609ee29884e32229099aead7588b`; after: the implementation accompanying this report.
The original files and their values are unchanged. [Raw measurements](views.json).

## Method

Apple M2 Pro, Node.js 24.22.1, DuckDB node-api 1.5.6-r.1, 8 DuckDB threads and a 2 GB memory limit.
Run before, then after, without the browser tests or other benchmarks running concurrently. Files were already
on disk and the OS cache was not cleared. Each run opens the 100-million-row Parquet (1.38 GB), then the
10-million-row CSV (735 MB), waiting for file loading before timing views.

The sort is `price DESC` with source row ID breaking ties; the filter is `city = 'Tokyo'`. Each request reads
256 rows of all eight columns through the engine's messages, including Arrow encoding and decoding, without
HTTP or drawing. The first request allows a preview, the next waits for completion, then five requests read
positions at 50%, 99%, 25%, 75% and the end of the result. p50/p95 are descriptive quantiles of these **five
samples**, not production latency guarantees; p95 is the largest sample. One run per version.

## Results

All times are milliseconds.

| File / plan | First rows before | First rows after | Deep reads before p50 / p95 | Deep reads after p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 100M Parquet / sort | 1,413 | 778 | 27,130 / 34,341 | 676 / 681 |
| 100M Parquet / filter | 99 | 191 | 1,556 / 1,693 | 21 / 24 |
| 735 MB CSV / sort | 117 | 53 | 742 / 862 | 3.1 / 3.4 |
| 735 MB CSV / filter | 51 | 179 | 85 / 92 | 2.7 / 2.9 |

The sorted previews have `status: building`, an exact row count and the first 1,000 positions in final order.
After the first response, waiting for the complete saved view and reading its first block takes another
2,298 ms for Parquet and 994 ms for CSV. Before the change, `ready` meant the query could be read, but each
deep read repeated the sort; it did not mean there was a saved result. Filter-only views now spend more time
on their first response to avoid repeating that work on every later read.

RSS and total session-folder bytes were sampled every 250 ms. The following are the maximum values over the
entire run (both files and both plans), including retained caches, the database, WAL and spill files; input
files are excluded. Sampling may miss short peaks. RSS includes memory outside DuckDB's buffer limit.

| Resource | Before | After |
| --- | ---: | ---: |
| Process RSS peak | 3.21 GB | 2.66 GB |
| Session folder peak | 8.61 GB | 0.83 GB |

The new defaults keep eight idle views, serialize view builds and bound spill files to 8 GB. Large inputs keep
only the row order; their arbitrary reads still fetch scattered source rows, so they are slower than reading a
full saved copy. The session database has no hard byte quota and may keep reusable blocks after LRU eviction.
Hosts requiring a total disk quota must provision one for `tempDirectory`. See the [engine options and cleanup](../../packages/duckdb-engine/README.md#limits-and-cleanup).

## DuckDB 2.0

2026-10-27, the same machine and files. The checkout of main `ae3feb0` on `@duckdb/node-api` 1.5.6-r.1 ran in
turn with the changes accompanying this section on 2.0.0-r.1, three times each; each number is the median of the
three runs, in milliseconds. The READMEs and the site show the 2.0 column.

| File / plan | First rows 1.5.6 | First rows 2.0 | Deep reads p50 1.5.6 | Deep reads p50 2.0 | Built 1.5.6 | Built 2.0 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100M Parquet / sort | 817 | 953 | 707 | 700 | 2,632 | 3,046 |
| 100M Parquet / filter | 218 | 192 | 23 | 21 | | |
| 735 MB CSV / sort | 54 | 55 | 3.5 | 4.0 | 1,145 | 869 |
| 735 MB CSV / filter | 192 | 124 | 3.0 | 3.0 | | |

`npm run bench` (`bench/open.ts`) gave, for the CSV file on 1.5.6 and 2.0: its first rows in 68 and 52 ms, the whole
load in 3.7 and 1.8 s, and a block at a random place in 3.3 and 2.8 ms (Parquet: 23 and 19 ms). Peaks were 2.62 GB
of RSS and 0.83 GB in the session folder on 1.5.6, 2.74 GB and 0.84 GB on 2.0.

Before these changes, DuckDB 2.0 read the CSV file more slowly in every run (its first rows in 127 ms, the load in
5.6 s, a block in 4.8 ms), for two reasons:

- DuckDB 2.0 refuses `null_padding` in parallel for a file with line breaks in quotes, which the file's notes have,
  so the engine read it in one thread after a refused attempt. It now reads such a file in parallel without
  `null_padding` when `sniff_csv` finds the same dialect, skipped lines, header and columns with and without it,
  and the preview in one thread from the start.
- DuckDB 2.0 parses and plans a query longer: preparing a block's read took 2.6 ms against 1.2 ms on 1.5.6
  (parsing alone 0.45 ms against 0.04 ms). The engine now keeps the statements of its block reads prepared on each
  connection, and runs them again with the new start and end.

## Reproduce

Generate the files with `bench/open.ts` if needed, then run:

```sh
node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/views.ts --dir=/data/bench
```

To compare an installed checkout of the baseline without changing the working branch:

```sh
node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/views.ts --dir=/data/bench --engine=/path/to/baseline/packages/duckdb-engine/src/index.ts
```

The benchmark emits JSON lines. The test corpus exercises both full-column and row-order storage. Native engine
tests also check previews, ties, derived columns, cancellation, locate/find/summarize, eviction and reopening.
The browser tests cover both real file sizes, first/middle/last positions after sorting and filtering, replacing
a plan and reconnecting. Core tests cover selection relocation, a short preview without events, stale responses
and queuing plans while a file loads.

## 日本語での要点

並べ替え・絞り込みの結果を一度保存して、スクロールでは必要な位置を読むようにしました。今回の計測では、
1億行Parquetの並べ替え後の読み込み中央値は27.1秒から0.68秒、735 MB CSVでは742 msから3.1 msになりました。
先頭はそれぞれ778 ms・53 msで先行表示し、残りをバックグラウンドで構築します。絞り込みだけの場合は最初の
表示が少し遅くなり、その後の読み込みが速くなります。

値や順序の正しさは適合テストと実ブラウザーで別に確認しています。上の性能値は手元の環境で各5か所を読んだ
結果で、すべてのファイルで同じ速さを保証するものではありません。メモリー・spill・保持するビュー数には
制限がありますが、セッションDB全体の厳密な容量制限にはホスト側の設定が必要です。
