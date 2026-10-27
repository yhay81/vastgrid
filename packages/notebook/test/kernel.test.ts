import assert from "node:assert/strict";
import test from "node:test";
import { Kernel } from "./kernel.ts";

test("a kernel that exits rejects all pending requests and later requests", { timeout: 10_000 }, async (t) => {
  const kernel = new Kernel(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(7))"]);
  t.after(() => kernel.close());
  const results = await Promise.allSettled([kernel.line({ first: true }), kernel.line({ second: true })]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /kernel closed \(code 7/);
  }
  await assert.rejects(kernel.line({ later: true }), /kernel closed \(code 7/);
});

test("a kernel that cannot start rejects requests instead of waiting forever", { timeout: 10_000 }, async (t) => {
  const kernel = new Kernel("vastgrid-test-command-that-does-not-exist", []);
  t.after(() => kernel.close());
  await assert.rejects(kernel.line({}), { code: "ENOENT" });
  await assert.rejects(kernel.line({ later: true }), { code: "ENOENT" });
});
