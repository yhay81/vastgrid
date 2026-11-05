/** Run each selected suite with Playwright's own server lifecycle and argument parsing. */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { functionalSuites, isSuite, suites } from "../e2e/suites.ts";

const args = process.argv.slice(2);
const first = args[0];
if (first && !first.startsWith("-") && !isSuite(first)) {
  throw new Error(
    `Choose an E2E suite (${Object.keys(suites).join(", ")}), then Playwright arguments. Example: pnpm run e2e grid grid.spec.ts`,
  );
}
const selected = first && isSuite(first) ? [first] : functionalSuites;
if (first && isSuite(first)) args.shift();
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
// Firefox 157 touches macOS's protected personal app-data directory even with a temporary profile. Give this
// test process its own home until Playwright ships the upstream fix: microsoft/playwright#42768.
const firefoxHome =
  process.platform === "darwin" && selected.includes("browsers")
    ? await mkdtemp(join(tmpdir(), "vastgrid-firefox-"))
    : undefined;
try {
  for (const suite of selected) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "test", "--config=playwright.config.ts", ...args], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          VASTGRID_E2E_SUITE: suite,
          ...(firefoxHome ? { VASTGRID_FIREFOX_HOME: firefoxHome } : {}),
        },
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
} finally {
  if (firefoxHome) {
    // macOS puts deny-delete ACLs on the Library/Downloads folders it creates in this temporary home.
    await promisify(execFile)("chmod", ["-RN", firefoxHome]);
    await rm(firefoxHome, { recursive: true, force: true });
  }
}
