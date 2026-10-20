import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createTableHandler, TableEngine, tableFormatOf } from "vastgrid-duckdb";
import type { Plugin } from "vite";

/** Resolves a path relative to `root`, refusing anything that leaves it (also through symbolic links). */
async function resolveInside(root: string, ref: string, mustExist = true) {
  if (path.isAbsolute(ref) || ref.split(/[\\/]/).includes(".."))
    throw new Error("The path must stay inside the data folder.");
  const target = path.join(root, ref);
  const real = mustExist
    ? await realpath(target)
    : path.join(await realpath(path.dirname(target)), path.basename(target));
  if (real !== root && !real.startsWith(`${root}${path.sep}`))
    throw new Error("The path must stay inside the data folder.");
  return real;
}

async function listTables(root: string) {
  const files: { path: string; size: number }[] = [];
  async function walk(folder: string, depth: number) {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && depth < 3) await walk(relative, depth + 1);
      else if (entry.isFile() && tableFormatOf(entry.name)) {
        files.push({ path: relative, size: (await stat(path.join(root, relative))).size });
      }
    }
  }
  await walk("", 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function toRequest(request: IncomingMessage, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Request(`http://localhost${request.url ?? "/"}`, {
    method: request.method,
    headers: { "content-type": String(request.headers["content-type"] ?? "application/json") },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
    signal,
  });
}

async function send(response: ServerResponse, result: Response) {
  response.statusCode = result.status;
  for (const [key, value] of result.headers) response.setHeader(key, value);
  response.end(Buffer.from(await result.arrayBuffer()));
}

/** Serves the vastgrid protocol for the table files in `dataDirectory` from the Vite dev server. */
export function tableServer(dataDirectory: string): Plugin {
  return {
    name: "vastgrid-table-server",
    async configureServer(server) {
      const root = await realpath(dataDirectory);
      const engine = TableEngine.create({
        allowedDirectories: [root],
        tempDirectory: path.join(os.tmpdir(), "vastgrid-playground"),
        log: (message, error) =>
          server.config.logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`),
      });
      const handler = createTableHandler({
        engine: () => engine,
        resolve: (ref) => resolveInside(root, ref),
        resolveTarget: (target) => resolveInside(root, target, false),
        onError: (error) => server.config.logger.error(String(error instanceof Error ? error.stack : error)),
      });
      server.middlewares.use("/api/table", (request, response) => {
        const controller = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) controller.abort();
        });
        void toRequest(request, controller.signal)
          .then((input) => handler(input))
          .then((result) => send(response, result))
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      server.middlewares.use("/api/files", (_request, response) => {
        void listTables(root).then(
          (files) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ root, files }));
          },
          (error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          },
        );
      });
      server.httpServer?.once("close", () => {
        void engine.then((instance) => instance.dispose());
      });
    },
  };
}
