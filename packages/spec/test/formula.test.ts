import assert from "node:assert/strict";
import { test } from "node:test";
import { isFailure, readCorpus } from "../src/conformance.ts";
import {
  type Column,
  checkPlan,
  compileFormula,
  type Expr,
  FormulaError,
  formulaColumns,
  formulaReference,
  formulaText,
} from "../src/index.ts";

const columns: Column[] = [
  { name: "qty", type: "integer" },
  { name: "price", type: "decimal", precision: 10, scale: 2 },
  { name: "name", type: "string" },
  { name: "day", type: "date" },
  { name: "at", type: "timestamp" },
  { name: "atz", type: "timestamptz" },
  { name: "ratio", type: "float" },
  { name: "unit price", type: "float" },
  { name: "id", type: "uuid" },
  { name: "ok", type: "boolean" },
];

const col = (name: string) => ({ col: name });
const lit = (value: number | string | boolean | null, type?: string) =>
  (type === undefined ? { lit: value } : { lit: value, type }) as Expr;
const fn = (name: string, ...args: Expr[]) => ({ fn: name, args }) as Expr;

function compiles(text: string, expr: Expr, type?: string) {
  const result = compileFormula(text, columns);
  assert.deepEqual(result.expr, expr, text);
  if (type) assert.equal(result.type.type, type, text);
  // The expression is written back as a formula that compiles to it.
  assert.deepEqual(compileFormula(formulaText(result.expr), columns).expr, expr, formulaText(result.expr));
}

function fails(text: string, reason: string, start: number, end: number) {
  assert.throws(
    () => compileFormula(text, columns),
    (error: unknown) => {
      assert.ok(error instanceof FormulaError, String(error));
      assert.deepEqual({ reason: error.reason, start: error.start, end: error.end }, { reason, start, end }, text);
      return true;
    },
  );
}

test("operators compile to the functions of §4.4, with v1's precedence", () => {
  compiles("qty * price", fn("mul", col("qty"), col("price")), "decimal");
  compiles("qty + 2 * 3 - 1", fn("sub", fn("add", col("qty"), fn("mul", lit(2), lit(3))), lit(1)), "bigint");
  compiles("ratio / 4 % 3", fn("mod", fn("div", col("ratio"), lit(4)), lit(3)), "float");
  compiles("-qty", fn("neg", col("qty")));
  compiles("-(5) + -5", fn("add", fn("neg", lit(5)), lit(-5)));
  compiles("name & ' ' & qty", fn("concat", col("name"), lit(" "), col("qty")), "string");
  compiles("(name & 'a') & 'b'", fn("concat", fn("concat", col("name"), lit("a")), lit("b")));
  compiles(
    "NOT qty = 1 AND name <> 'x' OR ratio >= 2.5",
    fn(
      "or",
      fn("and", fn("not", fn("eq", col("qty"), lit(1))), fn("ne", col("name"), lit("x"))),
      fn("ge", col("ratio"), lit("2.5", "decimal")),
    ),
    "boolean",
  );
  compiles("qty == 1 OR qty != 2", fn("or", fn("eq", col("qty"), lit(1)), fn("ne", col("qty"), lit(2))));
  compiles("[unit price] < 1", fn("lt", col("unit price"), lit(1)));
});

test("numbers stay exact: whole numbers are bigints, numbers with a point decimals, exponents floats (§2.5)", () => {
  compiles("12", lit(12), "bigint");
  compiles("007.50", lit("7.50", "decimal"), "decimal");
  compiles(".5", lit("0.5", "decimal"));
  compiles("-0.10", lit("-0.10", "decimal"));
  compiles("9223372036854775807", lit("9223372036854775807", "bigint"));
  compiles("-9223372036854775808", lit("-9223372036854775808", "bigint"));
  compiles("92233720368547758070", lit("92233720368547758070", "decimal"));
  compiles("1.5e0", lit(1.5), "float");
  compiles("2e3", lit(2000, "float"), "float");
  fails("1e400", "literal", 0, 5);
});

test("literals of every type are written TYPE 'text' and TYPE NULL", () => {
  compiles("DATE '2024-1-5'", lit("2024-01-05", "date"), "date");
  compiles("TIMESTAMP '2024-01-05T10:30'", lit("2024-01-05 10:30:00", "timestamp"));
  compiles("timestamp '2024-01-05 10:30:00.123456789'", lit("2024-01-05 10:30:00.123456789", "timestamp"));
  compiles("FLOAT 'nan'", lit("NaN", "float"));
  compiles("FLOAT '-inf'", lit("-Infinity", "float"));
  compiles("BIGINT '5'", lit(5, "bigint"));
  compiles("DECIMAL '7'", lit("7", "decimal"));
  compiles("BOOLEAN 'TRUE'", lit(true, "boolean"));
  compiles("STRING 'x'", lit("x", "string"));
  compiles("UUID '00000000-0000-0000-0000-000000000001'", lit("00000000-0000-0000-0000-000000000001", "uuid"));
  compiles("DATE NULL", lit(null, "date"), "date");
  compiles("IF(ok, 'yes', NULL)", fn("if", col("ok"), lit("yes"), lit(null)), "string");
  fails("DATE '2024-02-30'", "literal", 0, 17);
  fails("BOOLEAN 'yes'", "literal", 0, 13);
  fails("NULL", "type", 0, 4);
});

test("v1's functions map onto §4.4", () => {
  compiles("CEILING(ratio)", fn("ceil", col("ratio")));
  compiles("LEN(name)", fn("length", col("name")), "bigint");
  compiles("MID(name, 2, 3)", fn("substr", col("name"), lit(2), lit(3)));
  compiles("STARTSWITH(name, 'a')", fn("starts_with", col("name"), lit("a")));
  compiles("WEEKDAY(day)", fn("isodow", col("day")));
  compiles("ADDDAYS(day, 7)", fn("add_days", col("day"), lit(7)), "date");
  compiles("ISBLANK(name)", fn("is_blank", col("name")));
  compiles("MIN(qty)", col("qty"));
  compiles("MAX(qty, price, 1.5)", fn("greatest", col("qty"), col("price"), lit("1.5", "decimal")), "decimal");
  compiles("IF(qty > 1, 'many')", fn("if", fn("gt", col("qty"), lit(1)), lit("many"), lit(null)), "string");
  compiles("VALUE(qty)", col("qty"));
  compiles("VALUE(name)", fn("to_number", col("name")), "float");
  // DAYS(end, start) counts the days from start to end.
  compiles("DAYS(day, at)", fn("date_diff_days", col("at"), col("day")), "bigint");
  compiles("ROUND(ratio, -1)", fn("round", col("ratio"), lit(-1)));
  compiles("LEFT(name, 3.0)", fn("left", col("name"), lit(3)));
  compiles("lower(name)", fn("lower", col("name")));
  compiles("ceil(ratio)", fn("ceil", col("ratio")));
});

test("v1's conversions: text read as dates, text forms of values v1 read as text, dates as timestamps", () => {
  compiles("day >= '2024-1-5'", fn("ge", col("day"), lit("2024-01-05", "date")));
  compiles("at < '2024-01-05 10:00'", fn("lt", col("at"), lit("2024-01-05 10:00:00", "timestamp")));
  compiles("atz = '2024-01-05'", fn("eq", col("atz"), lit("2024-01-05 00:00:00+00", "timestamptz")));
  compiles("YEAR('2024-03-01')", fn("year", lit("2024-03-01", "date")));
  compiles("DATE('2024-3-1')", lit("2024-03-01", "date"));
  compiles("DATE(name)", fn("to_date", col("name")));
  compiles("DATE(at)", fn("to_date", fn("left", fn("text", col("at")), lit(10))), "date");
  compiles("DATETIME(day)", fn("to_timestamp", fn("concat", fn("text", col("day")), lit(" 00:00"))), "timestamp");
  compiles("HOUR(day)", fn("hour", fn("to_timestamp", fn("concat", fn("text", col("day")), lit(" 00:00")))));
  compiles(
    "YEAR(atz)",
    fn("year", fn("to_timestamp", fn("replace", fn("text", col("atz")), lit("+00"), lit("")))),
    "bigint",
  );
  compiles("LEN(id)", fn("length", fn("text", col("id"))));
  compiles("id = 'x'", fn("eq", fn("text", col("id")), lit("x")));
  compiles("MIN(day, '2024-01-01')", fn("least", col("day"), lit("2024-01-01", "date")));
});

test("errors name their reason (§4.7) and the characters at fault", () => {
  fails("", "syntax", 0, 0);
  fails("qty +", "syntax", 5, 5);
  fails("'open", "syntax", 0, 5);
  fails("[open", "syntax", 0, 5);
  fails("qty ? 1", "syntax", 4, 5);
  fails("1abc", "syntax", 0, 2);
  fails("missing + 1", "unknown_column", 0, 7);
  fails("FOO(1)", "unknown_function", 0, 6);
  fails("AND(ok, ok)", "syntax", 0, 3);
  fails("qty + name", "type", 6, 10);
  fails("LEFT(name, ratio)", "type", 11, 16);
  fails("ROUND(ratio, qty)", "type", 13, 16);
  fails("DAYS(day)", "arity", 0, 9);
  fails("SQRT(1, 2)", "arity", 0, 10);
  fails("YEAR('x')", "type", 5, 8);
  fails(`${"(".repeat(65)}1${")".repeat(65)}`, "limit", 64, 65);
  fails(Array.from({ length: 1001 }, () => "1").join(" & "), "limit", 0, 4001);
  // An engine that does not evaluate a function.
  assert.throws(
    () => compileFormula("SQRT(ratio)", columns, { functions: ["add"] }),
    (error: unknown) => error instanceof FormulaError && error.reason === "unsupported",
  );
});

test("names are written in brackets when they need them, and formulas list the names they use", () => {
  assert.equal(formulaReference("qty"), "qty");
  assert.equal(formulaReference("数量"), "数量");
  assert.equal(formulaReference("unit price"), "[unit price]");
  assert.equal(formulaReference("a]b"), "[a]]b]");
  assert.equal(formulaReference("and"), "[and]");
  assert.equal(formulaReference("1st"), "[1st]");
  assert.deepEqual(formulaColumns("qty * [unit price] + qty + LEN(name)"), ["qty", "unit price", "name"]);
  assert.deepEqual(formulaColumns("qty +"), []);
});

test("a formula uses the derived columns before it", () => {
  const first = compileFormula("qty * price", columns);
  const rows: Column[] = [...columns, { name: "total", ...first.type }];
  const second = compileFormula("total > 100", rows);
  assert.doesNotThrow(() =>
    checkPlan(
      {
        derive: [
          { name: "total", expr: first.expr },
          { name: "big", expr: second.expr },
        ],
      },
      columns,
    ),
  );
});

test("every expression of the corpus is written as a formula that compiles back to it", () => {
  let count = 0;
  for (const file of readCorpus()) {
    for (const item of file.cases) {
      if (isFailure(item.expect)) continue;
      const plan = item.plan as { derive?: { name: string; expr: Expr }[]; where?: Expr };
      const table = file.tables[item.table].columns;
      const expressions: [Expr, Column[]][] = [];
      let rows: Column[] = [...table];
      try {
        const checked = checkPlan(plan, table);
        checked.derive.forEach((derived, index) => {
          expressions.push([plan.derive?.[index].expr as Expr, rows]);
          rows = [...rows, derived.column];
        });
        if (plan.where && !JSON.stringify(plan.where).includes('"search"')) expressions.push([plan.where, rows]);
      } catch {
        continue;
      }
      for (const [expr, scope] of expressions) {
        const text = formulaText(expr);
        assert.deepEqual(compileFormula(text, scope).expr, expr, `${item.id}: ${text}`);
        count++;
      }
    }
  }
  assert.ok(count >= 50, `${count} expressions`);
});
