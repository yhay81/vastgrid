import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource } from "../src/array-source.ts";
import {
  compileFormulas,
  FormulaError,
  formulaEvaluator,
  formulaNames,
  formulaNumberText,
  formulaReference,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FORMULAS,
  parseFormula,
} from "../src/formula.ts";
import { parseGridState } from "../src/grid-state.ts";
import { parseProtocolRequest, parseViewQuery } from "../src/protocol.ts";
import { isEmptyQuery, queryFormulas, SourceError } from "../src/source.ts";
import type { CellValue, ColumnSchema, FormulaColumn } from "../src/types.ts";

const columns: ColumnSchema[] = [
  { name: "qty", type: "integer" },
  { name: "price", type: "float" },
  { name: "name", type: "string" },
  { name: "day", type: "date" },
  { name: "at", type: "timestamp" },
  { name: "ok", type: "boolean" },
  { name: "unit price", type: "decimal" },
  { name: "id", type: "bigint" },
  { name: "単価", type: "integer" },
];

const row: Record<string, CellValue> = {
  qty: 3,
  price: 2.5,
  name: " Apple pie ",
  day: "2024-02-28",
  at: "2024-02-28 23:30:15.25",
  ok: true,
  "unit price": "1.50",
  id: "9007199254740993",
  単価: 120,
};

function value(expression: string, values: Record<string, CellValue> = row): CellValue {
  const [compiled] = compileFormulas(columns, [{ name: "f", expression }]);
  if (compiled.error) throw compiled.error;
  const read = (column: number) => values[columns[column].name] ?? null;
  return formulaEvaluator(compiled.tree as NonNullable<typeof compiled.tree>)(read);
}

function error(expression: string, formulas: FormulaColumn[] = []) {
  const compiled = compileFormulas(columns, [...formulas, { name: "f", expression }]);
  return compiled[compiled.length - 1].error;
}

test("formulas compute numbers, text, booleans, dates and blanks", () => {
  assert.equal(value("qty * price"), 7.5);
  assert.equal(value("qty * price + 1 - 2 / 4"), 8);
  assert.equal(value("-qty % 2"), -1);
  assert.equal(value("[unit price] * 2"), 3);
  assert.equal(value("単価 * qty"), 360);
  assert.equal(value("qty / 0"), null);
  assert.equal(value("MOD(qty, 0)"), null);
  assert.equal(value("1e308 * 10"), null);
  assert.equal(value("SQRT(-1)"), null);
  assert.equal(value("LN(0)"), null);
  assert.equal(value("ROUND(2.5)"), 3);
  assert.equal(value("ROUND(-2.5)"), -3);
  assert.equal(value("ROUND(0.285, 2)"), 0.28);
  assert.equal(value("ROUND(1234.5, -2)"), 1200);
  assert.equal(value("ROUND(123.456, 400)"), 123.456);
  assert.equal(value("MIN(qty, price, NULL)"), 2.5);
  assert.equal(value("MAX('b', 'a')"), "b");
  assert.equal(value("name & '!'"), " Apple pie !");
  assert.equal(value("TRIM(name) & qty & ok & NULL"), "Apple pie3TRUE");
  assert.equal(value("TEXT(id)"), "9007199254740993");
  assert.equal(value("TEXT([unit price])"), "1.50");
  assert.equal(value("TEXT(price * 2)"), "5");
  assert.equal(value("TEXT(0.00001)"), "1e-05");
  assert.equal(value("LEN('a😀b')"), 3);
  assert.equal(value("LEFT('a😀bc', 2) & '|' & RIGHT('abc', 2) & '|' & MID('abcdef', 0, 3)"), "a😀|bc|abc");
  assert.equal(value("LEFT('abc', NULL)"), "");
  assert.equal(value("REPLACE('a-b-c', '-', '+') & REPLACE('abc', '', 'x')"), "a+b+cabc");
  assert.equal(value("UPPER(TRIM(name))"), "APPLE PIE");
  assert.equal(value("CONTAINS(name, 'pie') AND STARTSWITH(name, ' A') AND NOT ENDSWITH(name, 'x')"), true);
  assert.equal(value("VALUE(' 1_000.5 ') + VALUE('x')"), null);
  assert.equal(value("VALUE(' 1_000.5 ')"), 1000.5);
  assert.equal(value("ADDDAYS(day, 2)"), "2024-03-01");
  assert.equal(value("DAYS(DATE('2024-03-01'), day)"), 2);
  assert.equal(value("YEAR(day) * 10000 + MONTH(day) * 100 + DAY(day)"), 20240228);
  assert.equal(value("WEEKDAY(day)"), 3);
  assert.equal(value("HOUR(at) & ':' & MINUTE(at) & ':' & SECOND(at)"), "23:30:15");
  assert.equal(value("ADDDAYS(at, 1)"), "2024-02-29 23:30:15.25");
  assert.equal(value("DATE(at)"), "2024-02-28");
  assert.equal(value("DATETIME(day)"), "2024-02-28 00:00:00");
  assert.equal(value("DATE('2024-02-30')"), null);
  assert.equal(value("DATETIME(' 2024-1-5T7:08 ')"), "2024-01-05 07:08:00");
  assert.equal(value("day > '2024-01-01' AND at < '2025-01-01'"), true);
  assert.equal(value("IF(qty > 2, 'many', 'few')"), "many");
  assert.equal(value("IF(NULL, 1, 2)"), 2);
  assert.equal(value("IF(FALSE, 1)"), null);
  assert.equal(value("COALESCE(NULL, qty)"), 3);
  assert.equal(value("ISBLANK(NULL) AND ISBLANK('') AND NOT ISBLANK(qty)"), true);
  assert.equal(value("NULL AND FALSE"), false);
  assert.equal(value("NULL OR TRUE"), true);
  assert.equal(value("NULL = NULL"), null);
  assert.equal(value("qty + NULL"), null);
  assert.equal(value("'ｱ' < '😀'"), true);
  assert.equal(value("qty * price", { ...row, price: null }), null);
  assert.equal(value("qty * price", { ...row, price: "NaN" }), null);
});

test("the number text matches the shortest digits with SQL's exponent style", () => {
  assert.equal(formulaNumberText(3), "3");
  assert.equal(formulaNumberText(0.1), "0.1");
  assert.equal(formulaNumberText(0.0001), "0.0001");
  assert.equal(formulaNumberText(1.5e-7), "1.5e-07");
  assert.equal(formulaNumberText(1e16), "1e+16");
  assert.equal(formulaNumberText(123456789012.5), "123456789012.5");
  assert.equal(formulaNumberText(-0), "-0");
});

test("formula errors tell the kind and the place", () => {
  const syntax = error("qty * (price");
  assert.equal(syntax?.code, "syntax");
  assert.equal(error("qty +* 2")?.code, "syntax");
  assert.equal(error("'open")?.code, "syntax");
  assert.equal(error("[open")?.code, "syntax");
  assert.equal(error("2x")?.code, "syntax");
  assert.equal(error("qty price")?.code, "syntax");
  const unknown = error("qty * cost");
  assert.equal(unknown?.code, "unknown_column");
  assert.equal(unknown?.subject, "cost");
  assert.deepEqual([unknown?.start, unknown?.end], [6, 10]);
  assert.equal(error("EVAL('1')")?.code, "unknown_function");
  assert.equal(error("ROUND()")?.code, "arguments");
  const type = error("name * 2");
  assert.equal(type?.code, "type");
  assert.deepEqual(type?.expected, ["number"]);
  assert.equal(type?.actual, "text");
  assert.equal(error("IF(ok, 1, 'a')")?.code, "type");
  assert.equal(error("day > 'soon'")?.code, "type");
  assert.equal(error("LEN(qty)")?.code, "type");
  assert.equal(error("x".repeat(MAX_FORMULA_LENGTH + 1))?.code, "too_long");
  assert.equal(error(`${"(".repeat(MAX_FORMULA_DEPTH + 1)}1${")".repeat(MAX_FORMULA_DEPTH + 1)}`)?.code, "too_deep");
  assert.equal(error("")?.code, "syntax");
  assert.ok(syntax instanceof FormulaError);
});

test("formula columns use other formulas, by name, but not in a cycle", () => {
  const compiled = compileFormulas(columns, [
    { name: "total", expression: "qty * price" },
    { name: "with tax", expression: "ROUND(total * 1.1, 2)" },
    { name: "a", expression: "b + 1" },
    { name: "b", expression: "a + 1" },
    { name: "c", expression: "a" },
    { name: "self", expression: "self" },
    { name: "qty", expression: "1" },
    { name: "total", expression: "2" },
    { name: " ", expression: "2" },
  ]);
  assert.deepEqual(
    compiled.map((formula) => formula.error?.code ?? formula.type),
    ["float", "float", "circular", "circular", "dependency", "circular", "name_taken", "name_taken", "name_empty"],
  );
  const read = (column: number) => row[columns[column].name] ?? null;
  assert.equal(formulaEvaluator(compiled[1].tree as NonNullable<(typeof compiled)[1]["tree"]>)(read), 8.25);
  // Formulas that double their input on every level stay within the limit of operations.
  const growing = Array.from({ length: 12 }, (_, index) => ({
    name: `g${index}`,
    expression: index === 0 ? "qty" : `g${index - 1} + g${index - 1}`,
  }));
  const expanded = compileFormulas(columns, growing);
  assert.equal(expanded[8].error, null);
  assert.equal(expanded[9].error?.code, "too_complex");
  assert.equal(expanded[11].error?.code, "dependency");
});

test("formula helpers find names and quote them", () => {
  assert.deepEqual(formulaNames("[unit price] * qty + qty"), ["unit price", "qty"]);
  assert.deepEqual(formulaNames("qty +"), []);
  assert.equal(formulaReference("qty"), "qty");
  assert.equal(formulaReference("単価"), "単価");
  assert.equal(formulaReference("unit price"), "[unit price]");
  assert.equal(formulaReference("a]b"), "[a]]b]");
  assert.equal(formulaReference("and"), "[and]");
  assert.equal(parseFormula("[a]]b]").kind, "name");
});

test("the protocol checks the number, names and syntax of formulas", () => {
  const query = parseViewQuery({ formulas: [{ name: "f", expression: "qty * 2" }], extra: 1 });
  assert.deepEqual(query, { formulas: [{ name: "f", expression: "qty * 2" }] });
  assert.throws(() => parseViewQuery({ formulas: [{ name: "f", expression: "qty *" }] }), /formulas\[0\]\.expression/);
  assert.throws(() => parseViewQuery({ formulas: [{ name: "", expression: "1" }] }), /must not be empty/);
  assert.throws(
    () =>
      parseViewQuery({
        formulas: [
          { name: "f", expression: "1" },
          { name: "f", expression: "2" },
        ],
      }),
    /repeats/,
  );
  assert.throws(
    () =>
      parseViewQuery({
        formulas: Array.from({ length: MAX_FORMULAS + 1 }, (_, i) => ({ name: `f${i}`, expression: "1" })),
      }),
    /more than/,
  );
  assert.throws(() => parseViewQuery({ formulas: [{ name: "f", expression: "x".repeat(MAX_FORMULA_LENGTH + 1) }] }));
  assert.throws(() => parseViewQuery({ formulas: "qty * 2" }));
  const request = parseProtocolRequest({
    op: "view",
    table: "t",
    query: { formulas: [{ name: "f", expression: "1" }] },
  });
  assert.equal(request.op === "view" && request.query.formulas?.length, 1);
  assert.equal(isEmptyQuery({ formulas: [{ name: "f", expression: "1" }] }), false);
  assert.throws(
    () => queryFormulas(columns, { formulas: [{ name: "f", expression: "nothing" }] }),
    (error: unknown) => error instanceof SourceError && error.code === "invalid_request",
  );
  // Grid states keep formulas.
  const state = parseGridState({ version: 1, formulas: [{ name: "f", expression: "1" }, { name: 2 }] });
  assert.deepEqual(state?.formulas, [{ name: "f", expression: "1" }]);
});

test("ArraySource reads, sorts, filters, summarizes and exports formula columns", async () => {
  const source = new ArraySource({
    columns: ["item", "qty", "price"],
    rows: [
      ["a", 2, 10],
      ["b", 5, 1.5],
      ["c", null, 3],
      ["d", 1, 100],
    ],
  });
  const formulas = [
    { name: "total", expression: "qty * price" },
    { name: "label", expression: "item & ':' & total" },
  ];
  const info = await source.info();
  assert.equal(info.capabilities.formulas, true);
  const view = await source.createView({
    formulas,
    sort: [{ column: 3, direction: "desc" }],
    where: {
      type: "or",
      filters: [
        { type: "compare", column: 3, op: "ge", value: 20 },
        { type: "blank", column: 3, blank: true },
      ],
    },
  });
  assert.equal(view.rowCount, 3);
  const block = await source.readRows({ view: view.id, start: 0, end: 3, columns: [0, 3, 4] });
  assert.deepEqual(block.columns, [
    ["d", "a", "c"],
    [100, 20, null],
    ["d:100", "a:20", "c:"],
  ]);
  const stats = await source.columnStats(view.id, 3);
  assert.equal(stats.nulls, 1);
  assert.equal(stats.max, 100);
  const summary = await source.aggregate({ view: view.id, ranges: [{ start: 0, end: 3, columns: [3] }] });
  assert.equal(summary.sum, 120);
  const distinct = await source.distinctValues({ view: view.id, column: 4 });
  assert.equal(distinct.values.length, 3);
  const found = await source.find({ view: view.id, text: "a:2", columns: [0, 4], row: 0, column: 0, direction: 1 });
  assert.deepEqual(found, { row: 1, column: 1 });
  const exported = await source.exportView({ view: view.id, format: "csv", columns: [0, 3], target: "x.csv" });
  assert.equal(await exported.data?.text(), "item,total\nd,100\na,20\nc,\n");
  // A formula with an error is refused.
  await assert.rejects(source.createView({ formulas: [{ name: "x", expression: "missing" }] }), /missing/);
  // Formulas alone make a view in table order.
  const plain = await source.createView({ formulas });
  assert.equal(plain.rowCount, 4);
  const rows = await source.readRows({ view: plain.id, start: 0, end: 4, columns: [3] });
  assert.deepEqual(rows.columns[0], [20, 7.5, null, 100]);
});
