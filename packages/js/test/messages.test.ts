/**
 * The engine's messages (docs/v2-spec.md §8): every response follows §8 (the client checks each one), and
 * each operation answers as §8.2 says, or with the error of §8.7.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkResponse, FUNCTIONS, MEASURES, MESSAGE_LIMITS, planHash } from "vastgrid-spec";
import { MEMORY_CAPABILITIES, type MemoryTable, memoryEngine } from "../src/index.ts";
import { Client, type Json, single } from "./client.ts";

const ORDERS: MemoryTable = {
  columns: [
    { name: "id", type: "bigint" },
    { name: "region", type: "string" },
    { name: "qty", type: "integer" },
    { name: "price", type: "decimal", precision: 10, scale: 2, sourceType: "DECIMAL(10,2)" },
    { name: "rate", type: "float", readOnly: true },
  ],
  rows: [
    ["9223372036854775807", "Tokyo", 3, "12.50", 0.5],
    [2, "Osaka", 1, "8.00", "NaN"],
    [3, "tokyo bay", null, null, null],
    [4, "", 5, "100.00", "Infinity"],
    [5, "Nagoya", 2, "3.25", -1.25],
    [6, "Osaka", 7, "0.10", 2],
  ],
};

async function opened(tables: Record<string, MemoryTable> = { orders: ORDERS }) {
  const client = new Client(tables);
  return { client, info: await client.open(Object.keys(tables)[0]) };
}

test("open gives TableInfo with the capabilities of the engine; info and changes follow it", async () => {
  const { client, info } = await opened();
  assert.deepEqual(info, {
    table: info.table,
    revision: info.revision,
    edits: { version: 0, cells: 0 },
    status: "ready",
    progress: 1,
    rowCount: 6,
    readableRows: 6,
    columns: ORDERS.columns,
    capabilities: {
      plan: { derive: true, where: true, aggregate: true, pivot: true, having: true, sort: true, search: true },
      functions: [...FUNCTIONS],
      measures: [...MEASURES],
      summarize: true,
      find: true,
      locate: true,
      write: false,
      save: false,
      export: { formats: ["csv", "tsv", "json", "xlsx"], delivery: "data" },
      preview: false,
      partialViews: false,
      changes: "poll",
    },
  });
  assert.deepEqual(info.capabilities, MEMORY_CAPABILITIES);
  assert.deepEqual(await client.result("info", { table: info.table }), info);
  assert.deepEqual(await client.result("changes", { table: info.table }), {
    revision: info.revision,
    edits: { version: 0, cells: 0 },
  });
  // Another open gives another table ID with the same revision: the data is the same.
  const again = await client.open("orders");
  assert.notEqual(again.table, info.table);
  assert.equal(again.revision, info.revision);
  // The answer holds copies: changing them changes nothing in the engine.
  info.columns[0].name = "changed";
  assert.equal(((await client.result("info", { table: again.table })) as typeof info).columns[0].name, "id");
});

test("a ref that the host does not give is not_allowed; a closed or unknown table is table_not_found", async () => {
  const { client, info } = await opened();
  assert.equal((await client.error("open", { ref: "/etc/passwd" })).code, "not_allowed");
  assert.equal((await client.error("open", { ref: "constructor" })).code, "not_allowed");
  assert.equal(await client.result("close", { table: info.table }), null);
  for (const op of ["info", "changes", "close"] as const) {
    assert.equal((await client.error(op, { table: info.table })).code, "table_not_found", op);
  }
  assert.equal(
    (await client.error("rows", { table: "t99", revision: "r", plan: {}, start: 0, end: 1, columns: ["id"] })).code,
    "table_not_found",
  );
  // Opened again after its last close, the table is read again.
  const again = await client.open("orders");
  assert.equal(again.revision, info.revision);
});

test("a table that does not follow §2 fails to load, with the place at fault", async () => {
  const bad: Record<string, MemoryTable> = {
    type: { columns: [{ name: "x", type: "money" as never }], rows: [] },
    names: {
      columns: [
        { name: "x", type: "string" },
        { name: "x", type: "integer" },
      ],
      rows: [],
    },
    member: { columns: [{ name: "x", type: "string", width: 3 } as never], rows: [] },
    decimal: { columns: [{ name: "x", type: "decimal", precision: 4, scale: 2 }], rows: [["1.5"]] },
    arity: { columns: [{ name: "x", type: "string" }], rows: [["a", "b"]] },
    surrogate: { columns: [{ name: "x", type: "string" }], rows: [["a\uD800b"]] },
    nanos: { columns: [{ name: "x", type: "timestamp", unit: "ns" }], rows: [["2263-01-01 00:00:00"]] },
    interval: { columns: [{ name: "x", type: "interval" }], rows: [["1 fortnight"]] },
    long: { columns: [{ name: "x", type: "interval" }], rows: [["2562048000:00:00"]] },
    bigint: { columns: [{ name: "x", type: "bigint" }], rows: [[9007199254740992]] },
  };
  const client = new Client(bad);
  const where = {
    type: "/columns/0/type",
    names: "/columns/1/name",
    member: "/columns/0/width",
    decimal: "/rows/0/0",
    arity: "/rows/0",
    surrogate: "/rows/0/0",
    nanos: "/rows/0/0",
    interval: "/rows/0/0",
    long: "/rows/0/0",
    bigint: "/rows/0/0",
  };
  // The form of a table fails at open; a value fails when it is read, which sorting does for its whole column.
  const values = new Set(["decimal", "surrogate", "nanos", "interval", "long", "bigint"]);
  for (const [ref, path] of Object.entries(where)) {
    let error: { code: string; message: string };
    if (values.has(ref)) {
      const info = await client.open(ref);
      error = await client.error("rows", {
        table: info.table,
        revision: info.revision,
        plan: {},
        start: 0,
        end: 1,
        columns: ["x"],
      });
      const sorted = await client.error("rows", {
        table: info.table,
        revision: info.revision,
        plan: { sort: [{ column: "x", direction: "asc" }] },
        start: 0,
        end: 1,
        columns: ["x"],
      });
      assert.equal(sorted.code, "load_failed", `${ref}, sorted`);
    } else {
      error = await client.error("open", { ref });
    }
    assert.equal(error.code, "load_failed", ref);
    assert.ok(error.message.includes(`at ${path},`), `${ref}: ${error.message}`);
  }
  const none = await new Client({ none: null as never }).error("open", { ref: "none" });
  assert.equal(
    none.message,
    'The table "none" cannot be read: A table is an object: { columns, rows }, { arrow } or { file }.',
  );
  assert.throws(() => memoryEngine({} as never), TypeError);
});

/** A list in `levels` lists. */
function nested(levels: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < levels; level++) value = [value];
  return value;
}

test("requests that do not follow §8 are answered with invalid_request, its path and reason", async () => {
  const { client, info } = await opened();
  const engine = client.engine;
  const base = { table: info.table, revision: info.revision, plan: {} };
  const rows = { ...base, start: 0, end: 1, columns: ["id"] };
  const cases: [unknown, string, string][] = [
    [{ v: 1, id: 1, op: "info", table: info.table }, "version", "/v"],
    [{ v: 2, id: 1, op: "query" }, "unknown_op", "/op"],
    [{ v: 2, id: 1, op: "rows", ...rows, sql: "SELECT 1" }, "syntax", "/sql"],
    [{ v: 2, id: 1, op: "rows", ...rows, end: undefined }, "syntax", "/end"],
    [{ v: 2, id: 1, op: "rows", ...rows, start: 5, end: 4 }, "syntax", "/end"],
    [{ v: 2, id: 1, op: "rows", ...rows, end: 1_000_001 }, "limit", "/end"],
    [{ v: 2, id: 1, op: "rows", ...rows, end: 500_001, columns: ["id", "qty"] }, "limit", "/columns"],
    [{ v: 2, id: 1, op: "rows", ...rows, textLimit: 0 }, "syntax", "/textLimit"],
    [{ v: 2, id: 1, op: "rows", ...rows, columns: "id" }, "syntax", "/columns"],
    [{ v: 2, id: 1, op: "rows", ...rows, columns: ["id", "zzz"] }, "syntax", "/columns/1"],
    [{ v: 2, id: 1, op: "summarize", ...base, ranges: [[0, 1]], columns: ["zzz"] }, "syntax", "/columns/0"],
    [{ v: 2, id: 1, op: "summarize", ...base, ranges: [[0, 1]], columns: ["id"], start: 0 }, "syntax", "/start"],
    [{ v: 2, id: 1, op: "locate", ...base, keys: [{ value: 3 }] }, "syntax", "/rowKey"],
    [{ v: 2, id: 1, op: "locate", ...base, keys: [{ value: 3 }], rowKey: "zzz" }, "syntax", "/rowKey"],
    [{ v: 2, id: 1, op: "locate", ...base, keys: [{ rowId: -1 }] }, "syntax", "/keys/0/rowId"],
    // Strings in plans and keys, which checkRequest does not read, hold at most 1,000,000 code points (§8.1).
    [
      { v: 2, id: 1, op: "rows", ...rows, plan: { sort: [{ column: "x".repeat(1_000_001), direction: "asc" }] } },
      "limit",
      "/plan/sort/0/column",
    ],
    [
      { v: 2, id: 1, op: "locate", ...base, keys: [{ value: "😀".repeat(1_000_001) }], rowKey: "region" },
      "limit",
      "/keys/0/value",
    ],
    // A name that is too long cannot be in a path: the error names the object that holds it.
    [{ v: 2, id: 1, op: "rows", ...rows, plan: { ["x".repeat(1_000_001)]: 1 } }, "limit", "/plan"],
    [{ v: 2, id: 1, op: "rows", ...rows, ["y".repeat(1_000_001)]: 1 }, "limit", ""],
    // Values, levels and items are checked through the whole message (§8.1).
    [
      {
        v: 2,
        id: 1,
        op: "write",
        ...base,
        updates: [{ key: { rowId: 0 }, column: "region", value: "z".repeat(1_000_001) }],
      },
      "limit",
      "/updates/0/value",
    ],
    [{ v: 2, id: 1, op: "rows", ...rows, plan: { where: nested(300) } }, "limit", `/plan/where${"/0".repeat(254)}`],
    [{ v: 2, id: 1, op: "rows", ...rows, plan: { sort: new Array(1_000_001).fill(0) } }, "limit", "/plan/sort"],
  ];
  for (const [message, reason, path] of cases) {
    const response = (await engine.handle(message)) as Json;
    checkResponse(response, ((message as Json).op as never) ?? "info");
    const error = response.error as Json;
    assert.deepEqual([error.code, error.reason, error.path], ["invalid_request", reason, path], JSON.stringify(path));
  }
  // A plan member named by 1,000,000 code points is within the limit, but its path is not: the error's path
  // is cut to the plan, and its message to 1,000 code points.
  const named = (await engine.handle({
    v: 2,
    id: 1,
    op: "rows",
    ...rows,
    plan: { ["z".repeat(1_000_000)]: 1 },
  })) as Json;
  checkResponse(named, "rows");
  const error = named.error as { code: string; reason: string; path: string; message: string };
  assert.deepEqual([error.code, error.reason, error.path], ["invalid_plan", "syntax", ""]);
  assert.equal([...error.message].length, 1000);
  // A message without an id that can be answered is answered with a null id, which no request has (§8.1); the
  // engine never throws.
  for (const message of [undefined, null, 42, "rows", [], { v: 2 }, { v: 2, id: -1, op: "info" }, new Uint8Array(4)]) {
    const response = (await engine.handle(message)) as Json;
    checkResponse(response, "info");
    assert.equal(response.id, null);
    assert.equal((response.error as Json).code, "invalid_request");
  }
  assert.equal(((await engine.handle({ v: 2, id: 7, op: "info" })) as Json).id, 7);
  assert.equal(((await engine.handle({ v: 2, id: 0, op: "info" })) as Json).id, 0);
});

test("plans are checked against the table and the engine's capabilities (§4.7, §4.10)", async () => {
  const { client, info } = await opened();
  const rows = { table: info.table, revision: info.revision, start: 0, end: 1, columns: ["id"] };
  const plans: [unknown, string, string][] = [
    [{ sort: [{ column: "zzz", direction: "asc" }] }, "unknown_column", "/sort/0/column"],
    [{ sort: [{ column: "id", direction: "up" }] }, "syntax", "/sort/0/direction"],
    [{ where: { fn: "eq", args: [{ col: "region" }, { lit: 1 }] } }, "type", "/where"],
    [{ where: { col: "qty" } }, "type", "/where"],
    [{ derive: [{ name: "id", expr: { lit: 1 } }] }, "duplicate_name", "/derive/0/name"],
    [{ aggregate: { keys: ["zzz"], measures: [] } }, "unknown_column", "/aggregate/keys/0"],
    [{ having: { lit: true } }, "misplaced", "/having"],
    [{ filter: {} }, "syntax", "/filter"],
    [{ sort: Array.from({ length: 33 }, () => ({ column: "id", direction: "asc" })) }, "limit", "/sort"],
  ];
  for (const [plan, reason, path] of plans) {
    const error = await client.error("rows", { ...rows, plan });
    assert.deepEqual([error.code, error.reason, error.path], ["invalid_plan", reason, path], JSON.stringify(plan));
  }
});

test("requests at another revision fail with revision_changed (§8.3)", async () => {
  const { client, info } = await opened();
  const at = { table: info.table, revision: "r0", plan: {} };
  assert.equal((await client.error("rows", { ...at, start: 0, end: 1, columns: ["id"] })).code, "revision_changed");
  assert.equal(
    (await client.error("summarize", { ...at, ranges: [[0, 1]], columns: ["id"] })).code,
    "revision_changed",
  );
  assert.equal((await client.error("locate", { ...at, keys: [{ rowId: 0 }] })).code, "revision_changed");
  assert.equal(
    (await client.error("write", { table: info.table, revision: "r0", updates: [] })).code,
    "revision_changed",
  );
});

test("rows answers a view: its hash, its row IDs and a block of the columns asked for, in their order", async () => {
  const { client, info } = await opened();
  const plan = { sort: [{ column: "price", direction: "desc" as const }] };
  const read = await client.rows(info, plan, { columns: ["price", "id", "region"] });
  assert.deepEqual(read.view, {
    hash: await planHash(plan),
    status: "ready",
    rowCount: 6,
    rowCountExact: true,
    readableRows: 6,
    columns: ORDERS.columns,
    edits: { version: 0, cells: 0 },
  });
  assert.deepEqual(read.rowIds, [3, 0, 1, 4, 5, 2]);
  assert.deepEqual(read.rows, [
    ["100.00", 4, ""],
    ["12.50", "9223372036854775807", "Tokyo"],
    ["8.00", 2, "Osaka"],
    ["3.25", 5, "Nagoya"],
    ["0.10", 6, "Osaka"],
    [null, 3, "tokyo bay"],
  ]);
  assert.deepEqual(
    read.columns.map((column) => [column.name, column.type]),
    [
      ["price", "decimal"],
      ["id", "bigint"],
      ["region", "string"],
    ],
  );
  // The block is in the structured encoding (§8.8).
  const response = await client.send("rows", {
    table: info.table,
    revision: info.revision,
    plan: {},
    start: 0,
    end: 1,
    columns: ["rate"],
  });
  assert.ok(((response.result as Json).block as { bytes: unknown }).bytes instanceof Uint8Array);
  // Plans of one normal form are one view (§4.8).
  assert.equal((await client.rows(info, { sort: [] })).view.hash, (await client.rows(info, {})).view.hash);
});

test("rows reads positions within the view: end is cut to the rows, and a start beyond them reads none", async () => {
  const { client, info } = await opened();
  const plan = { sort: [{ column: "qty", direction: "asc" as const }] };
  const middle = await client.rows(info, plan, { start: 2, end: 4, columns: ["qty"] });
  assert.deepEqual([middle.start, middle.end, middle.rowIds, middle.rows], [2, 4, [0, 3], [[3], [5]]]);
  const tail = await client.rows(info, plan, { start: 4, end: 100, columns: ["qty"] });
  assert.deepEqual([tail.start, tail.end, tail.rowIds, tail.rows], [4, 6, [5, 2], [[7], [null]]]);
  const beyond = await client.rows(info, plan, { start: 10, end: 20, columns: ["qty"] });
  assert.deepEqual([beyond.start, beyond.end, beyond.rowIds, beyond.rows], [10, 10, [], []]);
  const none = await client.rows(info, plan, { start: 1, end: 1, columns: ["qty"] });
  assert.deepEqual([none.start, none.end, none.rowIds, none.rows], [1, 1, [], []]);
  // A column may be read twice.
  assert.deepEqual((await client.rows(info, {}, { end: 1, columns: ["qty", "qty"] })).rows, [[3, 3]]);
});

test("rows of no columns answers the view, its positions and row IDs, and a block without columns (§8.2)", async () => {
  const { client, info } = await opened();
  const read = await client.rows(info, {}, { start: 1, end: 100, columns: [] });
  assert.deepEqual(read.view, {
    hash: await planHash({}),
    status: "ready",
    rowCount: 6,
    rowCountExact: true,
    readableRows: 6,
    columns: ORDERS.columns,
    edits: { version: 0, cells: 0 },
  });
  assert.deepEqual([read.start, read.end, read.rowIds], [1, 6, [1, 2, 3, 4, 5]]);
  // The block is a schema without fields and without a record batch (§8.4).
  assert.deepEqual([read.columns, read.rows], [[], []]);
});

test("textLimit cuts strings longer than it, in code points, and truncated gives their offsets (§8.4)", async () => {
  const long = "a".repeat(2001);
  const table: MemoryTable = {
    columns: [
      { name: "s", type: "string" },
      { name: "__proto__", type: "string" },
      { name: "n", type: "integer" },
    ],
    rows: [
      ["😀😀😀", "abcd", 1],
      ["ab", "abc", 2],
      ["😀😀😀😀", "a😀", 3],
      [long, null, 4],
      [null, "", 5],
    ],
  };
  const { client, info } = await opened({ t: table });
  const cut = await client.rows(info, {}, { start: 0, end: 4, textLimit: 3 });
  assert.deepEqual(cut.rows, [
    ["😀😀😀", "abc", 1],
    ["ab", "abc", 2],
    ["😀😀😀", "a😀", 3],
    ["aaa", null, 4],
  ]);
  assert.deepEqual(cut.truncated, { s: [2, 3], ["__proto__"]: [0] });
  assert.ok(Object.hasOwn(cut.truncated as object, "__proto__"));
  // Offsets count from start.
  assert.deepEqual((await client.rows(info, {}, { start: 2, end: 5, textLimit: 3, columns: ["s", "s"] })).truncated, {
    s: [0, 1],
  });
  // By default, strings are cut at 2,000 code points.
  const read = await client.rows(info, {}, { start: 3, end: 4, columns: ["s"] });
  assert.equal(read.rows[0][0], "a".repeat(MESSAGE_LIMITS.textLimitDefault));
  assert.deepEqual(read.truncated, { s: [0] });
  // Nothing cut, no truncated.
  assert.equal((await client.rows(info, {}, { start: 0, end: 3, columns: ["n"], textLimit: 1 })).truncated, undefined);
});

test("locate gives positions of row IDs, and of values of rowKey at their first position in the view", async () => {
  const { client, info } = await opened();
  const at = { table: info.table, revision: info.revision };
  const locate = async (plan: unknown, keys: unknown[], rowKey?: string) =>
    ((await client.result("locate", { ...at, plan, keys, ...(rowKey ? { rowKey } : {}) })) as { rows: unknown[] }).rows;
  const byPrice = { sort: [{ column: "price", direction: "desc" }] };
  assert.deepEqual(await locate(byPrice, [{ rowId: 0 }, { rowId: 2 }, { rowId: 3 }, { rowId: 6 }]), [1, 5, 0, null]);
  assert.deepEqual(await locate({}, [{ rowId: 4 }, { rowId: 99 }]), [4, null]);
  // "Osaka" is rows 1 and 5: a value that repeats is found at its first position in the view, whichever row
  // holds it there. By rate, row 5 (2) comes before row 1 (NaN).
  const byQty = (direction: string) => ({ sort: [{ column: "qty", direction }] });
  assert.deepEqual(await locate(byQty("asc"), [{ value: "Osaka" }], "region"), [0]);
  assert.deepEqual(await locate(byQty("desc"), [{ value: "Osaka" }], "region"), [0]);
  assert.deepEqual(await locate({ sort: [{ column: "rate", direction: "asc" }] }, [{ value: "Osaka" }], "region"), [2]);
  assert.deepEqual(await locate({}, [{ value: "Osaka" }], "region"), [1]);
  // Values are equal by §3.1: exact numbers whatever their form or scale, NaN equal to NaN.
  assert.deepEqual(
    await locate({}, [{ value: "1.5" }, { value: "12.5" }, { value: "12.500" }, { value: 12.5 }], "price"),
    [null, 0, 0, null],
  );
  assert.deepEqual(
    await locate({}, [{ value: 2 ** 63 }, { value: "9223372036854775807" }, { value: "4" }, { value: 4 }], "id"),
    [null, 0, 3, 3],
  );
  assert.deepEqual(await locate({}, [{ value: "NaN" }, { value: "Infinity" }, { value: 2 }, { value: "2" }], "rate"), [
    1,
    3,
    5,
    null,
  ]);
  // The empty string finds the rows that hold it, and nothing finds null.
  assert.deepEqual(await locate({}, [{ value: "" }, { value: "Kyoto" }, { value: 3 }], "region"), [3, null, null]);
  // A key that is not a value of the column's type finds nothing.
  assert.deepEqual(await locate({}, [{ value: "three" }, { value: 2.5 }, { value: true }], "qty"), [null, null, null]);
});

test("locate finds values of every type, by their first position", async () => {
  const table: MemoryTable = {
    columns: [
      { name: "f", type: "float" },
      { name: "f32", type: "float", bits: 32 },
      { name: "t", type: "timestamp" },
      { name: "i", type: "interval" },
      { name: "u", type: "uuid" },
      { name: "b", type: "binary" },
      { name: "s", type: "string" },
      { name: "d", type: "decimal", precision: 30, scale: 1 },
    ],
    rows: [
      [
        -0,
        Math.fround(0.1),
        "2024-01-31 12:00:00.5",
        "1 month",
        "00000000-0000-0000-0000-000000000001",
        "AA==",
        "😀",
        "-0.5",
      ],
      [
        0,
        Math.fround(16777217),
        "2024-01-31 12:00:00",
        "30 days",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "",
        "｡",
        "1234567890123456789012345678.9",
      ],
    ],
  };
  const { client, info } = await opened({ t: table });
  const locate = async (rowKey: string, keys: unknown[]) =>
    (
      (await client.result("locate", {
        table: info.table,
        revision: info.revision,
        plan: { sort: [{ column: rowKey, direction: "desc" }] },
        keys: keys.map((value) => ({ value })),
        rowKey,
      })) as { rows: unknown[] }
    ).rows;
  // Desc keeps ties in row ID order: −0.0 and 0.0 are equal, and row 0 comes first.
  assert.deepEqual(await locate("f", [0, -0, 1]), [0, 0, null]);
  // Keys are typed JSON too: 0.1 is not a binary32 value, so it cannot match a row.
  assert.deepEqual(await locate("f32", [16777216, Math.fround(0.1), 0.1, 0.2]), [0, 1, null, null]);
  assert.deepEqual(await locate("t", ["2024-01-31 12:00:00", "2024-01-31 12:00:00.50", "2024-01-31 12:00:00.5"]), [
    1,
    null,
    0,
  ]);
  assert.deepEqual(await locate("i", ["30 days", "1 month", "720:00:00", "1 day"]), [0, 0, 0, null]);
  assert.deepEqual(
    await locate("u", ["00000000-0000-0000-0000-000000000001", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"]),
    [1, null],
  );
  assert.deepEqual(await locate("b", ["", "AA==", "AQ=="]), [1, 0, null]);
  assert.deepEqual(await locate("s", ["😀", "｡", "\uD83D"]), [0, 1, null]);
  assert.deepEqual(await locate("d", ["1234567890123456789012345678.90", "-0.50", "-0.51", "1e3"]), [0, 1, null, null]);
});

test("summarize counts the cells that are not blank, and sums the finite numbers exactly", async () => {
  const { client, info } = await opened();
  const summarize = async (ranges: [number, number][], columns: string[], plan: unknown = {}) =>
    client.result("summarize", { table: info.table, revision: info.revision, plan, ranges, columns });
  // price: 12.50 + 8.00 + 100.00 + 3.25 + 0.10, exactly; null is not a cell with a value.
  assert.deepEqual(await summarize([[0, 6]], ["price"]), {
    count: 5,
    numericCount: 5,
    sum: 123.85,
    min: 0.1,
    max: 100,
    average: 123.85 / 5,
  });
  // rate: NaN and Infinity count as cells, not as numbers.
  assert.deepEqual(await summarize([[0, 6]], ["rate"]), {
    count: 5,
    numericCount: 3,
    sum: 1.25,
    min: -1.25,
    max: 2,
    average: 1.25 / 3,
  });
  // region: the empty string is blank, and strings are not numbers.
  assert.deepEqual(await summarize([[0, 6]], ["region"]), {
    count: 5,
    numericCount: 0,
    sum: null,
    min: null,
    max: null,
    average: null,
  });
  // Overlapping ranges and a repeated column count each cell once; ranges are cut to the view.
  assert.deepEqual(
    await summarize(
      [
        [0, 2],
        [1, 3],
        [5, 50],
      ],
      ["qty", "qty"],
    ),
    { count: 3, numericCount: 3, sum: 11, min: 1, max: 7, average: 11 / 3 },
  );
  // Positions are positions of the plan's view.
  assert.deepEqual(await summarize([[0, 2]], ["qty"], { sort: [{ column: "qty", direction: "desc" }] }), {
    count: 2,
    numericCount: 2,
    sum: 12,
    min: 5,
    max: 7,
    average: 6,
  });
  // bigints: 2^63 − 1 + 2 + 3 + 4 + 5 + 6, exactly, then as a float.
  const ids = (await summarize([[0, 6]], ["id"])) as Json;
  assert.equal(ids.sum, Number(9223372036854775807n + 20n));
  assert.equal(ids.max, 2 ** 63);
  assert.deepEqual(await summarize([], ["id"]), {
    count: 0,
    numericCount: 0,
    sum: null,
    min: null,
    max: null,
    average: null,
  });
});

test("summarize: decimals add without float error, floats with compensation, and sums beyond floats", async () => {
  const table: MemoryTable = {
    columns: [
      { name: "d", type: "decimal", precision: 38, scale: 2 },
      { name: "f", type: "float" },
      { name: "b", type: "bigint" },
    ],
    rows: [
      ["0.10", 1.7e308, "9223372036854775807"],
      ["0.20", 1.7e308, "9223372036854775807"],
      ["999999999999999999999999999999999999.99", -1.7e308, "-9223372036854775808"],
      ["-999999999999999999999999999999999999.99", "NaN", null],
      [null, "-Infinity", 1],
    ],
  };
  const { client, info } = await opened({ t: table });
  const summarize = async (ranges: [number, number][], columns: string[]) =>
    client.result("summarize", { table: info.table, revision: info.revision, plan: {}, ranges, columns });
  // 0.10 + 0.20 is 0.3, the float nearest to the exact sum, not 0.30000000000000004.
  assert.equal(((await summarize([[0, 2]], ["d"])) as Json).sum, 0.3);
  assert.equal(((await summarize([[0, 5]], ["d"])) as Json).sum, 0.3);
  // A sum beyond the largest float is "Infinity"; the average of the same numbers is still a float.
  assert.deepEqual(await summarize([[0, 2]], ["f"]), {
    count: 2,
    numericCount: 2,
    sum: "Infinity",
    min: 1.7e308,
    max: 1.7e308,
    average: 1.7e308,
  });
  // Coming back within the floats, the sum is finite again: 1.7e308 + 1.7e308 − 1.7e308.
  assert.equal(((await summarize([[0, 3]], ["f"])) as Json).sum, 1.7e308);
  // bigints: the sum of 2^63 − 1, 2^63 − 1, −2^63 and 1 is 2^63, beyond 64 bits but exact.
  assert.equal(((await summarize([[0, 5]], ["b"])) as Json).sum, 2 ** 63);
  // Columns of several types: one sum.
  assert.deepEqual(await summarize([[4, 5]], ["d", "f", "b"]), {
    count: 2,
    numericCount: 1,
    sum: 1,
    min: 1,
    max: 1,
    average: 1,
  });
  const negative = new Client({
    t: single({ type: "float" }, [-1.7e308, -1.7e308]),
  });
  const negativeInfo = await negative.open("t");
  assert.deepEqual(
    await negative.result("summarize", {
      table: negativeInfo.table,
      revision: negativeInfo.revision,
      plan: {},
      ranges: [[0, 2]],
      columns: ["x"],
    }),
    { count: 2, numericCount: 2, sum: "-Infinity", min: -1.7e308, max: -1.7e308, average: -1.7e308 },
  );
});

test("a table without rows has views without rows, and open ignores the options of files", async () => {
  const client = new Client({ empty: { columns: [{ name: "x", type: "float" }], rows: [] } });
  const info = (await client.result("open", { ref: "empty", read: { headerRow: 2, keepEmptyRows: true } })) as {
    table: string;
    revision: string;
    rowCount: number;
  };
  assert.equal(info.rowCount, 0);
  const at = { table: info.table, revision: info.revision, plan: { sort: [{ column: "x", direction: "desc" }] } };
  const read = (await client.result("rows", { ...at, start: 0, end: 10, columns: ["x"] })) as Json;
  assert.deepEqual([read.start, read.end, read.rowIds, (read.view as Json).rowCount], [0, 0, [], 0]);
  assert.deepEqual(await client.result("locate", { ...at, keys: [{ rowId: 0 }, { value: 1 }], rowKey: "x" }), {
    rows: [null, null],
  });
  assert.deepEqual(await client.result("summarize", { ...at, ranges: [[0, 10]], columns: ["x"] }), {
    count: 0,
    numericCount: 0,
    sum: null,
    min: null,
    max: null,
    average: null,
  });
});

test("find goes row by row from the cell after from, wraps around and ends with from (§8.2)", async () => {
  const { client, info } = await opened();
  const at = { table: info.table, revision: info.revision, plan: { sort: [{ column: "qty", direction: "asc" }] } };
  // The view by qty, null last: positions 0–5 are rows 1, 4, 0, 3, 5, 2.
  const find = (text: string, from: { row: number; column: number }, direction = 1, more: Json = {}) =>
    client.result("find", { ...at, text, columns: ["region", "rate", "price"], from, direction, ...more });
  // "osaka" in any case: Osaka at positions 0 and 4.
  assert.deepEqual(await find("osaka", { row: 0, column: 0 }), { row: 4, column: 0 });
  assert.deepEqual(await find("osaka", { row: 4, column: 0 }), { row: 0, column: 0 });
  assert.deepEqual(await find("osaka", { row: 4, column: 0 }, -1), { row: 0, column: 0 });
  // Only from itself matches: it is found last.
  assert.deepEqual(await find("nagoya", { row: 1, column: 0 }), { row: 1, column: 0 });
  // Floats and decimals by their text form (§2.4): nan, inf, 12.50.
  assert.deepEqual(await find("NAN", { row: 2, column: 2 }), { row: 0, column: 1 });
  assert.deepEqual(await find("inf", { row: 0, column: 0 }), { row: 3, column: 1 });
  assert.deepEqual(await find("12.5", { row: 0, column: 0 }), { row: 2, column: 2 });
  // Before from in its row, with −1, then the rows before it.
  assert.deepEqual(await find(".", { row: 2, column: 2 }, -1), { row: 2, column: 1 });
  assert.deepEqual(await find("0", { row: 0, column: 0 }, -1), { row: 4, column: 2 });
  // Case-sensitive; an empty text and a text that is nowhere find nothing; null matches nothing.
  assert.equal(await find("osaka", { row: 0, column: 0 }, 1, { caseSensitive: true }), null);
  assert.deepEqual(await find("Osaka", { row: 0, column: 0 }, 1, { caseSensitive: true }), { row: 4, column: 0 });
  assert.equal(await find("", { row: 0, column: 0 }), null);
  assert.equal(await find("null", { row: 0, column: 0 }), null);
  // A column that the view does not have.
  const missing = await client.error("find", {
    ...at,
    text: "a",
    columns: ["nope"],
    from: { row: 0, column: 0 },
    direction: 1,
  });
  assert.deepEqual([missing.code, missing.path], ["invalid_request", "/columns/0"]);
});

test("export answers the view's rows as the bytes of a file, as the DuckDB engine writes them (§8.2)", async () => {
  const { client, info } = await opened();
  const at = {
    table: info.table,
    revision: info.revision,
    plan: {
      where: {
        fn: "and",
        args: [
          { fn: "gt", args: [{ col: "id" }, { lit: 3 }] },
          { fn: "lt", args: [{ col: "id" }, { lit: 100 }] },
        ],
      },
    },
  };
  const text = async (members: Json) => {
    const result = (await client.result("export", { ...at, ...members })) as {
      target: null;
      rows: number;
      data: { bytes: Uint8Array };
    };
    assert.equal(result.target, null);
    return { rows: result.rows, text: new TextDecoder().decode(result.data.bytes) };
  };
  assert.deepEqual(await text({ format: "csv" }), {
    rows: 3,
    text: 'id,region,qty,price,rate\n4,"",5,100.00,inf\n5,Nagoya,2,3.25,-1.25\n6,Osaka,7,0.10,2.0\n',
  });
  assert.deepEqual(await text({ format: "tsv", columns: ["region", "region"], headers: ["a\tb", "c"] }), {
    rows: 3,
    text: '"a\tb"\tc\n""\t""\nNagoya\tNagoya\nOsaka\tOsaka\n',
  });
  assert.deepEqual(await text({ format: "json", columns: ["id", "price", "rate", "region"] }), {
    rows: 3,
    text: '[\n\t{"id":4,"price":100.00,"rate":"inf","region":""},\n\t{"id":5,"price":3.25,"rate":-1.25,"region":"Nagoya"},\n\t{"id":6,"price":0.10,"rate":2.0,"region":"Osaka"}\n]\n',
  });
  // All rows: a bigint beyond 2^53 keeps its digits, and null is an empty field or null.
  const all = { ...at, plan: {} };
  const json = (await client.result("export", { ...all, format: "json", columns: ["id", "qty"] })) as {
    data: { bytes: Uint8Array };
  };
  assert.match(
    new TextDecoder().decode(json.data.bytes),
    /^\[\n\t\{"id":9223372036854775807,"qty":3\},\n.*\{"id":3,"qty":null\}/s,
  );
  const xlsx = (await client.result("export", {
    ...all,
    format: "xlsx",
    numberFormats: [null, null, null, "#,##0.00", null],
  })) as {
    rows: number;
    data: { bytes: Uint8Array };
  };
  assert.equal(xlsx.rows, 6);
  assert.deepEqual([...xlsx.data.bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  // Parquet is not written here, and a target is not allowed: the engine answers data.
  const parquet = await client.error("export", { ...all, format: "parquet" });
  assert.deepEqual([parquet.code, parquet.path], ["invalid_request", "/format"]);
  assert.equal((await client.error("export", { ...all, format: "csv", target: "out.csv" })).code, "not_allowed");
});

test("a find or export of many rows lets a cancel in, and answers cancelled (§8.6)", async () => {
  const count = 2_000_000;
  const rows = Array.from({ length: count }, (_, index) => [index % 1_000 === 999 ? "a" : "b"]);
  rows[count - 1] = ["needle"];
  const { client, info } = await opened({ big: { columns: [{ name: "x", type: "string" }], rows } });
  const engine = client.engine;
  const at = { table: info.table, revision: info.revision, plan: {} };
  const pending = engine.handle({
    v: 2,
    id: 900,
    op: "find",
    ...at,
    text: "needle",
    columns: ["x", "x", "x"],
    from: { row: 0, column: 0 },
    direction: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await engine.handle({ v: 2, id: 901, op: "cancel", request: 900 });
  assert.equal(((await pending) as { error: Json }).error.code, "cancelled");
  const exporting = engine.handle({ v: 2, id: 902, op: "export", ...at, format: "csv" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await engine.handle({ v: 2, id: 903, op: "cancel", request: 902 });
  assert.equal(((await exporting) as { error: Json }).error.code, "cancelled");
  // Not cancelled, the find finds it.
  assert.deepEqual(
    await client.result("find", { ...at, text: "needle", columns: ["x"], from: { row: 0, column: 0 }, direction: 1 }),
    { row: count - 1, column: 0 },
  );
});

test("operations the engine does not offer get the error that says so", async () => {
  const { client, info } = await opened();
  const update = { key: { rowId: 0 }, column: "qty", value: 1 };
  assert.equal(
    (await client.error("write", { table: info.table, revision: info.revision, updates: [update] })).code,
    "read_only",
  );
  assert.equal((await client.error("save", { table: info.table })).code, "save_unsupported");
  assert.equal((await client.error("save", { table: "t99" })).code, "table_not_found");
});

test("cancel has no answer, and a request cancelled before its view is made answers cancelled (§8.6)", async () => {
  const { client, info } = await opened();
  const engine = client.engine;
  assert.equal(await engine.handle({ v: 2, id: 50, op: "cancel", request: 49 }), undefined);
  const pending = engine.handle({
    v: 2,
    id: 51,
    op: "rows",
    table: info.table,
    revision: info.revision,
    plan: { sort: [{ column: "region", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["region"],
  });
  assert.equal(await engine.handle({ v: 2, id: 52, op: "cancel", request: 51 }), undefined);
  const response = (await pending) as Json;
  checkResponse(response, "rows");
  assert.deepEqual([response.id, (response.error as Json).code], [51, "cancelled"]);
  // The engine sends no events; subscribing and unsubscribing work.
  const events: unknown[] = [];
  const unsubscribe = engine.subscribe((event) => events.push(event));
  await client.rows(info, {});
  unsubscribe();
  assert.deepEqual(events, []);
});
