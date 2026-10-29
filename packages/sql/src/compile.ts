/**
 * Plans as DuckDB SQL (docs/spec.md §3, §4). The SQL implements the specification, not DuckDB's defaults
 * where they differ. Values are always parameters and names are always quoted. The session's time zone must
 * be UTC, so that the text form of `timestamptz` values is the one of §2.4.
 */
import {
  type CallExpr,
  type CheckedMeasure,
  type CheckedPlan,
  type Column,
  type LiteralExpr,
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
}

/** The text forms of the values of a pivot's combinations, in order, as `pivotQuery` reads them. */
export type PivotCombinations = (string | null)[][];

/** A view as SQL: `with` defines the relation `vg_view`, which holds the view's columns. */
export interface SqlView {
  with: string;
  params: SqlValue[];
  columns: Column[];
  /** ORDER BY terms that order the view totally (§3.3). */
  order: string[];
  rowIds: boolean;
  /** The column of `vg_view` that holds row IDs, when the view has them. */
  rowId: string | null;
}

const NUMBER_PATTERN = "[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?";
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

/**
 * The SQL of the text form (§2.4) of a value of a type. DuckDB writes a decimal without whole digits, such as a
 * decimal(1, 1), as `.5` and `-.5`, where §2.4 writes `0.5` and `-0.5` (Appendix B).
 */
export function textSql(sql: string, type: ValueType): string {
  if (type.type === "string") return sql;
  const text = `CAST(${sql} AS VARCHAR)`;
  const scale = type.scale ?? 0;
  if (type.type === "decimal" && scale > 0 && scale === (type.precision ?? 38)) {
    return `regexp_replace(${text}, '^(-?)\\.', '\\10.')`;
  }
  if (type.type === "float" && type.bits === 32) {
    // DuckDB writes some 32-bit floats with all their exact digits (5525.71875 for 5525.7188): the shortest digits
    // that read back as the same float, which `printf` rounds halves to even, written as the double they are.
    const shortest = Array.from({ length: 8 }, (_, digits) => {
      const rounded = `printf('%.${digits}e', ${sql})`;
      return `WHEN CAST(${rounded} AS FLOAT) = ${sql} THEN CAST(CAST(${rounded} AS DOUBLE) AS VARCHAR)`;
    });
    return `(CASE WHEN NOT isfinite(${sql}) THEN ${text} ${shortest.join(" ")} ELSE ${text} END)`;
  }
  return text;
}

/** A whole number, or `low` when it is below; null stays null (§3.6), where DuckDB's `greatest` would skip it. */
/**
 * A count of code points from `low`: below it counts as `low`, and beyond 2^32 − 1, the most that DuckDB's
 * `substring` takes, as 2^32 − 1, which no string reaches.
 */
function atLeast(sql: string, low: number) {
  const value = `CAST(${sql} AS BIGINT)`;
  return `(CASE WHEN ${value} < ${low} THEN ${low} WHEN ${value} > 4294967295 THEN 4294967295 ELSE ${value} END)`;
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

/** Null unless the number is finite (§3.6). */
function finite(sql: string) {
  return `(CASE WHEN isfinite(${sql}) THEN ${sql} END)`;
}

class Compiler {
  readonly params: Params;

  constructor(params: Params) {
    this.params = params;
  }

  expression(node: TypedExpr): string {
    switch (node.kind) {
      case "column":
        return quoteIdentifier(node.name);
      case "literal":
        return this.literal(node);
      case "search": {
        if (node.columns.length === 0) return "FALSE";
        const text = `CAST(${this.params.add(node.text)} AS VARCHAR)`;
        const matches = node.columns.map(
          (column) =>
            `coalesce(contains(lower(${textSql(quoteIdentifier(column.name), column)}), lower(${text})), FALSE)`,
        );
        return `(${matches.join(" OR ")})`;
      }
      case "call":
        return this.call(node);
    }
  }

  private literal(node: LiteralExpr): string {
    const type = node.type;
    if (type.type === "null") return "NULL";
    if (node.value === null) return `CAST(NULL AS ${duckdbType(type)})`;
    switch (type.type) {
      case "boolean":
        return node.value === true ? "TRUE" : "FALSE";
      case "float": {
        if (typeof node.value === "number") {
          return `CAST(CAST(${this.params.add(floatParam(node.value))} AS VARCHAR) AS DOUBLE)`;
        }
        const token = FLOAT_TOKENS.get(String(node.value));
        if (!token) throw new RangeError(`${String(node.value)} is not a float.`);
        return `CAST(${token} AS DOUBLE)`;
      }
      case "string":
        return `CAST(${this.params.add(String(node.value))} AS VARCHAR)`;
      case "binary":
        return `from_base64(CAST(${this.params.add(String(node.value))} AS VARCHAR))`;
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
        return `(${arg(0)} = ${arg(1)})`;
      case "ne":
        return `(${arg(0)} <> ${arg(1)})`;
      case "lt":
        return `(${arg(0)} < ${arg(1)})`;
      case "le":
        return `(${arg(0)} <= ${arg(1)})`;
      case "gt":
        return `(${arg(0)} > ${arg(1)})`;
      case "ge":
        return `(${arg(0)} >= ${arg(1)})`;
      case "in":
        return `(${arg(0)} IN (${args
          .slice(1)
          .map((item) => this.expression(item))
          .join(", ")}))`;
      case "is_null":
        return `(${arg(0)} IS NULL)`;
      case "is_blank": {
        if (args[0].type.type === "null") return "TRUE";
        const value = arg(0);
        return args[0].type.type === "string" ? `(${value} IS NULL OR ${value} = '')` : `(${value} IS NULL)`;
      }
      case "if":
        return `(CASE WHEN ${arg(0)} THEN ${tryCast(arg(1), type)} ELSE ${tryCast(arg(2), type)} END)`;
      case "coalesce": {
        // The first value that is not null, in the common type: null when it does not fit, as in the JS engine.
        const cases = args.map((_, index) => `WHEN ${arg(index)} IS NOT NULL THEN ${tryCast(arg(index), type)}`);
        return `(CASE ${cases.join(" ")} END)`;
      }
      case "least":
      case "greatest":
        return `${node.fn}(${typed()})`;
      case "add":
      case "sub":
      case "mul":
      case "mod": {
        const operator = { add: "+", sub: "-", mul: "*", mod: "%" }[node.fn];
        if (type.type === "float") return finite(`(${this.double(args[0])} ${operator} ${this.double(args[1])})`);
        if (type.type === "bigint") return `TRY(CAST(${arg(0)} AS BIGINT) ${operator} CAST(${arg(1)} AS BIGINT))`;
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
      case "sqrt":
      case "exp":
      case "ln":
      case "log10":
        return finite(`TRY(${node.fn}(${this.double(args[0])}))`);
      case "power":
        return finite(`TRY(power(${this.double(args[0])}, ${this.double(args[1])}))`);
      case "sign":
        return `CAST(sign(${this.number(args[0])}) AS INTEGER)`;
      case "to_number": {
        const value = `trim(${arg(0)})`;
        return `(CASE WHEN regexp_full_match(${value}, '${NUMBER_PATTERN}') THEN ${finite(`TRY_CAST(${value} AS DOUBLE)`)} END)`;
      }
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
      case "replace":
        return `replace(${arg(0)}, ${arg(1)}, ${arg(2)})`;
      case "contains":
      case "starts_with":
      case "ends_with":
        return `${node.fn}(${arg(0)}, ${arg(1)})`;
      case "text":
        return this.text(args[0]);
      case "to_date": {
        const value = arg(0);
        return `(CASE WHEN regexp_full_match(${value}, '${DATE_PATTERN}') THEN TRY_CAST(${value} AS DATE) END)`;
      }
      case "to_timestamp": {
        const value = arg(0);
        return `(CASE WHEN regexp_full_match(${value}, '${TIMESTAMP_PATTERN}') THEN TRY_CAST(replace(${value}, 'T', ' ') AS TIMESTAMP) END)`;
      }
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
        const sum = type.type === "date" ? `TRY(${arg(0)} + ${days})` : `TRY(${arg(0)} + to_days(${days}))`;
        // Years from 1 to 9999 (§2.2), as the JS engine gives them: DuckDB's dates go further, and a later date
        // would sort as itself and read as null.
        return `(CASE WHEN year(${sum}) BETWEEN 1 AND 9999 THEN ${sum} END)`;
      }
    }
  }

  /**
   * The sum of a wide decimal column as a HUGEINT of its digits, or null for other columns. DuckDB sums a
   * decimal(p, s) as a decimal(38, s) and refuses a sum beyond 38 digits, also inside avg; a decimal of up to 18
   * digits needs more rows than a table has to get there. The digits after the point are multiplied out as a
   * decimal of 38 digits, which holds those of up to 19.
   */
  private unscaledSum(measure: CheckedMeasure, filter: string): string | null {
    const decimal = measure.column;
    const scale = decimal?.scale ?? 0;
    if (decimal?.type !== "decimal" || (decimal.precision ?? 38) <= 18 || scale > 19) return null;
    const column = quoteIdentifier(decimal.name);
    const factor = `1${"0".repeat(scale)}`;
    // trunc keeps the type: both parts and their sum fit in a HUGEINT.
    const digits =
      scale === 0
        ? `CAST(${column} AS HUGEINT)`
        : `CAST(trunc(${column}) AS HUGEINT) * ${factor} + CAST((${column} - trunc(${column})) * ${factor} AS HUGEINT)`;
    return `sum(${digits})${filter}`;
  }

  /** A measure (§3.8, §4.5), optionally over the rows of a pivot's combination. */
  measure(measure: CheckedMeasure, condition?: string): string {
    const column = measure.column ? quoteIdentifier(measure.column.name) : null;
    const conditions: string[] = [];
    if (measure.column?.type === "float" && measure.fn !== "count" && measure.fn !== "count_distinct") {
      conditions.push(`isfinite(${column})`);
    }
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
        const unscaled = this.unscaledSum(measure, filter);
        if (unscaled) {
          // A HUGEINT of the sum's digits, which holds more than 38 of them: a sum beyond them is null (§3.8).
          const sum = `(CAST(${unscaled} AS DECIMAL(38, 0)) * ${scale > 0 ? `0.${"0".repeat(scale - 1)}1` : "1"})`;
          return `(CASE WHEN abs(${unscaled}) <= ${"9".repeat(38)} THEN ${sum} END)`;
        }
        // DuckDB refuses aggregates inside TRY(); TRY_CAST takes them. The sum of integers is a HUGEINT, which
        // holds more than 38 digits: a sum beyond them is null (§3.8).
        const sum = `TRY_CAST(sum(${column})${filter} AS ${duckdbType(measure.type)})`;
        const largest = `${"9".repeat(38 - scale)}${scale > 0 ? `.${"9".repeat(scale)}` : ""}`;
        return `(CASE WHEN abs(${sum}) <= ${largest} THEN ${sum} END)`;
      }
      case "avg": {
        const unscaled = this.unscaledSum(measure, filter);
        const scale = measure.column?.scale ?? 0;
        if (unscaled) return `(CAST(${unscaled} AS DOUBLE) / 1e${scale} / count(${column})${filter})`;
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

/** ORDER BY terms of group keys (§3.9): ascending, blanks last, the empty string before null. */
function keyTerms(column: Column) {
  const sql = quoteIdentifier(column.name);
  return column.type === "string"
    ? [`NULLIF(${sql}, '') ASC NULLS LAST`, `${sql} ASC NULLS LAST`]
    : [`${sql} ASC NULLS LAST`];
}

/** A name for the column of row IDs that no column of the plan has. */
function rowIdAlias(plan: CheckedPlan) {
  const names = new Set(plan.rows.map((column) => column.name));
  let alias = "vg_row";
  while (names.has(alias)) alias = `${alias}_`;
  return quoteIdentifier(alias);
}

/** The `WITH` entries up to `vg_rows`, the rows that `where` keeps, with the derived columns. */
function rowsWith(plan: CheckedPlan, source: SqlSource, compiler: Compiler, alias: string): string[] {
  const columns = plan.table.map((column) => quoteIdentifier(column.name));
  const entries = [
    `vg_base AS (SELECT ${[...columns, `${source.rowId} AS ${alias}`].join(", ")} FROM ${source.relation})`,
  ];
  let previous = "vg_base";
  plan.derive.forEach((item, index) => {
    const name = `vg_derive${index + 1}`;
    entries.push(
      `${name} AS (SELECT *, ${compiler.expression(item.expr)} AS ${quoteIdentifier(item.name)} FROM ${previous})`,
    );
    previous = name;
  });
  const where = plan.where ? ` WHERE ${compiler.expression(plan.where)}` : "";
  entries.push(`vg_rows AS (SELECT * FROM ${previous}${where})`);
  return entries;
}

/**
 * The query that reads the combinations of a pivot's values (§4.6), as their text forms, in order. It reads
 * one more combination than the pivot may make columns for, so that `compileView` can refuse too many.
 */
export function pivotQuery(plan: CheckedPlan, source: SqlSource): SqlQuery {
  const pivot = plan.aggregate?.pivot;
  if (!pivot || !plan.aggregate) throw new RangeError("The plan has no pivot.");
  const compiler = new Compiler(new Params(source.params));
  const entries = rowsWith(plan, source, compiler, rowIdAlias(plan));
  const names = pivot.columns.map((column) => quoteIdentifier(column.name));
  const texts = pivot.columns.map(
    (column, index) => `${textSql(quoteIdentifier(column.name), column)} AS "vg_value${index}"`,
  );
  const limit = Math.floor(pivot.maxColumns / plan.aggregate.measures.length) + 1;
  const sql = `WITH ${entries.join(", ")} SELECT ${texts.join(", ")} FROM (SELECT DISTINCT ${names.join(", ")} FROM vg_rows) ORDER BY ${pivot.columns.flatMap(keyTerms).join(", ")} LIMIT ${limit}`;
  return { sql, params: compiler.params.values };
}

/**
 * The view of a checked plan as SQL. A pivot needs the combinations that `pivotQuery` read, and fails with
 * `too_many_columns` when they would make more columns than its `maxColumns`.
 */
export function compileView(plan: CheckedPlan, source: SqlSource, combinations?: PivotCombinations): SqlView {
  const compiler = new Compiler(new Params(source.params));
  const alias = rowIdAlias(plan);
  const entries = rowsWith(plan, source, compiler, alias);
  const order = plan.sort.flatMap((key) => sortTerms(quoteIdentifier(key.column.name), key.column, key.direction));
  if (!plan.aggregate) {
    entries.push("vg_view AS (SELECT * FROM vg_rows)");
    return {
      with: `WITH ${entries.join(", ")}`,
      params: compiler.params.values,
      columns: plan.columns,
      order: [...order, `${alias} ASC`],
      rowIds: true,
      rowId: alias,
    };
  }
  const { keys, measures, pivot } = plan.aggregate;
  const columns = [...plan.columns];
  const outputs = keys.map((key) => quoteIdentifier(key.name));
  if (pivot) {
    if (!combinations) throw new RangeError("A pivot needs the combinations that pivotQuery reads.");
    if (combinations.length > Math.floor(pivot.maxColumns / measures.length)) {
      throw new SpecError("too_many_columns", `The pivot makes more than ${pivot.maxColumns} columns.`);
    }
    const taken = new Set(columns.map((column) => column.name));
    for (const combination of combinations) {
      const condition = pivot.columns
        .map((column, index) => {
          const text = combination[index];
          const value =
            text === null
              ? `CAST(NULL AS ${duckdbType(column)})`
              : cast(`CAST(${compiler.params.add(text)} AS VARCHAR)`, column);
          return `(${quoteIdentifier(column.name)} IS NOT DISTINCT FROM ${value})`;
        })
        .join(" AND ");
      const labels = combination.map((text) => (text === null ? "(null)" : text === "" ? "(empty)" : text));
      for (const measure of measures) {
        const name = uniqueName([...labels, measure.name].join(" / "), taken);
        outputs.push(`${compiler.measure(measure, condition)} AS ${quoteIdentifier(name)}`);
        columns.push({
          name,
          ...valueType(measure.type),
          pivot: {
            values: combination.map((text, index) => valueOfText(text, pivot.columns[index])),
            measure: measure.name,
          },
        });
      }
    }
  } else {
    for (const measure of measures) outputs.push(`${compiler.measure(measure)} AS ${quoteIdentifier(measure.name)}`);
  }
  const groupBy = keys.length > 0 ? ` GROUP BY ${keys.map((key) => quoteIdentifier(key.name)).join(", ")}` : "";
  // A pivot without keys whose rows make no combination has no columns, and one group.
  if (outputs.length === 0) outputs.push("count(*) AS vg_none");
  entries.push(`vg_groups AS (SELECT ${outputs.join(", ")} FROM vg_rows${groupBy})`);
  const having = plan.having ? ` WHERE ${compiler.expression(plan.having)}` : "";
  entries.push(`vg_view AS (SELECT * FROM vg_groups${having})`);
  return {
    with: `WITH ${entries.join(", ")}`,
    params: compiler.params.values,
    columns,
    order: [...order, ...keys.flatMap(keyTerms)],
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
  const outputs = read.columns.map((name) => {
    const column = view.columns.find((item) => item.name === name);
    if (!column) throw new RangeError(`The view has no column "${name}".`);
    return select(column, quoteIdentifier(name));
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
