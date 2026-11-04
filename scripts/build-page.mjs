// Builds the grid's pages for the apps (the command line, the MCP App, the VS Code webview, the notebook's widget):
// one script and its styles, minified, with React Compiler's output of the packages' builds (`pnpm run build` at the
// root first). The menus and panels that the grid loads when they open are in the same file: a page loads nothing
// else.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";

/**
 * Builds a page's script and styles with Vite, whose bundler is Rolldown: `input` names the entry points, whose files
 * in `outDir` take their names. Without `outDir` nothing is written. Resolves with the files.
 */
export async function buildPage({ input, outDir, define = {} }) {
  const result = await build({
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": '"production"', ...define },
    build: {
      outDir,
      write: outDir !== undefined,
      emptyOutDir: false,
      target: "es2022",
      modulePreload: false,
      reportCompressedSize: false,
      // The grid with all its parts, in one file.
      chunkSizeWarningLimit: 1000,
      rolldownOptions: {
        input,
        // The notebook's widget is a module, whose exports anywidget reads.
        preserveEntrySignatures: "strict",
        // The grid's "use client", for React Server Components, means nothing in a page.
        checks: { moduleLevelDirective: false },
        output: {
          codeSplitting: false,
          entryFileNames: "[name].js",
          assetFileNames: "[name][extname]",
          comments: false,
        },
      },
    },
  });
  return (Array.isArray(result) ? result[0] : result).output;
}

/** The text of a file of a build. */
function textOf(file) {
  if (file.type === "chunk") return file.code;
  return typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
}

/** Builds `app/main.tsx` of a package into `dist/app.html`: `app/index.html` with the script and styles inside. */
export async function buildHtmlPage(root, define = {}) {
  const files = await buildPage({ input: fileURLToPath(new URL("app/main.tsx", root)), define });
  const output = (extension) => {
    const file = files.find((item) => item.fileName.endsWith(extension));
    return file ? textOf(file) : "";
  };
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

/** Prints the size of each file of a build that `buildPage` wrote into the folder `folder`. */
export function printSizes(files, folder) {
  for (const file of files) {
    console.log(`${folder}/${file.fileName}: ${(Buffer.byteLength(textOf(file)) / 1024).toFixed(1)} KB`);
  }
}
