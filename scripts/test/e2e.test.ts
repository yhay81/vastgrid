import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { functionalSuites, suites } from "../../e2e/suites.ts";

test("every E2E spec belongs to exactly one suite, with heavy tests outside the functional run", async () => {
  const files = (await readdir(new URL("../../e2e/", import.meta.url), { recursive: true }))
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
  const assigned = Object.values(suites).flatMap((suite) => suite.tests.map((name) => `${name}.spec.ts`));
  assert.deepEqual(assigned.sort(), files, "Register each E2E spec once in e2e/suites.ts");
  assert.deepEqual(
    functionalSuites.flatMap((name) => [...suites[name].tests]).sort(),
    files.filter((name) => !["budgets.spec.ts", "files.spec.ts"].includes(name)).map((name) => name.slice(0, -8)),
  );
});
