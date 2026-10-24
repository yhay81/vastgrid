import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Column,
  checkDocument,
  checkPlan,
  checkSession,
  displayedColumns,
  type GridDocument,
  keyText,
  migrateGridState,
  repairDocument,
  StateError,
  sameKey,
} from "../src/index.ts";
import { schemaProblems } from "./schemas.ts";

function refused(check: () => unknown, reason: string, path: string) {
  assert.throws(check, (error: unknown) => {
    assert.ok(error instanceof StateError, String(error));
    assert.deepEqual(
      { reason: error.reason, path: error.path, code: error.code },
      { reason, path, code: "invalid_state" },
    );
    return true;
  });
}

const document = (members: object) => ({ kind: "vastgrid/document", version: 2, ...members });
const session = (members: object) => ({ kind: "vastgrid/session", version: 2, ...members });

test("the examples of §5.1 and §5.2 are a document and a session", () => {
  const example = document({
    schema: ["id", "region", "qty", "price"],
    rowKey: "id",
    plan: { sort: [{ column: "price", direction: "desc" }] },
    columns: [
      { name: "id", pin: "left" },
      {
        name: "price",
        width: 120,
        format: {
          label: "Price",
          number: { style: "currency", currency: "JPY" },
          styles: [
            { when: { fn: "lt", args: [{ col: "price" }, { lit: 0 }] }, color: "#b42318", description: "Negative" },
          ],
        },
        total: { fn: "sum" },
      },
      { name: "qty", hidden: true },
    ],
  });
  assert.deepEqual(checkDocument(example), example);
  assert.deepEqual(schemaProblems("state.schema.json", example), []);
  const state = session({
    view: `sha256:${"a".repeat(64)}`,
    revision: "1730000000-74512",
    active: { row: 120, column: "price", key: { rowId: 5012 } },
    anchor: { row: 100, column: "region" },
    focus: { row: 140, column: "price" },
    selection: [
      { rows: [100, 141], columns: ["region", "qty", "price"] },
      { rows: "all", columns: "all" },
    ],
    scroll: { row: 95, column: "id" },
    checked: { mode: "include", keys: [{ rowId: 3 }, { value: "A-9" }] },
    detail: { open: true },
    editor: { row: 120, column: "price", key: { rowId: 5012 }, text: "12", value: "11.50" },
    history: { undo: [{ updates: [{ key: { rowId: 1 }, column: "qty", before: null, after: 2 }] }], redo: [] },
  });
  assert.deepEqual(checkSession(state), state);
  assert.deepEqual(schemaProblems("state.schema.json", state), []);
});

test("documents that do not have the form of §5.1 are refused", () => {
  refused(() => checkDocument([]), "syntax", "");
  refused(() => checkDocument({ kind: "vastgrid/state", version: 2 }), "syntax", "/kind");
  refused(() => checkDocument({ kind: "vastgrid/document", version: 1 }), "version", "/version");
  refused(() => checkDocument(document({ query: {} })), "syntax", "/query");
  refused(
    () => checkDocument(document({ columns: [{ name: "a" }, { name: "a" }] })),
    "duplicate_name",
    "/columns/1/name",
  );
  refused(() => checkDocument(document({ columns: [{ name: "a", width: 0 }] })), "syntax", "/columns/0/width");
  refused(() => checkDocument(document({ columns: [{ name: "" }] })), "syntax", "/columns/0/name");
  refused(() => checkDocument(document({ columns: [{ name: "x".repeat(257) }] })), "syntax", "/columns/0/name");
  refused(() => checkDocument(document({ columns: [{ name: "a", pin: "top" }] })), "syntax", "/columns/0/pin");
  refused(
    () => checkDocument(document({ columns: [{ name: "a", total: { fn: "median" } }] })),
    "syntax",
    "/columns/0/total/fn",
  );
  refused(
    () => checkDocument(document({ columns: [{ name: "a", format: { styles: [{ color: "red" }] } }] })),
    "syntax",
    "/columns/0/format/styles/0/when",
  );
  const many = Array.from({ length: 100_001 }, (_, index) => ({ name: `c${index}` }));
  refused(() => checkDocument(document({ columns: many })), "limit", "/columns");
  // A name of 256 code points is a name, whatever its UTF-16 length.
  assert.doesNotThrow(() => checkDocument(document({ columns: [{ name: "😀".repeat(256) }] })));
});

test("sessions that do not have the form of §5.2 are refused", () => {
  refused(() => checkSession({ kind: "vastgrid/session", version: 3 }), "version", "/version");
  refused(() => checkSession(session({ view: "v1" })), "syntax", "/view");
  refused(() => checkSession(session({ selection: [] })), "syntax", "/selection");
  refused(
    () => checkSession(session({ selection: Array(1001).fill({ rows: [0, 1], columns: ["a"] }) })),
    "limit",
    "/selection",
  );
  refused(
    () => checkSession(session({ selection: [{ rows: [3, 3], columns: ["a"] }] })),
    "syntax",
    "/selection/0/rows",
  );
  refused(
    () => checkSession(session({ selection: [{ rows: [0, 1], columns: [] }] })),
    "syntax",
    "/selection/0/columns",
  );
  refused(() => checkSession(session({ active: { row: -1, column: "a" } })), "syntax", "/active/row");
  refused(() => checkSession(session({ anchor: { row: 0, column: "a", key: { rowId: 1 } } })), "syntax", "/anchor/key");
  refused(
    () => checkSession(session({ checked: { mode: "include", keys: [], where: { lit: true } } })),
    "syntax",
    "/checked/where",
  );
  refused(() => checkSession(session({ checked: { mode: "all", keys: [] } })), "syntax", "/checked/mode");
  refused(
    () => checkSession(session({ editor: { row: 0, column: "a", text: "", value: null } })),
    "syntax",
    "/editor/key",
  );
  refused(
    () => checkSession(session({ editor: { row: 0, column: "a", key: { rowId: 0 }, text: "", value: [1] } })),
    "syntax",
    "/editor/value",
  );
  const step = { updates: [] };
  refused(
    () => checkSession(session({ history: { undo: Array(60).fill(step), redo: Array(41).fill(step) } })),
    "limit",
    "/history",
  );
  refused(
    () =>
      checkSession(
        session({ history: { undo: [{ updates: [{ key: { rowId: 0 }, column: "a", before: 1 }] }], redo: [] } }),
      ),
    "syntax",
    "/history/undo/0/updates/0/after",
  );
});

const view: Column[] = ["a", "b", "c", "d", "e"].map((name) => ({ name, type: "string" }));
const order = (columns: GridDocument["columns"]) =>
  displayedColumns({ kind: "vastgrid/document", version: 2, columns }, view).map((item) => item.column.name);

test("displayed columns: pinned left, then listed and other columns, then pinned right (§5.1.1)", () => {
  assert.deepEqual(order(undefined), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(order([{ name: "d" }, { name: "b" }]), ["d", "b", "a", "c", "e"]);
  assert.deepEqual(
    order([
      { name: "e", pin: "left" },
      { name: "a", pin: "right" },
      { name: "c", pin: "left" },
    ]),
    ["e", "c", "b", "d", "a"],
  );
  assert.deepEqual(
    order([
      { name: "b", hidden: true },
      { name: "zzz", width: 10 },
    ]),
    ["a", "c", "d", "e"],
  );
  assert.deepEqual(order(view.map((column) => ({ name: column.name, hidden: true }))), ["a"]);
  assert.deepEqual(displayedColumns({ kind: "vastgrid/document", version: 2 }, []), []);
});

test("keys are the same when their JSON is, bigints written either way (§5.3)", () => {
  assert.ok(sameKey({ value: 2 }, { value: "2" }));
  assert.ok(sameKey({ rowId: 4 }, { rowId: 4 }));
  assert.ok(!sameKey({ rowId: 4 }, { value: 4 }));
  assert.ok(!sameKey({ value: "02" }, { value: 2 }));
  assert.ok(!sameKey({ value: "9007199254740993" }, { value: 9007199254740992 }));
  assert.ok(!sameKey({ value: true }, { value: "true" }));
  assert.equal(keyText({ value: "-12" }), '{"value":-12}');
});

const table: Column[] = [
  { name: "id", type: "integer" },
  { name: "name", type: "string" },
  { name: "amount", type: "decimal", precision: 10, scale: 2 },
  { name: "d", type: "date" },
];
const col = (name: string) => ({ col: name });
const lit = (value: number | string) => ({ lit: value });
const fn = (name: string, ...args: object[]) => ({ fn: name, args });

test("repairing a document removes what does not validate, in order (§5.5)", () => {
  const { document: repaired, removed } = repairDocument(
    {
      kind: "vastgrid/document",
      version: 2,
      plan: {
        derive: [
          { name: "x", expr: fn("mul", col("amount"), lit(2)) },
          { name: "y", expr: fn("add", col("missing"), lit(1)) },
          { name: "z", expr: fn("mul", col("x"), lit(3)) },
        ],
        where: fn("and", fn("gt", col("missing"), lit(1)), fn("eq", col("name"), lit("a")), fn("gt", col("y"), lit(1))),
        aggregate: {
          keys: ["name", "gone"],
          measures: [
            { name: "n", fn: "count" },
            { name: "s", fn: "sum", column: "gone" },
            { name: "t", fn: "sum", column: "name" },
          ],
        },
        having: fn("and", fn("gt", col("n"), lit(1)), fn("gt", col("s"), lit(1))),
        sort: [
          { column: "n", direction: "desc" },
          { column: "s", direction: "asc" },
        ],
      } as never,
      columns: [
        { name: "n", total: { fn: "sum" } },
        { name: "name", total: { fn: "sum" } },
      ],
    },
    table,
  );
  assert.deepEqual(removed, [
    "/plan/derive/1",
    "/plan/where/args/0",
    "/plan/where/args/2",
    "/plan/aggregate/keys/1",
    "/plan/aggregate/measures/1",
    "/plan/aggregate/measures/2",
    "/plan/having/args/1",
    "/plan/sort/1",
    "/columns/1/total",
  ]);
  assert.deepEqual(repaired.plan, {
    derive: [
      { name: "x", expr: fn("mul", col("amount"), lit(2)) },
      { name: "z", expr: fn("mul", col("x"), lit(3)) },
    ],
    where: fn("eq", col("name"), lit("a")),
    aggregate: { keys: ["name"], measures: [{ name: "n", fn: "count" }] },
    having: fn("gt", col("n"), lit(1)),
    sort: [{ column: "n", direction: "desc" }],
  });
  assert.deepEqual(repaired.columns, [{ name: "n", total: { fn: "sum" } }, { name: "name" }]);
  assert.doesNotThrow(() => checkPlan(repaired.plan, table));
});

test("repair removes a where that is not an and, having without aggregate, and a pivot that does not validate", () => {
  const repair = (plan: object) =>
    repairDocument({ kind: "vastgrid/document", version: 2, plan: plan as never }, table);
  assert.deepEqual(repair({ where: fn("gt", col("gone"), lit(1)) }).removed, ["/plan/where"]);
  assert.deepEqual(repair({ having: fn("gt", col("id"), lit(1)) }).removed, ["/plan/having"]);
  const pivot = repair({
    aggregate: { keys: ["name"], measures: [{ name: "n", fn: "count" }], pivot: { columns: ["gone"] } },
  });
  assert.deepEqual(pivot.removed, ["/plan/aggregate/pivot"]);
  assert.deepEqual(pivot.document.plan, { aggregate: { keys: ["name"], measures: [{ name: "n", fn: "count" }] } });
  const unsupported = repairDocument(
    {
      kind: "vastgrid/document",
      version: 2,
      plan: { where: fn("and", fn("gt", col("id"), lit(1)), fn("eq", col("name"), lit("a"))) as never },
    },
    table,
    { functions: ["and", "eq"] },
  );
  assert.deepEqual(unsupported.removed, ["/plan/where/args/0"]);
  assert.deepEqual(repair({ sort: [{ column: "id", direction: "asc" }] }).removed, []);
});

const v1Table: Column[] = [...table, { name: "note", type: "string" }];

test("v1's query migrates into where and sort (§5.6, Appendix A)", () => {
  const { document: migrated, dropped } = migrateGridState(
    {
      version: 1,
      schema: ["id", "name", "amount", "d"],
      query: {
        sort: [{ column: 2, direction: "desc" }],
        filters: [
          { type: "values", column: 1, values: ["a", null] },
          { type: "compare", column: 0, op: "gt", value: 5 },
          { type: "between", column: 2, min: "1.5", max: 3 },
          { type: "compare", column: 3, op: "ge", value: "2024-01-01" },
        ],
        where: {
          type: "and",
          filters: [
            { type: "text", column: 1, op: "contains", value: "Tok" },
            {
              type: "or",
              filters: [
                { type: "blank", column: 2, blank: true },
                { type: "values", column: 0, values: [1, 2], exclude: true },
              ],
            },
          ],
        },
        search: "x",
      },
    },
    v1Table,
  );
  assert.deepEqual(dropped, []);
  assert.deepEqual(migrated.schema, ["id", "name", "amount", "d"]);
  assert.deepEqual(migrated.plan, {
    where: fn(
      "and",
      { search: "x" },
      fn("or", fn("in", col("name"), lit("a")), fn("is_blank", col("name"))),
      fn("gt", col("id"), lit(5)),
      fn("and", fn("ge", col("amount"), { lit: "1.5", type: "decimal" }), fn("le", col("amount"), lit(3))),
      fn("ge", col("d"), { lit: "2024-01-01", type: "date" }),
      fn("contains", fn("lower", fn("text", col("name"))), fn("lower", lit("Tok"))),
      fn(
        "or",
        fn("is_blank", col("amount")),
        fn("not", fn("coalesce", fn("in", col("id"), lit(1), lit(2)), { lit: false })),
      ),
    ),
    sort: [{ column: "amount", direction: "desc" }],
  });
  assert.doesNotThrow(() => checkPlan(migrated.plan, v1Table));
});

test("v1's columns and frozen columns migrate into settings with pins", () => {
  const { document: migrated } = migrateGridState(
    {
      version: 1,
      columns: [
        { name: "id", width: 80 },
        { name: "name", hidden: true },
        { name: "amount", total: "sum" },
        { name: "note" },
      ],
      frozenColumns: 1,
      frozenRightColumns: 1,
    },
    v1Table,
  );
  assert.deepEqual(migrated.columns, [
    { name: "id", width: 80, pin: "left" },
    { name: "name", hidden: true },
    { name: "amount", total: { fn: "sum" } },
    { name: "note", pin: "right" },
  ]);
  assert.deepEqual(migrateGridState({ version: 1, frozenColumns: 2 }, v1Table).document.columns, [
    { name: "id", pin: "left" },
    { name: "name", pin: "left" },
    { name: "amount" },
    { name: "d" },
    { name: "note" },
  ]);
});

test("v1's groups migrate into aggregate, having and sort, with v1's names", () => {
  const { document: migrated, dropped } = migrateGridState(
    {
      version: 1,
      schema: ["id", "name", "amount"],
      query: { sort: [{ column: 0, direction: "asc" }], filters: [{ type: "compare", column: 2, op: "gt", value: 0 }] },
      group: {
        keys: ["name"],
        aggregates: [{ fn: "count" }, { fn: "sum", column: "amount" }, { fn: "sum", column: "amount" }],
        state: {
          version: 1,
          schema: ["name", "count(*)", "sum(amount)", "sum(amount) (2)"],
          query: {
            sort: [{ column: 1, direction: "desc" }],
            filters: [{ type: "compare", column: 2, op: "gt", value: 10 }],
            search: "q",
          },
          columns: [{ name: "count(*)", width: 60 }],
        },
      },
    },
    v1Table,
  );
  assert.deepEqual(dropped, ["/query/sort", "/group/state/query/search"]);
  assert.deepEqual(migrated.plan, {
    where: fn("gt", col("amount"), lit(0)),
    aggregate: {
      keys: ["name"],
      measures: [
        { name: "count(*)", fn: "count" },
        { name: "sum(amount)", fn: "sum", column: "amount" },
        { name: "sum(amount) (2)", fn: "sum", column: "amount" },
      ],
    },
    having: fn("gt", col("sum(amount)"), lit(10)),
    sort: [{ column: "count(*)", direction: "desc" }],
  });
  assert.deepEqual(migrated.columns, [{ name: "count(*)", width: 60 }]);
  assert.doesNotThrow(() => checkPlan(migrated.plan, v1Table));
});

test("v1's formulas are reported as dropped, with what uses them", () => {
  const { document: migrated, dropped } = migrateGridState(
    {
      version: 1,
      schema: ["id", "f"],
      formulas: [{ name: "f", expression: "id * 2" }],
      query: { sort: [{ column: 1, direction: "asc" }], filters: [{ type: "compare", column: 1, op: "gt", value: 1 }] },
    },
    v1Table,
  );
  assert.deepEqual(dropped, ["/formulas", "/query/filters/0", "/query/sort/0"]);
  assert.deepEqual(migrated.plan, {});
});

test("a v1 query saved without a state migrates, and other versions are refused", () => {
  assert.deepEqual(migrateGridState({ sort: [{ column: 0, direction: "asc" }] }, v1Table).document.plan, {
    sort: [{ column: "id", direction: "asc" }],
  });
  refused(() => migrateGridState({ version: 2 }, v1Table), "version", "/version");
  refused(() => migrateGridState("state", v1Table), "syntax", "");
});
