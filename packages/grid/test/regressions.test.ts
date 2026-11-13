import assert from "node:assert/strict";
import { expect, test } from "vite-plus/test";
import { memoryEngine } from "vastgrid-js";
import { decodeBlock } from "vastgrid-spec";
import { Geometry } from "../src/canvas/geometry.ts";
import { ColumnLayout } from "../src/canvas/layout.ts";
import { TextFitter } from "../src/canvas/text.ts";
import {
  createGridStore,
  GridClient,
  GridError,
  httpTransport,
  localTransport,
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
