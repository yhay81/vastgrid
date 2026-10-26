/**
 * Formulas (docs/v2-spec.md §4.11): the language people type for derived columns. A formula compiles to an
 * expression (§4.3) that engines check and run, and every expression of a derived column is written back
 * as a formula. The language is v1's, whose functions map onto §4.4, with the functions of §4.4 under their
 * own names and literals of every type. Nothing is evaluated here.
 */
import { type CheckOptions, checkExpression, type TypedExpr } from "./check.js";
import { type Expr, FUNCTIONS, type FunctionName, LIMITS, PlanError, type PlanErrorReason } from "./plan.js";
import { type Column, type JsonValue, LOGICAL_TYPES, type LogicalType, type ValueType } from "./types.js";
import { decimalTextType, floatText, isDateText, isTimestampText } from "./values.js";

/** Longest formula, in characters. */
export const MAX_FORMULA_LENGTH = 100_000;

/**
 * Why a formula does not compile: the reasons of §4.7. `start` and `end` are the characters of the formula
 * it is about.
 */
export class FormulaError extends Error {
  readonly reason: PlanErrorReason;
  readonly start: number;
  readonly end: number;

  constructor(reason: PlanErrorReason, message: string, range: Range) {
    super(message);
    this.name = "FormulaError";
    this.reason = reason;
    this.start = range.start;
    this.end = range.end;
  }
}

interface Range {
  start: number;
  end: number;
}

// ----- syntax -----

type Operator = "neg" | "not" | "+" | "-" | "*" | "/" | "%" | "&" | "=" | "<>" | "<" | "<=" | ">" | ">=" | "and" | "or";

/** A formula as written, before names are resolved and types checked. */
type Syntax = (
  | { kind: "number"; text: string }
  | { kind: "literal"; expr: Expr }
  | { kind: "name"; name: string }
  | { kind: "operator"; op: Operator; args: Syntax[] }
  | { kind: "call"; name: string; args: Syntax[] }
) &
  Range & { grouped?: boolean };

type Token =
  | { kind: "number"; value: string; start: number; end: number }
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "name"; value: string; quoted: boolean; start: number; end: number }
  | { kind: "symbol"; value: string; start: number; end: number }
  | { kind: "end"; start: number; end: number };

const identifier = /[\p{L}\p{Nl}_][\p{L}\p{N}\p{M}_]*/uy;
const wholeIdentifier = /^[\p{L}\p{Nl}_][\p{L}\p{N}\p{M}_]*$/u;
const numberPattern = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const symbols = ["<=", ">=", "<>", "!=", "==", "+", "-", "*", "/", "%", "&", "=", "<", ">", "(", ")", ","];
const KEYWORDS = new Set(["AND", "OR", "NOT", "TRUE", "FALSE", "NULL"]);
const TYPE_NAMES = new Map(LOGICAL_TYPES.map((type) => [type.toUpperCase(), type]));

function syntaxError(message: string, start: number, end = start + 1) {
  return new FormulaError("syntax", message, { start, end });
}

function quoted(text: string, at: number, close: string, what: string): { value: string; end: number } {
  let value = "";
  let index = at + 1;
  for (;;) {
    if (index >= text.length) throw syntaxError(`The ${what} is not closed with ${close}.`, at, text.length);
    if (text[index] === close) {
      if (text[index + 1] === close) {
        value += close;
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += text[index++];
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (/\s/u.test(char)) {
      at++;
      continue;
    }
    const start = at;
    if (char === "'" || char === '"') {
      const { value, end } = quoted(text, at, char, "text");
      tokens.push({ kind: "string", value, start, end });
      at = end;
      continue;
    }
    if (char === "[") {
      const { value, end } = quoted(text, at, "]", "column name");
      if (value === "") throw syntaxError("The brackets have no column name.", start, end);
      tokens.push({ kind: "name", value, quoted: true, start, end });
      at = end;
      continue;
    }
    numberPattern.lastIndex = at;
    const number = numberPattern.exec(text);
    if (number && /[\d.]/.test(char)) {
      at += number[0].length;
      identifier.lastIndex = at;
      if (identifier.test(text) || text[at] === ".") throw syntaxError("This is not a number.", start, at + 1);
      tokens.push({ kind: "number", value: number[0], start, end: at });
      continue;
    }
    identifier.lastIndex = at;
    const name = identifier.exec(text);
    if (name) {
      at += name[0].length;
      tokens.push({ kind: "name", value: name[0], quoted: false, start, end: at });
      continue;
    }
    const symbol = symbols.find((item) => text.startsWith(item, at));
    if (!symbol) throw syntaxError(`Unexpected character "${char}".`, start);
    at += symbol.length;
    tokens.push({ kind: "symbol", value: symbol, start, end: at });
  }
  tokens.push({ kind: "end", start: text.length, end: text.length });
  return tokens;
}

function keyword(token: Token) {
  return token.kind === "name" && !token.quoted ? token.value.toUpperCase() : null;
}

const comparisons: Record<string, Operator> = {
  "=": "=",
  "==": "=",
  "<>": "<>",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/** Operators whose chains are one call (`a & b & c` is one `concat`), unless a part is in parentheses. */
const CHAINED = new Set<Operator>(["and", "or", "&"]);

class Parser {
  private at = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private get token() {
    return this.tokens[this.at];
  }

  private symbol(value: string) {
    const token = this.token;
    if (token.kind === "symbol" && token.value === value) {
      this.at++;
      return true;
    }
    return false;
  }

  private enter(start: number) {
    if (++this.depth > LIMITS.depth) {
      throw new FormulaError("limit", `A formula nests at most ${LIMITS.depth} levels.`, { start, end: start + 1 });
    }
  }

  parse(): Syntax {
    const tree = this.or();
    if (this.token.kind !== "end") throw this.unexpected();
    return tree;
  }

  private unexpected() {
    const token = this.token;
    if (token.kind === "end") return syntaxError("The formula ends too early.", token.start, token.start);
    return syntaxError("Unexpected text here.", token.start, token.end);
  }

  private binary(next: () => Syntax, operators: (token: Token) => Operator | null) {
    const start = this.token.start;
    let left = next();
    let levels = 0;
    for (;;) {
      const op = operators(this.token);
      if (!op) break;
      this.at++;
      const right = next();
      if (CHAINED.has(op) && left.kind === "operator" && left.op === op && !left.grouped) {
        left = { ...left, args: [...left.args, right], end: right.end };
        continue;
      }
      // Each operator of a chain nests the tree one level deeper.
      this.enter(start);
      levels++;
      left = { kind: "operator", op, args: [left, right], start: left.start, end: right.end };
    }
    this.depth -= levels;
    return left;
  }

  private or(): Syntax {
    return this.binary(
      () => this.and(),
      (token) => (keyword(token) === "OR" ? "or" : null),
    );
  }

  private and(): Syntax {
    return this.binary(
      () => this.not(),
      (token) => (keyword(token) === "AND" ? "and" : null),
    );
  }

  private not(): Syntax {
    const start = this.token.start;
    if (keyword(this.token) === "NOT") {
      this.at++;
      this.enter(start);
      const operand = this.not();
      this.depth--;
      return { kind: "operator", op: "not", args: [operand], start, end: operand.end };
    }
    return this.comparison();
  }

  private comparison(): Syntax {
    return this.binary(
      () => this.concat(),
      (token) => (token.kind === "symbol" ? (comparisons[token.value] ?? null) : null),
    );
  }

  private concat(): Syntax {
    return this.binary(
      () => this.additive(),
      (token) => (token.kind === "symbol" && token.value === "&" ? "&" : null),
    );
  }

  private additive(): Syntax {
    return this.binary(
      () => this.multiplicative(),
      (token) => (token.kind === "symbol" && (token.value === "+" || token.value === "-") ? token.value : null),
    );
  }

  private multiplicative(): Syntax {
    return this.binary(
      () => this.unary(),
      (token) =>
        token.kind === "symbol" && (token.value === "*" || token.value === "/" || token.value === "%")
          ? (token.value as Operator)
          : null,
    );
  }

  private unary(): Syntax {
    const start = this.token.start;
    if (this.symbol("-")) {
      this.enter(start);
      const operand = this.unary();
      this.depth--;
      // A minus written before a number is part of the number.
      if (operand.kind === "number" && !operand.grouped && !operand.text.startsWith("-")) {
        return { kind: "number", text: `-${operand.text}`, start, end: operand.end };
      }
      return { kind: "operator", op: "neg", args: [operand], start, end: operand.end };
    }
    return this.primary();
  }

  private primary(): Syntax {
    const token = this.token;
    switch (token.kind) {
      case "number":
        this.at++;
        return { kind: "number", text: token.value, start: token.start, end: token.end };
      case "string":
        this.at++;
        return { kind: "literal", expr: { lit: token.value }, start: token.start, end: token.end };
      case "name": {
        this.at++;
        const word = keyword(token);
        if (word === "TRUE" || word === "FALSE") {
          return { kind: "literal", expr: { lit: word === "TRUE" }, start: token.start, end: token.end };
        }
        if (word === "NULL") return { kind: "literal", expr: { lit: null }, start: token.start, end: token.end };
        if (word && KEYWORDS.has(word)) {
          this.at--;
          throw this.unexpected();
        }
        const type = word ? TYPE_NAMES.get(word) : undefined;
        const next = this.token;
        if (type && (next.kind === "string" || keyword(next) === "NULL")) {
          this.at++;
          const range = { start: token.start, end: next.end };
          const expr = next.kind === "string" ? typedLiteral(type, next.value, range) : { lit: null, type };
          return { kind: "literal", expr, ...range };
        }
        if (!token.quoted && this.symbol("(")) {
          this.enter(token.start);
          const args: Syntax[] = [];
          if (!this.symbol(")")) {
            for (;;) {
              args.push(this.or());
              if (this.symbol(")")) break;
              if (!this.symbol(",")) throw this.unexpected();
            }
          }
          this.depth--;
          return { kind: "call", name: token.value, args, start: token.start, end: this.tokens[this.at - 1].end };
        }
        return { kind: "name", name: token.value, start: token.start, end: token.end };
      }
      case "symbol":
        if (token.value === "(") {
          this.at++;
          this.enter(token.start);
          const inner = this.or();
          this.depth--;
          if (!this.symbol(")")) throw this.unexpected();
          return { ...inner, grouped: true, start: token.start, end: this.tokens[this.at - 1].end };
        }
        throw this.unexpected();
      default:
        throw this.unexpected();
    }
  }
}

function parse(text: string): Syntax {
  if (text.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError("limit", `A formula has at most ${MAX_FORMULA_LENGTH} characters.`, {
      start: MAX_FORMULA_LENGTH,
      end: text.length,
    });
  }
  if (!text.trim()) throw syntaxError("The formula is empty.", 0, 0);
  return new Parser(tokenize(text)).parse();
}

// ----- literals -----

const INT64_MAX = 9223372036854775807n;
const temporalPattern =
  /^ *([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[ T]([01]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,9}))?)?)? *$/;

/**
 * A date or a timestamp written as v1 read them (`2024-1-5`, `2024-01-05T10:30`, with spaces around), in the
 * form of §2.2, or null when it is not one.
 */
function temporalText(text: string, type: "date" | "timestamp"): string | null {
  const match = temporalPattern.exec(text);
  if (!match) return null;
  const pad = (value: string | undefined) => (value ?? "0").padStart(2, "0");
  const date = `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  if (type === "date") return isDateText(date) ? date : null;
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  const timestamp = `${date} ${pad(match[4])}:${pad(match[5])}:${pad(match[6])}${fraction ? `.${fraction}` : ""}`;
  return isTimestampText(timestamp, fraction.length > 6 ? "ns" : "us") ? timestamp : null;
}

/** A literal written `TYPE 'text'`, read from the type's text form (§2.4). */
function typedLiteral(type: LogicalType, text: string, range: Range): Expr {
  const invalid = () => new FormulaError("literal", `'${text}' is not a ${type} value.`, range);
  switch (type) {
    case "boolean": {
      const lower = text.toLowerCase();
      if (lower !== "true" && lower !== "false") throw invalid();
      return { lit: lower === "true", type };
    }
    case "integer":
    case "bigint": {
      if (!/^-?(0|[1-9][0-9]*)$/.test(text)) throw invalid();
      const value = Number(text);
      return { lit: Number.isSafeInteger(value) ? value : text, type };
    }
    case "float": {
      const special: Record<string, string> = { nan: "NaN", inf: "Infinity", "-inf": "-Infinity" };
      const name = special[text.toLowerCase()];
      if (name) return { lit: name, type };
      if (!/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text)) throw invalid();
      const value = Number(text);
      return { lit: Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity", type };
    }
    case "date":
    case "timestamp":
      return { lit: temporalText(text, type) ?? text, type };
    default:
      return { lit: text, type };
  }
}

/**
 * The literal of a number as written: a whole number is a bigint (a decimal beyond 64 bits), a number with
 * a point is a decimal, so that it stays exact (§2.5), and one with an exponent is a float.
 */
function numberLiteral(text: string, range: Range): Expr {
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  if (!/[eE]/.test(digits)) {
    const [whole, fraction = ""] = digits.split(".");
    const integer = whole.replace(/^0+(?=.)/, "") || "0";
    const exact = `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
    if (!digits.includes(".")) {
      const value = Number(exact);
      if (Number.isSafeInteger(value)) return { lit: value === 0 ? 0 : value };
      const big = BigInt(exact);
      if (big <= INT64_MAX && big >= -INT64_MAX - 1n) return { lit: exact, type: "bigint" };
    }
    if (decimalTextType(exact)) return { lit: exact, type: "decimal" };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) throw new FormulaError("literal", "The number is too large.", range);
  return Number.isSafeInteger(value) ? { lit: value, type: "float" } : { lit: value };
}

// ----- compiling -----

/** v1's names of functions whose v2 form differs (§4.11); the others are the functions of §4.4. */
const V1_FUNCTIONS = new Set([
  "CEILING",
  "LEN",
  "MID",
  "STARTSWITH",
  "ENDSWITH",
  "VALUE",
  "DATE",
  "DATETIME",
  "WEEKDAY",
  "DAYS",
  "ADDDAYS",
  "ISBLANK",
  "MIN",
  "MAX",
  "IF",
]);

/** Functions of §4.4 that are written as operators: they cannot be called by name. */
const OPERATOR_FUNCTIONS = new Set<FunctionName>(["and", "or", "not"]);

const OPERATOR_FUNCTION: Record<Exclude<Operator, "and" | "or" | "not" | "neg">, FunctionName> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "&": "concat",
  "=": "eq",
  "<>": "ne",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
};

/** Types that v1 read as text: functions of text read their text form. */
const TEXT_LIKE = new Set<string>(["time", "interval", "uuid", "binary"]);
const NUMBER = new Set<string>(["integer", "bigint", "decimal", "float"]);

/** A compiled part of a formula, its type, and where it was written. */
interface Part {
  expr: Expr;
  type: TypedExpr["type"];
  range: Range;
}

function call(fn: FunctionName, ...args: Expr[]): Expr {
  return { fn, args };
}

function isStringLiteral(part: Part): part is Part & { expr: { lit: string } } {
  return "lit" in part.expr && typeof part.expr.lit === "string" && part.expr.type === undefined;
}

class Compiler {
  constructor(
    private readonly columns: readonly Column[],
    private readonly options: CheckOptions,
  ) {}

  /** Checks an expression; an error about one of its arguments is reported where that argument is written. */
  private check(expr: Expr, range: Range, args: readonly (Range | undefined)[] = []): Part {
    try {
      return { expr, type: checkExpression(expr, this.columns, this.options).type, range };
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      const index = /^\/args\/(\d+)/.exec(error.path)?.[1];
      const at = (index === undefined ? undefined : args[Number(index)]) ?? range;
      throw new FormulaError(error.reason, error.message, at);
    }
  }

  private apply(fn: FunctionName, args: Part[], range: Range): Part {
    return this.check(
      call(fn, ...args.map((arg) => arg.expr)),
      range,
      args.map((arg) => arg.range),
    );
  }

  compile(node: Syntax): Part {
    switch (node.kind) {
      case "number":
        return this.check(numberLiteral(node.text, node), node);
      case "literal":
        return this.check(node.expr, node);
      case "name":
        return this.check({ col: node.name }, node);
      case "operator": {
        const args = node.args.map((arg) => this.compile(arg));
        switch (node.op) {
          case "neg":
            return this.apply("neg", args, node);
          case "not":
            return this.apply("not", args, node);
          case "and":
          case "or":
            return this.apply(node.op, args, node);
          default: {
            const fn = OPERATOR_FUNCTION[node.op];
            return this.apply(fn, this.convert(fn, args), node);
          }
        }
      }
      case "call":
        return this.call(node);
    }
  }

  /** v1's conversions of arguments (§4.11): text read as dates, text forms, and whole numbers. */
  private convert(fn: FunctionName, args: Part[]): Part[] {
    switch (fn) {
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
      case "least":
      case "greatest":
      case "coalesce":
      case "in":
        return this.alike(args);
      case "if":
        return [args[0], ...this.alike(args.slice(1))];
      case "length":
      case "lower":
      case "upper":
      case "trim":
      case "replace":
      case "contains":
      case "starts_with":
      case "ends_with":
      case "to_number":
      case "to_date":
      case "to_timestamp":
        return args.map((arg) => this.asString(arg));
      case "left":
      case "right":
      case "substr":
        return args.map((arg, index) => (index === 0 ? this.asString(arg) : this.whole(arg)));
      case "round":
        return args.map((arg, index) => (index === 0 ? arg : this.whole(arg)));
      case "year":
      case "month":
      case "day":
      case "isodow":
      case "date_diff_days":
        return args.map((arg) => this.dateLike(arg, "date"));
      case "add_days":
        return args.map((arg, index) => (index === 0 ? this.dateLike(arg, "date") : this.whole(arg)));
      case "hour":
      case "minute":
      case "second":
        return args.map((arg) => this.dateLike(arg, "timestamp"));
      default:
        return args;
    }
  }

  /** Values to compare or to choose from: text beside dates is read as a date, beside text a text form. */
  private alike(args: Part[]): Part[] {
    const temporal = args.find((arg) => ["date", "timestamp", "timestamptz"].includes(arg.type.type));
    const text = args.some((arg) => arg.type.type === "string" && !isStringLiteral(arg));
    return args.map((arg) => {
      if (temporal && isStringLiteral(arg)) {
        const type = temporal.type.type;
        const literal =
          type === "date"
            ? (temporalText(arg.expr.lit, "date") ?? temporalText(arg.expr.lit, "timestamp"))
            : temporalText(arg.expr.lit, "timestamp");
        if (literal === null) return arg;
        if (type === "timestamptz") return this.check({ lit: `${literal}+00`, type }, arg.range);
        return this.check({ lit: literal, type: literal.length > 10 ? "timestamp" : "date" }, arg.range);
      }
      if ((text || args.some(isStringLiteral)) && TEXT_LIKE.has(arg.type.type)) {
        return this.check(call("text", arg.expr), arg.range);
      }
      return arg;
    });
  }

  /** The text form of a value that v1 read as text (a time, a UUID, …). */
  private asString(arg: Part): Part {
    return TEXT_LIKE.has(arg.type.type) ? this.check(call("text", arg.expr), arg.range) : arg;
  }

  /** A whole number written with a point (`3.0`) as an integer. */
  private whole(arg: Part): Part {
    const expr = arg.expr;
    if ("lit" in expr && (expr.type === "decimal" || expr.type === "float" || typeof expr.lit === "number")) {
      const value = Number(expr.lit);
      if (Number.isSafeInteger(value)) return this.check({ lit: value }, arg.range);
    }
    return arg;
  }

  /** A date or a timestamp: text written as one, a date as its midnight, and a timestamptz in UTC. */
  private dateLike(arg: Part, prefer: "date" | "timestamp"): Part {
    if (isStringLiteral(arg)) {
      const date = prefer === "date" ? temporalText(arg.expr.lit, "date") : null;
      const timestamp = date ?? temporalText(arg.expr.lit, "timestamp");
      if (timestamp !== null) return this.check({ lit: timestamp, type: date ? "date" : "timestamp" }, arg.range);
      return arg;
    }
    if (arg.type.type === "timestamptz") return this.timestamp(arg);
    if (prefer === "timestamp" && arg.type.type === "date") return this.timestamp(arg);
    return arg;
  }

  /** `DATETIME`: a date at midnight, or a timestamptz in UTC, as a timestamp. */
  private timestamp(arg: Part): Part {
    const text = call("text", arg.expr);
    const expr =
      arg.type.type === "date"
        ? call("to_timestamp", call("concat", text, { lit: " 00:00" }))
        : call("to_timestamp", call("replace", text, { lit: "+00" }, { lit: "" }));
    return this.check(expr, arg.range);
  }

  private call(node: Extract<Syntax, { kind: "call" }>): Part {
    const upper = node.name.toUpperCase();
    const name = upper.toLowerCase();
    const native = (FUNCTIONS as readonly string[]).includes(name) && !OPERATOR_FUNCTIONS.has(name as FunctionName);
    if (!native && !V1_FUNCTIONS.has(upper)) {
      throw new FormulaError("unknown_function", `There is no function ${node.name}.`, node);
    }
    const args = node.args.map((arg) => this.compile(arg));
    const arity = (count: number) => {
      if (args.length !== count) {
        throw new FormulaError("arity", `${upper} takes ${count} argument${count === 1 ? "" : "s"}.`, node);
      }
    };
    const apply = (fn: FunctionName, parts: Part[] = args) => this.apply(fn, this.convert(fn, parts), node);
    switch (upper) {
      case "CEILING":
        return apply("ceil");
      case "LEN":
        return apply("length");
      case "MID":
        return apply("substr");
      case "STARTSWITH":
        return apply("starts_with");
      case "ENDSWITH":
        return apply("ends_with");
      case "WEEKDAY":
        return apply("isodow");
      case "ADDDAYS":
        return apply("add_days");
      case "ISBLANK":
        return apply("is_blank");
      case "DAYS":
        // v1's DAYS(end, start) counts from start to end.
        arity(2);
        return apply("date_diff_days", [args[1], args[0]]);
      case "MIN":
      case "MAX":
        if (args.length === 1) return args[0];
        return apply(upper === "MIN" ? "least" : "greatest");
      case "IF":
        if (args.length === 2) {
          return apply("if", [...args, { expr: { lit: null }, type: { type: "null" }, range: node }]);
        }
        return apply("if");
      case "VALUE":
        arity(1);
        if (NUMBER.has(args[0].type.type)) return args[0];
        return apply("to_number");
      case "DATE": {
        arity(1);
        const arg = args[0];
        if (isStringLiteral(arg)) {
          const date = temporalText(arg.expr.lit, "date");
          if (date !== null) return this.check({ lit: date, type: "date" }, node);
        }
        if (arg.type.type === "date") return arg;
        if (arg.type.type === "timestamp" || arg.type.type === "timestamptz") {
          return this.check(call("to_date", call("left", call("text", arg.expr), { lit: 10 })), node);
        }
        return apply("to_date");
      }
      case "DATETIME": {
        arity(1);
        const arg = args[0];
        if (isStringLiteral(arg)) {
          const timestamp = temporalText(arg.expr.lit, "timestamp");
          if (timestamp !== null) return this.check({ lit: timestamp, type: "timestamp" }, node);
        }
        if (arg.type.type === "timestamp") return arg;
        if (arg.type.type === "date" || arg.type.type === "timestamptz") return { ...this.timestamp(arg), range: node };
        return apply("to_timestamp");
      }
      default:
        return apply(name as FunctionName);
    }
  }
}

/**
 * Compiles a formula over the columns it may use (a view's table columns, then the derived columns before
 * it) and gives its expression and type. Throws a `FormulaError` with the reason of §4.7 and the characters
 * at fault.
 */
export function compileFormula(
  text: string,
  columns: readonly Column[],
  options: CheckOptions = {},
): { expr: Expr; type: ValueType } {
  const part = new Compiler(columns, options).compile(parse(text));
  if (part.type.type === "null") {
    throw new FormulaError("type", "The type of a blank formula cannot be decided: write it as TYPE NULL.", part.range);
  }
  return { expr: part.expr, type: part.type as ValueType };
}

/** The names of the columns a formula uses, in the order written, or an empty list when it does not parse. */
export function formulaColumns(text: string): string[] {
  const names = new Set<string>();
  const visit = (node: Syntax) => {
    if (node.kind === "name") names.add(node.name);
    else if (node.kind === "operator" || node.kind === "call") for (const arg of node.args) visit(arg);
  };
  try {
    visit(parse(text));
  } catch {
    return [];
  }
  return [...names];
}

// ----- writing -----

/** Writes a column name in a formula: as it is when it can be, otherwise in brackets. */
export function formulaReference(name: string): string {
  if (wholeIdentifier.test(name) && !KEYWORDS.has(name.toUpperCase())) return name;
  return `[${name.replaceAll("]", "]]")}]`;
}

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Infix operators (§4.11) by precedence, from the lowest. */
const INFIX: Partial<Record<FunctionName, [string, number]>> = {
  or: [" OR ", 1],
  and: [" AND ", 2],
  eq: [" = ", 4],
  ne: [" <> ", 4],
  lt: [" < ", 4],
  le: [" <= ", 4],
  gt: [" > ", 4],
  ge: [" >= ", 4],
  concat: [" & ", 5],
  add: [" + ", 6],
  sub: [" - ", 6],
  mul: [" * ", 7],
  div: [" / ", 7],
  mod: [" % ", 7],
};

function literalText(value: JsonValue, type: LogicalType | undefined): string {
  if (type === undefined) {
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "string") return quote(value);
    if (Number.isSafeInteger(value)) return String(value);
    const text = String(value);
    // A number with an exponent is a float.
    return /e/i.test(text) ? text : `${text}e0`;
  }
  const name = type.toUpperCase();
  if (value === null) return `${name} NULL`;
  if (type === "decimal" && typeof value === "string" && value.includes(".") && decimalTextType(value)) return value;
  if (type === "bigint" && typeof value === "string" && !Number.isSafeInteger(Number(value))) return value;
  if (type === "float") {
    // A whole float is written with an exponent, which makes a float of it.
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return `${value}e0`;
    const number = typeof value === "number" ? value : value === "NaN" ? Number.NaN : Number(value);
    return `${name} ${quote(floatText(number))}`;
  }
  return `${name} ${quote(String(value))}`;
}

/** Writes an expression as a formula that compiles back to the same expression (§4.11). */
export function formulaText(expr: Expr): string {
  return write(expr, 0);
}

function write(expr: Expr, precedence: number): string {
  if ("col" in expr) return formulaReference(expr.col);
  if ("lit" in expr) return literalText(expr.lit, expr.type);
  if ("search" in expr) throw new TypeError("A search has no formula: it is only in where.");
  const { fn, args } = expr;
  const infix = INFIX[fn];
  let text: string;
  let own: number;
  if (infix && args.length >= 2 && (args.length === 2 || fn === "and" || fn === "or" || fn === "concat")) {
    const [symbol, level] = infix;
    const chained = fn === "and" || fn === "or" || fn === "concat";
    text = args.map((arg, index) => write(arg, index === 0 && !chained ? level : level + 1)).join(symbol);
    own = level;
  } else if (fn === "not") {
    text = `NOT ${write(args[0], 3)}`;
    own = 3;
  } else if (fn === "neg") {
    const operand = args[0];
    text = `-${"lit" in operand ? `(${write(operand, 0)})` : write(operand, 8)}`;
    own = 8;
  } else {
    if (OPERATOR_FUNCTIONS.has(fn)) throw new TypeError(`${fn} takes at least 2 arguments.`);
    return `${fn.toUpperCase()}(${args.map((arg) => write(arg, 0)).join(", ")})`;
  }
  return own < precedence ? `(${text})` : text;
}
