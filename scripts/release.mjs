// Release helpers, run from the repository root. See "Releasing" in CONTRIBUTING.md.
//
//   node scripts/release.mjs version <version>   sets the version of the packages and of what refers to them
//   node scripts/release.mjs check <version>     checks that the packages and CHANGELOG.md are at that version
//   node scripts/release.mjs notes <version>     prints the CHANGELOG.md section of that version
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const packages = ["packages/core", "packages/duckdb", "packages/browser", "packages/react"];
// Private workspaces that depend on the packages.
const apps = ["examples/playground/package.json", "site/package.json"];
const commands = { version: setVersion, check, notes: () => process.stdout.write(`${section()}\n`) };

const [command, version] = process.argv.slice(2);
if (!Object.hasOwn(commands, command)) fail("Usage: node scripts/release.mjs version|check|notes <version>");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) fail(`"${version ?? ""}" is not a version.`);
commands[command]();

function setVersion() {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  if (!changelog.includes("\n## Unreleased\n")) fail('CHANGELOG.md has no "## Unreleased" section.');
  for (const dir of packages) {
    const manifest = readJson(`${dir}/package.json`);
    manifest.version = version;
    // A package may use what this version of vastgrid-core added, so it must not get an older one.
    if (manifest.dependencies?.["vastgrid-core"]) manifest.dependencies["vastgrid-core"] = `^${version}`;
    writeJson(`${dir}/package.json`, manifest);
  }
  // With another version, npm would install the apps' vastgrid packages from the registry instead of linking the
  // workspace.
  for (const app of apps) {
    const manifest = readJson(app);
    for (const name of Object.keys(manifest.dependencies)) {
      if (name.startsWith("vastgrid")) manifest.dependencies[name] = version;
    }
    writeJson(app, manifest);
  }
  writeFileSync("CHANGELOG.md", changelog.replace("\n## Unreleased\n", `\n## ${version} — ${today()}\n`));
  execSync("npm install --package-lock-only --ignore-scripts", { stdio: "inherit" });
}

function check() {
  const problems = [];
  for (const dir of packages) {
    const { name, version: current, dependencies } = readJson(`${dir}/package.json`);
    if (current !== version) problems.push(`${name} is at ${current}.`);
    const core = dependencies?.["vastgrid-core"];
    if (core && core !== `^${version}`) problems.push(`${name} depends on vastgrid-core ${core}.`);
  }
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
