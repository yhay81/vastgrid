import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Filter, TableSource, ViewQuery } from "vastgrid-core";
import { type OpenTable, TableEngine } from "vastgrid-duckdb";
import { BrowserErrorCodes } from "../src/errors.ts";
import { serveTable } from "../src/serve.ts";
import { BrowserSource } from "../src/source.ts";
import { BrowserTable, type BrowserTableOptions } from "../src/table.ts";
import { parseCsv } from "../src/text.ts";
import { zonedText } from "../src/values.ts";

let root: string;
let engine: TableEngine;

const csv = [
  "id,name,price,when,flag,note",
  '1,Apple,1.5,2024-01-03,true,"crisp, red"',
  '2,Banana,0.25,2024-01-01,false,"line one\nline two"',
  '3,"Cherry ""Bing""",12,2024-02-10,true,',
  "4,Durian,,2024-01-15,,smelly",
  "5,Elderberry,3.75,2023-12-31,false,dark",
].join("\n");

const parquetSelect = `
  SELECT * FROM (VALUES
    (1, 'b', 2.50::DECIMAL(10,2), 1.5, DATE '2024-01-03', TIMESTAMP '2024-01-03 10:00:00.5', true, 9007199254740993, 7::INTEGER, TIMESTAMPTZ '2024-01-01 00:00:00+00', 1.5::FLOAT),
    (2, '', -0.05::DECIMAL(10,2), NULL, DATE '2024-01-01', TIMESTAMP '2023-12-31 23:59:59', false, -9007199254740993, NULL, NULL, -2.25::FLOAT),
    (3, 'a', NULL, -3.0, NULL, NULL, NULL, 5, 3, TIMESTAMPTZ '2024-06-01 12:30:00+00', NULL),
    (4, NULL, 100.00::DECIMAL(10,2), 'NaN'::DOUBLE, DATE '1999-12-31', TIMESTAMP '1999-12-31 00:00:00', true, NULL, -1, NULL, 0::FLOAT),
    (5, 'Apple', 2.5::DECIMAL(10,2), 'Infinity'::DOUBLE, DATE '2024-01-03', TIMESTAMP '2024-01-03 10:00:00.5', false, 0, 7, NULL, 3.5::FLOAT)
  ) t(id, label, amount, score, day, stamp, flag, big, small, zoned, ratio)
`;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-browser-"));
  await writeFile(path.join(root, "fruit.csv"), csv);
  await writeFile(path.join(root, "fruit.tsv"), csv.replaceAll(",", "\t").replace("crisp\t red", "crisp, red"));
  await writeFile(
    path.join(root, "events.jsonl"),
    [
      '{"id": 1, "kind": "open", "at": "2024-01-03", "value": 1.5, "ok": true, "tags": ["a", "b"]}',
      '{"id": 2, "kind": "close", "at": "2024-01-01", "value": null, "ok": false, "tags": []}',
      "",
      '{"id": 3, "kind": null, "at": "2023-12-31", "value": 4, "ok": null}',
    ].join("\n"),
  );
  await duckdb(`COPY (${parquetSelect}) TO '${path.join(root, "mixed.parquet")}' (FORMAT parquet)`);
  // More than one 4 MiB chunk of the index.
  await duckdb(
    `COPY (SELECT i AS n, i % 7 AS bucket, 'row ' || i AS label, (i * 37 % 1001) / 10.0 AS amount, DATE '2020-01-01' + (i % 900)::INTEGER AS day FROM range(150000) t(i)) TO '${path.join(root, "big.csv")}' (FORMAT csv, HEADER)`,
  );
  await duckdb(
    `COPY (SELECT i AS n, 'row "' || i || '"' || CASE WHEN i % 3 = 0 THEN chr(13) || chr(10) || 'more, ' || i ELSE '' END AS label FROM range(5000) t(i)) TO '${path.join(root, "quoted.csv")}' (FORMAT csv, HEADER)`,
  );
  await duckdb(
    `COPY (SELECT i AS n, i % 7 AS bucket, 'row ' || i AS label, (i * 37 % 1001) / 10.0 AS amount FROM range(100000) t(i)) TO '${path.join(root, "big.parquet")}' (FORMAT parquet, ROW_GROUP_SIZE 10000)`,
  );
  engine = await TableEngine.create({
    allowedDirectories: [root],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "4GB",
    threads: 2,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function duckdb(sql: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(sql);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function local(name: string, options: BrowserTableOptions = {}) {
  const table = new BrowserTable({ file: await openAsBlob(path.join(root, name)), name }, options);
  await ready(table);
  return table;
}

async function ready(source: TableSource) {
  for (;;) {
    const info = await source.info();
    if (info.status !== "loading") return info;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function server(name: string): Promise<OpenTable> {
  const table = await engine.open(path.join(root, name));
  await table.whenReady();
  assert.equal(table.info().status, "ready", table.info().error);
  return table;
}

async function rows(source: Pick<TableSource, "readRows">, view: string | null, count: number, columns: number[]) {
  const block = await source.readRows({ view, start: 0, end: count, columns });
  return { columns: block.columns, rowIds: block.rowIds ?? null };
}

/** Compares what the browser table and the DuckDB engine answer for the same file. */
async function compareWithDuckDB(name: string, queries: ViewQuery[]) {
  const browser = await local(name);
  const duck = await server(name);
  const info = await browser.info();
  const expected = duck.info();
  assert.deepEqual(
    info.columns.map((column) => [column.name, column.type]),
    expected.columns.map((column) => [column.name, column.type]),
    `${name}: columns`,
  );
  assert.equal(info.rowCount, expected.rowCount, `${name}: rows`);
  const all = info.columns.map((_, index) => index);
  const count = info.rowCount ?? 0;
  assert.deepEqual(await rows(browser, null, count, all), await rows(duck, null, count, all), `${name}: values`);
  for (const query of queries) {
    const left = await browser.createView(query);
    const right = await duck.createView(query);
    assert.equal(left.rowCount, right.rowCount, `${name}: rows of ${JSON.stringify(query)}`);
    assert.deepEqual(
      await rows(browser, left.id, left.rowCount, all),
      await rows(duck, right.id, right.rowCount, all),
      `${name}: ${JSON.stringify(query)}`,
    );
  }
  return { browser, duck };
}

function sorts(columns: number) {
  const queries: ViewQuery[] = [];
  for (let column = 0; column < columns; column++) {
    queries.push({ sort: [{ column, direction: "asc" }] }, { sort: [{ column, direction: "desc" }] });
  }
  return queries;
}

test("a CSV reads, sorts and filters as the DuckDB engine does", async () => {
  const filters: Filter[] = [
    { type: "values", column: 1, values: ["Apple", "Durian"] },
    { type: "values", column: 2, values: [12, null] },
    { type: "values", column: 2, values: [12], exclude: true },
    { type: "compare", column: 2, op: "gt", value: 1 },
    { type: "compare", column: 0, op: "lt", value: 2.5 },
    { type: "between", column: 3, min: "2024-01-01", max: "2024-01-31" },
    { type: "text", column: 1, op: "contains", value: "ERR" },
    { type: "text", column: 1, op: "contains", value: "ERR", caseSensitive: true },
    { type: "text", column: 5, op: "notContains", value: "r" },
    { type: "blank", column: 2, blank: true },
    { type: "values", column: 4, values: [true] },
  ];
  const { browser, duck } = await compareWithDuckDB("fruit.csv", [
    ...sorts(6),
    ...filters.map((filter) => ({ filters: [filter] })),
    { search: "LINE TWO" },
    { search: "2024-02" },
    { filters: [filters[3]], sort: [{ column: 1, direction: "desc" }] },
    // Condition trees: OR across columns, nesting, several conditions on one column, with filters.
    { where: { type: "or", filters: [filters[0], filters[5]] } },
    {
      filters: [filters[10]],
      where: { type: "or", filters: [filters[9], { type: "and", filters: [filters[3], filters[4]] }] },
    },
    {
      where: {
        type: "and",
        filters: [
          { type: "compare", column: 2, op: "ge", value: 0.25 },
          { type: "compare", column: 2, op: "lt", value: 12 },
          { type: "or", filters: [filters[6], filters[8]] },
        ],
      },
      sort: [{ column: 2, direction: "asc" }],
    },
  ]);
  await assert.rejects(
    browser.createView({ filters: [{ type: "compare", column: 2, op: "gt", value: "abc" }] }),
    (error: Error & { code?: string }) => error.code === "query_failed",
  );
  for (const column of [1, 2, 3, 4]) {
    const left = await browser.columnStats(null, column);
    const right = await duck.columnStats(null, column);
    // DuckDB also averages dates (as epoch seconds); ArraySource and this source average numbers only.
    const keys = ["rows", "nulls", "distinct", "min", "max"] as const;
    // DuckDB sends the extremes of booleans as text.
    const plain = (value: unknown) => (typeof value === "boolean" ? String(value) : (value ?? null));
    for (const key of column === 3 ? keys : [...keys, "mean" as const, "minLength" as const, "maxLength" as const])
      assert.deepEqual(plain(left[key]), plain(right[key]), `stats ${column} ${key}`);
  }
  assert.deepEqual(
    await browser.distinctValues({ view: null, column: 4 }),
    await duck.distinctValues({ view: null, column: 4 }),
  );
  const summary = { view: null, ranges: [{ start: 0, end: 3, columns: [1, 2] }] };
  assert.deepEqual(await browser.aggregate(summary), await duck.aggregate(summary));
  const columns = [1, 5];
  for (const [text, row, column, direction] of [
    ["r", 0, 0, 1],
    ["r", 0, 1, 1],
    ["apple", 3, 0, 1],
    ["dark", 0, 0, -1],
    ["zzz", 0, 0, 1],
  ] as const) {
    const request = { view: null, text, columns, row, column, direction };
    assert.deepEqual(await browser.find(request), await duck.find(request), `find ${text}`);
  }
});

test("TSV and JSON Lines read as the DuckDB engine reads them", async () => {
  await compareWithDuckDB("fruit.tsv", sorts(6));
  const browser = await local("events.jsonl");
  const info = await browser.info();
  assert.deepEqual(
    info.columns.map((column) => [column.name, column.type]),
    [
      ["id", "bigint"],
      ["kind", "string"],
      ["at", "date"],
      ["value", "float"],
      ["ok", "boolean"],
      ["tags", "list"],
    ],
  );
  assert.equal(info.rowCount, 3);
  const block = await browser.readRows({ view: null, start: 0, end: 3, columns: [0, 1, 2, 3, 4, 5] });
  assert.deepEqual(block.columns, [
    [1, 2, 3],
    ["open", "close", null],
    ["2024-01-03", "2024-01-01", "2023-12-31"],
    [1.5, null, 4],
    [true, false, null],
    ["[a, b]", "[]", null],
  ]);
  const view = await browser.createView({ sort: [{ column: 2, direction: "asc" }] });
  assert.deepEqual((await browser.readRows({ view: view.id, start: 0, end: 3, columns: [0] })).columns, [[3, 2, 1]]);
});

test("Parquet values, sorts and filters match the DuckDB engine, also for decimals, large integers and times", async () => {
  const queries: ViewQuery[] = [
    ...sorts(11),
    {
      sort: [
        { column: 2, direction: "desc" },
        { column: 0, direction: "desc" },
      ],
    },
    { filters: [{ type: "compare", column: 2, op: "ge", value: "2.5" }] },
    { filters: [{ type: "between", column: 7, min: "9007199254740992" }] },
    { filters: [{ type: "between", column: 5, min: "2024-01-01", max: "2024-12-31" }] },
    { filters: [{ type: "blank", column: 1, blank: true }] },
    { filters: [{ type: "values", column: 1, values: ["a", "Apple"] }] },
    { filters: [{ type: "text", column: 1, op: "startsWith", value: "a" }] },
    { search: "apple" },
    {
      where: {
        type: "or",
        filters: [
          { type: "between", column: 7, min: "9007199254740992" },
          {
            type: "and",
            filters: [
              { type: "values", column: 1, values: [""] },
              { type: "values", column: 6, values: [false] },
            ],
          },
          { type: "compare", column: 2, op: "eq", value: "100" },
        ],
      },
    },
  ];
  const { browser } = await compareWithDuckDB("mixed.parquet", queries);
  const info = await browser.info();
  assert.equal(info.columns[2].sourceType, "DECIMAL(10,2)");
  const values = await browser.readRows({ view: null, start: 0, end: 2, columns: [2, 5, 7, 9] });
  assert.deepEqual(values.columns, [
    ["2.50", "-0.05"],
    ["2024-01-03 10:00:00.5", "2023-12-31 23:59:59"],
    ["9007199254740993", "-9007199254740993"],
    [zonedText("2024-01-01 00:00:00"), null],
  ]);
});

test("large CSV files index in chunks and agree with DuckDB on rows, views and summaries", async () => {
  const browser = await local("big.csv");
  const duck = await server("big.csv");
  const info = await browser.info();
  assert.equal(info.rowCount, 150000);
  assert.equal(info.rowCount, duck.info().rowCount);
  assert.deepEqual(
    info.columns.map((column) => column.type),
    duck.info().columns.map((column) => column.type),
  );
  for (const start of [0, 999, 1023, 74_990, 149_990]) {
    const request = { view: null, start, end: start + 10, columns: [0, 1, 2, 3, 4] };
    assert.deepEqual(
      (await browser.readRows(request)).columns,
      (await duck.readRows(request)).columns,
      `rows ${start}`,
    );
  }
  const query: ViewQuery = {
    filters: [{ type: "compare", column: 1, op: "eq", value: 3 }],
    sort: [{ column: 3, direction: "desc" }],
  };
  const left = await browser.createView(query);
  const right = await duck.createView(query);
  assert.equal(left.rowCount, right.rowCount);
  for (const start of [0, 5000, left.rowCount - 10]) {
    const request = { start, end: start + 10, columns: [0, 3] };
    assert.deepEqual(
      await browser.readRows({ ...request, view: left.id }),
      await duck.readRows({ ...request, view: right.id }),
    );
  }
  const stats = await browser.columnStats(left.id, 3);
  const expected = await duck.columnStats(right.id, 3);
  assert.deepEqual(
    [stats.rows, stats.nulls, stats.min, stats.max],
    [expected.rows, expected.nulls, expected.min, expected.max],
  );
  const summary = { view: left.id, ranges: [{ start: 100, end: 20_000, columns: [3] }] };
  const total = await browser.aggregate(summary);
  const totalExpected = await duck.aggregate({ ...summary, view: right.id });
  assert.equal(total.count, totalExpected.count);
  assert.ok(Math.abs((total.sum ?? 0) - (totalExpected.sum ?? 0)) < 1e-6);
});

test("quoted line breaks and quotes split rows the same in every chunk size", async () => {
  const text = await readFile(path.join(root, "quoted.csv"), "utf8");
  const expected = parseCsv(text, ",").slice(1);
  for (const chunkBytes of [61, 1000, 65_536]) {
    const table = await local("quoted.csv", { chunkBytes });
    const info = await table.info();
    assert.equal(info.rowCount, 5000, `chunks of ${chunkBytes}`);
    for (const start of [0, 1023, 1024, 2500, 4990]) {
      const block = await table.readRows({ view: null, start, end: start + 10, columns: [0, 1] });
      assert.deepEqual(
        block.columns[1],
        expected.slice(start, start + 10).map((row) => row[1]),
      );
      assert.deepEqual(
        block.columns[0],
        expected.slice(start, start + 10).map((row) => Number(row[0])),
      );
    }
  }
  assert.equal(expected[3][1], 'row "3"\r\nmore, 3');
});

test("a CSV can be read while it is still being indexed", async () => {
  const table = new BrowserTable({ file: await openAsBlob(path.join(root, "big.csv")), name: "big.csv" });
  const first = await table.info();
  if (first.status === "loading") {
    assert.equal(first.rowCount, null);
    await assert.rejects(
      table.createView({ sort: [{ column: 0, direction: "asc" }] }),
      (error: Error & { code?: string }) => error.code === "not_ready",
    );
  }
  const info = await ready(table);
  assert.equal(info.status, "ready");
  assert.equal(info.progress, 1);
  table.close();
  await assert.rejects(table.info(), (error: Error & { code?: string }) => error.code === "table_not_found");
});

test("CSV parsing keeps quotes, empty fields and line breaks", () => {
  assert.deepEqual(parseCsv('a,"b ""c""",,""\r\n\r\n"x\ny",2\n', ","), [
    ["a", 'b "c"', null, ""],
    ["x\ny", "2"],
  ]);
});

test("cancelled requests stop, and failures carry their codes", async () => {
  const table = await local("big.parquet");
  const controller = new AbortController();
  const pending = table.createView({ sort: [{ column: 3, direction: "desc" }] }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  await assert.rejects(
    table.readRows({ view: "v999", start: 0, end: 1, columns: [0] }),
    (error: Error & { code?: string }) => error.code === "view_not_found",
  );
  await assert.rejects(
    table.readRows({ view: null, start: 0, end: 1, columns: [9] }),
    (error: Error & { code?: string }) => error.code === "invalid_request",
  );
  const broken = new BrowserTable({ file: new Blob(["PAR1 not really"]), name: "broken.parquet" });
  const info = await broken.info();
  assert.equal(info.status, "error");
  assert.match(info.error ?? "", /Parquet/);
});

// --- HTTP Range ---------------------------------------------------------------------------------------

interface ServeOptions {
  ranges?: boolean;
  head?: boolean;
  length?: boolean;
  token?: string;
}

interface Served {
  url: string;
  requests: { method: string; range?: string }[];
  bytes: number;
  replace(content: Buffer): void;
  close(): Promise<void>;
}

async function serve(file: string, options: ServeOptions = {}): Promise<Served> {
  let content = await readFile(file);
  let etag = '"1"';
  const state = { requests: [] as Served["requests"], bytes: 0 };
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    state.requests.push({ method: request.method ?? "GET", range: request.headers.range });
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
      response.statusCode = 401;
      response.end();
      return;
    }
    if (request.method === "HEAD" && options.head === false) {
      response.statusCode = 405;
      response.end();
      return;
    }
    response.setHeader("etag", etag);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    let body = content;
    if (match && options.ranges !== false) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), content.length - 1);
      body = content.subarray(start, end + 1);
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end}/${options.length === false ? "*" : content.length}`);
    }
    if (options.length !== false || response.statusCode === 206) response.setHeader("content-length", body.length);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    state.bytes += body.length;
    response.end(body);
  };
  const http: Server = createServer(handle);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${path.basename(file)}`,
    get requests() {
      return state.requests;
    },
    get bytes() {
      return state.bytes;
    },
    replace(next: Buffer) {
      content = next;
      etag = '"2"';
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

test("a Parquet URL is read in byte ranges, without downloading the whole file", async () => {
  const file = path.join(root, "big.parquet");
  const size = (await readFile(file)).length;
  const served = await serve(file);
  try {
    const table = new BrowserTable({ url: served.url });
    const info = await table.info();
    assert.equal(info.status, "ready", info.error);
    assert.equal(info.rowCount, 100000);
    assert.equal(info.byteSize, size);
    assert.equal(info.revision, '"1"');
    assert.equal(info.capabilities.sort, false, "sorting a URL would download all of it");
    assert.equal(info.capabilities.aggregate, false, "a whole column would download all of it");
    const block = await table.readRows({ view: null, start: 55_000, end: 55_003, columns: [0, 2] });
    assert.deepEqual(block.columns, [
      [55000, 55001, 55002],
      ["row 55000", "row 55001", "row 55002"],
    ]);
    assert.ok(served.bytes < size / 4, `read ${served.bytes} of ${size} bytes`);
    assert.ok(
      served.requests.every((request) => request.method === "HEAD" || /^bytes=\d+-\d+$/.test(request.range ?? "")),
    );
    const before = served.requests.length;
    await table.readRows({ view: null, start: 55_000, end: 55_003, columns: [0, 2] });
    assert.equal(served.requests.length, before, "ranges read before come from the cache");
    assert.deepEqual(table.transfer(), { bytes: served.bytes, requests: served.requests.length });
    await assert.rejects(
      table.createView({ sort: [{ column: 0, direction: "desc" }] }),
      (error: Error & { code?: string }) => error.code === "invalid_request",
    );
    const scanning = new BrowserTable({ url: served.url }, { fullScan: true });
    const view = await scanning.createView({ sort: [{ column: 0, direction: "desc" }] });
    assert.deepEqual((await scanning.readRows({ view: view.id, start: 0, end: 2, columns: [0] })).columns, [
      [99999, 99998],
    ]);
  } finally {
    await served.close();
  }
});

test("a replaced file fails with file_changed, and opens again with its new revision", async () => {
  const served = await serve(path.join(root, "big.parquet"));
  try {
    const table = new BrowserTable({ url: served.url });
    await table.readRows({ view: null, start: 0, end: 1, columns: [0] });
    served.replace(await readFile(path.join(root, "mixed.parquet")));
    await assert.rejects(
      table.readRows({ view: null, start: 90_000, end: 90_001, columns: [0] }),
      (error: Error & { code?: string }) => error.code === BrowserErrorCodes.fileChanged,
    );
    const info = await table.info();
    assert.equal(info.revision, '"2"');
    assert.equal(info.rowCount, 5);
  } finally {
    await served.close();
  }
});

test("servers without HEAD, Range or a size, and with authentication", async () => {
  const file = path.join(root, "mixed.parquet");
  const size = (await readFile(file)).length;
  const noHead = await serve(file, { head: false });
  try {
    const info = await new BrowserTable({ url: noHead.url }).info();
    assert.equal(info.rowCount, 5);
    assert.equal(noHead.requests[1].range, "bytes=0-0", "the size comes from a one-byte range");
  } finally {
    await noHead.close();
  }
  const noRanges = await serve(file, { ranges: false });
  try {
    const table = new BrowserTable({ url: noRanges.url });
    assert.equal((await table.info()).rowCount, 5);
    assert.equal(noRanges.bytes, size, "a small file is downloaded once");
    const tooLarge = new BrowserTable({ url: noRanges.url }, { maxDownloadBytes: 100 });
    await assert.rejects(
      tooLarge.readRows({ view: null, start: 0, end: 1, columns: [0] }),
      (error: Error & { code?: string }) => error.code === BrowserErrorCodes.rangeNotSupported,
    );
  } finally {
    await noRanges.close();
  }
  const unknown = await serve(file, { head: false, length: false });
  try {
    const info = await new BrowserTable({ url: unknown.url }).info();
    assert.equal(info.status, "error");
    assert.match(info.error ?? "", /size/);
  } finally {
    await unknown.close();
  }
  const secret = await serve(file, { token: "s3cret" });
  try {
    const denied = await new BrowserTable({ url: secret.url }).info();
    assert.equal(denied.status, "error");
    assert.match(denied.error ?? "", /401/);
    const allowed = await new BrowserTable({ url: secret.url }, { headers: { Authorization: "Bearer s3cret" } }).info();
    assert.equal(allowed.rowCount, 5);
  } finally {
    await secret.close();
  }
  const unreachable = await new BrowserTable({ url: "http://127.0.0.1:9/missing.parquet" }).info();
  assert.equal(unreachable.status, "error");
  assert.match(unreachable.error ?? "", /CORS/);
});

// --- The worker ---------------------------------------------------------------------------------------

/** A `BrowserSource` whose worker is the other end of a message channel in this thread. */
function sourceOverChannel(options: ConstructorParameters<typeof BrowserSource>[0]) {
  return new BrowserSource({
    ...options,
    worker: () => {
      const channel = new MessageChannel();
      serveTable(channel.port2 as unknown as Parameters<typeof serveTable>[0]);
      const port = channel.port1;
      return Object.assign(port, { terminate: () => channel.port2.close() }) as unknown as ReturnType<
        NonNullable<typeof options.worker>
      >;
    },
  });
}

test("BrowserSource reads through the worker messages, cancels and closes", async () => {
  // Node.js cannot send file-backed blobs (openAsBlob) through message ports; browsers send any File.
  const file = new Blob([await readFile(path.join(root, "big.parquet"))]);
  const source = sourceOverChannel({ file, name: "big.parquet" });
  const info = await ready(source);
  assert.equal(info.rowCount, 100000);
  assert.equal(info.format, "parquet");
  const view = await source.createView({ filters: [{ type: "compare", column: 1, op: "eq", value: 0 }] });
  const block = await source.readRows({ view: view.id, start: 0, end: 3, columns: [0] });
  assert.deepEqual(block.columns, [[0, 7, 14]]);
  assert.deepEqual(block.rowIds, [0, 7, 14]);
  const controller = new AbortController();
  const cancelled = source.createView({ sort: [{ column: 2, direction: "desc" }] }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error: Error) => error.name === "AbortError");
  await assert.rejects(
    source.readRows({ view: "v404", start: 0, end: 1, columns: [0] }),
    (error: Error & { code?: string }) => error.code === "view_not_found",
  );
  assert.ok((await source.transfer()).bytes > 0);
  source.close();
  await assert.rejects(source.info(), (error: Error & { code?: string }) => error.code === "table_not_found");
});

test("a file at a URL that changed on the server is reported to subscribers and opened again", async () => {
  const served = await serve(path.join(root, "big.parquet"));
  try {
    const table = new BrowserTable({ url: served.url });
    assert.equal(await table.checkChanges(), false, "a file that is not open is not compared");
    await table.info();
    assert.equal(await table.checkChanges(), false);
    served.replace(await readFile(path.join(root, "mixed.parquet")));
    assert.equal(await table.checkChanges(), true);
    assert.equal((await table.info()).rowCount, 5);
    assert.equal(await new BrowserTable({ file: new Blob(["a\n1\n"]) }).checkChanges(), false);
  } finally {
    await served.close();
  }

  const watched = await serve(path.join(root, "big.parquet"));
  const source = sourceOverChannel({ url: watched.url, changeInterval: 500 });
  try {
    assert.equal((await source.info()).revision, '"1"');
    let changes = 0;
    const stop = source.subscribe(() => changes++);
    watched.replace(await readFile(path.join(root, "mixed.parquet")));
    for (let wait = 0; wait < 100 && changes === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, 1);
    assert.equal((await source.info()).revision, '"2"');
    stop();
  } finally {
    source.close();
    await watched.close();
  }
});
