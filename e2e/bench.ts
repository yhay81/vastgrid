import type { Page } from "@playwright/test";

/** Opens the bench with a grid and waits for its first rows on screen. */
export async function openBench(
  page: Page,
  options: { rows?: number; columns?: number; engine?: "main" | "worker"; strict?: boolean; initial?: boolean } = {},
) {
  const { rows = 1_000_000, columns = 8, engine = "main" } = options;
  const flags = `${options.strict ? "&strict" : ""}${options.initial ? "&initial" : ""}`;
  await page.goto(`/?rows=${rows}&columns=${columns}&engine=${engine}${flags}`);
  await page.waitForFunction(() => window.bench?.firstRowsAt !== null, undefined, { timeout: 60_000 });
  // Let the first reads and the accessibility rows settle.
  await page.waitForTimeout(300);
}

/** The value at a quantile of numbers. */
export function quantile(values: readonly number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** What the bench measures on a grid: first rows, scrolling, keys. */
export async function measure(page: Page) {
  const first = await page.evaluate(() => (window.bench.firstRowsAt ?? Number.NaN) - window.bench.mountedAt);
  const scroll = await page.evaluate(() => window.bench.scroll(100, 240));
  // Keys from the top, once scrolling has paused: what follows a pause (the accessibility rows) is not a key's.
  await page.evaluate(() => {
    const scroller = document.querySelector(".vg-scroller");
    if (scroller) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.locator(".vg-scroller").focus();
  await page.evaluate(() => {
    window.bench.latencies.length = 0;
  });
  const keys: number[] = [];
  const renders: number[] = [];
  for (let press = 0; press < 40; press++) {
    const before = await page.evaluate(() => window.bench.commits.length);
    await page.keyboard.press("ArrowDown");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
    const commits = await page.evaluate((from) => window.bench.commits.slice(from), before);
    keys.push(commits.length);
    // The time React spent rendering for the key (Profiler's actualDuration), over its commits.
    renders.push(commits.reduce((total, commit) => total + commit.duration, 0));
  }
  const latencies = await page.evaluate(() => [...window.bench.latencies]);
  const heap = await page.evaluate(() => window.bench.heap());
  const sort = await page.evaluate(() => window.bench.sort("amount"));
  return {
    firstRows: first,
    scrollCommits: scroll.commits,
    scrollGapP50: quantile(scroll.frames, 0.5),
    scrollGapP95: quantile(scroll.frames, 0.95),
    scrollGapMax: Math.max(...scroll.frames),
    commitsPerKey: Math.max(...keys),
    keyRenderP50: Math.round(quantile(renders, 0.5) * 100) / 100,
    keyRenderP95: Math.round(quantile(renders, 0.95) * 100) / 100,
    keyLatencyP50: quantile(latencies, 0.5),
    keyLatencyP95: quantile(latencies, 0.95),
    sortMs: Math.round(sort.ms),
    sortLongestTask: Math.round(sort.longestTask),
    heapMB: heap === null ? null : Math.round(heap / 1_048_576),
  };
}
