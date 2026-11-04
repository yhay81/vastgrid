// Builds the extension (docs/vscode.md): `dist/extension.cjs`, which VS Code loads in the extension's process, and
// the webview's page, `dist/webview.js` and `dist/webview.css` (scripts/build-page.mjs at the root). DuckDB's native
// bindings stay outside, as `require`s of `@duckdb/node-bindings`, which a package of the extension carries
// (scripts/package.mjs) and which, run from this folder (`test:vscode`, F5), the extension finds as its dependency.
import { fileURLToPath } from "node:url";
import { build } from "vite/rolldown";
import { buildPage, printSizes } from "../../../scripts/build-page.mjs";

const root = new URL("..", import.meta.url);
const file = (name) => fileURLToPath(new URL(name, root));

// With Rolldown, Vite's bundler, for the Node.js of VS Code: 20 in VS Code 1.100, the oldest that the extension takes.
await build({
  input: file("src/extension.ts"),
  platform: "node",
  external: ["vscode", /^@duckdb\/node-bindings/],
  transform: { target: "node20" },
  logLevel: "warn",
  output: { file: file("dist/extension.cjs"), format: "cjs", minify: true, sourcemap: true, comments: false },
});

printSizes(await buildPage({ input: { webview: file("webview/main.tsx") }, outDir: file("dist") }), "dist");
