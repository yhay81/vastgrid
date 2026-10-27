import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cell, row, writeWorkbook } from "../packages/duckdb-engine/test/xlsx-fixture.ts";

/**
 * The site's page that opens a file (site/src/components/open, playwright.config.ts): a file chosen or dropped is
 * read by 0.2's memory engine in a Web Worker, edited, exported, and the export opened again, with nothing sent to a
 * server.
 */
const site = "http://127.0.0.1:5187";

/** Opens the page in a language, and collects the errors of its console. */
async function openPage(page: Page, language: "en" | "ja" = "en") {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${site}${language === "ja" ? "/ja" : ""}/open/`);
  return problems;
}

/** Drops files on the page as a person drags them from the desktop. */
async function drop(page: Page, files: { name: string; bytes: Uint8Array | string }[]) {
  await page.evaluate(
    (items) => {
      const transfer = new DataTransfer();
      for (const item of items) {
        const bytes = typeof item.bytes === "string" ? item.bytes : new Uint8Array(item.bytes);
        transfer.items.add(new File([bytes], item.name));
      }
      const target = document.querySelector(".demo") as HTMLElement;
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    files.map((file) => ({ name: file.name, bytes: typeof file.bytes === "string" ? file.bytes : [...file.bytes] })),
  );
}

test("a chosen CSV file is edited, exported as a workbook, and the workbook opens with the edit", async ({ page }) => {
  const problems = await openPage(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,region,price\n1,EU,10.5\n2,US,30\n3,東京,20\n"),
  });
  const grid = page.getByRole("grid", { name: "orders.csv" });
  await expect(grid).toHaveAttribute("aria-rowcount", "4", { timeout: 30_000 });
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Osaka");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });

  await page.getByRole("button", { name: "Export" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "Export" }).getByRole("button", { name: "Excel (.xlsx)" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("orders.xlsx");
  const exported = readFileSync(await download.path());
  expect([...exported.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  await drop(page, [{ name: "orders.xlsx", bytes: exported }]);
  const workbook = page.getByRole("grid", { name: "orders.xlsx" });
  await expect(workbook).toHaveAttribute("aria-rowcount", "4", { timeout: 30_000 });
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "東京", exact: true })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "US", exact: true })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a workbook's sheets are chosen, and a file of no known format says why", async ({ page }) => {
  const folder = await mkdtemp(path.join(tmpdir(), "vastgrid-open-"));
  const file = path.join(folder, "book.xlsx");
  await writeWorkbook(file, {
    sheets: [
      { name: "Hidden", state: "hidden", rows: [row(1, [cell("A1", { t: "inlineStr", is: "secret" })])] },
      { name: "Plan", rows: [row(1, [cell("A1", { t: "inlineStr", is: "plan" })]), row(2, [cell("A2", { v: 1 })])] },
      {
        name: "Done",
        rows: [row(1, [cell("A1", { t: "inlineStr", is: "done" })]), row(2, [cell("A2", { v: 2 })]), row(3, [])],
      },
    ],
  });
  const problems = await openPage(page, "ja");
  await expect(page.getByRole("button", { name: "ファイルを選ぶ" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(file);
  const grid = page.getByRole("grid", { name: "book.xlsx" });
  await expect(page.getByRole("columnheader", { name: /^plan/ })).toBeAttached({ timeout: 30_000 });
  const sheet = page.getByRole("combobox", { name: "シート" });
  await expect(sheet).toHaveValue("Plan");
  await expect(sheet.getByRole("option")).toHaveText(["Hidden (非表示)", "Plan", "Done"]);
  await sheet.selectOption("Done");
  await expect(page.getByRole("columnheader", { name: /^done/ })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole("gridcell", { name: "2", exact: true })).toBeAttached();
  await expect(grid).toHaveAttribute("aria-rowcount", "2");

  await drop(page, [{ name: "notes.json", bytes: "[]" }]);
  await expect(page.locator(".demo__grid")).toContainText("notes.json", { timeout: 30_000 });
  await expect(page.locator(".demo__grid")).toContainText("/format");
  expect(problems).toEqual([]);
});

test("the sample of 1,000,000 rows opens, goes to its last row and sorts", async ({ page }) => {
  const problems = await openPage(page);
  await page.getByRole("button", { name: "Try a sample of 1,000,000 rows" }).click();
  const grid = page.getByRole("grid", { name: "sample-1000000.csv" });
  await expect(grid).toHaveAttribute("aria-rowcount", "1000001", { timeout: 60_000 });
  await expect(page.locator(".vg-statusbar")).toContainText("1,000,000 rows");
  await grid.focus();
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(page.getByRole("gridcell", { name: "1000000", exact: true })).toBeAttached({ timeout: 30_000 });
  // The prices sorted from the highest, which the sample's prices reach.
  await page.keyboard.press("ControlOrMeta+Home");
  for (let column = 0; column < 5; column++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  await page
    .getByRole("dialog", { name: "unit_price column menu" })
    .getByRole("menuitemcheckbox", { name: "Sort descending" })
    .click();
  // The active cell's row (404.18) stays active where the sort puts it, away from the top; the first row then has
  // the highest price.
  await expect(page.locator('[role="row"][aria-rowindex="2"]')).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.locator('[role="row"][aria-rowindex="2"]')).toContainText("499.99", { timeout: 30_000 });
  expect(problems).toEqual([]);
});
