#!/usr/bin/env node
/**
 * vastgrid's MCP server over stdio: `vastgrid-mcp [--save] <folder>…`. The grids open the files of the folders
 * (the current folder when none is named); `--save` lets them save written cells into CSV and TSV files.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DuckDBEngine } from "vastgrid-duckdb";
import { Grids } from "./grids.js";
import { registerVastgrid } from "./server.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: vastgrid-mcp [--save] <folder>…\n");
  process.exit(0);
}
const save = args.includes("--save");
const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--save");
if (unknown) {
  process.stderr.write(`vastgrid-mcp: unknown option ${unknown}\n`);
  process.exit(2);
}
const named = args.filter((arg) => !arg.startsWith("-"));
const folders = (named.length > 0 ? named : [process.cwd()]).map((folder) => path.resolve(folder));
const tempDirectory = path.join(os.tmpdir(), `vastgrid-mcp-${process.pid}`);
mkdirSync(tempDirectory, { recursive: true });

const engine = await DuckDBEngine.create({
  allowedDirectories: folders,
  tempDirectory,
  saveFiles: save,
  // stdout carries MCP's messages: the engine's log goes to stderr.
  log: (message, error) => process.stderr.write(`vastgrid-mcp: ${message}: ${String(error ?? "")}\n`),
});
const grids = new Grids({ engine });
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const handle = serveStdio(() => {
  const server = new McpServer({ name: "vastgrid", version });
  registerVastgrid(server, { engine, folders, grids });
  return server;
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handle.close().catch(() => {});
  grids.dispose();
  await engine.dispose();
  process.exit(0);
}
process.stdin.on("end", () => void close());
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
