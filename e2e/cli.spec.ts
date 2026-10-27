import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cell, row, writeWorkbook } from "../packages/duckdb-engine/test/xlsx-fixture.ts";

/**
 * `vastgrid` (docs/cli.md) as a person runs it, on a folder and with saving on (playwright.config.ts): the address
 * that it prints opens the page, which lists the folder's files, saves edited cells into a CSV file with the keys
 * and exports the view, all through the command's server and nothing else.
 */
const site = "http://127.0.0.1:5186";
const folder = path.resolve(".data/cli-e2e");
const orders = ".data/cli-e2e/orders.csv";

test.beforeEach(async () => {
  mkdirSync(path.join(folder, "sub"), { recursive: true });
  writeFileSync(path.join(folder, "orders.csv"), "id,region,price\n1,EU,10.5\n2,US,30\n3,EU,20\n4,JP,5\n");
  writeFileSync(path.join(folder, "sub", "items.tsv"), "id\tname\n1\tpen\n2\tnote\n");
  await writeWorkbook(path.join(folder, "sub", "book.xlsx"), {
    sheets: [
      { name: "Plan", rows: [row(1, [cell("A1", { t: "inlineStr", is: "plan" })]), row(2, [cell("A2", { v: 1 })])] },
      { name: "Done", rows: [row(1, [cell("A1", { t: "inlineStr", is: "done" })]), row(2, [cell("A2", { v: 2 })])] },
    ],
  });
});

/** Opens the address that the command printed (`VASTGRID_TOKEN` of playwright.config.ts). */
async function openPrinted(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${site}/?token=e2e-token-0123456789`);
  // The page keeps the token, which leaves the address.
  await expect(page).toHaveURL(`${site}/`);
  await expect(page.getByRole("grid", { name: orders })).toHaveAttribute("aria-rowcount", "5", { timeout: 30_000 });
  return problems;
}

test("the printed address opens the folder's files, and the address keeps the file and sheet shown", async ({
  page,
}) => {
  const problems = await openPrinted(page);
  const files = page.getByRole("combobox", { name: "File" });
  await expect(files.locator("option")).toHaveText([
    orders,
    ".data/cli-e2e/sub/book.xlsx",
    ".data/cli-e2e/sub/items.tsv",
  ]);
  await files.selectOption(".data/cli-e2e/sub/items.tsv");
  await expect(page).toHaveURL(`${site}/?file=.data%2Fcli-e2e%2Fsub%2Fitems.tsv`);
  await expect(page.getByRole("gridcell", { name: "pen", exact: true })).toBeAttached({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole("gridcell", { name: "pen", exact: true })).toBeAttached({ timeout: 30_000 });

  await files.selectOption(".data/cli-e2e/sub/book.xlsx");
  const sheets = page.getByRole("navigation", { name: "Sheets" });
  await expect(sheets.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 30_000,
  });
  await sheets.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(`${site}/?file=.data%2Fcli-e2e%2Fsub%2Fbook.xlsx&sheet=Done`);
  await expect(page.getByRole("gridcell", { name: "2", exact: true })).toBeAttached({ timeout: 30_000 });
  await page.goBack();
  await expect(sheets.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 30_000,
  });
  expect(problems).toEqual([]);
});

test("without the printed address, neither the page nor the files open", async ({ page }) => {
  const response = await page.goto(`${site}/`);
  expect(response?.status()).toBe(401);
  await expect(page.locator("body")).toContainText("Open the address that vastgrid printed");
  expect((await page.request.get(`${site}/files`)).status()).toBe(401);
  expect((await page.request.post(`${site}/api`, { data: { v: 2, id: 1, op: "open", ref: orders } })).status()).toBe(
    401,
  );
});

test("an edited cell is saved into the CSV file with the keys, and the view exports", async ({ page }) => {
  const problems = await openPrinted(page);
  await page.getByRole("grid", { name: orders }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("99.5");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("gridcell", { name: "99.5", exact: true })).toBeAttached({ timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+s");
  // The bytes of the fields not edited stay as they were.
  await expect
    .poll(() => readFileSync(path.join(folder, "orders.csv"), "utf8"), { timeout: 30_000 })
    .toBe("id,region,price\n1,EU,10.5\n2,US,99.5\n3,EU,20\n4,JP,5\n");

  await page.getByRole("button", { name: "Export" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "Export" }).getByRole("button", { name: "CSV" }).click();
  const exported = await (await downloading).path();
  expect(readFileSync(exported, "utf8")).toContain("2,US,99.5");
  expect(problems).toEqual([]);
});

/** A cell of the grid as the accessibility rows give it (row and column from 0). */
function gridCell(page: Page, at: number, column: number) {
  return page.locator(`[role="gridcell"][id$="-r${at}-c${column}"]`);
}

/** Moves the active cell from the first one. */
async function goTo(page: Page, down: number, right: number) {
  const grid = page.getByRole("grid", { name: orders });
  await grid.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let index = 0; index < down; index++) await page.keyboard.press("ArrowDown");
  for (let index = 0; index < right; index++) await page.keyboard.press("ArrowRight");
}

test("cells of a file are edited with an IME, pasted as HTML and TSV, cleared, undone, sent again and saved", async ({
  page,
}) => {
  const problems = await openPrinted(page);
  const status = page.locator(".vg-statusbar");

  // An IME composition that starts on the grid goes into the editor whole.
  await goTo(page, 0, 1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Process",
    code: "KeyO",
    windowsVirtualKeyCode: 229,
  });
  await cdp.send("Input.imeSetComposition", { text: "おうしゅう", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.insertText", { text: "欧州" });
  await expect(page.locator(".vg-editor-input")).toHaveValue("欧州");
  await page.keyboard.press("Enter");
  await expect(gridCell(page, 0, 1)).toHaveText("欧州", { timeout: 30_000 });

  // A table copied as HTML only (§6.5 takes the text first when there is one) is pasted from the active cell down.
  await goTo(page, 1, 1);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<table><tr><td>米国</td></tr><tr><td>EU&amp;2</td></tr></table>");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await expect(gridCell(page, 1, 1)).toHaveText("米国", { timeout: 30_000 });
  await expect(gridCell(page, 2, 1)).toHaveText("EU&2");

  // Tab-separated text, as spreadsheets copy it, with digit grouping.
  await goTo(page, 0, 2);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "1,234.5\n31");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await expect(gridCell(page, 1, 2)).toHaveText("31.0", { timeout: 30_000 });
  await expect(gridCell(page, 0, 2)).toHaveText("1234.5");

  // Delete clears, and undo and redo write by the keys.
  await goTo(page, 3, 1);
  await page.keyboard.press("Delete");
  await expect(gridCell(page, 3, 1)).toHaveText("", { timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(gridCell(page, 3, 1)).toHaveText("JP", { timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(gridCell(page, 3, 1)).toHaveText("", { timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(gridCell(page, 3, 1)).toHaveText("JP", { timeout: 30_000 });

  // A write that the connection loses shows the file's value with Retry, which writes it.
  let next: "lose" | "conflict" | null = "lose";
  await page.route(`${site}/api`, async (route) => {
    const body = route.request().postDataJSON() as { op: string; updates?: { previous?: unknown }[] };
    if (body.op !== "write" || next === null) return route.continue();
    const what = next;
    next = null;
    if (what === "lose") return route.abort("failed");
    // Someone else wrote the cell first: the value it was made from is not the cell's any more.
    for (const update of body.updates ?? []) update.previous = "someone else's";
    return route.continue({ postData: JSON.stringify(body) });
  });
  await page.keyboard.type("JPN");
  await page.keyboard.press("Enter");
  await expect(status.getByRole("alert")).toContainText("Not written", { timeout: 30_000 });
  await expect(gridCell(page, 3, 1)).toHaveText("JP");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(gridCell(page, 3, 1)).toHaveText("JPN", { timeout: 30_000 });
  await expect(status.getByRole("alert")).toHaveCount(0);

  // A conflict offers Overwrite, which writes over what the cell holds.
  next = "conflict";
  await goTo(page, 3, 1);
  await page.keyboard.type("Japan");
  await page.keyboard.press("Enter");
  await expect(status.getByRole("alert")).toContainText("the cells were changed meanwhile", { timeout: 30_000 });
  await expect(gridCell(page, 3, 1)).toHaveText("JPN");
  await status.getByRole("button", { name: "Overwrite" }).click();
  await expect(gridCell(page, 3, 1)).toHaveText("Japan", { timeout: 30_000 });

  // Discard forgets a failed write.
  next = "lose";
  await goTo(page, 2, 1);
  await page.keyboard.type("gone");
  await page.keyboard.press("Enter");
  await status.getByRole("button", { name: "Discard" }).click();
  await expect(status.getByRole("alert")).toHaveCount(0);
  await expect(gridCell(page, 2, 1)).toHaveText("EU&2");

  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFileSync(path.join(folder, "orders.csv"), "utf8"), { timeout: 30_000 })
    .toBe("id,region,price\n1,欧州,1234.5\n2,米国,31.0\n3,EU&2,20\n4,Japan,5\n");
  // The browser logs the requests that the test made fail, and nothing else.
  expect(problems.filter((text) => !/net::ERR_FAILED|409 \(Conflict\)/.test(text))).toEqual([]);
});
