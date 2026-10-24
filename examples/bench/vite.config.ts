import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The bench measures what ships: the packages' builds (`npm run build`), in a production build of the page, with
// React's profiling build so that `<Profiler>` reports commits.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "react-dom/client": "react-dom/profiling" } },
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
  preview: { host: "127.0.0.1", port: 5181, strictPort: true },
});
