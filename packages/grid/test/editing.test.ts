import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { memoryEngine } from "vastgrid-js";
import { createGridStore, localTransport, serveEngine, type Transport, workerTransport } from "../src/core.ts";
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
  return openStore(localTransport(engine), document);
}

async function openStore(transport: Transport, document?: { kind: "vastgrid/document"; version: 2; rowKey?: string }) {
  const store = createGridStore({
    transport,
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

test("grids sharing a worker read and edit their own tables", async ({ onTestFinished }) => {
  const engine = memoryEngine({ tables: { first: table(), second: { ...table(), rows: [[9, "Kyoto", 7]] } } });
  const channel = new MessageChannel();
  const stop = serveEngine(engine, channel.port2 as never);
  const transport = workerTransport(channel.port1 as never);
  const stores = ["first", "second"].map((ref) => createGridStore({ transport, table: ref }));
  const disconnects = stores.map((store) => store.connect());
  onTestFinished(() => {
    for (const disconnect of disconnects) disconnect();
    stop();
    transport.close();
    channel.port1.close();
    channel.port2.close();
  });
  for (const store of stores) store.setViewport({ top: 0, rows: 10, columns: ["id", "city", "qty"] });
  await until(() => stores.every((store) => store.cell(0, "city") !== undefined));
  assert.deepEqual(
    stores.map((store) => store.cell(0, "city")),
    ["Tokyo", "Kyoto"],
  );

  const second = stores[1];
  await second.dispatch({ command: "select", row: 0, column: "city" });
  second.dispatchSync({ command: "edit.begin", text: "Nara" });
  assert.deepEqual(await second.dispatch({ command: "edit.commit", move: null }), { ok: true });
  // A fresh reader checks the engine's data, rather than either grid's optimistic cell cache.
  const readers = ["first", "second"].map((ref) => createGridStore({ transport: localTransport(engine), table: ref }));
  for (const reader of readers) {
    const disconnect = reader.connect();
    onTestFinished(disconnect);
    reader.setViewport({ top: 0, rows: 10, columns: ["city"] });
  }
  await until(() => readers.every((reader) => reader.cell(0, "city") !== undefined));
  assert.deepEqual(
    readers.map((reader) => reader.cell(0, "city")),
    ["Tokyo", "Nara"],
  );
});

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

test("the modifier and Enter write the text into every selected cell, as one step to undo (§6.5.2)", async () => {
  const { store, disconnect } = await editable();
  await store.dispatch({ command: "select", row: 0, column: "city" });
  await store.dispatch({ command: "select", row: 2, column: "city", mode: "extend" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  const committed = store.dispatch({ command: "edit.commit", move: null, cells: "selection" });
  // Before the engine answers, every selected cell shows the text, and the active cell stays.
  assert.equal(store.getSnapshot().session.editor, undefined);
  assert.equal(store.getSnapshot().session.active?.row, 0);
  assert.deepEqual(
    [0, 1, 2].map((row) => store.cell(row, "city")),
    ["Nara", "Nara", "Nara"],
  );
  assert.deepEqual(await committed, { ok: true });
  await until(() => store.getSnapshot().pending === null && store.getSnapshot().session.history?.undo.length === 1);
  assert.equal(store.getSnapshot().session.history?.undo[0].updates.length, 3);
  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(2, "city") === "Kobe");
  assert.deepEqual(
    [0, 1, 2].map((row) => store.cell(row, "city")),
    ["Tokyo", "Osaka", "Kobe"],
  );
  disconnect();
});

test("text that one selected column does not read writes no cell, and names that column", async () => {
  const { store, disconnect } = await editable();
  await store.dispatch({ command: "select", row: 0, column: "city" });
  await store.dispatch({ command: "select", row: 1, column: "qty", mode: "extend" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  const outcome = await store.dispatch({ command: "edit.commit", move: null, cells: "selection" });
  assert.equal(outcome.ok, false);
  const error = outcome.ok ? null : (outcome.error as { reason?: string; details?: { column?: string } });
  assert.equal(error?.reason, "invalid_value");
  assert.equal(error?.details?.column, "qty");
  assert.equal(store.getSnapshot().session.editor?.text, "Nara", "the editor stays");
  assert.equal(store.cell(0, "city"), "Tokyo");
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

test("retrying a conflict overwrites the cell and records a step that can be undone", async ({ onTestFinished }) => {
  const transport = localTransport(memoryEngine({ tables: { cities: table() } }));
  const sent: Parameters<Transport["send"]>[0][] = [];
  const { store, disconnect } = await openStore({
    ...transport,
    send(request, options) {
      if (request.op === "write") {
        sent.push(request);
        if (sent.length === 1) {
          return Promise.resolve({ v: 2, id: request.id, error: { code: "edit_conflict", message: "Try again." } });
        }
      }
      return transport.send(request, options);
    },
  });
  onTestFinished(disconnect);
  await store.dispatch({ command: "select", row: 0, column: "city" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  assert.equal((await store.dispatch({ command: "edit.commit", move: null })).ok, false);
  assert.equal(store.cell(0, "city"), "Tokyo");
  assert.equal(store.getSnapshot().failedWrite?.retry, "overwrite");

  assert.deepEqual(await store.retryWrite(), { ok: true });
  assert.equal(store.getSnapshot().failedWrite, null);
  assert.equal(Object.hasOwn((sent[1].updates as object[])[0], "previous"), false);
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Nara");
  assert.deepEqual(store.getSnapshot().session.history?.undo[0].updates, [
    { key: { rowId: 0 }, column: "city", before: "Tokyo", after: "Nara" },
  ]);
  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Tokyo");
});

test("retrying a failed undo moves its original history step to redo", async ({ onTestFinished }) => {
  const transport = localTransport(memoryEngine({ tables: { cities: table() } }));
  let failNext = false;
  const { store, disconnect } = await openStore({
    ...transport,
    send(request, options) {
      if (request.op === "write" && failNext) {
        failNext = false;
        return Promise.resolve({ v: 2, id: request.id, error: { code: "internal", message: "Try again." } });
      }
      return transport.send(request, options);
    },
  });
  onTestFinished(disconnect);
  await store.dispatch({ command: "select", row: 0, column: "city" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  await store.dispatch({ command: "edit.commit", move: null });
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Nara");
  const step = store.getSnapshot().session.history?.undo[0];
  failNext = true;
  assert.equal((await store.dispatch({ command: "history.undo" })).ok, false);
  assert.equal(store.getSnapshot().failedWrite?.retry, "retry");
  assert.equal(store.getSnapshot().session.history?.undo.length, 1);

  assert.deepEqual(await store.retryWrite(), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Tokyo");
  assert.deepEqual(store.getSnapshot().session.history, { undo: [], redo: [step] });
  assert.deepEqual(await store.dispatch({ command: "history.redo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Nara");
});

test("undo waits for a pending write to be answered and entered in history", async ({ onTestFinished }) => {
  const transport = localTransport(memoryEngine({ tables: { cities: table() } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const { store, disconnect } = await openStore({
    ...transport,
    async send(request, options) {
      if (request.op === "write" && ++writes === 1) await held;
      return transport.send(request, options);
    },
  });
  onTestFinished(disconnect);
  onTestFinished(release);
  await store.dispatch({ command: "select", row: 0, column: "city" });
  store.dispatchSync({ command: "edit.begin", text: "Nara" });
  const committed = store.dispatch({ command: "edit.commit", move: null });
  assert.equal(store.cell(0, "city"), "Nara");
  const undone = store.dispatch({ command: "history.undo" });
  await settle();
  assert.equal(writes, 1);
  assert.equal(store.getSnapshot().session.history, undefined);
  release();
  assert.deepEqual(await committed, { ok: true });
  assert.deepEqual(await undone, { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(0, "city") === "Tokyo");
  assert.equal(writes, 2);
  assert.equal(store.getSnapshot().session.history?.undo.length, 0);
  assert.equal(store.getSnapshot().session.history?.redo.length, 1);
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

test("pasting over a row key and undoing or redoing it targets the same source rows", async () => {
  const { store, disconnect } = await editable({ kind: "vastgrid/document", version: 2, rowKey: "id" });
  try {
    await store.dispatch({ command: "select", row: 0, column: "id" });
    const pasted = store.dispatch({ command: "edit.paste" }, { clipboard: { text: "2\tKyoto\n2\tNara" } });
    const rows = () => [0, 1].map((row) => [store.cell(row, "id"), store.cell(row, "city")]);
    assert.deepEqual(rows(), [
      [2, "Kyoto"],
      [2, "Nara"],
    ]);
    assert.equal((await pasted).ok, true);
    await until(() => store.getSnapshot().pending === null && store.getSnapshot().table?.edits.version === 1);
    assert.deepEqual(rows(), [
      [2, "Kyoto"],
      [2, "Nara"],
    ]);
    assert.equal((await store.dispatch({ command: "history.undo" })).ok, true);
    await until(() => store.getSnapshot().pending === null && store.getSnapshot().table?.edits.version === 2);
    assert.deepEqual(rows(), [
      [1, "Tokyo"],
      [2, "Osaka"],
    ]);
    assert.equal((await store.dispatch({ command: "history.redo" })).ok, true);
    await until(() => store.getSnapshot().pending === null && store.getSnapshot().table?.edits.version === 3);
    assert.deepEqual(rows(), [
      [2, "Kyoto"],
      [2, "Nara"],
    ]);
  } finally {
    disconnect();
  }
});
