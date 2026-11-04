/**
 * The size of 0.2's `DataGrid` with an in-memory table (react.md §10 and Appendix A): bundled from the packages'
 * builds with Rolldown, minified, React left out, code split where the grid loads parts when they are needed. Prints
 * the size of what a page loads first and of everything, minified and with gzip, and fails over the budget.
 * Run after `pnpm run build`: `pnpm run size`. CI runs it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite/rolldown";

/** The first load's budget, with gzip (react.md §10). */
const BUDGET = 200 * 1024;
const directory = mkdtempSync(path.join(tmpdir(), "vastgrid-size-"));
const entry = path.join(directory, "entry.js");
writeFileSync(
  entry,
  'import { DataGrid, localTransport } from "vastgrid";\nimport { memoryEngine } from "vastgrid-js";\nexport { DataGrid, localTransport, memoryEngine };\n',
);
try {
  const { output } = await build({
    input: entry,
    platform: "browser",
    write: false,
    // The entry is outside the workspace, which has the packages.
    resolve: { modules: [path.resolve("node_modules"), "node_modules"] },
    external: ["react", "react-dom", "react/jsx-runtime", "react/compiler-runtime"],
    // The grid's "use client", for React Server Components, means nothing in a page.
    checks: { moduleLevelDirective: false },
    logLevel: "warn",
    output: { dir: path.join(directory, "out"), format: "esm", minify: true },
  });
  const chunks = output.filter((file) => file.type === "chunk");
  const size = (files) => {
    const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.code), 0);
    const gzip = files.reduce((sum, file) => sum + gzipSync(file.code).length, 0);
    return `${(bytes / 1024).toFixed(1)} KB, ${(gzip / 1024).toFixed(1)} KB with gzip`;
  };
  // What a page loads first: the entry and the chunks it imports statically.
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const loaded = new Set();
  const visit = (name) => {
    if (loaded.has(name)) return;
    loaded.add(name);
    for (const imported of byName.get(name)?.imports ?? []) visit(imported);
  };
  visit(chunks.find((chunk) => chunk.isEntry).fileName);
  const initial = chunks.filter((chunk) => loaded.has(chunk.fileName));
  const initialGzip = initial.reduce((sum, chunk) => sum + gzipSync(chunk.code).length, 0);
  console.log(`first load: ${size(initial)}`);
  console.log(`everything: ${size(chunks)} in ${chunks.length} files`);
  if (initialGzip > BUDGET) {
    console.error(`Over the budget of ${BUDGET / 1024} KB with gzip.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
