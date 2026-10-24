import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import { RowCache } from "../src/cache.ts";
import { editableColumn, editText, normalizeCellValue, parseCellInput, sameCellValue } from "../src/cell-input.ts";
import type { ColumnSchema, TableChange } from "../src/index.ts";
import { parseProtocolRequest } from "../src/protocol.ts";
import { RemoteSource } from "../src/remote-source.ts";

const column = (type: ColumnSchema["type"], sourceType?: string): ColumnSchema => ({ name: "c", type, sourceType });

test("typed values are checked and keep their digits", () => {
  const ok = (text: string, schema: ColumnSchema) => {
    const result = parseCellInput(text, schema);
    assert.ok(result.ok, `${text} fits ${schema.type}`);
    return result.value;
  };
  const error = (text: string, schema: ColumnSchema) => {
    const result = parseCellInput(text, schema);
    assert.ok(!result.ok, `${text} does not fit ${schema.type}`);
    return result.error;
  };
  assert.equal(ok("  42 ", column("integer")), 42);
  assert.equal(ok("-007", column("integer")), -7);
  assert.equal(error("1.5", column("integer")), "integer");
  assert.equal(error("abc", column("integer")), "number");
  assert.equal(error("128", column("integer", "TINYINT")), "range");
  assert.equal(error("-1", column("integer", "UINTEGER")), "range");
  assert.equal(ok("9223372036854775807", column("bigint", "BIGINT")), "9223372036854775807");
  assert.equal(error("9223372036854775808", column("bigint", "BIGINT")), "range");
  assert.equal(
    ok("170141183460469231731687303715884105727", column("bigint", "HUGEINT")),
    "170141183460469231731687303715884105727",
  );
  assert.equal(ok("12.50", column("decimal", "DECIMAL(10,2)")), "12.50");
  assert.equal(ok("+0012.5", column("decimal", "DECIMAL(10,2)")), "12.5");
  assert.equal(ok("1.230", column("decimal", "DECIMAL(4,2)")), "1.230", "trailing zeros fit the scale");
  assert.equal(error("1.234", column("decimal", "DECIMAL(10,2)")), "scale");
  assert.equal(error("123.4", column("decimal", "DECIMAL(4,2)")), "precision");
  assert.equal(ok("12345678901234567890.123456789", column("decimal")), "12345678901234567890.123456789");
  assert.equal(error("1e5", column("decimal")), "decimal");
  assert.equal(ok("-0.0", column("decimal")), "0.0");
  assert.equal(ok("1e-3", column("float")), 0.001);
  assert.equal(ok("-inf", column("float")), "-Infinity");
  assert.equal(error("1e400", column("float")), "range");
  assert.equal(ok("TRUE", column("boolean")), true);
  assert.equal(ok("0", column("boolean")), false);
  assert.equal(error("yes", column("boolean")), "boolean");
  assert.equal(ok("2024/2/29", column("date")), "2024-02-29");
  assert.equal(error("2023-02-29", column("date")), "date");
  assert.equal(error("2024-13-01", column("date")), "date");
  assert.equal(ok("9:05", column("time")), "09:05:00");
  assert.equal(ok("23:59:59.123456", column("time")), "23:59:59.123456");
  assert.equal(error("25:00", column("time")), "time");
  assert.equal(ok("10:00+09:00", column("time", "TIME WITH TIME ZONE")), "10:00:00+09:00");
  assert.equal(ok("2024-01-31T12:34", column("timestamp")), "2024-01-31 12:34:00");
  assert.equal(ok("2024-01-31", column("timestamp")), "2024-01-31 00:00:00");
  assert.equal(ok("2024-01-31 12:34:56z", column("timestamptz")), "2024-01-31 12:34:56Z");
  assert.equal(error("2024-01-31 12:34 +09:00", column("timestamp")), "timestamp");
  assert.equal(
    ok("{6F9619FF-8B86-D011-B42D-00C04FC964FF}".slice(1, -1), column("uuid")),
    "6f9619ff-8b86-d011-b42d-00c04fc964ff",
  );
  assert.equal(ok('{"a":1}', column("json")), '{"a":1}');
  assert.equal(error("{a:1}", column("json")), "json");
  assert.equal(error("[1]", column("list")), "type");
  // Blanks: empty text, and text of spaces only.
  assert.equal(ok("", column("integer")), null);
  assert.equal(ok("   ", column("string")), null);
  assert.equal(ok(" padded ", column("string")), " padded ");
});

test("values written by programs are checked like typed values", () => {
  assert.deepEqual(normalizeCellValue(5, column("string")), { ok: true, value: "5" });
  assert.deepEqual(normalizeCellValue(12.5, column("decimal", "DECIMAL(5,1)")), { ok: true, value: "12.5" });
  assert.deepEqual(normalizeCellValue(1.5, column("integer")), { ok: false, error: "integer" });
  assert.deepEqual(normalizeCellValue(1e21, column("bigint")), { ok: false, error: "range" });
  assert.deepEqual(normalizeCellValue(true, column("integer")), { ok: false, error: "number" });
  assert.deepEqual(normalizeCellValue(" ", column("date")), { ok: true, value: null });
  assert.deepEqual(normalizeCellValue(null, column("map")), { ok: false, error: "type" });
  assert.equal(editableColumn({ name: "x", type: "string", readOnly: true }), false);
  assert.equal(editText(12.5), "12.5");
  assert.equal(editText(null), "");
  assert.ok(sameCellValue(12, "12"));
  assert.ok(!sameCellValue(true, "true"));
  assert.ok(!sameCellValue(null, ""));
});

test("an array source writes cells only when editable, all or nothing", async () => {
  const rows = [
    ["Ada", 36],
    ["Grace", 85],
  ];
  const readOnly = new ArraySource({ columns: ["name", "age"], rows });
  assert.equal((await readOnly.info()).capabilities.edit, undefined);
  await assert.rejects(readOnly.updateCells({ updates: [{ row: 0, column: 0, value: "x" }] }), { code: "read_only" });
  const source = new ArraySource({
    columns: ["name", "age", { name: "tags", type: "list" }, { name: "id", type: "integer", readOnly: true }],
    rows: rows.map((row, index) => [...row, "[]", index]),
    editable: true,
  });
  const info = await source.info();
  assert.equal(info.capabilities.edit, true);
  assert.deepEqual(info.edits, { version: 0, cells: 0 });
  assert.deepEqual(
    info.columns.map((item) => item.readOnly === true),
    [false, false, true, true],
  );
  const changes: TableChange[] = [];
  source.subscribe((change) => changes.push(change));
  await assert.rejects(
    source.updateCells({
      updates: [
        { row: 0, column: 0, value: "Ada L." },
        { row: 1, column: 1, value: "old" },
      ],
    }),
    { code: "invalid_value" },
  );
  await assert.rejects(source.updateCells({ updates: [{ row: 0, column: 3, value: 9 }] }), { code: "read_only" });
  await assert.rejects(source.updateCells({ updates: [{ row: 2, column: 0, value: "x" }] }), {
    code: "invalid_request",
  });
  await assert.rejects(source.updateCells({ updates: [{ row: 0, column: 0, value: "x", previous: "Adele" }] }), {
    code: "edit_conflict",
  });
  assert.deepEqual(changes, []);
  const view = await source.createView({ sort: [{ column: 1, direction: "desc" }] });
  const result = await source.updateCells({
    updates: [
      { row: 0, column: 1, value: "99", previous: 36 },
      { row: 1, column: 0, value: null },
    ],
  });
  assert.deepEqual(result, { updated: 2, edits: { version: 1, cells: 2 } });
  assert.deepEqual(changes, [{ edits: 1 }]);
  // Views keep their rows; a new view sorts by the new values.
  const old = await source.readRows({ view: view.id, start: 0, end: 2, columns: [0, 1] });
  assert.deepEqual(old.columns, [
    [null, "Ada"],
    [85, 99],
  ]);
  const sorted = await source.createView({ sort: [{ column: 1, direction: "desc" }] });
  assert.deepEqual((await source.readRows({ view: sorted.id, start: 0, end: 2, columns: [1] })).rowIds, [0, 1]);
  assert.equal((await source.columnStats(null, 1)).max, 99);
});

test("update requests are validated", () => {
  const request = parseProtocolRequest({
    op: "update",
    table: "t1",
    revision: "r1",
    updates: [
      { row: 0, column: 1, value: "x", previous: null },
      { row: 3, column: 0, value: null },
    ],
  });
  assert.deepEqual(request, {
    op: "update",
    table: "t1",
    revision: "r1",
    updates: [
      { row: 0, column: 1, value: "x", previous: null },
      { row: 3, column: 0, value: null },
    ],
  });
  assert.throws(() => parseProtocolRequest({ op: "update", table: "t1", updates: {} }), /updates must be an array/);
  assert.throws(() => parseProtocolRequest({ op: "update", table: "t1", updates: [{ row: -1, column: 0, value: 1 }] }));
  assert.throws(() => parseProtocolRequest({ op: "update", table: "t1", updates: [{ row: 0, column: 0 }] }), /missing/);
  assert.throws(() =>
    parseProtocolRequest({ op: "update", table: "t1", updates: Array.from({ length: 100_001 }, () => ({})) }),
  );
});

test("a remote source writes cells and does not report its own writes", async () => {
  let edits = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const result =
      body.op === "info"
        ? {
            table: "t1",
            columns: [],
            rowCount: 1,
            readableRows: 1,
            status: "ready",
            revision: "r",
            edits: { version: edits, cells: 0 },
            capabilities: {},
          }
        : body.op === "update"
          ? { updated: 1, edits: { version: ++edits, cells: 1 } }
          : { revision: "r", edits };
    return new Response(JSON.stringify({ result }));
  }) as typeof fetch;
  const checks: (() => Promise<boolean>)[] = [];
  const source = new RemoteSource({
    endpoint: "/api",
    ref: "a.csv",
    fetch: fetcher,
    changes: {
      watch: (watch) => {
        checks.push(() => watch.check());
        return () => undefined;
      },
    },
  });
  const changes: TableChange[] = [];
  source.subscribe((change) => changes.push(change));
  await source.info();
  const result = await source.updateCells({ revision: "r", updates: [{ row: 0, column: 0, value: 1 }] });
  assert.equal(result.edits.version, 1);
  assert.deepEqual(bodies[1], { op: "update", table: "t1", updates: [{ row: 0, column: 0, value: 1 }], revision: "r" });
  assert.equal(await checks[0](), false, "its own write");
  edits = 5;
  assert.equal(await checks[0](), true, "another client's write");
  assert.deepEqual(changes, [{ edits: 5 }]);
});

test("the row cache shows old values while it reads rows again, and patches cells", async () => {
  const data = [1, 2, 3, 4];
  const source = new ArraySource({ columns: [{ name: "n", type: "integer" }], columnData: [data], editable: true });
  const cache = new RowCache(source, { blockRows: 2 });
  cache.setView(null, 4, 4, 1);
  cache.want(0, 4, [0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.value(3, 0), 4);
  assert.ok(cache.patch(3, 0, 40));
  assert.equal(cache.value(3, 0), 40);
  assert.ok(!cache.patch(9, 0, 1), "not loaded");
  await source.updateCells({ updates: [{ row: 0, column: 0, value: 10 }] });
  cache.invalidate();
  assert.equal(cache.value(0, 0), 1, "the old value until the row is read again");
  cache.want(0, 4, [0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.value(0, 0), 10);
  assert.equal(cache.value(3, 0), 4, "the patch is replaced by the source's value");
});
