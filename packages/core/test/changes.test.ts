import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import { parseProtocolRequest } from "../src/protocol.ts";
import { type ChangeWatch, pollChanges, RemoteSource } from "../src/remote-source.ts";
import type { TableChange } from "../src/source.ts";

const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });

/** A server for one table whose revision the test changes; `revision` can be turned off like an older server. */
function server() {
  const backend = new ArraySource({ columns: ["a"], rows: [[1], [2]] });
  const state = {
    revision: "r1" as string | null,
    table: "t1",
    supportsRevision: true,
    down: false,
    ops: [] as string[],
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    state.ops.push(body.op);
    if (state.down) throw new TypeError("Failed to fetch");
    if (body.op === "info") {
      return reply(200, { result: { table: state.table, ...(await backend.info()), revision: state.revision } });
    }
    if (body.table !== state.table) return reply(404, { error: { code: "table_not_found", message: "gone" } });
    if (body.op === "revision") {
      if (!state.supportsRevision) return reply(400, { error: { code: "invalid_request", message: "op is invalid" } });
      return reply(200, { result: { revision: state.revision } });
    }
    return reply(400, { error: { code: "invalid_request", message: "?" } });
  }) as typeof fetch;
  return { state, fetch };
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the revision request is validated", () => {
  assert.deepEqual(parseProtocolRequest({ op: "revision", table: "t1" }), { op: "revision", table: "t1" });
  assert.throws(() => parseProtocolRequest({ op: "revision" }), /table/);
});

test("remote source polls the revision while subscribed and reports each change once", async () => {
  const { state, fetch } = server();
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch, changes: pollChanges({ interval: 100 }) });
  await source.info();
  const changes: TableChange[] = [];
  const stop = source.subscribe((change) => changes.push(change));
  await until(() => state.ops.includes("revision"));
  assert.deepEqual(changes, [], "an unchanged table is not reported");
  state.revision = "r2";
  await until(() => changes.length === 1);
  assert.deepEqual(changes, [{ revision: "r2" }]);
  // Until the grid reads the table again, the same revision is not reported again.
  await wait(250);
  assert.equal(changes.length, 1);
  await source.info();
  state.revision = "r3";
  await until(() => changes.length === 2);
  assert.deepEqual(changes[1], { revision: "r3" });
  stop();
  const asked = state.ops.length;
  await wait(250);
  assert.equal(state.ops.length, asked, "no requests after the last listener left");
});

test("remote source catches up after the server was unreachable or forgot the table", async () => {
  const { state, fetch } = server();
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch, changes: pollChanges({ interval: 100 }) });
  await source.info();
  const changes: TableChange[] = [];
  source.subscribe((change) => changes.push(change));
  state.down = true;
  await until(() => state.ops.filter((op) => op === "revision").length >= 2);
  // The server restarts with the file changed meanwhile: the table handle is gone too.
  state.revision = "r2";
  state.table = "t9";
  state.down = false;
  await until(() => changes.length === 1);
  assert.deepEqual(changes, [{ revision: "r2" }]);
  await source.close();
});

test("remote source stops polling a server without the revision request, and on close", async () => {
  const { state, fetch } = server();
  state.supportsRevision = false;
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch, changes: pollChanges({ interval: 100 }) });
  await source.info();
  source.subscribe(() => undefined);
  await until(() => state.ops.includes("revision"));
  await wait(250);
  assert.equal(state.ops.filter((op) => op === "revision").length, 1);

  const other = server();
  const closed = new RemoteSource({
    endpoint: "/api",
    ref: "a.csv",
    fetch: other.fetch,
    changes: pollChanges({ interval: 100 }),
  });
  await closed.info();
  closed.subscribe(() => undefined);
  await closed.close();
  const asked = other.state.ops.length;
  await wait(250);
  assert.equal(other.state.ops.length, asked);
});

test("remote source takes changes from a transport of its own, without polling", async () => {
  const { state, fetch } = server();
  let watch: ChangeWatch | null = null;
  let stopped = 0;
  const source = new RemoteSource({
    endpoint: "/api",
    ref: "a.csv",
    fetch,
    changes: {
      watch(given) {
        watch = given;
        return () => stopped++;
      },
    },
  });
  await source.info();
  const changes: TableChange[] = [];
  const stopFirst = source.subscribe((change) => changes.push(change));
  const stopSecond = source.subscribe(() => undefined);
  assert.equal((watch as ChangeWatch | null)?.ref, "a.csv");
  // A pushed message: the revision the source read is not a change, a new one is, once.
  watch?.changed("r1");
  watch?.changed("r2");
  watch?.changed("r2");
  watch?.changed();
  assert.deepEqual(changes, [{ revision: "r2" }, {}]);
  assert.equal(state.ops.includes("revision"), false);
  stopFirst();
  assert.equal(stopped, 0, "watching goes on while a listener is left");
  stopSecond();
  assert.equal(stopped, 1);

  const none = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch, changes: false });
  none.subscribe(() => undefined)();
});
