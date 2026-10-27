import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * The find bar, the cell menu and moving columns by dragging their headers (docs/react.md §6.13) on a file read
 * by the DuckDB engine over HTTP (`examples/files`).
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-find.csv";
const long = "x".repeat(2_500);

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    `id,city,qty,note\n1,Tokyo,3,first\n2,Osaka,12,second\n3,Kyoto,7,${long}\n4,Tokyo,5,fourth\n`,
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("find, the cell menu and dragging columns", async ({ page }) => {
  await page.goto(`${site}/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "Osaka", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  const primary = process.platform === "darwin" ? "Meta" : "Control";
  const active = () =>
    page.evaluate(
      () =>
        (
          window as never as {
            files: { handle: { store: { getSnapshot(): { session: { active?: { row: number; column: string } } } } } };
          }
        ).files.handle.store.getSnapshot().session.active,
    );

  // ⌘F finds from the active cell; Enter goes on, Shift+Enter back; Esc gives the focus back.
  await grid.focus();
  await page.keyboard.press(`${primary}+f`);
  const find = page.getByRole("searchbox", { name: "Find" });
  await expect(find).toBeFocused();
  await find.fill("tokyo");
  await find.press("Enter");
  await expect.poll(active).toEqual({ row: 0, column: "city", key: { rowId: 0 } });
  await find.press("Enter");
  await expect.poll(active).toMatchObject({ row: 3, column: "city" });
  await find.press("Shift+Enter");
  await expect.poll(active).toMatchObject({ row: 0, column: "city" });
  await find.fill("nowhere");
  await find.press("Enter");
  await expect(page.getByRole("search", { name: "Find" }).getByRole("status")).toHaveText("No matches");
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(grid).toBeFocused();

  // The cell menu of Osaka filters to its value; a cut value is shown in full.
  const osaka = await page.getByRole("gridcell", { name: "Osaka", exact: true }).boundingBox();
  if (!osaka) throw new Error("The cell has a box.");
  await page.mouse.click(osaka.x + 8, osaka.y + osaka.height / 2, { button: "right" });
  const menu = page.getByRole("dialog", { name: "Cell menu" });
  await menu.getByRole("menuitem", { name: "Filter to this value" }).click();
  await expect(page.locator(".vg-toolbar__count")).toHaveText("1 rows");
  await page.evaluate(() =>
    (window as never as { files: { handle: { dispatch(command: unknown): Promise<unknown> } } }).files.handle.dispatch({
      command: "filter.clear",
    }),
  );
  await expect(page.locator(".vg-toolbar__count")).toHaveText("4 rows");
  await grid.focus();
  await page.keyboard.press(`${primary}+Home`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(`${primary}+ArrowRight`);
  await page.keyboard.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Show full value" }).click();
  await expect(menu.locator("pre")).toHaveText(long);
  await page.keyboard.press("Escape");

  // Dragging the qty header before city moves it; a click sorts.
  const qty = await page.getByRole("columnheader", { name: "qty" }).boundingBox();
  const city = await page.getByRole("columnheader", { name: "city" }).boundingBox();
  if (!qty || !city) throw new Error("The headers have boxes.");
  await page.mouse.move(qty.x + 10, qty.y + qty.height / 2);
  await page.mouse.down();
  await page.mouse.move(city.x + 20, city.y + city.height / 2, { steps: 5 });
  await page.mouse.move(city.x + 4, city.y + city.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByRole("columnheader")).toHaveText(["id", "qty", "city", "note"]);
  const moved = await page.getByRole("columnheader", { name: "qty" }).boundingBox();
  if (!moved) throw new Error("The header has a box.");
  await page.mouse.click(moved.x + 10, moved.y + moved.height / 2);
  await expect(page.getByRole("columnheader", { name: "qty" })).toHaveAttribute("aria-sort", "ascending");
});
