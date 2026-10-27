// Builds the grid's pages for the apps (the command line, the MCP App, the VS Code webview, the notebook's widget):
// one script and its styles, minified, with React Compiler's output of the packages' builds (`npm run build` at the
// root first). The menus and panels that the grid loads when they open are in the same file: a page loads nothing
// else.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Builds the page's script and styles with esbuild, given the entry points and the output options. */
export function buildPage(options) {
  return build({
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    splitting: false,
    legalComments: "none",
    logLevel: "warning",
    ...options,
    define: { "process.env.NODE_ENV": '"production"', ...options.define },
  });
}

/** Builds `app/main.tsx` of a package into `dist/app.html`: `app/index.html` with the script and styles inside. */
export async function buildHtmlPage(root, define = {}) {
  const result = await buildPage({
    entryPoints: [fileURLToPath(new URL("app/main.tsx", root))],
    write: false,
    outdir: "out",
    define,
  });
  const output = (extension) => result.outputFiles.find((file) => file.path.endsWith(extension))?.text ?? "";
  // Neither may end the element that holds it.
  const script = output(".js").replaceAll("</script", "<\\/script");
  const styles = output(".css").replaceAll("</style", "<\\/style");
  const page = readFileSync(new URL("app/index.html", root), "utf8")
    .replace("<!--styles-->", () => `<style>${styles}</style>`)
    .replace("<!--script-->", () => `<script type="module">${script}</script>`);
  mkdirSync(new URL("dist/", root), { recursive: true });
  writeFileSync(new URL("dist/app.html", root), page);
  console.log(`dist/app.html: ${(page.length / 1024).toFixed(1)} KB`);
}

/** Prints the size of each file that a build with `metafile` wrote, from the folder `folder` on. */
export function printSizes(result, folder) {
  for (const [name, output] of Object.entries(result.metafile.outputs)) {
    console.log(`${name.replace(new RegExp(`^.*/${folder}/`), `${folder}/`)}: ${(output.bytes / 1024).toFixed(1)} KB`);
  }
}
