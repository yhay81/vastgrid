import assert from "node:assert/strict";
import { test } from "node:test";
import { columnGroupDepth, columnGroupPaths, columnGroupSpans, MAX_GROUP_DEPTH, spanAt } from "../src/column-groups.ts";
import type { ColumnGroup } from "../src/types.ts";

const q1: ColumnGroup = { name: "Q1", children: ["jan", "feb", "mar"] };
const q2: ColumnGroup = { name: "Q2", children: ["apr", "may"] };
const sales: ColumnGroup = { name: "Sales", children: [q1, q2] };

test("paths list each column's groups from the outermost, and the depth counts nested groups", () => {
  const paths = columnGroupPaths([sales, { name: "Notes", children: ["note"] }]);
  assert.deepEqual(
    paths.get("feb")?.map((group) => group.name),
    ["Sales", "Q1"],
  );
  assert.deepEqual(
    paths.get("note")?.map((group) => group.name),
    ["Notes"],
  );
  assert.equal(paths.has("id"), false);
  assert.equal(columnGroupDepth([sales]), 2);
  assert.equal(columnGroupDepth([{ name: "Empty", children: [] }]), 1);
  assert.equal(columnGroupDepth([]), 0);
});

test("invalid groups throw a RangeError", () => {
  assert.throws(() => columnGroupPaths([q1, { name: "Again", children: ["feb"] }]), RangeError);
  assert.throws(() => columnGroupPaths([{ name: "No children" } as unknown as ColumnGroup]), RangeError);
  let deep: ColumnGroup = { name: "leaf", children: ["x"] };
  for (let level = 0; level < MAX_GROUP_DEPTH; level++) deep = { name: `g${level}`, children: [deep] };
  assert.throws(() => columnGroupPaths([deep]), RangeError);
});

function spans(names: string[], breaks: number[] = []) {
  const paths = columnGroupPaths([sales]);
  return columnGroupSpans(
    names.map((name) => paths.get(name)),
    2,
    breaks,
  ).map((row) => row.map((span) => `${span.group.name}:${span.start}-${span.end}`));
}

test("spans cover runs of side-by-side columns of each group", () => {
  assert.deepEqual(spans(["id", "jan", "feb", "mar", "apr", "may"]), [["Sales:1-5"], ["Q1:1-3", "Q2:4-5"]]);
});

test("a column moved between a group's columns splits the group, each part keeping the name", () => {
  assert.deepEqual(spans(["jan", "id", "feb", "mar"]), [
    ["Sales:0-0", "Sales:2-3"],
    ["Q1:0-0", "Q1:2-3"],
  ]);
});

test("hidden columns are left out, so a group shows over the visible ones", () => {
  // "feb" hidden: the visible columns are still side by side.
  assert.deepEqual(spans(["jan", "mar", "apr"]), [["Sales:0-2"], ["Q1:0-1", "Q2:2-2"]]);
});

test("frozen columns split the groups that continue into the scrolling columns", () => {
  assert.deepEqual(spans(["jan", "feb", "mar", "apr"], [2]), [
    ["Sales:0-1", "Sales:2-3"],
    ["Q1:0-1", "Q1:2-2", "Q2:3-3"],
  ]);
});

test("spanAt finds the span covering a column", () => {
  const paths = columnGroupPaths([sales]);
  const [outer, inner] = columnGroupSpans(
    ["id", "jan", "feb", "apr"].map((name) => paths.get(name)),
    2,
  );
  assert.equal(spanAt(outer, 0), null);
  assert.equal(spanAt(outer, 3)?.group, sales);
  assert.equal(spanAt(inner, 2)?.group, q1);
  assert.equal(spanAt(inner, 3)?.group, q2);
});
