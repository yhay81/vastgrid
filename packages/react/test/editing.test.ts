import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue, SourceError, type TableSource, type UpdateRequest } from "vastgrid-core";
import { GridController, type GridOptions } from "../src/controller.ts";
import type { GridCellsChangeEvent } from "../src/editing.ts";

const options: GridOptions = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
  changeDelay: 10,
};

function people(editable = true) {
  return new ArraySource({
    columns: [
      { name: "name", type: "string" },
      { name: "age", type: "integer" },
      { name: "price", type: "decimal", sourceType: "DECIMAL(6,2)" },
      { name: "id", type: "integer", readOnly: true },
    ],
    rows: [
      ["Ada", 36, "1.50", 1],
      ["Grace", 85, "2.00", 2],
      ["Linus", 54, "3.25", 3],
    ],
    editable,
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function mounted(source: TableSource, extra: Partial<GridOptions> = {}) {
  const grid = new GridController(source, { ...options, ...extra });
  grid.attach({ scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement, { style: {} } as unknown as HTMLElement);
  grid.setViewport(400, 32 + 24 * 5);
  grid.start();
  await until(() => grid.info?.status === "ready");
  const last = grid.schema.length - 1;
  grid.cache.want(
    0,
    3,
    grid.schema.map((_, index) => index),
  );
  await until(() => grid.value(2, last) !== undefined);
  return grid;
}

function column(grid: GridController, col: number) {
  return [0, 1, 2].map((row) => grid.value(row, col));
}

test("a grid edits only sources that can write, and not read-only columns", async () => {
  const readOnly = await mounted(people(false));
  assert.equal(readOnly.edits.enabled, false);
  assert.equal(readOnly.edits.cellEditable(0, 0), false);
  const optedOut = await mounted(people(), { readOnly: true });
  assert.equal(optedOut.edits.enabled, false);
  const grid = await mounted(people());
  assert.equal(grid.edits.enabled, true);
  assert.equal(grid.edits.cellEditable(0, 0), true);
  assert.equal(grid.edits.cellEditable(0, 3), false, "read-only column");
  for (const item of [readOnly, optedOut, grid]) item.dispose();
});

test("typed values are checked, written, and shown while they save", async () => {
  const source = people();
  const requests: UpdateRequest[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: TableSource = Object.assign(Object.create(source), {
    updateCells: async (request: UpdateRequest) => {
      requests.push(request);
      await gate;
      return source.updateCells(request);
    },
  });
  const grid = await mounted(slow);
  const events: GridCellsChangeEvent[] = [];
  grid.edits.onChange((event) => events.push(event));
  const refused = await grid.edits.prepare([{ row: 0, col: 2, text: "1.234", previous: "1.50" }], "edit");
  assert.deepEqual(refused.ok ? null : refused.problems[0].problem, { kind: "input", error: "scale" });
  const readOnly = await grid.edits.prepare([{ row: 0, col: 3, text: "5" }], "edit");
  assert.deepEqual(readOnly.ok ? null : readOnly.problems[0].problem, { kind: "readOnly" });
  const unchanged = await grid.edits.prepare([{ row: 0, col: 1, text: "36", previous: 36 }], "edit");
  assert.deepEqual(unchanged, { ok: true, changes: [] });
  const prepared = await grid.edits.prepare([{ row: 1, col: 1, text: " 86 ", previous: 85 }], "edit");
  assert.ok(prepared.ok);
  const saved = grid.edits.write(prepared.changes, "edit");
  assert.equal(grid.value(1, 1), 86, "shown while saving");
  assert.equal(grid.edits.stateOf(1, 1), "saving");
  assert.equal(grid.edits.saving, 1);
  release();
  assert.equal(await saved, true);
  assert.deepEqual(requests[0], { updates: [{ row: 1, column: 1, value: 86, previous: 85 }] });
  assert.equal(grid.edits.stateOf(1, 1), null);
  assert.equal(events[0].status, "saved");
  assert.deepEqual(events[0].changes, [{ rowId: 1, column: 1, value: 86, previous: 85 }]);
  assert.deepEqual(grid.info?.edits, { version: 1, cells: 1 });
  grid.dispose();
});

test("validateCell refuses values, also asynchronously", async () => {
  const grid = await mounted(people(), {
    validateCell: async (cell) => (cell.column === 1 && Number(cell.value) > 150 ? "Too old" : null),
  });
  const result = await grid.edits.prepare([{ row: 0, col: 1, text: "200" }], "edit");
  assert.deepEqual(result.ok ? null : result.problems[0].problem, { kind: "invalid", message: "Too old" });
  grid.dispose();
});

test("a failed write shows the source's values again, and can be retried or discarded", async () => {
  const source = people();
  let fail: SourceError | null = new SourceError("internal_error", "Disk full", 500);
  const flaky: TableSource = Object.assign(Object.create(source), {
    updateCells: async (request: UpdateRequest) => {
      if (fail) throw fail;
      return source.updateCells(request);
    },
  });
  const grid = await mounted(flaky);
  const events: GridCellsChangeEvent[] = [];
  grid.edits.onChange((event) => events.push(event));
  const prepared = await grid.edits.prepare([{ row: 0, col: 0, text: "Ada L.", previous: "Ada" }], "edit");
  assert.ok(prepared.ok);
  assert.equal(await grid.edits.write(prepared.changes, "edit"), false);
  assert.equal(grid.value(0, 0), "Ada", "the old value again");
  assert.equal(grid.edits.stateOf(0, 0), "failed");
  assert.equal(grid.edits.failed?.error?.message, "Disk full");
  assert.equal(events[0].status, "failed");
  fail = null;
  assert.equal(await grid.edits.retry(), true);
  assert.equal(grid.edits.failed, null);
  await until(() => grid.value(0, 0) === "Ada L.");
  // A conflict: the user may overwrite, which sends the write without the previous values.
  fail = new SourceError("edit_conflict", "Changed", 409);
  const second = await grid.edits.prepare([{ row: 1, col: 0, text: "G", previous: "Grace" }], "edit");
  assert.ok(second.ok);
  await grid.edits.write(second.changes, "edit");
  assert.equal(grid.edits.failed?.error?.code, "edit_conflict");
  assert.ok(grid.edits.retryable(grid.edits.failed as NonNullable<typeof grid.edits.failed>));
  grid.edits.discard();
  assert.equal(grid.edits.failed, null);
  assert.equal(grid.edits.stateOf(1, 0), null);
  grid.dispose();
});

test("writes keep the view's rows in order, and a sorted view is sorted again by the new values", async () => {
  const grid = await mounted(people());
  await grid.setQuery({ sort: [{ column: 1, direction: "asc" }] });
  grid.cache.want(0, 3, [0, 1, 2, 3]);
  await until(() => grid.value(2, 0) !== undefined);
  assert.deepEqual(column(grid, 0), ["Ada", "Linus", "Grace"]);
  const prepared = await grid.edits.prepare([{ row: 0, col: 1, text: "99", previous: 36 }], "edit");
  assert.ok(prepared.ok);
  assert.equal(prepared.changes[0].rowId, 0, "named by the row's position in the table");
  await grid.edits.write(prepared.changes, "edit");
  await until(() => !grid.viewPending);
  grid.cache.want(0, 3, [0, 1, 2, 3]);
  await until(() => grid.value(2, 0) !== undefined);
  assert.deepEqual(column(grid, 0), ["Linus", "Grace", "Ada"]);
  // A write to a column the view does not depend on keeps the view.
  const view = grid.view.id;
  const name = await grid.edits.prepare([{ row: 0, col: 0, text: "Linus T." }], "edit");
  assert.ok(name.ok);
  await grid.edits.write(name.changes, "edit");
  assert.equal(grid.view.id, view);
  grid.cache.want(0, 3, [0, 1, 2, 3]);
  await until(() => grid.value(0, 0) === "Linus T.");
  grid.dispose();
});

test("another grid's writes are read again; the grid's own are not read twice", async () => {
  const source = people();
  const first = await mounted(source);
  const second = await mounted(source);
  let infos = 0;
  const info = source.info.bind(source);
  source.info = async () => {
    infos++;
    return info();
  };
  const prepared = await first.edits.prepare([{ row: 2, col: 0, text: "Linus T." }], "edit");
  assert.ok(prepared.ok);
  await first.edits.write(prepared.changes, "edit");
  await until(() => {
    second.cache.want(0, 3, [0, 1, 2, 3]);
    return second.value(2, 0) === "Linus T.";
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(infos, 1, "only the other grid reads the table again");
  first.dispose();
  second.dispose();
});

test("target cells read the rows' positions and values of a view when they are not loaded", async () => {
  const columnData: CellValue[][] = [Array.from({ length: 1000 }, (_, index) => index)];
  const grid = await mounted(
    new ArraySource({ columns: [{ name: "n", type: "integer" }], columnData, editable: true }),
  );
  await grid.setQuery({ sort: [{ column: 0, direction: "desc" }] });
  const cells = await grid.edits.targetCells(900, 902, [0]);
  assert.deepEqual(
    cells.map(({ rowId, previous }) => [rowId, previous]),
    [
      [99, 99],
      [98, 98],
    ],
  );
  grid.dispose();
});

test("pasted values go from the top-left cell, repeat over a multiple, and stop at the table's end", async () => {
  const grid = await mounted(people());
  const plan = async () =>
    (await grid.edits.pasteTargets([["a", "1"], ["b"]])).inputs.map((cell) => [cell.rowId, cell.column, cell.text]);
  grid.selection.select({ row: 1, col: 0 });
  assert.deepEqual(await plan(), [
    [1, 0, "a"],
    [1, 1, "1"],
    [2, 0, "b"],
    [2, 1, ""],
  ]);
  // Two rows of values cut at the end of the table.
  grid.selection.select({ row: 2, col: 2 });
  const cut = await grid.edits.pasteTargets([
    ["1", "2", "3"],
    ["4", "5", "6"],
  ]);
  assert.deepEqual([cut.cutRows, cut.cutCols], [1, 1]);
  assert.deepEqual(
    cut.inputs.map((cell) => cell.column),
    [2, 3],
    "the read-only column is returned so that the paste is refused",
  );
  const refused = await grid.edits.prepare(cut.inputs, "paste");
  assert.equal(refused.ok, false);
  // A selection twice the values' height repeats them.
  grid.selection.select({ row: 0, col: 1 });
  grid.selection.select({ row: 1, col: 1 }, "extend");
  const repeated = await grid.edits.pasteTargets([["7"]]);
  assert.deepEqual(
    repeated.inputs.map((cell) => cell.text),
    ["7", "7"],
  );
  // One value fills several ranges; more values cannot be pasted into them.
  grid.selection.select({ row: 0, col: 0 }, "add");
  assert.equal((await grid.edits.pasteTargets([["z"]])).inputs.length, 3);
  await assert.rejects(grid.edits.pasteTargets([["a", "b"]]), { name: "Error", message: /one range/ });
  grid.dispose();
});

test("a paste is checked as a whole and written as one write", async () => {
  const source = people();
  const grid = await mounted(source);
  grid.selection.select({ row: 0, col: 1 });
  const bad = await grid.edits.pasteTargets([
    ["40", "10,000.5"],
    ["x", "2"],
  ]);
  const refused = await grid.edits.prepare(bad.inputs, "paste");
  assert.ok(!refused.ok);
  assert.deepEqual(
    refused.problems.map((problem) => [problem.row, problem.col, problem.problem]),
    [
      [0, 2, { kind: "input", error: "precision" }],
      [1, 1, { kind: "input", error: "number" }],
    ],
  );
  const good = await grid.edits.pasteTargets([
    ["40", "1,000.5"],
    ["41", "2"],
  ]);
  const prepared = await grid.edits.prepare(good.inputs, "paste");
  assert.ok(prepared.ok);
  assert.equal(await grid.edits.write(prepared.changes, "paste"), true);
  const info = await source.info();
  assert.deepEqual(info.edits, { version: 1, cells: 4 });
  const rows = await source.readRows({ view: null, start: 0, end: 2, columns: [1, 2] });
  assert.deepEqual(rows.columns, [
    [40, 41],
    ["1000.5", "2"],
  ]);
  grid.dispose();
});

async function edit(grid: GridController, row: number, col: number, text: string) {
  const prepared = await grid.edits.prepare([{ row, col, text, previous: grid.value(row, col) }], "edit");
  assert.ok(prepared.ok);
  return grid.edits.write(prepared.changes, "edit");
}

async function read(source: ArraySource, column: number) {
  return (await source.readRows({ view: null, start: 0, end: 3, columns: [column] })).columns[0];
}

test("saved writes are undone and redone, a paste at once", async () => {
  const source = people();
  const grid = await mounted(source);
  const states: boolean[][] = [];
  grid.edits.onHistoryChange((state) => states.push([state.canUndo, state.canRedo]));
  assert.deepEqual(grid.edits.historyState.canUndo, false);
  await edit(grid, 0, 1, "37");
  grid.selection.select({ row: 0, col: 0 });
  const plan = await grid.edits.pasteTargets([["A"], ["B"], ["C"]]);
  const pasted = await grid.edits.prepare(plan.inputs, "paste");
  assert.ok(pasted.ok);
  await grid.edits.write(pasted.changes, "paste");
  assert.deepEqual(await read(source, 0), ["A", "B", "C"]);
  assert.equal(grid.edits.historyState.undoReason, "paste");
  assert.equal(await grid.edits.undo(), true);
  assert.deepEqual(await read(source, 0), ["Ada", "Grace", "Linus"], "the whole paste");
  assert.equal(await grid.edits.undo(), true);
  assert.deepEqual(await read(source, 1), [36, 85, 54]);
  assert.equal(await grid.edits.undo(), false, "nothing left");
  assert.equal(await grid.edits.redo(), true);
  assert.deepEqual(await read(source, 1), [37, 85, 54]);
  assert.deepEqual(grid.edits.historyState, {
    canUndo: true,
    canRedo: true,
    undo: 1,
    redo: 1,
    undoReason: "edit",
    redoReason: "paste",
  });
  // A new write drops what could be redone.
  await until(() => grid.value(0, 1) === 37);
  await edit(grid, 2, 1, "55");
  assert.equal(grid.edits.historyState.canRedo, false);
  assert.ok(states.some(([undo, redo]) => undo && redo));
  grid.dispose();
});

test("an undo refused because the cells changed meanwhile can overwrite them, and a new revision forgets the history", async () => {
  const source = people();
  const grid = await mounted(source);
  await edit(grid, 0, 0, "Ada L.");
  // Someone else changes the cell.
  await source.updateCells({ updates: [{ row: 0, column: 0, value: "Countess" }] });
  assert.equal(await grid.edits.undo(), false);
  assert.equal(grid.edits.failed?.error?.code, "edit_conflict");
  assert.equal(grid.edits.historyState.canUndo, false, "not while a write failed");
  assert.equal(await grid.edits.retry(true), true);
  assert.deepEqual((await read(source, 0))[0], "Ada");
  assert.equal(grid.edits.historyState.canRedo, true);
  grid.dispose();
});

test("a new revision of the table forgets what can be undone", async () => {
  const people1 = people();
  let revision = "1";
  const versioned: TableSource = Object.assign(Object.create(people1), {
    info: async () => ({ ...(await people1.info()), revision }),
    updateCells: (request: UpdateRequest) => people1.updateCells(request),
  });
  const grid = await mounted(versioned);
  await edit(grid, 1, 0, "G");
  assert.equal(grid.edits.historyState.canUndo, true);
  revision = "2";
  grid.reload();
  await until(() => grid.info?.revision === "2");
  assert.equal(grid.edits.historyState.canUndo, false);
  grid.dispose();
});

test("fill down and right copy the first row or column of each range, and undo at once", async () => {
  const source = people();
  const grid = await mounted(source);
  const fill = async (direction: "down" | "right", limit?: number) => {
    const inputs = await grid.edits.fillTargets(direction, limit);
    const prepared = await grid.edits.prepare(inputs, "fill");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    await grid.edits.write(prepared.changes, "fill");
    return inputs;
  };
  // Rows 0–2 of name and age: the first row goes down.
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 2, col: 1 }, "extend");
  const filled = await fill("down");
  assert.deepEqual(
    filled.map((cell) => [cell.row, cell.column, cell.text]),
    [
      [1, 0, "Ada"],
      [1, 1, "36"],
      [2, 0, "Ada"],
      [2, 1, "36"],
    ],
  );
  assert.deepEqual(await read(source, 0), ["Ada", "Ada", "Ada"]);
  assert.deepEqual(await read(source, 1), [36, 36, 36]);
  assert.equal(grid.edits.historyState.undoReason, "fill");
  assert.equal(await grid.edits.undo(), true);
  assert.deepEqual(await read(source, 1), [36, 85, 54], "one undo");
  // One cell takes the value above it; the decimal keeps its digits.
  await until(() => grid.value(1, 2) === "2.00");
  grid.selection.select({ row: 1, col: 2 });
  await fill("down");
  assert.deepEqual(await read(source, 2), ["1.50", "1.50", "3.25"]);
  // Right: the first column of the range into the columns right of it; a read-only target refuses the fill.
  grid.selection.select({ row: 0, col: 2 });
  grid.selection.select({ row: 0, col: 3 }, "extend");
  const refused = await grid.edits.prepare(await grid.edits.fillTargets("right"), "fill");
  assert.equal(refused.ok, false);
  // The age (an integer) filled into the price (a decimal) of the same row.
  grid.selection.select({ row: 2, col: 1 });
  grid.selection.select({ row: 2, col: 2 }, "extend");
  await fill("right");
  assert.deepEqual((await read(source, 2))[2], "54");
  // Nothing to fill from, and the limit.
  grid.selection.select({ row: 0, col: 0 });
  assert.deepEqual(await grid.edits.fillTargets("down"), []);
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 2, col: 1 }, "extend");
  await assert.rejects(grid.edits.fillTargets("down", 3), { message: /at most 3/ });
  grid.dispose();
});

test("fill reads the rows it fills when they are not loaded", async () => {
  const columnData: CellValue[][] = [Array.from({ length: 2000 }, (_, index) => `v${index}`)];
  const source = new ArraySource({ columns: [{ name: "s", type: "string" }], columnData, editable: true });
  const grid = await mounted(source);
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 1999, col: 0 }, "extend");
  const inputs = await grid.edits.fillTargets("down");
  assert.equal(inputs.length, 1999);
  assert.equal(inputs[1998].previous, "v1999", "the values before, for undo");
  const prepared = await grid.edits.prepare(inputs, "fill");
  assert.ok(prepared.ok);
  await grid.edits.write(prepared.changes, "fill");
  assert.equal(columnData[0][1999], "v0");
  assert.equal(await grid.edits.undo(), true);
  assert.equal(columnData[0][1999], "v1999");
  grid.dispose();
});
