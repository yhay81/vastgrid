import { expect, type Page, test } from "@playwright/test";
import { openBench } from "./bench.ts";

test.beforeEach(async ({ page }) => {
  await openBench(page, { rows: 1_000 });
});

/** The text of a cell as the accessibility rows give it (row and column from 0). */
function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][id$="-r${row}-c${column}"]`);
}

async function focusCell(page: Page, down: number, right: number) {
  await page.getByRole("grid").focus();
  for (let index = 0; index < down; index++) await page.keyboard.press("ArrowDown");
  for (let index = 0; index < right; index++) await page.keyboard.press("ArrowRight");
}

test("typing over a cell edits it, Enter writes it and moves down, and undo writes it back", async ({ page }) => {
  await focusCell(page, 1, 2);
  await expect(cell(page, 1, 2)).toHaveText("Sendai");
  await page.keyboard.type("Nagano");
  const editor = page.locator(".vg-editor-input");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Nagano");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("grid")).toBeFocused();
  await expect(cell(page, 1, 2)).toHaveText("Nagano");
  await expect(page.locator(".vg-statusbar__cell")).toHaveText("Row 3, city");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell(page, 1, 2)).toHaveText("Sendai");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(cell(page, 1, 2)).toHaveText("Nagano");
});

test("an IME composition that starts on the grid goes into the editor whole", async ({ page }) => {
  await focusCell(page, 2, 2);
  const cdp = await page.context().newCDPSession(page);
  // A Japanese IME: the key that starts a composition is "Process" (229), then the composition, then its text.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Process",
    code: "KeyT",
    windowsVirtualKeyCode: 229,
  });
  await cdp.send("Input.imeSetComposition", { text: "と", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "とうきょう", selectionStart: 5, selectionEnd: 5 });
  const editor = page.locator(".vg-editor-input");
  await expect(editor).toBeFocused();
  await cdp.send("Input.insertText", { text: "東京" });
  await expect(editor).toHaveValue("東京");
  await page.keyboard.press("Enter");
  await expect(cell(page, 2, 2)).toHaveText("東京");
});

test("Escape cancels, F2 edits the value, and text that is not a number keeps the editor with why", async ({
  page,
}) => {
  await focusCell(page, 0, 4);
  const before = await cell(page, 0, 4).textContent();
  await page.keyboard.press("F2");
  const editor = page.locator(".vg-editor-input");
  await expect(editor).toHaveValue(before ?? "");
  await page.keyboard.press("End");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await expect(page.locator(".vg-editor-error")).toHaveText("This is not a value of quantity.");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("grid")).toBeFocused();
  await expect(cell(page, 0, 4)).toHaveText(before ?? "");
});

test("the modifier and Enter write the editor's text into every selected cell, as one step to undo", async ({
  page,
}) => {
  await focusCell(page, 0, 2);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  const before = await Promise.all([0, 1, 2].map(async (row) => (await cell(page, row, 2).textContent()) ?? ""));
  await page.keyboard.type("Nara");
  await expect(page.locator(".vg-editor-input")).toHaveValue("Nara");
  await page.keyboard.press("ControlOrMeta+Enter");
  const grid = page.getByRole("grid");
  await expect(grid).toBeFocused();
  for (const row of [0, 1, 2]) await expect(cell(page, row, 2)).toHaveText("Nara");
  // The active cell stays.
  await expect.poll(async () => grid.getAttribute("aria-activedescendant")).toMatch(/-r0-c2$/);
  await page.keyboard.press("ControlOrMeta+z");
  for (const [row, text] of before.entries()) await expect(cell(page, row, 2)).toHaveText(text);
});

test("cutting puts the selection on the clipboard as TSV, then clears it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await focusCell(page, 0, 1);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  const city = (await cell(page, 0, 2).textContent()) ?? "";
  await page.evaluate(() => document.execCommand("cut"));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Ren 0\t${city}\nSora 1\tSendai`);
  for (const [row, column] of [
    [0, 1],
    [0, 2],
    [1, 1],
    [1, 2],
  ])
    await expect(cell(page, row, column)).toHaveText("");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell(page, 0, 1)).toHaveText("Ren 0");
  await expect(cell(page, 1, 2)).toHaveText("Sendai");
});

test("the modifier with ; types today's date, and with : the time at the caret", async ({ page }) => {
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  await focusCell(page, 0, 5);
  await page.keyboard.press("ControlOrMeta+;");
  const editor = page.locator(".vg-editor-input");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(today);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("grid")).toBeFocused();
  // Written as a date: the editor gives it back.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("F2");
  await expect(editor).toHaveValue(today);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("at ");
  await page.keyboard.press("ControlOrMeta+:");
  await expect(editor).toHaveValue(/^at \d{2}:\d{2}:\d{2}$/);
  await page.keyboard.press("Escape");
});
