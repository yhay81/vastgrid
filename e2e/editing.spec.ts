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
