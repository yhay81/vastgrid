import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * A column's format (docs/v2-react.md §6.10) on a file read by the DuckDB engine over HTTP (`examples/files`):
 * a number format, a conditional color with what it means, a date pattern and wrapped text, set from the column
 * menu as `column.format` and read back when it opens again.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-format.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,price,day,note\n1,1250.5,2024-02-29,short\n2,99.25,2024-03-01,a note long enough to wrap onto a second line\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("the format panel sets number and date formats, conditional colors and wrapping", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "short", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  const menu = page.getByRole("dialog", { name: "price column menu" });
  await menu.getByRole("menuitem", { name: "Format…" }).click();
  const form = menu.getByRole("form", { name: "Format of price" });
  await form.getByRole("textbox", { name: "Label" }).fill("Price");
  await form.getByRole("combobox", { name: "Numbers" }).selectOption("currency");
  await form.getByRole("textbox", { name: "Currency code" }).fill("usd");
  await form.getByRole("spinbutton", { name: "Decimal places" }).fill("1");
  await form.getByRole("button", { name: "Add rule" }).click();
  await form.getByRole("combobox", { name: "Condition" }).selectOption("gt");
  await form.getByRole("textbox", { name: "Value" }).fill("1,000");
  await form.getByRole("textbox", { name: "What the colors mean" }).fill("Expensive");
  await form.getByRole("button", { name: "Apply" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("columnheader", { name: "Price" })).toBeAttached();
  const expensive = page.getByRole("gridcell", { name: "$1,250.5", exact: true });
  await expect(expensive).toHaveAttribute("aria-description", "Expensive");
  await expect(page.getByRole("gridcell", { name: "$99.3", exact: true })).not.toHaveAttribute("aria-description");

  // Opening the panel again reads the format back.
  await page.keyboard.press("Alt+ArrowDown");
  await menu.getByRole("menuitem", { name: "Format…" }).click();
  await expect(form.getByRole("textbox", { name: "Currency code" })).toHaveValue("USD");
  await expect(form.getByRole("textbox", { name: "Value" })).toHaveValue("1000");
  await page.keyboard.press("Escape");

  // A date pattern, and wrapped text that makes rows taller.
  await grid.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  const day = page.getByRole("dialog", { name: "day column menu" });
  await day.getByRole("menuitem", { name: "Format…" }).click();
  await day.getByRole("textbox", { name: "Date pattern" }).fill("yyyy/MM/dd (EEE)");
  await day.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("gridcell", { name: "2024/02/29 (Thu)", exact: true })).toBeAttached();
  const height = async () => (await page.getByRole("gridcell", { name: "short", exact: true }).boundingBox())?.height;
  const before = await height();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  const note = page.getByRole("dialog", { name: "note column menu" });
  await note.getByRole("menuitem", { name: "Format…" }).click();
  await note.getByRole("checkbox", { name: "Wrap text" }).check();
  await note.getByRole("button", { name: "Apply" }).click();
  await expect.poll(height).toBeGreaterThan((before ?? 0) + 8);
});
