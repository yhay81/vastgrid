// Builds the notebook's grid (docs/notebook.md): `python/src/vastgrid/static/widget.js` and `widget.css`, the anywidget
// module and styles that the Python package `vastgrid` carries. It bundles the packages' builds (`npm run build` at
// the root first), React Compiler's output included.
import { build } from "esbuild";

const root = new URL("..", import.meta.url);
const result = await build({
  entryPoints: { widget: new URL("widget/main.tsx", root).pathname },
  outdir: new URL("python/src/vastgrid/static", root).pathname,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  // The menus and panels that the grid loads when they open are in the same file: the widget is one module.
  splitting: false,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});
for (const [name, output] of Object.entries(result.metafile.outputs)) {
  console.log(`${name.replace(/^.*\/static\//, "static/")}: ${(output.bytes / 1024).toFixed(1)} KB`);
}
