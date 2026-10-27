/**
 * Reproduce the large-view measurements (docs/views-benchmark.md).
 * node --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/views.ts [--dir=.data/bench]
 * Optional --engine=/absolute/path/to/packages/duckdb-engine/src/index.ts measures another checkout.
 * JSON lines are written to stdout; resource peaks are sampled every 250 ms across the entire run.
 */
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeBlock } from "vastgrid-spec";
import { DuckDBEngine } from "../src/index.ts";
import { benchDirectory } from "./files.ts";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const directory = path.resolve(args.get("dir") ?? benchDirectory);
const temp = path.join(os.tmpdir(), `vastgrid-views-bench-${process.pid}`);
const engineClass: typeof DuckDBEngine = args.has("engine")
  ? (await import(pathToFileURL(path.resolve(args.get("engine") as string)).href)).DuckDBEngine
  : DuckDBEngine;
const engine = await engineClass.create({
  allowedDirectories: [directory],
  tempDirectory: temp,
  threads: 8,
  memoryLimit: "2GB",
});
let id = 0;
type Json = Record<string, unknown>;
async function send(op: string, members: Json): Promise<Json> {
  const answer = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
  if (answer.error) throw new Error(JSON.stringify(answer.error));
  return answer.result as Json;
}
async function size(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? await size(file) : (await stat(file).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
let rss = 0;
let disk = 0;
let sampling = false;
const timer = setInterval(() => {
  rss = Math.max(rss, process.memoryUsage().rss);
  if (sampling) return;
  sampling = true;
  void size(temp)
    .then((bytes) => {
      disk = Math.max(disk, bytes);
    })
    .finally(() => {
      sampling = false;
    });
}, 250);
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
console.log(JSON.stringify({ cpu: os.cpus()[0]?.model, node: process.versions.node, threads: 8, memoryLimit: "2GB" }));
try {
  for (const file of ["sales-100000000.parquet", "sales-10000000.csv"]) {
    const opened = await send("open", { ref: file });
    await engine.whenLoaded(opened.table as string);
    const info = await send("info", { table: opened.table });
    for (const [label, plan] of [
      ["sort", { sort: [{ column: "price", direction: "desc" }] }],
      ["filter", { where: { fn: "eq", args: [{ col: "city" }, { lit: "Tokyo" }] } }],
    ] as const) {
      const read = async (start: number, preview = false) => {
        const began = performance.now();
        const result = await send("rows", {
          table: info.table,
          revision: info.revision,
          plan,
          start,
          end: start + 256,
          columns: (info.columns as { name: string }[]).map((column) => column.name),
          ...(preview ? { preview: true } : {}),
        });
        decodeBlock((result.block as { bytes: Uint8Array }).bytes);
        return { ms: performance.now() - began, view: result.view as { rowCount: number; status: string } };
      };
      const first = await read(0, true);
      const ready = await read(0);
      const times: number[] = [];
      for (const fraction of [0.5, 0.99, 0.25, 0.75, 1]) {
        const { ms } = await read(Math.max(0, Math.floor(ready.view.rowCount * fraction) - 256));
        times.push(ms);
      }
      rss = Math.max(rss, process.memoryUsage().rss);
      disk = Math.max(disk, await size(temp));
      console.log(
        JSON.stringify({
          file,
          label,
          first: first.ms,
          firstStatus: first.view.status,
          completionWait: ready.ms,
          p50: percentile(times, 0.5),
          p95: percentile(times, 0.95),
          samples: times,
          peakRssBytes: rss,
          peakSessionBytes: disk,
        }),
      );
    }
    await send("close", { table: info.table });
  }
} finally {
  clearInterval(timer);
  await engine.dispose();
  await rm(temp, { recursive: true, force: true });
}
