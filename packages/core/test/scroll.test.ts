import assert from "node:assert/strict";
import { test } from "node:test";
import { ColumnLayout } from "../src/layout.ts";
import { ScrollAxis } from "../src/scroll.ts";

test("small content maps one to one", () => {
  const axis = new ScrollAxis(1000);
  assert.equal(axis.resize(800, 200), 800);
  assert.equal(axis.scaled, false);
  assert.equal(axis.onNativeScroll(150), 150);
  assert.equal(axis.scrollTo(300), 300);
  assert.equal(axis.onNativeScroll(300), 300);
  assert.equal(axis.onNativeScroll(10_000), 600);
});

test("large content keeps small movements exact and maps jumps proportionally", () => {
  const axis = new ScrollAxis(10_000);
  const content = 1_000_000;
  assert.equal(axis.resize(content, 500), 10_000);
  assert.equal(axis.scaled, true);
  // Wheel scrolling moves by the same amount.
  assert.equal(axis.onNativeScroll(100), 100);
  assert.equal(axis.onNativeScroll(140), 140);
  // A jump (thumb drag) maps proportionally.
  const middle = axis.onNativeScroll(4750);
  assert.equal(middle, (4750 / 9500) * (content - 500));
  // Then small movements are exact again.
  assert.equal(axis.onNativeScroll(4760), middle + 10);
  // The ends map to the ends.
  assert.equal(axis.onNativeScroll(9500), content - 500);
  assert.equal(axis.onNativeScroll(0), 0);
});

test("scrollTo moves nearby targets locally and far targets proportionally", () => {
  const axis = new ScrollAxis(10_000);
  axis.resize(1_000_000, 500);
  axis.onNativeScroll(4750);
  const start = axis.position;
  const native = axis.scrollTo(start + 24);
  assert.equal(native, 4750 + 24);
  // The scroll event that follows keeps the requested position, even when rounded.
  assert.equal(axis.onNativeScroll(Math.round(native)), start + 24);
  const far = axis.scrollTo(900_000);
  assert.ok(Math.abs(far - (900_000 / 999_500) * 9500) < 1e-6);
  assert.equal(axis.onNativeScroll(far), 900_000);
  assert.equal(axis.scrollTo(Number.MAX_SAFE_INTEGER), 9500);
  assert.equal(axis.position, 999_500);
});

test("column layout finds columns by position", () => {
  const layout = new ColumnLayout([100, 50, 200]);
  assert.equal(layout.total, 350);
  assert.equal(layout.left(2), 150);
  assert.equal(layout.width(1), 50);
  assert.equal(layout.indexAt(-5), 0);
  assert.equal(layout.indexAt(99.9), 0);
  assert.equal(layout.indexAt(100), 1);
  assert.equal(layout.indexAt(149), 1);
  assert.equal(layout.indexAt(150), 2);
  assert.equal(layout.indexAt(1000), 2);
  assert.equal(new ColumnLayout([]).indexAt(10), -1);
});
