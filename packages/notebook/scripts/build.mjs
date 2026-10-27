// Builds the notebook's grid (docs/notebook.md): `python/src/vastgrid/static/widget.js` and `widget.css`, the anywidget
// module and styles that the Python package `vastgrid` carries.
import { fileURLToPath } from "node:url";
import { buildPage, printSizes } from "../../../scripts/build-page.mjs";

const root = new URL("..", import.meta.url);
const result = await buildPage({
  entryPoints: { widget: fileURLToPath(new URL("widget/main.tsx", root)) },
  outdir: fileURLToPath(new URL("python/src/vastgrid/static", root)),
  metafile: true,
});
printSizes(result, "static");
