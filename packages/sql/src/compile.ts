/**
 * Plans as DuckDB SQL (docs/spec.md §3, §4). The SQL implements the specification, not DuckDB's defaults
 * where they differ. User values are bound as parameters and names are always quoted. The session's time zone
 * must be UTC, so that the text form of `timestamptz` values is the one of §2.4.
 */
import {
  type CallExpr,
  type CheckedMeasure,
  type CheckedPlan,
  type Column,
  exactNumberText,
  type ExprType,
  FOLD_TABLES,
  type Fold,
  foldAll,
  infinityOf,
  isValueOf,
  type LiteralExpr,
  parseTimestampText,
  sameType,
  SpecError,
  type TypedExpr,
  uniqueName,
  type ValueType,
  valueOfText,
  valueType,
} from "vastgrid-spec";

export type SqlValue = string | number | boolean | null;

/** A statement and its parameters (`$1`, `$2`, …). */
export interface SqlQuery {
  sql: string;
  params: SqlValue[];
}

/** Where a table's rows come from. */
export interface SqlSource {
  /** The relation as SQL: a quoted table name, or a table function. */
  relation: string;
  /** The relation's column of row IDs (§1), as SQL. */
  rowId: string;
  /** Parameters that `relation` uses, as `$1`, `$2`, … */
  params?: SqlValue[];
  /** Quoted SQL identifiers in `relation` when source column names differ only in case. */
  columns?: Readonly<Record<string, string>>;
}

/** The text forms of the values of a pivot's combinations, in order, as `pivotQuery` reads them. */
export type PivotCombinations = (string | null)[][];

/** A view as SQL: `with` defines the relation `vg_view`, which holds the view's columns. */
export interface SqlView {
  with: string;
  params: SqlValue[];
  columns: Column[];
  /** The quoted SQL identifier of each column in `vg_view`, by column name. */
  identifiers: Record<string, string>;
  /** ORDER BY terms that order the view totally (§3.3). */
  order: string[];
  rowIds: boolean;
  /** The column of `vg_view` that holds row IDs, when the view has them. */
  rowId: string | null;
}

/** The quoted SQL identifier of a column in `vg_view`. */
export function viewColumn(view: SqlView, name: string): string {
  return Object.hasOwn(view.identifiers, name) ? view.identifiers[name] : quoteIdentifier(name);
}

const NUMBER_PATTERN = "[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?";
/** The first and the last date (§2.2). */
export const FIRST_DATE = "DATE '-290308-12-22'";
export const LAST_DATE = "DATE '294247-01-10'";
const DATE_PATTERN = "[0-9]{4}-[0-9]{2}-[0-9]{2}";
const TIMESTAMP_PATTERN = "[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,9})?)?";
const FLOAT_TOKENS = new Map([
  ["NaN", "'NaN'"],
  ["Infinity", "'Infinity'"],
  ["-Infinity", "'-Infinity'"],
]);

class Params {
  readonly values: SqlValue[];

  constructor(initial: readonly SqlValue[] = []) {
    this.values = [...initial];
  }

  add(value: SqlValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** A name as a DuckDB identifier. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The DuckDB type of a logical type (§2.1). */
export function duckdbType(type: ValueType): string {
  switch (type.type) {
    case "boolean":
      return "BOOLEAN";
    case "integer":
      return "INTEGER";
    case "bigint":
      return "BIGINT";
    case "decimal":
      return `DECIMAL(${type.precision ?? 38},${type.scale ?? 0})`;
    case "float":
      return type.bits === 32 ? "FLOAT" : "DOUBLE";
    case "string":
      return "VARCHAR";
    case "date":
      return "DATE";
    case "time":
      return "TIME";
    case "timestamp":
      switch (type.unit) {
        case "s":
          return "TIMESTAMP_S";
        case "ms":
          return "TIMESTAMP_MS";
        case "ns":
          return "TIMESTAMP_NS";
        default:
          return "TIMESTAMP";
      }
    case "timestamptz":
      return "TIMESTAMPTZ";
    case "interval":
      return "INTERVAL";
    case "uuid":
      return "UUID";
    case "binary":
      return "BLOB";
  }
}

const SIMPLE_SQL = /^(?:"(?:[^"]|"")+"|vg_[a-z0-9_]+|\$[0-9]+|NULL|TRUE|FALSE)$/;

/** Evaluates `sql` once when `body` refers to it more than once. */
function letSql(sql: string, body: (value: string) => string, name = "vg_v"): string {
  return SIMPLE_SQL.test(sql) ? body(sql) : `list_transform([${sql}], lambda ${name}: ${body(name)})[1]`;
}

/**
 * The SQL of the text form (§2.4) of a value of a type. DuckDB writes a decimal without whole digits, such as a
 * decimal(1, 1), as `.5` and `-.5`, where §2.4 writes `0.5` and `-0.5` (Appendix B).
 */
export function textSql(sql: string, type: ValueType): string {
  if (type.type === "string") return sql;
  const scale = type.scale ?? 0;
  if (type.type === "decimal" && scale > 0 && scale === (type.precision ?? 38)) {
    return `regexp_replace(CAST(${sql} AS VARCHAR), '^(-?)\\.', '\\10.')`;
  }
  if (type.type === "float" && type.bits === 32) {
    // DuckDB writes some 32-bit floats with all their exact digits (5525.71875 for 5525.7188): the shortest digits
    // that read back as the same float, which `printf` rounds halves to even, written as the double they are.
    return letSql(sql, (val) => {
      const text = `CAST(${val} AS VARCHAR)`;
      const shortest = Array.from({ length: 8 }, (_, digits) => {
        const rounded = `printf('%.${digits}e', ${val})`;
        return `WHEN CAST(${rounded} AS FLOAT) = ${val} THEN CAST(CAST(${rounded} AS DOUBLE) AS VARCHAR)`;
      });
      return `(CASE WHEN NOT isfinite(${val}) THEN ${text} ${shortest.join(" ")} ELSE ${text} END)`;
    });
  }
  return `CAST(${sql} AS VARCHAR)`;
}

/**
 * A count of code points from `low`: below it counts as `low`, and beyond 2^32 − 1, the most that DuckDB's
 * `substring` takes, as 2^32 − 1, which no string reaches.
 */
function atLeast(sql: string, low: number) {
  return letSql(
    `CAST(${sql} AS BIGINT)`,
    (value) => `(CASE WHEN ${value} < ${low} THEN ${low} WHEN ${value} > 4294967295 THEN 4294967295 ELSE ${value} END)`,
  );
}

function cast(sql: string, type: ValueType) {
  return `CAST(${sql} AS ${duckdbType(type)})`;
}

function tryCast(sql: string, type: ValueType) {
  return `TRY_CAST(${sql} AS ${duckdbType(type)})`;
}

/**
 * A float as text that DuckDB reads back as the same float, with the sign of −0.0. Floats are bound as text:
 * `@duckdb/node-api` binds numbers without a fraction, such as 1e20, as BIGINT.
 */
export function floatParam(value: number): string {
  return Object.is(value, -0) ? "-0.0" : String(value);
}

/** The text of a date or a timestamp (§2.2) as DuckDB reads it: years after 9999 without their `+`. */
export function temporalParam(text: string): string {
  return text.startsWith("+") ? text.slice(1) : text;
}

/** The types whose values may be infinite. */
const FINITE_TYPES = new Set(["float", "date", "timestamp", "timestamptz"]);
const NANOS_INFINITY = "CAST('10000000000000000000000000' AS HUGEINT)";

/** Null unless the number, the date or the timestamp is finite (§3.6). */
function finite(sql: string) {
  return letSql(sql, (val) => `(CASE WHEN isfinite(${val}) THEN ${val} END)`);
}

function isExactType(type: ExprType): type is ValueType {
  return type.type === "integer" || type.type === "bigint" || type.type === "decimal";
}

function exactDigits(type: ValueType): { p: number; s: number } {
  if (type.type === "integer") return { p: 10, s: 0 };
  if (type.type === "bigint") return { p: 19, s: 0 };
  return { p: type.precision ?? 38, s: type.scale ?? 0 };
}

function needsWideExactCompare(types: readonly ExprType[]): boolean {
  const exact: { p: number; s: number }[] = [];
  for (const type of types) {
    if (type.type === "null") continue;
    if (!isExactType(type)) return false;
    exact.push(exactDigits(type));
  }
  if (exact.length < 2) return false;
  const whole = Math.max(...exact.map(({ p, s }) => p - s));
  const scale = Math.max(...exact.map(({ s }) => s));
  return whole + scale > 38;
}

function exactParts(sql: string, type: ExprType): { whole: string; fraction: string } {
  if (type.type === "null") {
    return { whole: "CAST(NULL AS DECIMAL(38,0))", fraction: "CAST(NULL AS DECIMAL(38,38))" };
  }
  const { p, s } = exactDigits(type);
  if (s === 0) {
    return {
      whole: `CAST(${sql} AS DECIMAL(38,0))`,
      fraction: `(CASE WHEN ${sql} IS NOT NULL THEN CAST(0 AS DECIMAL(38,38)) END)`,
    };
  }
  if (s === p) {
    return {
      whole: `(CASE WHEN ${sql} IS NOT NULL THEN CAST(0 AS DECIMAL(38,0)) END)`,
      fraction: `CAST(${sql} AS DECIMAL(38,38))`,
    };
  }
  return {
    whole: `CAST(trunc(${sql}) AS DECIMAL(38,0))`,
    fraction: `CAST(${sql} - CAST(trunc(${sql}) AS DECIMAL(${p},${s})) AS DECIMAL(38,38))`,
  };
}

/** Inserts a fixed decimal point into an unscaled signed integer text at `scale` fractional digits. */
function scaledDigitsText(digitsSql: string, scale: number): string {
  if (scale === 0) return digitsSql;
  return letSql(digitsSql, (value) => {
    const magnitude = `ltrim(${value}, '-')`;
    const padded = `lpad(${magnitude}, CAST(greatest(length(${magnitude}), ${scale + 1}) AS INTEGER), '0')`;
    const sign = `(CASE WHEN starts_with(${value}, '-') THEN '-' ELSE '' END)`;
    return `(${sign} || regexp_replace(${padded}, '([0-9]{${scale}})$', '.\\1'))`;
  });
}

/** An exact value as an unscaled BIGNUM at `targetScale` fractional digits. */
function unscaledBignum(sql: string, type: ExprType, targetScale: number): string {
  if (type.type === "null") return "CAST(NULL AS BIGNUM)";
  const { s } = exactDigits(type);
  const raw = s > 0 ? `replace(CAST(${sql} AS VARCHAR), '.', '')` : `CAST(${sql} AS VARCHAR)`;
  const zeros = targetScale > s ? ` || '${"0".repeat(targetScale - s)}'` : "";
  return `CAST((${raw}${zeros}) AS BIGNUM)`;
}

function bignumDecimal(bignumSql: string, type: ValueType): string {
  return tryCast(scaledDigitsText(`CAST(${bignumSql} AS VARCHAR)`, type.scale ?? 0), type);
}

/** Exact decimal remainder when scale-aligned precision exceeds 38 digits (where DuckDB's `%` promotes to DOUBLE). */
function wideMod(leftSql: string, s1: number, rightSql: string, s2: number, type: ValueType): string {
  const scale = type.scale ?? 0;
  let body: string;
  if (s1 <= s2) {
    const shift = s2 - s1;
    const rem =
      shift === 0
        ? "(vg_m.ua % vg_m.ub)"
        : `list_reduce(CAST(range(${shift}) AS INTEGER[]), lambda vg_r, vg_i: ((((((vg_r * 2) % vg_m.ub) * 2) % vg_m.ub + vg_r) % vg_m.ub) * 2) % vg_m.ub, vg_m.ua % vg_m.ub)`;
    const signed = `((CASE WHEN vg_m.neg AND vg_d > 0 THEN '-' ELSE '' END) || CAST(vg_d AS VARCHAR))`;
    body = `list_transform([${rem}], lambda vg_d: ${tryCast(scaledDigitsText(signed, scale), type)})[1]`;
  } else {
    const shift = s1 - s2;
    const pow = `CAST('1${"0".repeat(shift)}' AS UHUGEINT)`;
    const digits = `(CASE WHEN vg_d.hi = 0 THEN CAST(vg_d.lo AS VARCHAR) ELSE CAST(vg_d.hi AS VARCHAR) || lpad(CAST(vg_d.lo AS VARCHAR), ${shift}, '0') END)`;
    const signed = `((CASE WHEN vg_m.neg AND (vg_d.hi > 0 OR vg_d.lo > 0) THEN '-' ELSE '' END) || ${digits})`;
    body = `list_transform([struct_pack(hi := (vg_m.ua // ${pow}) % vg_m.ub, lo := vg_m.ua % ${pow})], lambda vg_d: ${tryCast(scaledDigitsText(signed, scale), type)})[1]`;
  }
  return `list_transform([struct_pack(a := ${leftSql}, b := ${rightSql})], lambda vg_a: CASE WHEN vg_a.a IS NOT NULL AND vg_a.b IS NOT NULL THEN list_transform([struct_pack(ua := CAST(ltrim(replace(CAST(vg_a.a AS VARCHAR), '.', ''), '-') AS UHUGEINT), ub := CAST(ltrim(replace(CAST(vg_a.b AS VARCHAR), '.', ''), '-') AS UHUGEINT), neg := vg_a.a < 0)], lambda vg_m: CASE WHEN vg_m.ub > 0 THEN ${body} END)[1] END)[1]`;
}

function needsMixedNsCompare(types: readonly ExprType[]): boolean {
  let hasNs = false;
  let hasWider = false;
  for (const type of types) {
    if (type.type === "timestamp" && type.unit === "ns") hasNs = true;
    else if (type.type === "date" || type.type === "timestamp") hasWider = true;
  }
  return hasNs && hasWider;
}

/** A date or timestamp as nanoseconds since 1970-01-01 in HUGEINT, with ±10^25 for ±infinity (§3.1). */
function temporalNanos(sql: string, type: ExprType): string {
  if (type.type === "null") return "CAST(NULL AS HUGEINT)";
  return letSql(sql, (val) => {
    let finiteCount: string;
    if (type.type === "date") {
      finiteCount = `CAST(${val} - DATE '1970-01-01' AS HUGEINT) * 86400000000000`;
    } else if (type.type === "timestamp" && type.unit === "ns") {
      finiteCount = `CAST(epoch_ns(${val}) AS HUGEINT)`;
    } else if (type.type === "timestamp" && type.unit === "ms") {
      finiteCount = `CAST(epoch_ms(${val}) AS HUGEINT) * 1000000`;
    } else if (type.type === "timestamp" && type.unit === "s") {
      finiteCount = `CAST(epoch_us(CAST(${val} AS TIMESTAMP)) AS HUGEINT) * 1000`;
    } else {
      finiteCount = `CAST(epoch_us(${val}) AS HUGEINT) * 1000`;
    }
    return `(CASE WHEN isfinite(${val}) THEN ${finiteCount} WHEN ${val} = 'infinity' THEN ${NANOS_INFINITY} WHEN ${val} = '-infinity' THEN -${NANOS_INFINITY} END)`;
  });
}

/** Allocates quoted SQL identifiers that never collide in DuckDB's case-insensitive catalog. */
class IdentifierScope {
  private readonly used: Set<string>;
  readonly map: Record<string, string> = Object.create(null);
  private next = 0;

  constructor(reserved: Iterable<string> = []) {
    // DuckDB also binds quoted column references to lambda parameters of the same name.
    this.used = new Set(
      ["vg_v", "vg_l", "vg_r", "vg_w", "vg_c", "vg_a", "vg_n", "vg_m", "vg_i", "vg_d", ...reserved].map((name) =>
        name.toLowerCase(),
      ),
    );
  }

  allocate(name: string): string {
    const lower = name.toLowerCase();
    let sql: string;
    if (!this.used.has(lower)) {
      this.used.add(lower);
      sql = quoteIdentifier(name);
    } else {
      let candidate = `vg_c${this.next++}`;
      while (this.used.has(candidate)) candidate = `vg_c${this.next++}`;
      this.used.add(candidate);
      sql = quoteIdentifier(candidate);
    }
    this.map[name] = sql;
    return sql;
  }
}

/** Parts of one fold's table (`FOLD_TABLES`): pairs of two code points to one, then single code points. */
interface FoldPart {
  pairs: [string, string][];
  singles: [string, string][];
}

/** Folds that change at most this many single code points use `replace`, which is faster than `translate`. */
const REPLACED_SINGLES = 16;

/** The whole table of a fold, as its part. */
function foldPart(fold: Fold): FoldPart {
  const { pairs, from, to } = FOLD_TABLES[fold];
  const targets = [...to];
  return { pairs, singles: [...from].map((source, index): [string, string] => [source, targets[index]]) };
}

/**
 * The parts of a search's folds that can change whether a value holds its text (§3.5): the entries that make one of
 * the folded text's code points, after the later folds and `lower`, and those whose own code points are among them.
 * Any other entry makes a code point that no occurrence of the folded text holds, folded or not, so a value without
 * it holds the folded text exactly when the value folded with it does. `lower` maps one code point to one in
 * DuckDB, and to that one among others in JavaScript (`İ` to `i̇`), so the code points looked for are a superset.
 */
function searchFolds(text: string, folds: readonly Fold[]): FoldPart[] {
  const wanted = new Set<string>();
  for (const char of foldAll(text, folds)) {
    wanted.add(char);
    for (const lower of char.toLowerCase()) wanted.add(lower);
  }
  const reaches = (value: string) => [...value, ...value.toLowerCase()].some((char) => wanted.has(char));
  return folds.map((fold, index) => {
    const after = folds.slice(index + 1);
    const { pairs, singles } = foldPart(fold);
    const needed = ([source, target]: [string, string]) => reaches(source) || reaches(foldAll(target, after));
    return {
      pairs: pairs.filter(
        (pair) => needed(pair) || [...pair[0]].some((char) => reaches(foldAll(char, folds.slice(index)))),
      ),
      singles: singles.filter(needed),
    };
  });
}

/** An RE2 class of code points, as escapes and ranges: `[\x{3041}-\x{3096}]`. */
function codePointClass(chars: readonly string[]): string {
  const codes = [...new Set(chars.map((char) => char.codePointAt(0) as number))].sort((a, b) => a - b);
  const escape = (code: number) => `\\x{${code.toString(16)}}`;
  let result = "";
  for (let start = 0; start < codes.length;) {
    let end = start;
    while (end + 1 < codes.length && codes[end + 1] === codes[end] + 1) end++;
    result += end > start ? `${escape(codes[start])}-${escape(codes[end])}` : escape(codes[start]);
    start = end + 1;
  }
  return `[${result}]`;
}

class Compiler {
  readonly params: Params;
  private readonly tables = new Map<string, string>();
  private columns: Readonly<Record<string, string>> = {};

  constructor(params: Params) {
    this.params = params;
  }

  setColumns(columns: Readonly<Record<string, string>>) {
    this.columns = columns;
  }

  column(name: string): string {
    return Object.hasOwn(this.columns, name) ? this.columns[name] : quoteIdentifier(name);
  }

  expression(node: TypedExpr): string {
    switch (node.kind) {
      case "column":
        return this.column(node.name);
      case "literal":
        return this.literal(node);
      case "search": {
        if (node.columns.length === 0) return "FALSE";
        // The folds first, then lower (§3.5). The text is folded here, by the same tables. Values are folded only by
        // the parts of the folds that the search needs, and only strings: the other text forms are ASCII, which no
        // fold changes.
        const text = `lower(CAST(${this.params.add(foldAll(node.text, node.fold))} AS VARCHAR))`;
        const parts = searchFolds(node.text, node.fold);
        const matches = node.columns.map((column) => {
          const value = textSql(this.column(column.name), column);
          return `coalesce(contains(lower(${column.type === "string" ? this.folded(value, parts) : value}), ${text}), FALSE)`;
        });
        return `(${matches.join(" OR ")})`;
      }
      case "call":
        return this.call(node);
    }
  }

  /** A text of the folds' tables as a parameter: the same text is one parameter in the whole plan. */
  private constant(value: string): string {
    let param = this.tables.get(value);
    if (param === undefined) {
      param = this.params.add(value);
      this.tables.set(value, param);
    }
    return `CAST(${param} AS VARCHAR)`;
  }

  /**
   * A value folded by parts of folds (§4.4): their pairs first, two code points to one, then each code point, by
   * `replace` when they are few and by `translate` otherwise. DuckDB's `translate` costs about 100 ns a row
   * whatever it changes, so `guarded` values are folded only when they hold a code point that the parts change:
   * `guarded` repeats the value, so it is only for values that cost nothing to repeat, such as columns.
   */
  private folded(sql: string, parts: readonly FoldPart[], guarded = true): string {
    let result = sql;
    const sources: string[] = [];
    for (const { pairs, singles } of parts) {
      for (const [pair, letter] of pairs) {
        result = `replace(${result}, ${this.constant(pair)}, ${this.constant(letter)})`;
        sources.push(String.fromCodePoint(pair.codePointAt(0) as number));
      }
      if (singles.length <= REPLACED_SINGLES) {
        for (const [from, to] of singles) result = `replace(${result}, ${this.constant(from)}, ${this.constant(to)})`;
      } else {
        const from = singles.map(([source]) => source).join("");
        result = `translate(${result}, ${this.constant(from)}, ${this.constant(singles.map(([, target]) => target).join(""))})`;
      }
      sources.push(...singles.map(([source]) => source));
    }
    if (sources.length === 0) return sql;
    if (!guarded) return result;
    return `(CASE WHEN regexp_matches(${sql}, ${this.constant(codePointClass(sources))}) THEN ${result} ELSE ${sql} END)`;
  }

  literal(node: LiteralExpr): string {
    const type = node.type;
    if (type.type === "null") return "NULL";
    if (node.value === null) return `CAST(NULL AS ${duckdbType(type)})`;
    switch (type.type) {
      case "boolean":
        return node.value === true ? "TRUE" : "FALSE";
      case "float": {
        const target = duckdbType(type);
        if (typeof node.value === "number") {
          return `CAST(CAST(${this.params.add(floatParam(node.value))} AS VARCHAR) AS ${target})`;
        }
        const token = FLOAT_TOKENS.get(String(node.value));
        if (!token) throw new RangeError(`${String(node.value)} is not a float.`);
        return `CAST(${token} AS ${target})`;
      }
      case "string":
        return `CAST(${this.params.add(String(node.value))} AS VARCHAR)`;
      case "binary":
        return `from_base64(CAST(${this.params.add(String(node.value))} AS VARCHAR))`;
      case "timestamp":
        if (type.unit === "ns" && infinityOf(String(node.value)) === 0) {
          const count = String(parseTimestampText(String(node.value), "ns"));
          return `make_timestamp_ns(CAST(${this.params.add(count)} AS BIGINT))`;
        }
        return cast(`CAST(${this.params.add(temporalParam(String(node.value)))} AS VARCHAR)`, type);
      case "date":
      case "timestamptz":
        return cast(`CAST(${this.params.add(temporalParam(String(node.value)))} AS VARCHAR)`, type);
      default:
        return cast(`CAST(${this.params.add(String(node.value))} AS VARCHAR)`, type);
    }
  }

  /** A number argument: floats that are not finite become null (§3.6). */
  private number(node: TypedExpr) {
    const sql = this.expression(node);
    return node.type.type === "float" ? finite(sql) : sql;
  }

  private double(node: TypedExpr) {
    return `CAST(${this.number(node)} AS DOUBLE)`;
  }

  /**
   * An exact operand of a decimal operation: integers are decimal(10, 0) and bigints decimal(19, 0) (§3.7). With
   * `wide`, it has 19 digits at least.
   */
  private exact(node: TypedExpr, wide = false) {
    const sql = this.expression(node);
    if (node.type.type === "integer") return `CAST(${sql} AS DECIMAL(${wide ? 19 : 10},0))`;
    if (node.type.type === "bigint") return `CAST(${sql} AS DECIMAL(19,0))`;
    if (wide && node.type.type === "decimal" && (node.type.precision ?? 38) < 19) {
      return `CAST(${sql} AS DECIMAL(19,${node.type.scale ?? 0}))`;
    }
    return sql;
  }

  private text(node: TypedExpr) {
    const sql = this.expression(node);
    return node.type.type === "null" ? sql : textSql(sql, node.type);
  }

  private compare(fn: "eq" | "ne" | "lt" | "le" | "gt" | "ge", left: TypedExpr, right: TypedExpr): string {
    const op = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" }[fn];
    const types = [left.type, right.type];
    if (types.some((item) => item.type === "float")) {
      const side = (node: TypedExpr) =>
        node.type.type === "null" ? "CAST(NULL AS DOUBLE)" : `CAST(${this.expression(node)} AS DOUBLE)`;
      return `(${side(left)} ${op} ${side(right)})`;
    }
    if (needsMixedNsCompare(types)) {
      return `(${temporalNanos(this.expression(left), left.type)} ${op} ${temporalNanos(this.expression(right), right.type)})`;
    }
    if (needsWideExactCompare(types)) {
      return letSql(
        this.expression(left),
        (lv) =>
          letSql(
            this.expression(right),
            (rv) => {
              const a = exactParts(lv, left.type);
              const b = exactParts(rv, right.type);
              switch (fn) {
                case "eq":
                  return `(${a.whole} = ${b.whole} AND ${a.fraction} = ${b.fraction})`;
                case "ne":
                  return `(${a.whole} <> ${b.whole} OR ${a.fraction} <> ${b.fraction})`;
                case "lt":
                  return `(${a.whole} < ${b.whole} OR (${a.whole} = ${b.whole} AND ${a.fraction} < ${b.fraction}))`;
                case "le":
                  return `(${a.whole} < ${b.whole} OR (${a.whole} = ${b.whole} AND ${a.fraction} <= ${b.fraction}))`;
                case "gt":
                  return `(${a.whole} > ${b.whole} OR (${a.whole} = ${b.whole} AND ${a.fraction} > ${b.fraction}))`;
                case "ge":
                  return `(${a.whole} > ${b.whole} OR (${a.whole} = ${b.whole} AND ${a.fraction} >= ${b.fraction}))`;
              }
            },
            "vg_r",
          ),
        "vg_l",
      );
    }
    return `(${this.expression(left)} ${op} ${this.expression(right)})`;
  }

  private inList(args: readonly TypedExpr[]): string {
    const types = args.map((item) => item.type);
    if (types.some((item) => item.type === "float")) {
      // Only a pair that includes a float compares in DOUBLE (§3.1). Keep exact candidates exact.
      const left = args[0];
      if (left.type.type !== "float") {
        const exact = args.slice(1).filter((arg) => arg.type.type !== "float");
        const floats = args.slice(1).filter((arg) => arg.type.type === "float");
        if (exact.length && floats.length) {
          return `(${this.inList([left, ...exact])} OR ${this.inList([left, ...floats])})`;
        }
      }
      const side = (node: TypedExpr) =>
        node.type.type === "null" ? "CAST(NULL AS DOUBLE)" : `CAST(${this.expression(node)} AS DOUBLE)`;
      return `(${side(args[0])} IN (${args.slice(1).map(side).join(", ")}))`;
    }
    if (needsMixedNsCompare(types)) {
      const side = (node: TypedExpr) => temporalNanos(this.expression(node), node.type);
      return `(${side(args[0])} IN (${args.slice(1).map(side).join(", ")}))`;
    }
    if (needsWideExactCompare(types)) {
      const rights = args.slice(1).map((item) => exactParts(this.expression(item), item.type));
      return letSql(
        this.expression(args[0]),
        (lv) => {
          const left = exactParts(lv, args[0].type);
          const terms = rights.map(
            (right) => `(${left.whole} = ${right.whole} AND ${left.fraction} = ${right.fraction})`,
          );
          return `(${terms.join(" OR ")})`;
        },
        "vg_l",
      );
    }
    return `(${this.expression(args[0])} IN (${args
      .slice(1)
      .map((item) => this.expression(item))
      .join(", ")}))`;
  }

  private call(node: CallExpr): string {
    const { args, type } = node;
    const arg = (index: number) => this.expression(args[index]);
    const all = (separator: string) => args.map((item) => this.expression(item)).join(separator);
    // Values in their common type (§4.4); a value that does not fit it is null (§3.6).
    const typed = () => args.map((item) => tryCast(this.expression(item), type)).join(", ");
    switch (node.fn) {
      case "and":
        return `(${all(" AND ")})`;
      case "or":
        return `(${all(" OR ")})`;
      case "not":
        return `(NOT ${arg(0)})`;
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
        return this.compare(node.fn, args[0], args[1]);
      case "in":
        return this.inList(args);
      case "is_null":
        return `(${arg(0)} IS NULL)`;
      case "is_blank": {
        if (args[0].type.type === "null") return "TRUE";
        const value = arg(0);
        return args[0].type.type === "string"
          ? letSql(value, (val) => `(${val} IS NULL OR ${val} = '')`)
          : `(${value} IS NULL)`;
      }
      case "if":
        return `(CASE WHEN ${arg(0)} THEN ${tryCast(arg(1), type)} ELSE ${tryCast(arg(2), type)} END)`;
      case "coalesce": {
        if (args.every((item) => item.type.type !== "null" && sameType(item.type, type))) {
          return `coalesce(${args.map((_, index) => arg(index)).join(", ")})`;
        }
        // The first value that is not null, in the common type: null when it does not fit, as in the JS engine.
        const fields = args.map((_, index) => `a${index} := ${arg(index)}`).join(", ");
        const cases = args.map((_, index) => `WHEN vg_c.a${index} IS NOT NULL THEN ${tryCast(`vg_c.a${index}`, type)}`);
        return `list_transform([struct_pack(${fields})], lambda vg_c: CASE ${cases.join(" ")} END)[1]`;
      }
      case "least":
      case "greatest": {
        const argTypes = args.map((item) => item.type);
        if (needsMixedNsCompare(argTypes)) {
          const chosen = `${node.fn}(${args.map((item) => temporalNanos(this.expression(item), item.type)).join(", ")})`;
          return letSql(
            chosen,
            (val) =>
              `(CASE WHEN ${val} = ${NANOS_INFINITY} THEN TIMESTAMP_NS 'infinity' WHEN ${val} = -${NANOS_INFINITY} THEN TIMESTAMP_NS '-infinity' WHEN ${val} BETWEEN -9223372036854775806 AND 9223372036854775806 THEN make_timestamp_ns(CAST(${val} AS BIGINT)) END)`,
            "vg_n",
          );
        }
        if (type.type === "decimal") {
          const maxWhole = (type.precision ?? 38) - (type.scale ?? 0);
          const canOverflow = args.some((item) => {
            if (item.type.type === "null") return false;
            const { p, s } = exactDigits(item.type);
            return p - s > maxWhole;
          });
          if (canOverflow) {
            const scale = type.scale ?? 0;
            const chosen = `${node.fn}(${args.map((item) => unscaledBignum(this.expression(item), item.type, scale)).join(", ")})`;
            return bignumDecimal(chosen, type);
          }
        }
        return `${node.fn}(${typed()})`;
      }
      case "add":
      case "sub":
      case "mul":
      case "mod": {
        const operator = { add: "+", sub: "-", mul: "*", mod: "%" }[node.fn];
        if (type.type === "float") return finite(`(${this.double(args[0])} ${operator} ${this.double(args[1])})`);
        if (type.type === "bigint") return `TRY(CAST(${arg(0)} AS BIGINT) ${operator} CAST(${arg(1)} AS BIGINT))`;
        if (type.type === "decimal" && node.fn !== "mul") {
          const x = exactDigits(args[0].type as ValueType);
          const y = exactDigits(args[1].type as ValueType);
          const whole = Math.max(x.p - x.s, y.p - y.s);
          const scale = Math.max(x.s, y.s);
          if (node.fn === "mod" && whole + scale > 38) {
            return wideMod(arg(0), x.s, arg(1), y.s, type);
          }
          if ((node.fn === "add" || node.fn === "sub") && whole + scale + 1 > 38) {
            return bignumDecimal(
              `(${unscaledBignum(arg(0), args[0].type, scale)} ${operator} ${unscaledBignum(arg(1), args[1].type, scale)})`,
              type,
            );
          }
        }
        // DuckDB multiplies two decimals of at most 18 digits in 18 digits and fails past them; a left operand of
        // 19 digits makes it keep every digit of the product.
        const wide = node.fn === "mul" && type.type === "decimal" && (type.precision ?? 38) > 18;
        return `TRY(${cast(`(${this.exact(args[0], wide)} ${operator} ${this.exact(args[1])})`, type)})`;
      }
      case "div":
        return finite(`(${this.double(args[0])} / ${this.double(args[1])})`);
      case "neg":
        return type.type === "float" ? finite(`(-${this.number(args[0])})`) : `TRY(${cast(`(-${arg(0)})`, type)})`;
      case "abs":
        return type.type === "float" ? finite(`abs(${this.number(args[0])})`) : `TRY(${cast(`abs(${arg(0)})`, type)})`;
      case "round": {
        const digits = args.length === 2 ? Number((args[1] as LiteralExpr).value) : 0;
        // 64-bit, also for a 32-bit float column (§3.7).
        if (type.type === "float") return finite(`round(${this.double(args[0])}, ${digits})`);
        if (type.type !== "decimal" && digits >= 0) return arg(0);
        // Rounding past the type's range fails, which TRY makes null (§3.6).
        return `TRY(${cast(`round(${arg(0)}, ${digits})`, type)})`;
      }
      case "floor":
      case "ceil":
        if (type.type === "float") return finite(`${node.fn}(${this.number(args[0])})`);
        if (type.type === "decimal") return cast(`${node.fn}(${arg(0)})`, type);
        return arg(0);
      case "bin": {
        // The greatest multiple of the width that is not above the number (§4.4); a remainder below zero is moved
        // up by the width, which cannot overflow.
        if (type.type === "float") {
          return letSql(
            this.double(args[1]),
            (width) => finite(`(floor(${this.double(args[0])} / ${width}) * ${width})`),
            "vg_w",
          );
        }
        const exact = exactNumberText(Number((args[1] as LiteralExpr).value)) as string;
        const step = cast(`CAST(${this.params.add(exact)} AS VARCHAR)`, type);
        return letSql(arg(0), (val) => {
          const rest = `(${val} % ${step})`;
          return `TRY(${cast(`(${val} - (CASE WHEN ${rest} < 0 THEN ${rest} + ${step} ELSE ${rest} END))`, type)})`;
        });
      }
      case "sqrt":
      case "exp":
      case "ln":
      case "log10":
        return finite(`TRY(${node.fn}(${this.double(args[0])}))`);
      case "power":
        return finite(`TRY(power(${this.double(args[0])}, ${this.double(args[1])}))`);
      case "sign":
        return `CAST(sign(${this.number(args[0])}) AS INTEGER)`;
      case "to_number":
        return letSql(
          `trim(${arg(0)})`,
          (value) =>
            `(CASE WHEN regexp_full_match(${value}, '${NUMBER_PATTERN}') THEN ${finite(`TRY_CAST(${value} AS DOUBLE)`)} END)`,
        );
      case "concat":
        return `concat(${args.map((item) => this.text(item)).join(", ")})`;
      case "length":
        return `CAST(length(${arg(0)}) AS BIGINT)`;
      case "lower":
      case "upper":
      case "trim":
        return `${node.fn}(${arg(0)})`;
      case "left":
      case "right":
        return `${node.fn}(${arg(0)}, ${atLeast(arg(1), 0)})`;
      case "substr": {
        const start = atLeast(arg(1), 1);
        return args.length === 3
          ? `substring(${arg(0)}, ${start}, ${atLeast(arg(2), 0)})`
          : `substring(${arg(0)}, ${start})`;
      }
      case "fold":
        return this.folded(arg(0), [foldPart((args[1] as LiteralExpr).value as Fold)], args[0].kind === "column");
      case "replace":
        return `replace(${arg(0)}, ${arg(1)}, ${arg(2)})`;
      case "contains":
      case "starts_with":
      case "ends_with":
        return `${node.fn}(${arg(0)}, ${arg(1)})`;
      case "text":
        return this.text(args[0]);
      case "to_date":
        return letSql(
          arg(0),
          (value) => `(CASE WHEN regexp_full_match(${value}, '${DATE_PATTERN}') THEN TRY_CAST(${value} AS DATE) END)`,
        );
      case "to_timestamp":
        return letSql(
          arg(0),
          (value) =>
            `(CASE WHEN regexp_full_match(${value}, '${TIMESTAMP_PATTERN}') THEN TRY_CAST(replace(${value}, 'T', ' ') AS TIMESTAMP) END)`,
        );
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
      case "isodow":
        return `CAST(${node.fn}(${arg(0)}) AS BIGINT)`;
      case "date_diff_days": {
        const mixed = args[0].type.type !== args[1].type.type;
        const side = (index: number) => (mixed ? `CAST(${arg(index)} AS TIMESTAMP)` : arg(index));
        return `date_diff('day', ${side(0)}, ${side(1)})`;
      }
      case "add_days": {
        const days = `TRY_CAST(${arg(1)} AS INTEGER)`;
        // The dates of §2.2, as the JS engine gives them: DuckDB's dates go further, and its timestamps do not.
        // DuckDB keeps an infinity, which gives null (§3.6).
        if (type.type === "date") {
          return letSql(
            `TRY(${arg(0)} + ${days})`,
            (sum) => `(CASE WHEN ${sum} BETWEEN ${FIRST_DATE} AND ${LAST_DATE} THEN ${sum} END)`,
          );
        }
        if (type.unit === "ns") {
          return `list_transform([struct_pack(t := ${arg(0)}, d := ${days})], lambda vg_a: CASE WHEN isfinite(vg_a.t) AND vg_a.d IS NOT NULL THEN list_transform([CAST(epoch_ns(vg_a.t) AS HUGEINT) + CAST(vg_a.d AS HUGEINT) * 86400000000000], lambda vg_n: CASE WHEN vg_n BETWEEN -9223372036854775806 AND 9223372036854775806 THEN make_timestamp_ns(CAST(vg_n AS BIGINT)) END)[1] END)[1]`;
        }
        const base = type.unit ? `CAST(${arg(0)} AS TIMESTAMP)` : arg(0);
        const sum = finite(`TRY(${base} + to_days(${days}))`);
        return type.unit ? tryCast(sum, type) : sum;
      }
    }
  }

  /**
   * A wide decimal's unscaled digits always fit BIGNUM, including when the sum exceeds 38 digits.
   * DuckDB does not cast DECIMAL to BIGNUM exactly, so read the digits from its fixed-scale text.
   */
  private wideDecimalSumText(measure: CheckedMeasure, filter: string): string | null {
    const decimal = measure.column;
    if (decimal?.type !== "decimal" || (decimal.precision ?? 38) <= 18) return null;
    const column = this.column(decimal.name);
    const scale = decimal.scale ?? 0;
    const digits = `CAST(replace(CAST(${column} AS VARCHAR), '.', '') AS BIGNUM)`;
    return scaledDigitsText(`CAST(sum(${digits})${filter} AS VARCHAR)`, scale);
  }

  /** A measure (§3.8, §4.5), optionally over the rows of a pivot's combination. */
  measure(measure: CheckedMeasure, condition?: string): string {
    const column = measure.column ? this.column(measure.column.name) : null;
    const conditions: string[] = [];
    // Measures leave out NaN and the infinities of floats, dates and timestamps (§3.8).
    const finiteType = measure.column && FINITE_TYPES.has(measure.column.type);
    if (finiteType && measure.fn !== "count" && measure.fn !== "count_distinct") conditions.push(`isfinite(${column})`);
    if (condition) conditions.push(condition);
    const filter = conditions.length > 0 ? ` FILTER (WHERE ${conditions.join(" AND ")})` : "";
    switch (measure.fn) {
      case "count":
        return `count(${column ?? "*"})${filter}`;
      case "count_distinct":
        return measure.approx ? `approx_count_distinct(${column})${filter}` : `count(DISTINCT ${column})${filter}`;
      case "sum": {
        if (measure.type.type === "float") return `sum(${column})${filter}`;
        const scale = measure.type.scale ?? 0;
        const wideText = this.wideDecimalSumText(measure, filter);
        if (wideText) return `TRY_CAST(${wideText} AS ${duckdbType(measure.type)})`;
        // DuckDB refuses aggregates inside TRY(); TRY_CAST takes them. The sum of integers is a HUGEINT, which
        // holds more than 38 digits: a sum beyond them is null (§3.8).
        const sum = `TRY_CAST(sum(${column})${filter} AS ${duckdbType(measure.type)})`;
        const largest = `${"9".repeat(38 - scale)}${scale > 0 ? `.${"9".repeat(scale)}` : ""}`;
        return `(CASE WHEN abs(${sum}) <= ${largest} THEN ${sum} END)`;
      }
      case "avg": {
        const wideText = this.wideDecimalSumText(measure, filter);
        if (wideText) return finite(`(CAST(${wideText} AS DOUBLE) / count(${column})${filter})`);
        return `CAST(avg(${column})${filter} AS DOUBLE)`;
      }
      case "stddev": {
        // DuckDB gives the infinities and NaN for squares beyond the largest float; the JS engine gives null.
        const stddev = `CAST(stddev_samp(${column})${filter} AS DOUBLE)`;
        return `(CASE WHEN isfinite(${stddev}) THEN ${stddev} END)`;
      }
      case "min":
      case "max":
        return `${measure.fn}(${column})${filter}`;
      case "quantile": {
        // DuckDB interpolates temporal values in microseconds and gives a TIMESTAMP for a DATE (§3.8); its
        // approx_quantile gives a DATE or TIMESTAMP_NS instead, so temporal quantiles always use quantile_cont.
        if (measure.type.type !== "float") {
          const result = `quantile_cont(${column}, ${Number(measure.p)})${filter}`;
          if (measure.type.type === "time") return result;
          // Overflow can be infinity (epoch_us gives null) or -2^63. Check the first valid date (§3.8).
          // The text round-trip blocks range propagation, which wrongly assumes quantiles stay within their inputs.
          const count = `CAST(CAST(epoch_us(${result}) AS VARCHAR) AS BIGINT)`;
          return `(CASE WHEN ${count} >= epoch_us(${FIRST_DATE}) THEN ${result} END)`;
        }
        const fn = measure.approx ? "approx_quantile" : "quantile_cont";
        // Interpolated in doubles, also for a 32-bit float column (§3.7).
        return `${fn}(CAST(${column} AS DOUBLE), ${Number(measure.p)})${filter}`;
      }
    }
  }
}

/** ORDER BY terms of one sort key: blanks last in both directions (§3.3). */
function sortTerms(sql: string, type: ValueType, direction: "asc" | "desc") {
  const order = direction === "desc" ? "DESC" : "ASC";
  return type.type === "string" ? [`NULLIF(${sql}, '') ${order} NULLS LAST`] : [`${sql} ${order} NULLS LAST`];
}

/** The value of a group's key: DuckDB keeps the first row's, which may be −0.0 where §3.9 reads 0.0, and source dates/times outside §2.2 read as null. */
function keySql(sql: string, column: Column): string {
  if (column.type === "float") return `(${sql} + CAST(0 AS ${duckdbType(column)}))`;
  if (column.type === "date") {
    return letSql(
      sql,
      (val) => `(CASE WHEN ${val} BETWEEN ${FIRST_DATE} AND ${LAST_DATE} OR NOT isfinite(${val}) THEN ${val} END)`,
    );
  }
  if (column.type === "time") {
    return letSql(sql, (val) => `(CASE WHEN ${val} < TIME '24:00:00' THEN ${val} END)`);
  }
  return sql;
}

/** ORDER BY terms of group keys (§3.9): ascending, blanks last, the empty string before null. */
function keyTerms(sql: string, column: Column) {
  return column.type === "string"
    ? [`NULLIF(${sql}, '') ASC NULLS LAST`, `${sql} ASC NULLS LAST`]
    : [`${sql} ASC NULLS LAST`];
}

/** A name for the column of row IDs that no column of the plan has, ignoring case. */
function rowIdName(plan: CheckedPlan): string {
  const names = new Set(plan.rows.map((column) => column.name.toLowerCase()));
  let alias = "vg_row";
  while (names.has(alias)) alias = `${alias}_`;
  return alias;
}

/** The `WITH` entries up to `vg_rows`, the rows that `where` keeps, with the derived columns. */
function rowsWith(
  plan: CheckedPlan,
  source: SqlSource,
  compiler: Compiler,
  rowIdRaw: string,
): { entries: string[]; identifiers: Record<string, string>; alias: string } {
  const scope = new IdentifierScope([rowIdRaw]);
  const alias = quoteIdentifier(rowIdRaw);
  const columns = plan.table.map((column) => {
    const raw =
      source.columns && Object.hasOwn(source.columns, column.name)
        ? source.columns[column.name]
        : quoteIdentifier(column.name);
    const id = scope.allocate(column.name);
    return raw === id ? id : `${raw} AS ${id}`;
  });
  compiler.setColumns(scope.map);
  const entries = [
    `vg_base AS (SELECT ${[...columns, `${source.rowId} AS ${alias}`].join(", ")} FROM ${source.relation})`,
  ];
  let previous = "vg_base";
  plan.derive.forEach((item, index) => {
    const name = `vg_derive${index + 1}`;
    const expr = compiler.expression(item.expr);
    const id = scope.allocate(item.name);
    entries.push(`${name} AS (SELECT *, ${expr} AS ${id} FROM ${previous})`);
    previous = name;
  });
  const where = plan.where ? ` WHERE ${compiler.expression(plan.where)}` : "";
  entries.push(`vg_rows AS (SELECT * FROM ${previous}${where})`);
  return { entries, identifiers: { ...scope.map }, alias };
}

/**
 * The query that reads the combinations of a pivot's values (§4.6), as their text forms, in order. It reads
 * one more combination than the pivot may make columns for, so that `compileView` can refuse too many.
 */
export function pivotQuery(plan: CheckedPlan, source: SqlSource): SqlQuery {
  const pivot = plan.aggregate?.pivot;
  if (!pivot || !plan.aggregate) throw new RangeError("The plan has no pivot.");
  const compiler = new Compiler(new Params(source.params));
  const { entries } = rowsWith(plan, source, compiler, rowIdName(plan));
  const ids = pivot.columns.map((column) => compiler.column(column.name));
  const distinct = pivot.columns.map((column, index) => {
    const expr = keySql(ids[index], column);
    return expr === ids[index] ? ids[index] : `${expr} AS ${ids[index]}`;
  });
  const texts = pivot.columns.map(
    (column, index) => `${textSql(`vg_distinct.${ids[index]}`, column)} AS "vg_value${index}"`,
  );
  const order = pivot.columns.flatMap((column, index) => keyTerms(`vg_distinct.${ids[index]}`, column));
  const limit = Math.floor(pivot.maxColumns / plan.aggregate.measures.length) + 1;
  const sql = `WITH ${entries.join(", ")} SELECT ${texts.join(", ")} FROM (SELECT DISTINCT ${distinct.join(", ")} FROM vg_rows) vg_distinct ORDER BY ${order.join(", ")} LIMIT ${limit}`;
  return { sql, params: compiler.params.values };
}

/**
 * The view of a checked plan as SQL. A pivot needs the combinations that `pivotQuery` read, and fails with
 * `too_many_columns` when they would make more columns than its `maxColumns`.
 */
export function compileView(plan: CheckedPlan, source: SqlSource, combinations?: PivotCombinations): SqlView {
  const compiler = new Compiler(new Params(source.params));
  const { entries, identifiers: rowIds, alias } = rowsWith(plan, source, compiler, rowIdName(plan));
  if (!plan.aggregate) {
    const order = plan.sort.flatMap((key) => sortTerms(rowIds[key.column.name], key.column, key.direction));
    entries.push("vg_view AS (SELECT * FROM vg_rows)");
    return {
      with: `WITH ${entries.join(", ")}`,
      params: compiler.params.values,
      columns: plan.columns,
      identifiers: rowIds,
      order: [...order, `${alias} ASC`],
      rowIds: true,
      rowId: alias,
    };
  }
  const { keys, measures, pivot } = plan.aggregate;
  const columns = [...plan.columns];
  const groupScope = new IdentifierScope();
  const outputs = keys.map((key) => `${keySql(rowIds[key.name], key)} AS ${groupScope.allocate(key.name)}`);
  if (pivot) {
    if (!combinations) throw new RangeError("A pivot needs the combinations that pivotQuery reads.");
    if (combinations.length > Math.floor(pivot.maxColumns / measures.length)) {
      throw new SpecError("too_many_columns", `The pivot makes more than ${pivot.maxColumns} columns.`);
    }
    const taken = new Set(columns.map((column) => column.name));
    for (const combination of combinations) {
      if (combination.length !== pivot.columns.length) {
        throw new RangeError("Each pivot combination must match pivot.columns.");
      }
      const jsonValues = combination.map((text, index) => {
        const val = valueOfText(text, pivot.columns[index]);
        if (!isValueOf(val, pivot.columns[index])) {
          throw new RangeError(`Invalid pivot combination value for ${pivot.columns[index].name}.`);
        }
        return val;
      });
      const condition = pivot.columns
        .map((column, index) => {
          const value = compiler.literal({ kind: "literal", value: jsonValues[index], type: column });
          return `(${keySql(rowIds[column.name], column)} IS NOT DISTINCT FROM ${value})`;
        })
        .join(" AND ");
      const labels = combination.map((text) => (text === null ? "(null)" : text === "" ? "(empty)" : text));
      for (const measure of measures) {
        const name = uniqueName([...labels, measure.name].join(" / "), taken);
        outputs.push(`${compiler.measure(measure, condition)} AS ${groupScope.allocate(name)}`);
        columns.push({
          name,
          ...valueType(measure.type),
          pivot: {
            values: jsonValues,
            measure: measure.name,
          },
        });
      }
    }
  } else {
    for (const measure of measures) {
      outputs.push(`${compiler.measure(measure)} AS ${groupScope.allocate(measure.name)}`);
    }
  }
  const groupKey = (key: Column) =>
    key.type === "date" || key.type === "time" ? keySql(rowIds[key.name], key) : rowIds[key.name];
  const groupBy = keys.length > 0 ? ` GROUP BY ${keys.map(groupKey).join(", ")}` : "";
  // A pivot without keys whose rows make no combination has no columns, and one group.
  if (outputs.length === 0) outputs.push("count(*) AS vg_none");
  entries.push(`vg_groups AS (SELECT ${outputs.join(", ")} FROM vg_rows${groupBy})`);
  const identifiers = { ...groupScope.map };
  compiler.setColumns(identifiers);
  const having = plan.having ? ` WHERE ${compiler.expression(plan.having)}` : "";
  entries.push(`vg_view AS (SELECT * FROM vg_groups${having})`);
  const order = plan.sort.flatMap((key) => sortTerms(identifiers[key.column.name], key.column, key.direction));
  return {
    with: `WITH ${entries.join(", ")}`,
    params: compiler.params.values,
    columns,
    identifiers,
    order: [...order, ...keys.flatMap((key) => keyTerms(identifiers[key.name], key))],
    rowIds: false,
    rowId: null,
  };
}

/** What `rowsQuery` reads: positions `[start, end)` and the view's columns, by name. */
export interface SqlRead {
  start: number;
  end: number;
  columns: string[];
}

/**
 * The query that reads positions of a view, in order: the columns, then the row ID when the view has them.
 * `select` may wrap each column, for example to read exact numbers as text.
 */
export function rowsQuery(
  view: SqlView,
  read: SqlRead,
  select: (column: Column, sql: string) => string = (_column, sql) => sql,
): SqlQuery {
  if (!Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end < read.start) {
    throw new RangeError("A read is a range of positions from 0, [start, end).");
  }
  const byName = new Map(view.columns.map((item) => [item.name, item]));
  const outputs = read.columns.map((name) => {
    const column = byName.get(name);
    if (!column) throw new RangeError(`The view has no column "${name}".`);
    return select(column, viewColumn(view, name));
  });
  if (view.rowId) outputs.push(view.rowId);
  if (outputs.length === 0) outputs.push("NULL");
  const order = view.order.length > 0 ? ` ORDER BY ${view.order.join(", ")}` : "";
  return {
    sql: `${view.with} SELECT ${outputs.join(", ")} FROM vg_view${order} LIMIT ${read.end - read.start} OFFSET ${read.start}`,
    params: view.params,
  };
}

/** The query that counts the rows of a view. */
export function countQuery(view: SqlView): SqlQuery {
  return { sql: `${view.with} SELECT count(*) FROM vg_view`, params: view.params };
}
