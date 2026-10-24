/**
 * Opens large files with the engine and reads blocks from their start to their end, as scrolling does, and prints a
 * Markdown report. Every time is a wall-clock time in this process, with the messages but without HTTP.
 *
 *   node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/open.ts [--dir=.data/bench]
 *     [--csv-rows=10000000] [--parquet-rows=100000000]
 *
 * The files are those of `npm run bench` (v1's, `packages/duckdb/bench/run.ts`), generated here when missing.
 */
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeBlock } from "vastgrid-spec";
import { DuckDBEngine } from "../src/index.ts";
import { benchDirectory, benchFiles } from "./files.ts";

const args = new Map(
  process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1], match[2]] as const] : [];
  }),
);
const csvRows = Number(args.get("csv-rows") ?? 10_000_000);
const parquetRows = Number(args.get("parquet-rows") ?? 100_000_000);
const directory = path.resolve(args.get("dir") ?? benchDirectory);

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

const results: [string, string][] = [];
function record(label: string, milliseconds: number | string) {
  const text =
    typeof milliseconds === "number" ? `${milliseconds.toFixed(milliseconds < 10 ? 1 : 0)} ms` : milliseconds;
  results.push([label, text]);
  console.error(`${label.padEnd(60)} ${text}`);
}

let id = 0;
type Json = Record<string, unknown>;

async function send(engine: DuckDBEngine, op: string, members: Json): Promise<Json> {
  const answer = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
  if (answer.error) throw new Error(`${op}: ${JSON.stringify(answer.error)}`);
  return answer.result as Json;
}

/** Reads 256-row blocks of every column at places from the start to the end. */
async function blocks(engine: DuckDBEngine, info: Json, label: string) {
  const rows = info.rowCount as number;
  const columns = (info.columns as { name: string }[]).map((column) => column.name);
  const read = async (start: number) => {
    const began = performance.now();
    const result = await send(engine, "rows", {
      table: info.table,
      revision: info.revision,
      plan: {},
      start,
      end: start + 256,
      columns,
    });
    decodeBlock((result.block as { bytes: Uint8Array }).bytes);
    return performance.now() - began;
  };
  record(`${label}: the first block`, await read(0));
  record(`${label}: the last block`, await read(Math.max(0, rows - 256)));
  const times: number[] = [];
  for (let index = 0; index < 50; index++) times.push(await read(Math.floor(Math.random() * Math.max(1, rows - 256))));
  record(`${label}: blocks at random places, median`, percentile(times, 0.5));
  record(`${label}: blocks at random places, 95th percentile`, percentile(times, 0.95));
}

async function main() {
  const { csv, parquet } = await benchFiles(directory, csvRows, parquetRows);
  const temp = path.join(os.tmpdir(), `vastgrid-engine-bench-${process.pid}`);
  const engine = await DuckDBEngine.create({ allowedDirectories: [directory], tempDirectory: temp });
  try {
    let began = performance.now();
    const pq = await send(engine, "open", { ref: parquet });
    record(
      `Parquet, ${parquetRows.toLocaleString("en")} rows (${((await stat(parquet)).size / 1e6).toFixed(0)} MB): open`,
      performance.now() - began,
    );
    await blocks(engine, pq, "Parquet");

    began = performance.now();
    const opened = await send(engine, "open", { ref: csv });
    record(
      `CSV, ${csvRows.toLocaleString("en")} rows (${((await stat(csv)).size / 1e6).toFixed(0)} MB): open, its first rows readable`,
      performance.now() - began,
    );
    await engine.whenLoaded(opened.table as string);
    record("CSV: loaded", performance.now() - began);
    const loaded = await send(engine, "info", { table: opened.table });
    await blocks(engine, loaded, "CSV");
  } finally {
    await engine.dispose();
    await rm(temp, { recursive: true, force: true });
  }
  console.log(
    `| Measure | Time |\n| --- | ---: |\n${results.map(([label, value]) => `| ${label} | ${value} |`).join("\n")}`,
  );
  console.log(`\n${os.cpus()[0]?.model ?? "CPU"}, ${os.cpus().length} threads, Node.js ${process.versions.node}`);
}

await main();
