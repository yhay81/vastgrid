/**
 * Tables given as Arrow (docs/spec.md §2.3): read from any number of record batches and kept as Arrow holds
 * them, with the same answers as the same table given as rows; values that have no typed JSON fail to load when
 * they are read, and writes leave the host's bytes as they were.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Column as ArrowColumn,
  Batch,
  columnFromValues,
  dateDay,
  decimal,
  Endianness,
  field,
  float64,
  int32,
  list,
  Table,
  TimeUnit,
  tableFromColumns,
  tableToIPC,
  timeMicrosecond,
  timestamp,
  utf8,
  Version,
} from "@uwdata/flechette";
import { decodeBlock } from "vastgrid-spec";
import type { ArrowTable, MemoryTable } from "../src/index.ts";
import { Client, type Json } from "./client.ts";

/** Arrow bytes of one column. */
function oneColumn(name: string, column: ArrowColumn<unknown>): Uint8Array {
  const table = new Table(
    { version: Version.V5, endianness: Endianness.Little, fields: [field(name, column.type)], metadata: null },
    [column],
  );
  return tableToIPC(table, { format: "stream" }) as Uint8Array;
}

/** Milliseconds in a day. */
const DAY = 86_400_000;

/** A table of several record batches, with nulls in every column. */
function batches(): Uint8Array {
  const options = { maxBatchRows: 3 };
  const table = tableFromColumns({
    id: columnFromValues([5, 3, null, 1, 4, 3, 2, -7], int32(), options),
    city: columnFromValues(["Kobe", "Osaka", "Tokyo", null, "", "Nara", "Osaka", "Kyoto"], utf8(), options),
    price: columnFromValues([150n, -25n, 300n, 0n, null, 999n, 1n, 150n], decimal(6, 2, 128), options),
    score: columnFromValues([0.5, Number.NaN, -0, 2.25, null, -1e300, 0, 0.5], float64(), options),
    // Flechette takes dates and timestamps in milliseconds, whatever their unit.
    day: columnFromValues(
      [19_000, -1, 0, null, 2_932_896, -719_162, 19_000, 1].map((days) => (days === null ? null : days * DAY)),
      dateDay(),
      options,
    ),
    at: columnFromValues([0, 1, -1, 1.5e12, null, -9.2e12, 9.2e12, 0], timestamp(TimeUnit.NANOSECOND), options),
  });
  return tableToIPC(table, { format: "stream" }) as Uint8Array;
}

test("a table given as Arrow answers as the same table given as rows", async () => {
  const arrow = batches();
  const decoded = decodeBlock(arrow);
  const rows: MemoryTable = { columns: decoded.columns, rows: decoded.rows };
  const plans = [
    {},
    { sort: [{ column: "price", direction: "desc" }] },
    {
      sort: [
        { column: "day", direction: "asc" },
        { column: "id", direction: "desc" },
      ],
    },
    { sort: [{ column: "at", direction: "asc" }] },
    {
      sort: [
        { column: "score", direction: "desc" },
        { column: "city", direction: "asc" },
      ],
    },
    {
      derive: [{ name: "total", expr: { fn: "mul", args: [{ col: "price" }, { col: "id" }] } }],
      where: { fn: "gt", args: [{ col: "total" }, { lit: "0", type: "decimal" }] },
      sort: [{ column: "total", direction: "asc" }],
    },
    { where: { search: "osaka" } },
    {
      aggregate: {
        keys: ["city"],
        measures: [
          { name: "n", fn: "count" },
          { name: "sum", fn: "sum", column: "price" },
          { name: "top", fn: "max", column: "at" },
        ],
      },
      sort: [{ column: "sum", direction: "desc" }],
    },
  ];
  const answers = [];
  for (const table of [rows, { arrow } satisfies ArrowTable]) {
    const client = new Client({ t: table });
    const info = await client.open("t");
    const answer: unknown[] = [info.rowCount, info.columns];
    for (const plan of plans) {
      // Every column of the view, which a read of no columns gives first.
      const { view } = await client.rows(info, plan, { columns: [], end: 0 });
      const read = await client.rows(info, plan, { columns: view.columns.map((column) => column.name), end: 100 });
      answer.push([read.rows, read.rowIds, read.view.rowCount]);
    }
    const plain = { table: info.table, revision: info.revision, plan: {} };
    answer.push(
      await client.result("summarize", {
        ...plain,
        ranges: [[0, 8]],
        columns: ["id", "price", "score", "day", "at"],
      }),
      await client.result("locate", { ...plain, keys: [{ value: "1.50" }, { value: "9.99" }], rowKey: "price" }),
      await client.result("locate", { ...plain, keys: [{ value: "1970-01-01 00:00:00.001" }], rowKey: "at" }),
    );
    answers.push(answer);
  }
  assert.deepEqual(answers[1], answers[0]);
  // The search finds both rows of Osaka, and the cities make seven groups, the null and the empty string among them.
  assert.deepEqual(
    [8, 9].map((at) => (answers[0][at] as unknown[])[2]),
    [2, 7],
  );
});

test("a table given as Arrow that is not one fails to load", async () => {
  const bad: Record<string, ArrowTable> = {
    text: { arrow: "ARROW1" as never },
    bytes: { arrow: new Uint8Array([1, 2, 3, 4]) },
    nested: { arrow: oneColumn("x", columnFromValues([[1, 2]], list(int32()))) },
    names: {
      arrow: tableToIPC(
        new Table(
          {
            version: Version.V5,
            endianness: Endianness.Little,
            fields: [field("x", int32()), field("x", int32())],
            metadata: null,
          },
          [columnFromValues([1], int32()), columnFromValues([2], int32())],
        ),
        { format: "stream" },
      ) as Uint8Array,
    },
  };
  const client = new Client(bad);
  for (const ref of Object.keys(bad)) {
    const error = await client.error("open", { ref });
    assert.equal(error.code, "load_failed", ref);
    assert.ok(error.message.includes("at /arrow,"), `${ref}: ${error.message}`);
  }
});

test("values of an Arrow table that have no typed JSON fail to load when they are read", async () => {
  const utf8Type = utf8();
  const malformed = new ArrowColumn(
    [
      new Batch({
        length: 2,
        nullCount: 0,
        type: utf8Type,
        validity: new Uint8Array(0),
        values: new Uint8Array([0x61, 0xff]),
        offsets: new Int32Array([0, 1, 2]),
      } as never),
    ],
    utf8Type,
  );
  const bad: Record<string, ArrowTable> = {
    // Text that is not UTF-8, a time beyond a day, a date after +294247-01-10 and a decimal of too many digits.
    utf8: { arrow: oneColumn("x", malformed) },
    time: { arrow: oneColumn("x", columnFromValues([0n, 86_400_000_000n], timeMicrosecond())) },
    date: { arrow: oneColumn("x", columnFromValues([0, 106_751_992 * DAY], dateDay())) },
    decimal: { arrow: oneColumn("x", columnFromValues([1n, 1_000_000n], decimal(6, 2, 128))) },
  };
  const client = new Client(bad);
  for (const ref of Object.keys(bad)) {
    const info = await client.open(ref);
    const read = (plan: Json, start: number) =>
      client.send("rows", { table: info.table, revision: info.revision, plan, start, end: start + 1, columns: ["x"] });
    // The first value reads; the second fails, alone or as a sort reads its whole column.
    assert.ok("result" in (await read({}, 0)), ref);
    for (const plan of [{}, { sort: [{ column: "x", direction: "asc" }] }]) {
      const error = (await read(plan, 1)).error as { code: string; message: string };
      assert.equal(error.code, "load_failed", ref);
      assert.ok(error.message.includes("at /rows/1/0,"), `${ref}: ${error.message}`);
    }
  }
});

test("writes to an Arrow table change the engine's copy of a column, and leave the host's bytes", async () => {
  const arrow = batches();
  const before = arrow.slice();
  const client = new Client({ t: { arrow, editable: true } });
  const info = await client.open("t");
  assert.equal((info.capabilities as { write?: boolean }).write, true);
  const written = await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [
      { key: { value: 1 }, column: "price", value: "-9.99", previous: "0.00" },
      { key: { rowId: 7 }, column: "city", value: "Sakai" },
    ],
    rowKey: "id",
  });
  assert.deepEqual(written, { updated: 2, edits: { version: 1, cells: 2 } });
  const sorted = await client.rows(
    info,
    { sort: [{ column: "price", direction: "asc" }] },
    { columns: ["id", "price"] },
  );
  assert.deepEqual(sorted.rows.slice(0, 2), [
    [1, "-9.99"],
    [3, "-0.25"],
  ]);
  const plain = await client.rows(info, {}, { columns: ["city"], start: 6 });
  assert.deepEqual(plain.rows, [["Osaka"], ["Sakai"]]);
  assert.deepEqual(arrow, before);
});
