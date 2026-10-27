import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * Column statistics, the totals row and grouping (docs/react.md §6.7, §6.8) on a file read by the DuckDB engine
 * over HTTP (`examples/files`): each is an aggregate that the engine evaluates.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-totals.csv";

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

test("statistics, the totals row and groups are read by the engine", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("End");

  // Statistics of qty.
  await page.keyboard.press("Alt+ArrowDown");
  const menu = page.getByRole("dialog", { name: "qty column menu" });
  await menu.getByRole("menuitem", { name: "Statistics…" }).click();
  const statistics = menu.getByRole("region", { name: "Statistics of qty" });
  await expect(statistics.locator("dt")).toHaveText([
    "Rows",
    "Values",
    "Empty",
    "Distinct",
    "Minimum",
    "Maximum",
    "Sum",
    "Average",
    "Median",
    "Standard deviation",
  ]);
  await expect(statistics.locator("dd").nth(0)).toHaveText("6");
  await expect(statistics.locator("dd").nth(6)).toHaveText("37");
  await expect(statistics.locator("dd").nth(8)).toHaveText("6");

  // The totals row: the sum of qty, which follows the filters.
  await menu.getByRole("button", { name: "Back" }).click();
  await menu.getByRole("menuitem", { name: "Total…" }).click();
  await menu.getByRole("menuitemradio", { name: "Sum" }).click();
  const totals = page.getByRole("row").last();
  await expect(totals.getByRole("gridcell").last()).toHaveText("37");
  await expect(grid).toHaveAttribute("aria-rowcount", "8");
  await page.getByRole("searchbox", { name: "Search" }).fill("Tokyo");
  await expect(totals.getByRole("gridcell").last()).toHaveText("19");
  await page.getByRole("searchbox", { name: "Search" }).fill("");
  await expect(totals.getByRole("gridcell").last()).toHaveText("37");

  // Grouping by city from its menu: a count per city; then the sum of qty from the group menu.
  await grid.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+ArrowDown");
  await page
    .getByRole("dialog", { name: "city column menu" })
    .getByRole("menuitem", { name: "Group by this column" })
    .click();
  await expect(page.getByRole("columnheader", { name: "count(*)" })).toBeAttached();
  await expect(page.locator(".vg-toolbar__count")).toHaveText("4 rows");
  await page.getByRole("button", { name: "Group" }).click();
  const groups = page.getByRole("dialog", { name: "Group" });
  await groups.getByRole("combobox", { name: "Measures" }).selectOption({ label: "Sum" });
  await groups.getByRole("combobox", { name: "Column", exact: true }).selectOption("qty");
  await groups.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("columnheader", { name: "sum(qty)" })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "19", exact: true })).toBeAttached();
  await groups.getByRole("button", { name: "Ungroup" }).click();
  await expect(page.locator(".vg-toolbar__count")).toHaveText("6 rows");
});
