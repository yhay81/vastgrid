import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { benchDirectory } from "../packages/duckdb-engine/bench/files.ts";

/**
 * The search box and its switch that folds width and kana (docs/react.md §6.2, §3.5 of the specification), on a
 * file read by the DuckDB engine over HTTP (`examples/files`).
 */
const file = "e2e-search.csv";

test.beforeAll(async () => {
  await mkdir(benchDirectory, { recursive: true });
  await writeFile(
    path.join(benchDirectory, file),
    "id,name\n1,ｶﾌｪ\n2,カフェ\n3,かふぇ\n4,ガフェ\n5,ＣＡＦＥ\n6,cafe\n",
  );
});

test.afterAll(async () => {
  await rm(path.join(benchDirectory, file), { force: true });
});

test("the switch folds width and kana in the search", async ({ page }) => {
  await page.goto(`/?file=${file}`);
  await expect(page.getByRole("gridcell", { name: "ガフェ", exact: true })).toBeAttached({ timeout: 30_000 });
  const names = page.getByRole("gridcell").filter({ hasText: /^(ｶﾌｪ|カフェ|かふぇ|ガフェ|ＣＡＦＥ|cafe)$/ });
  const search = page.getByRole("searchbox", { name: "Search" });
  const fold = page.getByRole("button", { name: "Match full-width and half-width, hiragana and katakana" });
  await expect(fold).toHaveAttribute("aria-pressed", "false");

  await search.fill("かふぇ");
  await expect(names).toHaveText(["かふぇ"]);
  await fold.click();
  await expect(fold).toHaveAttribute("aria-pressed", "true");
  await expect(names).toHaveText(["ｶﾌｪ", "カフェ", "かふぇ"]);

  // The switch stays on for the next text.
  await search.fill("cafe");
  await expect(names).toHaveText(["ＣＡＦＥ", "cafe"]);
  await fold.click();
  await expect(names).toHaveText(["cafe"]);
  await search.fill("");
  await expect(names).toHaveCount(6);
});
