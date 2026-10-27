import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryEngine } from "vastgrid-js";
import { encodeBlock, frameAttached, type GridCommand } from "vastgrid-spec";
import { keyCommand } from "../src/canvas/keys.ts";
import { BLOCK_ROWS, ViewCache } from "../src/core/cache.ts";
import { GridClient, GridError, httpTransport, localTransport, serveEngine, workerTransport } from "../src/core.ts";
import { fakeEngine, numbers } from "./fake-engine.ts";

const key = (key: string, extra: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

test("keys give the commands of the grid pattern (§6.4)", () => {
  const cases: [ReturnType<typeof key>, boolean, GridCommand | null][] = [
    [key("ArrowDown"), true, { command: "move", direction: "down" }],
    [key("ArrowLeft", { shiftKey: true }), true, { command: "move", direction: "left", extend: true }],
    [key("ArrowUp", { metaKey: true }), true, { command: "move", direction: "up", jump: true }],
    [key("ArrowUp", { ctrlKey: true }), false, { command: "move", direction: "up", jump: true }],
    [key("ArrowUp", { ctrlKey: true }), true, { command: "move", direction: "up" }],
    [key("PageDown", { shiftKey: true }), false, { command: "move", direction: "down", page: true, extend: true }],
    [key("Home", { ctrlKey: true }), false, { command: "move.home", jump: true }],
    [key("End"), false, { command: "move.end" }],
    [key("Tab", { shiftKey: true }), false, { command: "advance", axis: "column", back: true }],
    [key("Enter"), false, { command: "advance", axis: "row" }],
    [key("a", { metaKey: true }), true, { command: "select.all" }],
    [key("a"), true, null],
    [key("s", { metaKey: true }), true, { command: "save" }],
    [key("s", { ctrlKey: true }), false, { command: "save" }],
    [key("S", { ctrlKey: true, shiftKey: true }), false, null],
    [key("ArrowDown", { altKey: true }), true, null],
    [key("d", { metaKey: true }), true, { command: "edit.fill", direction: "down" }],
    [key("r", { ctrlKey: true }), false, { command: "edit.fill", direction: "right" }],
    [key("d", { ctrlKey: true }), true, null],
  ];
  for (const [input, apple, expected] of cases)
    assert.deepEqual(keyCommand(input, apple), expected, JSON.stringify(input));
});

test("the cache reads runs of blocks that lack the same columns, and keeps what it is reading", () => {
  const cache = new ViewCache();
  assert.deepEqual(cache.reads(0, 600, ["a"], 10_000), [{ start: 0, end: 768, columns: ["a"] }]);
  cache.reading({ start: 0, end: 512, columns: ["a"] }, true);
  assert.deepEqual(cache.reads(0, 600, ["a", "b"], 10_000), [
    { start: 0, end: 512, columns: ["b"] },
    { start: 512, end: 768, columns: ["a", "b"] },
  ]);
  // Reads end at the last row and hold at most maxCells cells.
  assert.deepEqual(cache.reads(9_900, 20_000, ["a"], 10_000), [{ start: 9_728, end: 10_000, columns: ["a"] }]);
  assert.equal(cache.reads(0, 4_096, ["a"], 10_000, BLOCK_ROWS * 4).length, 4);
});

test("the cache takes rows, keys them and lets the least recently used blocks go", () => {
  const cache = new ViewCache();
  const rows = (start: number) => Array.from({ length: BLOCK_ROWS }, (_, index) => [`text ${start + index}`]);
  for (let block = 0; block < 4; block++) {
    const start = block * BLOCK_ROWS;
    cache.receive(
      start,
      Array.from({ length: BLOCK_ROWS }, (_, index) => start + index + 1_000),
      ["s"],
      rows(start),
      {
        s: [3],
      },
    );
  }
  assert.equal(cache.value(300, "s"), "text 300");
  assert.equal(cache.rowId(300), 1_300);
  assert.equal(cache.isCut(259, "s"), true);
  assert.equal(cache.isCut(260, "s"), false);
  assert.deepEqual(cache.loaded(5, undefined)?.key, { rowId: 1_005 });
  assert.deepEqual(cache.loaded(5, "s")?.key, { value: "text 5" });
  assert.equal(cache.loaded(5_000, undefined), undefined);
  cache.touch(0, BLOCK_ROWS);
  const before = cache.bytes;
  cache.evict(before / 2, 0, BLOCK_ROWS);
  assert.ok(cache.bytes <= before / 2);
  assert.equal(cache.value(10, "s"), "text 10", "the blocks on screen stay");
  // The blocks never used leave first, in the order they came, until the cache fits.
  assert.equal(cache.value(BLOCK_ROWS + 10, "s"), undefined);
  assert.equal(cache.value(2 * BLOCK_ROWS + 10, "s"), undefined);
  assert.equal(cache.value(3 * BLOCK_ROWS + 10, "s"), `text ${3 * BLOCK_ROWS + 10}`);
});

test("the client checks answers, gives errors as GridError and cancels by message", async () => {
  const engine = fakeEngine(numbers(10));
  const client = new GridClient(localTransport(engine));
  const info = await client.request<{ table: string }>("open", { ref: "x" });
  await assert.rejects(
    client.request("rows", {
      table: "nope",
      revision: null,
      plan: { where: { lit: true } },
      start: 0,
      end: 1,
      columns: ["id"],
    }),
    (error: unknown) => error instanceof GridError && error.op === "rows",
  );
  const broken = new GridClient({ send: async (request) => ({ v: 2, id: request.id, result: { nonsense: true } }) });
  await assert.rejects(
    broken.request("info", { table: "t" }),
    (error: unknown) => error instanceof GridError && error.code === "internal",
  );
  engine.hold();
  const abort = new AbortController();
  const reading = client.request(
    "rows",
    { table: info.table, revision: "r1", plan: {}, start: 0, end: 5, columns: ["id"] },
    abort.signal,
  );
  abort.abort();
  await assert.rejects(reading, (error: unknown) => error instanceof GridError && error.code === "cancelled");
  engine.release();
  assert.equal(engine.requests.at(-1)?.op, "cancel");
});

test("cancelling one client does not name another client's request on the same engine", async () => {
  const engine = fakeEngine(numbers(3));
  const clients = [new GridClient(localTransport(engine)), new GridClient(localTransport(engine))];
  const opened = await Promise.all(clients.map((client) => client.request<{ table: string }>("open", { ref: "x" })));
  engine.hold();
  const controller = new AbortController();
  const reads = clients.map((client, index) =>
    client.request(
      "rows",
      { table: opened[index].table, revision: "r1", plan: {}, start: 0, end: 1, columns: ["id"] },
      index === 0 ? controller.signal : undefined,
    ),
  );
  const requests = engine.requests.filter((request) => request.op === "rows");
  controller.abort();
  engine.release();
  await assert.rejects(reads[0], (error: unknown) => error instanceof GridError && error.code === "cancelled");
  await reads[1];
  const cancel = engine.requests.find((request) => request.op === "cancel");
  assert.equal(cancel?.request, requests[0].id);
  assert.notEqual(cancel?.request, requests[1].id);
});

test("over HTTP, blocks come attached to the response (§8.8)", async () => {
  const engine = fakeEngine(numbers(20));
  const seen: RequestInit[] = [];
  const transport = httpTransport("https://example.test/grid", {
    fetch: async (_url, init) => {
      seen.push(init ?? {});
      const response = (await engine.handle(JSON.parse(String(init?.body)))) as Record<string, unknown>;
      const rows = (response.result as { block?: unknown } | undefined)?.block !== undefined;
      return rows
        ? new Response(frameAttached(response), { headers: { "content-type": "application/vnd.vastgrid.v2+arrow" } })
        : Response.json(response);
    },
  });
  const client = new GridClient(transport);
  const info = await client.request<{ table: string }>("open", { ref: "x" });
  const rows = await client.request<{ block: { bytes: Uint8Array } }>("rows", {
    table: info.table,
    revision: "r1",
    plan: {},
    start: 0,
    end: 3,
    columns: ["id"],
  });
  assert.ok(rows.block.bytes instanceof Uint8Array);
  assert.equal(new Headers(seen[1].headers).get("accept")?.startsWith("application/vnd.vastgrid.v2+arrow"), true);
  assert.deepEqual(rows.block.bytes, encodeBlock([{ name: "id", type: "integer" }], [[0], [1], [2]]));
});

test("over HTTP, requests wait until the event stream is open, and one that fails does not hold them", async () => {
  // An engine sends each event to the streams open at the time: a table opened before its client's stream would
  // finish loading unheard.
  class FakeEventSource {
    static made: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      FakeEventSource.made.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const global = globalThis as { EventSource?: unknown };
  const before = global.EventSource;
  global.EventSource = FakeEventSource;
  try {
    const sent: string[] = [];
    const transport = httpTransport("https://example.test/grid", {
      events: "https://example.test/grid/events",
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)).op);
        return Response.json({ v: 2, id: 1, result: {} });
      },
    });
    const events: unknown[] = [];
    const stop = transport.subscribe?.((event) => events.push(event));
    const answer = transport.send({ v: 2, id: 1, op: "open", ref: "x" } as never, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent, []);
    const [source] = FakeEventSource.made;
    source.onopen?.();
    await answer;
    assert.deepEqual(sent, ["open"]);
    source.onmessage?.({ data: '{"v":2,"event":"progress"}' });
    assert.deepEqual(events, [{ v: 2, event: "progress" }]);
    stop?.();
    assert.equal(source.closed, true);

    transport.subscribe?.(() => {});
    const failed = transport.send({ v: 2, id: 2, op: "info", table: "t1" } as never, {});
    FakeEventSource.made[1].onerror?.();
    await failed;
    assert.deepEqual(sent, ["open", "info"]);
  } finally {
    global.EventSource = before;
  }
});

test("a worker serves an engine through a MessagePort, events included", async () => {
  const engine = fakeEngine(numbers(5));
  const channel = new MessageChannel();
  const stop = serveEngine(engine, channel.port2 as never);
  const transport = workerTransport(channel.port1 as never);
  const client = new GridClient(transport);
  const events: unknown[] = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  const info = await client.request<{ table: string }>("open", { ref: "x" });
  engine.send({ v: 2, event: "changed", table: info.table, revision: "r2", edits: { version: 1, cells: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  unsubscribe();
  stop();
  transport.close();
  channel.port1.close();
  channel.port2.close();
});

test("the memory engine behind a MessagePort stops a find that is cancelled, and forgets the table it closes", async () => {
  // 300,000 rows of four columns of text, which a find goes through for longer than the 40 ms of a slice.
  const rows = Array.from({ length: 300_000 }, (_, index) => [`a${index}`, `b${index}`, `c${index}`, `d${index}`]);
  const columns = ["a", "b", "c", "d"].map((name) => ({ name, type: "string" as const }));
  const channel = new MessageChannel();
  const stop = serveEngine(memoryEngine({ tables: { big: { columns, rows } } }), channel.port2 as never);
  const transport = workerTransport(channel.port1 as never);
  type Answer = { result?: { table: string; revision: string }; error?: { code: string } };
  const opened = (await transport.send({ v: 2, id: 1, op: "open", ref: "big" })) as Answer;
  const at = { table: opened.result?.table, revision: opened.result?.revision };
  const finding = transport.send({
    v: 2,
    id: 2,
    op: "find",
    ...at,
    plan: {},
    text: "nowhere",
    columns: ["a", "b", "c", "d"],
    from: { row: 0, column: 0 },
    direction: 1,
  }) as Promise<Answer>;
  await transport.send({ v: 2, id: 3, op: "cancel", request: 2 });
  assert.equal((await finding).error?.code, "cancelled");
  assert.deepEqual(await transport.send({ v: 2, id: 4, op: "close", table: at.table }), { v: 2, id: 4, result: null });
  const after = (await transport.send({ v: 2, id: 5, op: "info", table: at.table })) as Answer;
  assert.equal(after.error?.code, "table_not_found");
  stop();
  transport.close();
  channel.port1.close();
  channel.port2.close();
});

test("a block read while the view was shorter is read again once the view has more rows (§9)", () => {
  const cache = new ViewCache();
  cache.receive(0, [0, 1, 2], ["a"], [["x"], ["y"], ["z"]], undefined);
  assert.deepEqual(cache.reads(0, 3, ["a"], 3), []);
  assert.deepEqual(cache.reads(0, 300, ["a"], 1_000), [{ start: 0, end: 512, columns: ["a"] }]);
});
