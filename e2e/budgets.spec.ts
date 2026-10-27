import { expect, test } from "@playwright/test";
import { measure, openBench } from "./bench.ts";

// react.md §10. Counts of commits are exact; times allow for the machine (60 Hz frames, shared CI runners).
test("0.2 stays within its performance budgets on a million rows", async ({ page }) => {
  await openBench(page);
  const result = await measure(page);
  console.log(`0.2 ${JSON.stringify(result)}`);
  expect(result.commitsPerKey).toBeLessThanOrEqual(1);
  expect(result.scrollCommits).toBe(0);
  expect(result.scrollGapP95).toBeLessThan(25);
  expect(result.keyLatencyP95).toBeLessThan(25);
  expect(result.firstRows).toBeLessThan(300);
});

test("0.2 with its engine in a Web Worker keeps the page responsive while it sorts", async ({ page }) => {
  await openBench(page, { engine: "worker" });
  const result = await measure(page);
  console.log(`v2-worker ${JSON.stringify(result)}`);
  expect(result.commitsPerKey).toBeLessThanOrEqual(1);
  expect(result.scrollCommits).toBe(0);
  // Sorting a million rows takes the worker a while; the page meanwhile has no task long enough to drop frames.
  expect(result.sortLongestTask).toBeLessThan(100);
});
