/**
 * The grids of an MCP server (docs/mcp-app.md) on an engine that holds requests: the requests of the Apps and of the
 * agent that share a grid, each with ids of its own.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBEngine } from "vastgrid-duckdb";
import { type GridEngine, Grids } from "../src/index.ts";

type Json = Record<string, unknown>;

let folder: string;
let file: string;
let duckdb: DuckDBEngine;

before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "vastgrid-mcp-grids-"));
  file = path.join(folder, "orders.csv");
  await writeFile(file, "id,region,price\n1,EU,10.5\n2,US,30\n3,EU,20\n4,JP,5\n");
  duckdb = await DuckDBEngine.create({ allowedDirectories: [folder], tempDirectory: path.join(folder, ".tmp") });
});

after(async () => {
  await duckdb.dispose();
  await rm(folder, { recursive: true, force: true });
});

/**
 * The engine, holding `open` requests while `hold` is on, as it does a long request: a `cancel` of one answers it as
 * cancelled (§8.6), and `release` lets the others through.
 */
function holding(engine: DuckDBEngine) {
  const held = new Map<number, { message: Json; resolve: (answer: unknown) => void }>();
  return {
    hold: false,
    get held() {
      return held.size;
    },
    release() {
      for (const [id, { message, resolve }] of held) {
        held.delete(id);
        resolve(engine.handle(message));
      }
    },
    subscribe: (listener: (event: Json) => void) => engine.subscribe(listener),
    async handle(message: unknown, options?: { signal?: AbortSignal }) {
      const request = message as Json;
      const waiting = held.get(request.request as number);
      if (request.op === "cancel" && waiting) {
        held.delete(request.request as number);
        waiting.resolve({ v: 2, id: request.request, error: { code: "cancelled", message: "Cancelled." } });
        return undefined;
      }
      if (this.hold && request.op === "open") {
        return new Promise((resolve) => held.set(request.id as number, { message: request, resolve }));
      }
      return engine.handle(message, options);
    },
  } satisfies GridEngine & Json;
}

test("an App's cancel stops its own request and no other's, though the others use the same ids (§8.6)", async () => {
  const engine = holding(duckdb);
  const grids = new Grids({ engine, wait: 300 });
  try {
    const grid = await grids.open(file);
    const opened = (await grid.message("a", { v: 2, id: 1, op: "open", ref: file })) as Json;
    assert.equal(opened.id, 1);
    engine.hold = true;
    const second = grid.message("b", { v: 2, id: 1, op: "open", ref: file }) as Promise<Json>;
    // App a cancels its request 1 late, once it has its answer: App b's request 1 goes on.
    await grid.message("a", { v: 2, id: 2, op: "cancel", request: 1 });
    assert.equal(engine.held, 1);
    // The agent's reads number their requests from 1 too; App b still cancels its own.
    assert.equal((await grid.rows({ count: 1 })).rows.length, 1);
    await grid.message("b", { v: 2, id: 2, op: "cancel", request: 1 });
    assert.equal(engine.held, 0);
    const answer = await second;
    assert.deepEqual([answer.id, (answer.error as Json | undefined)?.code], [1, "cancelled"]);
  } finally {
    engine.release();
    grids.dispose();
  }
});

test("the tables of an App that stopped asking are closed, and so are those of a grid that closes", async () => {
  const grids = new Grids({ engine: duckdb, wait: 50, idle: 100 });
  const read = (table: string) => duckdb.handle({ v: 2, id: 9, op: "info", table });
  try {
    const grid = await grids.open(file);
    const first = ((await grid.message("a", { v: 2, id: 1, op: "open", ref: file })) as { result: Json }).result;
    assert.equal(((await read(first.table as string)) as Json).error, undefined);
    // App a leaves; when App b next asks, a is forgotten and its table is closed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await grid.sync("b", { version: -1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((((await read(first.table as string)) as Json).error as Json).code, "table_not_found");
    // A grid that closes closes the tables of the Apps that show it.
    const second = ((await grid.message("b", { v: 2, id: 1, op: "open", ref: file })) as { result: Json }).result;
    grids.close(grid.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((((await read(second.table as string)) as Json).error as Json).code, "table_not_found");
  } finally {
    grids.dispose();
  }
});
