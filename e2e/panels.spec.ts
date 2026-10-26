import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * The toolbar's conditions, columns and group menus (docs/v2-react.md §6.8, §6.9) on a file read by the DuckDB
 * engine over HTTP (`examples/files`): conditions across columns in nested groups, columns shown, hidden and moved,
 * and a pivot.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-panels.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,city,qty,member\n1,Tokyo,3,true\n2,Osaka,12,false\n3,Tokyo,7,false\n4,Kobe,5,true\n5,Kobe,1,false\n6,Tokyo,9,true\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("conditions across columns, the columns menu and a pivot", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });
  const count = page.locator(".vg-toolbar__count");

  // city contains "to" AND (qty > 8 OR qty < 4).
  await page.getByRole("button", { name: "Conditions" }).click();
  const menu = page.getByRole("dialog", { name: "Filter conditions" });
  await menu.getByRole("button", { name: "Add condition" }).click();
  await menu.getByRole("button", { name: "Add group" }).click();
  const rows = menu.locator(".vg-conditions__row");
  await rows.nth(0).getByRole("combobox", { name: "Column" }).selectOption("city");
  await rows.nth(0).getByRole("combobox", { name: "Condition" }).selectOption("contains");
  await rows.nth(0).getByRole("textbox", { name: "Value" }).fill("to");
  await rows.nth(1).getByRole("combobox", { name: "Column" }).selectOption("qty");
  await rows.nth(1).getByRole("combobox", { name: "Condition" }).selectOption("gt");
  await rows.nth(1).getByRole("textbox", { name: "Value" }).fill("8");
  await menu.locator(".vg-conditions__group").nth(1).getByRole("button", { name: "Add condition" }).click();
  await rows.nth(2).getByRole("combobox", { name: "Column" }).selectOption("qty");
  await rows.nth(2).getByRole("combobox", { name: "Condition" }).selectOption("lt");
  await rows.nth(2).getByRole("textbox", { name: "Value" }).fill("4");
  await expect(rows).toHaveCount(3);
  await menu.getByRole("button", { name: "Apply" }).click();
  await expect(menu).toBeHidden();
  // Tokyo 3 and Tokyo 9.
  await expect(count).toHaveText("2 rows");
  await expect(page.getByRole("button", { name: "Conditions (2)" })).toBeVisible();

  // Opening again reads the conditions back; text that is not a number names its condition.
  await page.getByRole("button", { name: "Conditions (2)" }).click();
  await expect(rows).toHaveCount(3);
  await expect(menu.getByRole("combobox", { name: "Match" }).nth(1)).toHaveValue("or");
  await rows.nth(2).getByRole("textbox", { name: "Value" }).fill("few");
  await menu.getByRole("button", { name: "Apply" }).click();
  await expect(menu.getByRole("alert")).toHaveText("A value is not a value of its column.");
  await expect(rows.nth(2).getByRole("textbox", { name: "Value" })).toHaveAttribute("aria-invalid", "true");
  await menu.getByRole("button", { name: "Clear all" }).click();
  await expect(count).toHaveText("6 rows");

  // The columns menu hides, moves and shows columns.
  await page.getByRole("button", { name: "Columns" }).click();
  const columns = page.getByRole("dialog", { name: "Columns" });
  await columns.getByRole("checkbox", { name: "id" }).uncheck();
  await expect(page.getByRole("columnheader", { name: "id" })).toHaveCount(0);
  await columns.getByRole("button", { name: "Move member left" }).click();
  await expect(page.getByRole("columnheader")).toHaveText(["city", "member", "qty"]);
  await columns.getByRole("button", { name: "Show all columns" }).click();
  await expect(page.getByRole("columnheader")).toHaveText(["id", "city", "member", "qty"]);
  await page.keyboard.press("Escape");

  // A pivot: a column per value of member, with a count.
  await page.getByRole("button", { name: "Group" }).click();
  const groups = page.getByRole("dialog", { name: "Group" });
  await groups.getByRole("combobox", { name: "Add a column…" }).selectOption("city");
  await groups.getByRole("combobox", { name: "Columns from values of" }).selectOption("member");
  await expect(page.getByRole("columnheader")).toHaveText(["city", "false / count(*)", "true / count(*)"]);
  await expect(count).toHaveText("3 rows");
});
