/**
 * Measures `BrowserTable` (the engine `BrowserSource` runs in its worker) on the playground's sample files:
 * opening, the first window of rows, windows at random positions, a sort, the bytes read and the memory used.
 *
 *   npm run generate -w vastgrid-playground
 *   npm run bench -w vastgrid-browser [folder]
 *
 * Parquet files are read twice: from a local HTTP server with Range requests (as from a URL), and as a
 * local file. Node.js has no Web Worker; the numbers are those of the worker's thread.
 */
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { BrowserTable, type TableInput } from "../src/index.ts";

const folder = path.resolve(
  process.argv[2] ?? path.join(import.meta.dirname, "..", "..", "..", "examples", "playground", ".data"),
);

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function memory() {
  global.gc?.();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

async function time<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await run();
  return [result, performance.now() - started];
}

async function measure(label: string, input: TableInput, size: number, sortColumn: number | null) {
  const before = memory();
  const table = new BrowserTable(input, { fullScan: true });
  const [, opened] = await time(async () => {
    for (;;) {
      const info = await table.info();
      if (info.status === "error") throw new Error(info.error);
      if (info.status === "ready") return info;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  const afterOpen = table.transfer();
  const info = await table.info();
  const columns = info.columns.map((_, index) => index);
  const rows = info.rowCount ?? 0;
  const [, first] = await time(() => table.readRows({ view: null, start: 0, end: 100, columns }));
  const afterFirst = table.transfer();
  const randoms: number[] = [];
  const [, next] = await time(() => table.readRows({ view: null, start: 100, end: 200, columns }));
  for (const fraction of [0.37, 0.81, 0.13, 0.66, 0.995]) {
    const start = Math.floor(rows * fraction);
    randoms.push((await time(() => table.readRows({ view: null, start, end: start + 100, columns })))[1]);
  }
  const afterRandom = table.transfer();
  let sorted = "";
  if (sortColumn !== null) {
    const [view, took] = await time(() => table.createView({ sort: [{ column: sortColumn, direction: "desc" }] }));
    const [, window] = await time(() => table.readRows({ view: view.id, start: 0, end: 100, columns }));
    sorted = `sort ${info.columns[sortColumn].name} ${(took / 1000).toFixed(1)} s, first sorted window ${window.toFixed(0)} ms`;
  }
  const used = memory() - before;
  console.log(`\n${label}: ${megabytes(size)}, ${rows.toLocaleString("en")} rows, ${columns.length} columns`);
  console.log(
    `  open (until ready)   ${opened.toFixed(0)} ms; read ${megabytes(afterOpen.bytes)} in ${afterOpen.requests} reads`,
  );
  console.log(
    `  first 100 rows       ${first.toFixed(0)} ms; read ${megabytes(afterFirst.bytes)} in ${afterFirst.requests} reads`,
  );
  console.log(`  next 100 rows        ${next.toFixed(0)} ms`);
  console.log(
    `  5 random windows     ${randoms.map((value) => value.toFixed(0)).join(", ")} ms; read ${megabytes(afterRandom.bytes)} in ${afterRandom.requests} reads (${((afterRandom.bytes / size) * 100).toFixed(1)}% of the file)`,
  );
  if (sorted) console.log(`  ${sorted}`);
  console.log(`  memory               +${megabytes(used)} (heap and buffers)`);
  table.close();
}

async function serveFolder() {
  const { createReadStream } = await import("node:fs");
  const server = createServer(async (request, response) => {
    const file = path.join(folder, decodeURIComponent((request.url ?? "/").slice(1)));
    const { size } = await stat(file);
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (range) {
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end}/${size}`);
    }
    response.setHeader("content-length", end - start + 1);
    response.setHeader("etag", `"${size}"`);
    if (request.method === "HEAD") response.end();
    else createReadStream(file, { start, end }).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const { server, base } = await serveFolder();
try {
  for (const [name, sortColumn] of [
    ["sales-10m.parquet", 3],
    ["sales-1m.csv", 3],
  ] as const) {
    const file = path.join(folder, name);
    const { size } = await stat(file);
    if (name.endsWith(".parquet")) await measure(`${name} over HTTP Range`, { url: `${base}/${name}` }, size, null);
    await measure(`${name} as a local file`, { file: await openAsBlob(file), name }, size, sortColumn);
  }
} finally {
  server.close();
}
