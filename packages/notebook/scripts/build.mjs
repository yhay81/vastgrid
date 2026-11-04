// Builds the notebook's grid (docs/notebook.md): `python/src/vastgrid/static/widget.js` and `widget.css`, the anywidget
// module and styles that the Python package `vastgrid` carries.
import { fileURLToPath } from "node:url";
import { buildPage, printSizes } from "../../../scripts/build-page.mjs";

const root = new URL("..", import.meta.url);
const files = await buildPage({
  input: { widget: fileURLToPath(new URL("widget/main.tsx", root)) },
  outDir: fileURLToPath(new URL("python/src/vastgrid/static", root)),
});
printSizes(files, "static");
