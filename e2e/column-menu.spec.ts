import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * The column menu (docs/react.md §6.7) on a file read by the DuckDB engine over HTTP (`examples/files`): the list
 * of a column's values is read by the engine under the other filters, and the filter and the condition are applied
 * with `filter.column` and read back when the menu opens again.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-column-menu.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,city,qty\n1,Tokyo,3\n2,Osaka,12\n3,Tokyo,7\n4,,5\n5,Kobe,1\n6,Tokyo,9\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("the column menu filters by values and by a condition, and sorts", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  const status = page.locator(".vg-toolbar__count");

  // Alt+↓ opens the menu of the active cell's column.
  await grid.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  const menu = page.getByRole("dialog", { name: "city column menu" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Filter…" }).click();
  const values = menu.getByRole("group", { name: "Filter city" });
  // The most common first, with how many rows have each, then by value (blank last, §3.3).
  await expect(values.locator(".vg-filter__value")).toHaveText([
    "(Select all)",
    "Tokyo3",
    "Kobe1",
    "Osaka1",
    "(Blank)1",
  ]);
  await values.getByRole("checkbox", { name: "(Select all)" }).uncheck();
  await values.getByRole("checkbox", { name: "Tokyo" }).check();
  await values.getByRole("checkbox", { name: "Kobe" }).check();
  await menu.getByRole("button", { name: "Apply" }).click();
  await expect(menu).toBeHidden();
  await expect(status).toHaveText("4 rows");
  await expect(grid).toBeFocused();

  // A condition on another column; the list of the first one then has what the condition leaves.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  const qty = page.getByRole("dialog", { name: "qty column menu" });
  await qty.getByRole("menuitem", { name: "Filter…" }).click();
  await qty.getByRole("combobox", { name: "Condition" }).selectOption({ label: "Greater than" });
  await qty.getByRole("textbox", { name: "Value" }).fill("4");
  await qty.getByRole("textbox", { name: "Value" }).press("Enter");
  await expect(status).toHaveText("2 rows");

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+ArrowDown");
  await menu.getByRole("menuitem", { name: "Filter…" }).click();
  await expect(values.locator(".vg-filter__value")).toHaveText(["(Select all)", "Tokyo2", "Osaka1", "(Blank)1"]);
  // What was applied is read back.
  await expect(values.getByRole("checkbox", { name: "Tokyo" })).toBeChecked();
  await expect(values.getByRole("checkbox", { name: "Osaka" })).not.toBeChecked();
  await menu.getByRole("button", { name: "Clear filter" }).click();
  await expect(status).toHaveText("4 rows");

  // Sorting from the menu.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  await qty.getByRole("menuitemcheckbox", { name: "Sort descending" }).click();
  await expect(page.getByRole("row").nth(1).getByRole("gridcell").first()).toHaveText("2");
});
