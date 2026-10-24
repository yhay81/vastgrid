import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, compileFormulas, type FormulaColumn, type TableInfo, type TableSource } from "vastgrid-core";
import { formulaErrorText, formulaUsers } from "../src/components/formula-editor.tsx";
import { GridController } from "../src/controller.ts";
import { en, ja } from "../src/messages.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

function orders() {
  return new ArraySource({
    columns: ["item", "qty", "price"],
    rows: [
      ["apple", 3, 120],
      ["pear", 1, 300],
      ["fig", 5, 80],
    ],
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function readyGrid(source: TableSource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

const names = (grid: GridController) => grid.visible.map((column) => grid.schema[column.index].name);

async function values(grid: GridController, column: string) {
  const index = grid.schema.findIndex((item) => item.name === column);
  const block = await grid.source.readRows({ view: grid.view.id, start: 0, end: grid.rowCount, columns: [index] });
  return block.columns[0];
}

test("formula columns join the schema after the table's columns and sort like the others", async () => {
  const grid = await readyGrid(orders());
  try {
    assert.equal(grid.formulasAvailable, true);
    const changes: FormulaColumn[][] = [];
    grid.onFormulasChange((list) => changes.push(list));
    grid.setFormulas([{ name: "total", expression: "qty * price" }], { after: 0 });
    await until(() => !grid.viewPending && grid.view.id !== null);
    assert.deepEqual(names(grid), ["item", "total", "qty", "price"]);
    assert.deepEqual(grid.schema[3], { name: "total", type: "float", expression: "qty * price" });
    assert.deepEqual(grid.query.formulas, [{ name: "total", expression: "qty * price" }]);
    assert.deepEqual(await values(grid, "total"), [360, 300, 400]);
    assert.equal(changes.length, 1);
    grid.sortBy(1, "desc");
    await until(() => !grid.viewPending && grid.query.sort?.length === 1);
    assert.deepEqual(await values(grid, "item"), ["fig", "apple", "pear"]);

    // Editing the expression keeps the sort, which follows the column by name.
    grid.setFormulas([{ name: "total", expression: "qty * price * 2" }]);
    await until(() => !grid.viewPending && grid.view.query.formulas?.[0].expression === "qty * price * 2");
    assert.deepEqual(grid.query.sort, [{ column: 3, direction: "desc" }]);
    assert.deepEqual(await values(grid, "total"), [800, 720, 600]);
    assert.deepEqual(names(grid), ["item", "total", "qty", "price"]);

    // Saved states keep the formulas, and the query refers to their names.
    const state = grid.getState();
    assert.deepEqual(state.formulas, [{ name: "total", expression: "qty * price * 2" }]);
    assert.deepEqual(state.schema, ["item", "qty", "price", "total"]);
    assert.equal(state.query?.formulas, undefined);

    // Removing a formula drops its sort and its column.
    grid.setFormulas([]);
    await until(() => !grid.viewPending);
    assert.deepEqual(names(grid), ["item", "qty", "price"]);
    assert.deepEqual(grid.query, { sort: [] });
    assert.equal(grid.view.id, null);

    // Applying the state brings them back onto a new grid, with the sort.
    const other = await readyGrid(orders());
    try {
      assert.ok(other.applyState(state));
      await until(() => !other.viewPending && other.view.id !== null && other.query.sort?.length === 1);
      assert.deepEqual(names(other), ["item", "total", "qty", "price"]);
      assert.deepEqual(await values(other, "item"), ["fig", "apple", "pear"]);
    } finally {
      other.dispose();
    }
  } finally {
    grid.dispose();
  }
});

test("a state applied before the columns are known brings its formulas, and broken ones wait to be fixed", async () => {
  const grid = new GridController(orders(), { ...options });
  try {
    grid.applyState({
      version: 1,
      schema: ["item", "qty", "price", "total", "broken"],
      formulas: [
        { name: "total", expression: "qty * price" },
        { name: "broken", expression: "qty * cost" },
      ],
      query: { filters: [{ type: "compare", column: 3, op: "ge", value: 350 }] },
    });
    grid.start();
    await until(() => grid.info?.status === "ready" && !grid.viewPending && grid.view.id !== null);
    assert.deepEqual(names(grid), ["item", "qty", "price", "total"]);
    assert.equal(grid.rowCount, 2);
    assert.equal(grid.formulaResults[1].error?.code, "unknown_column");
    assert.deepEqual(
      grid.formulas.map((formula) => formula.name),
      ["total", "broken"],
    );
    assert.equal(grid.getState().formulas?.length, 2);
    // Fixing it shows it.
    grid.setFormulas([grid.formulas[0], { name: "broken", expression: "qty * 2" }]);
    await until(() => !grid.viewPending && grid.schema.length === 5);
    assert.deepEqual(await values(grid, "broken"), [6, 10]);
  } finally {
    grid.dispose();
  }
});

test("sources that do not evaluate formulas show none and get no formulas in their queries", async () => {
  const array = orders();
  const queries: unknown[] = [];
  const source: TableSource = {
    info: async () => {
      const info = await array.info();
      return { ...info, capabilities: { ...info.capabilities, formulas: false } } satisfies TableInfo;
    },
    createView: (query, signal) => {
      queries.push(query);
      return array.createView(query, signal);
    },
    readRows: (request) => array.readRows(request),
  };
  const grid = await readyGrid(source);
  try {
    assert.equal(grid.formulasAvailable, false);
    grid.setFormulas([{ name: "total", expression: "qty * price" }]);
    grid.sortBy(0, "asc");
    await until(() => !grid.viewPending && grid.view.id !== null);
    assert.deepEqual(names(grid), ["item", "qty", "price"]);
    assert.ok(queries.every((query) => !(query as { formulas?: unknown }).formulas));
    assert.equal(grid.formulas.length, 1);
  } finally {
    grid.dispose();
  }
});

test("formula errors read in both languages, and formulas that use a column are found", () => {
  const formulas = [
    { name: "total", expression: "qty * price" },
    { name: "tax", expression: "total * 0.1" },
  ];
  assert.deepEqual(
    formulaUsers(formulas, "total").map((formula) => formula.name),
    ["tax"],
  );
  assert.deepEqual(formulaUsers(formulas, "tax"), []);
  const result = (expression: string) =>
    compileError([{ name: "item", type: "string" }], expression) as NonNullable<ReturnType<typeof compileError>>;
  assert.equal(formulaErrorText(result("item * 2"), en), "* takes number, not text (at character 1).");
  assert.equal(
    formulaErrorText(result("item * 2"), ja),
    "* には数値が必要です（文字列が渡されています）（1 文字目）。",
  );
  assert.equal(formulaErrorText(result("cost"), ja), "「cost」という列はありません（1 文字目）。");
  assert.equal(formulaErrorText(result("item +"), en), "The formula is not written correctly (at character 7).");
});

function compileError(columns: { name: string; type: "string" }[], expression: string) {
  return compileFormulas(columns, [{ name: "f", expression }])[0].error;
}
