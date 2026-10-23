import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type RowRequest, SourceError, type TableSource, type ViewQuery } from "vastgrid-core";
import { comparable } from "../src/components/filter-panel.tsx";
import { CopyRangesError, CopyTooLargeError, GridController } from "../src/controller.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

/** A table whose server cancels its first `failures` view builds on its own, as when it closes the table. */
function cancellingSource(failures: number) {
  const source = new ArraySource({
    columns: ["name", "born"],
    rows: [
      ["Ada", 1815],
      ["Grace", 1906],
      ["Linus", 1969],
    ],
  });
  const createView = source.createView.bind(source);
  source.createView = async (query: ViewQuery, signal?: AbortSignal) => {
    if (failures-- > 0) throw new SourceError("cancelled", "The view request was cancelled.", 409);
    return createView(query, signal);
  };
  return source;
}

async function readyGrid(source: TableSource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  while (grid.info?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 1));
  return grid;
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

test("a view the server cancelled on its own is asked for once more", async () => {
  const grid = await readyGrid(cancellingSource(1));
  await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
  assert.equal(grid.viewPending, false);
  assert.equal(grid.viewError, null);
  assert.ok(grid.view.id);
  grid.dispose();
});

test("a view refused because the server loads the table again is applied once it is loaded", async () => {
  const source = cancellingSource(0);
  const info = source.info.bind(source);
  const createView = source.createView.bind(source);
  // The server closed the table (for example because the file changed) and opens it again.
  let phase: "ready" | "reopened" | "loaded" = "ready";
  source.info = async () => {
    const result = await info();
    if (phase !== "reopened") return result;
    phase = "loaded";
    return { ...result, status: "loading", rowCount: null, readableRows: 0 };
  };
  source.createView = async (query: ViewQuery, signal?: AbortSignal) => {
    if (phase === "ready") {
      phase = "reopened";
      throw new SourceError("not_ready", "The table is still loading.", 409);
    }
    return createView(query, signal);
  };
  const grid = await readyGrid(source);
  await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
  for (let wait = 0; wait < 100 && grid.view.id === null; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(grid.view.id, "the query is applied once the table is ready again");
  assert.equal(grid.viewError, null);
  grid.dispose();
});

test("a view that keeps being cancelled is reported instead of pending forever", async () => {
  const grid = await readyGrid(cancellingSource(2));
  await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
  assert.equal(grid.viewPending, false);
  assert.equal(grid.view.id, null);
  assert.match(grid.viewError ?? "", /cancelled/);
  grid.dispose();
});

/** Answers like a table server: text longer than `textLimit` (2,000 characters unless asked) ends with "…". */
function truncating(source: ArraySource) {
  const readRows = source.readRows.bind(source);
  source.readRows = async (request: RowRequest) => {
    const block = await readRows(request);
    const limit = request.textLimit ?? 2000;
    const cut = (value: unknown) =>
      typeof value === "string" && value.length > limit ? `${value.slice(0, limit)}…` : value;
    return { ...block, columns: block.columns.map((values) => values.map(cut) as typeof values) };
  };
  return source;
}

test("copies and filters by the whole text of long cells", async () => {
  const long = `${"x".repeat(2999)}y`;
  const grid = await readyGrid(
    truncating(
      new ArraySource({
        columns: ["id", "note"],
        rows: [
          [1, long],
          [2, "short"],
        ],
      }),
    ),
  );
  grid.cache.want(0, 2, [0, 1]);
  await until(() => grid.value(0, 1) !== undefined);
  grid.selection.select({ row: 0, col: 1 });
  // The loaded value was cut for display, so the browser's copy event cannot answer with it.
  assert.equal(grid.copySelectionSync({}), null);
  assert.equal((await grid.copySelection({})).text, long);
  await grid.filterByValue(0, 1, false);
  assert.equal(grid.view.rowCount, 1);
  grid.dispose();
});

test("widening a column for a long number stops at the widest width", async () => {
  const grid = await readyGrid(cancellingSource(0));
  let renders = 0;
  grid.onRender(() => renders++);
  grid.growColumns(new Map([[1, 900]]));
  assert.equal(grid.visible[1].width, 600);
  renders = 0;
  // The renderer reports the same need on every frame.
  grid.growColumns(new Map([[1, 900]]));
  assert.equal(renders, 0);
  grid.dispose();
});

test("reading a changed file again keeps column settings with their columns and clears the summary", async () => {
  const first = new ArraySource({
    columns: ["a", "b", "c"],
    rows: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
  });
  // The file was rewritten with its columns in another order.
  const second = new ArraySource({
    columns: ["c", "a", "b"],
    rows: [
      [3, 1, 2],
      [6, 4, 5],
      [9, 7, 8],
    ],
  });
  let current = first;
  const source: TableSource = {
    info: async () => ({ ...(await current.info()), revision: current === first ? "1" : "2" }),
    createView: (query, signal) => current.createView(query, signal),
    readRows: (request) => current.readRows(request),
    aggregate: (request) => current.aggregate(request),
  };
  const grid = await readyGrid(source);
  grid.resizeColumn(0, 222);
  grid.setColumnHidden(1, true);
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 2, col: 0 }, "extend");
  grid.selectionChanged();
  await until(() => grid.summary !== null);
  current = second;
  grid.reload();
  await until(() => grid.info?.revision === "2");
  const byName = new Map(grid.columns.map((state) => [grid.schema[state.index].name, state]));
  assert.equal(byName.get("a")?.width, 222);
  assert.equal(byName.get("b")?.hidden, true);
  assert.equal(byName.get("c")?.hidden, false);
  assert.equal(grid.summary, null);
  grid.dispose();
});

test("reloading remaps sort and filters by name after a schema-less loading response", async () => {
  const first = new ArraySource({
    columns: ["name", "age", "removed"],
    rows: [
      ["Ada", 30, "x"],
      ["Ada", 40, "x"],
      ["Bob", 50, "x"],
    ],
  });
  const second = new ArraySource({
    columns: ["age", "name"],
    rows: [
      [30, "Ada"],
      [40, "Ada"],
      [50, "Bob"],
    ],
  });
  let current = first;
  let loading = false;
  const source: TableSource = {
    info: async () => {
      const info = { ...(await current.info()), revision: current === first ? "1" : "2" };
      if (loading) {
        loading = false;
        return { ...info, columns: [], rowCount: null, readableRows: 0, status: "loading" };
      }
      return info;
    },
    createView: (query, signal) => current.createView(query, signal),
    readRows: (request) => current.readRows(request),
  };
  const grid = await readyGrid(source);
  try {
    await grid.setQuery({
      sort: [
        { column: 1, direction: "desc" },
        { column: 2, direction: "asc" },
      ],
      filters: [
        { type: "values", column: 0, values: ["Ada"] },
        { type: "values", column: 2, values: ["x"] },
      ],
      search: "Ada",
    });
    current = second;
    loading = true;
    grid.reload();
    await until(() => grid.info?.revision === "2" && grid.status === "ready" && !grid.viewPending);
    assert.equal(grid.viewError, null);
    assert.equal(grid.rowCount, 2);
    assert.deepEqual(grid.query, {
      sort: [{ column: 0, direction: "desc" }],
      filters: [{ type: "values", column: 1, values: ["Ada"] }],
      search: "Ada",
    });
    assert.deepEqual((await grid.source.readRows({ view: grid.view.id, start: 0, end: 2, columns: [0, 1] })).columns, [
      [40, 30],
      ["Ada", "Ada"],
    ]);
  } finally {
    grid.dispose();
  }
});

test("reloading removes query keys for columns that no longer exist", async () => {
  const first = new ArraySource({
    columns: ["removed", "kept"],
    rows: [
      ["x", "Ada"],
      ["y", "Bob"],
    ],
  });
  const second = new ArraySource({ columns: ["kept"], rows: [["Ada"], ["Bob"]] });
  let current = first;
  const source: TableSource = {
    info: async () => ({ ...(await current.info()), revision: current === first ? "1" : "2" }),
    createView: (query, signal) => current.createView(query, signal),
    readRows: (request) => current.readRows(request),
  };
  const grid = await readyGrid(source);
  try {
    await grid.setQuery({
      sort: [{ column: 0, direction: "asc" }],
      filters: [{ type: "text", column: 0, op: "equals", value: "x" }],
    });
    current = second;
    grid.reload();
    await until(() => grid.info?.revision === "2" && !grid.viewPending);
    assert.deepEqual(grid.query, { sort: [], filters: [] });
    assert.equal(grid.view.id, null);
    assert.equal(grid.rowCount, 2);
  } finally {
    grid.dispose();
  }
});

test("queries set before the first schema arrives keep their column indexes", async () => {
  const source = new ArraySource({
    columns: ["name", "age"],
    rows: [
      ["Ada", 30],
      ["Bob", 40],
    ],
  });
  const info = source.info.bind(source);
  let loading = true;
  source.info = async () => {
    const result = await info();
    if (!loading) return result;
    loading = false;
    return { ...result, columns: [], status: "loading", rowCount: null, readableRows: 0 };
  };
  const grid = new GridController(source, { ...options });
  try {
    const query: ViewQuery = { filters: [{ type: "values", column: 0, values: ["Ada"] }] };
    await grid.setQuery(query);
    grid.start();
    await until(() => grid.status === "ready" && !grid.viewPending);
    assert.deepEqual(grid.query, query);
    assert.equal(grid.rowCount, 1);
  } finally {
    grid.dispose();
  }
});

test("the filter panel keeps numbers that a JavaScript number cannot hold exactly as text", () => {
  assert.equal(comparable("1,234", "integer"), 1234);
  assert.equal(comparable("2.5", "bigint"), 2.5);
  assert.equal(comparable("9007199254740993", "bigint"), "9007199254740993");
  assert.equal(comparable("9,007,199,254,740,993", "bigint"), "9007199254740993");
  assert.equal(comparable("12.30", "decimal"), "12.30");
  assert.equal(comparable("abc", "integer"), "abc");
  assert.equal(comparable("2024-01-02", "date"), "2024-01-02");
});

test("column formats change the shown text, not the values", async () => {
  const source = new ArraySource({
    columns: [
      { name: "item", type: "string" },
      { name: "price", type: "decimal" },
    ],
    rows: [
      ["b", "1234.5"],
      ["a", "99.125"],
      ["c", "9007199254740993.5"],
    ],
  });
  const grid = new GridController(source, {
    ...options,
    locale: "en-US",
    columnFormats: { price: { label: "Price (USD)", number: { style: "currency", currency: "USD" } } },
  });
  grid.start();
  while (grid.info?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 1));
  grid.cache.want(0, 3, [0, 1]);
  await until(() => grid.value(2, 1) !== undefined);
  assert.equal(grid.columnLabel(1), "Price (USD)");
  assert.equal(grid.formatterOf(1).format(grid.value(2, 1) ?? null), "$9,007,199,254,740,993.50");
  // Sorting uses the values.
  await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
  grid.cache.want(0, 3, [0, 1]);
  await until(() => grid.value(2, 1) !== undefined);
  assert.deepEqual(
    [0, 1, 2].map((row) => grid.value(row, 0)),
    ["c", "b", "a"],
  );
  // Copies are the values by default, and the shown text with copyValues: "formatted".
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 1, col: 1 }, "extend");
  assert.equal(grid.copySelectionSync({ headers: true })?.text, "item\tprice\nc\t9007199254740993.5\nb\t1234.5");
  grid.options.copyValues = "formatted";
  assert.equal(
    grid.copySelectionSync({ headers: true })?.text,
    "item\tPrice (USD)\nc\t$9,007,199,254,740,993.50\nb\t$1,234.50",
  );
  assert.equal(
    grid.copySelectionSync({ markdown: true })?.text,
    "| item | Price (USD) |\n| --- | --- |\n| c | $9,007,199,254,740,993.50 |\n| b | $1,234.50 |",
  );
  grid.dispose();
});

test("changing column formats redraws and fits the columns again", async () => {
  const source = new ArraySource({
    columns: [
      { name: "id", type: "integer" },
      { name: "ratio", type: "float" },
    ],
    rows: [
      [1, 0.5],
      [2, 0.25],
    ],
  });
  const grid = new GridController(source, { ...options, locale: "en-US" });
  // 10 px per character.
  grid.measure = (text) => text.length * 10;
  grid.start();
  while (grid.info?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 1));
  grid.cache.want(0, 2, [0, 1]);
  await until(() => grid.visible[1].width !== 110);
  const before = grid.visible[1].width;
  const version = grid.formatVersion;
  // The same settings in a new object change nothing.
  grid.setColumnFormats({});
  assert.equal(grid.formatVersion, version);
  const label = "A much longer label for the ratio";
  grid.setColumnFormats({ ratio: { label, number: { style: "percent", fractionDigits: 4 } } });
  assert.ok(grid.formatVersion > version, "cached text is rebuilt");
  assert.equal(grid.formatterOf(1).format(0.25), "25.0000%");
  assert.ok(grid.visible[1].width > before, "the column fits its new label");
  assert.equal(grid.visible[1].width, Math.min(240, label.length * 10 + 62));
  grid.setColumnFormats({ ratio: { label, number: { style: "percent", fractionDigits: 4 } } });
  assert.equal(grid.formatVersion, version + 1, "equal settings are not applied again");
  // Columns the user sized keep their width.
  grid.resizeColumn(1, 80);
  grid.setColumnFormats({});
  assert.equal(grid.visible[1].width, 80);
  assert.equal(grid.columnLabel(1), "ratio");
  grid.dispose();
});

test("invalid column formats are refused when they are set", () => {
  const source = new ArraySource({ columns: ["price"], rows: [[1]] });
  assert.throws(
    () => new GridController(source, { ...options, columnFormats: { price: { number: { style: "currency" } } } }),
    RangeError,
  );
  const grid = new GridController(source, { ...options });
  assert.throws(() => grid.setColumnFormats({ price: { date: { timeZone: "Nowhere/City" } } }), RangeError);
  assert.deepEqual(grid.options.columnFormats, {}, "the previous settings stay");
  grid.dispose();
});

/** A table of 8 rows whose cells read as their column name and row, such as "c3". */
function lettered() {
  const columns = ["a", "b", "c", "d", "e"];
  return new ArraySource({
    columns,
    rows: Array.from({ length: 8 }, (_, row) => columns.map((name) => `${name}${row}`)),
  });
}

test("ranges with the same rows copy side by side in display order, without hidden columns", async () => {
  const grid = await readyGrid(lettered());
  grid.moveColumn(4, 0); // e a b c d
  grid.hideColumn(2); // e a c d
  grid.selection.select({ row: 1, col: 2 });
  grid.selection.select({ row: 2, col: 3 }, "extend");
  grid.selection.select({ row: 1, col: 0 }, "add");
  grid.selection.select({ row: 2, col: 0 }, "extend");
  // Not loaded yet: the cells are read.
  assert.equal(grid.copySelectionSync({}), null);
  const copied = await grid.copySelection({ headers: true });
  assert.equal(copied.text, "e\tc\td\ne1\tc1\td1\ne2\tc2\td2");
  assert.equal(copied.cells, 6);
  assert.equal(
    copied.html,
    '<meta charset="utf-8"><table><tr><th>e</th><th>c</th><th>d</th></tr><tr><td>e1</td><td>c1</td><td>d1</td></tr><tr><td>e2</td><td>c2</td><td>d2</td></tr></table>',
  );
  // Once loaded, the browser's copy event answers with the same text.
  grid.cache.want(0, 8, [0, 1, 2, 3, 4]);
  await until(() => grid.copySelectionSync({}) !== null);
  assert.equal(grid.copySelectionSync({ headers: true })?.text, copied.text);
  grid.dispose();
});

test("ranges with the same columns are stacked in view order and overlaps are copied once", async () => {
  const grid = await readyGrid(lettered());
  grid.selection.select({ row: 5, col: 1 });
  grid.selection.select({ row: 6, col: 2 }, "extend");
  grid.selection.select({ row: 0, col: 1 }, "add");
  grid.selection.select({ row: 1, col: 2 }, "extend");
  grid.selection.select({ row: 1, col: 1 }, "add");
  grid.selection.select({ row: 2, col: 2 }, "extend");
  const expected = [
    "| b | c |",
    "| --- | --- |",
    "| b0 | c0 |",
    "| b1 | c1 |",
    "| b2 | c2 |",
    "| b5 | c5 |",
    "| b6 | c6 |",
  ];
  assert.equal((await grid.copySelection({ markdown: true })).text, expected.join("\n"));
  grid.dispose();
});

test("ranges with other rows and columns are refused, and the limit applies to all ranges", async () => {
  const grid = new GridController(lettered(), { ...options, copyLimit: 5 });
  grid.start();
  await until(() => grid.info?.status === "ready");
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 1, col: 1 }, "add");
  assert.equal(grid.copySelectionSync({}), null);
  await assert.rejects(grid.copySelection({}), CopyRangesError);
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 2, col: 0 }, "extend");
  grid.selection.select({ row: 0, col: 2 }, "add");
  grid.selection.select({ row: 2, col: 2 }, "extend");
  await assert.rejects(grid.copySelection({}), CopyTooLargeError);
  grid.dispose();
});

test("a copy of several ranges can be canceled, and a failed read is reported", async () => {
  const source = lettered();
  const readRows = source.readRows.bind(source);
  const requests: RowRequest[] = [];
  let release = () => {};
  let fail = false;
  source.readRows = async (request: RowRequest, signal?: AbortSignal) => {
    if (request.textLimit === undefined) return readRows(request, signal);
    requests.push(request);
    if (fail) throw new Error("disk read failed");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return readRows(request, signal);
  };
  const grid = await readyGrid(source);
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 4, col: 0 }, "add");
  const abort = new AbortController();
  const task = grid.copySelection({}, abort.signal);
  await until(() => requests.length === 1);
  abort.abort();
  release();
  await assert.rejects(task, (error: unknown) => error instanceof Error && error.name === "AbortError");
  // The second range was not read after the cancel.
  assert.equal(requests.length, 1);
  fail = true;
  await assert.rejects(grid.copySelection({}), /disk read failed/);
  grid.dispose();
});
