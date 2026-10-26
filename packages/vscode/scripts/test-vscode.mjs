// Runs the extension in VS Code (docs/vscode.md): `test/vscode/suite.cjs` opens, edits, saves, reverts and opens
// again files of a folder made here, in a window of its own with a profile of its own. It needs the build
// (`npm run build` at the root). VS Code is the one at `VSCODE_PATH`, or a stable one that @vscode/test-electron
// downloads into `.vscode-test`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { TableFile } from "../dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), "vastgrid-vscode-test-"));
const folder = path.join(work, "data");
const profile = path.join(work, "profile");
await mkdir(folder);
await mkdir(path.join(profile, "User"), { recursive: true });
// Files are editable in a trusted workspace only: the window trusts its folder without asking.
await writeFile(
  path.join(profile, "User", "settings.json"),
  JSON.stringify({ "security.workspace.trust.enabled": false, "workbench.startupEditor": "none" }),
);
const csv = 'id,region,price\r\n1,EU,10.5\r\n2,"US, east",30\r\n3,EU,20\r\n';
await writeFile(path.join(folder, "orders.csv"), csv);
// Files of the formats that are only read, written from the CSV file by the engine.
const source = new TableFile(path.join(folder, "orders.csv"), {
  tempDirectory: path.join(work, "tmp"),
  editable: false,
});
try {
  await source.saveAs(path.join(folder, "orders.parquet"));
  await source.saveAs(path.join(folder, "orders.xlsx"));
} finally {
  await source.dispose();
}

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "test", "vscode", "suite.cjs"),
    ...(process.env.VSCODE_PATH ? { vscodeExecutablePath: process.env.VSCODE_PATH } : {}),
    launchArgs: [folder, "--user-data-dir", profile, "--disable-extensions", "--disable-workspace-trust"],
    extensionTestsEnv: { VASTGRID_TEST_CSV: csv },
  });
} finally {
  await rm(work, { recursive: true, force: true });
}
