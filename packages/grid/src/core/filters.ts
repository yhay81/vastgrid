/**
 * The filter of one column as the column menu edits it: values ticked in a list, or a condition. Each is written
 * as the parts of `where` that `filter.column` sets (§6.2.1 of the specification), and read back from them.
 */
import {
  type Column,
  columnsOf,
  type Expr,
  type FunctionName,
  type JsonValue,
  joinParts,
  type Literal,
  type LogicalType,
  type Plan,
  partsOf,
  readCellText,
} from "vastgrid-spec";

export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "between"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "blank"
  | "notBlank";

export type ColumnFilter =
  /** Rows with one of `values`, or blank (§3.2) with `blank`; with `exclude`, the other rows. */
  | { kind: "values"; values: JsonValue[]; blank: boolean; exclude: boolean }
  /** A condition on typed text: `first`, and `second` for `between`; an empty text leaves that side out. */
  | { kind: "condition"; operator: FilterOperator; first: string; second: string };

const ORDERED: FilterOperator[] = ["eq", "ne", "gt", "ge", "lt", "le", "between", "blank", "notBlank"];
const TEXT: FilterOperator[] = ["contains", "notContains", "startsWith", "endsWith", "eq", "ne", "blank", "notBlank"];

/** The operators offered for a column's type. */
export function operatorsFor(type: LogicalType): FilterOperator[] {
  if (type === "string") return TEXT;
  if (type === "boolean" || type === "binary" || type === "interval") return ["blank", "notBlank"];
  if (type === "uuid") return ["eq", "ne", "blank", "notBlank"];
  return ORDERED;
}

/** Whether an operator takes no text. */
export function takesNoValue(operator: FilterOperator) {
  return operator === "blank" || operator === "notBlank";
}

/** A literal of a value of a column (§2.5): values that JSON writes as strings carry the column's type. */
export function literalOf(value: JsonValue, column: Column): Literal {
  if (typeof value === "string" && column.type !== "string") return { lit: value, type: column.type };
  return { lit: value };
}

function call(fn: FunctionName, ...args: Expr[]): Expr {
  return { fn, args };
}

/** Rows for which `expr` is not true: null counts as not matching, so `not` keeps the rows where it is null. */
function notMatching(expr: Expr): Expr {
  return call("not", call("coalesce", expr, { lit: false }));
}

const TEXT_FUNCTIONS: Partial<Record<FilterOperator, FunctionName>> = {
  contains: "contains",
  notContains: "contains",
  startsWith: "starts_with",
  endsWith: "ends_with",
};

export class FilterTextError extends Error {
  constructor(readonly side: "first" | "second") {
    super(`The ${side} value is not a value of the column.`);
  }
}

/**
 * The parts of `where` for a column's filter; none when it keeps every row. Text that is not a value of the column
 * throws a `FilterTextError` (§7.3 reads it as a cell's text is read).
 */
export function filterParts(filter: ColumnFilter, column: Column): Expr[] {
  const c: Expr = { col: column.name };
  if (filter.kind === "values") {
    const parts: Expr[] = [];
    if (filter.values.length > 0) parts.push(call("in", c, ...filter.values.map((value) => literalOf(value, column))));
    if (filter.blank) parts.push(call("is_blank", c));
    const matching = parts.length === 0 ? null : parts.length === 1 ? parts[0] : call("or", ...parts);
    if (filter.exclude) return matching ? [notMatching(matching)] : [];
    return [matching ?? { lit: false }];
  }
  const { operator } = filter;
  if (operator === "blank") return [call("is_blank", c)];
  if (operator === "notBlank") return [call("not", call("is_blank", c))];
  const text = TEXT_FUNCTIONS[operator];
  if (text) {
    if (filter.first === "") return [];
    const expr = call(text, call("lower", call("text", c)), call("lower", { lit: filter.first }));
    return [operator === "notContains" ? notMatching(expr) : expr];
  }
  const read = (input: string, side: "first" | "second") => {
    if (input.trim() === "") return null;
    const result = readCellText(input, column, { grouping: true });
    if (!result.ok || result.value === null) throw new FilterTextError(side);
    return literalOf(result.value, column);
  };
  if (operator === "between") {
    const low = read(filter.first, "first");
    const high = read(filter.second, "second");
    return [...(low ? [call("ge", c, low)] : []), ...(high ? [call("le", c, high)] : [])];
  }
  const value = read(filter.first, "first");
  return value ? [call(operator as FunctionName, c, value)] : [];
}

function isColumn(expr: Expr | undefined, name: string) {
  return expr !== undefined && "col" in expr && expr.col === name;
}

function isLiteral(expr: Expr | undefined): expr is Literal {
  return expr !== undefined && "lit" in expr;
}

function isCall(expr: Expr | undefined, fn: FunctionName): expr is { fn: FunctionName; args: Expr[] } {
  return expr !== undefined && "fn" in expr && expr.fn === fn;
}

/** The text of a literal as the menu shows it to edit. */
function literalText(literal: Literal): string {
  return literal.lit === null ? "" : String(literal.lit);
}

/** `in(c, …)`, `is_blank(c)` or the `or` of both, as values. */
function readValues(expr: Expr, name: string): { values: JsonValue[]; blank: boolean } | null {
  const parts = isCall(expr, "or") ? expr.args : [expr];
  let values: JsonValue[] | null = null;
  let blank = false;
  for (const part of parts) {
    if (isCall(part, "in") && isColumn(part.args[0], name) && values === null && part.args.slice(1).every(isLiteral)) {
      values = (part.args.slice(1) as Literal[]).map((literal) => literal.lit);
    } else if (isCall(part, "is_blank") && isColumn(part.args[0], name) && !blank) {
      blank = true;
    } else {
      return null;
    }
  }
  return { values: values ?? [], blank };
}

/** `contains(lower(text(c)), lower(lit))` and the like: the operator and the text. */
function readText(expr: Expr, name: string): { fn: FunctionName; text: string } | null {
  if (!("fn" in expr) || !["contains", "starts_with", "ends_with"].includes(expr.fn)) return null;
  const [haystack, needle] = expr.args;
  if (!isCall(haystack, "lower") || !isCall(haystack.args[0], "text") || !isColumn(haystack.args[0].args[0], name)) {
    return null;
  }
  if (!isCall(needle, "lower") || !isLiteral(needle.args[0]) || typeof needle.args[0].lit !== "string") return null;
  return { fn: expr.fn, text: needle.args[0].lit };
}

const COMPARISONS: FilterOperator[] = ["eq", "ne", "lt", "le", "gt", "ge"];

/**
 * The filter that the conditions of a column (§6.2.1) make, when the menu wrote them or they have the same shape;
 * null when there are none, and `"other"` for conditions written otherwise (an agent, a saved view).
 */
export function readFilter(parts: readonly Expr[], name: string): ColumnFilter | "other" | null {
  if (parts.length === 0) return null;
  if (parts.length === 2) {
    const [low, high] = parts;
    if (
      isCall(low, "ge") &&
      isCall(high, "le") &&
      isColumn(low.args[0], name) &&
      isColumn(high.args[0], name) &&
      isLiteral(low.args[1]) &&
      isLiteral(high.args[1])
    ) {
      return {
        kind: "condition",
        operator: "between",
        first: literalText(low.args[1]),
        second: literalText(high.args[1]),
      };
    }
    return "other";
  }
  if (parts.length !== 1) return "other";
  const [part] = parts;
  if (isLiteral(part) && part.lit === false) return { kind: "values", values: [], blank: false, exclude: false };
  if (isCall(part, "is_blank") && isColumn(part.args[0], name)) {
    return { kind: "condition", operator: "blank", first: "", second: "" };
  }
  if (isCall(part, "not")) {
    const inner = part.args[0];
    if (isCall(inner, "is_blank") && isColumn(inner.args[0], name)) {
      return { kind: "condition", operator: "notBlank", first: "", second: "" };
    }
    if (isCall(inner, "coalesce") && isLiteral(inner.args[1]) && inner.args[1].lit === false) {
      const matching = inner.args[0];
      const values = readValues(matching, name);
      if (values) return { kind: "values", ...values, exclude: true };
      const text = readText(matching, name);
      if (text?.fn === "contains") return { kind: "condition", operator: "notContains", first: text.text, second: "" };
    }
    return "other";
  }
  const values = readValues(part, name);
  if (values && values.values.length > 0) return { kind: "values", ...values, exclude: false };
  const text = readText(part, name);
  if (text) {
    const operator = text.fn === "contains" ? "contains" : text.fn === "starts_with" ? "startsWith" : "endsWith";
    return { kind: "condition", operator, first: text.text, second: "" };
  }
  const comparison = COMPARISONS.find((fn) => isCall(part, fn as FunctionName));
  if (comparison && isCall(part, comparison as FunctionName)) {
    const [left, right] = part.args;
    // One side of a range is read as the comparison it is.
    if (isColumn(left, name) && isLiteral(right)) {
      return { kind: "condition", operator: comparison, first: literalText(right), second: "" };
    }
  }
  return "other";
}

/** Whether a value is blank (§3.2). */
export function isBlank(value: JsonValue, column: Column) {
  return value === null || (column.type === "string" && value === "");
}

/** The conditions of a column (§6.2.1): the parts of `where` that are not the search and refer to it and no other. */
export function conditionsOf(where: Expr | undefined, name: string): Expr[] {
  return partsOf(where).filter((part) => {
    if ("search" in part) return false;
    const names = columnsOf(part);
    return names.size === 1 && names.has(name);
  });
}

/**
 * The plan whose rows are a column's values and how many rows have each, the most common first: the rows of
 * `plan` without its conditions on the column (so that the list holds the values that other filters leave), and
 * with those whose text contains `search`, ignoring letter case. Null when the plan groups rows.
 */
export function valuesPlan(plan: Plan, name: string, search: string): { plan: Plan; count: string } | null {
  if (plan.aggregate) return null;
  const own = new Set(conditionsOf(plan.where, name));
  const parts = partsOf(plan.where).filter((part) => !own.has(part));
  if (search.trim() !== "") {
    parts.push(call("contains", call("lower", call("text", { col: name })), call("lower", { lit: search })));
  }
  let count = "count";
  for (let n = 2; count === name; n++) count = `count ${n}`;
  const where = joinParts(parts);
  return {
    plan: {
      ...(plan.derive ? { derive: plan.derive } : {}),
      ...(where ? { where } : {}),
      aggregate: { keys: [name], measures: [{ name: count, fn: "count" }] },
      sort: [
        { column: count, direction: "desc" },
        { column: name, direction: "asc" },
      ],
    },
    count,
  };
}
