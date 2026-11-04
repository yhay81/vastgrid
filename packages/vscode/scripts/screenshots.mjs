// Takes the extension's screenshots: the window for the README (docs/images/vscode.png) and parts of it for the
// walkthrough (media/walkthrough/*.png). It opens the bench's Parquet file of 100,000,000 rows
// (packages/duckdb-engine/bench/files.ts, made when it is missing) and a CSV file of 100,000 rows in VS Code with
// the extension of this folder (`npm run build` at the root first), sorts, filters and edits as a person would, and
// captures the window, 1280 by 800 points at twice as many pixels, over the Chrome DevTools Protocol. VS Code is
// the one at `VSCODE_PATH`, or a stable one that @vscode/test-electron downloads. A window of VS Code opens while
// it runs.
import { spawn } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { benchDirectory, benchFiles } from "../../duckdb-engine/bench/files.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = path.join(root, "..", "..");
const walkthrough = path.join(root, "media", "walkthrough");
const rows = 100_000_000;
const port = 9339;
const { csv, parquet } = await benchFiles(benchDirectory, 100_000, rows);

const work = await mkdtemp(path.join(os.tmpdir(), "vastgrid-screenshots-"));
const folder = path.join(work, "sales");
const profile = path.join(work, "profile");
await mkdir(folder);
await mkdir(path.join(profile, "User"), { recursive: true });
await mkdir(walkthrough, { recursive: true });
// The file of 1.4 GB is linked, not copied; the CSV file, which is edited, is a copy.
const sales = path.join(folder, "sales.parquet");
await link(parquet, sales).catch(() => symlink(parquet, sales));
await copyFile(csv, path.join(folder, "customers.csv"));
await writeFile(
  path.join(profile, "User", "settings.json"),
  JSON.stringify({
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    // The system's title bar, outside the page that is captured: VS Code's own says "Extension Development Host".
    "window.titleBarStyle": "native",
    "window.customTitleBarVisibility": "never",
    "window.restoreWindows": "none",
    "workbench.hover.delay": 300,
    "chat.disableAIFeatures": true,
    "editor.minimap.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.ignoreRecommendations": true,
    "git.enabled": false,
  }),
);

const executable = process.env.VSCODE_PATH ?? (await downloadAndUnzipVSCode());
const code = spawn(
  executable,
  [
    folder,
    "--user-data-dir",
    profile,
    "--extensions-dir",
    path.join(work, "extensions"),
    `--extensionDevelopmentPath=${root}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--remote-debugging-port=${port}`,
  ],
  { stdio: "ignore" },
);

/** Polls until `find` gives a value, for at most `seconds`. */
async function until(what, find, seconds = 120) {
  for (let i = 0; i < seconds * 4; i++) {
    const found = await find().catch(() => undefined);
    if (found) return found;
    await delay(250);
  }
  throw new Error(`No ${what} after ${seconds} s.`);
}

let browser;
try {
  browser = await until("connection to VS Code", () => chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const page = await until("window", async () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("workbench")),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.locator(".explorer-folders-view .monaco-list-row").first().waitFor();

  /** Opens the folder's file named with Quick Open. */
  const open = async (name) => {
    await page.keyboard.press("Meta+P");
    await page.locator(".quick-input-widget .quick-input-box input").first().fill(name);
    await page.locator(".quick-input-list .monaco-list-row", { hasText: name }).first().waitFor();
    await page.keyboard.press("Enter");
  };
  /** The frame of the grid that shows the file named, once its rows are counted. */
  const grid = (name, count) =>
    until(`grid of ${name}`, async () => {
      for (const frame of page.frames()) {
        const element = frame.getByRole("grid");
        if ((await element.count()) === 1 && (await element.getAttribute("aria-rowcount")) === String(count + 1)) {
          return frame;
        }
      }
    });
  const cell = (frame, row, column) => frame.locator(`[role="gridcell"][id$="-r${row}-c${column}"]`);
  const click = async (locator) => {
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const statusBar = (frame) => frame.locator(".vg-statusbar");
  /**
   * Captures the window, or the part of it given in points, into the file, with the pointer at `pointer`: by
   * default on the side bar's empty part, where it changes nothing on screen.
   */
  const shoot = async (file, clip, pointer = { x: 150, y: 600 }) => {
    await page.mouse.move(pointer.x, pointer.y);
    await delay(1500);
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    await writeFile(file, Buffer.from(data, "base64"));
    console.error(path.relative(repository, file));
  };
  const step = (name) => path.join(walkthrough, `${name}.png`);

  // The Parquet file, sorted by price from the highest, with every price selected and summed.
  await open("sales.parquet");
  const table = await grid("sales.parquet", rows);
  const price = table.getByRole("columnheader", { name: "price" });
  const header = await price.boundingBox();
  for (let i = 0; i < 2; i++) await page.mouse.click(header.x + 20, header.y + header.height / 2);
  await until("sort", async () => (await price.getAttribute("aria-sort")) === "descending");
  await until("sorted rows", async () => !(await statusBar(table).textContent()).includes("Reading"));
  await click(cell(table, 0, 3));
  await page.keyboard.press("Shift+Meta+ArrowDown");
  await until("sum", async () => (await statusBar(table).textContent()).includes("Sum"));
  await shoot(path.join(repository, "docs", "images", "vscode.png"));
  // The walkthrough's parts are the editor's, without the side bar: here from the grid's header to its status bar.
  const area = await table.getByRole("grid").boundingBox();
  const status = await statusBar(table).boundingBox();
  const editor = { x: area.x - 2, width: area.width + 4 };
  await shoot(step("select"), { ...editor, y: area.y - 4, height: status.y + status.height + 6 - (area.y - 4) });

  // The filter of the city column, with how many of the rows have each city.
  await click(cell(table, 0, 2));
  await page.keyboard.press("Alt+ArrowDown");
  await table.getByRole("menuitem", { name: "Filter…" }).click();
  await until("counts", async () => (await table.locator(".vg-filter__count").count()) > 1);
  const toolbar = await table.locator(".vg-toolbar").boundingBox();
  await shoot(step("filter"), { ...editor, y: toolbar.y - 2, height: Math.round(editor.width * 0.625) });
  await page.keyboard.press("Escape");

  // The CSV file as text, with the editor's button that opens it in vastgrid.
  await open("customers.csv");
  const button = page.locator('.editor-actions [aria-label="Open in vastgrid"]');
  await until("button", async () => (await button.count()) > 0);
  // The pointer on the button, which shows its name.
  const action = await button.first().boundingBox();
  await shoot(
    step("open"),
    { x: 1280 - 560, y: 0, width: 560, height: 350 },
    {
      x: action.x + action.width / 2,
      y: action.y + action.height / 2,
    },
  );

  // The CSV file in vastgrid with a cell edited, which makes the editor dirty, and another being edited.
  await button.first().click();
  const customers = await grid("customers.csv", 100_000);
  await click(cell(customers, 2, 2));
  await page.keyboard.type("Kyoto");
  await page.keyboard.press("Enter");
  await until("dirty editor", async () => (await page.locator(".tab.dirty").count()) > 0);
  await click(cell(customers, 5, 2));
  await page.keyboard.type("Kobe");
  await shoot(step("edit"), { x: editor.x, y: 0, width: 680, height: 425 });
} finally {
  await browser?.close().catch(() => {});
  code.kill();
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
