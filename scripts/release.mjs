// Release helpers, run from the repository root. See "Releasing" in CONTRIBUTING.md.
//
//   node scripts/release.mjs version <version>   sets the version of the packages and of what refers to them
//   node scripts/release.mjs check <version>     checks that the packages and CHANGELOG.md are at that version
//   node scripts/release.mjs notes <version>     prints the CHANGELOG.md section of that version
//   node scripts/release.mjs python <version>    prints the Python package's version for that version
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** The packages published to npm, in the order they are published: each after those it depends on. */
const NPM_PACKAGES = [
  "packages/spec",
  "packages/sql",
  "packages/js",
  "packages/grid",
  "packages/duckdb-engine",
  "packages/cli",
  "packages/mcp",
];
/**
 * Workspaces released with them elsewhere (the VS Code extension on the Marketplace, the notebook's Python
 * package on PyPI) or not at all (the examples and the site), which depend on the packages.
 */
const others = ["packages/vscode", "packages/notebook", "examples/bench", "examples/files", "site"];
const pyproject = "packages/notebook/python/pyproject.toml";
/** uv's lockfile, which holds the version of the package itself. */
const uvLock = "packages/notebook/python/uv.lock";
const lockedVersion = /(\nname = "vastgrid"\nversion = )"([^"]*)"(\nsource = \{ editable = "\." \})/;
const commands = {
  version: setVersion,
  check,
  notes: () => process.stdout.write(`${absoluteLinks(section())}\n`),
  python: () => process.stdout.write(`${pythonVersion(version)}\n`),
};

const [command, version] = process.argv.slice(2);
if (!Object.hasOwn(commands, command)) fail("Usage: node scripts/release.mjs version|check|notes|python <version>");
if (!/^\d+\.\d+\.\d+(-next\.\d+)?$/.test(version ?? "")) {
  fail(`"${version ?? ""}" is not a version: 0.2.0, or 0.2.0-next.1 for a pre-release.`);
}
commands[command]();

/** The workspaces whose `version` is the release's: the npm packages and the extension. */
function versioned() {
  return [...NPM_PACKAGES, "packages/vscode", "packages/notebook"];
}

/**
 * PEP 440 has no `-next.N`: a pre-release `0.2.0-next.3` is `0.2.0rc3` on PyPI, which sorts before 0.2.0 there
 * as on npm.
 */
function pythonVersion(value) {
  return value.replace(/-next\.(\d+)$/, "rc$1");
}

function setVersion() {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  if (!changelog.includes("\n## Unreleased\n")) fail('CHANGELOG.md has no "## Unreleased" section.');
  for (const dir of [...NPM_PACKAGES, ...others]) {
    const manifest = readJson(`${dir}/package.json`);
    if (versioned().includes(dir)) manifest.version = version;
    // The packages depend on each other at exactly the version they are released with. With another version, npm
    // would also install the workspaces' vastgrid packages from the registry instead of linking them.
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (/^vastgrid(-|$)/.test(name)) manifest[field][name] = version;
      }
    }
    writeJson(`${dir}/package.json`, manifest);
  }
  const python = readFileSync(pyproject, "utf8");
  writeFileSync(pyproject, python.replace(/^version = ".*"$/m, `version = "${pythonVersion(version)}"`));
  const lock = readFileSync(uvLock, "utf8");
  if (!lockedVersion.test(lock)) fail(`${uvLock} has no version of the package vastgrid.`);
  writeFileSync(uvLock, lock.replace(lockedVersion, `$1"${pythonVersion(version)}"$3`));
  writeFileSync("CHANGELOG.md", changelog.replace("\n## Unreleased\n", `\n## ${version} — ${today()}\n`));
  execSync("npm install --package-lock-only --ignore-scripts", { stdio: "inherit" });
}

function check() {
  const problems = [];
  for (const dir of [...NPM_PACKAGES, ...others]) {
    const manifest = readJson(`${dir}/package.json`);
    if (versioned().includes(dir) && manifest.version !== version) {
      problems.push(`${manifest.name} is at ${manifest.version}.`);
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (/^vastgrid(-|$)/.test(name) && range !== version) {
          problems.push(`${manifest.name} depends on ${name} ${range}.`);
        }
      }
    }
    if (NPM_PACKAGES.includes(dir) && manifest.private) problems.push(`${manifest.name} is private.`);
  }
  const python = /^version = "(.*)"$/m.exec(readFileSync(pyproject, "utf8"))?.[1];
  if (python !== pythonVersion(version)) problems.push(`The Python package is at ${python}.`);
  const locked = lockedVersion.exec(readFileSync(uvLock, "utf8"))?.[2];
  if (locked !== pythonVersion(version)) problems.push(`${uvLock} has the Python package at ${locked}.`);
  if (problems.length > 0) fail(`${problems.join("\n")}\nRun: node scripts/release.mjs version ${version}`);
  section();
}

function section() {
  const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) fail(`CHANGELOG.md has no section for ${version}.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** Links relative to the repository, made absolute at the release's tag, as the GitHub release shows them. */
function absoluteLinks(text) {
  return text.replace(/\]\((?!https?:|#)([^)\s]+)\)/g, `](https://github.com/yhay81/vastgrid/blob/v${version}/$1)`);
}

function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
