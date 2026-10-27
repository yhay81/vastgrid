---
title: Performance
description: Measurements of the grid in the browser, of the DuckDB engine and of the memory engine, with the budgets that CI keeps.
---

All the numbers below were measured on an Apple M2 Pro. Each table says when, with what, and how to measure it
again. Times on your machine will differ; the counts of React commits will not.

## The grid in the browser

The bench (`examples/bench`) mounts the grid on a table of 1,000,000 rows and 8 columns (integers, strings,
floats, dates, booleans) held by the memory engine, in the page or in a Web Worker, and the end-to-end tests
measure it in Chromium 156 with Playwright (headless, 60 Hz). Measured on 2026-10-24 with Node.js 24 and React
19.3.1; ranges are those of the last four runs. vastgrid 0.1 is there for comparison.

| Measure | vastgrid 0.1 | 0.2, engine in the page | 0.2, engine in a worker |
| --- | ---: | ---: | ---: |
| From mount to the first rows on screen | 46–65 ms | 43–49 ms | 36–49 ms |
| React commits per arrow key | 1 | 1 | 1 |
| From a key press to the next frame, p95 | 13.8–14.1 ms | 13.4–14.1 ms | 13.5–13.9 ms |
| React commits while scrolling for 100 frames | 0 | 0 | 0 |
| The gap between frames while scrolling, p95 | 16.7–16.8 ms | 16.7–16.8 ms | 16.7–16.8 ms |
| Sorting by a float column until the sorted rows are on screen | 494–516 ms | 85–98 ms | 112–113 ms |
| The longest task of the page meanwhile | 490–512 ms | 81–93 ms | none |
| JavaScript heap of the page | 190 MB | 202 MB | 10 MB |

The grid scrolls without dropping a frame at 60 Hz and commits React once per key. It sorts five to six
times faster than vastgrid 0.1, and with the engine in a worker the page never stops while a million rows are
sorted, and holds none of the table.

## Budgets

The end-to-end tests fail when the grid goes over one of these, so they hold for every release:

| Measure | Budget |
| --- | --- |
| React commits per arrow key | at most 1 |
| React commits while scrolling for 100 frames | 0 |
| The gap between frames while scrolling, p95 | under 25 ms |
| From a key press to the next frame, p95 | under 25 ms |
| From mount to the first rows on screen, a million rows in memory | under 300 ms |
| What a page loads first of `DataGrid` with a table in memory, minified with gzip | under 200 KB |

On 2026-10-27, a page loaded 100.9 KB with gzip first, and 133.2 KB in all: the column and cell menus, the
toolbar's menus, the find bar and the detail panel load when they first open. `npm run size` measures it, after
`npm run build`.

## The DuckDB engine

Measured on 2026-10-27 with Node.js 24.22.1, DuckDB's Node.js API 2.0.0-r.1, 8 DuckDB threads and a 2 GB memory
limit; each number is the median of three runs. Each request reads 256 rows of all eight columns through the engine's messages, with Arrow encoding and
decoding, without HTTP or drawing. The sort is `price DESC`, the filter `city = 'Tokyo'`. Deep reads are five
reads at 25%, 50%, 75%, 99% and the end of the finished view.

| File and plan | First rows | Deep reads, p50 / largest |
| --- | ---: | ---: |
| Parquet, 100M rows (1.38 GB), sort | 953 ms | 700 / 931 ms |
| Parquet, 100M rows, filter | 192 ms | 21 / 23 ms |
| CSV, 10M rows (735 MB), sort | 55 ms | 4.0 / 4.5 ms |
| CSV, 10M rows, filter | 124 ms | 3.0 / 3.2 ms |

- The first rows of a sort of a million rows or more come from a top-N query, in the order of the finished view,
  while the rest is built: 3.0 seconds more for the Parquet file, 0.9 for the CSV file.
- The 100-million-row view keeps only the order of the rows, above the 20 million rows of a sorted copy, so its
  deep reads gather rows from all over the file. The CSV file's view is a sorted copy, and reads in milliseconds.
- Over the whole run, the process peaked at 2.74 GB of memory and its session folder at 0.84 GB.

On an Apple-silicon laptop, saving two edited cells takes about 60 ms in a 200,000-row CSV file and 0.3 s in a
2-million-row one, and a sorted view of a million rows of four columns exports in 0.3 s as CSV, 0.1 s as Parquet,
0.2 s as JSON and 2.2 s as an Excel workbook.

[`views-benchmark.md`](https://github.com/yhay81/vastgrid/blob/main/docs/views-benchmark.md) has the method,
the numbers before this version and the commands to run it again.

## The memory engine

Measured on 2026-10-27 with Node.js 24.22.1: each request goes through the engine's messages, with the file
given as a page gives it a `File`, without a worker, a page or drawing. One run, in milliseconds, with the default
`maxBytes` of 1 GiB.

| Request | 1M CSV (69 MB) | 1M Parquet (13 MB) | 10M CSV (701 MB) | 10M Parquet (132 MB) |
| --- | ---: | ---: | ---: | ---: |
| Open | 1,059 | 26 | 10,499 | 38 |
| First 256 rows | 9.3 | 201 | 6.8 | 206 |
| Sort by a float | 91 | 1,078 | 881 | 8,723 |
| Sort by a string | 483 | 247 | 5,040 | 2,880 |
| Filter, then sort by a timestamp | 189 | 100 | 2,470 | 1,813 |
| Group with three measures | 411 | 322 | 4,974 | 3,523 |
| Export every row as CSV | 1,450 | 1,324 | 14,785 | 13,653 |
| Write a cell | 0.5 | 0.3 | 0.4 | 0.3 |

A million rows of CSV take about 60 MB once open, and the Parquet file 1 MB until its columns are read. A file
whose columns do not fit in `maxBytes` still opens, and its requests read the columns they need; one that needs
more at once than `maxBytes` fails with `load_failed`, and the table stays open. For those files, use the DuckDB
engine, which spills to disk.

[`memory-engine-benchmark.md`](https://github.com/yhay81/vastgrid/blob/main/docs/memory-engine-benchmark.md)
has every request, the memory, the limits and the command to run it again.
