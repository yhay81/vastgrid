import assert from "node:assert/strict";
import { expect, test } from "vite-plus/test";
import { memoryEngine } from "vastgrid-js";
import { decodeBlock, type GridSession } from "vastgrid-spec";
import { Geometry } from "../src/canvas/geometry.ts";
import { ColumnLayout } from "../src/canvas/layout.ts";
import { ScrollAxis } from "../src/canvas/scroll.ts";
import { TextFitter } from "../src/canvas/text.ts";
import { ViewCache } from "../src/core/cache.ts";
import {
  createGridStore,
  GridClient,
  GridError,
  httpTransport,
  localTransport,
  serveEngine,
  type WorkerLike,
  workerTransport,
} from "../src/core.ts";
import { readInitialView } from "../src/server.ts";

test("readInitialView supports pivot plans, grouped rowKey omission, keyless 0-row aggregates, and rows <= 0", async () => {
  const engine = memoryEngine({
    tables: {
      sales: {
        columns: [
          { name: "id", type: "integer" },
          { name: "region", type: "string" },
          { name: "quarter", type: "string" },
          { name: "amount", type: "integer" },
        ],
        rows: [
          [1, "East", "Q1", 10],
          [2, "West", "Q2", 25],
        ],
      },
      empty: {
        columns: [
          { name: "id", type: "integer" },
          { name: "amount", type: "integer" },
        ],
        rows: [],
      },
    },
  });
  const transport = localTransport(engine);

  const pivoted = await readInitialView(transport, {
    table: "sales",
    document: {
      kind: "vastgrid/document",
      version: 2,
      rowKey: "id",
      plan: {
        aggregate: {
          keys: ["region"],
          pivot: { columns: ["quarter"] },
          measures: [{ name: "total", fn: "sum", column: "amount" }],
        },
      },
    },
    rows: 10,
  });
  assert.equal(pivoted.rows.view.rowCount, 2);
  const pivotedBlock = decodeBlock(pivoted.rows.block.bytes);
  assert.deepEqual(
    pivotedBlock.columns.map((column) => column.name),
    ["region", "Q1 / total", "Q2 / total"],
  );

  const zeroRows = await readInitialView(transport, { table: "sales", rows: 0 });
  assert.equal(decodeBlock(zeroRows.rows.block.bytes).rows.length, 0);

  const emptyAgg = await readInitialView(transport, {
    table: "empty",
    document: {
      kind: "vastgrid/document",
      version: 2,
      plan: {
        aggregate: {
          keys: [],
          measures: [{ name: "n", fn: "count" }],
        },
      },
    },
    rows: 10,
  });
  assert.equal(emptyAgg.rows.view.rowCount, 1);
  assert.deepEqual(decodeBlock(emptyAgg.rows.block.bytes).rows, [[0]]);
});

test("Geometry returns none in empty space past the last column and hits both sides of resize borders", () => {
  const geometry = new Geometry();
  geometry.width = 548;
  geometry.height = 200;
  geometry.layout = new ColumnLayout([100, 100]);
  geometry.rowCount = 5;
  geometry.scrollX.resize(200, 500);
  geometry.scrollY.resize(120, 168);

  // Past the second column (48 + 200 = 248): empty space is not the last column.
  assert.equal(geometry.columnAt(300), -1);
  assert.equal(geometry.hit(300, 60).area, "none");
  assert.equal(geometry.hit(300, 12).area, "none");

  // Both sides (±4px) of column 0's right border at x = 148 resize column 0.
  assert.deepEqual(geometry.hit(145, 12), { area: "header", row: 0, column: 0, edge: true, menu: false });
  assert.deepEqual(geometry.hit(151, 12), { area: "header", row: 0, column: 0, edge: true, menu: false });

  // +3px into empty space past the rightmost column's border at x = 248 still resizes column 1.
  assert.deepEqual(geometry.hit(251, 12), { area: "header", row: 0, column: 1, edge: true, menu: false });
});

test("TextFitter never splits a surrogate pair when truncating long strings", () => {
  const fitter = new TextFitter(
    {
      measureText: (text: string) => ({ width: [...text].length * 8 }),
    } as unknown as CanvasRenderingContext2D,
    "13px sans-serif",
  );
  // 399 ASCII characters followed by a 2-code-unit emoji at index 399..400.
  const long = `${"a".repeat(399)}😀${"b".repeat(50)}`;
  const fitted = fitter.fit(long, 3_000);
  for (let i = 0; i < fitted.length; i++) {
    const code = fitted.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = fitted.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "high surrogate must be paired");
      i++;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, "no lone low surrogate");
    }
  }
});

test("workerTransport.close settles in-flight requests, and httpTransport wraps non-JSON HTTP errors", async () => {
  const port: WorkerLike = {
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const transport = workerTransport(port);
  const client = new GridClient(transport);
  const pending = client.request("open", { ref: "items" });
  transport.close();
  await assert.rejects(pending, (error: unknown) => error instanceof GridError && error.code === "cancelled");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
  try {
    const http = new GridClient(httpTransport("http://localhost:9999"));
    await assert.rejects(
      http.request("open", { ref: "items" }),
      (error: unknown) => error instanceof GridError && error.code === "internal" && /502/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setDocument fits session.active when hiding the active column on the current view", async () => {
  const engine = memoryEngine({
    tables: {
      items: {
        columns: [
          { name: "a", type: "integer" },
          { name: "b", type: "integer" },
        ],
        rows: [
          [1, 2],
          [3, 4],
        ],
      },
    },
  });
  const store = createGridStore({
    transport: localTransport(engine),
    table: "items",
    session: { kind: "vastgrid/session", version: 2, active: { row: 0, column: "a" } },
  });
  const disconnect = store.connect();
  try {
    await expect.poll(() => store.getSnapshot().view?.status).toBe("ready");
    assert.equal(store.getSnapshot().session.active?.column, "a");
    store.setDocument({ kind: "vastgrid/document", version: 2, columns: [{ name: "a", hidden: true }] });
    assert.equal(store.getSnapshot().session.active?.column, "b");
  } finally {
    disconnect();
  }
});

test("ViewCache tracks per-column loaded lengths, does not fabricate null for unread cells, and clears stale cut flags", () => {
  const cache = new ViewCache();
  cache.receive(
    0,
    Array.from({ length: 100 }, (_, i) => i),
    ["a"],
    Array.from({ length: 100 }, (_, i) => [i]),
    { a: [5] },
  );
  cache.receive(
    0,
    Array.from({ length: 256 }, (_, i) => i),
    ["b"],
    Array.from({ length: 256 }, (_, i) => [i * 10]),
    undefined,
  );

  // Column "a" was only read for rows 0..100, so rows 100..256 are still unread and must be scheduled.
  assert.equal(cache.value(150, "a"), undefined);
  assert.equal(cache.loaded(150, undefined)?.has("a"), false);
  assert.deepEqual(cache.reads(0, 256, ["a", "b"], 256), [{ start: 0, end: 256, columns: ["a"] }]);

  // Re-reading row 5 without truncation clears its previous cut flag.
  assert.equal(cache.isCut(5, "a"), true);
  cache.receive(
    0,
    Array.from({ length: 256 }, (_, i) => i),
    ["a"],
    Array.from({ length: 256 }, (_, i) => [i]),
    undefined,
  );
  assert.equal(cache.isCut(5, "a"), false);
  assert.equal(cache.loaded(150, undefined)?.has("a"), true);
  assert.deepEqual(cache.reads(0, 256, ["a", "b"], 256), []);
});

test("setDocument reconciles controlled sessions and updates rowKey without wiping active cell", async () => {
  const engine = memoryEngine({
    tables: {
      items: {
        columns: [
          { name: "id", type: "integer" },
          { name: "name", type: "string" },
        ],
        rows: [
          [10, "Alpha"],
          [20, "Beta"],
        ],
      },
    },
  });
  const store = createGridStore({
    transport: localTransport(engine),
    table: "items",
    session: { kind: "vastgrid/session", version: 2, active: { row: 1, column: "id" } },
  });
  store.control("session", true);
  const reported: GridSession[] = [];
  store.on("session", (next) => reported.push(next));
  const disconnect = store.connect();
  try {
    await expect.poll(() => store.getSnapshot().view?.status).toBe("ready");
    store.ensure(0, 2, ["id", "name"]);
    await expect.poll(() => store.cell(1, "id")).toBe(20);

    // Changing rowKey and hiding column "id" emits the reconciled controlled session and updates currentSession().
    store.setDocument({
      kind: "vastgrid/document",
      version: 2,
      rowKey: "id",
      columns: [{ name: "id", hidden: true }],
    });
    assert.equal(store.currentSession().active?.row, 1);
    assert.equal(store.currentSession().active?.column, "name");
    assert.deepEqual(store.currentSession().active?.key, { value: 20 });
    assert.equal(reported.at(-1)?.active?.column, "name");
  } finally {
    disconnect();
  }
});

test("ScrollAxis does not warp to 0 or virtualRange on small steps at native edges and recenters runway", () => {
  const axis = new ScrollAxis(8_000_000);
  axis.resize(24_000_000_000, 600);
  const native = axis.scrollTo(50_000);
  assert.equal(axis.onNativeScroll(native), 50_000);

  // Small wheel steps upward hit native === 0 while virtual is still > 0; must not warp to row 0.
  let currentNative = native;
  while (currentNative > 0) {
    currentNative = Math.max(0, currentNative - 200);
    axis.onNativeScroll(currentNative);
  }
  assert.equal(axis.native, 0);
  assert.ok(axis.position > 40_000);
  assert.equal(axis.pinnedAtEdge, true);

  const recentered = axis.recenter();
  assert.ok(recentered > 0);
  assert.equal(axis.pinnedAtEdge, false);
});

test("serveEngine avoids detaching subarray buffers and answers internal errors on unexpected rejections", async () => {
  const shared = new Uint8Array([10, 20, 30, 40]);
  const subarray = shared.subarray(1, 3);
  const posted: { message: unknown; transfer: Transferable[] | undefined }[] = [];
  let handler: ((event: MessageEvent) => void) | undefined;
  const scope: WorkerLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
    },
    addEventListener(_type, listener) {
      handler = listener;
    },
    removeEventListener() {},
  };
  const stop = serveEngine(
    {
      async handle(message) {
        const req = message as { id: number; op: string };
        if (req.op === "boom") throw new Error("kaboom");
        return { v: 2, id: req.id, result: { block: { bytes: subarray } } };
      },
    },
    scope,
  );
  try {
    handler?.({ data: { v: 2, id: 1, op: "rows" } } as MessageEvent);
    await expect.poll(() => posted.length).toBe(1);
    assert.deepEqual(posted[0].transfer, []);
    assert.equal(shared.byteLength, 4);

    handler?.({ data: { v: 2, id: 2, op: "boom" } } as MessageEvent);
    await expect.poll(() => posted.length).toBe(2);
    assert.deepEqual(posted[1].message, { v: 2, id: 2, error: { code: "internal", message: "kaboom" } });
  } finally {
    stop();
  }
});

test("ensure called before connect is replayed once open, and TotalsReader recovers after transient failure", async () => {
  const engine = memoryEngine({
    tables: {
      items: {
        columns: [
          { name: "id", type: "integer" },
          { name: "val", type: "integer" },
        ],
        rows: [
          [1, 10],
          [2, 20],
        ],
      },
    },
  });
  let failTotals = true;
  const flaky = {
    ...engine,
    async handle(message: unknown) {
      const req = message as { id: number; op: string; plan?: { aggregate?: unknown } };
      if (failTotals && req.op === "rows" && req.plan?.aggregate) {
        return { v: 2, id: req.id, error: { code: "internal", message: "transient" } };
      }
      return engine.handle(message);
    },
  };
  const doc = {
    kind: "vastgrid/document" as const,
    version: 2 as const,
    columns: [{ name: "val", total: { fn: "sum" as const } }],
  };
  const store = createGridStore({ transport: localTransport(flaky), table: "items", document: doc });
  // Calling ensure before connect queues the read and replays it once the view opens.
  store.ensure(0, 2, ["val"]);
  const disconnect = store.connect();
  try {
    await expect.poll(() => store.cell(1, "val")).toBe(20);
    await expect.poll(() => store.getSnapshot().error?.message).toBe("transient");

    failTotals = false;
    store.setDocument({ ...doc });
    await expect.poll(() => store.getSnapshot().totals?.values.val).toBe("30");
    assert.equal(store.getSnapshot().error, null);
  } finally {
    disconnect();
  }
});
