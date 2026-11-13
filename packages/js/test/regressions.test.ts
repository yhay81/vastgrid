import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { HttpFetch, HttpResponse, ParquetTable } from "../src/index.ts";
import { Client } from "./client.ts";

test("exports ParquetTable, HttpFetch, and HttpResponse types from package root", () => {
  const check = (_t?: ParquetTable, _f?: HttpFetch, _r?: HttpResponse) => true;
  assert.equal(check(), true);
});

test("reads >256-byte quoted CSV headers and detects semicolon after leading blank lines", async () => {
  const longHeader = "h".repeat(300);
  const csv = `\r\n\n"${longHeader}";val\n1;2\n`;
  const client = new Client({ t: { file: new Blob([csv]), format: "csv" } });
  const info = await client.open("t");
  assert.deepEqual(
    info.columns.map((column) => column.name),
    [longHeader, "val"],
  );
  assert.deepEqual((await client.rows(info, {})).rows, [[1, 2]]);
});

test("single-row CSV larger than previewBytes opens ready instead of a 0-row preview, while JSONL previews 1 row", async () => {
  const csv = `id,text\n1,${"a".repeat(80)}\n2,${"b".repeat(80)}`;
  const csvClient = new Client({ t: { file: new Blob([csv]), format: "csv" } }, { previewBytes: 100 });
  const csvInfo = await csvClient.open("t");
  assert.equal(csvInfo.status, "ready");
  assert.equal(csvInfo.rowCount, 2);

  const jsonl = `{"id":1,"text":"${"a".repeat(60)}"}\n{"id":2,"text":"${"b".repeat(80)}"}`;
  const jsonlClient = new Client({ t: { file: new Blob([jsonl]), format: "jsonl" } }, { previewBytes: 100 });
  const jsonlInfo = await jsonlClient.open("t");
  assert.equal(jsonlInfo.status, "loading");
  assert.equal(jsonlInfo.readableRows, 1);
});

test("grows lazy JSONL string column buffer when serialized values exceed raw slice bytes", async () => {
  // Compact JSONL with many rows whose mixed string/object column expands or fills lazy block reads.
  // In JSONL, `{"x":"\\u20ac"}` is 14 bytes raw, while multiple columns or whitespace-free objects can pack tightly;
  // more directly, `{"a":1e99}` has 4 chars `1e99` in JSONL (`{"a":1e99}\n` = 11 bytes), while `JSON.stringify(1e99)`
  // or `{"a":[1e20,1e20]}` (`1e20` -> `"100000000000000000000"`, 21 bytes vs 4 bytes raw!) expands 5x!
  const line = '{"a":[1e20,1e20,1e20,1e20]}\n';
  const count = 40;
  const text = line.repeat(count);
  const client = new Client({
    t: { file: new Blob([text]), format: "jsonl", maxBytes: 100 },
  });
  const info = await client.open("t");
  assert.equal(info.rowCount, count);
  const expected = JSON.stringify([1e20, 1e20, 1e20, 1e20]);
  const res = await client.rows(info, {}, { start: 0, end: 5 });
  assert.deepEqual(
    res.rows,
    Array.from({ length: 5 }, () => [expected]),
  );
});

test("evaluates bin with scientific-notation exact width, round float edge cases, and Set-backed in", async () => {
  const client = new Client({
    t: {
      columns: [
        { name: "d", type: "decimal", precision: 18, scale: 8 },
        { name: "f", type: "float" },
        { name: "dt", type: "date" },
        { name: "iv", type: "interval" },
      ],
      rows: [
        ["0.00000025", -0, "2020-01-01", "30 days"],
        ["-0.00000005", 1e308, "2020-01-02", "2 days"],
        ["0.00000000", "NaN", "2020-01-03", "1 month"],
      ],
    },
  });
  const info = await client.open("t");
  const plan = {
    derive: [
      { name: "b", expr: { fn: "bin", args: [{ col: "d" }, { lit: 1e-7 }] } },
      { name: "r5", expr: { fn: "round", args: [{ col: "f" }, { lit: 5 }] } },
      { name: "r0", expr: { fn: "round", args: [{ col: "f" }, { lit: 0 }] } },
      {
        name: "in_d",
        expr: { fn: "in", args: [{ col: "d" }, { lit: "0.00000025", type: "decimal" }, { lit: 0 }] },
      },
      { name: "in_f", expr: { fn: "in", args: [{ col: "f" }, { lit: 0 }, { lit: "NaN", type: "float" }] } },
      {
        name: "in_dt",
        expr: { fn: "in", args: [{ col: "dt" }, { lit: "2020-01-01 00:00:00", type: "timestamp" }] },
      },
      { name: "in_iv", expr: { fn: "in", args: [{ col: "iv" }, { lit: "1 month", type: "interval" }] } },
    ],
  };
  const { rows } = await client.rows(info, plan, {
    columns: ["b", "r5", "r0", "in_d", "in_f", "in_dt", "in_iv"],
  });
  assert.equal(rows[0][0], "0.00000020");
  assert.ok(Object.is(rows[0][1], -0));
  assert.ok(Object.is(rows[0][2], -0));
  assert.deepEqual(rows[0].slice(3), [true, true, true, true]);

  assert.equal(rows[1][0], "-0.00000010");
  assert.equal(rows[1][1], 1e308);
  assert.equal(rows[1][2], 1e308);
  assert.deepEqual(rows[1].slice(3), [false, false, false, false]);

  assert.equal(rows[2][0], "0.00000000");
  assert.equal(rows[2][1], null);
  assert.equal(rows[2][2], null);
  assert.deepEqual(rows[2].slice(3), [true, true, false, true]);
});

test("measure sharing a base column name neither reads the base column whole nor confuses locate", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i % 2},${"x".repeat(200)}`).join("\n");
  const client = new Client({
    t: { file: new Blob([`k,big\n${lines}\n`]), format: "csv", maxBytes: 2_000 },
  });
  const info = await client.open("t");
  const plan = {
    aggregate: {
      keys: ["k"],
      measures: [{ name: "big", fn: "count" }],
    },
    having: { fn: "gt", args: [{ col: "big" }, { lit: 0 }] },
    sort: [{ column: "big", direction: "desc" }],
  };
  const { rows } = await client.rows(info, plan);
  assert.deepEqual(rows, [
    [0, 25],
    [1, 25],
  ]);
  const located = await client.result("locate", {
    table: info.table,
    revision: info.revision,
    plan,
    rowKey: "big",
    keys: [{ value: "x".repeat(200) }],
  });
  assert.deepEqual(located, { rows: [null] });
});

test("export validates headers and numberFormats length when columns is omitted", async () => {
  const client = new Client({
    t: {
      columns: [
        { name: "a", type: "integer" },
        { name: "b", type: "integer" },
      ],
      rows: [[1, 2]],
    },
  });
  const info = await client.open("t");
  const badHeaders = await client.error("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    format: "csv",
    headers: ["only_one"],
  });
  assert.equal(badHeaders.code, "invalid_request");
  assert.equal(badHeaders.path, "/headers");

  const badFormats = await client.error("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    format: "xlsx",
    numberFormats: ["0.00"],
  });
  assert.equal(badFormats.code, "invalid_request");
  assert.equal(badFormats.path, "/numberFormats");
});

test("write rejects empty updates on read-only tables and matches decimal rowKey values by §3.1 equality", async () => {
  const client = new Client({
    ro: { columns: [{ name: "id", type: "integer" }], rows: [[1]], editable: false },
    rw: {
      columns: [
        { name: "price", type: "decimal", precision: 6, scale: 2 },
        { name: "city", type: "string" },
      ],
      rows: [
        ["1.50", "Tokyo"],
        ["2.00", "Osaka"],
      ],
      editable: true,
    },
  });
  const ro = await client.open("ro");
  const err = await client.error("write", { table: ro.table, revision: ro.revision, updates: [] });
  assert.equal(err.code, "read_only");
  const missingRowKey = await client.error("write", {
    table: ro.table,
    revision: ro.revision,
    updates: [{ key: { value: 1 }, column: "id", value: 2 }],
  });
  assert.deepEqual([missingRowKey.code, missingRowKey.path], ["invalid_request", "/rowKey"]);

  const rw = await client.open("rw");
  const written = await client.result("write", {
    table: rw.table,
    revision: rw.revision,
    rowKey: "price",
    updates: [
      { key: { value: "1.5" }, column: "city", value: "Kyoto", previous: "Tokyo" },
      { key: { value: "1.50" }, column: "city", value: "Nara", previous: "Kyoto" },
      { key: { value: "1.50" }, column: "price", value: "3.00", previous: "1.50" },
      { key: { value: "3.0" }, column: "city", value: "Kobe", previous: "Nara" },
    ],
  });
  assert.deepEqual(written, { updated: 4, edits: { version: 1, cells: 2 } });
  assert.deepEqual((await client.rows(rw, {})).rows[0], ["3.00", "Kobe"]);
});
