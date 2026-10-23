import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import { RowCache } from "../src/cache.ts";
import { parseProtocolRequest } from "../src/protocol.ts";
import { RemoteSource } from "../src/remote-source.ts";
import { filtersRows, isEmptyQuery, type TableSource } from "../src/source.ts";
import type { RowRequest, ViewQuery } from "../src/types.ts";

function people() {
  return new ArraySource({
    columns: ["name", "age", "city"],
    rows: [
      ["Ada", 36, "London"],
      ["Grace", 85, "New York"],
      ["Linus", null, "Helsinki"],
      ["Barbara", 81, "Boston"],
      ["Ken", 81, ""],
    ],
  });
}

test("array source infers types and sorts with blanks last", async () => {
  const source = people();
  const info = await source.info();
  assert.deepEqual(
    info.columns.map((column) => column.type),
    ["string", "integer", "string"],
  );
  for (const direction of ["asc", "desc"] as const) {
    const view = await source.createView({ sort: [{ column: 1, direction }] });
    const rows = await source.readRows({ view: view.id, start: 0, end: 5, columns: [0, 1] });
    assert.equal(rows.columns[1][4], null, "blank last");
    assert.deepEqual(
      rows.columns[0].slice(0, 4),
      direction === "asc" ? ["Ada", "Barbara", "Ken", "Grace"] : ["Grace", "Barbara", "Ken", "Ada"],
    );
    assert.equal(rows.rowIds?.length, 5);
  }
});

test("array source filters, searches, summarizes and finds", async () => {
  const source = people();
  const filtered = await source.createView({
    filters: [
      { type: "compare", column: 1, op: "ge", value: 80 },
      { type: "values", column: 2, values: ["Boston", null] },
    ],
  });
  const rows = await source.readRows({ view: filtered.id, start: 0, end: 10, columns: [0] });
  assert.deepEqual(rows.columns[0], ["Barbara", "Ken"]);
  const searched = await source.createView({ search: "LIN" });
  assert.equal(searched.rowCount, 1);
  const text = await source.createView({ filters: [{ type: "text", column: 2, op: "startsWith", value: "new" }] });
  assert.equal(text.rowCount, 1);
  const summary = await source.aggregate({ view: null, ranges: [{ start: 0, end: 5, columns: [0, 1] }] });
  assert.deepEqual(summary, { count: 9, numericCount: 4, sum: 283, min: 36, max: 85, average: 70.75 });
  const stats = await source.columnStats(null, 1);
  assert.equal(stats.nulls, 1);
  assert.equal(stats.distinct, 3);
  assert.equal(stats.max, 85);
  const distinct = await source.distinctValues({ view: null, column: 1 });
  assert.deepEqual(distinct.values[0], { value: 81, count: 2 });
  const found = await source.find({ view: null, text: "o", columns: [0, 2], row: 0, column: 0, direction: 1 });
  assert.deepEqual(found, { row: 0, column: 1 });
  const wrapped = await source.find({ view: null, text: "ada", columns: [0, 2], row: 3, column: 0, direction: 1 });
  assert.deepEqual(wrapped, { row: 0, column: 0 });
});

class CountingSource implements TableSource {
  readonly requests: RowRequest[] = [];
  constructor(private readonly rows: number) {}
  async info() {
    return people().info();
  }
  async createView() {
    return { id: null, rowCount: this.rows, query: {} };
  }
  async readRows(request: RowRequest, signal?: AbortSignal) {
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return {
      start: request.start,
      end: request.end,
      columns: request.columns.map((column) =>
        Array.from({ length: request.end - request.start }, (_, index) => (request.start + index) * 10 + column),
      ),
    };
  }
}

async function waitForCache(cache: RowCache) {
  const deadline = Date.now() + 5000;
  while (cache.pending > 0) {
    assert.ok(Date.now() < deadline, "timed out waiting for the row cache");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("row cache loads visible blocks first and serves values", async () => {
  const source = new CountingSource(10_000);
  const cache = new RowCache(source, { blockRows: 100, blockColumns: 2, concurrency: 2 });
  cache.setView(null, 10_000, 10_000, 3);
  let changes = 0;
  cache.onChange(() => changes++);
  cache.want(500, 540, [0, 2]);
  assert.deepEqual(
    source.requests.map((request) => [request.start, request.columns]),
    [
      [500, [0, 1]],
      [500, [2]],
    ],
  );
  await waitForCache(cache);
  assert.ok(changes > 0);
  assert.equal(cache.value(520, 2), 5202);
  assert.equal(cache.value(9000, 0), undefined);
  // Prefetch reaches one screen (at least one block) around the visible rows.
  assert.ok(source.requests.some((request) => request.start === 400));
  assert.ok(source.requests.some((request) => request.start === 600));
});

test("row cache respects readable rows while loading and refetches cut blocks", async () => {
  const source = new CountingSource(1000);
  const cache = new RowCache(source, { blockRows: 100 });
  cache.setView(null, 1000, 150, 1);
  cache.want(0, 300, [0]);
  await waitForCache(cache);
  assert.equal(cache.value(149, 0), 1490);
  assert.equal(cache.value(150, 0), undefined);
  assert.deepEqual(
    source.requests.map((request) => [request.start, request.end]),
    [
      [0, 100],
      [100, 150],
    ],
  );
  cache.setView(null, 1000, 1000, 1);
  cache.want(0, 300, [0]);
  await waitForCache(cache);
  assert.equal(cache.value(250, 0), 2500);
  assert.ok(source.requests.some((request) => request.start === 100 && request.end === 200));
});

test("row cache reads ranges in chunks for copying", async () => {
  const source = new CountingSource(100_000);
  const cache = new RowCache(source);
  cache.setView(null, 100_000, 100_000, 3);
  const values = await cache.read(10, 1500, [2, 0]);
  assert.equal(values[0].length, 1490);
  assert.equal(values[0][0], 102);
  assert.equal(values[1][1489], 14990);
  // Wide tables are read in fewer rows per request, so that no request asks for too many cells.
  const wide = Array.from({ length: 2000 }, (_, index) => index);
  source.requests.length = 0;
  const columns = await cache.read(0, 300, wide);
  assert.equal(columns[1999][299], 299 * 10 + 1999);
  assert.ok(source.requests.every((request) => (request.end - request.start) * request.columns.length <= 200_000));
});

test("protocol requests are validated", () => {
  assert.deepEqual(parseProtocolRequest({ op: "rows", table: "t", view: null, start: 0, end: 10, columns: [1, 2] }), {
    op: "rows",
    table: "t",
    view: null,
    start: 0,
    end: 10,
    columns: [1, 2],
  });
  assert.throws(() => parseProtocolRequest({ op: "rows", table: "t", start: 5, end: 1, columns: [] }));
  assert.throws(() => parseProtocolRequest({ op: "drop" }));
  assert.throws(() =>
    parseProtocolRequest({ op: "view", table: "t", query: { filters: [{ type: "sql", column: 0 }] } }),
  );
  assert.throws(() => parseProtocolRequest({ op: "rows", table: "t", start: -1, end: 1, columns: [] }));
  assert.throws(
    () => parseProtocolRequest({ op: "rows", table: "t", start: 0, end: 1, columns: [3, 3, 3] }),
    /must not repeat a column/,
  );
  const view = parseProtocolRequest({
    op: "view",
    table: "t",
    query: {
      sort: [{ column: 1, direction: "desc" }],
      filters: [{ type: "values", column: 0, values: [1, null] }],
      search: " ",
    },
  });
  assert.deepEqual(view, {
    op: "view",
    table: "t",
    query: {
      sort: [{ column: 1, direction: "desc" }],
      filters: [{ type: "values", column: 0, values: [1, null], exclude: false }],
    },
  });
});

test("remote source reopens tables and recreates views the server forgot", async () => {
  const backend = people();
  let table = "t1";
  let forgetViews = false;
  const viewsOnServer = new Set<string>();
  const calls: string[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.op);
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    if (body.op === "info") return reply(200, { result: { table, ...(await backend.info()) } });
    if (body.table !== table) return reply(404, { error: { code: "table_not_found", message: "gone" } });
    if (body.op === "view") {
      const view = await backend.createView(body.query);
      if (view.id) viewsOnServer.add(view.id);
      return reply(200, { result: view });
    }
    if (body.op === "rows") {
      if (body.view && (forgetViews || !viewsOnServer.has(body.view))) {
        forgetViews = false;
        return reply(404, { error: { code: "view_not_found", message: "gone" } });
      }
      return reply(200, { result: await backend.readRows(body) });
    }
    return reply(400, { error: { code: "invalid_request", message: "?" } });
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch: fakeFetch });
  await source.info();
  const view = await source.createView({ sort: [{ column: 0, direction: "asc" }] });
  assert.ok(view.id);
  forgetViews = true;
  const rows = await source.readRows({ view: view.id, start: 0, end: 2, columns: [0] });
  assert.deepEqual(rows.columns[0], ["Ada", "Barbara"]);
  table = "t2";
  const again = await source.readRows({ view: view.id, start: 0, end: 1, columns: [0] });
  assert.deepEqual(again.columns[0], ["Ada"]);
  assert.ok(calls.filter((op) => op === "info").length >= 2);
});

test("remote source keeps a shared open request alive when one caller gives up", async () => {
  const backend = people();
  let infoCalls = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.op === "info") infoCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(JSON.stringify({ result: { table: "t1", ...(await backend.info()) } }));
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch: fakeFetch });
  // Like React StrictMode: the first effect starts loading and is cleaned up at once, the second one waits.
  const first = new AbortController();
  const abandoned = source.info(first.signal);
  first.abort();
  await assert.rejects(abandoned, (error: Error) => error.name === "AbortError");
  const info = await source.info();
  assert.equal(info.status, "ready");
  assert.equal(infoCalls, 1, "the request already in flight is reused");
});

test("remote source recreates a forgotten view for callers that still wait when another gives up", async () => {
  const backend = people();
  const viewsOnServer = new Set<string>();
  let onViewRequest: (() => void) | null = null;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    if (body.op === "info") return reply(200, { result: { table: "t1", ...(await backend.info()) } });
    if (body.op === "view") {
      onViewRequest?.();
      // Sorting a large table takes a while.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const view = await backend.createView(body.query);
      if (view.id) viewsOnServer.add(view.id);
      return reply(200, { result: view });
    }
    if (body.view && !viewsOnServer.has(body.view)) {
      return reply(404, { error: { code: "view_not_found", message: "gone" } });
    }
    return reply(200, { result: await backend.readRows(body) });
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch: fakeFetch });
  const view = await source.createView({ sort: [{ column: 0, direction: "asc" }] });
  assert.ok(view.id);
  // The server restarts and forgets the view. A block asks for rows and starts recreating it; a second
  // block joins; then the first block scrolls away and gives up.
  viewsOnServer.clear();
  const recreating = new Promise<void>((resolve) => {
    onViewRequest = resolve;
  });
  const scrolledAway = new AbortController();
  const abandoned = source.readRows({ view: view.id, start: 0, end: 1, columns: [0] }, scrolledAway.signal);
  await recreating;
  const waiting = source.readRows({ view: view.id, start: 1, end: 2, columns: [0] }, new AbortController().signal);
  scrolledAway.abort();
  await assert.rejects(abandoned, (error: Error) => error.name === "AbortError");
  assert.deepEqual((await waiting).columns[0], ["Barbara"]);
});

test("row cache retries a block that failed with a cancellation it did not ask for", async () => {
  let failures = 1;
  const source = new CountingSource(100);
  const readRows = source.readRows.bind(source);
  // A source that shares work between requests can reject a request with another one's AbortError.
  source.readRows = async (request, signal) => {
    if (failures-- > 0) throw new DOMException("aborted", "AbortError");
    return readRows(request, signal);
  };
  const cache = new RowCache(source, { blockRows: 100, retryDelay: 0 });
  cache.setView(null, 100, 100, 1);
  cache.want(0, 10, [0]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cache.blockAt(0, 0)?.state, "error", "the block does not stay loading without a request");
  cache.want(0, 10, [0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cache.value(5, 0), 50);
});

test("row cache asks for failed blocks again by itself", async () => {
  let failures = 1;
  const source = new CountingSource(100);
  const readRows = source.readRows.bind(source);
  source.readRows = async (request, signal) => {
    if (failures-- > 0) throw new Error("The connection was lost.");
    return readRows(request, signal);
  };
  const cache = new RowCache(source, { blockRows: 100, retryDelay: 20 });
  cache.setView(null, 100, 100, 1);
  // Like a grid, ask for the visible rows whenever the cache changes, and not otherwise.
  cache.onChange(() => cache.want(0, 10, [0]));
  cache.want(0, 10, [0]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cache.value(5, 0), 50);
});

test("array source compares, sorts and summarizes large integers and decimals exactly", async () => {
  const source = new ArraySource({
    columns: [
      { name: "id", type: "bigint" },
      { name: "price", type: "decimal" },
      { name: "serial", type: "bigint" },
    ],
    rows: [
      ["9007199254740993", "2.00", 10_000_000_001],
      ["9007199254740992", "10.00", 10_000_000_002],
      ["9007199254740994", "3.50", 10_000_000_003],
    ],
  });
  const equal = await source.createView({
    filters: [{ type: "compare", column: 0, op: "eq", value: "9007199254740993" }],
  });
  assert.equal(equal.rowCount, 1);
  const above = await source.createView({ filters: [{ type: "between", column: 0, min: "9007199254740993" }] });
  assert.equal(above.rowCount, 2);
  const sorted = await source.createView({ sort: [{ column: 0, direction: "asc" }] });
  const rows = await source.readRows({ view: sorted.id, start: 0, end: 3, columns: [0] });
  assert.deepEqual(rows.columns[0], ["9007199254740992", "9007199254740993", "9007199254740994"]);
  const price = await source.columnStats(null, 1);
  assert.equal(price.min, "2.00");
  assert.equal(price.max, "10.00");
  const serial = await source.columnStats(null, 2);
  assert.equal(serial.stddev, 1);
});

test("array source preserves decimal digits in sorting, comparisons, ranges and extrema", async () => {
  const values = ["9007199254740992.20", "9007199254740992.10", "-1.00000000000000002", "-1.00000000000000001"];
  const source = new ArraySource({ columns: [{ name: "amount", type: "decimal" }], columnData: [values] });
  const read = async (query: ViewQuery) => {
    const view = await source.createView(query);
    return (await source.readRows({ view: view.id, start: 0, end: 10, columns: [0] })).columns[0];
  };
  assert.deepEqual(await read({ sort: [{ column: 0, direction: "asc" }] }), [
    values[2],
    values[3],
    values[1],
    values[0],
  ]);
  assert.deepEqual(await read({ sort: [{ column: 0, direction: "desc" }] }), [
    values[0],
    values[1],
    values[3],
    values[2],
  ]);
  assert.deepEqual(await read({ filters: [{ type: "compare", column: 0, op: "eq", value: values[1] }] }), [values[1]]);
  assert.deepEqual(
    await read({ filters: [{ type: "between", column: 0, min: "9007199254740992.09", max: "9007199254740992.15" }] }),
    [values[1]],
  );
  const stats = await source.columnStats(null, 0);
  assert.equal(stats.min, values[2]);
  assert.equal(stats.max, values[0]);

  const mixed = new ArraySource({
    columns: [{ name: "amount", type: "decimal" }],
    columnData: [["1.2300", "123e-2", "0.00", "-0e5", 1.23, "0.0001", "-2.5e3", "2.5e3", "1e-1000"]],
  });
  const equal = await mixed.createView({ filters: [{ type: "compare", column: 0, op: "eq", value: "1.23" }] });
  assert.equal(equal.rowCount, 3);
  const sorted = await mixed.createView({ sort: [{ column: 0, direction: "asc" }] });
  assert.deepEqual((await mixed.readRows({ view: sorted.id, start: 0, end: 9, columns: [0] })).columns[0], [
    "-2.5e3",
    "0.00",
    "-0e5",
    "1e-1000",
    "0.0001",
    "1.2300",
    "123e-2",
    1.23,
    "2.5e3",
  ]);
});

/** Like a table server: text longer than `textLimit` (2,000 characters unless asked) ends with "…". */
class TruncatingSource extends CountingSource {
  override async readRows(request: RowRequest, signal?: AbortSignal) {
    const block = await super.readRows(request, signal);
    const limit = request.textLimit ?? 2000;
    const long = "x".repeat(3000);
    return {
      ...block,
      columns: block.columns.map((values) =>
        values.map(() => (long.length > limit ? `${long.slice(0, limit)}…` : long)),
      ),
    };
  }
}

test("row cache reads copies whole and from the view they started in", async () => {
  const source = new TruncatingSource(100_000);
  let release = () => {};
  const firstPart = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readRows = source.readRows.bind(source);
  source.readRows = async (request, signal) => {
    await firstPart;
    return readRows(request, signal);
  };
  const cache = new RowCache(source);
  cache.setView("sorted", 100_000, 100_000, 3);
  const reading = cache.read(0, 100_000, [0, 1, 2]);
  // The user sorts again while the first part of the copy is being read.
  cache.setView("sorted again", 100_000, 100_000, 3);
  release();
  const values = await reading;
  assert.ok(source.requests.length > 1);
  assert.ok(source.requests.every((request) => request.view === "sorted"));
  assert.equal(values[2][99_999], "x".repeat(3000));
});

test("a query that only sorts keeps every row; filters and a search leave rows out", () => {
  const sort = [{ column: 0, direction: "asc" as const }];
  assert.equal(isEmptyQuery({}), true);
  assert.equal(isEmptyQuery({ sort: [], filters: [], search: "  " }), true);
  assert.equal(isEmptyQuery({ sort }), false);
  assert.equal(filtersRows({ sort }), false);
  assert.equal(filtersRows({ search: "  " }), false);
  assert.equal(filtersRows({ search: "Tokyo" }), true);
  assert.equal(filtersRows({ filters: [{ type: "blank", column: 0, blank: true }] }), true);
});

test("protocol requests carry the preview of a view and ask for its status", () => {
  const query = { sort: [{ column: 0, direction: "asc" }] };
  assert.deepEqual(parseProtocolRequest({ op: "view", table: "t", query, preview: true }), {
    op: "view",
    table: "t",
    query,
    preview: true,
  });
  assert.deepEqual(parseProtocolRequest({ op: "view", table: "t", query, preview: false }), {
    op: "view",
    table: "t",
    query,
  });
  assert.throws(() => parseProtocolRequest({ op: "view", table: "t", query, preview: 1 }), /preview/);
  assert.deepEqual(parseProtocolRequest({ op: "status", table: "t", view: "v1" }), {
    op: "status",
    table: "t",
    view: "v1",
  });
  assert.throws(() => parseProtocolRequest({ op: "status", table: "t", view: 3 }));
});

test("remote source asks for previews, polls views and recreates forgotten ones as previews", async () => {
  const backend = people();
  const requests: Record<string, unknown>[] = [];
  let ready = false;
  let forget = false;
  let next = 1;
  const views = new Map<string, ViewQuery>();
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    const state = (id: string) => ({
      id,
      rowCount: 5,
      query: views.get(id),
      status: ready ? "ready" : "building",
      readableRows: ready ? 5 : 2,
    });
    if (body.op === "info") return reply(200, { result: { table: "t1", ...(await backend.info()) } });
    if (body.op === "view") {
      const id = `s${next++}`;
      views.set(id, body.query);
      return reply(200, { result: state(id) });
    }
    if (body.op === "status") {
      if (forget || !views.has(body.view)) {
        forget = false;
        views.clear();
        return reply(404, { error: { code: "view_not_found", message: "gone" } });
      }
      return reply(200, { result: state(body.view) });
    }
    return reply(400, { error: { code: "invalid_request", message: "?" } });
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "a.csv", fetch: fakeFetch });
  const query: ViewQuery = { sort: [{ column: 1, direction: "desc" }] };
  const view = await source.createView(query, undefined, { preview: true });
  assert.equal(view.status, "building");
  assert.equal(view.readableRows, 2);
  assert.equal(requests.at(-1)?.preview, true);
  assert.equal((await source.viewInfo(view.id as string)).status, "building");
  // The server forgets the view: it is created again, still as a preview, under the caller's id.
  forget = true;
  ready = true;
  const polled = await source.viewInfo(view.id as string);
  assert.deepEqual(
    requests.slice(-3).map((request) => [request.op, request.preview, request.view]),
    [
      ["status", undefined, view.id],
      ["view", true, undefined],
      ["status", undefined, "s2"],
    ],
  );
  assert.equal(polled.id, view.id);
  assert.equal(polled.status, "ready");
  // Without the option, nothing asks for a preview.
  await source.createView({ sort: [{ column: 0, direction: "asc" }] });
  assert.equal(requests.at(-1)?.preview, undefined);
});

test("info requests carry read options, validated, and remote sources send them", async () => {
  assert.deepEqual(
    parseProtocolRequest({ op: "info", ref: "book.xlsx", read: { sheet: "Q1", headerRow: 0, keepEmptyRows: true } }),
    { op: "info", ref: "book.xlsx", read: { sheet: "Q1", headerRow: 0, keepEmptyRows: true } },
  );
  assert.deepEqual(parseProtocolRequest({ op: "info", ref: "a.csv" }), { op: "info", ref: "a.csv" });
  for (const read of [null, "Q1", { sheet: 1 }, { headerRow: 1.5 }, { headerRow: 2_000_000 }, { keepEmptyColumns: 1 }])
    assert.throws(() => parseProtocolRequest({ op: "info", ref: "book.xlsx", read }), JSON.stringify(read));
  const bodies: unknown[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const info = await people().info();
    return new Response(JSON.stringify({ result: { table: "t1", ...info, sheets: [{ name: "Q1" }], sheet: "Q1" } }));
  }) as typeof fetch;
  const source = new RemoteSource({ endpoint: "/api", ref: "book.xlsx", read: { sheet: "Q1" }, fetch: fakeFetch });
  const info = await source.info();
  assert.equal(info.sheet, "Q1");
  assert.deepEqual(bodies, [{ op: "info", ref: "book.xlsx", read: { sheet: "Q1" } }]);
});
