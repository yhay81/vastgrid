/**
 * Plans and expressions (docs/v2-spec.md §4): their JSON form, limits and errors.
 */
import type { JsonValue, LogicalType } from "./types.js";

/** The functions of expressions (§4.4). */
export const FUNCTIONS = [
  // Logic and comparison
  "and",
  "or",
  "not",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "in",
  "is_null",
  "is_blank",
  "if",
  "coalesce",
  "least",
  "greatest",
  // Arithmetic and numbers
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "abs",
  "round",
  "floor",
  "ceil",
  "sqrt",
  "exp",
  "ln",
  "log10",
  "power",
  "sign",
  "to_number",
  // Text
  "concat",
  "length",
  "lower",
  "upper",
  "trim",
  "left",
  "right",
  "substr",
  "replace",
  "contains",
  "starts_with",
  "ends_with",
  "text",
  // Dates and times
  "to_date",
  "to_timestamp",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "isodow",
  "date_diff_days",
  "add_days",
] as const;

export type FunctionName = (typeof FUNCTIONS)[number];

/** The functions of measures (§4.5). */
export const MEASURES = ["count", "count_distinct", "sum", "avg", "stddev", "min", "max", "quantile"] as const;

export type MeasureName = (typeof MEASURES)[number];

/** A column of the row (§4.3). */
export interface ColumnRef {
  col: string;
}

/** A literal (§2.5). */
export interface Literal {
  lit: JsonValue;
  type?: LogicalType;
}

/** A function call (§4.4). */
export interface Call {
  fn: FunctionName;
  args: Expr[];
}

/** The search of §3.5, only in `where`. */
export interface Search {
  search: string;
}

export type Expr = ColumnRef | Literal | Call | Search;

export interface Derived {
  name: string;
  expr: Expr;
}

/** A measure of `aggregate` (§4.5). */
export interface Measure {
  name: string;
  fn: MeasureName;
  column?: string;
  /** `quantile`: from 0 to 1. */
  p?: number;
  /** The engine may approximate `count_distinct` and `quantile`. */
  approx?: boolean;
}

/** A cross tabulation (§4.6). */
export interface Pivot {
  columns: string[];
  maxColumns?: number;
}

export interface Aggregate {
  keys: string[];
  measures: Measure[];
  pivot?: Pivot;
}

export type SortDirection = "asc" | "desc";

export interface SortKey {
  column: string;
  direction: SortDirection;
}

/** A view of a table (§4.1). Every member is optional; `{}` is the table as it is. */
export interface Plan {
  derive?: Derived[];
  where?: Expr;
  aggregate?: Aggregate;
  having?: Expr;
  sort?: SortKey[];
}

/** The limits of §4.9. */
export const LIMITS = {
  derive: 32,
  name: 256,
  nodes: 1000,
  depth: 64,
  inLiterals: 100_000,
  sortKeys: 32,
  keys: 16,
  pivotColumns: 16,
  measures: 64,
  pivotOutput: 1000,
  pivotDefault: 200,
} as const;

/** Why a plan does not validate (§4.7). */
export type PlanErrorReason =
  | "syntax"
  | "unknown_column"
  | "duplicate_name"
  | "type"
  | "arity"
  | "unknown_function"
  | "unsupported"
  | "misplaced"
  | "literal"
  | "limit";

/** A plan that does not validate against a table (§4.7): `path` is a JSON Pointer to the member at fault. */
export class PlanError extends Error {
  readonly code = "invalid_plan";
  readonly path: string;
  readonly reason: PlanErrorReason;

  constructor(path: string, reason: PlanErrorReason, message: string) {
    super(message);
    this.name = "PlanError";
    this.path = path;
    this.reason = reason;
  }
}

/** An error of §8.7 other than `invalid_plan`, such as `too_many_columns`. */
export class SpecError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpecError";
    this.code = code;
  }
}
