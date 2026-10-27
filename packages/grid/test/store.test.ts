import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBlock, encodeBlock, type GridDocument, type GridSession } from "vastgrid-spec";
import type { RowsResult } from "../src/core/types.js";
import { createGridStore, type GridStore, localTransport } from "../src/core.ts";
import { CAPABILITIES, fakeEngine, numbers, settle } from "./fake-engine.ts";

/** A store over the fake engine, connected, with a viewport of 20 rows of every column. */
async function ready(count = 1_000, options: { document?: GridDocument; session?: GridSession } = {}) {
  const engine = fakeEngine(numbers(count));
  const store = createGridStore({ transport: localTransport(engine), table: "numbers", ...options });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name", "score"] });
  await until(store, (snapshot) => snapshot.view !== null);
  await settle();
  return { engine, store, disconnect };
}

async function until(store: GridStore, done: (snapshot: ReturnType<GridStore["getSnapshot"]>) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (done(store.getSnapshot())) return;
    await settle(1);
  }
  throw new Error(`The store did not get there: ${JSON.stringify(store.getSnapshot().status)}`);
}

test("making a store has no side effects; connecting opens the table and reads the rows on screen", async () => {
  const engine = fakeEngine(numbers(1_000));
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  await settle();
  assert.equal(engine.requests.length, 0);
  assert.equal(store.getSnapshot().status, "idle");
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
  await until(store, (snapshot) => snapshot.view !== null);
  await settle();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.view?.rowCount, 1_000);
  assert.deepEqual(
    snapshot.displayed.map((item) => item.column.name),
    ["id", "name", "score"],
  );
  assert.equal(store.cell(5, "name"), "name 5");
  assert.equal(store.rowId(5), 5);
  disconnect();
  await settle();
  assert.equal(engine.open.size, 0, "disconnecting closes the table");
});

test("connecting again after disconnecting works, as Strict Mode does it", async () => {
  const engine = fakeEngine(numbers(100));
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  const first = store.connect();
  first();
  const second = store.connect();
  await until(store, (snapshot) => snapshot.view !== null);
  await settle();
  assert.equal(engine.open.size, 1, "one table stays open");
  assert.equal(store.getSnapshot().status, "ready");
  second();
  await settle();
  assert.equal(engine.open.size, 0);
});

test("connecting again after the table opened reads the view again, and closes the first table", async () => {
  const engine = fakeEngine(numbers(100));
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  const first = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
  await until(store, (snapshot) => snapshot.view !== null);
  await settle();
  first();
  const second = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
  await until(store, (snapshot) => snapshot.status === "ready" && store.cell(5, "name") !== undefined);
  await settle();
  assert.equal(engine.open.size, 1, "one table stays open");
  assert.equal(store.cell(5, "name"), "name 5");
  await store.dispatch({ command: "sort.set", keys: [{ column: "id", direction: "desc" }] });
  await until(store, () => store.cell(0, "id") === 99);
  second();
  await settle();
  assert.equal(engine.open.size, 0);
});

test("connecting twice keeps the rows read on a server, as Strict Mode does with `initial`", async () => {
  const { readInitialView } = await import("../src/server.ts");
  const reads = async (twice: boolean) => {
    const engine = fakeEngine(numbers(300));
    const transport = localTransport(engine);
    const initial = await readInitialView(transport, { table: "numbers", rows: 50 });
    const store = createGridStore({ transport, table: "numbers", initial });
    const before = engine.requests.length;
    if (twice) store.connect()();
    const disconnect = store.connect();
    assert.equal(store.cell(10, "name"), "name 10", "the rows stay while the table opens");
    store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
    await until(store, (snapshot) => snapshot.status === "ready");
    await settle(5);
    assert.equal(store.cell(10, "name"), "name 10");
    assert.equal(engine.open.size, 1, "one table stays open");
    disconnect();
    await settle();
    assert.equal(engine.open.size, 0);
    return engine.requests
      .slice(before)
      .filter((request) => request.op === "rows")
      .map(({ start, end, columns }) => ({ start, end, columns }));
  };
  assert.deepEqual(await reads(true), await reads(false), "the rows are read as after one connection");
});

test("a command changes the snapshot at once and keeps what it does not change", async () => {
  const { store, disconnect } = await ready();
  const before = store.getSnapshot();
  let notified = 0;
  const stop = store.subscribe(() => notified++);
  const done = store.dispatch({ command: "move", direction: "down" });
  // Before the promise resolves: a key press shows in the same frame.
  const after = store.getSnapshot();
  assert.equal(notified, 1);
  assert.equal(after.document, before.document);
  assert.deepEqual(after.session.active, { row: 1, column: "id", key: { rowId: 1 } });
  assert.equal(after.displayed, before.displayed);
  assert.deepEqual(await done, { ok: true });
  stop();
  disconnect();
});

test("a sort keeps the view on screen until the first rows of the new one arrive, and moves the active row", async () => {
  const { engine, store, disconnect } = await ready(100);
  await store.dispatch({ command: "select", row: 10, column: "name" });
  const shown = store.getSnapshot().view;
  engine.hold();
  void store.dispatch({ command: "sort.toggle", column: "id" });
  void store.dispatch({ command: "sort.toggle", column: "id" });
  await settle(5);
  let snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.document.plan, { sort: [{ column: "id", direction: "desc" }] });
  assert.deepEqual(snapshot.pending, { plan: { sort: [{ column: "id", direction: "desc" }] } });
  assert.equal(snapshot.view, shown, "the old view stays on screen");
  assert.equal(store.cell(10, "name"), "name 10");
  engine.release();
  await until(store, (current) => current.pending === null);
  snapshot = store.getSnapshot();
  assert.notEqual(snapshot.view?.hash, shown?.hash);
  // Row ID 10 is at position 89 of the descending view (§5.4).
  assert.deepEqual(snapshot.session.active, { row: 89, column: "name", key: { rowId: 10 } });
  assert.equal(snapshot.session.view, snapshot.view?.hash);
  assert.equal(store.cell(0, "id"), 99);
  // The first sort's read was cancelled by the second (§8.6).
  assert.ok(engine.requests.some((request) => request.op === "cancel"));
  disconnect();
});

test("a controlled document is reported, and shown once the host passes it back", async () => {
  const { store, disconnect } = await ready(50);
  const reported: GridDocument[] = [];
  store.control("document", true);
  const stop = store.on("document", (document) => reported.push(document));
  await store.dispatch({ command: "sort.toggle", column: "score" });
  await store.dispatch({ command: "sort.toggle", column: "score" });
  assert.equal(store.getSnapshot().document.plan, undefined, "the grid shows the prop");
  assert.deepEqual(
    reported.map((document) => document.plan),
    [{ sort: [{ column: "score", direction: "asc" }] }, { sort: [{ column: "score", direction: "desc" }] }],
    "the second command applies to what the first reported",
  );
  store.setDocument(reported[1]);
  assert.equal(store.getSnapshot().document, reported[1]);
  await until(store, (snapshot) => snapshot.pending === null && snapshot.view?.hash === snapshot.session.view);
  stop();
  disconnect();
});

test("a command that needs rows that are not read reads them first", async () => {
  const { store, disconnect } = await ready(2_000);
  await store.dispatch({ command: "select.rows", from: 1_500, to: 1_510 });
  assert.equal(store.cell(1_505, "name"), undefined);
  const sync = store.dispatchSync({ command: "copy" });
  assert.equal(sync.ok, false);
  const outcome = await store.dispatch({ command: "copy" });
  assert.ok(outcome.ok);
  const { tsv } = outcome.output as { tsv: string };
  assert.equal(tsv.split("\n").length, 11);
  assert.ok(tsv.startsWith("1500\tname 1500\t"));
  disconnect();
});

test("commands before the table is open fail with not_ready and change nothing", async () => {
  const store = createGridStore({ transport: localTransport(fakeEngine(numbers(3))), table: "numbers" });
  const before = store.getSnapshot();
  const outcome = await store.dispatch({ command: "move", direction: "down" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? "" : outcome.error.code, "not_ready");
  assert.equal(store.getSnapshot(), before);
});

test("rows read on a server are shown before the table is open", async () => {
  const { store: server, disconnect } = await ready(300);
  const snapshot = server.getSnapshot();
  disconnect();
  const engine = fakeEngine(numbers(300));
  const transport = localTransport(engine);
  const { readInitialView } = await import("../src/server.ts");
  const initial = await readInitialView(transport, { table: "numbers", rows: 50 });
  assert.equal(engine.open.size, 0, "reading the initial view closes the table");
  const store = createGridStore({ transport, table: "numbers", initial });
  assert.equal(store.getSnapshot().view?.rowCount, snapshot.view?.rowCount);
  assert.equal(store.cell(49, "name"), "name 49");
  assert.equal(store.cell(50, "name"), undefined);
  const connected = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
  await until(store, (current) => current.status === "ready");
  await settle(5);
  // The rows of the same revision stay: nothing is read again for them.
  assert.equal(store.cell(10, "name"), "name 10");
  connected();
});

test("an event of another edits version reads the view again and keeps the session", async () => {
  const { engine, store, disconnect } = await ready(40);
  await store.dispatch({ command: "select", row: 3, column: "score" });
  const table = store.getSnapshot().table;
  const before = store.getSnapshot().session;
  engine.send({ v: 2, event: "changed", table: table?.table, revision: "r1", edits: { version: 1, cells: 1 } });
  await settle(10);
  assert.equal(store.getSnapshot().table?.edits.version, 1);
  assert.deepEqual(store.getSnapshot().session.active, before.active);
  disconnect();
});

test("a preview is displayed before completion, and a normal read finishes it without an event channel", async () => {
  const engine = fakeEngine(numbers(1000), { ...CAPABILITIES, preview: true });
  const original = engine.handle.bind(engine);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  engine.handle = async (message, options) => {
    const request = message as Record<string, unknown>;
    if (request.op === "rows" && (request.plan as { sort?: unknown }).sort) {
      if (!request.preview) await done;
      const answer = (await original(message, options)) as { result: RowsResult };
      if (request.preview) {
        const result = answer.result;
        const decoded = decodeBlock(result.block.bytes);
        result.view = { ...result.view, status: "building", readableRows: 3 };
        result.end = 3;
        result.rowIds = result.rowIds?.slice(0, 3) ?? null;
        result.block = { bytes: encodeBlock(decoded.columns, decoded.rows.slice(0, 3)) };
      }
      return answer;
    }
    return original(message, options);
  };
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name"] });
  await until(store, (snapshot) => snapshot.view !== null);
  store.setDocument({ plan: { sort: [{ column: "id", direction: "desc" }] } });
  await until(store, (snapshot) => snapshot.view?.status === "building");
  assert.equal(store.cell(0, "id"), 999);
  assert.equal(store.cell(2, "id"), 997);
  assert.equal(store.getSnapshot().view?.rowCount, 1000);
  const reads = engine.requests.filter((request) => request.op === "rows").length;
  await settle(10);
  assert.equal(
    engine.requests.filter((request) => request.op === "rows").length,
    reads,
    "no loop rereading a short preview",
  );
  finish();
  await until(store, (snapshot) => snapshot.view?.status === "ready");
  store.setViewport({ top: 600, rows: 20, columns: ["id", "name"] });
  await until(store, () => store.cell(600, "id") !== undefined);
  assert.equal(store.cell(600, "id"), 399);
  disconnect();
});

test("switching a building view cancels its completion read and ignores a late answer", async () => {
  const engine = fakeEngine(numbers(1000), { ...CAPABILITIES, preview: true });
  const original = engine.handle.bind(engine);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  engine.handle = async (message, options) => {
    const request = message as Record<string, unknown>;
    const descending = (request.plan as { sort?: { direction: string }[] })?.sort?.[0]?.direction === "desc";
    if (request.op === "rows" && descending && !request.preview) await done;
    const answer = (await original(message, options)) as { result: RowsResult };
    if (request.op === "rows" && descending && request.preview)
      answer.result.view = { ...answer.result.view, status: "building" };
    return answer;
  };
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id"] });
  await until(store, (snapshot) => snapshot.view !== null);
  store.setDocument({ plan: { sort: [{ column: "id", direction: "desc" }] } });
  await until(store, (snapshot) => snapshot.view?.status === "building");
  store.setDocument({ plan: { sort: [{ column: "id", direction: "asc" }] } });
  await until(store, (snapshot) => snapshot.view?.status === "ready" && snapshot.pending === null);
  const hash = store.getSnapshot().view?.hash;
  assert.equal(store.cell(0, "id"), 0);
  assert.ok(engine.requests.some((request) => request.op === "cancel"));
  finish();
  await settle(10);
  assert.equal(store.getSnapshot().view?.hash, hash);
  assert.equal(store.cell(0, "id"), 0);
  disconnect();
});

test("a plan chosen while the table loads waits until ready when partialViews is false", async () => {
  const engine = fakeEngine(numbers(100));
  const original = engine.handle.bind(engine);
  let loading = true;
  engine.handle = async (message, options) => {
    const request = message as Record<string, unknown>;
    const answer = (await original(message, options)) as { result: Record<string, unknown> };
    if (loading && (request.op === "open" || request.op === "info"))
      answer.result = { ...answer.result, status: "loading", rowCount: null };
    if (loading && request.op === "rows") {
      const result = answer.result as unknown as RowsResult;
      result.view = { ...result.view, status: "building", rowCountExact: false };
    }
    return answer;
  };
  const store = createGridStore({ transport: localTransport(engine), table: "numbers" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id"] });
  await until(store, (snapshot) => snapshot.view !== null);
  store.setDocument({ plan: { sort: [{ column: "id", direction: "desc" }] } });
  await settle(5);
  assert.ok(store.getSnapshot().pending);
  assert.ok(!engine.requests.some((request) => request.op === "rows" && (request.plan as { sort?: unknown }).sort));
  loading = false;
  engine.send({
    v: 2,
    event: "progress",
    table: [...engine.open][0],
    status: "ready",
    progress: 1,
    readableRows: 100,
    rowCount: 100,
  });
  await until(store, (snapshot) => snapshot.view?.status === "ready" && snapshot.pending === null);
  assert.equal(store.cell(0, "id"), 99);
  assert.equal(store.getSnapshot().error, null);
  disconnect();
});

test("a view that fails to read keeps the one on screen with the failure, until a view comes", async () => {
  const engine = fakeEngine(numbers(100));
  const failing = {
    ...engine,
    async handle(message: unknown) {
      const request = message as { id: number; op: string; plan?: { sort?: { direction: string }[] } };
      if (request.op === "rows" && request.plan?.sort?.[0]?.direction === "desc") {
        return { v: 2, id: request.id, error: { code: "too_many_columns", message: "Too many." } };
      }
      return engine.handle(message);
    },
  };
  const store = createGridStore({ transport: localTransport(failing), table: "numbers" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id"] });
  await until(store, (snapshot) => snapshot.view !== null);
  const shown = store.getSnapshot().view;
  await store.dispatch({ command: "sort.set", keys: [{ column: "id", direction: "desc" }] });
  await until(store, (snapshot) => snapshot.error !== null);
  assert.equal(store.getSnapshot().error?.code, "too_many_columns");
  assert.equal(store.getSnapshot().view, shown);
  assert.equal(store.getSnapshot().pending, null);
  await store.dispatch({ command: "sort.set", keys: [{ column: "id", direction: "asc" }] });
  await until(store, (snapshot) => snapshot.view !== shown);
  assert.equal(store.getSnapshot().error, null);
  disconnect();
});
