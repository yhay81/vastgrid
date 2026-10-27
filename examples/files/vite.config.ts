import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";

/** The folder whose files the page opens: `VASTGRID_DATA`, or the benches' data (`.data/bench`). */
const data = path.resolve(process.env.VASTGRID_DATA ?? path.join(import.meta.dirname, "..", "..", ".data", "bench"));

/**
 * The DuckDB engine behind the page: requests at `/api` and events at `/api/events` (docs/v2-spec.md §8.8), in the
 * dev server and in the preview of the build.
 */
function engine(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    mkdirSync(data, { recursive: true });
    const made = DuckDBEngine.create({
      allowedDirectories: [data],
      tempDirectory: path.join(os.tmpdir(), "vastgrid-files-example"),
      // `VASTGRID_SAVE=1` lets the page save edited cells into the CSV and TSV files of the folder (⌘S or Ctrl+S).
      saveFiles: process.env.VASTGRID_SAVE === "1",
      log: (message, error) => server.config.logger.warn(`${message}: ${String(error ?? "")}`),
    });
    const handler = made.then((created) => createHttpHandler(created, { path: "/api" }));
    server.middlewares.use((request, response, next) => {
      void handler.then((handle) => handle(request, response, next)).catch(next);
    });
    server.httpServer?.on("close", () => {
      void made.then((created) => created.dispose());
    });
  };
  return { name: "vastgrid-duckdb", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig({
  plugins: [react(), engine()],
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5182, strictPort: true },
  preview: { host: "127.0.0.1", port: 5183, strictPort: true },
});
