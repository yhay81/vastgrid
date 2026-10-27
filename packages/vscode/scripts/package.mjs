// Packages the extension for one platform (docs/vscode.md): a `.vsix` of the build (`npm run build` at the root
// first) with DuckDB's native bindings of that platform, which `dist/extension.cjs` requires from
// `dist/node_modules`. `node scripts/package.mjs [target]` takes VS Code's target (darwin-arm64, linux-x64,
// alpine-x64, win32-x64, ...), this machine's by default, and writes `dist/vastgrid-vscode-<version>-<target>.vsix`.
// The bindings of another platform are fetched from npm, of the version installed here.
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/** VS Code's targets, with the package of DuckDB's bindings for each (`@duckdb/node-bindings-<name>`). */
const BINDINGS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linux-x64-musl",
  "alpine-arm64": "linux-arm64-musl",
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
};

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const binding = BINDINGS[target];
if (!binding) throw new Error(`vastgrid is packaged for ${Object.keys(BINDINGS).join(", ")}, not ${target}.`);

/** The folder of an installed package. */
function installed(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

const stage = await mkdtemp(path.join(os.tmpdir(), "vastgrid-vscode-package-"));
try {
  // The manifest without what only the workspace uses.
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const key of ["private", "exports", "scripts", "dependencies", "devDependencies"]) delete manifest[key];
  manifest.files = ["dist/**", "LICENSE"];
  await writeFile(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(path.join(root, "README.md"), path.join(stage, "README.md"));
  await copyFile(path.join(root, "..", "..", "LICENSE"), path.join(stage, "LICENSE"));
  await mkdir(path.join(stage, "dist"));
  for (const name of ["extension.cjs", "webview.js", "webview.css"]) {
    await copyFile(path.join(root, "dist", name), path.join(stage, "dist", name));
  }

  // The bindings: the package that loads them, with its dependency, and the platform's.
  const modules = path.join(stage, "dist", "node_modules");
  const bindings = installed("@duckdb/node-bindings");
  const { version } = JSON.parse(await readFile(path.join(bindings, "package.json"), "utf8"));
  await cp(bindings, path.join(modules, "@duckdb", "node-bindings"), { recursive: true });
  await cp(installed("detect-libc"), path.join(modules, "detect-libc"), { recursive: true });
  const platform = path.join(modules, "@duckdb", `node-bindings-${binding}`);
  const local = (() => {
    try {
      return installed(`@duckdb/node-bindings-${binding}`);
    } catch {
      return null;
    }
  })();
  if (local && JSON.parse(await readFile(path.join(local, "package.json"), "utf8")).version === version) {
    await cp(local, platform, { recursive: true });
  } else {
    const fetched = path.join(stage, "fetched");
    await mkdir(fetched);
    execFileSync("npm", ["pack", `@duckdb/node-bindings-${binding}@${version}`, "--pack-destination", fetched], {
      stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32",
    });
    const [tarball] = await readdir(fetched);
    await mkdir(platform);
    execFileSync("tar", ["-xzf", path.join(fetched, tarball), "-C", platform, "--strip-components=1"]);
    await rm(fetched, { recursive: true });
  }
  // The bindings of this machine load from the package as the extension loads them.
  if (target === `${process.platform}-${process.arch}`) {
    execFileSync(process.execPath, [
      "-e",
      `require(${JSON.stringify(path.join(modules, "@duckdb", "node-bindings"))})`,
    ]);
  }

  const out = path.join(root, "dist", `vastgrid-vscode-${manifest.version}-${target}.vsix`);
  const vsce = path.join(installed("@vscode/vsce"), "vsce");
  execFileSync(process.execPath, [vsce, "package", "--target", target, "--no-dependencies", "--out", out], {
    cwd: stage,
    stdio: "inherit",
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
