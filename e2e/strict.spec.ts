import { expect, type Page, test } from "@playwright/test";
import { openBench } from "./bench.ts";

/** Errors and React's warnings in the console while the page runs. */
function watchConsole(page: Page) {
  const messages: string[] = [];
  page.on("pageerror", (error) => messages.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") messages.push(message.text());
  });
  return messages;
}

for (const initial of [false, true]) {
  test(`in Strict Mode${initial ? ", with `initial` as a promise," : ""} the grid opens one table and works`, async ({
    page,
  }) => {
    const messages = watchConsole(page);
    await openBench(page, { rows: 10_000, strict: true, initial });
    // Mounted twice: the first connection's table is closed. `initial` opens and closes one more.
    expect(await page.evaluate(() => window.bench.opens)).toBe(initial ? 3 : 2);
    expect(await page.evaluate(() => window.bench.openTables.size)).toBe(1);
    const grid = page.getByRole("grid", { name: "Data table" });
    await expect(grid).toHaveAttribute("aria-rowcount", "10001");
    await expect(page.getByRole("gridcell", { name: "Ren 0", exact: true }).first()).toBeAttached();

    await page.evaluate(() => window.bench.sort("id"));
    await expect(page.getByRole("columnheader", { name: "id" })).toHaveAttribute("aria-sort", "ascending");
    await grid.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".vg-statusbar__cell")).toHaveText("Row 2, id");

    expect(await page.evaluate(() => window.bench.openTables.size)).toBe(1);
    expect(messages).toEqual([]);
  });
}
