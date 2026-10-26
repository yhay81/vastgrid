import { defineConfig } from "@playwright/test";

// The end-to-end tests and the performance budgets of v2-react.md §10, on the bench page built from the packages'
// builds: `npm run build`, then `npm run e2e`, which builds the page before it runs the tests (a server already
// running on the port serves the new build).
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5181", viewport: { width: 1280, height: 800 } },
  // Chromium as it is, not a device's user agent: the grid takes ⌘ or Ctrl from the platform it runs on.
  projects: [{ name: "chromium", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      command: "npm run preview -w vastgrid-bench",
      url: "http://127.0.0.1:5181",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // e2e/files.spec.ts: files of a folder in v2's grid, read by the DuckDB engine on this server.
      command: "npm run build -w vastgrid-files-example && npm run preview -w vastgrid-files-example",
      url: "http://127.0.0.1:5183",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // e2e/mcp.spec.ts: the MCP App in a host's sandboxed frame, with the built server over stdio.
      command: "npm run build -w vastgrid-mcp && node --import tsx packages/mcp/host/serve.ts .data/mcp-e2e 5184",
      url: "http://127.0.0.1:5184",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
