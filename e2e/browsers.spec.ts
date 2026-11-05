import { expect, test } from "@playwright/test";

// A small shared journey in all three browser engines; the full functional suite stays on Chromium.
for (const engine of ["main", "worker"]) {
  test(`${engine}: renders, edits, undoes, selects and sorts`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?rows=100&columns=8&engine=${engine}`);
    const grid = page.getByRole("grid", { name: "Data table" });
    const cell = (row: number, column: number) => page.locator(`[role="gridcell"][id$="-r${row}-c${column}"]`);
    await expect(grid).toHaveAttribute("aria-rowcount", "101");
    await expect(cell(0, 2)).toHaveText("Kyoto");
    // Canvas rendering is a separate path from the accessible cells.
    await expect
      .poll(() =>
        page.locator(".vg-canvas").evaluate((element: HTMLCanvasElement) => {
          const pixel = element.getContext("2d")?.getImageData(element.width / 2, element.height / 2, 1, 1).data;
          return pixel?.[3];
        }),
      )
      .toBe(255);

    await grid.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("Nagano");
    await expect(page.locator(".vg-editor-input")).toHaveValue("Nagano");
    await page.keyboard.press("Enter");
    await expect(cell(0, 2)).toHaveText("Nagano");
    await expect(grid).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(cell(0, 2)).toHaveText("Kyoto");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(cell(0, 2)).toHaveText("Nagano");

    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
    const header = page.getByRole("columnheader", { name: "id", exact: true });
    const box = await header.boundingBox();
    if (!box) throw new Error("The column header has a box.");
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await page.keyboard.press("ControlOrMeta+Home");
    await expect(cell(0, 0)).toHaveText("99");
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await expect(cell(99, 0)).toHaveText("0");
    expect(errors).toEqual([]);
  });
}
