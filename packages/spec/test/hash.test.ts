import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, normalizePlan, type Plan, planHash } from "../src/index.ts";

test("the normal form leaves out empty derive and sort, and keeps everything else (§4.8)", () => {
  const plan: Plan = { derive: [], sort: [], where: { col: "ok" }, aggregate: { keys: [], measures: [] } };
  assert.deepEqual(normalizePlan(plan), { where: { col: "ok" }, aggregate: { keys: [], measures: [] } });
});

test("canonical JSON sorts members by code point and has no white space", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } }),
    '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
  );
  // U+FF61 comes before U+1F600 by code point, after it by UTF-16 code unit.
  assert.equal(canonicalJson({ "\u{1F600}": 1, "｡": 2 }), '{"｡":2,"\u{1F600}":1}');
  assert.equal(canonicalJson({ a: undefined, b: 1.5 }), '{"b":1.5}');
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
});

test("the hash is the SHA-256 of the normal form, whatever the order of members", async () => {
  const expected = `sha256:${createHash("sha256").update("{}").digest("hex")}`;
  assert.equal(await planHash({}), expected);
  assert.equal(await planHash({ derive: [], sort: [] }), expected);
  const a: Plan = { sort: [{ column: "x", direction: "asc" }], where: { fn: "eq", args: [{ col: "x" }, { lit: 1 }] } };
  const b = JSON.parse(
    '{"where":{"args":[{"col":"x"},{"lit":1}],"fn":"eq"},"sort":[{"direction":"asc","column":"x"}]}',
  );
  assert.equal(await planHash(a), await planHash(b));
  assert.notEqual(await planHash(a), await planHash({ ...a, sort: [{ column: "x", direction: "desc" }] }));
  assert.match(await planHash(a), /^sha256:[0-9a-f]{64}$/);
});
