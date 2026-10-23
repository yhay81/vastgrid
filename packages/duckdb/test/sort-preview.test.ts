import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SortKey, ViewInfo, ViewQuery } from "vastgrid-core";
import { type OpenTable, TableEngine, type TableEngineOptions } from "../src/engine.ts";
import { createTableHandler } from "../src/handler.ts";

let root: string;
let workspace: string;
const engines: TableEngine[] = [];

const ROWS = 3000;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-preview-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  // Few distinct keys, so that most rows tie and the order of ties decides what the first rows are.
  const lines = ["id,key,label,amount"];
  for (let i = 0; i < ROWS; i++) {
    const label = i % 11 === 0 ? "" : `item-${(i * 7) % 13}`;
    lines.push(`${i},${i % 4},${label},${i % 5 === 0 ? "" : (i * 37) % 101}`);
  }
  await writeFile(path.join(workspace, "ties.csv"), lines.join("\n"));
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const source = path.join(workspace, "ties.csv").replaceAll("'", "''");
    const target = path.join(workspace, "ties.parquet").replaceAll("'", "''");
    await connection.run(`COPY (SELECT * FROM read_csv('${source}')) TO '${target}' (FORMAT parquet)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

after(async () => {
  for (const engine of engines) await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function createEngine(options: Partial<TableEngineOptions> = {}) {
  const engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, `temp-${engines.length}`),
    memoryLimit: "1GB",
    threads: 2,
    viewPreviewMinRows: 0,
    viewPreviewRows: 100,
    ...options,
  });
  engines.push(engine);
  return engine;
}

async function open(engine: TableEngine, name = "ties.csv") {
  const table = await engine.open(path.join(workspace, name));
  await table.whenReady();
  return table;
}

/** Holds both slots for building views and statistics until `release` is called. */
function holdWork(engine: TableEngine) {
  let release = () => {};
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holders = [engine.work.run(() => busy), engine.work.run(() => busy)];
  return async () => {
    release();
    await Promise.all(holders);
  };
}

async function untilReady(table: OpenTable, view: ViewInfo) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = table.viewInfo(view.id);
    if (state.status !== "building") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The view did not finish.");
}

const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected;

const sorts: SortKey[][] = [
  [{ column: 1, direction: "asc" }],
  [{ column: 2, direction: "desc" }],
  [
    { column: 1, direction: "desc" },
    { column: 3, direction: "asc" },
  ],
];

test("a sort answers with its first rows, which are the first rows of the finished view", async () => {
  // Small tables keep every column in their views, large ones only the positions; Parquet files are
  // read in place and give positions of their own.
  for (const materializeRows of [Number.MAX_SAFE_INTEGER, 0]) {
    const plain = await createEngine({ viewPreviewMinRows: Number.MAX_SAFE_INTEGER, materializeRows });
    const engine = await createEngine({ materializeRows });
    for (const file of ["ties.csv", "ties.parquet"]) {
      const reference = await open(plain, file);
      const table = await open(engine, file);
      for (const sort of sorts) {
        for (const query of [{ sort }, { sort, filters: [{ type: "blank" as const, column: 3, blank: false }] }]) {
          const label = `${file}, materializeRows ${materializeRows}, ${JSON.stringify(query)}`;
          const finished = await reference.createView(query, undefined, { preview: true });
          assert.equal(finished.status, "ready", label);
          const release = holdWork(engine);
          const view = await table.createView(query, undefined, { preview: true });
          assert.equal(view.status, "building", label);
          assert.equal(view.readableRows, 100, label);
          assert.equal(view.rowCount, finished.rowCount, label);
          const columns = [0, 1, 2, 3];
          const first = await table.readRows({ view: view.id, start: 0, end: 150, columns });
          assert.equal(first.end, 100, label);
          const expected = await reference.readRows({ view: finished.id, start: 0, end: 100, columns });
          assert.deepEqual(first.columns, expected.columns, label);
          assert.deepEqual(first.rowIds, expected.rowIds, label);
          await release();
          const ready = await untilReady(table, view);
          assert.equal(ready.status, "ready", label);
          assert.equal(ready.readableRows, finished.rowCount, label);
          const all = await table.readRows({ view: view.id, start: 0, end: ROWS, columns });
          const whole = await reference.readRows({ view: finished.id, start: 0, end: ROWS, columns });
          assert.deepEqual(all.columns, whole.columns, label);
          assert.deepEqual(all.rowIds, whole.rowIds, label);
        }
      }
    }
  }
});

test("a view that is building serves its first rows, statistics of its rows, and refuses the rest", async () => {
  const engine = await createEngine();
  const table = await open(engine);
  const release = holdWork(engine);
  const sorted = await table.createView({ sort: [{ column: 3, direction: "desc" }] }, undefined, { preview: true });
  assert.equal(sorted.status, "building");
  // Rows past the first ones are not readable yet.
  await assert.rejects(table.readRows({ view: sorted.id, start: 100, end: 200, columns: [0] }), code("not_ready"));
  assert.equal((await table.readRows({ view: sorted.id, start: 90, end: 200, columns: [0] })).end, 100);
  // A sort keeps the rows of the table: their statistics and values are known already.
  const statsWhileBuilding = table.columnStats(sorted.id, 3);
  const distinct = table.distinctValues({ view: sorted.id, column: 1 });
  // A summary of the first rows works; one that reaches further waits for the view.
  const summary = table.aggregate({ view: sorted.id, ranges: [{ start: 0, end: 100, columns: [3] }] });
  await assert.rejects(
    table.aggregate({ view: sorted.id, ranges: [{ start: 0, end: 101, columns: [3] }] }),
    code("not_ready"),
  );
  // Find and export walk the whole view.
  await assert.rejects(
    table.find({ view: sorted.id, text: "item", columns: [2], row: 0, column: 0, direction: 1 }),
    code("not_ready"),
  );
  await assert.rejects(
    table.exportView({ view: sorted.id, format: "csv", target: "x.csv" }, path.join(workspace, "x.csv")),
    code("not_ready"),
  );
  // A filtered view has other rows than the table: its statistics wait for it.
  const filtered = await table.createView(
    { sort: [{ column: 1, direction: "asc" }], filters: [{ type: "compare", column: 3, op: "gt", value: 50 }] },
    undefined,
    { preview: true },
  );
  assert.equal(filtered.status, "building");
  assert.ok(filtered.rowCount > 100 && filtered.rowCount < ROWS);
  await assert.rejects(table.columnStats(filtered.id, 3), code("not_ready"));
  // Requests that do not accept a preview wait until the view is ready.
  const waiting = table.createView({ sort: [{ column: 3, direction: "desc" }] });
  await release();
  assert.equal((await statsWhileBuilding).rows, ROWS);
  assert.equal((await distinct).values.length, 4);
  assert.equal(
    (await summary).count,
    (await table.readRows({ view: sorted.id, start: 0, end: 100, columns: [3] })).columns[0].filter(
      (value) => value !== null,
    ).length,
  );
  const complete = await waiting;
  assert.equal(complete.id, sorted.id);
  assert.equal(complete.status, "ready");
  assert.equal(complete.readableRows, ROWS);
  const found = await table.find({ view: sorted.id, text: "item", columns: [2], row: 0, column: 0, direction: 1 });
  assert.ok(found);
  assert.equal((await untilReady(table, filtered)).status, "ready");
  assert.equal((await table.columnStats(filtered.id, 3)).rows, filtered.rowCount);
});

test("small tables and filters without a sort build the whole view first", async () => {
  const engine = await createEngine({ viewPreviewMinRows: ROWS + 1 });
  const table = await open(engine);
  const sorted = await table.createView({ sort: [{ column: 1, direction: "asc" }] }, undefined, { preview: true });
  assert.equal(sorted.status, "ready");
  const large = await createEngine();
  const other = await open(large);
  const filtered = await other.createView({ filters: [{ type: "blank", column: 2, blank: false }] }, undefined, {
    preview: true,
  });
  assert.equal(filtered.status, "ready");
  // A sort whose rows all fit in the preview is ready at once.
  const few = await other.createView(
    { sort: [{ column: 0, direction: "desc" }], filters: [{ type: "compare", column: 0, op: "lt", value: 50 }] },
    undefined,
    { preview: true },
  );
  assert.equal(few.status, "ready");
  assert.equal(few.rowCount, 50);
});

test("builds that nobody follows stop when another view waits, and starting over gives the same rows", async () => {
  const engine = await createEngine({ abandonedViewTimeout: 40 });
  const table = await open(engine);
  const release = holdWork(engine);
  const ascending = { sort: [{ column: 2, direction: "asc" as const }] };
  const old = await table.createView(ascending, undefined, { preview: true });
  const followed = await table.createView({ sort: [{ column: 2, direction: "desc" }] }, undefined, { preview: true });
  const first = await table.readRows({ view: old.id, start: 0, end: 100, columns: [0] });
  // Only the second view is polled while both wait for their turn.
  for (let tick = 0; tick < 8; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(table.viewInfo(followed.id).status, "building");
  }
  await release();
  assert.equal((await untilReady(table, followed)).status, "ready");
  assert.throws(() => table.viewInfo(old.id), code("view_not_found"));
  // Asking again starts over, with the same first rows.
  const again = await table.createView(ascending, undefined, { preview: true });
  assert.notEqual(again.id, old.id);
  const rows = await table.readRows({ view: again.id, start: 0, end: 100, columns: [0] });
  assert.deepEqual(rows.columns, first.columns);
  assert.equal((await untilReady(table, again)).status, "ready");
});

test("several clients share a preview, keep their own views apart, and cancel only their own request", async () => {
  const engine = await createEngine({ maxViews: 2 });
  const table = await open(engine);
  const release = holdWork(engine);
  const query: ViewQuery = { sort: [{ column: 1, direction: "desc" }] };
  // Two people ask for the same sort at once; one of them gives up.
  const leaving = new AbortController();
  const [left, stayed] = await Promise.allSettled([
    table.createView(query, leaving.signal, { preview: true }),
    table.createView(query, undefined, { preview: true }),
    Promise.resolve().then(() => leaving.abort()),
  ]);
  assert.equal(left.status, "rejected");
  assert.equal(stayed.status, "fulfilled");
  const shared = (stayed as PromiseFulfilledResult<ViewInfo>).value;
  assert.equal(shared.status, "building");
  // Another person sorts differently: their rows are their own.
  const other = await table.createView({ sort: [{ column: 0, direction: "desc" }] }, undefined, { preview: true });
  assert.notEqual(other.id, shared.id);
  const theirs = await table.readRows({ view: other.id, start: 0, end: 3, columns: [0] });
  assert.deepEqual(theirs.columns[0], [ROWS - 1, ROWS - 2, ROWS - 3]);
  const mine = await table.readRows({ view: shared.id, start: 0, end: 3, columns: [1] });
  assert.deepEqual(mine.columns[0], [3, 3, 3]);
  // A third view pushes out the least recently used one, also while it is building.
  table.viewInfo(other.id);
  await table.createView({ sort: [{ column: 3, direction: "asc" }] }, undefined, { preview: true });
  assert.throws(() => table.viewInfo(shared.id), code("view_not_found"));
  await release();
  assert.equal((await untilReady(table, other)).status, "ready");
  assert.deepEqual((await table.readRows({ view: other.id, start: 0, end: 3, columns: [0] })).columns, theirs.columns);
});

test("the HTTP handler answers previews and the status of views", async () => {
  const engine = await createEngine();
  const handler = createTableHandler({ engine, resolve: (ref) => path.join(workspace, ref) });
  const post = async (body: unknown) => {
    const response = await handler(new Request("http://local/api", { method: "POST", body: JSON.stringify(body) }));
    return {
      status: response.status,
      body: (await response.json()) as { result?: Record<string, unknown>; error?: { code: string } },
    };
  };
  const handle = (await post({ op: "info", ref: "ties.csv" })).body.result?.table as string;
  await engine.get(handle).whenReady();
  const release = holdWork(engine);
  const query = { sort: [{ column: 2, direction: "asc" }] };
  const view = (await post({ op: "view", table: handle, query, preview: true })).body.result;
  assert.equal(view?.status, "building");
  assert.equal(view?.readableRows, 100);
  const rows = await post({ op: "rows", table: handle, view: view?.id, start: 100, end: 110, columns: [0] });
  assert.equal(rows.status, 409);
  assert.equal(rows.body.error?.code, "not_ready");
  assert.equal((await post({ op: "status", table: handle, view: view?.id })).body.result?.status, "building");
  assert.equal((await post({ op: "view", table: handle, query, preview: "yes" })).status, 400);
  // A request without `preview` waits for the view.
  const waiting = post({ op: "view", table: handle, query });
  await release();
  const ready = (await waiting).body.result;
  assert.equal(ready?.id, view?.id);
  assert.equal(ready?.status, "ready");
  assert.equal((await post({ op: "status", table: handle, view: view?.id })).body.result?.readableRows, ROWS);
  assert.equal((await post({ op: "status", table: handle, view: "v-missing" })).body.error?.code, "view_not_found");
});

test("a build that fails reports its error, and asking again builds the view again", async () => {
  const engine = await createEngine();
  const table = await open(engine);
  const internals = table as unknown as { materialize: (...args: unknown[]) => Promise<unknown> };
  const materialize = internals.materialize;
  internals.materialize = async () => {
    throw new Error("No space left on device");
  };
  const query: ViewQuery = { sort: [{ column: 2, direction: "desc" }] };
  const view = await table.createView(query, undefined, { preview: true });
  const failed = await untilReady(table, view);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /No space left/);
  // The first rows stay readable.
  assert.equal((await table.readRows({ view: view.id, start: 0, end: 10, columns: [0] })).end, 10);
  internals.materialize = materialize;
  const again = await table.createView(query, undefined, { preview: true });
  assert.notEqual(again.id, view.id);
  assert.equal((await untilReady(table, again)).status, "ready");
});
