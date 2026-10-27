import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { ARROW_MEDIA_TYPE, checkEvent, checkResponse, decodeBlock, fromBase64, readAttached } from "vastgrid-spec";
import { createHttpHandler } from "../src/index.ts";
import { setUp } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let server: Server;
let base: string;
let id = 0;

before(async () => {
  context = await setUp();
  await writeFile(path.join(context.workspace, "fruit.csv"), "id,name\n1,Apple\n2,Banana\n3,Cherry\n");
  const handler = createHttpHandler(context.engine, { path: "/api" });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await context.tearDown();
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function open() {
  const response = await post({ v: 2, id: ++id, op: "open", ref: "fruit.csv" });
  const answer = (await response.json()) as { result: { table: string; revision: string } };
  await context.engine.whenLoaded(answer.result.table);
  return answer.result;
}

test("malformed export URLs return 400 and leave the HTTP server running", { timeout: 10_000 }, async () => {
  for (const suffix of ["%", "%FF", "%E0%A4%A"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${base}/api/exports/${suffix}`, { method, signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 400);
      if (method === "GET") {
        const answer = (await response.json()) as { id: unknown; error: { code: string } };
        assert.equal(answer.id, null);
        assert.equal(answer.error.code, "invalid_request");
      }
    }
  }
  assert.ok((await open()).table);
});

test("disconnecting during a POST body leaves the HTTP server running", { timeout: 10_000 }, async (t) => {
  // Create the listener inside this test so node:test attributes an unhandled rejection to this regression.
  const interrupted = createServer(createHttpHandler(context.engine, { path: "/api" }));
  t.after(async () => {
    interrupted.closeAllConnections();
    await new Promise<void>((resolve) => interrupted.close(() => resolve()));
  });
  await new Promise<void>((resolve) => interrupted.listen(0, "127.0.0.1", resolve));
  const received = new Promise<void>((resolve) => {
    interrupted.once("request", (request) => request.once("data", () => resolve()));
  });
  const closed = new Promise<void>((resolve) => {
    interrupted.once("request", (request) => request.once("close", () => resolve()));
  });
  const port = (interrupted.address() as AddressInfo).port;
  const socket = connect(port, "127.0.0.1", () => {
    socket.write("POST /api HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000\r\n\r\n{");
  });
  t.after(() => socket.destroy());
  await received;
  socket.destroy();
  await closed;
  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: "POST",
    body: JSON.stringify({ v: 2, id: ++id, op: "open", ref: "fruit.csv" }),
  });
  assert.equal(response.status, 200);
  checkResponse(await response.json(), "open");
});

test("a request is a POST of its JSON, and blocks are base64 in JSON responses (§8.8)", async () => {
  const table = await open();
  const response = await post({
    v: 2,
    id: ++id,
    op: "rows",
    table: table.table,
    revision: table.revision,
    plan: {},
    start: 0,
    end: 2,
    columns: ["name"],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const answer = (await response.json()) as { result: { block: { base64: string } } };
  checkResponse(answer, "rows");
  assert.deepEqual(decodeBlock(fromBase64(answer.result.block.base64)).rows, [["Apple"], ["Banana"]]);
});

test("a client that accepts Arrow gets the block attached after the JSON", async () => {
  const table = await open();
  const response = await post(
    {
      v: 2,
      id: ++id,
      op: "rows",
      table: table.table,
      revision: table.revision,
      plan: {},
      start: 1,
      end: 3,
      columns: ["id", "name"],
    },
    { accept: `${ARROW_MEDIA_TYPE}, application/json` },
  );
  assert.equal(response.headers.get("content-type"), ARROW_MEDIA_TYPE);
  const answer = readAttached(new Uint8Array(await response.arrayBuffer())) as {
    result: { block: { bytes: Uint8Array } };
  };
  assert.deepEqual(decodeBlock(answer.result.block.bytes).rows, [
    [2, "Banana"],
    [3, "Cherry"],
  ]);
  // Answers without a block stay JSON.
  const info = await post({ v: 2, id: ++id, op: "info", table: table.table }, { accept: ARROW_MEDIA_TYPE });
  assert.match(info.headers.get("content-type") ?? "", /^application\/json/);
});

test("errors have the HTTP statuses of §8.7", async () => {
  const table = await open();
  const status = async (body: unknown) => {
    const response = await post(body);
    const answer = (await response.json()) as { error: { code: string } };
    return [response.status, answer.error.code];
  };
  assert.deepEqual(await status({ v: 2, id: 1, op: "info", table: "t999" }), [404, "table_not_found"]);
  assert.deepEqual(await status({ v: 2, id: 2, op: "query" }), [400, "invalid_request"]);
  const read = { v: 2, id: 3, op: "rows", table: table.table, plan: {}, start: 0, end: 1, columns: ["id"] };
  assert.deepEqual(await status({ ...read, revision: "r0" }), [409, "revision_changed"]);
  assert.deepEqual(
    await status({ ...read, revision: table.revision, plan: { sort: [{ column: "x", direction: "asc" }] } }),
    [400, "invalid_plan"],
  );
  assert.deepEqual(await status({ v: 2, id: 4, op: "open", ref: "../outside.csv" }), [403, "not_allowed"]);
  assert.deepEqual(await status({ v: 2, id: 5, op: "open", ref: "missing.csv" }), [422, "load_failed"]);
  assert.deepEqual(await status("{"), [400, "invalid_request"]);
  // No request was read: the answer's id is null, which no request has (§8.1).
  assert.equal(((await (await post("{")).json()) as { id: unknown }).id, null);
  const get = await fetch(`${base}/api`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  const large = await post(JSON.stringify({ v: 2, id: 6, op: "open", ref: "x".repeat(65 * 1024 * 1024) }));
  assert.equal(large.status, 413);
});

test("cancel has no response, and middleware passes other paths on", async () => {
  const cancel = await post({ v: 2, id: ++id, op: "cancel", request: 1 });
  assert.equal(cancel.status, 204);
  assert.equal(await cancel.text(), "");
  const handler = createHttpHandler(context.engine, { path: "/api" });
  let passed = false;
  await handler({ url: "/other", method: "GET", headers: {} } as never, {} as never, () => {
    passed = true;
  });
  assert.ok(passed);
});

test("events go out as Server-Sent Events (§8.5, §8.8)", async () => {
  await writeFile(path.join(context.workspace, "later.csv"), "x\n1\n2\n");
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const opened = post({ v: 2, id: ++id, op: "open", ref: "later.csv" });
  let ready: Record<string, unknown> | undefined;
  while (!ready) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
      checkEvent(event);
      if (event.event === "progress" && event.status === "ready" && event.rowCount === 2) ready = event;
    }
  }
  assert.ok(ready, "a progress event tells that the table has loaded");
  await opened;
  controller.abort();
  await reader.cancel().catch(() => undefined);
});
