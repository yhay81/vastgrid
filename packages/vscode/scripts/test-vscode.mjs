// Runs the extension in VS Code (docs/vscode.md): `test/vscode/suite.cjs` opens, edits, saves, reverts and opens
// again files of a folder made here, in a window of its own with a profile of its own. It needs the build
// (`npm run build` at the root). VS Code is the one at `VSCODE_PATH`, or a stable one that @vscode/test-electron
// downloads into `.vscode-test`. With `VASTGRID_VSIX`, the extension is that package (scripts/package.mjs), which
// VS Code installs as it installs one of the Marketplace.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";
import { cell, row, writeWorkbook } from "../../duckdb-engine/test/xlsx-fixture.ts";
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
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    // No chat view, whose field would take the focus and VS Code's Undo with it.
    "chat.disableAIFeatures": true,
  }),
);
const csv = 'id,region,price\r\n1,EU,10.5\r\n2,"US, east",30\r\n3,EU,20\r\n';
await writeFile(path.join(folder, "orders.csv"), csv);
await writeFile(path.join(folder, "orders.tsv"), "id\tregion\tprice\n1\tEU\t10.5\n2\tUS, east\t30\n3\tEU\t20\n");
await writeFile(
  path.join(folder, "orders.jsonl"),
  '{"id":1,"region":"EU","price":10.5}\n{"id":2,"region":"US, east","price":30}\n{"id":3,"region":"EU","price":20}\n',
);
// A file of a million rows, whose last row the grid shows.
const big = Array.from({ length: 1_000_000 }, (_, index) => `${index + 1},${(index * 7) % 1000}`);
await writeFile(path.join(folder, "big.csv"), `id,value\n${big.join("\n")}\n`);
// A workbook whose second sheet has 200,000 rows, which "Choose Sheet" shows.
const header = row(1, [cell("A1", { t: "inlineStr", is: "id" }), cell("B1", { t: "inlineStr", is: "value" })]);
function* rows(count) {
  yield header;
  for (let index = 0; index < count; index++) {
    yield row(index + 2, [cell(`A${index + 2}`, { v: index + 1 }), cell(`B${index + 2}`, { v: (index * 7) % 1000 })]);
  }
}
await writeWorkbook(path.join(folder, "sheets.xlsx"), {
  sheets: [
    { name: "Small", rows: rows(3) },
    { name: "Large", rows: rows(200_000) },
  ],
});
// Files of the formats that are only read, written from the CSV file by the engine.
const source = new TableFile(path.join(folder, "orders.csv"), {
  tempDirectory: path.join(work, "tmp"),
  editable: false,
});
const large = new TableFile(path.join(folder, "big.csv"), { tempDirectory: path.join(work, "tmp"), editable: false });
try {
  await source.saveAs(path.join(folder, "orders.parquet"));
  await source.saveAs(path.join(folder, "orders.xlsx"));
  await large.saveAs(path.join(folder, "big.parquet"));
} finally {
  await source.dispose();
  await large.dispose();
}

const vscode = process.env.VSCODE_PATH ?? (await downloadAndUnzipVSCode());
let extension = root;
const launchArgs = [folder, "--user-data-dir", profile, "--disable-workspace-trust"];
if (process.env.VASTGRID_VSIX) {
  // The package, installed by VS Code's command line into a folder of extensions of its own; the extension that
  // runs the tests is an empty one.
  const extensions = path.join(work, "extensions");
  const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscode);
  execFileSync(
    cli,
    [...args, "--extensions-dir", extensions, "--install-extension", path.resolve(process.env.VASTGRID_VSIX)],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  extension = path.join(work, "host");
  await mkdir(extension);
  await writeFile(
    path.join(extension, "package.json"),
    JSON.stringify({ name: "host", publisher: "test", version: "0.0.0", engines: { vscode: "*" } }),
  );
  launchArgs.push("--extensions-dir", extensions);
} else {
  launchArgs.push("--disable-extensions");
}

try {
  await runTests({
    vscodeExecutablePath: vscode,
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(root, "test", "vscode", "suite.cjs"),
    launchArgs,
    extensionTestsEnv: { VASTGRID_TEST_CSV: csv },
  });
} finally {
  await rm(work, { recursive: true, force: true });
}
