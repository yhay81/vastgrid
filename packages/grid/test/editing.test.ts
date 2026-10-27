import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryEngine } from "vastgrid-js";
import { createGridStore, localTransport } from "../src/core.ts";
import { settle } from "./fake-engine.ts";

function table() {
  return {
    editable: true,
    columns: [
      { name: "id", type: "bigint" as const },
      { name: "city", type: "string" as const },
      { name: "qty", type: "integer" as const },
    ],
    rows: [
      [1, "Tokyo", 3],
      [2, "Osaka", 5],
      [3, "Kobe", 1],
    ],
  };
}

async function editable(document?: { kind: "vastgrid/document"; version: 2; rowKey?: string }) {
  const engine = memoryEngine({ tables: { cities: table() } });
  const store = createGridStore({
    transport: localTransport(engine),
    table: "cities",
    ...(document ? { document } : {}),
  });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "city", "qty"] });
  for (let attempt = 0; attempt < 200 && store.getSnapshot().view === null; attempt++) await settle(1);
  await settle(5);
  return { store, disconnect };
}

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await settle(1);
  assert.ok(done());
}

test("typing into a cell writes it, shows the value at once and records a step to undo (§6.5, §7.4)", async () => {
  const { store, disconnect } = await editable();
  await store.dispatch({ command: "select", row: 1, column: "city" });
  assert.deepEqual(store.dispatchSync({ command: "edit.begin", text: "" }), { ok: true });
  store.dispatchSync({ command: "edit.change", text: "Nara" });
  assert.equal(store.getSnapshot().session.editor?.text, "Nara");
  const committed = store.dispatch({ command: "edit.commit", move: "down" });
  // Before the engine answers, the editor is closed, the active cell moved and the cell shows the new value.
  assert.equal(store.getSnapshot().session.editor, undefined);
  assert.equal(store.getSnapshot().session.active?.row, 2);
  assert.equal(store.cell(1, "city"), "Nara");
  assert.deepEqual(await committed, { ok: true });
  await until(() => store.getSnapshot().table?.edits.version === 1 && store.getSnapshot().pending === null);
  assert.equal(store.cell(1, "city"), "Nara");
  assert.equal(store.getSnapshot().session.history?.undo.length, 1);
  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "city") === "Osaka");
  assert.deepEqual(store.getSnapshot().session.history, {
    undo: [],
    redo: [{ updates: [{ key: { rowId: 1 }, column: "city", before: "Osaka", after: "Nara" }] }],
  });
  assert.deepEqual(await store.dispatch({ command: "history.redo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "city") === "Nara");
  disconnect();
});

test("text that is not a value of the column keeps the editor open, and a cell cleared by key is null", async () => {
  const { store, disconnect } = await editable({ kind: "vastgrid/document", version: 2, rowKey: "id" });
  await store.dispatch({ command: "select", row: 0, column: "qty" });
  store.dispatchSync({ command: "edit.begin", text: "three" });
  const outcome = store.dispatchSync({ command: "edit.commit", move: null });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? "" : (outcome.error as { reason?: string }).reason, "invalid_value");
  assert.equal(store.getSnapshot().session.editor?.text, "three", "the editor stays");
  store.dispatchSync({ command: "edit.cancel" });
  await store.dispatch({ command: "select", row: 2, column: "qty", mode: "replace" });
  assert.deepEqual(await store.dispatch({ command: "edit.clear" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(2, "qty") === null);
  assert.deepEqual(store.getSnapshot().session.history?.undo[0].updates[0].key, { value: 3 });
  disconnect();
});

test("a write that fails shows the cell's value again and reports why", async () => {
  const engine = memoryEngine({ tables: { cities: table() } });
  const transport = localTransport(engine);
  const failing = {
    ...transport,
    send: (request: Parameters<typeof transport.send>[0], options: Parameters<typeof transport.send>[1]) =>
      request.op === "write"
        ? Promise.resolve({ v: 2, id: request.id, error: { code: "edit_conflict", message: "Someone wrote it." } })
        : transport.send(request, options),
  };
  const store = createGridStore({ transport: failing, table: "cities" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "city", "qty"] });
  for (let attempt = 0; attempt < 200 && store.getSnapshot().view === null; attempt++) await settle(1);
  await settle(5);
  await store.dispatch({ command: "select", row: 0, column: "city" });
  store.dispatchSync({ command: "edit.begin", text: "Sendai" });
  const committed = store.dispatch({ command: "edit.commit", move: null });
  assert.equal(store.cell(0, "city"), "Sendai");
  const outcome = await committed;
  assert.equal(outcome.ok ? "" : outcome.error.code, "edit_conflict");
  assert.equal(store.cell(0, "city"), "Tokyo");
  assert.equal(store.getSnapshot().session.history, undefined);
  disconnect();
});

test("export over an engine that answers data gives the file's bytes, with written cells and a name (§6.6)", async () => {
  const { store, disconnect } = await editable();
  await store.dispatch({ command: "select", row: 1, column: "city" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  await store.dispatch({ command: "edit.commit" });
  await until(() => store.getSnapshot().table?.edits.version === 1 && store.getSnapshot().pending === null);
  await store.dispatch({ command: "sort.set", keys: [{ column: "qty", direction: "desc" }] });
  const outcome = await store.dispatch({ command: "export", format: "csv" });
  assert.ok(outcome.ok);
  const output = outcome.output as { target: null; rows: number; data: { bytes: Uint8Array } };
  assert.deepEqual([output.target, output.rows], [null, 3]);
  assert.equal(new TextDecoder().decode(output.data.bytes), "id,city,qty\n2,Nara,5\n1,Tokyo,3\n3,Kobe,1\n");
  assert.equal(store.exportName("csv"), "cities.csv");
  const parquet = await store.dispatch({ command: "export", format: "parquet" });
  assert.equal(parquet.ok, false);
  disconnect();
});
