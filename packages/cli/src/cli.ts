#!/usr/bin/env node
/**
 * `vastgrid [--save] [--port <n>] [--no-open] [<file or folder>…]` (docs/cli.md): starts DuckDB and the page that
 * shows the files in v2's grid, on 127.0.0.1, and opens the page in the browser. Ctrl+C stops both, and the engine
 * deletes its temporary folder.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { serve } from "./server.js";

const USAGE = `Usage: vastgrid [options] [<file or folder>…]

Opens CSV, TSV, Parquet, JSON Lines and Excel files in a grid in the browser, read by DuckDB on this computer.
A folder gives its files, two folders deep; the current folder when nothing is named.

Options:
  --save       Let the page save edited cells into CSV and TSV files (⌘S or Ctrl+S).
  --port <n>   The port on 127.0.0.1; a free one by default.
  --no-open    Print the address without opening the browser.
  -h, --help   Show this help.

VASTGRID_TOKEN sets the token in the address, instead of a random one.
`;

function fail(message: string, code: number): never {
  process.stderr.write(`vastgrid: ${message}\n`);
  process.exit(code);
}

let parsed: ReturnType<typeof readArgs>;
function readArgs() {
  return parseArgs({
    allowPositionals: true,
    options: {
      save: { type: "boolean" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}
try {
  parsed = readArgs();
} catch (error) {
  fail(`${(error as Error).message}\nRun vastgrid --help for the options.`, 2);
}
const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`${values.port} is not a port.`, 2);

/** Opens the address in the browser of the system; the address is printed either way. */
function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => process.stderr.write("vastgrid: Open the address in a browser.\n"));
  child.unref();
}

const served = await serve({
  paths: positionals.length > 0 ? positionals : ["."],
  port,
  token: process.env.VASTGRID_TOKEN || undefined,
  save: values.save ?? false,
  log: (message, error) => process.stderr.write(`vastgrid: ${message}: ${String(error ?? "")}\n`),
}).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error), 1));

const count = (await served.files()).length;
process.stdout.write(
  `vastgrid shows ${count === 1 ? "1 file" : `${count} files`}${values.save ? ", and saves edited cells," : ""} at\n` +
    `  ${served.url}\nPress Ctrl+C to stop.\n`,
);
if (!values["no-open"]) openBrowser(served.url);

let stopping = false;
function stop() {
  // A second Ctrl+C does not wait.
  if (stopping) process.exit(130);
  stopping = true;
  void served.close().finally(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
