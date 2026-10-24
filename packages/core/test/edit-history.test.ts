import assert from "node:assert/strict";
import { test } from "node:test";
import { EditHistory, type HistoryEntry } from "../src/edit-history.ts";

const entry = (value: string, cells = 1): HistoryEntry => ({
  reason: "edit",
  changes: Array.from({ length: cells }, (_, row) => ({ row, column: 0, value, previous: null })),
});

test("undo and redo move entries between the stacks; a new entry drops the redo stack", () => {
  const history = new EditHistory();
  assert.equal(history.canUndo, false);
  const a = entry("a");
  const b = entry("b");
  history.record(a);
  history.record(b);
  assert.equal(history.peekUndo(), b);
  assert.ok(history.undone(b));
  assert.ok(!history.undone(b), "only the top entry");
  assert.equal(history.peekRedo(), b);
  assert.ok(history.redone(b));
  history.undone(b);
  history.record(entry("c"));
  assert.equal(history.canRedo, false);
  assert.equal(history.undoSize, 2);
  history.clear();
  assert.equal(history.canUndo, false);
});

test("the history is bounded by entries, cells and text", () => {
  const byEntries = new EditHistory({ maxEntries: 3 });
  for (let index = 0; index < 5; index++) byEntries.record(entry(String(index)));
  assert.equal(byEntries.undoSize, 3);
  const byCells = new EditHistory({ maxCells: 10 });
  byCells.record(entry("a", 6));
  byCells.record(entry("b", 6));
  assert.equal(byCells.undoSize, 1, "the oldest entry is dropped");
  assert.equal(byCells.record(entry("c", 11)), false, "too large on its own");
  assert.equal(byCells.canUndo, false, "older entries cannot be undone in order without it");
  const byText = new EditHistory({ maxText: 4 });
  byText.record(entry("abc"));
  byText.record(entry("de"));
  assert.equal(byText.undoSize, 1);
});
