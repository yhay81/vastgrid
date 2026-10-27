// Builds the extension (docs/vscode.md): `dist/extension.cjs`, which VS Code loads in the extension's process, and
// the webview's page, `dist/webview.js` and `dist/webview.css`. It bundles the packages' builds (`npm run build` at
// the root first), React Compiler's output included. DuckDB's native bindings stay outside, as `require`s of
// `@duckdb/node-bindings`, which a package of the extension carries (scripts/package.mjs).
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("..", import.meta.url);
const file = (name) => fileURLToPath(new URL(name, root));

await build({
  entryPoints: [file("src/extension.ts")],
  outfile: file("dist/extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "@duckdb/node-bindings"],
  sourcemap: true,
  legalComments: "none",
  logLevel: "warning",
});

const page = await build({
  entryPoints: { webview: file("webview/main.tsx") },
  outdir: file("dist"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  // The menus and panels that the grid loads when they open are in the same file: the page loads nothing else.
  splitting: false,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});
for (const [name, output] of Object.entries(page.metafile.outputs)) {
  console.log(`${name.replace(/^.*\/dist\//, "dist/")}: ${(output.bytes / 1024).toFixed(1)} KB`);
}
