import { expect, type Locator, type Page, test } from "@playwright/test";
import { benchDirectory, benchFiles } from "../packages/duckdb-engine/bench/files.ts";

/**
 * Step 2 of the rebuild (docs/rebuild-decision.ja.md): v2's grid opens a Parquet file of 100,000,000 rows and a
 * CSV file of 10,000,000 rows (735 MB) through the DuckDB engine over HTTP (`examples/files`), and scrolls them to
 * their last row. The files are those of the benches, made when they are missing; `VASTGRID_E2E_PARQUET_ROWS` and
 * `VASTGRID_E2E_CSV_ROWS` choose smaller ones.
 */
const site = "http://127.0.0.1:5183";
const parquetRows = Number(process.env.VASTGRID_E2E_PARQUET_ROWS ?? 100_000_000);
const csvRows = Number(process.env.VASTGRID_E2E_CSV_ROWS ?? 10_000_000);

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  // Making the files takes a minute or more the first time.
  test.setTimeout(900_000);
  await benchFiles(benchDirectory, csvRows, parquetRows);
});

/** The text of the `name` column of a row, as the benches' files make it. */
function nameOf(row: number) {
  return `item-${row % 50_000}${row % 7 === 0 ? ' "special", limited' : ""}`;
}

/** Scrolls to the end with the scroll bar, then moves there with the keys, and checks the last row. */
async function scrollToEnd(page: Page, grid: Locator, rows: number) {
  await page.locator(".vg-scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // The rows on screen are in the accessibility tree once scrolling has paused.
  await expect(page.getByRole("gridcell", { name: String(rows - 1), exact: true })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole("gridcell", { name: nameOf(rows - 1), exact: true }).first()).toBeAttached();
  await page.locator(".vg-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole("gridcell", { name: nameOf(1), exact: true })).toBeAttached({ timeout: 30_000 });
  await grid.focus();
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(page.locator(".vg-statusbar__cell")).toHaveText(`Row ${rows.toLocaleString("en")}, id`);
  await expect(page.getByRole("gridcell", { name: String(rows - 1), exact: true })).toBeAttached({ timeout: 30_000 });
}

test("a Parquet file of 100,000,000 rows opens and scrolls to its last row", async ({ page }) => {
  const name = `sales-${parquetRows}.parquet`;
  await page.goto(`${site}/?file=${name}`);
  const grid = page.getByRole("grid", { name });
  await expect(grid).toHaveAttribute("aria-rowcount", String(parquetRows + 1), { timeout: 30_000 });
  await expect(page.locator(".vg-statusbar")).toContainText(`${parquetRows.toLocaleString("en")} rows`);
  await expect(page.getByRole("gridcell", { name: nameOf(1), exact: true })).toBeAttached();
  await scrollToEnd(page, grid, parquetRows);
});

test("a CSV file of 735 MB shows its first rows at once, then every row to the last", async ({ page }) => {
  const name = `sales-${csvRows}.csv`;
  await page.goto(`${site}/?file=${name}`);
  const grid = page.getByRole("grid", { name });
  // The first rows are read while the rest loads on the server (§9).
  await expect(page.getByRole("gridcell", { name: nameOf(1), exact: true })).toBeAttached({ timeout: 10_000 });
  // Once the table has loaded, the grid holds every row (§8.5), without reading the page again.
  await expect(grid).toHaveAttribute("aria-rowcount", String(csvRows + 1), { timeout: 180_000 });
  await scrollToEnd(page, grid, csvRows);
});
