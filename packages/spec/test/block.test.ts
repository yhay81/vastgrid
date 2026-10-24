import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Column as ArrowColumn,
  Batch,
  columnFromValues,
  Endianness,
  field,
  int8,
  largeUtf8,
  Table,
  tableFromIPC,
  tableToIPC,
  uint32,
  utf8View,
  Version,
} from "@uwdata/flechette";
import { type Column, decodeBlock, encodeBlock, type JsonValue, UUID_EXTENSION } from "../src/index.ts";

function roundTrip(columns: Column[], rows: JsonValue[][]) {
  const back = decodeBlock(encodeBlock(columns, rows));
  assert.deepEqual(back.columns, columns);
  assert.deepEqual(back.rows, rows);
}

test("every type goes through a block unchanged (§8.4)", () => {
  roundTrip(
    [
      { name: "b", type: "boolean" },
      { name: "i", type: "integer" },
      { name: "g", type: "bigint" },
      { name: "d", type: "decimal", precision: 38, scale: 2 },
      { name: "f", type: "float" },
      { name: "f32", type: "float", bits: 32 },
      { name: "s", type: "string" },
      { name: "dt", type: "date" },
      { name: "t", type: "time" },
      { name: "ts", type: "timestamp" },
      { name: "tz", type: "timestamptz" },
      { name: "iv", type: "interval" },
      { name: "u", type: "uuid" },
      { name: "bin", type: "binary" },
    ],
    [
      [
        true,
        -2147483648,
        "9223372036854775807",
        "-999999999999999999999999999999999999.99",
        "NaN",
        0.10000000149011612,
        "日本語 😀",
        "0001-01-01",
        "23:59:59.999999",
        "9999-12-31 23:59:59.999999",
        "2024-01-31 03:00:00+00",
        "1 year 2 months 3 days 04:05:06.789",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "AAEC/w==",
      ],
      [null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      [
        false,
        2147483647,
        "-9223372036854775808",
        "0.00",
        "-Infinity",
        16777216,
        "",
        "1969-12-31",
        "00:00:00",
        "1969-12-31 23:59:59.999999",
        "1970-01-01 00:00:00+00",
        "-01:30:00",
        "00000000-0000-0000-0000-000000000000",
        "",
      ],
      [
        true,
        0,
        9007199254740991,
        "12.50",
        1e-300,
        1,
        "a",
        "2024-02-29",
        "12:00:00.5",
        "2024-02-29 12:00:00.5",
        "1999-12-31 23:59:59.5+00",
        "00:00:00",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "/w==",
      ],
    ],
  );
});

test("timestamps keep their unit", () => {
  roundTrip(
    [
      { name: "s", type: "timestamp", unit: "s" },
      { name: "ms", type: "timestamp", unit: "ms" },
      { name: "ns", type: "timestamp", unit: "ns" },
    ],
    [
      ["0001-01-01 00:00:00", "1969-12-31 23:59:59.999", "1677-09-21 00:12:43.145224192"],
      ["9999-12-31 23:59:59", "2000-01-01 00:00:00.001", "2262-04-11 23:47:16.854775807"],
    ],
  );
});

test("a string that starts with U+FEFF keeps it (Appendix B)", () => {
  roundTrip([{ name: "s", type: "string" }], [["﻿"], ["﻿a"], ["a﻿"]]);
});

test("decimals of every precision keep their digits", () => {
  roundTrip(
    [
      { name: "d0", type: "decimal", precision: 38, scale: 0 },
      { name: "d38", type: "decimal", precision: 38, scale: 38 },
      { name: "d1", type: "decimal", precision: 1, scale: 0 },
    ],
    [
      ["99999999999999999999999999999999999999", "0.99999999999999999999999999999999999999", "9"],
      ["-99999999999999999999999999999999999999", "-0.00000000000000000000000000000000000001", "-9"],
      ["0", "0.00000000000000000000000000000000000000", "0"],
    ],
  );
});

test("a block without rows has its schema", () => {
  roundTrip([{ name: "a", type: "integer" }], []);
});

test("blocks are read from bytes at any offset", () => {
  const bytes = encodeBlock([{ name: "g", type: "bigint" }], [["9223372036854775807"]]);
  const framed = new Uint8Array(bytes.length + 5);
  framed.set(bytes, 5);
  assert.deepEqual(decodeBlock(framed.subarray(5)).rows, [["9223372036854775807"]]);
});

test("UUID fields carry the arrow.uuid extension", () => {
  const table = tableFromIPC(encodeBlock([{ name: "u", type: "uuid" }], [[null]]));
  const metadata = table.schema.fields[0].metadata as Map<string, string>;
  assert.equal(metadata.get(UUID_EXTENSION.key), UUID_EXTENSION.value);
  assert.equal(table.schema.fields[0].nullable, true);
});

test("values that are not of their column's type are refused", () => {
  assert.throws(() => encodeBlock([{ name: "d", type: "decimal", precision: 4, scale: 2 }], [["1.5"]]), TypeError);
  assert.throws(() => encodeBlock([{ name: "d", type: "date" }], [["2023-02-29"]]), TypeError);
  assert.throws(() => encodeBlock([{ name: "u", type: "uuid" }], [["xyz"]]), TypeError);
  assert.throws(() => encodeBlock([{ name: "t", type: "timestamptz" }], [["2024-01-01 00:00:00"]]), TypeError);
  assert.throws(() => encodeBlock([{ name: "i", type: "interval" }], [["3 weeks"]]), TypeError);
});

/** A table of one column as an IPC stream, from batches that the test builds. */
function stream(name: string, column: ArrowColumn<unknown>) {
  const table = new Table(
    { version: Version.V5, endianness: Endianness.Little, fields: [field(name, column.type)], metadata: null },
    [column],
  );
  return tableToIPC(table, { format: "stream" }) as Uint8Array;
}

test("readers accept LargeUtf8 and Utf8View strings (§8.4)", () => {
  const large = decodeBlock(stream("s", columnFromValues(["﻿a", null, "b"], largeUtf8())));
  assert.deepEqual(large.columns, [{ name: "s", type: "string" }]);
  assert.deepEqual(large.rows, [["﻿a"], [null], ["b"]]);
  // Views: a string of up to 12 bytes is inline; a longer one points into a data buffer.
  const long = new TextEncoder().encode("﻿a string longer than twelve bytes");
  const views = new Uint8Array(32);
  const data = new DataView(views.buffer);
  const short = new TextEncoder().encode("short");
  data.setInt32(0, short.length, true);
  views.set(short, 4);
  data.setInt32(16, long.length, true);
  views.set(long.subarray(0, 4), 20);
  data.setInt32(24, 0, true);
  data.setInt32(28, 0, true);
  const type = utf8View();
  // The base Batch keeps no data buffers; the IPC writer reads them from `data`.
  const batch = Object.assign(
    new Batch({ length: 2, nullCount: 0, type, validity: new Uint8Array(0), values: views } as never),
    { data: [long] },
  );
  const view = decodeBlock(stream("v", new ArrowColumn([batch], type)));
  assert.deepEqual(view.rows, [["short"], ["﻿a string longer than twelve bytes"]]);
});

test("integers of other widths read as integer and bigint", () => {
  const small = decodeBlock(stream("i", columnFromValues([-128, 127, null], int8())));
  assert.deepEqual(small.columns, [{ name: "i", type: "integer" }]);
  assert.deepEqual(small.rows, [[-128], [127], [null]]);
  const unsigned = decodeBlock(stream("u", columnFromValues([4294967295], uint32())));
  assert.deepEqual(unsigned.columns, [{ name: "u", type: "bigint" }]);
  assert.deepEqual(unsigned.rows, [[4294967295]]);
});
