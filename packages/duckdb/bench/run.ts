/**
 * Measures the table engine on generated data and prints a Markdown report.
 *
 *   npm run bench -- [--csv-rows=5000000] [--parquet-rows=50000000] [--dir=.data/bench]
 *
 * Files are generated once into the data folder and reused. Every number is a wall-clock time
 * measured in this process (DuckDB through @duckdb/node-api), without the HTTP layer.
 */
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { type OpenTable, TableEngine } from "../src/engine.ts";

const args = new Map(
  process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1], match[2]] as const] : [];
  }),
);
const csvRows = Number(args.get("csv-rows") ?? 5_000_000);
const parquetRows = Number(args.get("parquet-rows") ?? 50_000_000);
const directory = path.resolve(args.get("dir") ?? path.join(import.meta.dirname, "..", "..", "..", ".data", "bench"));

const select = (rows: number) => `
  SELECT i AS id,
    'item-' || (i % 50000)::VARCHAR || CASE WHEN i % 7 = 0 THEN ' "special", limited' ELSE '' END AS name,
    ['Tokyo', 'Osaka', 'Nagoya', 'Fukuoka', 'Sapporo', 'Sendai', 'Hiroshima', 'Naha'][(i % 8) + 1] AS city,
    round((hash(i) % 1000000) / 100.0, 2)::DOUBLE AS price,
    (hash(i * 31) % 500)::INTEGER AS quantity,
    TIMESTAMP '2020-01-01' + to_seconds((hash(i * 17) % 157680000)::BIGINT) AS sold_at,
    (i % 3 = 0) AS member,
    CASE WHEN i % 1000 = 0 THEN 'multi' || chr(10) || 'line' WHEN i % 10 = 0 THEN NULL ELSE 'note ' || (i % 97)::VARCHAR END AS note
  FROM range(${rows}) t(i)`;

async function generate() {
  await mkdir(directory, { recursive: true });
  const csv = path.join(directory, `sales-${csvRows}.csv`);
  const parquet = path.join(directory, `sales-${parquetRows}.parquet`);
  if (!existsSync(csv) || !existsSync(parquet)) {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    if (!existsSync(csv)) {
      console.error(`Generating ${csv}…`);
      await connection.run(`COPY (${select(csvRows)}) TO '${csv}' (HEADER)`);
    }
    if (!existsSync(parquet)) {
      console.error(`Generating ${parquet}…`);
      await connection.run(`COPY (${select(parquetRows)}) TO '${parquet}' (FORMAT parquet, COMPRESSION zstd)`);
    }
    connection.closeSync();
    instance.closeSync();
  }
  return { csv, parquet };
}

async function time<T>(task: () => Promise<T>): Promise<[number, T]> {
  const started = performance.now();
  const result = await task();
  return [performance.now() - started, result];
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

const results: [string, string][] = [];
function record(label: string, milliseconds: number | string) {
  const text =
    typeof milliseconds === "number" ? `${milliseconds.toFixed(milliseconds < 10 ? 1 : 0)} ms` : milliseconds;
  results.push([label, text]);
  console.error(`${label.padEnd(56)} ${text}`);
}

/** Reads 256-row windows of every column at random places and reports the median and 95th percentile. */
async function windows(table: OpenTable, view: string | null, rows: number, label: string) {
  const columns = table.columns.map((_, index) => index);
  const times: number[] = [];
  let seed = 42;
  for (let index = 0; index < 30; index++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const start = Math.floor((seed / 2 ** 31) * Math.max(1, rows - 256));
    const [elapsed] = await time(() => table.readRows({ view, start, end: start + 256, columns }));
    times.push(elapsed);
  }
  record(`${label}: 256 rows × ${columns.length} columns, median`, percentile(times, 0.5));
  record(`${label}: 256 rows × ${columns.length} columns, 95th percentile`, percentile(times, 0.95));
}

const files = await generate();
const engine = await TableEngine.create({
  allowedDirectories: [directory],
  tempDirectory: path.join(os.tmpdir(), "vastgrid-bench"),
});
try {
  // ----- CSV -----
  const csvSize = (await stat(files.csv)).size;
  const [opened, csv] = await time(() => engine.open(files.csv));
  let firstRows = 0;
  const started = performance.now();
  while (csv.info().readableRows === 0 && csv.status === "loading")
    await new Promise((resolve) => setTimeout(resolve, 2));
  firstRows = performance.now() - started + opened;
  await csv.whenReady();
  const loaded = performance.now() - started + opened;
  const rows = csv.rowCount ?? 0;
  record(`CSV ${(csvSize / 1e6).toFixed(0)} MB, ${rows.toLocaleString("en")} rows: first rows readable`, firstRows);
  record("CSV: fully loaded (sort, filter and statistics available)", loaded);
  await windows(csv, null, rows, "CSV: random windows");
  const [sortNumber, byPrice] = await time(() => csv.createView({ sort: [{ column: 3, direction: "desc" }] }));
  record("CSV: sort by a number column", sortNumber);
  await windows(csv, byPrice.id, byPrice.rowCount, "CSV sorted: random windows");
  const [sortText] = await time(() => csv.createView({ sort: [{ column: 1, direction: "asc" }] }));
  record("CSV: sort by a text column", sortText);
  const [filter, filtered] = await time(() =>
    csv.createView({ filters: [{ type: "values", column: 2, values: ["Tokyo", "Osaka"] }] }),
  );
  record(`CSV: filter by values (${filtered.rowCount.toLocaleString("en")} rows)`, filter);
  const [search, searched] = await time(() => csv.createView({ search: "special" }));
  record(`CSV: search all columns (${searched.rowCount.toLocaleString("en")} rows)`, search);
  const [stats] = await time(() => csv.columnStats(null, 3));
  record("CSV: statistics of a number column (histogram, quartiles)", stats);
  const [distinct] = await time(() => csv.distinctValues({ view: null, column: 1, limit: 1000 }));
  record("CSV: distinct values of a text column (top 1,000)", distinct);
  const [aggregate] = await time(() =>
    csv.aggregate({ view: null, ranges: [{ start: 0, end: Math.min(rows, 1_000_000), columns: [3, 4] }] }),
  );
  record("CSV: sum, average, min, max of 1M rows × 2 columns", aggregate);
  const [find] = await time(() =>
    csv.find({ view: null, text: "item-49999", columns: [1, 2, 7], row: 0, column: 0, direction: 1 }),
  );
  record("CSV: find the next cell containing text", find);

  // ----- Parquet -----
  const parquetSize = (await stat(files.parquet)).size;
  const [openedParquet, parquet] = await time(async () => {
    const table = await engine.open(files.parquet);
    await table.whenReady();
    return table;
  });
  const parquetRowCount = parquet.rowCount ?? 0;
  record(
    `Parquet ${(parquetSize / 1e6).toFixed(0)} MB, ${parquetRowCount.toLocaleString("en")} rows: open (read in place)`,
    openedParquet,
  );
  await windows(parquet, null, parquetRowCount, "Parquet: random windows");
  const [sortParquet, sortedParquet] = await time(() =>
    parquet.createView({ sort: [{ column: 3, direction: "desc" }] }),
  );
  record("Parquet: sort by a number column", sortParquet);
  await windows(parquet, sortedParquet.id, sortedParquet.rowCount, "Parquet sorted: random windows");
  const [filterParquet, filteredParquet] = await time(() =>
    parquet.createView({ filters: [{ type: "compare", column: 3, op: "gt", value: 9990 }] }),
  );
  record(`Parquet: filter by a comparison (${filteredParquet.rowCount.toLocaleString("en")} rows)`, filterParquet);
} finally {
  await engine.dispose();
}

const cpu = os.cpus()[0]?.model ?? "unknown CPU";
console.log(
  `## vastgrid benchmark\n\n${cpu}, ${os.availableParallelism()} threads, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB RAM, Node.js ${process.version}, ${os.platform()} ${os.arch()}\n`,
);
console.log("| Operation | Time |\n| --- | ---: |");
for (const [label, value] of results) console.log(`| ${label} | ${value} |`);
