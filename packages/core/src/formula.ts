/**
 * Formula columns (`ViewQuery.formulas`): columns computed row by row from the other columns of the same
 * row, with a small expression language of its own. Expressions are parsed and type-checked here, the same
 * way for every source; sources then evaluate the checked tree (`compileFormulas`), `ArraySource` with
 * `formulaEvaluator` and SQL engines by translating each node. Nothing is evaluated as JavaScript or SQL
 * text.
 *
 * The language:
 * - Columns by name: `price`, or in brackets when the name has other characters, `[unit price]` (`]]` is a
 *   `]` in the name). Formula columns can use other formula columns, but not themselves (no cycles).
 * - Literals: numbers (`12`, `1.5`, `2e3`), text in single or double quotes (`'it''s'`, `"a"`), `TRUE`,
 *   `FALSE` and `NULL`.
 * - Operators, from the lowest precedence: `OR`, `AND`, `NOT`, comparisons (`=`, `<>`, `!=`, `<`, `<=`,
 *   `>`, `>=`), `&` (joins text), `+` `-`, `*` `/` `%`, and the sign `-`.
 * - Functions (`FORMULA_FUNCTIONS`), with case-insensitive names.
 *
 * Values have one of five types: number (64-bit floating point), text, boolean, date and timestamp (date
 * and time without a time zone). Any value can be null (blank). Most operations on null give null;
 * `AND` and `OR` follow SQL (`FALSE AND NULL` is false), `&` and `CONCAT` treat null as empty text, and
 * `IF` takes the second branch when the condition is null. Division by zero, numbers out of range and
 * results that are not finite give null, as do texts that `VALUE`, `DATE` or `DATETIME` cannot read.
 */

import { numericValue, plainText } from "./format.js";
import type { CellValue, ColumnSchema, ColumnType, FormulaColumn } from "./types.js";

/** Most formula columns in one query. */
export const MAX_FORMULAS = 32;
/** Longest expression, in characters. */
export const MAX_FORMULA_LENGTH = 2000;
/** Longest formula column name, in characters. */
export const MAX_FORMULA_NAME_LENGTH = 256;
/** Most nested levels of one expression as written (parentheses, function calls and operators). */
export const MAX_FORMULA_DEPTH = 64;
/**
 * Most operations in one formula once the formula columns it uses are put in place of their names, and
 * most nested levels then (twice `MAX_FORMULA_DEPTH`).
 */
export const MAX_FORMULA_NODES = 1000;

export type FormulaType = "number" | "text" | "boolean" | "date" | "timestamp" | "null";

export type FormulaOperator =
  | "neg"
  | "not"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

/** The functions formulas can call. */
export const FORMULA_FUNCTIONS = [
  "ABS",
  "ROUND",
  "FLOOR",
  "CEILING",
  "SQRT",
  "POWER",
  "EXP",
  "LN",
  "LOG10",
  "MOD",
  "SIGN",
  "MIN",
  "MAX",
  "LEN",
  "LOWER",
  "UPPER",
  "TRIM",
  "LEFT",
  "RIGHT",
  "MID",
  "REPLACE",
  "CONTAINS",
  "STARTSWITH",
  "ENDSWITH",
  "CONCAT",
  "TEXT",
  "VALUE",
  "DATE",
  "DATETIME",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "WEEKDAY",
  "DAYS",
  "ADDDAYS",
  "IF",
  "COALESCE",
  "ISBLANK",
] as const;

export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number];

const functionNames = new Set<string>(FORMULA_FUNCTIONS);
const aliases: Record<string, FormulaFunction> = { CEIL: "CEILING", LENGTH: "LEN" };

/**
 * A checked expression. Columns are schema indexes; formula columns that it uses are already put in place
 * of their names. Conversions that the language makes by itself (text for `&`, a date for a text compared
 * with a date) are explicit `TEXT`, `DATE` and `DATETIME` calls. `type` is the type of the node's values.
 */
export type FormulaExpression =
  | { kind: "literal"; type: FormulaType; value: number | string | boolean | null }
  | { kind: "column"; type: Exclude<FormulaType, "null">; column: number; columnType: ColumnType }
  | { kind: "operator"; type: FormulaType; op: FormulaOperator; args: FormulaExpression[] }
  | { kind: "function"; type: FormulaType; name: FormulaFunction; args: FormulaExpression[] };

export type FormulaErrorCode =
  /** The expression is not written correctly. */
  | "syntax"
  /** No column has this name (`subject`), for example because it was removed. */
  | "unknown_column"
  | "unknown_function"
  /** Too few or too many arguments for the function (`subject`). */
  | "arguments"
  /** A value has a type the operator or function (`subject`) does not take (`expected`, `actual`). */
  | "type"
  /** The formula uses itself, through the formula columns in `subject`. */
  | "circular"
  /** The formula uses a formula column (`subject`) that has an error. */
  | "dependency"
  | "name_empty"
  /** Another column already has the name. */
  | "name_taken"
  | "name_too_long"
  | "too_long"
  | "too_deep"
  /** Too many operations once the formula columns it uses are put in place (`MAX_FORMULA_NODES`). */
  | "too_complex"
  | "too_many";

/** Why a formula cannot be evaluated. `start` and `end` are the characters of the expression it is about. */
export class FormulaError extends Error {
  readonly code: FormulaErrorCode;
  readonly start: number;
  readonly end: number;
  /** The name, function or operator the error is about. */
  readonly subject?: string;
  readonly expected?: FormulaType[];
  readonly actual?: FormulaType;

  constructor(
    code: FormulaErrorCode,
    message: string,
    range: { start: number; end: number } = { start: 0, end: 0 },
    details: { subject?: string; expected?: FormulaType[]; actual?: FormulaType } = {},
  ) {
    super(message);
    this.name = "FormulaError";
    this.code = code;
    this.start = range.start;
    this.end = range.end;
    if (details.subject !== undefined) this.subject = details.subject;
    if (details.expected) this.expected = details.expected;
    if (details.actual) this.actual = details.actual;
  }
}

// ----- syntax -----

/** An expression as written, before names are resolved and types checked. */
export type FormulaSyntax = (
  | { kind: "literal"; value: number | string | boolean | null }
  | { kind: "name"; name: string }
  | { kind: "operator"; op: FormulaOperator; args: FormulaSyntax[] }
  | { kind: "call"; name: string; args: FormulaSyntax[] }
) & { start: number; end: number };

type Token =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "name"; value: string; quoted: boolean; start: number; end: number }
  | { kind: "symbol"; value: string; start: number; end: number }
  | { kind: "end"; start: number; end: number };

const identifier = /[\p{L}\p{Nl}_][\p{L}\p{N}\p{M}_]*/uy;
const numberPattern = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const symbols = ["<=", ">=", "<>", "!=", "==", "+", "-", "*", "/", "%", "&", "=", "<", ">", "(", ")", ","];
const keywords = new Set(["AND", "OR", "NOT", "TRUE", "FALSE", "NULL"]);

function syntaxError(message: string, start: number, end = start + 1) {
  return new FormulaError("syntax", message, { start, end });
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
      let value = "";
      at++;
      for (;;) {
        if (at >= text.length) throw syntaxError("The text is not closed with a quote.", start, text.length);
        if (text[at] === char) {
          if (text[at + 1] === char) {
            value += char;
            at += 2;
            continue;
          }
          at++;
          break;
        }
        value += text[at++];
      }
      tokens.push({ kind: "string", value, start, end: at });
      continue;
    }
    if (char === "[") {
      let value = "";
      at++;
      for (;;) {
        if (at >= text.length) throw syntaxError("The column name is not closed with ].", start, text.length);
        if (text[at] === "]") {
          if (text[at + 1] === "]") {
            value += "]";
            at += 2;
            continue;
          }
          at++;
          break;
        }
        value += text[at++];
      }
      if (value === "") throw syntaxError("The brackets have no column name.", start, at);
      tokens.push({ kind: "name", value, quoted: true, start, end: at });
      continue;
    }
    numberPattern.lastIndex = at;
    const number = numberPattern.exec(text);
    if (number && /[\d.]/.test(char)) {
      at += number[0].length;
      identifier.lastIndex = at;
      if (identifier.test(text) || text[at] === ".") throw syntaxError("This is not a number.", start, at + 1);
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw syntaxError("The number is too large.", start, at);
      tokens.push({ kind: "number", value, start, end: at });
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

const comparisons: Record<string, FormulaOperator> = {
  "=": "=",
  "==": "=",
  "<>": "<>",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

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

  private word(value: string) {
    if (keyword(this.token) === value) {
      this.at++;
      return true;
    }
    return false;
  }

  private enter(start: number) {
    if (++this.depth > MAX_FORMULA_DEPTH) {
      throw new FormulaError("too_deep", `The formula nests more than ${MAX_FORMULA_DEPTH} levels.`, {
        start,
        end: start + 1,
      });
    }
  }

  private node(
    kind: "operator",
    op: FormulaOperator,
    args: FormulaSyntax[],
    start: number,
    end: number,
  ): FormulaSyntax {
    return { kind, op, args, start, end };
  }

  parse(): FormulaSyntax {
    const tree = this.or();
    if (this.token.kind !== "end") throw this.unexpected();
    return tree;
  }

  private unexpected() {
    const token = this.token;
    if (token.kind === "end") return syntaxError("The formula ends too early.", token.start);
    return syntaxError("Unexpected text here.", token.start, token.end);
  }

  private binary(next: () => FormulaSyntax, operators: (token: Token) => FormulaOperator | null) {
    const start = this.token.start;
    let left = next();
    let levels = 0;
    for (;;) {
      const op = operators(this.token);
      if (!op) break;
      this.at++;
      // Each operator of a chain nests the tree one level deeper.
      this.enter(start);
      levels++;
      const right = next();
      left = this.node("operator", op, [left, right], left.start, right.end);
    }
    this.depth -= levels;
    return left;
  }

  private or(): FormulaSyntax {
    return this.binary(
      () => this.and(),
      (token) => (keyword(token) === "OR" ? "or" : null),
    );
  }

  private and(): FormulaSyntax {
    return this.binary(
      () => this.not(),
      (token) => (keyword(token) === "AND" ? "and" : null),
    );
  }

  private not(): FormulaSyntax {
    const start = this.token.start;
    if (this.word("NOT")) {
      this.enter(start);
      const operand = this.not();
      this.depth--;
      return this.node("operator", "not", [operand], start, operand.end);
    }
    return this.comparison();
  }

  private comparison(): FormulaSyntax {
    return this.binary(
      () => this.concat(),
      (token) => (token.kind === "symbol" ? (comparisons[token.value] ?? null) : null),
    );
  }

  private concat(): FormulaSyntax {
    return this.binary(
      () => this.additive(),
      (token) => (token.kind === "symbol" && token.value === "&" ? "&" : null),
    );
  }

  private additive(): FormulaSyntax {
    return this.binary(
      () => this.multiplicative(),
      (token) => (token.kind === "symbol" && (token.value === "+" || token.value === "-") ? token.value : null),
    );
  }

  private multiplicative(): FormulaSyntax {
    return this.binary(
      () => this.unary(),
      (token) =>
        token.kind === "symbol" && (token.value === "*" || token.value === "/" || token.value === "%")
          ? (token.value as FormulaOperator)
          : null,
    );
  }

  private unary(): FormulaSyntax {
    const start = this.token.start;
    if (this.symbol("-")) {
      this.enter(start);
      const operand = this.unary();
      this.depth--;
      // A negative number is a literal.
      if (operand.kind === "literal" && typeof operand.value === "number") {
        return { kind: "literal", value: -operand.value, start, end: operand.end };
      }
      return this.node("operator", "neg", [operand], start, operand.end);
    }
    return this.primary();
  }

  private primary(): FormulaSyntax {
    const token = this.token;
    switch (token.kind) {
      case "number":
      case "string":
        this.at++;
        return { kind: "literal", value: token.value, start: token.start, end: token.end };
      case "name": {
        this.at++;
        const word = keyword(token);
        if (word === "TRUE" || word === "FALSE") {
          return { kind: "literal", value: word === "TRUE", start: token.start, end: token.end };
        }
        if (word === "NULL") return { kind: "literal", value: null, start: token.start, end: token.end };
        if (word && keywords.has(word)) {
          this.at--;
          throw this.unexpected();
        }
        if (!token.quoted && this.symbol("(")) {
          this.enter(token.start);
          const args: FormulaSyntax[] = [];
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
          return { ...inner, start: token.start, end: this.tokens[this.at - 1].end };
        }
        throw this.unexpected();
      default:
        throw this.unexpected();
    }
  }
}

/** Parses an expression. Throws `FormulaError` (`syntax`, `too_long`, `too_deep`). */
export function parseFormula(expression: string): FormulaSyntax {
  if (expression.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError("too_long", `A formula has at most ${MAX_FORMULA_LENGTH} characters.`, {
      start: MAX_FORMULA_LENGTH,
      end: expression.length,
    });
  }
  if (!expression.trim()) throw syntaxError("The formula is empty.", 0, 0);
  return new Parser(tokenize(expression)).parse();
}

// ----- types -----

/** The type that a column's values have in formulas. */
export function formulaTypeOf(type: ColumnType): Exclude<FormulaType, "null"> {
  switch (type) {
    case "integer":
    case "bigint":
    case "float":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "timestamp":
    case "timestamptz":
      return "timestamp";
    default:
      return "text";
  }
}

/** The column type of a formula's results. */
export function formulaColumnType(type: FormulaType): ColumnType {
  switch (type) {
    case "number":
      return "float";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "timestamp":
      return "timestamp";
    default:
      return "string";
  }
}

/** Whether a column node holds numbers whose text is exact (integers and decimals, not floating point). */
export function isExactNumberColumn(node: FormulaExpression) {
  return (
    node.kind === "column" &&
    (node.columnType === "integer" || node.columnType === "bigint" || node.columnType === "decimal")
  );
}

type Range = { start: number; end: number };

function typeError(subject: string, expected: FormulaType[], actual: FormulaType, range: Range) {
  return new FormulaError(
    "type",
    `${subject} takes ${expected.join(" or ")}, not ${actual === "null" ? "a blank" : actual}.`,
    range,
    { subject, expected, actual },
  );
}

function literal(type: FormulaType, value: number | string | boolean | null): FormulaExpression {
  return { kind: "literal", type, value };
}

function call(name: FormulaFunction, args: FormulaExpression[], type: FormulaType): FormulaExpression {
  return { kind: "function", name, args, type };
}

/** A checked argument with its place in the expression, for errors. */
interface Argument {
  node: FormulaExpression;
  range: Range;
}

/** Converts an argument to `type` (a blank takes the type), or throws a type error. */
function expect(argument: Argument, types: FormulaType[], subject: string): FormulaExpression {
  const node = argument.node;
  // An expression of no type is always blank.
  if (node.type === "null") return literal(types[0], null);
  if (types.includes(node.type)) return node;
  // A text literal is read as a date or timestamp where one is taken.
  if (node.kind === "literal" && node.type === "text" && (types.includes("date") || types.includes("timestamp"))) {
    return temporalLiteral(argument, types.includes("date") ? "date" : "timestamp", subject);
  }
  // Dates count as timestamps at midnight where only timestamps are taken.
  if (node.type === "date" && types.includes("timestamp")) return call("DATETIME", [node], "timestamp");
  throw typeError(subject, types, node.type, argument.range);
}

/** Text of any value, for `&`, `CONCAT` and `TEXT`. */
function toText(node: FormulaExpression): FormulaExpression {
  if (node.type === "text") return node;
  if (node.type === "null") return literal("text", null);
  return call("TEXT", [node], "text");
}

/** Gives values the same type: numbers, texts, booleans, or dates and timestamps (as timestamps). */
function unify(arguments_: Argument[], subject: string, allowed: FormulaType[]): FormulaExpression[] {
  const types = new Set(arguments_.map((item) => item.node.type).filter((type) => type !== "null"));
  let type: FormulaType = "null";
  if (types.size === 1) type = [...types][0];
  else if (types.size === 2 && types.has("date") && types.has("timestamp")) type = "timestamp";
  else if (types.size > 1) {
    const first = arguments_.find((item) => item.node.type !== "null") as Argument;
    const other = arguments_.find((item) => item.node.type !== "null" && item.node.type !== first.node.type);
    throw typeError(subject, [first.node.type], (other as Argument).node.type, (other as Argument).range);
  }
  if (type === "null") return arguments_.map((item) => item.node);
  if (!allowed.includes(type)) {
    const bad = arguments_.find((item) => item.node.type !== "null") as Argument;
    throw typeError(subject, allowed, bad.node.type, bad.range);
  }
  return arguments_.map((item) => expect(item, [type], subject));
}

const datePattern =
  /^ *([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[ T]([01]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,6}))?)?)? *$/;

/**
 * The text that `DATE` and `DATETIME` read: `YYYY-MM-DD`, optionally followed by a space or `T` and
 * `HH:MM`, `HH:MM:SS` or `HH:MM:SS.ffffff`, with spaces around. SQL engines check text with this pattern
 * (in RE2 and JavaScript syntax); its one group is the text without the spaces.
 */
export const FORMULA_DATE_PATTERN =
  "^ *([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[ T](?:[01]?[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,6})?)?)?) *$";

/** Converts a text literal compared with a date or timestamp; a text that is not one is a type error. */
function temporalLiteral(argument: Argument, type: "date" | "timestamp", subject: string): FormulaExpression {
  const node = argument.node;
  if (node.kind !== "literal" || typeof node.value !== "string")
    throw typeError(subject, [type], "text", argument.range);
  const value = type === "date" ? parseDate(node.value) : parseTimestamp(node.value);
  if (value === null) throw typeError(subject, [type], "text", argument.range);
  return call(type === "date" ? "DATE" : "DATETIME", [node], type);
}

function checkOperator(op: FormulaOperator, args: Argument[]): FormulaExpression {
  const subject = op === "neg" ? "-" : op.toUpperCase();
  switch (op) {
    case "neg":
      return { kind: "operator", op, args: [expect(args[0], ["number"], subject)], type: "number" };
    case "not":
      return { kind: "operator", op, args: [expect(args[0], ["boolean"], subject)], type: "boolean" };
    case "and":
    case "or":
      return { kind: "operator", op, args: args.map((item) => expect(item, ["boolean"], subject)), type: "boolean" };
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
      return { kind: "operator", op, args: args.map((item) => expect(item, ["number"], subject)), type: "number" };
    case "&":
      return { kind: "operator", op, args: args.map((item) => toText(item.node)), type: "text" };
    default: {
      // A text literal compared with a date or a timestamp is read as one.
      const temporal = args.find((item) => item.node.type === "date" || item.node.type === "timestamp");
      const converted = args.map((item) =>
        temporal && item.node.type === "text"
          ? { ...item, node: temporalLiteral(item, temporal.node.type as "date" | "timestamp", subject) }
          : item,
      );
      const unified = unify(converted, subject, ["number", "text", "boolean", "date", "timestamp"]);
      return { kind: "operator", op, args: unified, type: "boolean" };
    }
  }
}

const arity: Record<FormulaFunction, [number, number]> = {
  ABS: [1, 1],
  ROUND: [1, 2],
  FLOOR: [1, 1],
  CEILING: [1, 1],
  SQRT: [1, 1],
  POWER: [2, 2],
  EXP: [1, 1],
  LN: [1, 1],
  LOG10: [1, 1],
  MOD: [2, 2],
  SIGN: [1, 1],
  MIN: [1, 32],
  MAX: [1, 32],
  LEN: [1, 1],
  LOWER: [1, 1],
  UPPER: [1, 1],
  TRIM: [1, 1],
  LEFT: [2, 2],
  RIGHT: [2, 2],
  MID: [3, 3],
  REPLACE: [3, 3],
  CONTAINS: [2, 2],
  STARTSWITH: [2, 2],
  ENDSWITH: [2, 2],
  CONCAT: [1, 32],
  TEXT: [1, 1],
  VALUE: [1, 1],
  DATE: [1, 1],
  DATETIME: [1, 1],
  YEAR: [1, 1],
  MONTH: [1, 1],
  DAY: [1, 1],
  HOUR: [1, 1],
  MINUTE: [1, 1],
  SECOND: [1, 1],
  WEEKDAY: [1, 1],
  DAYS: [2, 2],
  ADDDAYS: [2, 2],
  IF: [2, 3],
  COALESCE: [1, 32],
  ISBLANK: [1, 1],
};

function checkFunction(name: FormulaFunction, args: Argument[], range: Range): FormulaExpression {
  const [min, max] = arity[name];
  if (args.length < min || args.length > max) {
    const count = min === max ? `${min}` : max >= 32 ? `at least ${min}` : `${min} to ${max}`;
    throw new FormulaError("arguments", `${name} takes ${count} argument${max === 1 ? "" : "s"}.`, range, {
      subject: name,
    });
  }
  const numbers = () => args.map((item) => expect(item, ["number"], name));
  switch (name) {
    case "ABS":
    case "ROUND":
    case "FLOOR":
    case "CEILING":
    case "SQRT":
    case "POWER":
    case "EXP":
    case "LN":
    case "LOG10":
    case "MOD":
    case "SIGN":
      return call(name, numbers(), "number");
    case "MIN":
    case "MAX": {
      const unified = unify(args, name, ["number", "text", "date", "timestamp"]);
      return call(name, unified, unified.find((item) => item.type !== "null")?.type ?? "null");
    }
    case "LEN":
      return call(name, [expect(args[0], ["text"], name)], "number");
    case "LOWER":
    case "UPPER":
    case "TRIM":
      return call(name, [expect(args[0], ["text"], name)], "text");
    case "LEFT":
    case "RIGHT":
      return call(name, [expect(args[0], ["text"], name), expect(args[1], ["number"], name)], "text");
    case "MID":
      return call(
        name,
        [expect(args[0], ["text"], name), expect(args[1], ["number"], name), expect(args[2], ["number"], name)],
        "text",
      );
    case "REPLACE":
      return call(
        name,
        args.map((item) => expect(item, ["text"], name)),
        "text",
      );
    case "CONTAINS":
    case "STARTSWITH":
    case "ENDSWITH":
      return call(
        name,
        args.map((item) => expect(item, ["text"], name)),
        "boolean",
      );
    case "CONCAT":
      return call(
        name,
        args.map((item) => toText(item.node)),
        "text",
      );
    case "TEXT":
      return toText(args[0].node);
    case "VALUE": {
      const node = expect(args[0], ["text", "number"], name);
      return node.type === "number" ? node : call(name, [node], "number");
    }
    case "DATE": {
      const node = expect(args[0], ["text", "date", "timestamp"], name);
      return node.type === "date" ? node : call(name, [node], "date");
    }
    case "DATETIME": {
      const node = expect(args[0], ["text", "date", "timestamp"], name);
      return node.type === "timestamp" ? node : call(name, [node], "timestamp");
    }
    case "YEAR":
    case "MONTH":
    case "DAY":
    case "WEEKDAY":
      return call(name, [expect(args[0], ["date", "timestamp"], name)], "number");
    case "HOUR":
    case "MINUTE":
    case "SECOND":
      return call(name, [expect(args[0], ["timestamp"], name)], "number");
    case "DAYS":
      return call(
        name,
        args.map((item) => {
          const node = expect(item, ["date", "timestamp"], name);
          return node.type === "timestamp" ? call("DATE", [node], "date") : node;
        }),
        "number",
      );
    case "ADDDAYS": {
      const node = expect(args[0], ["date", "timestamp"], name);
      return call(name, [node, expect(args[1], ["number"], name)], node.type === "null" ? "date" : node.type);
    }
    case "IF": {
      const condition = expect(args[0], ["boolean"], name);
      const branches = unify(
        args.length === 3 ? args.slice(1) : [args[1], { node: literal("null", null), range }],
        name,
        ["number", "text", "boolean", "date", "timestamp"],
      );
      return call(name, [condition, ...branches], branches.find((item) => item.type !== "null")?.type ?? "null");
    }
    case "COALESCE": {
      const unified = unify(args, name, ["number", "text", "boolean", "date", "timestamp"]);
      return call(name, unified, unified.find((item) => item.type !== "null")?.type ?? "null");
    }
    case "ISBLANK":
      return call(name, [args[0].node], "boolean");
  }
}

/** Operations in a tree, counting formula columns that it uses once per use, and its depth. */
function measure(node: FormulaExpression): { nodes: number; depth: number } {
  if (node.kind === "literal" || node.kind === "column") return { nodes: 1, depth: 1 };
  let nodes = 1;
  let depth = 0;
  for (const arg of node.args) {
    const size = measure(arg);
    nodes += size.nodes;
    depth = Math.max(depth, size.depth);
    if (nodes > MAX_FORMULA_NODES) break;
  }
  return { nodes, depth: depth + 1 };
}

export interface CompiledFormula {
  name: string;
  expression: string;
  /** The column type of its values (`formulaColumnType`); `string` for a formula with an error. */
  type: ColumnType;
  /** The checked expression, or null when the formula has an error. */
  tree: FormulaExpression | null;
  error: FormulaError | null;
}

function collectNames(node: FormulaSyntax, names: FormulaSyntax[]) {
  if (node.kind === "name") names.push(node);
  else if (node.kind === "operator" || node.kind === "call") for (const arg of node.args) collectNames(arg, names);
}

/**
 * Checks formula columns over a table's columns: parses each expression, resolves the names it uses (a
 * table column, or another formula of the list), checks the types and finds cycles. Every formula gets a
 * result, in the order given; a formula with an error has `error` and no `tree`, and so has every formula
 * that uses it. Formula `i` is column `columns.length + i` of a view with these formulas.
 */
export function compileFormulas(
  columns: readonly ColumnSchema[],
  formulas: readonly FormulaColumn[],
): CompiledFormula[] {
  const tableNames = new Map<string, number>();
  columns.forEach((column, index) => {
    if (!tableNames.has(column.name)) tableNames.set(column.name, index);
  });
  const formulaNames = new Map<string, number>();
  const parsed = formulas.map((formula, index): { syntax: FormulaSyntax | null; error: FormulaError | null } => {
    const name = formula.name;
    if (index >= MAX_FORMULAS) {
      return { syntax: null, error: new FormulaError("too_many", `A query has at most ${MAX_FORMULAS} formulas.`) };
    }
    if (!name.trim()) return { syntax: null, error: new FormulaError("name_empty", "The column needs a name.") };
    if (name.length > MAX_FORMULA_NAME_LENGTH) {
      return {
        syntax: null,
        error: new FormulaError("name_too_long", `A name has at most ${MAX_FORMULA_NAME_LENGTH} characters.`),
      };
    }
    if (tableNames.has(name) || formulaNames.has(name)) {
      return {
        syntax: null,
        error: new FormulaError("name_taken", `Another column is named "${name}".`, undefined, { subject: name }),
      };
    }
    formulaNames.set(name, index);
    try {
      return { syntax: parseFormula(formula.expression), error: null };
    } catch (error) {
      if (error instanceof FormulaError) return { syntax: null, error };
      throw error;
    }
  });

  const results: (CompiledFormula | undefined)[] = new Array(formulas.length);
  const stack: number[] = [];

  const resolve = (index: number): CompiledFormula => {
    const done = results[index];
    if (done) return done;
    const formula = formulas[index];
    const entry = parsed[index];
    const fail = (error: FormulaError): CompiledFormula => {
      const result = {
        name: formula.name,
        expression: formula.expression,
        type: "string" as ColumnType,
        tree: null,
        error,
      };
      results[index] = result;
      return result;
    };
    if (!entry.syntax) return fail(entry.error as FormulaError);
    stack.push(index);
    try {
      const check = (node: FormulaSyntax): FormulaExpression => {
        switch (node.kind) {
          case "literal": {
            const value = node.value;
            const type: FormulaType =
              value === null
                ? "null"
                : typeof value === "number"
                  ? "number"
                  : typeof value === "string"
                    ? "text"
                    : "boolean";
            return literal(type, value);
          }
          case "name": {
            const column = tableNames.get(node.name);
            if (column !== undefined) {
              const columnType = columns[column].type;
              return { kind: "column", column, columnType, type: formulaTypeOf(columnType) };
            }
            const other = formulaNames.get(node.name);
            if (other === undefined) {
              throw new FormulaError("unknown_column", `No column is named "${node.name}".`, node, {
                subject: node.name,
              });
            }
            const cycle = stack.indexOf(other);
            if (cycle >= 0) {
              const names = [...stack.slice(cycle), other].map((item) => formulas[item].name);
              throw new FormulaError("circular", `The formula uses itself: ${names.join(" → ")}.`, node, {
                subject: names.join(" → "),
              });
            }
            const used = resolve(other);
            if (!used.tree) {
              // Every formula on a cycle reports the cycle.
              const cycleNames = used.error?.code === "circular" ? (used.error.subject ?? "").split(" → ") : [];
              if (cycleNames.includes(formula.name)) {
                throw new FormulaError("circular", (used.error as FormulaError).message, node, {
                  subject: used.error?.subject,
                });
              }
              throw new FormulaError("dependency", `The formula column "${node.name}" has an error.`, node, {
                subject: node.name,
              });
            }
            return used.tree;
          }
          case "operator":
            return checkOperator(
              node.op,
              node.args.map((arg) => ({ node: check(arg), range: arg })),
            );
          case "call": {
            const upper = node.name.toUpperCase();
            const name = (aliases[upper] ?? upper) as FormulaFunction;
            if (!functionNames.has(name)) {
              throw new FormulaError("unknown_function", `There is no function ${node.name}.`, node, {
                subject: node.name,
              });
            }
            return checkFunction(
              name,
              node.args.map((arg) => ({ node: check(arg), range: arg })),
              node,
            );
          }
        }
      };
      const tree = check(entry.syntax);
      const size = measure(tree);
      if (size.nodes > MAX_FORMULA_NODES || size.depth > 2 * MAX_FORMULA_DEPTH) {
        return fail(
          new FormulaError(
            "too_complex",
            `With the formula columns it uses, the formula has more than ${MAX_FORMULA_NODES} operations.`,
            { start: 0, end: formula.expression.length },
          ),
        );
      }
      const result: CompiledFormula = {
        name: formula.name,
        expression: formula.expression,
        type: formulaColumnType(tree.type),
        tree,
        error: null,
      };
      results[index] = result;
      return result;
    } catch (error) {
      if (error instanceof FormulaError) {
        // A cycle is an error of every formula on it, reported where each one uses the next.
        return fail(error);
      }
      throw error;
    } finally {
      stack.pop();
    }
  };

  return formulas.map((_, index) => resolve(index));
}

/** The names a formula uses (columns and formula columns), or an empty list when it cannot be parsed. */
export function formulaNames(expression: string): string[] {
  try {
    const names: FormulaSyntax[] = [];
    collectNames(parseFormula(expression), names);
    return [...new Set(names.map((node) => (node as { name: string }).name))];
  } catch {
    return [];
  }
}

/** Writes a column name for a formula: as it is when it can be, otherwise in brackets. */
export function formulaReference(name: string) {
  identifier.lastIndex = 0;
  const match = identifier.exec(name);
  if (match && match[0] === name && !keywords.has(name.toUpperCase())) return name;
  return `[${name.replaceAll("]", "]]")}]`;
}

// ----- evaluation -----

const MICROS_PER_DAY = 86_400_000_000;

/** Days since 1970-01-01 of a date in the proleptic Gregorian calendar. */
function daysFromCivil(year: number, month: number, day: number) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function validDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= length;
}

/** Microseconds since midnight of a matched time, or 0 without one. */
function timeOf(match: RegExpExecArray) {
  if (match[4] === undefined) return 0;
  const fraction = match[7] ? Number(match[7].padEnd(6, "0")) : 0;
  return ((Number(match[4]) * 60 + Number(match[5])) * 60 + Number(match[6] ?? 0)) * 1_000_000 + fraction;
}

/** Days since 1970-01-01 of a text that `DATE` reads (see `FORMULA_DATE_PATTERN`), or null. */
function parseDate(text: string): number | null {
  const match = datePattern.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return validDate(year, month, day) ? daysFromCivil(year, month, day) : null;
}

/** Microseconds since 1970-01-01 00:00 of a text that `DATETIME` reads, or null. */
function parseTimestamp(text: string): number | null {
  const match = datePattern.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(year, month, day)) return null;
  return daysFromCivil(year, month, day) * MICROS_PER_DAY + timeOf(match);
}

const cellTimestamp =
  /^ *([0-9]{4,})-([0-9]{1,2})-([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?)? *(Z|[+-][0-9]{2}(?::?[0-9]{2})?)? *$/i;

/**
 * A date or timestamp cell value (ISO-like text) as days or microseconds. `zone`: apply the value's offset
 * (`timestamptz` values count in UTC); otherwise an offset is ignored, as SQL does for timestamps.
 */
function cellTemporal(value: CellValue, unit: "days" | "micros", zone: boolean): number | null {
  if (typeof value !== "string") return null;
  const match = cellTimestamp.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(year, month, day)) return null;
  const fraction = match[7] ? Number(match[7].slice(0, 6).padEnd(6, "0")) : 0;
  let micros =
    daysFromCivil(year, month, day) * MICROS_PER_DAY +
    (match[4] === undefined
      ? 0
      : ((Number(match[4]) * 60 + Number(match[5])) * 60 + Number(match[6] ?? 0)) * 1_000_000 + fraction);
  const offset = match[8];
  if (zone && offset && offset.toUpperCase() !== "Z") {
    const digits = offset.replace(":", "");
    const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0);
    micros -= (offset[0] === "-" ? -1 : 1) * minutes * 60_000_000;
  }
  return unit === "days" ? Math.floor(micros / MICROS_PER_DAY) : micros;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function dateText(days: number) {
  const [year, month, day] = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function timestampText(micros: number) {
  const days = Math.floor(micros / MICROS_PER_DAY);
  let rest = micros - days * MICROS_PER_DAY;
  const fraction = rest % 1_000_000;
  rest = (rest - fraction) / 1_000_000;
  const time = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}`;
  const digits = fraction === 0 ? "" : `.${pad(fraction, 6).replace(/0+$/, "")}`;
  return `${dateText(days)} ${time}${digits}`;
}

/**
 * The text of a number: the shortest digits that read back as the same number, without a fraction for
 * whole numbers, and with an exponent (`1.5e-05`, `1e+16`) below 0.0001 or from 10^16 on.
 */
export function formulaNumberText(value: number) {
  if (Object.is(value, -0)) return "-0";
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    return `${mantissa}e${exponent < 0 ? "-" : "+"}${pad(Math.abs(exponent))}`;
  }
  return String(value);
}

const numberText =
  /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** An integer argument (truncated toward zero), or null when it is blank or out of the 64-bit range. */
function integer(value: number | null): number | null {
  if (value === null) return null;
  const truncated = Math.trunc(value);
  return Math.abs(truncated) >= 2 ** 63 ? null : truncated;
}

/** Like SQL `greatest(value, low)`, which skips a blank. */
function atLeast(value: number | null, low: number) {
  return value === null ? low : Math.max(value, low);
}

function roundAway(value: number) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

function round(value: number, digits: number) {
  if (digits >= 0) {
    const modifier = Number(`1e${digits}`);
    const rounded = roundAway(value * modifier) / modifier;
    return Number.isFinite(rounded) ? rounded : value;
  }
  const modifier = Number(`1e${-digits}`);
  const rounded = roundAway(value / modifier) * modifier;
  return Number.isFinite(rounded) ? rounded : 0;
}

/** Compares texts by code point, which is the order of their UTF-8 bytes. */
function compareText(a: string, b: string) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a.codePointAt(index) as number;
    const right = b.codePointAt(index) as number;
    if (left !== right) return left < right ? -1 : 1;
    if (left > 0xffff) index++;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compare(a: number | string | boolean, b: number | string | boolean) {
  if (typeof a === "string") return compareText(a, b as string);
  return a < b ? -1 : a > b ? 1 : 0;
}

type Value = number | string | boolean | null;
type Read = (column: number) => CellValue;
type Evaluate = (read: Read) => Value;

const chars = (text: string) => Array.from(text);

function compileNode(node: FormulaExpression): Evaluate {
  switch (node.kind) {
    case "literal": {
      const value = node.value;
      return () => value;
    }
    case "column": {
      const { column, columnType } = node;
      switch (node.type) {
        case "number":
          return (read) => numericValue(read(column), columnType);
        case "boolean":
          return (read) => {
            const value = read(column);
            return typeof value === "boolean" ? value : null;
          };
        case "date":
          return (read) => cellTemporal(read(column), "days", false);
        case "timestamp": {
          const zone = columnType === "timestamptz";
          return (read) => cellTemporal(read(column), "micros", zone);
        }
        default:
          return (read) => {
            const value = read(column);
            return value === null ? null : plainText(value);
          };
      }
    }
    case "operator":
      return operator(node.op, node.args.map(compileNode));
    case "function":
      return fn(node, node.args.map(compileNode));
  }
}

function operator(op: FormulaOperator, args: Evaluate[]): Evaluate {
  const [a, b] = args;
  const numbers = (apply: (x: number, y: number) => number | null): Evaluate => {
    return (read) => {
      const x = a(read);
      if (x === null) return null;
      const y = b(read);
      return y === null ? null : apply(x as number, y as number);
    };
  };
  switch (op) {
    case "neg":
      return (read) => {
        const x = a(read);
        return x === null ? null : -(x as number);
      };
    case "not":
      return (read) => {
        const x = a(read);
        return x === null ? null : !x;
      };
    case "and":
      return (read) => {
        const x = a(read);
        if (x === false) return false;
        const y = b(read);
        if (y === false) return false;
        return x === null || y === null ? null : true;
      };
    case "or":
      return (read) => {
        const x = a(read);
        if (x === true) return true;
        const y = b(read);
        if (y === true) return true;
        return x === null || y === null ? null : false;
      };
    case "+":
      return numbers((x, y) => finite(x + y));
    case "-":
      return numbers((x, y) => finite(x - y));
    case "*":
      return numbers((x, y) => finite(x * y));
    case "/":
      return numbers((x, y) => (y === 0 ? null : finite(x / y)));
    case "%":
      return numbers((x, y) => (y === 0 ? null : finite(x % y)));
    case "&":
      return (read) => `${a(read) ?? ""}${b(read) ?? ""}`;
    default: {
      const test = {
        "=": (order: number) => order === 0,
        "<>": (order: number) => order !== 0,
        "<": (order: number) => order < 0,
        "<=": (order: number) => order <= 0,
        ">": (order: number) => order > 0,
        ">=": (order: number) => order >= 0,
      }[op];
      return (read) => {
        const x = a(read);
        if (x === null) return null;
        const y = b(read);
        return y === null ? null : test(compare(x, y));
      };
    }
  }
}

function fn(node: Extract<FormulaExpression, { kind: "function" }>, args: Evaluate[]): Evaluate {
  const [a, b, c] = args;
  const unaryNumber = (apply: (x: number) => Value): Evaluate => {
    return (read) => {
      const x = a(read);
      return x === null ? null : apply(x as number);
    };
  };
  const unaryText = (apply: (x: string) => Value): Evaluate => {
    return (read) => {
      const x = a(read);
      return x === null ? null : apply(x as string);
    };
  };
  const all = (read: Read) => args.map((arg) => arg(read));
  switch (node.name) {
    case "ABS":
      return unaryNumber(Math.abs);
    case "ROUND":
      return (read) => {
        const x = a(read);
        if (x === null) return null;
        if (!b) return round(x as number, 0);
        const digits = integer(b(read) as number | null);
        return digits === null || Math.abs(digits) >= 2 ** 31 ? null : round(x as number, digits);
      };
    case "FLOOR":
      return unaryNumber(Math.floor);
    case "CEILING":
      return unaryNumber(Math.ceil);
    case "SQRT":
      return unaryNumber((x) => (x < 0 ? null : Math.sqrt(x)));
    case "EXP":
      return unaryNumber((x) => finite(Math.exp(x)));
    case "LN":
      return unaryNumber((x) => (x <= 0 ? null : Math.log(x)));
    case "LOG10":
      return unaryNumber((x) => (x <= 0 ? null : Math.log10(x)));
    case "SIGN":
      return unaryNumber((x) => (x > 0 ? 1 : x < 0 ? -1 : 0));
    case "POWER":
    case "MOD":
      return (read) => {
        const x = a(read);
        const y = b(read);
        if (x === null || y === null) return null;
        if (node.name === "MOD") return y === 0 ? null : finite((x as number) % (y as number));
        return finite((x as number) ** (y as number));
      };
    case "MIN":
    case "MAX":
      return (read) => {
        let best: Value = null;
        for (const value of all(read)) {
          if (value === null) continue;
          if (best === null || compare(value, best) < 0 === (node.name === "MIN")) best = value;
        }
        return best;
      };
    case "LEN":
      return unaryText((x) => chars(x).length);
    case "LOWER":
      return unaryText((x) => x.toLowerCase());
    case "UPPER":
      return unaryText((x) => x.toUpperCase());
    case "TRIM":
      return unaryText((x) => x.replace(/^ +| +$/g, ""));
    case "LEFT":
    case "RIGHT":
      return (read) => {
        const x = a(read);
        if (x === null) return null;
        const count = atLeast(integer(b(read) as number | null), 0);
        if (count === 0) return "";
        const list = chars(x as string);
        return (node.name === "LEFT" ? list.slice(0, count) : list.slice(Math.max(0, list.length - count))).join("");
      };
    case "MID":
      return (read) => {
        const x = a(read);
        if (x === null) return null;
        const start = atLeast(integer(b(read) as number | null), 1);
        const length = atLeast(integer(c(read) as number | null), 0);
        return chars(x as string)
          .slice(start - 1, start - 1 + length)
          .join("");
      };
    case "REPLACE":
      return (read) => {
        const [x, from, to] = all(read) as (string | null)[];
        if (x === null || from === null || to === null) return null;
        return from === "" ? x : x.split(from).join(to);
      };
    case "CONTAINS":
    case "STARTSWITH":
    case "ENDSWITH":
      return (read) => {
        const x = a(read) as string | null;
        const y = b(read) as string | null;
        if (x === null || y === null) return null;
        return node.name === "CONTAINS" ? x.includes(y) : node.name === "STARTSWITH" ? x.startsWith(y) : x.endsWith(y);
      };
    case "CONCAT":
      return (read) => all(read).join("");
    case "TEXT": {
      const arg = node.args[0];
      const exact = isExactNumberColumn(arg);
      const column = arg.kind === "column" ? arg.column : -1;
      switch (arg.type) {
        case "number":
          // Integers and decimals of a column keep their digits.
          return exact
            ? (read) => {
                const value = read(column);
                return value === null || numericValue(value, (arg as { columnType: ColumnType }).columnType) === null
                  ? null
                  : plainText(value);
              }
            : unaryNumber(formulaNumberText);
        case "boolean":
          return (read) => {
            const x = a(read);
            return x === null ? null : x ? "TRUE" : "FALSE";
          };
        case "date":
          return unaryNumber(dateText);
        case "timestamp":
          return unaryNumber(timestampText);
        default:
          return a;
      }
    }
    case "VALUE":
      return unaryText((x) => (numberText.test(x) ? finite(Number(x.trim().replaceAll("_", ""))) : null));
    case "DATE":
      if (node.args[0].type === "text") return unaryText(parseDate);
      return unaryNumber((x) => Math.floor(x / MICROS_PER_DAY));
    case "DATETIME":
      if (node.args[0].type === "text") return unaryText(parseTimestamp);
      return unaryNumber((x) => x * MICROS_PER_DAY);
    case "YEAR":
    case "MONTH":
    case "DAY":
    case "WEEKDAY": {
      const days = node.args[0].type === "timestamp" ? (x: number) => Math.floor(x / MICROS_PER_DAY) : (x: number) => x;
      return unaryNumber((x) => {
        const day = days(x);
        if (node.name === "WEEKDAY") return ((((day + 3) % 7) + 7) % 7) + 1;
        const parts = civilFromDays(day);
        return parts[node.name === "YEAR" ? 0 : node.name === "MONTH" ? 1 : 2];
      });
    }
    case "HOUR":
    case "MINUTE":
    case "SECOND":
      return unaryNumber((x) => {
        const seconds = Math.floor((x - Math.floor(x / MICROS_PER_DAY) * MICROS_PER_DAY) / 1_000_000);
        if (node.name === "HOUR") return Math.floor(seconds / 3600);
        if (node.name === "MINUTE") return Math.floor(seconds / 60) % 60;
        return seconds % 60;
      });
    case "DAYS":
      return (read) => {
        const x = a(read);
        const y = b(read);
        return x === null || y === null ? null : (x as number) - (y as number);
      };
    case "ADDDAYS":
      return (read) => {
        const x = a(read);
        const days = integer(b(read) as number | null);
        if (x === null || days === null || Math.abs(days) >= 2 ** 31) return null;
        return node.type === "timestamp" ? (x as number) + days * MICROS_PER_DAY : (x as number) + days;
      };
    case "IF":
      return (read) => (a(read) === true ? b(read) : c ? c(read) : null);
    case "COALESCE":
      return (read) => {
        for (const arg of args) {
          const value = arg(read);
          if (value !== null) return value;
        }
        return null;
      };
    case "ISBLANK":
      return (read) => {
        const x = a(read);
        return x === null || x === "";
      };
  }
}

/**
 * Evaluates a checked formula (`CompiledFormula.tree`) for one row: `read` gives the row's value of a
 * schema column. Values are returned as the grid receives them from sources: numbers (finite), text,
 * booleans, dates as `YYYY-MM-DD` and timestamps as `YYYY-MM-DD HH:MM:SS[.ffffff]`.
 */
export function formulaEvaluator(tree: FormulaExpression): (read: Read) => CellValue {
  const evaluate = compileNode(tree);
  switch (tree.type) {
    case "date":
      return (read) => {
        const value = evaluate(read);
        return value === null ? null : dateText(value as number);
      };
    case "timestamp":
      return (read) => {
        const value = evaluate(read);
        return value === null ? null : timestampText(value as number);
      };
    default:
      return evaluate;
  }
}

/** The columns of a view with formulas: the table's columns, then one per formula (with `expression`). */
export function formulaSchema(columns: readonly ColumnSchema[], compiled: readonly CompiledFormula[]): ColumnSchema[] {
  return [
    ...columns,
    ...compiled.map((formula) => ({ name: formula.name, type: formula.type, expression: formula.expression })),
  ];
}
