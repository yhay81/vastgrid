// Builds the page of `vastgrid` (docs/cli.md): one HTML file with its script and styles inside, which the server
// serves at `/`. It bundles the packages' builds (`npm run build` at the root first), React Compiler's output included.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("..", import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(new URL("app/main.tsx", root))],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  minify: true,
  // The menus and panels that the grid loads when they open are in the same file: the server serves one page.
  splitting: false,
  outdir: "out",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
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
