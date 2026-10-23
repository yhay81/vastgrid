/**
 * Measures opening a large generated workbook and prints a Markdown report.
 *
 *   node --conditions=vastgrid-source --import tsx packages/duckdb/bench/xlsx.ts [--rows=1000000] [--dir=.data/bench]
 *
 * The workbook (8 columns: integers, shared strings, decimals, dates, timestamps, booleans, formulas
 * with saved values and text) is generated once into the data folder and reused.
 */
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TableEngine } from "../src/engine.ts";
import { cell, row, writeWorkbook } from "../test/xlsx-fixture.ts";

const args = new Map(
  process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1], match[2]] as const] : [];
  }),
);
const rows = Number(args.get("rows") ?? 1_000_000);
const directory = path.resolve(args.get("dir") ?? path.join(import.meta.dirname, "..", "..", "..", ".data", "bench"));
const file = path.join(directory, `sales-${rows}.xlsx`);
const cities = ["Tokyo", "Osaka", "Nagoya", "Fukuoka", "Sapporo", "Sendai", "Hiroshima", "Naha"];
const names = ["id", "city", "price", "day", "sold_at", "member", "total", "note"];

function* sheetRows() {
  yield row(
    1,
    names.map((_, index) => cell(`${String.fromCharCode(65 + index)}1`, { t: "s", v: cities.length + index })),
  );
  let batch = "";
  for (let index = 0; index < rows; index++) {
    const r = index + 2;
    batch += row(r, [
      cell(`A${r}`, { v: index }),
      cell(`B${r}`, { t: "s", v: index % cities.length }),
      cell(`C${r}`, { v: ((index * 7919) % 1_000_000) / 100 }),
      cell(`D${r}`, { s: 1, v: 43831 + (index % 1500) }),
      cell(`E${r}`, { s: 2, v: 43831 + (index % 1500) + (index % 86_400) / 86_400 }),
      cell(`F${r}`, { t: "b", v: index % 3 === 0 ? 1 : 0 }),
      cell(`G${r}`, { f: `C${r}*2`, v: ((index * 7919) % 1_000_000) / 50 }),
      cell(`H${r}`, { t: "inlineStr", is: `note ${index % 97}` }),
    ]);
    if (index % 1000 === 999) {
      yield batch;
      batch = "";
    }
  }
  yield batch;
}

const seconds = (start: number) => ((performance.now() - start) / 1000).toFixed(2);
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

await mkdir(directory, { recursive: true });
if (!existsSync(file)) {
  const start = performance.now();
  await writeWorkbook(file, {
    sharedStrings: [...cities, ...names],
    cellStyles: [0, 14, 22],
    sheets: [{ name: "Sales", rows: sheetRows() }],
  });
  console.error(`Generated ${file} in ${seconds(start)} s`);
}

const engine = await TableEngine.create({
  allowedDirectories: [directory],
  tempDirectory: path.join(os.tmpdir(), "vastgrid-bench-xlsx"),
});
let peakHeap = 0;
const sampler = setInterval(() => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}, 50);
try {
  const start = performance.now();
  const cpu = process.cpuUsage();
  const table = await engine.open(file);
  await table.whenReady();
  const loaded = seconds(start);
  const used = process.cpuUsage(cpu);
  const info = table.info();
  if (info.status !== "ready") throw new Error(info.error);
  const readStart = performance.now();
  await table.readRows({ view: null, start: rows / 2, end: rows / 2 + 200, columns: [0, 1, 2, 3, 4, 5, 6, 7] });
  const read = seconds(readStart);
  const sortStart = performance.now();
  await table.createView({ sort: [{ column: 2, direction: "desc" }] });
  const sorted = seconds(sortStart);
  clearInterval(sampler);
  console.log(`| Workbook | ${rows.toLocaleString("en")} rows × 8 columns, ${megabytes((await stat(file)).size)} |`);
  console.log("| --- | --- |");
  console.log(`| Open until ready | ${loaded} s |`);
  console.log(`| CPU time while opening (all threads) | ${((used.user + used.system) / 1e6).toFixed(2)} s |`);
  console.log(`| Read 200 rows in the middle | ${read} s |`);
  console.log(`| Sort by a number column | ${sorted} s |`);
  console.log(`| Peak JS heap | ${megabytes(peakHeap)} |`);
  console.log(`| Peak resident memory (process) | ${megabytes(process.resourceUsage().maxRSS * 1024)} |`);
  console.log(`| Column types | ${info.columns.map((column) => `${column.name}: ${column.sourceType}`).join(", ")} |`);
} finally {
  clearInterval(sampler);
  await engine.dispose();
}
