---
title: Performance
description: Measurements of the DuckDB engine and of the canvas renderer.
---

## The DuckDB engine

`npm run bench -- --csv-rows=10000000 --parquet-rows=100000000` on an Apple M2 Pro (12 threads, 32 GB),
Node.js 24, DuckDB 1.5. Times include DuckDB but not HTTP.

| Operation | Time |
| --- | ---: |
| CSV 735 MB, 10M rows: first rows readable | 143 ms |
| CSV: fully loaded (sort, filter and statistics available) | 5.3 s |
| CSV: 256 rows × 8 columns at a random position (median) | 1.8 ms |
| CSV: sort by a number / text column | 1.2 s / 1.1 s |
| CSV: filter by values (2.5M rows) / search all columns | 293 ms / 544 ms |
| CSV: column statistics (histogram, quartiles) | 117 ms |
| CSV: sum, average, min, max of 1M rows × 2 columns | 7.8 ms |
| Parquet 1.38 GB, 100M rows: open (read in place) | 20 ms |
| Parquet: 256 rows × 8 columns at a random position (median) | 24 ms |
| Parquet: sort by a number column | 1.9 s |
| Parquet sorted: 256 rows at a random position (median / 95th percentile) | 147 ms / 208 ms |

The sorted Parquet file has 100M rows, above `materializeRows`, so its view holds only the order of the
rows: it is built in 1.9 s, and each block of rows is read from the file in that order. A table below the
limit gets a sorted copy instead, which reads as fast as the table itself.

### First rows of a sort

The grid accepts a preview of a sort, so for tables of 1M rows or more the server first reads the first
1,000 rows with a top-N query and builds the rest of the view in the background. The same benchmark
compares it with waiting for the whole view, in a new engine each time (memory is what DuckDB holds, of
its default 4 GB limit; temporary space is the growth of the engine's folder). The machine was busy with
other work, so times vary by about ±30%.

| Parquet, 100M rows | First 256 rows shown | View ready | Memory / temporary space until the first rows |
| --- | ---: | ---: | ---: |
| Sort by a number column, whole view first | 1.9 s | 1.9 s | 1,963 MB / 407 MB |
| … with a preview | 0.8 s | 2.6 s | 127 MB / 0 MB |
| Sort by a text column, whole view first | 4.9 s | 4.9 s | 3,816 MB / 1,047 MB |
| … with a preview | 0.9 s | 6.4 s | 134 MB / 0 MB |
| Sort by text, then time, whole view first | 5.9 s | 5.9 s | 3,815 MB / 1,447 MB |
| … with a preview | 1.0 s | 6.7 s | 135 MB / 0 MB |

The first rows appear in under a second whatever the sort; the view is ready about 0.6–1.5 s later than
without a preview, the time of the top-N query, and needs the same memory and temporary space as before.

The benchmark is in
[`packages/duckdb/bench/run.ts`](https://github.com/yhay81/vastgrid/blob/main/packages/duckdb/bench/run.ts)
and generates its own files.

## The canvas

Rendering a 2280 × 1371 px viewport (56 rows × 20 columns) takes 2.0 ms per frame at the median and
3.0 ms at the 99th percentile, measured with the canvas flushed after every frame. Drawing does not
depend on the number of rows.

The [demo](/demo/) shows the average and slowest of the last frames drawn in your browser, from
`renderer.timings()`.

## `ArraySource`

`ArraySource` works on the main thread. On the same machine in Node.js 24, a table of 300,000 rows and
13 columns sorts by a decimal column in 0.55 s and by a text column in 0.15 s, and searches all columns in 0.13 s.
See [Data in memory](/guides/in-memory/#how-large).
