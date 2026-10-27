/**
 * The size of v2's `DataGrid` with an in-memory table (v2-react.md §10 and Appendix A): bundled from the packages'
 * builds with esbuild, minified, React left out, code split where the grid loads parts when they are needed. Prints
 * the size of what a page loads first and of everything, minified and with gzip, and fails over the budget.
 * Run after `npm run build`: `npm run size`. CI runs it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/** The first load's budget, with gzip (v2-react.md §10). */
const BUDGET = 200 * 1024;
const directory = mkdtempSync(path.join(tmpdir(), "vastgrid-size-"));
const entry = path.join(directory, "entry.js");
writeFileSync(
  entry,
  'import { DataGrid, localTransport } from "vastgrid-grid";\nimport { memoryEngine } from "vastgrid-js";\nexport { DataGrid, localTransport, memoryEngine };\n',
);
try {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    splitting: true,
    format: "esm",
    write: false,
    outdir: path.join(directory, "out"),
    nodePaths: [path.resolve("node_modules")],
    external: ["react", "react-dom", "react/jsx-runtime", "react/compiler-runtime"],
    metafile: true,
    logLevel: "error",
  });
  const outputs = result.outputFiles.filter((file) => file.path.endsWith(".js"));
  const first = outputs.find((file) => path.basename(file.path) === "entry.js");
  const size = (files) => {
    const bytes = files.reduce((sum, file) => sum + file.contents.length, 0);
    const gzip = files.reduce((sum, file) => sum + gzipSync(file.contents).length, 0);
    return `${(bytes / 1024).toFixed(1)} KB, ${(gzip / 1024).toFixed(1)} KB with gzip`;
  };
  // What a page loads first: the entry and the chunks it imports statically.
  const meta = result.metafile.outputs;
  const loaded = new Set();
  const visit = (file) => {
    if (loaded.has(file)) return;
    loaded.add(file);
    for (const item of meta[file]?.imports ?? []) if (item.kind === "import-statement") visit(item.path);
  };
  const relative = (file) => path.relative(process.cwd(), file);
  visit(relative(first.path));
  const initial = outputs.filter((file) => loaded.has(relative(file.path)));
  const initialGzip = initial.reduce((sum, file) => sum + gzipSync(file.contents).length, 0);
  console.log(`first load: ${size(initial)}`);
  console.log(`everything: ${size(outputs)} in ${outputs.length} files`);
  if (initialGzip > BUDGET) {
    console.error(`Over the budget of ${BUDGET / 1024} KB with gzip.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
