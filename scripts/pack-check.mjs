// Installs the packed packages in a new project, as a user does, and runs what their READMEs show: a store over the
// memory engine and over the DuckDB engine, `DataGrid` rendered on the server and bundled for a browser, the
// command line's page and the MCP server's tools. It catches files missing from a package, exports that point
// nowhere and dependencies that only the workspace has.
//
//   node scripts/pack-check.mjs [<folder of .tgz files>]
//
// Without a folder, it packs the packages of `npm run build` (run it first). The Release workflow gives it the
// tarballs that it publishes.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const PACKAGES = [
  "packages/spec",
  "packages/sql",
  "packages/js",
  "packages/grid",
  "packages/duckdb-engine",
  "packages/cli",
  "packages/mcp",
];
/** What a script in the new project runs (Node.js). */
const CHECK = `
import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DataGrid } from "vastgrid";
import { createGridStore, localTransport } from "vastgrid/core";
import { readInitialView } from "vastgrid/server";
import { DuckDBEngine } from "vastgrid-duckdb";
import { memoryEngine } from "vastgrid-js";
import { checkPlan } from "vastgrid-spec";
import { compileView } from "vastgrid-sql";

assert.equal(typeof checkPlan, "function");
assert.equal(typeof compileView, "function");

async function until(test) {
  const deadline = Date.now() + 20_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The values of a column in the store's view, after sorting it by price, largest first. */
async function sortedIds(transport, table) {
  const store = createGridStore({ transport, table });
  const disconnect = store.connect();
  try {
    const ready = () => store.getSnapshot().status === "ready" && store.getSnapshot().view?.status === "ready";
    await until(ready);
    await store.dispatch({ command: "sort.set", keys: [{ column: "price", direction: "desc" }] });
    await until(() => ready() && store.getSnapshot().view.rowCount === 4 && !store.getSnapshot().pending);
    store.ensure(0, 4, ["id"]);
    await until(() => [0, 1, 2, 3].every((row) => store.cell(row, "id") !== undefined));
    return [0, 1, 2, 3].map((row) => store.cell(row, "id"));
  } finally {
    disconnect();
  }
}

const columns = [{ name: "id", type: "integer" }, { name: "region", type: "string" }, { name: "price", type: "float" }];
const rows = [[1, "EU", 10.5], [2, "US", 30], [3, "EU", 20], [4, "JP", 5]];
const memory = localTransport(memoryEngine({ tables: { orders: { columns, rows } } }));
assert.deepEqual(await sortedIds(memory, "orders"), [2, 3, 1, 4]);

const engine = await DuckDBEngine.create({ allowedDirectories: [path.resolve("data")], tempDirectory: path.resolve("duckdb") });
try {
  const duckdb = localTransport(engine);
  assert.deepEqual(await sortedIds(duckdb, path.resolve("data/orders.csv")), [2, 3, 1, 4]);
} finally {
  await engine.dispose();
}

const initial = await readInitialView(memory, { table: "orders", rows: 4 });
const html = renderToString(createElement(DataGrid, { transport: memory, table: "orders", initial, "aria-label": "orders" }));
// The first rows as a table, which the canvas replaces in the browser (§7 of v2-react.md).
assert.match(html, /<table class="vg-static" aria-label="orders" aria-rowcount="5">/);
assert.match(html, /JP/);
`;

/** A page in the new project, bundled for a browser. */
const PAGE = `
import { createRoot } from "react-dom/client";
import { DataGrid } from "vastgrid";
import "vastgrid/styles.css";
import { localTransport } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders: { columns: [{ name: "id", type: "integer" }], rows: [[1]] } } }));
createRoot(document.getElementById("root")).render(<DataGrid transport={transport} table="orders" toolbar statusBar />);
`;

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = mkdtempSync(path.join(tmpdir(), "vastgrid-pack-"));
const app = path.join(root, "app");
const data = path.join(app, "data");
mkdirSync(data, { recursive: true });

try {
  const tarballs = path.resolve(process.argv[2] ?? path.join(root, "packages"));
  if (!process.argv[2]) {
    mkdirSync(tarballs);
    const workspaces = PACKAGES.flatMap((dir) => ["-w", dir]);
    execFileSync(npm, ["pack", ...workspaces, "--pack-destination", tarballs, "--silent"], { stdio: "ignore" });
  }
  const files = readdirSync(tarballs).filter((name) => name.endsWith(".tgz"));
  if (files.length !== PACKAGES.length)
    throw new Error(`${tarballs} has ${files.length} packages, not ${PACKAGES.length}.`);

  // React at the version the workspace tests with; the packages from their tarballs alone.
  const { devDependencies } = JSON.parse(readFileSync("package.json", "utf8"));
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
  const installs = [
    ...files.map((name) => path.join(tarballs, name)),
    `react@${devDependencies.react}`,
    `react-dom@${devDependencies["react-dom"]}`,
  ];
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", ...installs], {
    cwd: app,
    stdio: "inherit",
  });
  writeFileSync(path.join(data, "orders.csv"), "id,region,price\n1,EU,10.5\n2,US,30\n3,EU,20\n4,JP,5\n");

  step("stores over the memory engine and the DuckDB engine, and DataGrid on the server");
  writeFileSync(path.join(app, "check.mjs"), CHECK);
  execFileSync(process.execPath, ["check.mjs"], { cwd: app, stdio: "inherit" });

  step("DataGrid bundled for a browser, with its styles and the parts it loads later");
  writeFileSync(path.join(app, "page.jsx"), PAGE);
  await build({
    absWorkingDir: app,
    entryPoints: ["page.jsx"],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: path.join(root, "out"),
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });

  step("vastgrid-cli serves its page");
  await checkCli();

  step("vastgrid-mcp lists its tools and opens a file");
  await checkMcp();
  console.log(`\nThe ${PACKAGES.length} packages work as installed from their tarballs.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function step(name) {
  console.log(`- ${name}`);
}

async function checkCli() {
  const binary = path.join(app, "node_modules", "vastgrid-cli", "dist", "cli.js");
  const child = spawn(process.execPath, [binary, "--no-open", "--port", "0", "data/orders.csv"], { cwd: app });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /(https?:\/\/\S+)\r?\n/.exec(output);
        if (match) resolve(match[1]);
      });
      child.on("exit", (code) => reject(new Error(`vastgrid-cli stopped (${code}): ${output}`)));
      setTimeout(() => reject(new Error(`vastgrid-cli printed no address: ${output}`)), 30_000);
    });
    // The address sets the token's cookie and sends the browser on to the page without it.
    const first = await fetch(url, { redirect: "manual" });
    const cookie = first.headers.get("set-cookie")?.split(";")[0];
    const page = new URL(first.headers.get("location") ?? "/", url);
    const response = await fetch(page, { headers: { cookie: cookie ?? "" } });
    const html = await response.text();
    if (!response.ok || !html.includes("<script")) throw new Error(`${page} answered ${response.status}.`);
  } finally {
    child.kill();
  }
}

async function checkMcp() {
  const binary = path.join(app, "node_modules", "vastgrid-mcp", "dist", "cli.js");
  const child = spawn(process.execPath, [binary, "data"], { cwd: app, stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      answers.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`vastgrid-mcp did not answer ${method}.`)), 30_000);
      answers.set(++id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const client = { name: "pack-check", version: "1.0.0" };
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: client });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { tools } = await request("tools/list", {});
    const names = tools.map((tool) => tool.name);
    for (const name of ["list_files", "open_grid", "grid_state", "grid_rows", "grid_command"]) {
      if (!names.includes(name)) throw new Error(`vastgrid-mcp has no ${name}: ${names.join(", ")}`);
    }
    const opened = await request("tools/call", { name: "open_grid", arguments: { file: "orders.csv" } });
    if (opened.isError) throw new Error(`open_grid failed: ${JSON.stringify(opened.content)}`);
    const grid = opened.structuredContent?.grid;
    const rows = await request("tools/call", { name: "grid_rows", arguments: { grid, columns: ["id"], count: 4 } });
    const ids = JSON.stringify(rows.structuredContent?.rows);
    if (ids !== "[[1],[2],[3],[4]]") throw new Error(`grid_rows gave ${ids}.`);
  } finally {
    child.kill();
  }
}
