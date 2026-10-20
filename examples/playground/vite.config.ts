import path from "node:path";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import { tableServer } from "./server.ts";

const dataDirectory = path.resolve(process.env.VASTGRID_DATA ?? path.join(import.meta.dirname, ".data"));

export default defineConfig({
  plugins: [react(), tableServer(dataDirectory)],
  // Use the TypeScript sources of the packages, so that edits apply without building them.
  resolve: { conditions: ["vastgrid-source", ...defaultClientConditions] },
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 5174), strictPort: false },
});
