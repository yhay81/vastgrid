import { mkdirSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { isSuite, suites } from "./e2e/suites.ts";

// pnpm run e2e runs the functional suites in turn; pass a suite to run just its tests and server.
// A direct `playwright test` defaults to the grid. The packages must already be built (pnpm run build).
const name = process.env.VASTGRID_E2E_SUITE ?? "grid";
if (!isSuite(name)) throw new Error(`Unknown E2E suite: ${name}`);
const suite = suites[name];
if (name === "cli") mkdirSync(".data/cli-e2e", { recursive: true });

export default defineConfig({
  testDir: "e2e",
  testMatch: suite.tests.map((file) => `**/${file}.spec.ts`),
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: [["list"]],
  outputDir: `test-results/${name}`,
  use: { baseURL: suite.server.url, viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  // Chromium without a device's user agent: the grid takes ⌘ or Ctrl from the platform it runs on.
  projects: (name === "browsers" ? (["chromium", "firefox", "webkit"] as const) : (["chromium"] as const)).map(
    (browserName) => ({
      name: browserName,
      use: {
        browserName,
        ...(browserName === "firefox" && process.env.VASTGRID_FIREFOX_HOME
          ? { launchOptions: { env: { ...process.env, CFFIXED_USER_HOME: process.env.VASTGRID_FIREFOX_HOME } } }
          : {}),
      },
    }),
  ),
  webServer: { ...suite.server, reuseExistingServer: name !== "notebook" && !process.env.CI, timeout: 120_000 },
});
