import { expect, test } from "@playwright/test";
import { measure, openBench } from "./bench.ts";

// v2-react.md §10. Counts of commits are exact; times allow for the machine (60 Hz frames, shared CI runners).
test("v2 stays within its performance budgets on a million rows", async ({ page }) => {
  await openBench(page, "v2");
  const result = await measure(page);
  console.log(`v2 ${JSON.stringify(result)}`);
  expect(result.commitsPerKey).toBeLessThanOrEqual(1);
  expect(result.scrollCommits).toBe(0);
  expect(result.scrollGapP95).toBeLessThan(25);
  expect(result.keyLatencyP95).toBeLessThan(25);
  expect(result.firstRows).toBeLessThan(300);
});

test("v2 with its engine in a Web Worker keeps the page responsive while it sorts", async ({ page }) => {
  await openBench(page, "v2", { engine: "worker" });
  const result = await measure(page);
  console.log(`v2-worker ${JSON.stringify(result)}`);
  expect(result.commitsPerKey).toBeLessThanOrEqual(1);
  expect(result.scrollCommits).toBe(0);
  // Sorting a million rows takes the worker a while; the page meanwhile has no task long enough to drop frames.
  expect(result.sortLongestTask).toBeLessThan(100);
});

test("v1 measured the same way, for the comparison of v2-react.md Appendix A", async ({ page }) => {
  await openBench(page, "v1");
  const result = await measure(page);
  console.log(`v1 ${JSON.stringify(result)}`);
  expect(result.firstRows).toBeGreaterThan(0);
});
