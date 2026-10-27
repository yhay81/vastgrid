/**
 * The order of views (docs/v2-spec.md §3.1, §3.3) beyond the conformance corpus, through the engine's
 * messages: each order is checked against a reference that compares values one pair at a time, written
 * independently of the engine's ranks and radix sorts. Tables are sorted as rows and as Arrow, whose columns of
 * fixed width are ranked from the numbers that hold them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Column,
  dateText,
  encodeBlock,
  floatOf,
  fromBase64,
  type JsonValue,
  parseDateText,
  parseIntervalText,
  parseTimestampText,
  parseTimeText,
  type SortKey,
  type TimestampUnit,
  timestampText,
  timeText,
  toBase64,
} from "vastgrid-spec";
import type { MemoryTable } from "../src/index.ts";
import { Client, random, single } from "./client.ts";

/** Compares code point by code point (§3.1). */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (character) => character.codePointAt(0) as number);
  const y = Array.from(b, (character) => character.codePointAt(0) as number);
  for (let index = 0; index < Math.min(x.length, y.length); index++) {
    if (x[index] !== y[index]) return x[index] - y[index];
  }
  return x.length - y.length;
}

function compareBigInts(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

const NANOS_PER_DAY = 86_400_000_000_000n;

/** DuckDB 1.5's comparison of intervals: nanoseconds into days, then days into 30-day months, truncating. */
function intervalKey(text: string): bigint[] {
  const parts = parseIntervalText(text);
  assert.ok(parts, text);
  const days = BigInt(parts.days) + parts.nanos / NANOS_PER_DAY;
  return [BigInt(parts.months) + days / 30n, days % 30n, parts.nanos % NANOS_PER_DAY];
}

/** Compares two values that are not blank, by §3.1. */
function compareValues(a: JsonValue, b: JsonValue, column: Column): number {
  switch (column.type) {
    case "boolean":
      return Number(a) - Number(b);
    case "integer":
      return (a as number) - (b as number);
    case "bigint":
      return compareBigInts(BigInt(a as number | string), BigInt(b as number | string));
    case "decimal":
      return compareBigInts(BigInt((a as string).replace(".", "")), BigInt((b as string).replace(".", "")));
    case "float": {
      let x = floatOf(a);
      let y = floatOf(b);
      if (column.bits === 32) {
        x = Math.fround(x);
        y = Math.fround(y);
      }
      if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "string":
      return compareCodePoints(a as string, b as string);
    case "date":
      return (parseDateText(a as string) as number) - (parseDateText(b as string) as number);
    case "time":
      return compareBigInts(parseTimeText(a as string) as bigint, parseTimeText(b as string) as bigint);
    case "timestamp": {
      const unit = column.unit ?? "us";
      return compareBigInts(
        parseTimestampText(a as string, unit) as bigint,
        parseTimestampText(b as string, unit) as bigint,
      );
    }
    case "timestamptz":
      return compareBigInts(
        parseTimestampText((a as string).slice(0, -3)) as bigint,
        parseTimestampText((b as string).slice(0, -3)) as bigint,
      );
    case "uuid":
      return compareBigInts(
        BigInt(`0x${(a as string).replaceAll("-", "")}`),
        BigInt(`0x${(b as string).replaceAll("-", "")}`),
      );
    case "binary":
      return compareBytes(fromBase64(a as string), fromBase64(b as string));
    case "interval": {
      const x = intervalKey(a as string);
      const y = intervalKey(b as string);
      for (let index = 0; index < 3; index++) {
        if (x[index] !== y[index]) return compareBigInts(x[index], y[index]);
      }
      return 0;
    }
  }
}

function isBlank(value: JsonValue, column: Column) {
  return value === null || (column.type === "string" && value === "");
}

/** The row IDs of a table in the order of §3.3, by comparing rows two at a time. */
function referenceOrder(table: MemoryTable, sort: SortKey[]): number[] {
  const keys = sort.map((key) => {
    const index = table.columns.findIndex((column) => column.name === key.column);
    return { index, column: table.columns[index], sign: key.direction === "asc" ? 1 : -1 };
  });
  return table.rows
    .map((_, row) => row)
    .sort((x, y) => {
      for (const { index, column, sign } of keys) {
        const a = table.rows[x][index];
        const b = table.rows[y][index];
        const blankA = isBlank(a, column);
        const blankB = isBlank(b, column);
        if (blankA || blankB) {
          if (blankA && blankB) continue;
          return blankA ? 1 : -1;
        }
        const difference = compareValues(a, b, column);
        if (difference !== 0) return sign * difference;
      }
      return x - y;
    });
}

/** A client of a table given as rows, and of the same table given as Arrow. */
function clients(table: MemoryTable): [string, Client][] {
  return [
    ["rows", new Client({ t: table })],
    ["Arrow", new Client({ t: { arrow: encodeBlock(table.columns, table.rows) } })],
  ];
}

/** Sorts a table of one column both ways, and checks the engine against the reference and `expected`. */
async function checkOrder(table: MemoryTable, expected?: { asc: number[]; desc?: number[] }) {
  for (const [form, client] of clients(table)) {
    const info = await client.open("t");
    const name = table.columns[0].name;
    for (const direction of ["asc", "desc"] as const) {
      const sort: SortKey[] = [{ column: name, direction }];
      const got = await client.sorted(info, sort);
      assert.deepEqual(
        got,
        referenceOrder(table, sort),
        `${form}, ${direction}: ${JSON.stringify(got.map((row) => table.rows[row][0]))}`,
      );
      const wanted = direction === "asc" ? expected?.asc : expected?.desc;
      if (wanted) assert.deepEqual(got, wanted, `${form}, ${direction}`);
    }
  }
}

test("strings compare by code point, not by UTF-16 unit (§3.1)", async () => {
  const values = ["😀", "｡", "", "￿", "a", "😁", "a😀", "a｡", "\u{10FFFF}", "퟿", "𠀀", "", null, "B", "aa"];
  await checkOrder(single({ type: "string" }, values), {
    asc: [13, 4, 14, 7, 6, 9, 2, 1, 3, 0, 5, 10, 8, 11, 12],
  });
  // JavaScript's < answers the other way for these: the emoji's high surrogate is below U+FF61.
  assert.ok("😀" < "｡");
  // Without surrogates, and with only surrogates, the UTF-16 order is already the code point order.
  await checkOrder(single({ type: "string" }, ["｡", "", "a", "￿", "퟿", "ア", "ｱ"]));
  await checkOrder(single({ type: "string" }, ["😁", "😀", "𠀀", "\u{10000}", "a😀", "a😁"]));
});

test("random strings over the BMP and beyond sort as the reference does, with ties in row ID order", async () => {
  const next = random(11);
  const ranges = [
    [0x20, 0x7e],
    [0x3040, 0x30ff],
    [0xd7f0, 0xd7ff],
    [0xe000, 0xe010],
    [0xff00, 0xffff],
    [0x10000, 0x10010],
    [0x1f600, 0x1f64f],
    [0x10fff0, 0x10ffff],
  ];
  const pool = Array.from({ length: 300 }, () => {
    const length = Math.floor(next() * 4);
    return Array.from({ length }, () => {
      const [low, high] = ranges[Math.floor(next() * ranges.length)];
      return String.fromCodePoint(low + Math.floor(next() * (high - low + 1)));
    }).join("");
  });
  const values = Array.from({ length: 3000 }, () => (next() < 0.05 ? null : pool[Math.floor(next() * pool.length)]));
  await checkOrder(single({ type: "string" }, values));
});

test("text of more rows than a run is sorted in runs that are merged, as the reference sorts it", async () => {
  const next = random(12);
  const pool = Array.from({ length: 5_000 }, () =>
    Array.from({ length: 1 + Math.floor(next() * 6) }, () => String.fromCodePoint(0x61 + Math.floor(next() * 4))).join(
      "",
    ),
  );
  pool.push("😀", "｡");
  const values = Array.from({ length: 100_000 }, () => (next() < 0.02 ? null : pool[Math.floor(next() * pool.length)]));
  await checkOrder(single({ type: "string" }, values));
});

test("floats: NaN is the greatest number, −0.0 equals 0.0, and null comes last both ways", async () => {
  const values: JsonValue[] = [
    0,
    -0,
    "NaN",
    "Infinity",
    "-Infinity",
    null,
    1e-320,
    -1e-320,
    5e-324,
    -5e-324,
    1.7976931348623157e308,
    -1.7976931348623157e308,
    "NaN",
    -0,
    0.1,
  ];
  await checkOrder(single({ type: "float" }, values), {
    asc: [4, 11, 7, 9, 0, 1, 13, 8, 6, 14, 10, 3, 2, 12, 5],
    desc: [2, 12, 3, 10, 14, 6, 8, 0, 1, 13, 9, 7, 11, 4, 5],
  });
  // Typed JSON already holds float32 values; equal values retain their original row order.
  await checkOrder(
    single({ type: "float", bits: 32 }, [
      Math.fround(16777217),
      16777216,
      Math.fround(0.1),
      Math.fround(0.1),
      -0,
      0,
      "NaN",
    ]),
    {
      asc: [4, 5, 2, 3, 0, 1, 6],
    },
  );
});

test("blanks come last in both directions and tie with each other in row ID order (§3.2, §3.3)", async () => {
  const values = ["b", "", null, "a", "", null, " ", "b"];
  await checkOrder(single({ type: "string" }, values), {
    asc: [6, 3, 0, 7, 1, 2, 4, 5],
    desc: [0, 7, 3, 6, 1, 2, 4, 5],
  });
  // The empty string is blank only in string columns: an empty binary value is the smallest value.
  await checkOrder(single({ type: "binary" }, ["AQ==", "", null, "AA=="]), { asc: [1, 3, 0, 2], desc: [0, 3, 1, 2] });
  await checkOrder(single({ type: "integer" }, [null, 2, null, 1]), { asc: [3, 1, 0, 2], desc: [1, 3, 0, 2] });
  await checkOrder(single({ type: "boolean" }, [true, null, false, true, false]), {
    asc: [2, 4, 0, 3, 1],
    desc: [0, 3, 2, 4, 1],
  });
});

test("bigints compare exactly, near 2^63 and beyond 2^53, as numbers or digits", async () => {
  const values: JsonValue[] = [
    "9223372036854775807",
    "9223372036854775806",
    "-9223372036854775808",
    "-9223372036854775807",
    "9007199254740993",
    "9007199254740992",
    9007199254740991,
    -9007199254740991,
    "-9007199254740993",
    0,
    -1,
    1,
    null,
    4294967296,
    4294967295,
    -4294967296,
    -4294967297,
  ];
  await checkOrder(single({ type: "bigint" }, values), {
    asc: [2, 3, 8, 7, 16, 15, 10, 9, 11, 14, 13, 6, 5, 4, 1, 0, 12],
  });
  await checkOrder(single({ type: "integer" }, [2147483647, -2147483648, 0, -1, 1, null, 65536, -65536]));
});

test("decimals compare exactly, in 64 and 128 bits", async () => {
  // Up to 15 digits the engine reads unscaled integers as numbers, beyond as bigints: both in one column.
  await checkOrder(
    single({ type: "decimal", precision: 18, scale: 2 }, [
      "9999999999999999.99",
      "999999999999.99",
      "-0.01",
      "0.00",
      "-0.00",
      "1.10",
      "1.09",
      "-9999999999999999.99",
      "10000000000000.00",
      "9999999999999.99",
      null,
    ]),
    { asc: [7, 2, 3, 4, 6, 5, 1, 9, 8, 0, 10] },
  );
  await checkOrder(
    single({ type: "decimal", precision: 38, scale: 0 }, [
      "99999999999999999999999999999999999999",
      "-99999999999999999999999999999999999999",
      "18446744073709551616",
      "18446744073709551615",
      "-18446744073709551616",
      "9223372036854775808",
      "-9223372036854775809",
      "0",
      "-1",
      null,
    ]),
    { asc: [1, 4, 6, 8, 7, 5, 3, 2, 0, 9] },
  );
  await checkOrder(
    single({ type: "decimal", precision: 38, scale: 10 }, [
      "1.0000000001",
      "1.0000000000",
      "0.9999999999",
      "-1234567890123456789012345678.0000000001",
      "1234567890123456789012345678.0000000001",
    ]),
    { asc: [3, 2, 1, 0, 4] },
  );
});

test("dates, times and timestamps compare in time, their fractions included", async () => {
  await checkOrder(
    single({ type: "date" }, [
      "2024-01-31",
      "0001-01-01",
      "9999-12-31",
      "1969-12-31",
      "1970-01-01",
      "2000-02-29",
      null,
    ]),
    { asc: [1, 3, 4, 5, 0, 2, 6] },
  );
  await checkOrder(
    single({ type: "time" }, [
      "12:00:00.5",
      "12:00:00.25",
      "12:00:00",
      "12:00:00.05",
      "12:00:00.000001",
      "23:59:59.999999",
      "00:00:00",
      "11:59:59.999999",
    ]),
    { asc: [6, 7, 2, 4, 3, 1, 0, 5] },
  );
  await checkOrder(
    single({ type: "timestamp" }, [
      "1970-01-01 00:00:00",
      "1969-12-31 23:59:59.999999",
      "0001-01-01 00:00:00",
      "9999-12-31 23:59:59.999999",
      "2024-01-31 12:00:00.5",
      "2024-01-31 12:00:00.25",
      "2024-01-31 12:00:00",
    ]),
    { asc: [2, 1, 0, 6, 5, 4, 3] },
  );
  await checkOrder(
    single({ type: "timestamp", unit: "ns" }, [
      "1970-01-01 00:00:00.000000001",
      "1970-01-01 00:00:00",
      "1969-12-31 23:59:59.999999999",
      "2262-04-11 23:47:16.854775807",
      "1677-09-21 00:12:43.145224192",
    ]),
    { asc: [4, 2, 1, 0, 3] },
  );
  await checkOrder(
    single({ type: "timestamp", unit: "s" }, ["2024-01-31 12:00:01", "2024-01-31 12:00:00", "0001-01-01 00:00:00"]),
    {
      asc: [2, 1, 0],
    },
  );
  await checkOrder(
    single({ type: "timestamp", unit: "ms" }, [
      "2024-01-31 12:00:00.1",
      "2024-01-31 12:00:00.01",
      "2024-01-31 12:00:00.001",
    ]),
    {
      asc: [2, 1, 0],
    },
  );
  await checkOrder(
    single({ type: "timestamptz" }, [
      "2024-01-31 03:00:00.5+00",
      "2024-01-31 03:00:00+00",
      "2024-01-31 03:00:00.51+00",
      "2024-01-31 03:00:01+00",
      "2024-01-31 02:59:59.999999+00",
    ]),
    { asc: [4, 1, 0, 2, 3] },
  );
});

test("the text of dates, times and timestamps orders as their time does, so text could sort them (§2.2)", async () => {
  // Fixed-width fields, fractions without trailing zeros, and "+" below "." below the digits: comparing
  // the text unit by unit compares the times, for every year that §2.2 writes.
  const next = random(5);
  const minDay = BigInt(parseDateText("0001-01-01") as number);
  const maxDay = BigInt(parseDateText("9999-12-31") as number);
  const fractions = [0n, 5n, 25n, 50n, 500n, 999n, 1000n];
  for (const unit of ["s", "ms", "us", "ns"] as TimestampUnit[]) {
    const perSecond = { s: 1n, ms: 1000n, us: 1_000_000n, ns: 1_000_000_000n }[unit];
    // Timestamps in nanoseconds are 64-bit counts (§8.4): from 1677-09-21 to 2262-04-11.
    const [first, last] =
      unit === "ns"
        ? [BigInt(parseDateText("1677-09-22") as number), BigInt(parseDateText("2262-04-10") as number)]
        : [minDay, maxDay];
    const counts = Array.from({ length: 2000 }, (_, index) => {
      const day = first + BigInt(Math.floor(next() * Number(last - first + 1n)));
      const second = BigInt(Math.floor(next() * 86_400));
      const fraction =
        index % 4 === 0
          ? fractions[index % fractions.length] % perSecond
          : BigInt(Math.floor(next() * Number(perSecond)));
      return (day * 86_400n + second) * perSecond + fraction;
    });
    // Neighbors within one second, which differ only in their fractions.
    counts.push(0n, 1n, perSecond - 1n, perSecond, perSecond + 1n, 10n % perSecond, 100n % perSecond);
    const texts = counts.map((count) => timestampText(count, unit));
    const byCount = counts.map((_, index) => index).sort((a, b) => compareBigInts(counts[a], counts[b]) || a - b);
    const byText = texts
      .map((_, index) => index)
      .sort((a, b) => (texts[a] < texts[b] ? -1 : texts[a] > texts[b] ? 1 : a - b));
    assert.deepEqual(byText, byCount, unit);
    const zoned = texts.map((text) => `${text}+00`);
    const byZoned = zoned
      .map((_, index) => index)
      .sort((a, b) => (zoned[a] < zoned[b] ? -1 : zoned[a] > zoned[b] ? 1 : a - b));
    assert.deepEqual(byZoned, byCount, `${unit} with +00`);
    const client = new Client({
      t: single({ type: "timestamp", unit }, texts),
      z: single({ type: "timestamptz" }, unit === "us" ? zoned : []),
    });
    assert.deepEqual(await client.sorted(await client.open("t"), [{ column: "x", direction: "asc" }]), byCount, unit);
    if (unit === "us")
      assert.deepEqual(await client.sorted(await client.open("z"), [{ column: "x", direction: "asc" }]), byCount);
  }
  const micros = Array.from({ length: 2000 }, () => BigInt(Math.floor(next() * 86_400_000_000)));
  micros.push(0n, 1n, 10n, 100n, 500_000n, 250_000n, 999_999n, 1_000_000n);
  const times = micros.map((count) => timeText(count));
  const byMicros = micros.map((_, index) => index).sort((a, b) => compareBigInts(micros[a], micros[b]) || a - b);
  assert.deepEqual(
    times.map((_, index) => index).sort((a, b) => (times[a] < times[b] ? -1 : times[a] > times[b] ? 1 : a - b)),
    byMicros,
  );
  const days = Array.from({ length: 2000 }, () => Number(minDay) + Math.floor(next() * Number(maxDay - minDay + 1n)));
  const dates = days.map((day) => dateText(day));
  const byDay = days.map((_, index) => index).sort((a, b) => days[a] - days[b] || a - b);
  assert.deepEqual(
    dates.map((_, index) => index).sort((a, b) => (dates[a] < dates[b] ? -1 : dates[a] > dates[b] ? 1 : a - b)),
    byDay,
  );
  const client = new Client({ t: single({ type: "time" }, times), d: single({ type: "date" }, dates) });
  assert.deepEqual(await client.sorted(await client.open("t"), [{ column: "x", direction: "asc" }]), byMicros);
  assert.deepEqual(await client.sorted(await client.open("d"), [{ column: "x", direction: "asc" }]), byDay);
});

test("UUIDs and binary values compare by their bytes", async () => {
  // DuckDB 1.5.6 orders these UUIDs and BLOBs so.
  await checkOrder(
    single({ type: "uuid" }, [
      "ffffffff-0000-0000-0000-000000000000",
      "80000000-0000-0000-0000-000000000000",
      "7fffffff-ffff-ffff-ffff-ffffffffffff",
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-8000-000000000000",
      "00000000-0000-0000-7fff-ffffffffffff",
    ]),
    { asc: [3, 5, 4, 2, 1, 0] },
  );
  // Their base64 text orders otherwise: "/w==" (0xFF) is below "AA==" (0x00) as text.
  await checkOrder(single({ type: "binary" }, ["/w==", "AAE=", "AA==", "", "gA==", "f/8="]), {
    asc: [3, 2, 1, 5, 4, 0],
  });
  const next = random(3);
  const blobs = Array.from({ length: 500 }, () =>
    toBase64(Uint8Array.from({ length: Math.floor(next() * 4) }, () => Math.floor(next() * 256))),
  );
  await checkOrder(single({ type: "binary" }, blobs));
});

test("intervals compare as DuckDB 1.5 compares them", async () => {
  // Orders read from DuckDB 1.5.6 (ORDER BY x, id): 1 month equals 30 days and 1 day equals 24 hours, but
  // 1 month −1 day is greater than 29 days, since days and months are normalized by truncating division.
  const values = [
    "1 month",
    "30 days",
    "1 month -1 day",
    "29 days",
    "29 days 696:00:00",
    "1 month 28 days",
    "-31 days",
    "-1 month -1 day",
    "-25:00:00",
    "-1 day -01:00:00",
    "00:00:00",
    "1 day",
    "24:00:00",
    "1 month -01:00:00",
    "29 days 23:00:00",
    null,
  ];
  await checkOrder(single({ type: "interval" }, values), {
    asc: [6, 7, 8, 9, 10, 11, 12, 3, 14, 2, 13, 0, 1, 4, 5, 15],
    desc: [4, 5, 0, 1, 13, 2, 14, 3, 11, 12, 10, 8, 9, 6, 7, 15],
  });
});

/** A table of every type, with few distinct values so that keys tie often. */
function mixedTable(count: number, seed: number): MemoryTable {
  const next = random(seed);
  const pick = <T>(values: T[]): T => values[Math.floor(next() * values.length)];
  const columns: Column[] = [
    { name: "s", type: "string" },
    { name: "i", type: "integer" },
    { name: "b", type: "bigint" },
    { name: "d", type: "decimal", precision: 20, scale: 3 },
    { name: "f", type: "float" },
    { name: "t", type: "timestamp" },
    { name: "flag", type: "boolean" },
    { name: "day", type: "date" },
  ];
  const pools: JsonValue[][] = [
    ["", "a", "B", "😀", "｡", "aa", null],
    [0, -1, 7, 2147483647, null],
    ["9223372036854775807", 3, -3, "-9223372036854775808", null],
    ["0.000", "-0.001", "12345678901234567.890", "1.500", null],
    [0, -0, "NaN", "Infinity", "-Infinity", 0.5, -2.25, null],
    ["2024-01-31 12:00:00", "2024-01-31 12:00:00.5", "1969-12-31 23:59:59.999999", null],
    [true, false, null],
    ["2024-01-31", "0001-01-01", null],
  ];
  return { columns, rows: Array.from({ length: count }, () => pools.map((pool) => pick(pool))) };
}

test("sorts of several keys break ties with the next key, then by row ID", async () => {
  const table = mixedTable(2000, 7);
  const [[, client]] = clients(table);
  const info = await client.open("t");
  const names = table.columns.map((column) => column.name);
  for (const [form, each] of clients(table)) {
    const opened = await each.open("t");
    const next = random(99);
    for (let trial = 0; trial < 60; trial++) {
      const sort: SortKey[] = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
        column: names[Math.floor(next() * names.length)],
        direction: next() < 0.5 ? "asc" : "desc",
      }));
      assert.deepEqual(
        await each.sorted(opened, sort),
        referenceOrder(table, sort),
        `${form}: ${JSON.stringify(sort)}`,
      );
    }
  }
  // A key on a column that an earlier key sorts by changes nothing.
  assert.deepEqual(
    await client.sorted(info, [
      { column: "s", direction: "asc" },
      { column: "s", direction: "desc" },
    ]),
    await client.sorted(info, [{ column: "s", direction: "asc" }]),
  );
});

test("rows equal for every key stay in row ID order, in both directions", async () => {
  const table = single(
    { type: "string" },
    Array.from({ length: 1000 }, (_, row) => (row % 3 === 0 ? "same" : "Same")),
  );
  const client = new Client({ t: table });
  const info = await client.open("t");
  const ascending = await client.sorted(info, [{ column: "x", direction: "asc" }]);
  const descending = await client.sorted(info, [{ column: "x", direction: "desc" }]);
  const upper = table.rows.flatMap((row, id) => (row[0] === "Same" ? [id] : []));
  const lower = table.rows.flatMap((row, id) => (row[0] === "same" ? [id] : []));
  assert.deepEqual(ascending, [...upper, ...lower]);
  assert.deepEqual(descending, [...lower, ...upper]);
  const view = await client.rows(info, {}, { columns: ["x"] });
  assert.deepEqual(
    view.rowIds,
    table.rows.map((_, id) => id),
  );
});
