/**
 * A generated table and generated plans, finds and exports, which engines answer alike (docs/spec.md §10): the
 * tests of this package compare its engine with the memory engine of `vastgrid-js` by them, and those of
 * `vastgrid-notebook` its Python engine with the memory engine. The table holds the edges of every type (NaN, the
 * infinities, −0.0, bigints beyond 2^53, decimals of 38 digits, surrogate pairs, letters whose case JavaScript maps
 * otherwise, leap days); the plans derive, filter, search, group, pivot and sort. A seeded generator makes them, so
 * that a run is repeatable.
 */
import { inflateRawSync } from "node:zlib";
import type { memoryEngine } from "vastgrid-js";
import { type Column, checkResponse, decodeBlock, type JsonValue, type Operation } from "vastgrid-spec";
import { sameValue } from "vastgrid-spec/conformance";

export type Json = Record<string, unknown>;

/** The rows of the generated table. */
export const ROWS = 240;
/** The relative difference that floats may have: the order of additions, and libm against JavaScript's Math. */
export const TOLERANCE = 1e-9;
/** Floats below the smallest normal float, which DuckDB's interpolation may flush to 0. */
export const SUBNORMAL = 2.2250738585072014e-308;

/** Whether two values of a column are the same, floats within the tolerance and subnormal floats alike. */
export function same(a: JsonValue, b: JsonValue, column: Column): boolean {
  if (sameValue(a, b, column, TOLERANCE)) return true;
  return (
    column.type === "float" &&
    typeof a === "number" &&
    typeof b === "number" &&
    Math.abs(a) < SUBNORMAL &&
    Math.abs(b) < SUBNORMAL
  );
}

/**
 * A summary's counts exactly, its least and greatest within the tolerance, and its sum and average within the error
 * that additions of floats in another order may make: the tolerance of the largest number, once for each number.
 */
export function sameSummary(a: Json, b: Json): boolean {
  const float: Column = { name: "", type: "float" };
  const count = a.numericCount as number;
  const largest = Math.max(Math.abs(Number(a.min)), Math.abs(Number(a.max)));
  const near = (x: JsonValue, y: JsonValue, error: number) =>
    same(x, y, float) || (typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= error * 1e-9);
  return (
    a.count === b.count &&
    count === b.numericCount &&
    same(a.min as JsonValue, b.min as JsonValue, float) &&
    same(a.max as JsonValue, b.max as JsonValue, float) &&
    near(a.sum as JsonValue, b.sum as JsonValue, largest * count) &&
    near(a.average as JsonValue, b.average as JsonValue, largest)
  );
}

/** A pseudo-random generator with a seed (mulberry32). */
export function generator(seed: number) {
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

export type Random = ReturnType<typeof generator>;

// ----- the table -----

export const WORDS = [
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

export const COLUMNS: Column[] = [
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

export const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The text of a decimal from its integer at a scale. */
export function decimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, point)}${scale > 0 ? `.${digits.slice(point)}` : ""}`;
}

/** A fraction of a second without trailing zeros, with its point; empty for 0. */
export function fraction(micros: number): string {
  if (micros === 0) return "";
  return `.${pad(micros, 6).replace(/0+$/, "")}`;
}

export function generateValue(column: Column, random: Random): JsonValue {
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

export function generateTable(random: Random): { columns: Column[]; rows: JsonValue[][] } {
  return {
    columns: COLUMNS,
    rows: Array.from({ length: ROWS }, () => COLUMNS.map((column) => generateValue(column, random))),
  };
}

// ----- the plans -----

export type Kind = "bool" | "exact" | "float" | "string" | "date" | "timestamp" | "time" | "uuid" | "interval";

/** The columns of each kind that expressions may read; derived columns join them. */
export type Pool = Record<Kind, string[]>;

export function tablePool(): Pool {
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

export const ORDERABLE: Kind[] = ["bool", "exact", "float", "string", "date", "timestamp", "time", "uuid"];

export class Plans {
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

/**
 * Differences of this engine from the specification, kept until they are fixed: plans whose rows the memory
 * engine answers and this engine fails, known by the message of its error.
 */
export const KNOWN = [
  {
    message: /Overflow in HUGEINT addition/,
    reason: "sum and avg of decimals of more than 18 digits overflow DuckDB's HUGEINT on the way (§3.8 sums exactly)",
  },
  {
    message: /STDDEV_SAMP is out of range/,
    reason: "stddev of floats near the largest overflows in DuckDB; the memory engine gives null",
  },
];

export interface Answer {
  error?: { code: string; reason?: string; path?: string };
  columns?: Column[];
  rowCount?: number;
  rowIds?: number[] | null;
  rows?: JsonValue[][];
}

export type Send = (op: Operation, members: Json) => Promise<Json>;

/** A plan's view, read whole: its columns, row IDs and rows, or the error of either read. */
export async function answer(send: Send, table: { table: string; revision: string }, plan: Json): Promise<Answer> {
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
export function differences(memory: Answer, duckdb: Answer): string[] {
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
  const otherRows = duckdb.rows as JsonValue[][];
  if (rows.length !== otherRows.length) problems.push(`rows read ${rows.length}; duckdb ${otherRows.length}`);
  for (const [engine, values] of [
    ["memory", rows],
    ["duckdb", otherRows],
  ] as const) {
    values.forEach((row, index) => {
      if (row.length !== columns.length) {
        problems.push(`${engine} row ${index}: ${row.length} cells, expected ${columns.length}`);
      }
    });
  }
  rows.forEach((row, index) => {
    const other = otherRows[index];
    if (!other || row.length !== columns.length || other.length !== columns.length) return;
    row.forEach((value, at) => {
      if (problems.length < 8 && !same(value, other[at], columns[at])) {
        problems.push(
          `row ${index}, ${columns[at].name}: ${JSON.stringify(value)}; duckdb ${JSON.stringify(other[at])}`,
        );
      }
    });
  });
  return problems;
}

/** Sends requests to a memory engine, checking every response against §8. */
export function sender(engine: ReturnType<typeof memoryEngine>): Send {
  let id = 0;
  return async (op, members) => {
    const response = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
    checkResponse(response, op);
    return response;
  };
}

/** The texts that finds look for: parts of words in any case, digits, and the text forms of floats and dates. */
export const NEEDLES = [
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
export function records(text: string, delimiter: string): string[][] {
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
export function fieldValue(text: string, column: Column): JsonValue {
  if (column.type !== "float") return text;
  return { nan: "NaN", inf: "Infinity", "-inf": "-Infinity" }[text] ?? Number(text);
}

/** A JSON export's rows, with each number as its text in the file. */
export function jsonRows(bytes: Uint8Array): Record<string, JsonValue>[] {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? (context?.source ?? value) : value;
  return JSON.parse(new TextDecoder().decode(bytes), reviver as never);
}

/** A value of a JSON export as typed JSON of its column: numbers as their digits, floats as numbers. */
export function jsonValue(value: JsonValue, column: Column): JsonValue {
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
export function unzip(bytes: Uint8Array): Map<string, string> {
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
