import {
  type CompiledFormula,
  FORMULA_DATE_PATTERN,
  type FormulaExpression,
  type FormulaType,
  isExactNumberColumn,
} from "vastgrid-core";
import { quoteIdentifier, quoteLiteral, type SqlColumn } from "./sql.js";

/** The DuckDB type of each formula type. */
const sqlTypes: Record<FormulaType, string> = {
  number: "DOUBLE",
  text: "VARCHAR",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
  null: "VARCHAR",
};

/** A literal of a formula, kept in a table of constants (one row) and read as `k.c<index>`. */
export interface FormulaConstant {
  value: number | string | boolean;
  sqlType: string;
}

export interface FormulaSelect {
  /** The formula columns, under free names (`label` is the formula's name). */
  columns: SqlColumn[];
  /**
   * Projections to apply in turn over the table's rows: each is a list of `expression AS name` over the rows
   * `f` (with the columns of the projections before) and the constants `k`. Values that are used twice (to
   * turn infinities into NULL) get a column in one projection and are read in the next, so that no
   * expression is written twice: the SQL grows with the formula, not exponentially.
   */
  layers: string[][];
  /** The literals, in the order of the constants' columns. */
  constants: FormulaConstant[];
}

/** SQL of a node, and the projection from which it can be computed (0: from the table's columns). */
interface Fragment {
  sql: string;
  level: number;
}

const comparisons = { "=": "=", "<>": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" } as const;
const datePattern = quoteLiteral(FORMULA_DATE_PATTERN);

/** An integer argument, truncated toward zero; NULL when it does not fit. */
function integer(sql: string, type: "INTEGER" | "BIGINT") {
  return `TRY_CAST(trunc(${sql}) AS ${type})`;
}

/**
 * Compiles checked formulas (see `compileFormulas`) to SQL over the table's rows (`f`) and a table of
 * constants (`k`). Table columns are quoted identifiers, literals are columns of the constants, which the
 * engine fills with parameters, and only the functions below are called: the SQL never contains text from
 * the formula. Numbers that are not finite (DuckDB computes infinities and NaN) become NULL, as in
 * `formulaEvaluator`.
 */
export function formulaSelect(compiled: readonly CompiledFormula[], columns: readonly SqlColumn[]): FormulaSelect {
  const constants: FormulaConstant[] = [];
  const known = new Map<string, number>();
  const layers: string[][] = [];
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  const free = (prefix: string) => {
    let suffix = 0;
    while (taken.has(`${prefix}${suffix}`)) suffix++;
    const name = `${prefix}${suffix}`;
    taken.add(name);
    return name;
  };
  const place = (fragment: Fragment, name: string) => {
    while (layers.length <= fragment.level) layers.push([]);
    layers[fragment.level].push(`${fragment.sql} AS ${quoteIdentifier(name)}`);
  };
  const builder: Builder = {
    columns,
    constant(value, sqlType) {
      const key = `${sqlType}:${typeof value}:${String(value)}`;
      let index = known.get(key);
      if (index === undefined) {
        index = constants.length;
        constants.push({ value, sqlType });
        known.set(key, index);
      }
      return { sql: `k.${quoteIdentifier(`c${index}`)}`, level: 0 };
    },
    finite(fragment) {
      const name = free("__vg_t");
      place(fragment, name);
      const id = `f.${quoteIdentifier(name)}`;
      return { sql: `CASE WHEN isfinite(${id}) THEN ${id} END`, level: fragment.level + 1 };
    },
  };
  const result: FormulaSelect = { columns: [], layers, constants };
  for (const formula of compiled) {
    if (!formula.tree) throw new RangeError(`The formula column "${formula.name}" has an error.`);
    const name = free("__vg_f");
    const sqlType = sqlTypes[formula.tree.type];
    result.columns.push({ name, label: formula.name, sqlType, type: formula.type });
    const fragment = expression(formula.tree, builder);
    place({ sql: `CAST(${fragment.sql} AS ${sqlType})`, level: fragment.level }, name);
  }
  return result;
}

interface Builder {
  columns: readonly SqlColumn[];
  constant(value: number | string | boolean, sqlType: string): Fragment;
  /** The value, or NULL when it is not finite, computed once. */
  finite(fragment: Fragment): Fragment;
}

function expression(node: FormulaExpression, builder: Builder): Fragment {
  switch (node.kind) {
    case "literal":
      return node.value === null
        ? { sql: `CAST(NULL AS ${sqlTypes[node.type]})`, level: 0 }
        : builder.constant(node.value, sqlTypes[node.type]);
    case "column": {
      const column = builder.columns[node.column];
      if (!column) throw new RangeError(`Column ${node.column} does not exist.`);
      const id = `f.${quoteIdentifier(column.name)}`;
      let sql: string;
      switch (node.type) {
        case "number":
          // A column read twice costs nothing.
          sql =
            column.type === "float"
              ? `CASE WHEN isfinite(CAST(${id} AS DOUBLE)) THEN CAST(${id} AS DOUBLE) END`
              : `CAST(${id} AS DOUBLE)`;
          break;
        case "boolean":
        case "date":
          sql = id;
          break;
        case "timestamp":
          // Timestamps with a time zone count in UTC.
          sql = column.type === "timestamptz" ? `timezone('UTC', ${id})` : `CAST(${id} AS TIMESTAMP)`;
          break;
        default:
          sql = column.type === "string" ? id : `CAST(${id} AS VARCHAR)`;
      }
      return { sql, level: 0 };
    }
    case "operator": {
      const args = node.args.map((arg) => expression(arg, builder));
      const level = Math.max(0, ...args.map((arg) => arg.level));
      const [a, b] = args.map((arg) => arg.sql);
      const plain = (sql: string) => ({ sql, level });
      switch (node.op) {
        case "neg":
          return plain(`(- ${a})`);
        case "not":
          return plain(`(NOT ${a})`);
        case "and":
          return plain(`(${a} AND ${b})`);
        case "or":
          return plain(`(${a} OR ${b})`);
        case "+":
        case "-":
        case "*":
        case "/":
        case "%":
          return builder.finite(plain(`(${a} ${node.op} ${b})`));
        case "&":
          return plain(`concat(${a}, ${b})`);
        default:
          return plain(`(${a} ${comparisons[node.op]} ${b})`);
      }
    }
    case "function": {
      const fragments = node.args.map((arg) => expression(arg, builder));
      const level = Math.max(0, ...fragments.map((arg) => arg.level));
      const args = fragments.map((arg) => arg.sql);
      const [a, b, c] = args;
      const plain = (sql: string) => ({ sql, level });
      switch (node.name) {
        case "ABS":
          return plain(`abs(${a})`);
        case "ROUND":
          return plain(b === undefined ? `round(${a})` : `round(${a}, ${integer(b, "INTEGER")})`);
        case "FLOOR":
          return plain(`floor(${a})`);
        case "CEILING":
          return plain(`ceil(${a})`);
        case "SQRT":
          return plain(`TRY(sqrt(${a}))`);
        case "POWER":
          return builder.finite(plain(`power(${a}, ${b})`));
        case "EXP":
          return builder.finite(plain(`exp(${a})`));
        case "LN":
          return plain(`TRY(ln(${a}))`);
        case "LOG10":
          return plain(`TRY(log10(${a}))`);
        case "MOD":
          return builder.finite(plain(`(${a} % ${b})`));
        case "SIGN":
          return plain(`CAST(sign(${a}) AS DOUBLE)`);
        case "MIN":
          return plain(`least(${args.join(", ")})`);
        case "MAX":
          return plain(`greatest(${args.join(", ")})`);
        case "LEN":
          return plain(`CAST(length(${a}) AS DOUBLE)`);
        case "LOWER":
          return plain(`lower(${a})`);
        case "UPPER":
          return plain(`upper(${a})`);
        case "TRIM":
          return plain(`trim(${a})`);
        case "LEFT":
          return plain(`left(${a}, greatest(${integer(b, "BIGINT")}, 0))`);
        case "RIGHT":
          return plain(`right(${a}, greatest(${integer(b, "BIGINT")}, 0))`);
        case "MID":
          return plain(`substring(${a}, greatest(${integer(b, "BIGINT")}, 1), greatest(${integer(c, "BIGINT")}, 0))`);
        case "REPLACE":
          return plain(`replace(${a}, ${b}, ${c})`);
        case "CONTAINS":
          return plain(`contains(${a}, ${b})`);
        case "STARTSWITH":
          return plain(`starts_with(${a}, ${b})`);
        case "ENDSWITH":
          return plain(`ends_with(${a}, ${b})`);
        case "CONCAT":
          return plain(`concat(${args.join(", ")})`);
        case "TEXT": {
          const arg = node.args[0];
          switch (arg.type) {
            case "number":
              // Integers and decimals of a column keep their digits; other numbers lose a ".0".
              if (isExactNumberColumn(arg) && arg.kind === "column") {
                return plain(`CAST(f.${quoteIdentifier((builder.columns[arg.column] as SqlColumn).name)} AS VARCHAR)`);
              }
              return plain(`regexp_replace(CAST(${a} AS VARCHAR), '\\.0$', '')`);
            case "boolean":
              return plain(`upper(CAST(${a} AS VARCHAR))`);
            default:
              return plain(`CAST(${a} AS VARCHAR)`);
          }
        }
        case "VALUE":
          return builder.finite(plain(`TRY_CAST(${a} AS DOUBLE)`));
        case "DATE":
          return plain(
            node.args[0].type === "text"
              ? `CAST(TRY_CAST(regexp_extract(${a}, ${datePattern}, 1) AS TIMESTAMP) AS DATE)`
              : `CAST(${a} AS DATE)`,
          );
        case "DATETIME":
          return plain(
            node.args[0].type === "text"
              ? `TRY_CAST(regexp_extract(${a}, ${datePattern}, 1) AS TIMESTAMP)`
              : `CAST(${a} AS TIMESTAMP)`,
          );
        case "YEAR":
        case "MONTH":
        case "DAY":
        case "HOUR":
        case "MINUTE":
        case "SECOND":
          return plain(`CAST(${node.name.toLowerCase()}(${a}) AS DOUBLE)`);
        case "WEEKDAY":
          return plain(`CAST(isodow(${a}) AS DOUBLE)`);
        case "DAYS":
          return plain(`CAST(date_diff('day', ${b}, ${a}) AS DOUBLE)`);
        case "ADDDAYS":
          return plain(
            node.type === "timestamp"
              ? `TRY(${a} + to_days(${integer(b, "INTEGER")}))`
              : `TRY(${a} + ${integer(b, "INTEGER")})`,
          );
        case "IF":
          return plain(`CASE WHEN ${a} THEN ${b} ELSE ${c ?? "NULL"} END`);
        case "COALESCE":
          return plain(`coalesce(${args.join(", ")})`);
        case "ISBLANK":
          return plain(node.args[0].type === "text" ? `(coalesce(${a}, '') = '')` : `(${a} IS NULL)`);
      }
    }
  }
  throw new RangeError("Unknown formula node.");
}
