/**
 * The memory engine of `vastgrid-js` against this engine (docs/v2-spec.md §10): a generated table with the edges of
 * every type (NaN, the infinities, −0.0, bigints beyond 2^53, decimals of 38 digits, surrogate pairs, letters whose
 * case JavaScript maps otherwise, leap days), and generated plans that derive, filter, search, group, pivot and
 * sort. Both engines answer each plan, and their views, rows, row IDs and errors must be the same; floats may
 * differ within a relative tolerance, as conformance allows for sums (§3.8).
 *
 * The memory engine answers them twice: from the table as rows, and from the Parquet file that this engine reads.
 * Both engines also read the same Excel workbooks with the same read options (§8.2).
 *
 * The plans come from a seeded generator, so that a run is repeatable. `VASTGRID_PLANS` sets how many (300 by
 * default) and `VASTGRID_SEED` the seed; a difference names the plan's seed and shows the plan.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { memoryEngine } from "vastgrid-js";
import { type Column, checkResponse, decodeBlock, type JsonValue, type Operation } from "vastgrid-spec";
import { sameValue } from "vastgrid-spec/conformance";
import { setUp, type TableInfo, writeParquet } from "./client.ts";
import { cell, type FixtureWorkbook, row, writeWorkbook } from "./xlsx-fixture.ts";

type Json = Record<string, unknown>;

const PLANS = Number(process.env.VASTGRID_PLANS ?? 300);
const SEED = Number(process.env.VASTGRID_SEED ?? 2026);
const ROWS = 240;
/** The relative difference that floats may have: the order of additions, and libm against JavaScript's Math. */
const TOLERANCE = 1e-9;
/** Floats below the smallest normal float, which DuckDB's interpolation may flush to 0. */
const SUBNORMAL = 2.2250738585072014e-308;

/** Whether two values of a column are the same, floats within the tolerance and subnormal floats alike. */
function same(a: JsonValue, b: JsonValue, column: Column): boolean {
  if (sameValue(a, b, column, TOLERANCE)) return true;
  return column.type === "float" && Math.abs(Number(a)) < SUBNORMAL && Math.abs(Number(b)) < SUBNORMAL;
}

/** A pseudo-random generator with a seed (mulberry32). */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}

type Random = ReturnType<typeof generator>;

// ----- the table -----

const WORDS = [
  "Tokyo",
  "tokyo",
  "TOKYO bay",
  "Osaka",
  "",
  " ",
  "  padded　",
  "İstanbul",
  "straße",
  "ΣΑΣ",
  "ᾳ",
  "ﬀ",
  "😀 smile",
  "｡",
  "10",
  "9",
  " 12.5 ",
  "1e3",
  ".5",
  "+3.",
  "abc",
  "2024-02-29",
  "2024-13-01",
  "2023-02-29",
  "2024-01-31T10:00",
  "2024-01-31 10:00:05.1234567",
  "naïve café",
  "a,b;c",
];

const COLUMNS: Column[] = [
  { name: "flag", type: "boolean" },
  { name: "i", type: "integer" },
  { name: "b", type: "bigint" },
  { name: "d", type: "decimal", precision: 10, scale: 2 },
  { name: "big", type: "decimal", precision: 38, scale: 4 },
  { name: "f", type: "float" },
  { name: "f32", type: "float", bits: 32 },
  { name: "s", type: "string" },
  { name: "word", type: "string" },
  { name: "day", type: "date" },
  { name: "at", type: "timestamp" },
  { name: "clock", type: "time" },
  { name: "id", type: "uuid" },
  { name: "span", type: "interval" },
];

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The text of a decimal from its integer at a scale. */
function decimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, point)}${scale > 0 ? `.${digits.slice(point)}` : ""}`;
}

/** A fraction of a second without trailing zeros, with its point; empty for 0. */
function fraction(micros: number): string {
  if (micros === 0) return "";
  return `.${pad(micros, 6).replace(/0+$/, "")}`;
}

function generateValue(column: Column, random: Random): JsonValue {
  const { int, pick, chance } = random;
  if (chance(0.08)) return null;
  switch (column.name) {
    case "flag":
      return chance(0.5);
    case "i":
      return chance(0.05) ? pick([2_147_483_647, -2_147_483_648]) : int(-50, 50);
    case "b":
      return chance(0.1) ? pick(["9223372036854775807", "-9223372036854775808", "9007199254740993"]) : int(-1000, 1000);
    case "d":
      return decimalText(BigInt(int(-100_000, 100_000)), 2);
    case "big":
      return chance(0.1)
        ? pick([`${"9".repeat(34)}.9999`, `-${"9".repeat(34)}.9999`])
        : decimalText(BigInt(int(-1e9, 1e9)) * BigInt(int(1, 1e6)), 4);
    case "f":
      return chance(0.12)
        ? pick(["NaN", "Infinity", "-Infinity", -0, 0, 0.1, 1e300, 5e-324])
        : Math.round((random.next() - 0.5) * 1e6) / 64;
    case "f32":
      return chance(0.1) ? pick(["NaN", Math.fround(0.1), 16777217 - 1, -0]) : Math.fround((random.next() - 0.5) * 1e4);
    case "s":
      return pick(WORDS);
    case "word":
      return pick(["Tokyo", "Osaka", "", "Nagoya"]);
    case "day":
      return chance(0.1)
        ? pick(["2024-02-29", "0001-01-01", "9999-12-31", "1970-01-01"])
        : `${int(1990, 2030)}-${pad(int(1, 12))}-${pad(int(1, 28))}`;
    case "at":
      return `${int(1990, 2030)}-${pad(int(1, 12))}-${pad(int(1, 28))} ${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}${fraction(chance(0.5) ? 0 : int(0, 999_999))}`;
    case "clock":
      return `${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}${fraction(chance(0.5) ? 0 : int(0, 999_999))}`;
    case "id":
      return chance(0.3)
        ? pick(["00000000-0000-0000-0000-000000000001", "ffffffff-ffff-ffff-ffff-ffffffffffff"])
        : Array.from({ length: 32 }, () => int(0, 15).toString(16))
            .join("")
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    case "span":
      return pick(["1 month", "30 days", "29 days", "01:00:00", "1 day 02:00:00", "1 year 2 months"]);
    default:
      throw new Error(column.name);
  }
}

function generateTable(random: Random): { columns: Column[]; rows: JsonValue[][] } {
  return {
    columns: COLUMNS,
    rows: Array.from({ length: ROWS }, () => COLUMNS.map((column) => generateValue(column, random))),
  };
}

// ----- the plans -----

type Kind = "bool" | "exact" | "float" | "string" | "date" | "timestamp" | "time" | "uuid" | "interval";

/** The columns of each kind that expressions may read; derived columns join them. */
type Pool = Record<Kind, string[]>;

function tablePool(): Pool {
  return {
    bool: ["flag"],
    exact: ["i", "b", "d", "big"],
    float: ["f", "f32"],
    string: ["s", "word"],
    date: ["day"],
    timestamp: ["at"],
    time: ["clock"],
    uuid: ["id"],
    interval: ["span"],
  };
}

const ORDERABLE: Kind[] = ["bool", "exact", "float", "string", "date", "timestamp", "time", "uuid"];

class Plans {
  constructor(
    private readonly random: Random,
    private readonly pool: Pool,
  ) {}

  private literal(kind: Kind): Json {
    const { pick, int, chance } = this.random;
    if (chance(0.05)) {
      const type = { bool: "boolean", exact: "bigint", float: "float", string: "string" }[kind as string] ?? kind;
      return { lit: null, type };
    }
    switch (kind) {
      case "bool":
        return { lit: chance(0.5) };
      case "exact":
        return pick([
          { lit: int(-20, 20) },
          { lit: "12.50", type: "decimal" },
          { lit: "-0.005", type: "decimal" },
          { lit: "9223372036854775807", type: "bigint" },
          { lit: int(-3, 3) },
        ]);
      case "float":
        return pick([{ lit: 0.5 }, { lit: "NaN", type: "float" }, { lit: -2.25 }, { lit: "Infinity", type: "float" }]);
      case "string":
        return { lit: pick(WORDS) };
      case "date":
        return { lit: pick(["2024-02-29", "2000-01-01", "2030-12-31"]), type: "date" };
      case "timestamp":
        return { lit: pick(["2024-01-31 12:00:00", "2010-06-15 00:00:00.5"]), type: "timestamp" };
      case "time":
        return { lit: pick(["12:00:00", "00:00:00.25"]), type: "time" };
      case "uuid":
        return { lit: "80000000-0000-0000-0000-000000000000", type: "uuid" };
      case "interval":
        return { lit: pick(["30 days", "1 month"]), type: "interval" };
    }
  }

  private column(kind: Kind): Json | null {
    const names = this.pool[kind];
    return names.length > 0 ? { col: this.random.pick(names) } : null;
  }

  /** A whole number: an integer or bigint column, a small literal, or a length. */
  private whole(depth: number): Json {
    const { pick, int } = this.random;
    return pick<() => Json>([
      () => ({ col: pick(["i", "b"]) }),
      () => ({ lit: int(-2, 8) }),
      () => ({ fn: "length", args: [this.expr("string", depth - 1)] }),
    ])();
  }

  /**
   * A value whose text form is taken. Floats only as the 64-bit column holds them: a float that a function computes
   * may differ in its last digit between JavaScript's Math and DuckDB's libm, and its text with it; and DuckDB writes
   * some 32-bit floats with more than the shortest digits of §2.4.1 (−3395.90625, whose shortest 8 digits tie).
   */
  private textual(depth: number): Json {
    const kind = this.random.pick<Kind>([...ORDERABLE, "interval"]);
    return kind === "float" ? { col: "f" } : this.expr(kind, depth);
  }

  private call(fn: string, ...args: Json[]): Json {
    return { fn, args };
  }

  /** An expression of a kind. */
  expr(kind: Kind, depth: number): Json {
    const { pick, chance, int } = this.random;
    if (depth <= 0 || chance(0.3)) return (chance(0.75) ? this.column(kind) : null) ?? this.literal(kind);
    const e = (k: Kind) => this.expr(k, depth - 1);
    const number = () => e(chance(0.6) ? "exact" : "float");
    const same = (k: Kind) => [e(k), e(k)];
    const choices: (() => Json)[] = [() => this.call("coalesce", e(kind), e(kind))];
    if (kind !== "bool") choices.push(() => this.call("if", e("bool"), e(kind), e(kind)));
    switch (kind) {
      case "bool":
        choices.push(
          () => {
            const compared = pick<Kind>([...ORDERABLE, "interval"]);
            const fn = pick(["eq", "ne", "lt", "le", "gt", "ge"]);
            if (compared === "exact" || compared === "float") return this.call(fn, number(), number());
            if (compared === "date" || compared === "timestamp")
              return this.call(fn, e(pick(["date", "timestamp"])), e(pick(["date", "timestamp"])));
            return this.call(fn, ...same(compared));
          },
          () => this.call(pick(["and", "or"]), ...Array.from({ length: int(2, 3) }, () => e("bool"))),
          () => this.call("not", e("bool")),
          () => this.call("is_null", e(pick(ORDERABLE))),
          () => this.call("is_blank", e(pick(ORDERABLE))),
          () => this.call(pick(["contains", "starts_with", "ends_with"]), e("string"), e("string")),
          () =>
            this.call(
              "in",
              e("string"),
              ...Array.from({ length: int(1, 3) }, () => ({ lit: pick(["Tokyo", "", "Osaka", "9"]) })),
            ),
          () => this.call("in", e("exact"), ...Array.from({ length: int(1, 3) }, () => ({ lit: int(-5, 5) }))),
        );
        break;
      case "exact":
        choices.push(
          () => this.call(pick(["add", "sub", "mul", "mod"]), e("exact"), e("exact")),
          () => this.call(pick(["neg", "abs", "floor", "ceil"]), e("exact")),
          () => this.call("round", e("exact"), { lit: int(-3, 3) }),
          () => this.call("sign", number()),
          () => this.call("length", e("string")),
          () => this.call(pick(["year", "month", "day", "isodow"]), e(pick(["date", "timestamp"]))),
          () => this.call(pick(["hour", "minute", "second"]), e(pick(["time", "timestamp"]))),
          () => this.call("date_diff_days", e(pick(["date", "timestamp"])), e(pick(["date", "timestamp"]))),
          () => this.call(pick(["least", "greatest"]), e("exact"), e("exact")),
        );
        break;
      case "float":
        choices.push(
          () => this.call(pick(["add", "sub", "mul"]), e("float"), number()),
          // A divisor that a function computes may differ in its last digit, which mod magnifies.
          () => this.call("mod", e("float"), this.column(pick(["exact", "float"])) ?? this.literal("float")),
          () => this.call("div", number(), number()),
          () => this.call(pick(["sqrt", "exp", "ln", "log10"]), number()),
          () => this.call("power", number(), number()),
          () => this.call("to_number", e("string")),
          () => this.call(pick(["neg", "abs", "floor", "ceil"]), e("float")),
          () => this.call("round", e("float"), { lit: int(-2, 2) }),
          () => this.call(pick(["least", "greatest"]), e("float"), number()),
        );
        break;
      case "string":
        choices.push(
          () => this.call("concat", ...Array.from({ length: int(1, 3) }, () => this.textual(depth - 1))),
          () => this.call(pick(["lower", "upper", "trim"]), e("string")),
          () => this.call(pick(["left", "right"]), e("string"), this.whole(depth - 1)),
          () =>
            chance(0.5)
              ? this.call("substr", e("string"), this.whole(depth - 1))
              : this.call("substr", e("string"), this.whole(depth - 1), this.whole(depth - 1)),
          () => this.call("replace", e("string"), { lit: pick(["o", "", "To", "ß"]) }, e("string")),
          () => this.call("text", this.textual(depth - 1)),
          () => this.call(pick(["least", "greatest"]), e("string"), e("string")),
        );
        break;
      case "date":
        choices.push(
          () => this.call("to_date", e("string")),
          () => this.call("add_days", e("date"), this.whole(depth - 1)),
        );
        break;
      case "timestamp":
        choices.push(
          () => this.call("to_timestamp", e("string")),
          () => this.call("add_days", e("timestamp"), this.whole(depth - 1)),
          () => this.call(pick(["least", "greatest"]), e("timestamp"), e(pick(["date", "timestamp"]))),
        );
        break;
      default:
        break;
    }
    return pick(choices)();
  }

  /** A measure over the rows' columns. */
  private measure(name: string): Json {
    const { pick, chance } = this.random;
    const fn = pick(["count", "count", "count_distinct", "sum", "avg", "stddev", "min", "max", "quantile"]);
    if (fn === "count") return chance(0.5) ? { name, fn } : { name, fn, column: this.anyColumn(ORDERABLE) };
    if (fn === "count_distinct" || fn === "min" || fn === "max") {
      return { name, fn, column: this.anyColumn(ORDERABLE) };
    }
    const column = this.anyColumn(["exact", "float"]);
    return fn === "quantile" ? { name, fn, column, p: pick([0, 0.25, 0.5, 0.9, 1]) } : { name, fn, column };
  }

  private anyColumn(kinds: Kind[]): string {
    return this.random.pick(kinds.flatMap((kind) => this.pool[kind]));
  }

  plan(): Json {
    const { chance, int, pick } = this.random;
    const plan: Json = {};
    const derive: Json[] = [];
    for (let index = 0; index < int(0, 3); index++) {
      const kind = pick<Kind>(["bool", "exact", "exact", "float", "string", "string", "date", "timestamp"]);
      const name = `x${index}`;
      derive.push({ name, expr: this.expr(kind, int(1, 4)) });
      this.pool[kind].push(name);
    }
    if (derive.length > 0) plan.derive = derive;
    if (chance(0.6)) {
      const search = { search: pick(["tok", "O", "1", "2024", "nan", "ß", "İ", "😀", "-0", "true", "e+"]) };
      plan.where = pick([
        () => this.expr("bool", int(1, 4)),
        () => search,
        () => this.call("and", search, this.expr("bool", 2)),
      ])();
    }
    let viewColumns = [...COLUMNS.map((column) => column.name), ...derive.map((item) => item.name as string)];
    if (chance(0.35)) {
      const keys = [...new Set(Array.from({ length: int(0, 2) }, () => this.anyColumn(ORDERABLE)))];
      const measures = Array.from({ length: int(1, 3) }, (_, index) => this.measure(`m${index}`));
      const aggregate: Json = { keys, measures };
      const pivot = chance(0.25);
      if (pivot) {
        const free = ["word", "flag", "i"].filter((name) => !keys.includes(name));
        aggregate.pivot = { columns: [pick(free)], ...(chance(0.3) ? { maxColumns: int(1, 8) } : {}) };
      }
      plan.aggregate = aggregate;
      viewColumns = pivot ? keys : [...keys, ...measures.map((measure) => measure.name as string)];
      if (!pivot && chance(0.4)) {
        plan.having = this.call(pick(["gt", "ge", "lt", "ne"]), { col: pick(measures).name }, { lit: int(0, 3) });
      }
    }
    if (viewColumns.length > 0 && chance(0.7)) {
      plan.sort = Array.from({ length: int(1, 3) }, () => ({
        column: pick(viewColumns),
        direction: pick(["asc", "desc"]),
      }));
    }
    return plan;
  }
}

// ----- the engines -----

/**
 * Differences of this engine from the specification, kept until they are fixed: plans whose rows the memory
 * engine answers and this engine fails, known by the message of its error.
 */
const KNOWN = [
  {
    message: /Overflow in HUGEINT addition/,
    reason: "sum and avg of decimals of more than 18 digits overflow DuckDB's HUGEINT on the way (§3.8 sums exactly)",
  },
  {
    message: /STDDEV_SAMP is out of range/,
    reason: "stddev of floats near the largest overflows in DuckDB; the memory engine gives null",
  },
];

interface Answer {
  error?: { code: string; reason?: string; path?: string };
  columns?: Column[];
  rowCount?: number;
  rowIds?: number[] | null;
  rows?: JsonValue[][];
}

type Send = (op: Operation, members: Json) => Promise<Json>;

/** A plan's view, read whole: its columns, row IDs and rows, or the error of either read. */
async function answer(send: Send, table: { table: string; revision: string }, plan: Json): Promise<Answer> {
  const at = { table: table.table, revision: table.revision, plan };
  const probe = await send("rows", { ...at, start: 0, end: 0, columns: [] });
  if (probe.error) return { error: probe.error as Answer["error"] };
  const columns = (probe.result as { view: { columns: Column[] } }).view.columns;
  const read = columns.length > 0 ? columns.map((column) => column.name) : [];
  const response = await send("rows", { ...at, start: 0, end: ROWS + 1_000, columns: read });
  if (response.error) return { error: response.error as Answer["error"] };
  const result = response.result as {
    view: { rowCount: number };
    rowIds: number[] | null;
    block: { bytes: Uint8Array };
  };
  const block = decodeBlock(result.block.bytes);
  return { columns, rowCount: result.view.rowCount, rowIds: result.rowIds, rows: block.rows };
}

/** The differences between the memory engine's answer and this engine's; empty when they agree. */
function differences(memory: Answer, duckdb: Answer): string[] {
  const message = (duckdb.error as { message?: string } | undefined)?.message ?? "";
  if (!memory.error && duckdb.error && KNOWN.some((known) => known.message.test(message))) return ["known"];
  if (memory.error || duckdb.error) {
    const shown = (item: Answer) =>
      item.error ? `${item.error.code} ${item.error.reason ?? ""} ${item.error.path ?? ""}`.trim() : "rows";
    if (shown(memory) === shown(duckdb)) return [];
    const message = (item: Answer) => (item.error ? ` (${(item.error as { message?: string }).message})` : "");
    return [`memory: ${shown(memory)}${message(memory)}; duckdb: ${shown(duckdb)}${message(duckdb)}`];
  }
  const problems: string[] = [];
  const columns = memory.columns as Column[];
  const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
  if (JSON.stringify(columns.map(strip)) !== JSON.stringify((duckdb.columns as Column[]).map(strip))) {
    problems.push(`columns: ${JSON.stringify(columns)}; duckdb: ${JSON.stringify(duckdb.columns)}`);
    return problems;
  }
  if (memory.rowCount !== duckdb.rowCount) problems.push(`rowCount ${memory.rowCount}; duckdb ${duckdb.rowCount}`);
  if (JSON.stringify(memory.rowIds) !== JSON.stringify(duckdb.rowIds)) {
    problems.push(`rowIds ${JSON.stringify(memory.rowIds)}; duckdb ${JSON.stringify(duckdb.rowIds)}`);
  }
  const rows = memory.rows as JsonValue[][];
  rows.forEach((row, index) => {
    row.forEach((value, at) => {
      const other = duckdb.rows?.[index]?.[at] ?? null;
      if (problems.length < 8 && !same(value, other, columns[at])) {
        problems.push(`row ${index}, ${columns[at].name}: ${JSON.stringify(value)}; duckdb ${JSON.stringify(other)}`);
      }
    });
  });
  return problems;
}

let context: Awaited<ReturnType<typeof setUp>>;
let duckdbTable: TableInfo;
let memorySend: Send;
let memoryTable: { table: string; revision: string };
let parquetSend: Send;
let parquetTable: { table: string; revision: string; columns: Column[] };

/** Sends requests to a memory engine, checking every response against §8. */
function sender(engine: ReturnType<typeof memoryEngine>): Send {
  let id = 0;
  return async (op, members) => {
    const response = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
    checkResponse(response, op);
    return response;
  };
}

before(async () => {
  context = await setUp();
  const table = generateTable(generator(SEED));
  const file = path.join(context.workspace, "generated.parquet");
  await writeParquet(file, table);
  duckdbTable = await context.client.open(file);
  assert.equal(duckdbTable.status, "ready");
  memorySend = sender(memoryEngine({ tables: { generated: table } }));
  memoryTable = (await memorySend("open", { ref: "generated" })).result as { table: string; revision: string };
  parquetSend = sender(memoryEngine({ tables: { generated: { parquet: new Blob([await readFile(file)]) } } }));
  const opened = await parquetSend("open", { ref: "generated" });
  assert.ok(opened.result, JSON.stringify(opened.error));
  parquetTable = opened.result as typeof parquetTable;
});

after(async () => {
  await context.tearDown();
});

test("the generated table reads with the same columns and values in both engines", async () => {
  const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
  assert.deepEqual(duckdbTable.columns.map(strip), COLUMNS);
  const memory = await answer(memorySend, memoryTable, {});
  const duckdb = await answer((op, members) => context.client.send(op, members), duckdbTable, {});
  assert.deepEqual(differences(memory, duckdb), []);
  // The memory engine reads the Parquet file with the columns, source types included, that this engine reads.
  assert.deepEqual(parquetTable.columns, duckdbTable.columns);
  assert.deepEqual(differences(await answer(parquetSend, parquetTable, {}), duckdb), []);
});

test(`${PLANS} generated plans give the same answers in both engines (seed ${SEED})`, async (t) => {
  const failures: string[] = [];
  const outcomes = { rows: 0, errors: 0, known: 0 };
  const only = process.env.VASTGRID_ONLY;
  const seeds = only ? only.split(",").map(Number) : Array.from({ length: PLANS }, (_, index) => SEED * 1_000 + index);
  for (const seed of seeds) {
    const plan = new Plans(generator(seed), tablePool()).plan();
    const memory = await answer(memorySend, memoryTable, plan);
    const duckdb = await answer((op, members) => context.client.send(op, members), duckdbTable, plan);
    if (memory.error) {
      outcomes.errors++;
      if (process.env.VASTGRID_DEBUG) console.log(JSON.stringify(plan), JSON.stringify(memory.error));
    } else outcomes.rows++;
    const problems = differences(memory, duckdb);
    const parquet = differences(await answer(parquetSend, parquetTable, plan), duckdb);
    if (parquet.length > 0 && parquet[0] !== "known") problems.push(...parquet.map((problem) => `parquet: ${problem}`));
    if (only) t.diagnostic(JSON.stringify({ plan, memory, duckdb }));
    if (problems[0] === "known") outcomes.known++;
    else if (problems.length > 0) {
      failures.push(`plan ${seed}: ${JSON.stringify(plan)}\n  ${problems.join("\n  ")}`);
    }
  }
  t.diagnostic(
    `${outcomes.rows} plans answered with rows, ${outcomes.errors} with errors; ${outcomes.known} differ as KNOWN says`,
  );
  assert.equal(failures.length, 0, `${failures.length} plans differ:\n${failures.slice(0, 10).join("\n")}`);
  // The generator makes plans that run, not only plans that fail.
  if (!only) assert.ok(outcomes.rows > PLANS * 0.8, `${outcomes.rows} of ${PLANS} plans ran`);
});

// ----- find and export -----

/** The texts that finds look for: parts of words in any case, digits, and the text forms of floats and dates. */
const NEEDLES = [
  "tokyo",
  "TOKYO",
  "o",
  "ß",
  "SS",
  "i̇",
  "σ",
  "😀",
  "1",
  "0.",
  "-",
  "nan",
  "inf",
  "2024-0",
  ":0",
  "e+",
  ",",
];

/** The records of CSV or TSV as DuckDB writes them: fields quoted with `"`, records ending with LF. */
function records(text: string, delimiter: string): string[][] {
  const result: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted && char === '"' && text[at + 1] === '"') {
      field += '"';
      at++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (quoted || (char !== delimiter && char !== "\n")) {
      field += char;
    } else {
      record.push(field);
      field = "";
      if (char === "\n") {
        result.push(record);
        record = [];
      }
    }
  }
  return result;
}

/** A field of CSV as typed JSON of its column, so that floats compare within the tolerance. */
function fieldValue(text: string, column: Column): JsonValue {
  if (column.type !== "float") return text;
  return { nan: "NaN", inf: "Infinity", "-inf": "-Infinity" }[text] ?? Number(text);
}

/** A JSON export's rows, with each number as its text in the file. */
function jsonRows(bytes: Uint8Array): Record<string, JsonValue>[] {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? (context?.source ?? value) : value;
  return JSON.parse(new TextDecoder().decode(bytes), reviver as never);
}

/** A value of a JSON export as typed JSON of its column: numbers as their digits, floats as numbers. */
function jsonValue(value: JsonValue, column: Column): JsonValue {
  if (value === null) return null;
  if (column.type === "float") return fieldValue(String(value), column);
  // Decimals of up to 18 digits come from DuckDB without the zeros at their end (12.5 for 12.50).
  if (column.type === "decimal")
    return String(value)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  return String(value);
}

/** The entries of a ZIP archive by name, read by its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const data = Buffer.from(bytes);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = data.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let index = data.readUInt16LE(end + 10); index > 0; index--) {
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const offset = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    const raw = data.subarray(start, start + compressed);
    entries.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
  }
  return entries;
}

/** The file of an export of this engine, which it keeps for the host to serve. */
async function keptFile(response: Json): Promise<Buffer> {
  assert.ok(response.result, JSON.stringify(response.error));
  const kept = context.engine.exportFile((response.result as { target: string }).target);
  assert.ok(kept);
  return readFile(kept.path);
}

test("generated plans find the same cells and export the same files in both engines", async () => {
  const duckdbSend: Send = (op, members) => context.client.send(op, members);
  const ours = { table: memoryTable.table, revision: memoryTable.revision };
  const theirs = { table: duckdbTable.table, revision: duckdbTable.revision };
  const table = new Set(COLUMNS.map((column) => column.name));
  const failures: string[] = [];
  let compared = 0;
  for (let index = 0; index < 60 && failures.length < 5; index++) {
    const seed = SEED * 1_000 + index;
    const random = generator(seed);
    const plan = new Plans(generator(seed), tablePool()).plan();
    const memory = await answer(memorySend, memoryTable, plan);
    if (memory.error || differences(memory, await answer(duckdbSend, duckdbTable, plan)).length > 0) continue;
    compared++;
    const columns = memory.columns as Column[];
    const count = memory.rowCount as number;
    // Finds in the table's own columns, whose text forms are the same in both engines; derived floats may differ
    // in their last digits.
    const own = columns.filter((column) => table.has(column.name)).map((column) => column.name);
    for (let find = 0; find < 6 && own.length > 0 && count > 0; find++) {
      const names = Array.from({ length: random.int(1, 4) }, () => random.pick(own));
      const members = {
        plan,
        text: random.pick(NEEDLES),
        columns: names,
        from: { row: random.int(0, count - 1), column: random.int(0, names.length - 1) },
        direction: random.chance(0.5) ? 1 : -1,
        ...(random.chance(0.3) ? { caseSensitive: true } : {}),
      };
      const found = await memorySend("find", { ...ours, ...members });
      const other = await duckdbSend("find", { ...theirs, ...members });
      if (JSON.stringify(found.result ?? found.error) !== JSON.stringify(other.result ?? other.error)) {
        failures.push(
          `plan ${seed}: find ${JSON.stringify(members)}\n  memory ${JSON.stringify(found.result ?? found.error)}; duckdb ${JSON.stringify(other.result ?? other.error)}`,
        );
      }
    }
    // Exports of every column of the view, which hold the same rows: CSV and TSV field by field, JSON value by value.
    for (const format of ["csv", "tsv", "json"] as const) {
      const exported = await memorySend("export", { ...ours, plan, format });
      const other = await duckdbSend("export", { ...theirs, plan, format });
      if (exported.error || other.error) {
        failures.push(`plan ${seed}: ${format}: ${JSON.stringify(exported.error ?? other.error)}`);
        continue;
      }
      const bytes = ((exported.result as Json).data as { bytes: Uint8Array }).bytes;
      const file = await keptFile(other);
      assert.equal((exported.result as Json).rows, count);
      if (format === "json") {
        const mine = jsonRows(bytes);
        const other = jsonRows(file);
        assert.equal(mine.length, other.length);
        mine.forEach((row, at) => {
          for (const column of columns) {
            const a = jsonValue(row[column.name], column);
            const b = jsonValue(other[at][column.name], column);
            if (failures.length < 5 && !same(a, b, column) && a !== b) {
              failures.push(
                `plan ${seed}: json row ${at}, ${column.name}: ${JSON.stringify(a)}; duckdb ${JSON.stringify(b)}`,
              );
            }
          }
        });
        continue;
      }
      const delimiter = format === "tsv" ? "\t" : ",";
      const mine = records(new TextDecoder().decode(bytes), delimiter);
      const lines = records(file.toString("utf8"), delimiter);
      assert.equal(mine.length, count + 1);
      assert.deepEqual(mine[0], lines[0]);
      for (let at = 1; at < mine.length && failures.length < 5; at++) {
        mine[at].forEach((text, field) => {
          const other = lines[at]?.[field];
          const column = columns[field];
          if (text !== other && !same(fieldValue(text, column), fieldValue(other ?? "", column), column)) {
            failures.push(
              `plan ${seed}: ${format} line ${at}, ${column.name}: ${JSON.stringify(text)}; duckdb ${JSON.stringify(other)}`,
            );
          }
        });
      }
    }
  }
  // Workbooks of the table: the same sheet, compressed by either engine's deflate.
  const workbook = await memorySend("export", { ...ours, plan: {}, format: "xlsx" });
  assert.ok(workbook.result, JSON.stringify(workbook.error));
  const written = await duckdbSend("export", { ...theirs, plan: {}, format: "xlsx" });
  const mine = unzip(((workbook.result as Json).data as { bytes: Uint8Array }).bytes);
  const other = unzip(await keptFile(written));
  assert.deepEqual([...mine.keys()], [...other.keys()]);
  for (const [name, text] of mine) assert.equal(text, other.get(name), name);
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(compared > 40, `${compared} plans compared`);
});

// ----- Parquet files by byte ranges -----

/** Rows `start` to `end` of a view: their row IDs and values. */
async function page(
  send: Send,
  table: { table: string; revision: string },
  plan: Json,
  start: number,
  end: number,
  columns: string[],
) {
  const response = await send("rows", { table: table.table, revision: table.revision, plan, start, end, columns });
  assert.ok(response.result, JSON.stringify(response.error));
  const result = response.result as { rowIds: number[] | null; block: { bytes: Uint8Array } };
  return { rowIds: result.rowIds, rows: decodeBlock(result.block.bytes).rows };
}

test("reads a Parquet file over HTTP by range requests, the row groups of the rows it shows", async (t) => {
  const file = path.join(context.workspace, "groups.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  // 20,000 rows in row groups of 2,048, with a column of text that does not compress.
  await connection.run(
    `COPY (SELECT i, 'w' || (i * 7919 % 1000) AS word, CAST(i % 97 AS DECIMAL(6, 2)) / 4 AS amount,
       DATE '2020-01-01' + CAST(i % 1500 AS INTEGER) AS day, CASE WHEN i % 11 = 0 THEN NULL ELSE i * 0.5 END AS half,
       md5(CAST(i AS VARCHAR)) AS padding FROM range(20000) AS t(i))
     TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 2048)`,
  );
  connection.closeSync();
  instance.closeSync();
  const bytes = await readFile(file);
  // A server of the file that answers range requests and counts the bytes it sends.
  let sent = 0;
  let etag = '"one"';
  const server = http.createServer((request, response) => {
    response.setHeader("etag", etag);
    if (request.method === "HEAD") {
      response.setHeader("content-length", bytes.length);
      response.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2]) + 1, bytes.length) : bytes.length;
    if (range) {
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end - 1}/${bytes.length}`);
    }
    sent += end - start;
    response.end(bytes.subarray(start, end));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/groups.parquet`;
  const send = sender(memoryEngine({ tables: { groups: { parquet: url, editable: true } } }));
  const opened = await send("open", { ref: "groups" });
  assert.ok(opened.result, JSON.stringify(opened.error));
  const memory = opened.result as { table: string; revision: string; columns: Column[]; rowCount: number };
  // Opening reads the footer only.
  assert.ok(sent < bytes.length / 8, `${sent} of ${bytes.length} bytes to open`);
  const duckdb = await context.client.open(file);
  assert.deepEqual(memory.columns, duckdb.columns);
  assert.equal(memory.rowCount, 20_000);
  const duckdbSend: Send = (op, members) => context.client.send(op, members);
  const shown = ["i", "word", "amount", "day", "half"];
  // Rows in the middle read the row group that holds them, of the columns they show.
  let before = sent;
  const middle = await page(send, memory, {}, 10_000, 10_100, shown);
  assert.deepEqual(middle, await page(duckdbSend, duckdb, {}, 10_000, 10_100, shown));
  assert.ok(sent - before < bytes.length / 8, `${sent - before} of ${bytes.length} bytes for 100 rows`);
  // A sort reads whole the columns it sorts by, and the rows it shows by their row groups.
  before = sent;
  const plan = {
    sort: [
      { column: "word", direction: "desc" },
      { column: "half", direction: "asc" },
    ],
  };
  for (const [start, end] of [
    [0, 100],
    [19_950, 20_000],
  ]) {
    assert.deepEqual(
      await page(send, memory, plan, start, end, shown),
      await page(duckdbSend, duckdb, plan, start, end, shown),
    );
  }
  assert.ok(sent - before < bytes.length / 2, `${sent - before} of ${bytes.length} bytes to sort`);
  const filter = {
    where: { fn: "gt", args: [{ col: "amount" }, { lit: 20 }] },
    sort: [{ column: "day", direction: "asc" }],
  };
  assert.deepEqual(
    await page(send, memory, filter, 0, 300, shown),
    await page(duckdbSend, duckdb, filter, 0, 300, shown),
  );
  // A write is kept over the file, which is not read whole for it.
  before = sent;
  const written = await send("write", {
    table: memory.table,
    revision: memory.revision,
    updates: [{ key: { rowId: 15_000 }, column: "word", value: "written", previous: "w0" }],
  });
  assert.ok(written.result, JSON.stringify(written.error));
  const after = await page(send, memory, plan, 0, 1, ["i", "word"]);
  assert.deepEqual(after.rows, [[15_000, "written"]]);
  assert.deepEqual((await page(send, memory, {}, 15_000, 15_001, ["word"])).rows, [["written"]]);
  // Columns read whole are limited by maxBytes; rows read by their row groups are not.
  const small = sender(memoryEngine({ tables: { groups: { parquet: url, maxBytes: 100_000 } } }));
  const limited = (await small("open", { ref: "groups" })).result as typeof memory;
  assert.equal((await page(small, limited, {}, 0, 3, ["padding"])).rows.length, 3);
  const refused = await small("rows", {
    table: limited.table,
    revision: limited.revision,
    plan: { sort: [{ column: "padding", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["i"],
  });
  assert.equal((refused.error as { code: string } | undefined)?.code, "load_failed");
  assert.match((refused.error as { message: string }).message, /maxBytes/);
  // Room for the integers (162,500 bytes) or the dates (82,500), not both: a column that no request reads is
  // forgotten when another request needs its room, and a request that reads both at once fails.
  const one = sender(memoryEngine({ tables: { groups: { parquet: url, maxBytes: 170_000 } } }));
  const single = (await one("open", { ref: "groups" })).result as typeof memory;
  for (const column of ["i", "day", "i"]) {
    const sort = { sort: [{ column, direction: "desc" }] };
    assert.deepEqual(
      await page(one, single, sort, 0, 5, ["i", "day"]),
      await page(duckdbSend, duckdb, sort, 0, 5, ["i", "day"]),
    );
  }
  const both = await one("rows", {
    table: single.table,
    revision: single.revision,
    plan: { sort: [{ column: "day", direction: "asc" }] },
    start: 0,
    end: 1,
    columns: ["i"],
  });
  assert.ok(both.result, JSON.stringify(both.error));
  const together = await one("summarize", {
    table: single.table,
    revision: single.revision,
    plan: {},
    ranges: [[0, 20_000]],
    columns: ["i", "day"],
  });
  assert.equal((together.error as { code: string } | undefined)?.code, "load_failed");
  // A file that changes while it is open fails the reads of what was not read yet.
  etag = '"two"';
  const changed = await send("rows", {
    table: memory.table,
    revision: memory.revision,
    plan: {},
    start: 0,
    end: 10,
    columns: ["padding"],
  });
  assert.equal((changed.error as { code: string } | undefined)?.code, "file_changed");
});

/** Workbooks with every type of cell, sheets to choose, a layout that read options change, and notes. */
const WORKBOOKS: Record<string, FixtureWorkbook> = {
  "types.xlsx": {
    // Styles: 0 General, 1 date, 2 date and time, 3 time, 4 a Japanese date, 5 a percentage.
    numberFormats: [
      { id: 164, code: 'yyyy"年"m"月"d"日"' },
      { id: 165, code: "0.0%" },
    ],
    cellStyles: [0, 14, 22, 21, 164, 165],
    sharedStrings: [
      "id",
      "name",
      "price",
      "member",
      "day",
      "at",
      "time",
      "mixed",
      "formula",
      "jp",
      "rate",
      "東京",
      "x",
    ],
    sheets: [
      {
        name: "Data",
        rows: [
          row(
            1,
            Array.from({ length: 11 }, (_, index) => cell(`${String.fromCharCode(65 + index)}1`, { t: "s", v: index })),
          ),
          ...Array.from({ length: 40 }, (_, index) => {
            const at = index + 2;
            const cells = [
              cell(`A${at}`, { v: index % 7 === 3 ? 2 ** 53 + index : index }),
              cell(
                `B${at}`,
                index % 5 === 0 ? { t: "s", v: 11 + (index % 2) } : { t: "inlineStr", is: `name ${index}` },
              ),
              cell(`C${at}`, { v: index / 8 - 2 }),
              cell(`D${at}`, { t: "b", v: index % 2 }),
              cell(`E${at}`, { s: 1, v: 45306 + index * 31 }),
              cell(`F${at}`, { s: 2, v: 45306 + index / 24 }),
              cell(`G${at}`, { s: 3, v: (index % 24) / 24 }),
              cell(`H${at}`, index % 3 === 0 ? { t: "s", v: 12 } : { v: index }),
              cell(`I${at}`, index % 9 === 0 ? { f: "1/0", t: "e", v: "#DIV/0!" } : { f: `A${at}*2`, v: index * 2 }),
              cell(`J${at}`, { s: 4, v: 45306 - index }),
              cell(`K${at}`, { s: 5, v: index / 100 }),
            ];
            // Every sixth row has blank cells.
            return row(at, index % 6 === 5 ? cells.filter((_, column) => column % 2 === 0) : cells);
          }),
        ],
      },
    ],
  },
  "sheets.xlsx": {
    sharedStrings: ["name", "first", "second", "hidden"],
    chartSheet: "Chart",
    sheets: [
      {
        name: "Secret",
        state: "hidden",
        rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 3 })])],
      },
      { name: "First", rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 1 })])] },
      {
        name: "Second & more",
        rows: [row(1, [cell("A1", { t: "s", v: 0 })]), row(2, [cell("A2", { t: "s", v: 2 })])],
      },
    ],
  },
  "layout.xlsx": {
    sharedStrings: ["Report title", "name", "", "name", "value", "a", "b"],
    sheets: [
      {
        name: "S",
        merges: ["B1:D1"],
        rows: [
          row(1, [cell("B1", { t: "s", v: 0 })]),
          row(3, [
            cell("B3", { t: "s", v: 1 }),
            cell("C3", { t: "s", v: 2 }),
            cell("D3", { t: "s", v: 3 }),
            cell("F3", { t: "s", v: 4 }),
          ]),
          row(4, [cell("B4", { t: "s", v: 5 }), cell("D4", { v: 1 }), cell("F4", { f: "SUM(D:D)" })]),
          row(5, []),
          row(7, [cell("B7", { t: "s", v: 6 }), cell("C7", { v: 2 }), cell("F7", { v: 20 })]),
          row(9, [cell("A9", { s: 0 })]),
        ],
      },
    ],
  },
};

test("both engines read the same sheets of a workbook with the same read options", async () => {
  const cases: [string, Json | undefined][] = [
    ["types.xlsx", undefined],
    ["sheets.xlsx", undefined],
    ["sheets.xlsx", { sheet: "Second & more" }],
    ["sheets.xlsx", { sheet: "Secret", headerRow: 0 }],
    ["sheets.xlsx", { sheet: "Chart" }],
    ["layout.xlsx", undefined],
    ["layout.xlsx", { headerRow: 3 }],
    ["layout.xlsx", { headerRow: 3, keepEmptyRows: true, keepEmptyColumns: true }],
    ["layout.xlsx", { headerRow: 0, keepEmptyColumns: true }],
  ];
  const files = new Map<string, Uint8Array>();
  for (const [name, workbook] of Object.entries(WORKBOOKS)) {
    await writeWorkbook(path.join(context.workspace, name), workbook);
    files.set(name, await readFile(path.join(context.workspace, name)));
  }
  // A `File` is a workbook by its name; a `Blob` by the table's format.
  const send = sender(
    memoryEngine({
      tables: Object.fromEntries(
        [...files].map(([name, bytes], index) => [
          name,
          index % 2 === 0 ? { file: new File([bytes], name) } : { file: new Blob([bytes]), format: "xlsx" },
        ]),
      ),
    }),
  );
  for (const [name, read] of cases) {
    const label = `${name} ${JSON.stringify(read ?? {})}`;
    const duckdb = await context.client.open(name, read);
    const opened = await send("open", read === undefined ? { ref: name } : { ref: name, read });
    if (duckdb.status === "error") {
      // The memory engine reads a workbook before it answers, so a sheet it cannot read fails the open.
      const error = opened.error as { code: string; message: string };
      assert.equal(error.code, "load_failed", label);
      assert.ok(error.message.includes(duckdb.error as string), `${label}: ${error.message}`);
      continue;
    }
    assert.ok(opened.result, `${label}: ${JSON.stringify(opened.error)}`);
    const memory = opened.result as TableInfo;
    const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
    assert.deepEqual(memory.columns, duckdb.columns.map(strip), label);
    for (const member of ["sheets", "sheet", "notes"] as const) assert.deepEqual(memory[member], duckdb[member], label);
    const duckdbSend: Send = (op, members) => context.client.send(op, members);
    for (const plan of [{}, { sort: [{ column: duckdb.columns[0].name, direction: "desc" }] }]) {
      const differs = differences(await answer(send, memory, plan), await answer(duckdbSend, duckdb, plan));
      assert.deepEqual(differs, [], `${label} ${JSON.stringify(plan)}`);
    }
  }
  // Read options other than a workbook's are ignored, as before.
  const csv = sender(memoryEngine({ tables: { csv: { file: new File(["a\n1\n"], "a.csv") } } }));
  const plain = (await csv("open", { ref: "csv", read: { sheet: "Other" } })).result as TableInfo;
  assert.deepEqual(plain.columns, [{ name: "a", type: "integer" }]);
  assert.equal(plain.sheets, undefined);
});
