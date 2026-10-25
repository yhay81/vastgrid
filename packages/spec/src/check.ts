/**
 * Checking a plan against a table's columns (docs/v2-spec.md §4.7): its form, its names, the types of its
 * expressions (§3.7, §4.4, §4.5) and its limits (§4.9). The checked plan is a typed tree that engines run.
 */
import {
  type Capabilities,
  FUNCTIONS,
  type FunctionName,
  LIMITS,
  MEASURES,
  type MeasureName,
  type Plan,
  PlanError,
  type PlanErrorReason,
  type PlanMember,
  type SortDirection,
} from "./plan.js";
import { type Column, type JsonValue, LOGICAL_TYPES, type LogicalType, type ValueType } from "./types.js";
import { decimalTextType, isValueOf, sameType, trimSpaces, typeName } from "./values.js";

/** The type of an untyped null literal until its place gives it one (§2.5). */
export interface NullType {
  type: "null";
}

export type ExprType = ValueType | NullType;

export interface ColumnExpr {
  kind: "column";
  name: string;
  type: ValueType;
}

export interface LiteralExpr {
  kind: "literal";
  value: JsonValue;
  type: ExprType;
}

export interface CallExpr {
  kind: "call";
  fn: FunctionName;
  args: TypedExpr[];
  type: ValueType;
}

/** The search of §3.5, over the table's own columns. */
export interface SearchExpr {
  kind: "search";
  text: string;
  columns: Column[];
  type: ValueType;
}

/** A checked expression: every node knows its type. */
export type TypedExpr = ColumnExpr | LiteralExpr | CallExpr | SearchExpr;

export interface CheckedDerived {
  name: string;
  expr: TypedExpr;
  column: Column;
}

export interface CheckedMeasure {
  name: string;
  fn: MeasureName;
  /** The measured column; null for `count` of rows. */
  column: Column | null;
  /** `quantile`'s `p`. */
  p: number | null;
  approx: boolean;
  type: ValueType;
}

export interface CheckedPivot {
  columns: Column[];
  maxColumns: number;
}

export interface CheckedAggregate {
  keys: Column[];
  measures: CheckedMeasure[];
  pivot: CheckedPivot | null;
}

export interface CheckedSortKey {
  column: Column;
  direction: SortDirection;
}

/** A plan checked against a table (§4.7). */
export interface CheckedPlan {
  /** The plan as given. */
  plan: Plan;
  /** The table's columns. */
  table: Column[];
  derive: CheckedDerived[];
  /** The columns of the rows before grouping: the table's, then the derived ones. */
  rows: Column[];
  where: TypedExpr | null;
  aggregate: CheckedAggregate | null;
  having: TypedExpr | null;
  sort: CheckedSortKey[];
  /** The view's columns (§4.2). For a pivot, only the keys: the generated columns come from the data. */
  columns: Column[];
  /** Views without `aggregate` have row IDs. */
  rowIds: boolean;
}

/** What an engine evaluates (§4.10); everything by default. */
export interface CheckOptions {
  functions?: readonly string[];
  measures?: readonly string[];
  plan?: Partial<Record<PlanMember, boolean>>;
}

/** The options of `checkPlan` for an engine's capabilities: everything without them. */
export function planOptions(capabilities?: Capabilities): CheckOptions {
  if (!capabilities) return {};
  return { functions: capabilities.functions, measures: capabilities.measures, plan: capabilities.plan };
}

type Place = "derive" | "where" | "having";

const BOOLEAN: ValueType = { type: "boolean" };
const INTEGER: ValueType = { type: "integer" };
const BIGINT: ValueType = { type: "bigint" };
const FLOAT: ValueType = { type: "float" };
const STRING: ValueType = { type: "string" };
const DATE: ValueType = { type: "date" };
const TIMESTAMP: ValueType = { type: "timestamp" };

const ORDERABLE = new Set<LogicalType>([
  "integer",
  "bigint",
  "decimal",
  "float",
  "string",
  "boolean",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
]);

function isNumber(type: ValueType) {
  return type.type === "integer" || type.type === "bigint" || type.type === "decimal" || type.type === "float";
}

function isWhole(type: ValueType) {
  return type.type === "integer" || type.type === "bigint";
}

function isDateLike(type: ValueType) {
  return type.type === "date" || type.type === "timestamp";
}

function isNull(type: ExprType): type is NullType {
  return type.type === "null";
}

/** Values of these types can be compared with each other (§3.1). */
function comparable(a: ValueType, b: ValueType) {
  if (isNumber(a) && isNumber(b)) return true;
  if (isDateLike(a) && isDateLike(b)) return true;
  return a.type === b.type;
}

function decimal(precision: number, scale: number): ValueType {
  return { type: "decimal", precision, scale };
}

/** Precision and scale of an exact number when it meets a decimal (§3.7). */
function decimalShape(type: ValueType): { p: number; s: number } {
  if (type.type === "integer") return { p: 10, s: 0 };
  if (type.type === "bigint") return { p: 19, s: 0 };
  return { p: type.precision ?? 38, s: type.scale ?? 0 };
}

/** The type of `add`, `sub`, `mul`, `div` or `mod` on two numbers (§3.7). */
export function arithmeticType(fn: "add" | "sub" | "mul" | "div" | "mod", a: ValueType, b: ValueType): ValueType {
  if (fn === "div" || a.type === "float" || b.type === "float") return FLOAT;
  if (isWhole(a) && isWhole(b)) return BIGINT;
  const x = decimalShape(a);
  const y = decimalShape(b);
  const scale = Math.max(x.s, y.s);
  const whole = Math.max(x.p - x.s, y.p - y.s);
  switch (fn) {
    case "add":
    case "sub":
      return decimal(Math.min(38, whole + scale + 1), scale);
    case "mul":
      return x.s + y.s > 38 ? FLOAT : decimal(Math.min(38, x.p + y.p), x.s + y.s);
    case "mod":
      return decimal(Math.min(38, whole + scale), scale);
  }
}

/** The type of a measure (§3.8, §4.5). */
function measureType(fn: MeasureName, column: Column | null): ValueType {
  switch (fn) {
    case "count":
    case "count_distinct":
      return BIGINT;
    case "sum":
      if (column === null) return BIGINT;
      if (isWhole(column)) return decimal(38, 0);
      if (column.type === "decimal") return decimal(38, column.scale ?? 0);
      return FLOAT;
    case "avg":
    case "stddev":
    case "quantile":
      return FLOAT;
    case "min":
    case "max":
      return column ? valueType(column) : BIGINT;
  }
}

/** A column's type without its other members. */
export function valueType(column: ValueType): ValueType {
  const type: ValueType = { type: column.type };
  if (column.precision !== undefined) type.precision = column.precision;
  if (column.scale !== undefined) type.scale = column.scale;
  if (column.bits !== undefined && column.bits !== 64) type.bits = column.bits;
  if (column.unit !== undefined && column.unit !== "us") type.unit = column.unit;
  return type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The JSON Pointer of a member. */
function child(path: string, key: string | number) {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function fail(path: string, reason: PlanErrorReason, message: string): never {
  throw new PlanError(path, reason, message);
}

function members(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(child(path, key), "syntax", `"${key}" is not a member here.`);
  }
}

function nameOf(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "syntax", "A name is a string.");
  const length = [...value].length;
  if (length < 1 || length > LIMITS.name) fail(path, "syntax", `A name has 1 to ${LIMITS.name} characters.`);
  return value;
}

function settle(node: TypedExpr, type: ValueType) {
  if (node.kind === "literal" && isNull(node.type)) node.type = type;
}

function describeCount(min: number, max: number) {
  if (min === max) return `${min}`;
  return max === Number.POSITIVE_INFINITY ? `${min} or more` : `${min} to ${max}`;
}

class Checker {
  private readonly table: Column[];
  private readonly options: CheckOptions;
  private inLiterals = 0;
  private searched = false;
  private nodes = 0;
  private root = "";

  constructor(table: readonly Column[], options: CheckOptions) {
    this.table = [...table];
    this.options = options;
  }

  member(name: PlanMember, path: string) {
    if (this.options.plan?.[name] === false) fail(path, "unsupported", `This engine does not evaluate ${name}.`);
  }

  /** Checks one expression of the plan (a derived column, `where` or `having`). */
  expression(node: unknown, scope: ReadonlyMap<string, Column>, path: string, place: Place): TypedExpr {
    this.nodes = 0;
    this.root = path;
    return this.visit(node, scope, path, place, 1);
  }

  private visit(
    node: unknown,
    scope: ReadonlyMap<string, Column>,
    path: string,
    place: Place,
    depth: number,
  ): TypedExpr {
    if (depth > LIMITS.depth) fail(path, "limit", `An expression is nested at most ${LIMITS.depth} levels deep.`);
    if (++this.nodes > LIMITS.nodes) fail(this.root, "limit", `An expression has at most ${LIMITS.nodes} nodes.`);
    if (!isObject(node))
      fail(path, "syntax", "An expression is an object: { col }, { lit }, { fn, args } or { search }.");
    if ("col" in node) {
      members(node, ["col"], path);
      const name = nameOf(node.col, child(path, "col"));
      const column = scope.get(name);
      if (!column) fail(path, "unknown_column", `There is no column "${name}" here.`);
      return { kind: "column", name, type: valueType(column) };
    }
    if ("lit" in node) {
      members(node, ["lit", "type"], path);
      return this.literal(node.lit, node.type, path);
    }
    if ("search" in node) {
      members(node, ["search"], path);
      return this.search(node.search, path, place);
    }
    if ("fn" in node) {
      members(node, ["fn", "args"], path);
      if (typeof node.fn !== "string") fail(child(path, "fn"), "syntax", "A function's name is a string.");
      if (!(FUNCTIONS as readonly string[]).includes(node.fn)) {
        fail(path, "unknown_function", `There is no function "${node.fn}".`);
      }
      const fn = node.fn as FunctionName;
      if (this.options.functions && !this.options.functions.includes(fn)) {
        fail(path, "unsupported", `This engine does not evaluate ${fn}.`);
      }
      if (!Array.isArray(node.args)) fail(child(path, "args"), "syntax", "A function's arguments are an array.");
      const argsPath = child(path, "args");
      const args = node.args.map((arg, index) => this.visit(arg, scope, child(argsPath, index), place, depth + 1));
      return { kind: "call", fn, args, type: this.call(fn, args, path) };
    }
    return fail(path, "syntax", "An expression is an object: { col }, { lit }, { fn, args } or { search }.");
  }

  private literal(value: unknown, declared: unknown, path: string): TypedExpr {
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      fail(child(path, "lit"), "syntax", "A literal is a string, a number, a boolean or null.");
    }
    if (declared === undefined) {
      if (value === null) return { kind: "literal", value, type: { type: "null" } };
      if (typeof value === "boolean") return { kind: "literal", value, type: BOOLEAN };
      if (typeof value === "string") {
        if (!isValueOf(value, STRING)) fail(path, "literal", "A string literal is well-formed Unicode text.");
        return { kind: "literal", value, type: STRING };
      }
      if (!Number.isFinite(value)) fail(path, "literal", "A number literal is finite; write NaN with type float.");
      return { kind: "literal", value, type: Number.isSafeInteger(value) ? BIGINT : FLOAT };
    }
    if (typeof declared !== "string" || !(LOGICAL_TYPES as readonly string[]).includes(declared)) {
      fail(child(path, "type"), "syntax", `There is no type ${JSON.stringify(declared)}.`);
    }
    const type = declared as LogicalType;
    if (value === null) {
      return { kind: "literal", value, type: type === "decimal" ? decimal(38, 0) : { type } };
    }
    if (type === "decimal") {
      const found = typeof value === "string" ? decimalTextType(value) : null;
      if (!found)
        fail(path, "literal", `${JSON.stringify(value)} is not a decimal written as digits, such as "12.50".`);
      return { kind: "literal", value, type: decimal(found.precision, found.scale) };
    }
    let literalType: ValueType = { type };
    if (type === "timestamp" && typeof value === "string") {
      const digits = /\.([0-9]+)$/.exec(value)?.[1].length ?? 0;
      literalType = digits > 6 ? { type, unit: "ns" } : TIMESTAMP;
    }
    if (!isValueOf(value, literalType)) fail(path, "literal", `${JSON.stringify(value)} is not a ${type} value.`);
    return { kind: "literal", value, type: literalType };
  }

  private search(text: unknown, path: string, place: Place): TypedExpr {
    this.member("search", path);
    if (typeof text !== "string") fail(child(path, "search"), "syntax", "A search is a string.");
    if (!isValueOf(text, STRING)) fail(child(path, "search"), "literal", "A search is well-formed Unicode text.");
    if (place !== "where" || this.searched) fail(path, "misplaced", "A plan can search once, in where.");
    if (trimSpaces(text) === "") fail(path, "literal", "A search needs text other than spaces.");
    this.searched = true;
    return { kind: "search", text, columns: [...this.table], type: BOOLEAN };
  }

  /** A value of the kind a function takes: an untyped null takes `otherwise`. */
  private want(
    arg: TypedExpr,
    path: string,
    accepts: (type: ValueType) => boolean,
    kind: string,
    otherwise: ValueType,
  ) {
    if (isNull(arg.type)) {
      settle(arg, otherwise);
      return;
    }
    if (!accepts(arg.type)) fail(path, "type", `Expected ${kind}, not ${typeName(arg.type)}.`);
  }

  /** The common type of several values (§4.4), given to their untyped nulls. */
  private common(args: TypedExpr[], path: string): ValueType {
    let result: ValueType | null = null;
    for (const arg of args) {
      if (isNull(arg.type)) continue;
      const type = arg.type;
      if (result === null || sameType(result, type)) {
        result = result ?? type;
      } else if (isNumber(result) && isNumber(type)) {
        result = result.type === "float" || type.type === "float" ? FLOAT : arithmeticType("add", result, type);
      } else if (isDateLike(result) && isDateLike(type)) {
        result = result.type === "timestamp" ? result : type;
      } else {
        fail(path, "type", `${typeName(result)} and ${typeName(type)} have no common type.`);
      }
    }
    if (result === null) fail(path, "type", "The type of these values cannot be decided: give a null literal a type.");
    for (const arg of args) settle(arg, result);
    return result;
  }

  /** Two numbers, whose untyped nulls take the other's type. */
  private numbers(fn: FunctionName, args: TypedExpr[], path: string): [ValueType, ValueType] {
    const [a, b] = args;
    if (isNull(a.type) && isNull(b.type)) fail(path, "type", `The types of ${fn}'s arguments cannot be decided.`);
    if (isNull(a.type)) settle(a, b.type as ValueType);
    if (isNull(b.type)) settle(b, a.type as ValueType);
    args.forEach((arg, index) => {
      this.want(arg, child(child(path, "args"), index), isNumber, "a number", FLOAT);
    });
    return [a.type as ValueType, b.type as ValueType];
  }

  private call(fn: FunctionName, args: TypedExpr[], path: string): ValueType {
    const at = (index: number) => child(child(path, "args"), index);
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) {
        fail(path, "arity", `${fn} takes ${describeCount(min, max)} arguments, not ${args.length}.`);
      }
    };
    const strings = () => {
      args.forEach((arg, index) => {
        this.want(arg, at(index), (type) => type.type === "string", "a string", STRING);
      });
    };
    const wholeNumber = (index: number) => {
      this.want(args[index], at(index), isWhole, "an integer", BIGINT);
    };
    switch (fn) {
      case "and":
      case "or":
        arity(2, Number.POSITIVE_INFINITY);
        args.forEach((arg, index) => {
          this.want(arg, at(index), (type) => type.type === "boolean", "a boolean", BOOLEAN);
        });
        return BOOLEAN;
      case "not":
        arity(1);
        this.want(args[0], at(0), (type) => type.type === "boolean", "a boolean", BOOLEAN);
        return BOOLEAN;
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        arity(2);
        const [a, b] = args;
        if (isNull(a.type) && isNull(b.type))
          fail(path, "type", "The type of a comparison of two nulls cannot be decided.");
        if (isNull(a.type)) settle(a, b.type as ValueType);
        if (isNull(b.type)) settle(b, a.type as ValueType);
        const [x, y] = [a.type as ValueType, b.type as ValueType];
        if (!comparable(x, y)) fail(path, "type", `${typeName(x)} and ${typeName(y)} values cannot be compared.`);
        return BOOLEAN;
      }
      case "in": {
        arity(2, Number.POSITIVE_INFINITY);
        const [value, ...items] = args;
        items.forEach((item, index) => {
          if (item.kind !== "literal" || item.value === null) {
            fail(at(index + 1), "type", "The values of in are literals other than null.");
          }
        });
        if (isNull(value.type)) settle(value, items[0].type as ValueType);
        const type = value.type as ValueType;
        items.forEach((item, index) => {
          if (!comparable(type, item.type as ValueType)) {
            fail(
              at(index + 1),
              "type",
              `${typeName(item.type as ValueType)} cannot be compared with ${typeName(type)}.`,
            );
          }
        });
        this.inLiterals += items.length;
        if (this.inLiterals > LIMITS.inLiterals)
          fail(path, "limit", `A plan has at most ${LIMITS.inLiterals} values of in.`);
        return BOOLEAN;
      }
      case "is_null":
      case "is_blank":
        arity(1);
        return BOOLEAN;
      case "if":
        arity(3);
        this.want(args[0], at(0), (type) => type.type === "boolean", "a boolean", BOOLEAN);
        return this.common(args.slice(1), path);
      case "coalesce":
        arity(1, Number.POSITIVE_INFINITY);
        return this.common(args, path);
      case "least":
      case "greatest": {
        arity(2, Number.POSITIVE_INFINITY);
        const type = this.common(args, path);
        if (!ORDERABLE.has(type.type)) fail(path, "type", `${typeName(type)} values have no order.`);
        return type;
      }
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "mod": {
        arity(2);
        const [a, b] = this.numbers(fn, args, path);
        return arithmeticType(fn, a, b);
      }
      case "neg":
      case "abs":
        arity(1);
        this.want(args[0], at(0), isNumber, "a number", FLOAT);
        return (args[0].type as ValueType).type === "float" ? FLOAT : valueType(args[0].type as ValueType);
      case "round": {
        arity(1, 2);
        this.want(args[0], at(0), isNumber, "a number", FLOAT);
        let digits = 0;
        if (args.length === 2) {
          const node = args[1];
          if (node.kind !== "literal" || typeof node.value !== "number" || !Number.isInteger(node.value)) {
            fail(at(1), "type", "round's digits are an integer literal.");
          }
          digits = node.value;
          if (digits < -18 || digits > 18) fail(at(1), "type", "round's digits are from -18 to 18.");
        }
        const type = args[0].type as ValueType;
        if (type.type === "float") return FLOAT;
        if (type.type === "decimal")
          return decimal(type.precision ?? 38, Math.min(type.scale ?? 0, Math.max(digits, 0)));
        return valueType(type);
      }
      case "floor":
      case "ceil": {
        arity(1);
        this.want(args[0], at(0), isNumber, "a number", FLOAT);
        const type = args[0].type as ValueType;
        if (type.type === "float") return FLOAT;
        if (type.type === "decimal") return decimal(type.precision ?? 38, 0);
        return valueType(type);
      }
      case "sqrt":
      case "exp":
      case "ln":
      case "log10":
        arity(1);
        this.want(args[0], at(0), isNumber, "a number", FLOAT);
        return FLOAT;
      case "power":
        arity(2);
        this.numbers(fn, args, path);
        return FLOAT;
      case "sign":
        arity(1);
        this.want(args[0], at(0), isNumber, "a number", FLOAT);
        return INTEGER;
      case "to_number":
        arity(1);
        strings();
        return FLOAT;
      case "concat":
        arity(1, Number.POSITIVE_INFINITY);
        for (const arg of args) settle(arg, STRING);
        return STRING;
      case "length":
        arity(1);
        strings();
        return BIGINT;
      case "lower":
      case "upper":
      case "trim":
        arity(1);
        strings();
        return STRING;
      case "left":
      case "right":
        arity(2);
        this.want(args[0], at(0), (type) => type.type === "string", "a string", STRING);
        wholeNumber(1);
        return STRING;
      case "substr":
        arity(2, 3);
        this.want(args[0], at(0), (type) => type.type === "string", "a string", STRING);
        for (let index = 1; index < args.length; index++) wholeNumber(index);
        return STRING;
      case "replace":
        arity(3);
        strings();
        return STRING;
      case "contains":
      case "starts_with":
      case "ends_with":
        arity(2);
        strings();
        return BOOLEAN;
      case "text":
        arity(1);
        settle(args[0], STRING);
        return STRING;
      case "to_date":
        arity(1);
        strings();
        return DATE;
      case "to_timestamp":
        arity(1);
        strings();
        return TIMESTAMP;
      case "year":
      case "month":
      case "day":
      case "isodow":
        arity(1);
        this.want(args[0], at(0), isDateLike, "a date or a timestamp", DATE);
        return BIGINT;
      case "hour":
      case "minute":
      case "second":
        arity(1);
        this.want(
          args[0],
          at(0),
          (type) => type.type === "time" || type.type === "timestamp",
          "a time or a timestamp",
          TIMESTAMP,
        );
        return BIGINT;
      case "date_diff_days":
        arity(2);
        args.forEach((arg, index) => {
          this.want(arg, at(index), isDateLike, "a date or a timestamp", DATE);
        });
        return BIGINT;
      case "add_days":
        arity(2);
        this.want(args[0], at(0), isDateLike, "a date or a timestamp", DATE);
        wholeNumber(1);
        return valueType(args[0].type as ValueType);
    }
  }

  measures(raw: unknown, rows: ReadonlyMap<string, Column>, names: Set<string>, path: string): CheckedMeasure[] {
    if (!Array.isArray(raw)) fail(path, "syntax", "measures is an array.");
    if (raw.length > LIMITS.measures) fail(path, "limit", `An aggregate has at most ${LIMITS.measures} measures.`);
    return raw.map((measure, index) => {
      const at = child(path, index);
      if (!isObject(measure)) fail(at, "syntax", "A measure is an object: { name, fn, column?, p?, approx? }.");
      members(measure, ["name", "fn", "column", "p", "approx"], at);
      const name = nameOf(measure.name, child(at, "name"));
      if (typeof measure.fn !== "string") fail(child(at, "fn"), "syntax", "A measure's fn is a string.");
      if (!(MEASURES as readonly string[]).includes(measure.fn)) {
        fail(child(at, "fn"), "unknown_function", `There is no measure "${measure.fn}".`);
      }
      const fn = measure.fn as MeasureName;
      if (this.options.measures && !this.options.measures.includes(fn)) {
        fail(child(at, "fn"), "unsupported", `This engine does not evaluate ${fn}.`);
      }
      if (names.has(name)) fail(child(at, "name"), "duplicate_name", `The view already has a column "${name}".`);
      names.add(name);
      let column: Column | null = null;
      if (measure.column !== undefined) {
        const columnName = nameOf(measure.column, child(at, "column"));
        const found = rows.get(columnName);
        if (!found) fail(child(at, "column"), "unknown_column", `There is no column "${columnName}" here.`);
        column = found;
      } else if (fn !== "count") {
        fail(at, "syntax", `${fn} measures a column.`);
      }
      if (column) {
        const accepts =
          fn === "count"
            ? () => true
            : fn === "count_distinct" || fn === "min" || fn === "max"
              ? (type: ValueType) => ORDERABLE.has(type.type)
              : isNumber;
        if (!accepts(column)) fail(child(at, "column"), "type", `${fn} does not measure ${typeName(column)} values.`);
      }
      let p: number | null = null;
      if (fn === "quantile") {
        if (typeof measure.p !== "number" || !(measure.p >= 0 && measure.p <= 1)) {
          fail(child(at, "p"), "syntax", "quantile takes p, from 0 to 1.");
        }
        p = measure.p;
      } else if (measure.p !== undefined) {
        fail(child(at, "p"), "syntax", "Only quantile takes p.");
      }
      if (measure.approx !== undefined && typeof measure.approx !== "boolean") {
        fail(child(at, "approx"), "syntax", "approx is a boolean.");
      }
      return { name, fn, column, p, approx: measure.approx === true, type: measureType(fn, column) };
    });
  }
}

function columnOf(name: string, type: ValueType): Column {
  return { name, ...valueType(type) };
}

/**
 * Checks a plan against a table's columns (§4.7) and gives the typed tree that engines run. Throws a
 * `PlanError` with the JSON Pointer `path` of the problem and its `reason`.
 */
export function checkPlan(plan: unknown, table: readonly Column[], options: CheckOptions = {}): CheckedPlan {
  const checker = new Checker(table, options);
  if (!isObject(plan)) fail("", "syntax", "A plan is an object.");
  members(plan, ["derive", "where", "aggregate", "having", "sort"], "");
  const rows = new Map(table.map((column) => [column.name, column]));

  const derive: CheckedDerived[] = [];
  if (plan.derive !== undefined) {
    checker.member("derive", "/derive");
    if (!Array.isArray(plan.derive)) fail("/derive", "syntax", "derive is an array.");
    if (plan.derive.length > LIMITS.derive)
      fail("/derive", "limit", `A plan has at most ${LIMITS.derive} derived columns.`);
    plan.derive.forEach((item, index) => {
      const at = `/derive/${index}`;
      if (!isObject(item)) fail(at, "syntax", "A derived column is an object: { name, expr }.");
      members(item, ["name", "expr"], at);
      const name = nameOf(item.name, `${at}/name`);
      if (rows.has(name)) fail(`${at}/name`, "duplicate_name", `The view already has a column "${name}".`);
      const expr = checker.expression(item.expr, rows, `${at}/expr`, "derive");
      if (isNull(expr.type))
        fail(`${at}/expr`, "type", "The type of a derived column cannot be decided: give the null literal a type.");
      const column = columnOf(name, expr.type);
      derive.push({ name, expr, column });
      rows.set(name, column);
    });
  }

  let where: TypedExpr | null = null;
  if (plan.where !== undefined) {
    checker.member("where", "/where");
    where = checker.expression(plan.where, rows, "/where", "where");
    if (isNull(where.type)) settle(where, BOOLEAN);
    if (where.type.type !== "boolean")
      fail("/where", "type", `where is a boolean, not ${typeName(where.type as ValueType)}.`);
  }

  let aggregate: CheckedAggregate | null = null;
  let columns = [...rows.values()];
  if (plan.aggregate !== undefined) {
    checker.member("aggregate", "/aggregate");
    const raw = plan.aggregate;
    if (!isObject(raw)) fail("/aggregate", "syntax", "aggregate is an object: { keys, measures, pivot? }.");
    members(raw, ["keys", "measures", "pivot"], "/aggregate");
    if (!Array.isArray(raw.keys)) fail("/aggregate/keys", "syntax", "keys is an array of column names.");
    if (raw.keys.length > LIMITS.keys)
      fail("/aggregate/keys", "limit", `An aggregate has at most ${LIMITS.keys} keys.`);
    const names = new Set<string>();
    const keys = raw.keys.map((key, index) => {
      const name = nameOf(key, `/aggregate/keys/${index}`);
      const column = rows.get(name);
      if (!column) fail(`/aggregate/keys/${index}`, "unknown_column", `There is no column "${name}" here.`);
      if (names.has(name)) fail(`/aggregate/keys/${index}`, "duplicate_name", `"${name}" is a key twice.`);
      names.add(name);
      return column;
    });
    let pivot: CheckedPivot | null = null;
    if (raw.pivot !== undefined) {
      checker.member("pivot", "/aggregate/pivot");
      const spec = raw.pivot;
      if (!isObject(spec)) fail("/aggregate/pivot", "syntax", "pivot is an object: { columns, maxColumns? }.");
      members(spec, ["columns", "maxColumns"], "/aggregate/pivot");
      if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
        fail("/aggregate/pivot/columns", "syntax", "pivot's columns are a list of column names.");
      }
      if (spec.columns.length > LIMITS.pivotColumns) {
        fail("/aggregate/pivot/columns", "limit", `A pivot has at most ${LIMITS.pivotColumns} columns.`);
      }
      const used = new Set<string>();
      const pivotColumns = spec.columns.map((item, index) => {
        const at = `/aggregate/pivot/columns/${index}`;
        const name = nameOf(item, at);
        const column = rows.get(name);
        if (!column) fail(at, "unknown_column", `There is no column "${name}" here.`);
        if (names.has(name) || used.has(name))
          fail(at, "duplicate_name", `"${name}" is already a key or a pivot column.`);
        used.add(name);
        return column;
      });
      let maxColumns: number = LIMITS.pivotDefault;
      if (spec.maxColumns !== undefined) {
        if (typeof spec.maxColumns !== "number" || !Number.isInteger(spec.maxColumns) || spec.maxColumns < 1) {
          fail("/aggregate/pivot/maxColumns", "syntax", "maxColumns is a positive integer.");
        }
        if (spec.maxColumns > LIMITS.pivotOutput) {
          fail("/aggregate/pivot/maxColumns", "limit", `A pivot makes at most ${LIMITS.pivotOutput} columns.`);
        }
        maxColumns = spec.maxColumns;
      }
      pivot = { columns: pivotColumns, maxColumns };
    }
    const measures = checker.measures(raw.measures, rows, names, "/aggregate/measures");
    if (pivot && measures.length === 0) fail("/aggregate/pivot", "misplaced", "A pivot needs at least one measure.");
    aggregate = { keys, measures, pivot };
    columns = [
      ...keys.map((key) => columnOf(key.name, key)),
      ...(pivot ? [] : measures.map((measure) => columnOf(measure.name, measure.type))),
    ];
  }
  const view = new Map(columns.map((column) => [column.name, column]));

  let having: TypedExpr | null = null;
  if (plan.having !== undefined) {
    checker.member("having", "/having");
    if (!aggregate) fail("/having", "misplaced", "having filters groups: it needs aggregate.");
    having = checker.expression(plan.having, view, "/having", "having");
    if (isNull(having.type)) settle(having, BOOLEAN);
    if (having.type.type !== "boolean")
      fail("/having", "type", `having is a boolean, not ${typeName(having.type as ValueType)}.`);
  }

  const sort: CheckedSortKey[] = [];
  if (plan.sort !== undefined) {
    checker.member("sort", "/sort");
    if (!Array.isArray(plan.sort)) fail("/sort", "syntax", "sort is an array.");
    if (plan.sort.length > LIMITS.sortKeys) fail("/sort", "limit", `A plan has at most ${LIMITS.sortKeys} sort keys.`);
    plan.sort.forEach((key, index) => {
      const at = `/sort/${index}`;
      if (!isObject(key)) fail(at, "syntax", "A sort key is an object: { column, direction }.");
      members(key, ["column", "direction"], at);
      const name = nameOf(key.column, `${at}/column`);
      const column = view.get(name);
      if (!column) fail(`${at}/column`, "unknown_column", `There is no column "${name}" here.`);
      if (key.direction !== "asc" && key.direction !== "desc")
        fail(`${at}/direction`, "syntax", "direction is asc or desc.");
      sort.push({ column, direction: key.direction });
    });
  }

  return {
    plan: plan as Plan,
    table: [...table],
    derive,
    rows: [...rows.values()],
    where,
    aggregate,
    having,
    sort,
    columns,
    rowIds: aggregate === null,
  };
}
