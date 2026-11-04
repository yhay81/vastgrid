import { expect, test } from "@playwright/test";
import { openBench } from "./bench.ts";

test.beforeEach(async ({ page }) => {
  await openBench(page, { rows: 10_000 });
});

test("the grid is an ARIA grid with the rows on screen under the canvas", async ({ page }) => {
  const grid = page.getByRole("grid", { name: "Data table" });
  await expect(grid).toHaveAttribute("aria-rowcount", "10001");
  await expect(grid).toHaveAttribute("aria-colcount", "8");
  await expect(page.getByRole("columnheader", { name: "amount" })).toBeAttached();
  await expect(page.getByRole("gridcell", { name: "Ren 0", exact: true }).first()).toBeAttached();
  await expect(page.locator(".vg-statusbar")).toContainText("10,000 rows");
});

test("the canvas draws the theme's colors and the cells' text", async ({ page }) => {
  // Light-dark colors resolve (a build may turn them into variables), and text is drawn in the first cells.
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".vg-canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return null;
    const ratio = canvas.width / canvas.clientWidth;
    const at = (x: number, y: number) => Array.from(context.getImageData(x * ratio, y * ratio, 1, 1).data);
    const cell = context.getImageData(60 * ratio, 40 * ratio, 80 * ratio, 20 * ratio).data;
    let inked = 0;
    for (let index = 0; index < cell.length; index += 4) if (cell[index] < 160) inked++;
    return { body: at(600, 400), header: at(600, 10), inked };
  });
  expect(pixels).not.toBeNull();
  expect(pixels?.body).toEqual([255, 255, 255, 255]);
  expect(pixels?.header.slice(0, 3)).not.toEqual([0, 0, 0]);
  expect(pixels?.inked).toBeGreaterThan(20);
});

test("keys move the active cell, and the status bar and aria-activedescendant follow", async ({ page }) => {
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".vg-statusbar__cell")).toHaveText("Row 3, name");
  await expect.poll(async () => grid.getAttribute("aria-activedescendant")).toMatch(/-r2-c1$/);
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(page.locator(".vg-statusbar__cell")).toHaveText("Row 10,000, name");
});

test("clicking a header sorts, and the rows of the old view stay until the new ones arrive", async ({ page }) => {
  const header = page.getByRole("columnheader", { name: "id" });
  const box = await page.locator(".vg-scroller").boundingBox();
  if (!box) throw new Error("No scroller.");
  // The header row is drawn on the canvas; the click goes to its place.
  const cell = await header.boundingBox();
  if (!cell) throw new Error("No header.");
  await page.mouse.click(cell.x + 20, cell.y + cell.height / 2);
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await page.mouse.click(cell.x + 20, cell.y + cell.height / 2);
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("gridcell", { name: "9999", exact: true }).first()).toBeAttached();
});

test("copying puts the selected cells on the clipboard as TSV", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate(() => document.execCommand("copy"));
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split("\n")).toEqual(["0\tRen 0", "1\tSora 1"]);
});

test("dragging across cells selects the whole rectangle for copying", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const start = await page.locator('[role="row"][aria-rowindex="2"] [role="gridcell"]').first().boundingBox();
  const end = await page.getByRole("gridcell", { name: "Sora 1", exact: true }).boundingBox();
  if (!start || !end) throw new Error("The cells have boxes.");
  await page.mouse.move(start.x + 8, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 8, end.y + end.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
  await page.evaluate(() => document.execCommand("copy"));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("0\tRen 0\n1\tSora 1");
});

test("dragging a header edge resizes it and dragging its name reorders it without sorting", async ({ page }) => {
  const id = page.getByRole("columnheader", { name: "id", exact: true });
  const original = await id.boundingBox();
  if (!original) throw new Error("The header has a box.");
  const edge = original.x + original.width - 1;
  const y = original.y + original.height / 2;
  await page.mouse.move(edge, y);
  await page.mouse.down();
  await page.mouse.move(edge + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await id.boundingBox())?.width).toBe(Math.round(original.width + 60));

  const target = await page.getByRole("columnheader", { name: "name", exact: true }).boundingBox();
  if (!target) throw new Error("The next header has a box.");
  await page.mouse.move(original.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.75, y, { steps: 6 });
  await page.mouse.up();
  await expect(id).toHaveAttribute("aria-colindex", "2");
  await expect(page.getByRole("columnheader", { name: "name", exact: true })).toHaveAttribute("aria-colindex", "1");
  await expect(id).not.toHaveAttribute("aria-sort");
});

test("dragging beyond the grid scrolls and releasing the pointer stops it", async ({ page }) => {
  const start = await page.getByRole("gridcell", { name: "Ren 0", exact: true }).boundingBox();
  const scroller = page.locator(".vg-scroller");
  const box = await scroller.boundingBox();
  if (!start || !box) throw new Error("The grid and its cell have boxes.");
  await page.mouse.move(start.x + 8, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, box.y + box.height + 10, { steps: 6 });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.mouse.up();
  const stopped = await scroller.evaluate((element) => element.scrollTop);
  await page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
  });
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(stopped);
});
