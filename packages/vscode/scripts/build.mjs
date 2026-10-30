// Builds the extension (docs/vscode.md): `dist/extension.cjs`, which VS Code loads in the extension's process, and
// the webview's page, `dist/webview.js` and `dist/webview.css` (scripts/build-page.mjs at the root). DuckDB's native
// bindings stay outside, as `require`s of `@duckdb/node-bindings`, which a package of the extension carries
// (scripts/package.mjs).
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPage, printSizes } from "../../../scripts/build-page.mjs";

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
  minify: true,
  sourcemap: true,
  legalComments: "none",
  logLevel: "warning",
});

const page = await buildPage({
  entryPoints: { webview: file("webview/main.tsx") },
  outdir: file("dist"),
  metafile: true,
});
printSizes(page, "dist");
