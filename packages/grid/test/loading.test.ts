/**
 * The grid over the memory engine while a text file loads (docs/spec.md §9): the first rows show at once, a sort
 * waits for the file, and the columns that the whole file has replace those of its first rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryEngine, type TextFile } from "vastgrid-js";
import { createGridStore, localTransport } from "../src/core.ts";
import { settle } from "./fake-engine.ts";

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 400 && !done(); attempt++) await settle(1);
  assert.ok(done());
}

test("the grid shows the first rows of a file while the memory engine loads it, and the whole file after", async (t) => {
  // The last `v` is text, which the first rows do not have: the whole file has other columns.
  const lines = Array.from({ length: 100 }, (_, row) => `${row},${row === 99 ? "x" : row * 2}`);
  const blob = new Blob([`id,v\n${lines.join("\n")}\n`]);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const file: TextFile = {
    size: blob.size,
    name: "t.csv",
    slice: (start = 0, end = blob.size) => ({
      arrayBuffer: async () => {
        if (end > 64) await released;
        return blob.slice(start, end).arrayBuffer();
      },
    }),
  };
  const engine = memoryEngine({ tables: { t: { file } }, previewBytes: 64 });
  const store = createGridStore({ transport: localTransport(engine), table: "t" });
  t.after(store.connect());
  store.setViewport({ top: 0, rows: 20, columns: ["id", "v"] });
  await until(() => store.cell(10, "v") === 20);
  assert.equal(store.getSnapshot().table?.status, "loading");
  assert.equal(store.cell(11, "v"), undefined);
  assert.deepEqual(await store.dispatch({ command: "sort.set", keys: [{ column: "id", direction: "desc" }] }), {
    ok: true,
  });
  await settle(5);
  assert.ok(store.getSnapshot().pending);
  release();
  await until(() => store.cell(0, "v") === "x");
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    [snapshot.table?.status, snapshot.table?.columns[1].type, snapshot.view?.rowCount, snapshot.pending],
    ["ready", "string", 100, null],
  );
  assert.equal(store.cell(1, "v"), "196");
  assert.equal(snapshot.error, null);
});
