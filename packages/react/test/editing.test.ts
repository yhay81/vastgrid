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

test("target cells read the rows' positions of a view when they are not loaded", async () => {
  const columnData: CellValue[][] = [Array.from({ length: 1000 }, (_, index) => index)];
  const grid = await mounted(
    new ArraySource({ columns: [{ name: "n", type: "integer" }], columnData, editable: true }),
  );
  await grid.setQuery({ sort: [{ column: 0, direction: "desc" }] });
  const cells = await grid.edits.targetCells(900, 902, [0]);
  assert.deepEqual(
    cells.map(({ rowId, previous }) => [rowId, previous]),
    [
      [99, undefined],
      [98, undefined],
    ],
  );
  grid.dispose();
});
