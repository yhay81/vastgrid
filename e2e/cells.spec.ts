import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * Column groups, cells that are links, and filling (docs/react.md §6.12) on a file read by the DuckDB engine
 * over HTTP (`examples/files`, with `?groups=` and `?links=`).
 */
const site = "http://127.0.0.1:5183";
const file = "e2e-cells.csv";
const groups = JSON.stringify([
  { name: "Item", children: ["id", "name"] },
  { name: "Sale", children: [{ name: "Amount", children: ["qty", "price"] }] },
]);

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,name,qty,price,url\n1,apple,3,1.5,https://example.com/a\n2,banana,12,0.25,https://example.com/b\n3,cherry,7,4,https://example.com/c\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("column groups select their columns, links act, and Ctrl+D fills down", async ({ page }) => {
  await page.goto(`${site}/?file=${file}&links=url&groups=${encodeURIComponent(groups)}`);
  await expect(page.getByRole("gridcell", { name: "banana", exact: true })).toBeAttached({ timeout: 30_000 });
  const grid = page.getByRole("grid");
  const snapshot = () =>
    page.evaluate(() => {
      const store = (window as never as { files: { handle: { store: { getSnapshot(): { session: unknown } } } } }).files
        .handle.store;
      return store.getSnapshot().session as { selection?: unknown; active?: { row: number; column: string } };
    });

  // Screen readers hear a column's groups.
  await expect(page.getByRole("columnheader", { name: "price" })).toHaveAttribute("aria-description", "Sale › Amount");

  // Clicking "Amount" (the row of groups just above the names) selects qty and price.
  const box = await grid.boundingBox();
  const price = await page.getByRole("columnheader", { name: "price" }).boundingBox();
  if (!box || !price) throw new Error("The grid has a box.");
  await page.mouse.click(price.x + 4, box.y + 24 + 12);
  expect((await snapshot()).selection).toEqual([{ rows: "all", columns: ["qty", "price"] }]);

  // A link acts on a click and on Space, with the cell and its row's key.
  const link = page.getByRole("link", { name: "Open https://example.com/b" });
  await expect(link).toBeAttached();
  const url = await page.getByRole("gridcell", { name: "https://example.com/b" }).boundingBox();
  if (!url) throw new Error("The cell has a box.");
  await page.mouse.click(url.x + 8, url.y + url.height / 2);
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  const actions = await page.evaluate(() =>
    (window as never as { files: { actions: { text: string; key: unknown; action: unknown }[] } }).files.actions.map(
      ({ text, key, action }) => ({ text, key, action }),
    ),
  );
  expect(actions).toEqual([
    { text: "https://example.com/b", key: { rowId: 1 }, action: { kind: "link", label: "Open https://example.com/b" } },
    { text: "https://example.com/c", key: { rowId: 2 }, action: { kind: "link", label: "Open https://example.com/c" } },
  ]);

  // Ctrl+D (⌘D on Apple platforms) fills the selection down from its first row.
  const primary = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${primary}+Home`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press(`${primary}+d`);
  await expect(page.getByRole("gridcell", { name: "apple", exact: true })).toHaveCount(2);
});
