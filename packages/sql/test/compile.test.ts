import assert from "node:assert/strict";
import { test } from "node:test";
import { type Column, checkPlan } from "vastgrid-spec";
import { compileView, countQuery, quoteIdentifier, rowsQuery } from "../src/index.ts";

const columns: Column[] = [
  { name: 'say "hi"', type: "string" },
  { name: "n", type: "integer" },
];
const source = { relation: quoteIdentifier("t"), rowId: "row_id" };

test("values are parameters and names are quoted, whatever they hold", () => {
  const text = "x'); DROP TABLE t; --";
  const plan = checkPlan(
    {
      derive: [{ name: "a'b", expr: { fn: "concat", args: [{ col: 'say "hi"' }, { lit: text }] } }],
      where: {
        fn: "and",
        args: [{ search: text }, { fn: "gt", args: [{ col: "n" }, { lit: "1.5", type: "decimal" }] }],
      },
      sort: [{ column: "a'b", direction: "desc" }],
    },
    columns,
  );
  const view = compileView(plan, source);
  const query = rowsQuery(view, { start: 0, end: 10, columns: ["a'b"] });
  assert.ok(!query.sql.includes("DROP"), query.sql);
  assert.ok(!query.sql.includes("1.5"), query.sql);
  assert.ok(query.sql.includes('"say ""hi"""'), query.sql);
  assert.ok(query.sql.includes(`"a'b"`), query.sql);
  assert.deepEqual(query.params, [text, text, "1.5"]);
  assert.deepEqual(countQuery(view).params, query.params);
});

test("source parameters come first", () => {
  const plan = checkPlan({ where: { fn: "eq", args: [{ col: "n" }, { lit: 2 }] } }, columns);
  const view = compileView(plan, { relation: "read_csv($1)", rowId: "row_id", params: ["data.csv"] });
  assert.deepEqual(view.params, ["data.csv", "2"]);
  assert.ok(view.with.includes("CAST(CAST($2 AS VARCHAR) AS BIGINT)"), view.with);
});

test("the row ID column takes a name that no column has", () => {
  const plan = checkPlan({}, [{ name: "vg_row", type: "integer" }]);
  const view = compileView(plan, source);
  assert.equal(view.rowId, '"vg_row_"');
  assert.deepEqual(view.order, ['"vg_row_" ASC']);
});

test("reads are ranges of positions", () => {
  const view = compileView(checkPlan({}, columns), source);
  assert.throws(() => rowsQuery(view, { start: 5, end: 2, columns: [] }), RangeError);
  assert.throws(() => rowsQuery(view, { start: 0, end: 1, columns: ["missing"] }), RangeError);
  assert.match(rowsQuery(view, { start: 3, end: 7, columns: ["n"] }).sql, /LIMIT 4 OFFSET 3$/);
});
