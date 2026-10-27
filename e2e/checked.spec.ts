import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * Checked rows and the detail panel (docs/react.md §6.11) on a file read by the DuckDB engine over HTTP
 * (`examples/files`, which shows the check boxes): rows are checked by key, so a sort keeps them, checking every
 * row of a filtered view is unknown in a wider one, and the detail panel follows the active row.
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-checked.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,city,qty,note\n1,Tokyo,3,first\n2,Osaka,12,second\n3,Tokyo,7,third\n4,Kobe,5,fourth\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("rows are checked by key, and the detail panel shows the active row", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  const status = page.locator(".vg-statusbar");
  const session = () =>
    page.evaluate(
      () =>
        (
          window as never as { files: { handle: { store: { getSnapshot(): { session: { checked?: unknown } } } } } }
        ).files.handle.store.getSnapshot().session.checked,
    );

  // Space checks the active row; another row is checked from its box in the gutter.
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(status).toContainText("1 checked");
  const box = await grid.boundingBox();
  if (!box) throw new Error("The grid has a box.");
  // The gutter's check box of the fourth row (the header is 32 pixels, rows 24).
  await page.mouse.click(box.x + 12, box.y + 32 + 3 * 24 + 12);
  await expect(status).toContainText("2 checked");
  expect(await session()).toEqual({ mode: "include", keys: [{ rowId: 1 }, { rowId: 3 }] });

  // A sort keeps the same records checked.
  await page.evaluate(() =>
    (window as never as { files: { handle: { dispatch(command: unknown): Promise<unknown> } } }).files.handle.dispatch({
      command: "sort.set",
      keys: [{ column: "qty", direction: "desc" }],
    }),
  );
  await expect(page.getByRole("row").nth(1).getByRole("gridcell").first()).toHaveText("2");
  expect(await session()).toEqual({ mode: "include", keys: [{ rowId: 1 }, { rowId: 3 }] });

  // Checking every row of a search, then searching wider, leaves the rows unknown.
  await page.getByRole("searchbox", { name: "Search" }).fill("Osaka");
  await expect(page.locator(".vg-toolbar__count")).toHaveText("1 rows");
  await page.mouse.click(box.x + 12, box.y + 16);
  await expect(status).toContainText("1 checked");
  await page.getByRole("searchbox", { name: "Search" }).fill("");
  await expect(status).toContainText("Some rows of this view may not be checked");
  // Checking every row of this view, then none.
  await page.mouse.click(box.x + 12, box.y + 16);
  await expect(status).toContainText("4 checked");
  await page.mouse.click(box.x + 12, box.y + 16);
  await expect(status).not.toContainText("checked");

  // The detail panel follows the active row.
  await page.getByRole("button", { name: "Details" }).click();
  await grid.focus();
  await page.keyboard.press("Control+Home");
  const panel = page.getByRole("complementary", { name: "Row 1" });
  await expect(panel.locator("dd")).toHaveText(["2", "Osaka", "12", "second"]);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: "Row 2" }).locator("dd").nth(1)).toHaveText("Tokyo");
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  // Alt+Enter opens and closes it from the grid.
  await grid.focus();
  await page.keyboard.press("Alt+Enter");
  await expect(page.getByRole("complementary")).toHaveCount(1);
  await page.keyboard.press("Alt+Enter");
  await expect(page.getByRole("complementary")).toHaveCount(0);
});
