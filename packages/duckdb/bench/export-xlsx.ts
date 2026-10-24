/**
 * Measures exporting a table to xlsx: time and peak memory of the process.
 * Usage: node --conditions=vastgrid-source --import tsx packages/duckdb/bench/export-xlsx.ts <file> [rows]
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TableEngine } from "../src/engine.ts";

const file = path.resolve(process.argv[2] ?? "examples/playground/.data/sales-1m.csv");
const limit = Number(process.argv[3] ?? 1_048_575);
const temp = await mkdtemp(path.join(os.tmpdir(), "vastgrid-export-bench-"));
const engine = await TableEngine.create({
  allowedDirectories: [path.dirname(file), temp],
  tempDirectory: path.join(temp, "engine"),
});
let peak = 0;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 50);
try {
  const table = await engine.open(file);
  await table.whenReady();
  const rows = table.info().rowCount ?? 0;
  const view =
    rows > limit ? await table.createView({ filters: [{ type: "compare", column: 0, op: "lt", value: limit }] }) : null;
  const before = process.memoryUsage().rss;
  for (const format of ["xlsx", "csv"] as const) {
    peak = 0;
    const target = path.join(temp, `out.${format}`);
    const start = performance.now();
    const result = await table.exportView({ view: view?.id ?? null, format, target: target }, target);
    const seconds = (performance.now() - start) / 1000;
    console.log(
      `${format}: ${result.rows} rows × ${table.info().columns.length} columns in ${seconds.toFixed(1)} s, ` +
        `${((await stat(target)).size / 1024 ** 2).toFixed(1)} MB, RSS before ${(before / 1024 ** 2).toFixed(0)} MB, peak ${(peak / 1024 ** 2).toFixed(0)} MB`,
    );
  }
} finally {
  clearInterval(timer);
  await engine.dispose();
  await rm(temp, { recursive: true, force: true });
}
