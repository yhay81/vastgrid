/**
 * Excel workbooks in the memory engine (§8.2): the sheet that `read` chooses is opened, written to, exported as a
 * workbook and opened again with the values written. The DuckDB engine's tests compare the two engines' reading of
 * the same workbooks (packages/duckdb-engine/test/memory-engine.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileTable, MemoryTable } from "../src/index.ts";
import { Client, type TableInfo } from "./client.ts";

const table: MemoryTable = {
  columns: [
    { name: "id", type: "integer" },
    { name: "name", type: "string" },
    { name: "price", type: "float" },
    { name: "day", type: "date" },
    { name: "at", type: "timestamp" },
    { name: "ok", type: "boolean" },
  ],
  rows: [
    [1, "Kobe", 1.5, "2024-01-15", "2024-01-15 12:00:00", true],
    [2, '東京, "都"', -0.25, "1999-12-31", "2000-01-01 00:00:00.5", false],
    [3, null, null, null, null, null],
  ],
};

/** A table exported as a workbook (§8.5), with the sheet's name and numbers formats that the engine writes. */
async function exported(client: Client, info: TableInfo): Promise<Uint8Array> {
  const result = (await client.result("export", {
    table: info.table,
    revision: info.revision,
    plan: {},
    format: "xlsx",
  })) as { data: { bytes: Uint8Array } };
  return result.data.bytes;
}

type Opened = TableInfo & { sheets?: { name: string; hidden?: boolean }[]; sheet?: string; notes?: string[] };

async function open(client: Client, ref: string, read?: unknown): Promise<Opened> {
  return (await client.result("open", read === undefined ? { ref } : { ref, read })) as Opened;
}

test("a sheet opens with its columns' types, is written to, exported and opened again", async () => {
  const source = new Client({ source: table });
  const bytes = await exported(source, await source.open("source"));
  const book: FileTable = { file: new File([bytes], "book.xlsx"), editable: true };
  const client = new Client({ book });
  const info = await open(client, "book");
  assert.deepEqual(info.sheets, [{ name: "Sheet1" }]);
  assert.equal(info.sheet, "Sheet1");
  assert.equal(info.notes, undefined);
  assert.deepEqual(
    info.columns.map((column) => [column.name, column.type]),
    [
      ["id", "bigint"],
      ["name", "string"],
      ["price", "float"],
      ["day", "date"],
      ["at", "timestamp"],
      ["ok", "boolean"],
    ],
  );
  assert.equal(info.capabilities.write, true);
  assert.deepEqual((await client.rows(info, {})).rows, [
    [1, "Kobe", 1.5, "2024-01-15", "2024-01-15 12:00:00", true],
    [2, '東京, "都"', -0.25, "1999-12-31", "2000-01-01 00:00:00.5", false],
    [3, null, null, null, null, null],
  ]);
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [
      { key: { rowId: 2 }, column: "name", value: "大阪" },
      { key: { rowId: 0 }, column: "price", value: 2.75 },
    ],
  });
  const again = new Client({ book: { file: new File([await exported(client, info)], "again.xlsx") } });
  const reopened = await open(again, "book");
  assert.deepEqual(
    (
      await again.rows(
        reopened,
        { sort: [{ column: "price", direction: "desc" }] },
        { columns: ["id", "name", "price"] },
      )
    ).rows,
    [
      [1, "Kobe", 2.75],
      [2, '東京, "都"', -0.25],
      [3, "大阪", null],
    ],
  );
});

test("read options choose the sheet and the header row, and each set of them is a table of its own", async () => {
  const source = new Client({ source: table });
  const bytes = await exported(source, await source.open("source"));
  // A Blob is a workbook by the table's format.
  const client = new Client({ book: { file: new Blob([bytes]), format: "xlsx" } });
  const named = await open(client, "book");
  const unnamed = await open(client, "book", { sheet: "Sheet1", headerRow: 0 });
  assert.deepEqual(
    unnamed.columns.map((column) => column.name),
    ["A", "B", "C", "D", "E", "F"],
  );
  assert.equal(unnamed.rowCount, 4);
  assert.notEqual(unnamed.table, named.table);
  // Options that read the sheet as before open the same table, with the edits the other IDs see.
  const same = await open(client, "book", { keepEmptyRows: false });
  assert.equal(same.rowCount, named.rowCount);
  const missing = await client.error("open", { ref: "book", read: { sheet: "Other" } });
  assert.equal(missing.code, "load_failed");
  assert.match(missing.message, /The workbook has no sheet named "Other"\./);
});

test("a workbook that cannot be read fails the open at /file; one beyond maxBytes is read by blocks", async () => {
  const source = new Client({ source: table });
  const bytes = await exported(source, await source.open("source"));
  const client = new Client({
    text: { file: new Blob(["id,name\n1,a\n"]), format: "xlsx" },
    old: { file: new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], "old.xlsx") },
    small: { file: new File([bytes], "small.xlsx"), maxBytes: 64 },
  });
  for (const [ref, message] of [
    ["text", /at \/file, .*not a ZIP archive/],
    ["old", /at \/file, .*encrypted or in the old \.xls format/],
  ] as const) {
    const error = await client.error("open", { ref });
    assert.equal(error.code, "load_failed", ref);
    assert.match(error.message, message, ref);
  }
  // The sheet's lines are kept, and its columns read from them when requests need them, within maxBytes.
  const small = await open(client, "small");
  assert.equal(small.rowCount, 3);
  assert.deepEqual((await client.rows(small, {}, { columns: ["id", "ok"] })).rows, [
    [1, true],
    [2, false],
    [3, null],
  ]);
});
