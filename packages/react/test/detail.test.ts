import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, MAX_TEXT_LIMIT, type RowBlock, type RowRequest, type TableInfo } from "vastgrid-core";
import { GridController } from "../src/controller.ts";
import { DetailTracker, detailKeyAction } from "../src/detail.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

const long = "A note that is longer than the table shows";

/** A table that cuts text longer than 10 characters unless asked for whole values, like the engines. */
class CuttingSource extends ArraySource {
  revision = 1;
  fullReads: RowRequest[] = [];
  failNext = false;
  /** Holds full reads until released, to see them cancelled. */
  hold: Promise<void> | null = null;

  constructor() {
    super({
      columns: ["name", "born", "note"],
      rows: [
        ["Ada", 1815, long],
        ["Grace", 1906, "short"],
        ["Linus", 1969, null],
      ],
    });
  }

  override async info(): Promise<TableInfo> {
    return { ...(await super.info()), revision: this.revision };
  }

  override async readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock> {
    if (request.textLimit === MAX_TEXT_LIMIT) {
      this.fullReads.push(request);
      if (this.hold) await this.hold;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.failNext) {
        this.failNext = false;
        throw new Error("The table server stopped.");
      }
      return super.readRows(request);
    }
    const block = await super.readRows(request);
    const cut = (value: unknown) => (typeof value === "string" && value.length > 10 ? `${value.slice(0, 10)}…` : value);
    return { ...block, columns: block.columns.map((column) => column.map(cut) as typeof column) };
  }
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function setup(delay = 10) {
  const source = new CuttingSource();
  const grid = new GridController(source, { ...options });
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  const tracker = new DetailTracker(grid, { delay });
  return { source, grid, tracker };
}

function moveTo(grid: GridController, row: number, col = 0) {
  grid.selection.select({ row, col });
  grid.selectionChanged();
}

test("the record shows loaded rows at once and reads only cut or missing values in full", async () => {
  const { source, grid, tracker } = await setup();
  try {
    grid.cache.want(0, 3, [0, 1, 2]);
    await until(() => grid.cache.value(2, 0) !== undefined);
    moveTo(grid, 1);
    tracker.start();
    // Nothing of row 1 is cut: no request.
    assert.deepEqual(tracker.record, {
      row: 1,
      rowId: 1,
      values: ["Grace", 1906, "short"],
      status: "ready",
      error: null,
    });
    moveTo(grid, 0);
    assert.equal(tracker.record?.status, "loading");
    assert.equal(tracker.record?.values[2], "A note tha…");
    await until(() => tracker.record?.status === "ready");
    assert.deepEqual(tracker.record?.values, ["Ada", 1815, long]);
    assert.equal(source.fullReads.length, 1);
    assert.deepEqual(source.fullReads[0].columns, [2]);
    assert.equal(source.fullReads[0].start, 0);
    // Moving within the row, or hiding and moving columns, keeps the record.
    const before = tracker.record;
    moveTo(grid, 0, 2);
    grid.moveColumn(2, 0);
    grid.hideColumn(1);
    assert.equal(tracker.record, before);
    assert.equal(source.fullReads.length, 1);
  } finally {
    tracker.stop();
    grid.dispose();
  }
});

test("moving quickly reads only the row where the cell stops, and cancels a read under way", async () => {
  const { source, grid, tracker } = await setup(30);
  try {
    tracker.start();
    for (const row of [0, 1, 2, 1, 0, 2]) moveTo(grid, row);
    await until(() => tracker.record?.status === "ready");
    assert.equal(tracker.record?.row, 2);
    assert.deepEqual(tracker.record?.values, ["Linus", 1969, null]);
    assert.equal(source.fullReads.length, 1);
    assert.equal(source.fullReads[0].start, 2);

    let release: () => void = () => {};
    source.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    moveTo(grid, 0);
    await until(() => source.fullReads.length === 2);
    moveTo(grid, 1);
    release();
    source.hold = null;
    await until(() => tracker.record?.row === 1 && tracker.record.status === "ready");
    assert.deepEqual(tracker.record?.values, ["Grace", 1906, "short"]);
    // The read of row 0 was cancelled and never replaced the record.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(tracker.record?.row, 1);
  } finally {
    tracker.stop();
    grid.dispose();
  }
});

test("a failed read is reported and can be retried", async () => {
  const { source, grid, tracker } = await setup();
  try {
    source.failNext = true;
    tracker.start();
    await until(() => tracker.record?.status === "error");
    assert.equal(tracker.record?.error, "The table server stopped.");
    tracker.retry();
    assert.equal(tracker.record?.status, "loading");
    await until(() => tracker.record?.status === "ready");
    assert.deepEqual(tracker.record?.values, ["Ada", 1815, long]);
  } finally {
    tracker.stop();
    grid.dispose();
  }
});

test("after sorting, filtering or reloading, the record follows the new active row", async () => {
  const { source, grid, tracker } = await setup();
  try {
    tracker.start();
    moveTo(grid, 1);
    await until(() => tracker.record?.status === "ready");
    assert.equal(tracker.record?.values[0], "Grace");

    // A new view starts at its first row: the newest person, the last row of the table.
    await grid.setQuery({ sort: [{ column: 1, direction: "desc" }] });
    await until(() => tracker.record?.status === "ready");
    assert.equal(tracker.record?.row, 0);
    assert.equal(tracker.record?.rowId, 2);
    assert.deepEqual(tracker.record?.values, ["Linus", 1969, null]);

    await grid.setQuery({ filters: [{ column: 0, op: "eq", value: "Nobody" }] });
    await until(() => grid.rowCount === 0);
    assert.equal(tracker.record, null);

    await grid.setQuery({});
    moveTo(grid, 1);
    await until(() => tracker.record?.row === 1 && tracker.record.status === "ready");
    // Reading an unchanged table again keeps the record.
    const kept = tracker.record;
    const reads = source.fullReads.length;
    grid.reload();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tracker.record, kept);
    assert.equal(source.fullReads.length, reads);
    // A changed table is read again where the grid was: the record of the kept active row is read anew.
    source.revision = 2;
    grid.reload();
    await until(() => source.fullReads.length > reads && tracker.record?.status === "ready");
    assert.equal(tracker.record?.row, 1);
    assert.equal(tracker.record?.values[0], "Grace");
  } finally {
    tracker.stop();
    grid.dispose();
  }
});

test("stopping cancels the read and clears the record", async () => {
  const { source, grid, tracker } = await setup(20);
  try {
    let version = tracker.getVersion();
    const stop = tracker.subscribe(() => {
      version = tracker.getVersion();
    });
    tracker.start();
    assert.equal(tracker.record?.status, "loading");
    tracker.stop();
    assert.equal(tracker.record, null);
    assert.equal(version, tracker.getVersion());
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(source.fullReads.length, 0);
    stop();
  } finally {
    grid.dispose();
  }
});

test("keys open, close and move the focus between the grid and the detail panel", () => {
  const key = (key: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  assert.equal(detailKeyAction(key("Enter", { altKey: true }), "grid", false), "open");
  assert.equal(detailKeyAction(key("Enter", { altKey: true }), "grid", true), "focusPanel");
  assert.equal(detailKeyAction(key("Enter", { altKey: true }), "panel", true), "focusGrid");
  assert.equal(detailKeyAction(key("Escape"), "grid", true), "close");
  assert.equal(detailKeyAction(key("Escape"), "panel", true), "close");
  assert.equal(detailKeyAction(key("Escape"), "grid", false), null);
  // Enter alone moves the active cell, and other modifiers are left to the grid and the browser.
  assert.equal(detailKeyAction(key("Enter"), "grid", true), null);
  assert.equal(detailKeyAction(key("Enter", { altKey: true, shiftKey: true }), "grid", false), null);
  assert.equal(detailKeyAction(key("Enter", { altKey: true, metaKey: true }), "grid", false), null);
});
