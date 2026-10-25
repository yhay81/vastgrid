import assert from "node:assert/strict";
import { test } from "node:test";
import { readCellText, type ValueType } from "vastgrid-spec";
import type { MemoryTable } from "../src/index.ts";
import { Client } from "./client.ts";

test("writes reject lossy values atomically, and float32 edits persist the rounded value", async () => {
  const cases: [ValueType, string | number, string | number][] = [
    [{ type: "timestamp", unit: "ns" }, "2024-01-01 00:00:00", "9999-12-31 23:59:59.999999999"],
    [{ type: "float", bits: 32 }, 1, 1e39],
    [{ type: "float", bits: 32 }, 1, 0.1],
    [{ type: "string" }, "ok", "\ud800"],
  ];
  for (const [type, initial, invalid] of cases) {
    const columns = [
      { name: "safe", type: "integer" as const },
      { name: "value", ...type },
    ];
    const client = new Client({ t: { columns, rows: [[1, initial]], editable: true } });
    const info = await client.open("t");
    const error = await client.error("write", {
      table: info.table,
      revision: info.revision,
      updates: [
        { key: { rowId: 0 }, column: "safe", value: 2 },
        { key: { rowId: 0 }, column: "value", value: invalid },
      ],
    });
    assert.equal(error.code, "invalid_value");
    assert.equal(error.path, "/updates/1/value");
    assert.equal(error.reason, "type");
    assert.deepEqual((await client.rows(info, {})).rows, [[1, initial]]);
    if (type.type === "float") {
      const input = readCellText("0.1", type);
      assert.ok(input.ok);
      await client.result("write", {
        table: info.table,
        revision: info.revision,
        updates: [{ key: { rowId: 0 }, column: "value", value: input.value }],
      });
      assert.deepEqual((await client.rows(info, {})).rows, [[1, Math.fround(0.1)]]);
    }
  }
});

function orders(): MemoryTable {
  return {
    editable: true,
    columns: [
      { name: "id", type: "bigint" },
      { name: "city", type: "string" },
      { name: "price", type: "decimal", precision: 6, scale: 2 },
      { name: "note", type: "string", readOnly: true },
    ],
    rows: [
      [10, "Tokyo", "1.50", "a"],
      [20, "Osaka", "3.00", "b"],
      [30, "Kobe", "2.25", "c"],
    ],
  };
}

test("an editable table is written by row ID or by key, and every later request sees it (§7.2)", async () => {
  const table = orders();
  const client = new Client({ orders: table });
  const info = await client.open("orders");
  assert.equal((info.capabilities as { write?: boolean }).write, true);
  const events: unknown[] = [];
  client.engine.subscribe((event) => events.push(event));
  const written = await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [
      { key: { rowId: 1 }, column: "city", value: "Nara", previous: "Osaka" },
      { key: { value: 30 }, column: "price", value: "0.75" },
    ],
    rowKey: "id",
  });
  assert.deepEqual(written, { updated: 2, edits: { version: 1, cells: 2 } });
  assert.deepEqual(events, [
    { v: 2, event: "changed", table: info.table, revision: info.revision, edits: { version: 1, cells: 2 } },
  ]);
  const rows = await client.rows(
    info,
    { sort: [{ column: "price", direction: "asc" }] },
    { columns: ["id", "city", "price"] },
  );
  assert.deepEqual(rows.rows, [
    [30, "Kobe", "0.75"],
    [10, "Tokyo", "1.50"],
    [20, "Nara", "3.00"],
  ]);
  assert.deepEqual(table.rows[1], [20, "Osaka", "3.00", "b"], "the host's rows stay as they were");
  // A table that holds written values keeps them when every ID is closed and it is opened again.
  await client.result("close", { table: info.table });
  const again = await client.open("orders");
  assert.deepEqual((await client.rows(again, {}, { columns: ["city"] })).rows[1], ["Nara"]);
  assert.deepEqual(await client.result("changes", { table: again.table }), {
    revision: again.revision,
    edits: { version: 1, cells: 2 },
  });
});

test("a write fails as a whole: conflicts, values of other types and cells that are not written (§7.2)", async () => {
  const client = new Client({ orders: orders(), fixed: { ...orders(), editable: false } });
  const info = await client.open("orders");
  const base = { table: info.table, revision: info.revision };
  const fail = async (updates: unknown[], code: string) => {
    const error = await client.error("write", { ...base, updates });
    assert.equal(error.code, code, JSON.stringify(updates));
  };
  await fail([{ key: { rowId: 0 }, column: "city", value: "X", previous: "Kyoto" }], "edit_conflict");
  await fail([{ key: { rowId: 0 }, column: "price", value: "1.555" }], "invalid_value");
  await fail([{ key: { rowId: 0 }, column: "note", value: "z" }], "read_only");
  await fail(
    [
      { key: { rowId: 0 }, column: "city", value: "Y" },
      { key: { rowId: 9 }, column: "city", value: "Z" },
    ],
    "edit_conflict",
  );
  assert.deepEqual((await client.rows(info, {}, { columns: ["city"] })).rows[0], ["Tokyo"], "nothing was written");
  assert.equal((await client.error("write", { ...base, revision: "other", updates: [] })).code, "revision_changed");
  const fixed = await client.open("fixed");
  assert.equal((fixed.capabilities as { write?: boolean }).write, false);
  assert.equal(
    (
      await client.error("write", {
        table: fixed.table,
        revision: fixed.revision,
        updates: [{ key: { rowId: 0 }, column: "city", value: "Y" }],
      })
    ).code,
    "read_only",
  );
});
