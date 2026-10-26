/**
 * Evaluates the `when` of a style rule (§5.1 of the specification) over a row of the view on screen, in the grid:
 * the logic and comparisons that the menus write (§4.4: `and`, `or`, `not`, `coalesce`, comparisons, `in`,
 * `is_null`, `is_blank`, `contains`, `starts_with` and `ends_with` over `lower` and `text`), with nulls as §3.6 has
 * them. Other expressions are not evaluated here, and their rules are skipped.
 */
import { type Column, columnsOf, type Expr, floatOf, type JsonValue, textOf } from "vastgrid-spec";

/** A value of an expression: a JSON value with its column's type, or a string or boolean that it made. */
interface Value {
  value: JsonValue;
  type: Column["type"] | "text";
}

/** Reads the value of a column of the row; undefined while it is not read. */
export type RowReader = (column: string) => JsonValue | undefined;

/** A compiled `when`: true, false or null for a row, or undefined while a value it needs is not read. */
export type Rule = (row: RowReader) => boolean | null | undefined;

const NUMERIC = new Set(["integer", "bigint", "decimal", "float"]);

/** Compares exact decimal texts (`-12.50`) by their digits. */
function compareDecimal(a: string, b: string): number {
  const sign = (text: string) => (text.startsWith("-") ? -1 : 1);
  const [ai, af = ""] = a.replace(/^[+-]/, "").split(".");
  const [bi, bf = ""] = b.replace(/^[+-]/, "").split(".");
  const isZero = (i: string, f: string) => /^0*$/.test(i) && /^0*$/.test(f);
  const as = isZero(ai, af) ? 0 : sign(a);
  const bs = isZero(bi, bf) ? 0 : sign(b);
  if (as !== bs) return as - bs;
  const whole = (x: string) => x.replace(/^0+(?=\d)/, "");
  const [x, y] = [whole(ai), whole(bi)];
  const width = Math.max(af.length, bf.length);
  const left = `${x.padStart(Math.max(x.length, y.length), "0")}${af.padEnd(width, "0")}`;
  const right = `${y.padStart(Math.max(x.length, y.length), "0")}${bf.padEnd(width, "0")}`;
  return (left < right ? -1 : left > right ? 1 : 0) * as;
}

/** Orders two values of one kind (§3.1), or null when they do not compare. */
function compare(a: Value, b: Value): number | null {
  if (a.value === null || b.value === null) return null;
  if (NUMERIC.has(a.type) || NUMERIC.has(b.type) || (typeof a.value === "number" && typeof b.value === "number")) {
    const float =
      a.type === "float" || b.type === "float" || typeof a.value === "number" || typeof b.value === "number";
    if (float && !(typeof a.value === "string" && typeof b.value === "string")) {
      const x = floatOf(a.value);
      const y = floatOf(b.value);
      // NaN is the greatest number (§3.1).
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return compareDecimal(String(a.value), String(b.value));
  }
  if (typeof a.value === "boolean" && typeof b.value === "boolean") return Number(a.value) - Number(b.value);
  if (typeof a.value === "string" && typeof b.value === "string") {
    // Code point order.
    const x = [...a.value];
    const y = [...b.value];
    for (let index = 0; index < Math.min(x.length, y.length); index++) {
      const difference = (x[index].codePointAt(0) ?? 0) - (y[index].codePointAt(0) ?? 0);
      if (difference !== 0) return difference;
    }
    return x.length - y.length;
  }
  return null;
}

/** `lower` (§3.4): each code point by itself, kept when its lower case is not one code point. */
function lower(text: string): string {
  let out = "";
  for (const point of text) {
    if (point === "İ") {
      out += "i";
      continue;
    }
    const mapped = point.toLowerCase();
    out += [...mapped].length === 1 ? mapped : point;
  }
  return out;
}

type Compiled = (row: RowReader) => Value | undefined;

const PENDING = Symbol("pending");

function compile(expr: Expr, columns: ReadonlyMap<string, Column>): Compiled | null {
  if ("col" in expr) {
    const column = columns.get(expr.col);
    if (!column) return null;
    return (row) => {
      const value = row(column.name);
      return value === undefined ? undefined : { value, type: column.type };
    };
  }
  if ("lit" in expr) {
    const value: Value = {
      value: expr.lit,
      type: expr.type ?? (typeof expr.lit === "number" ? (Number.isInteger(expr.lit) ? "bigint" : "float") : "text"),
    };
    return () => value;
  }
  if ("search" in expr) return null;
  const args = expr.args.map((arg) => compile(arg, columns));
  if (args.some((arg) => arg === null)) return null;
  const parts = args as Compiled[];
  const read = (row: RowReader) => {
    const values: Value[] = [];
    for (const part of parts) {
      const value = part(row);
      if (value === undefined) throw PENDING;
      values.push(value);
    }
    return values;
  };
  const truth = (value: boolean | null): Value => ({ value, type: "boolean" });
  const run = (body: (values: Value[]) => Value): Compiled => {
    return (row) => {
      try {
        return body(read(row));
      } catch (error) {
        if (error === PENDING) return undefined;
        throw error;
      }
    };
  };
  switch (expr.fn) {
    case "and":
    case "or": {
      const stop = expr.fn === "or";
      return run((values) => {
        let unknown = false;
        for (const { value } of values) {
          if (value === stop) return truth(stop);
          if (value === null) unknown = true;
        }
        return truth(unknown ? null : !stop);
      });
    }
    case "not":
      return run(([a]) => truth(a.value === null ? null : !a.value));
    case "coalesce":
      return run((values) => values.find((item) => item.value !== null) ?? values[values.length - 1]);
    case "is_null":
      return run(([a]) => truth(a.value === null));
    case "is_blank":
      return run(([a]) => truth(a.value === null || (a.type === "string" && a.value === "")));
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      const fn = expr.fn;
      return run(([a, b]) => {
        const order = compare(a, b);
        if (order === null) return truth(null);
        const result =
          fn === "eq"
            ? order === 0
            : fn === "ne"
              ? order !== 0
              : fn === "lt"
                ? order < 0
                : fn === "le"
                  ? order <= 0
                  : fn === "gt"
                    ? order > 0
                    : order >= 0;
        return truth(result);
      });
    }
    case "in":
      return run(([a, ...list]) => {
        if (a.value === null) return truth(null);
        return truth(list.some((item) => compare(a, item) === 0));
      });
    case "text":
      return run(([a]) => ({
        value: a.type === "text" ? a.value : textOf(a.value, { type: a.type } as Column),
        type: "text",
      }));
    case "lower":
      return run(([a]) => ({ value: typeof a.value === "string" ? lower(a.value) : null, type: "text" }));
    case "contains":
    case "starts_with":
    case "ends_with": {
      const fn = expr.fn;
      return run(([a, b]) => {
        if (typeof a.value !== "string" || typeof b.value !== "string") return truth(null);
        return truth(
          fn === "contains"
            ? a.value.includes(b.value)
            : fn === "starts_with"
              ? a.value.startsWith(b.value)
              : a.value.endsWith(b.value),
        );
      });
    }
    default:
      return null;
  }
}

/**
 * A rule's `when` compiled over the columns of the view, or null when it names a column the view does not have or a
 * function that the grid does not evaluate. `columns` lists the columns it reads.
 */
export function compileRule(when: Expr, view: readonly Column[]): { rule: Rule; columns: string[] } | null {
  const byName = new Map(view.map((column) => [column.name, column]));
  const compiled = compile(when, byName);
  if (!compiled) return null;
  return {
    rule: (row) => {
      const result = compiled(row);
      if (result === undefined) return undefined;
      return typeof result.value === "boolean" ? result.value : null;
    },
    columns: [...columnsOf(when)],
  };
}
