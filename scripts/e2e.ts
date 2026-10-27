/** Run each selected suite with Playwright's own server lifecycle and argument parsing. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { functionalSuites, isSuite, suites } from "../e2e/suites.ts";

const args = process.argv.slice(2);
const first = args[0];
if (first && !first.startsWith("-") && !isSuite(first)) {
  throw new Error(
    `Choose an E2E suite (${Object.keys(suites).join(", ")}), then Playwright arguments. Example: npm run e2e -- grid grid.spec.ts`,
  );
}
const selected = first && isSuite(first) ? [first] : functionalSuites;
if (first && isSuite(first)) args.shift();
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
for (const suite of selected) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "test", "--config=playwright.config.ts", ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, VASTGRID_E2E_SUITE: suite },
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
