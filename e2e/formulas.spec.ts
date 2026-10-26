import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * The toolbar's formula menu (docs/v2-spec.md §4.11) on a file read by the DuckDB engine over HTTP (`examples/files`):
 * formulas are added, refused with the characters at fault, renamed and removed through the derive commands.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-formulas.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,item,qty,price,day\n1,apple,3,1.50,2024-02-28\n2,banana,12,0.25,2024-03-01\n3,cherry,0,4.00,2024-03-05\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("formulas add derived columns, show their errors, and are renamed and removed", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "banana", exact: true })).toBeAttached({ timeout: 30_000 });
  await page.getByRole("button", { name: "Formulas" }).click();
  const menu = page.getByRole("dialog", { name: "Formulas" });
  const added = menu.getByRole("form", { name: "New column" });

  await added.getByRole("textbox", { name: "Column name" }).fill("total");
  const formula = added.getByRole("textbox", { name: "Formula" });
  await formula.fill("qty * price + nme");
  await formula.press("Enter");
  await expect(menu.getByRole("alert")).toHaveText('There is no column "nme" here.');
  // The characters at fault are selected, so that typing replaces them.
  await formula.pressSequentially("id");
  await formula.press("Enter");
  await expect(menu.getByRole("form", { name: "total" })).toBeVisible();

  const next = menu.getByRole("form", { name: "New column" });
  await next.getByRole("textbox", { name: "Column name" }).fill("label");
  await next.getByRole("textbox", { name: "Formula" }).fill("IF(total > 5, UPPER(item), item) & ' / ' & WEEKDAY(day)");
  await next.getByRole("textbox", { name: "Formula" }).press("Enter");
  await expect(page.getByRole("gridcell", { name: "APPLE / 3", exact: true })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "banana / 5", exact: true })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "5.5", exact: true })).toBeAttached();

  // Renaming a formula renames what uses it.
  const total = menu.getByRole("form", { name: "total" });
  await total.getByRole("textbox", { name: "Column name" }).fill("amount");
  await total.getByRole("textbox", { name: "Column name" }).press("Enter");
  await expect(menu.getByRole("form", { name: "label" }).getByRole("textbox", { name: "Formula" })).toHaveValue(
    "IF(amount > 5, UPPER(item), item) & ' / ' & ISODOW(day)",
  );
  await expect(page.getByRole("columnheader", { name: "amount" })).toBeAttached();

  // Removing it removes the formulas that use it.
  await menu.getByRole("form", { name: "amount" }).getByRole("button", { name: "Remove" }).click();
  await expect(menu.getByRole("form")).toHaveCount(1);
  await expect(page.getByRole("columnheader", { name: "label" })).toHaveCount(0);
});
