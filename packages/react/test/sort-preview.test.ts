import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, SourceError, type TableSource, type ViewInfo, type ViewQuery } from "vastgrid-core";
import { GridController, ViewBuildingError } from "../src/controller.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

const READABLE = 2;

/**
 * A source whose sorted views show their first two rows until `finish(query)` is called, like a server
 * that sorts a large table in the background.
 */
function sortingSource({ poll = true } = {}) {
  const source = new ArraySource({
    columns: ["name", "born"],
    rows: [
      ["Ada", 1815],
      ["Grace", 1906],
      ["Linus", 1969],
      ["Barbara", 1939],
      ["Ken", 1943],
    ],
  });
  const finished = new Set<string>();
  const waiting = new Map<string, () => void>();
  const queries = new Map<string, string>();
  const polls: string[] = [];
  const createView = source.createView.bind(source);
  const readRows = source.readRows.bind(source);
  const state = (view: ViewInfo): ViewInfo => {
    const key = JSON.stringify(view.query);
    return finished.has(key)
      ? { ...view, status: "ready", readableRows: view.rowCount }
      : { ...view, status: "building", readableRows: Math.min(READABLE, view.rowCount) };
  };
  const views = new Map<string, ViewInfo>();
  const wrapped: TableSource & {
    finish: (query: ViewQuery) => void;
    polls: string[];
  } = {
    info: (signal) => source.info(signal),
    async createView(query, signal, viewOptions) {
      const view = await createView(query, signal);
      if (view.id === null) return view;
      views.set(view.id, view);
      queries.set(view.id, JSON.stringify(query));
      const key = JSON.stringify(query);
      if (!viewOptions?.preview && !finished.has(key)) {
        await new Promise<void>((resolve) => waiting.set(key, resolve));
      }
      return state(view);
    },
    readRows(request, signal) {
      const view = request.view === null ? null : views.get(request.view);
      if (view && state(view).status === "building" && request.end > READABLE) {
        return Promise.reject(new SourceError("not_ready", "Still sorting.", 409));
      }
      return readRows(request, signal);
    },
    aggregate: (request, signal) => source.aggregate(request, signal),
    columnStats: (view, column, signal) => source.columnStats(view, column, signal),
    find: (request, signal) => source.find(request, signal),
    finish(query) {
      const key = JSON.stringify(query);
      finished.add(key);
      waiting.get(key)?.();
    },
    polls,
  };
  if (poll) {
    wrapped.viewInfo = async (id) => {
      polls.push(queries.get(id) ?? "");
      const view = views.get(id);
      if (!view) throw new SourceError("view_not_found", "gone", 404);
      return state(view);
    };
  }
  return wrapped;
}

async function readyGrid(source: TableSource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  while (grid.info?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 1));
  return grid;
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

const byBirth: ViewQuery = { sort: [{ column: 1, direction: "asc" }] };

test("a sort shows its first rows at once and the rest when it is ready", async () => {
  const source = sortingSource();
  const grid = await readyGrid(source);
  await grid.setQuery(byBirth);
  assert.equal(grid.viewPending, false);
  assert.equal(grid.viewBuilding, true);
  assert.equal(grid.rowCount, 5);
  assert.equal(grid.readableRows, READABLE);
  // Every row can be selected; the first ones can be copied, the others wait for the sort.
  grid.selection.select({ row: 0, col: 0 });
  grid.selection.select({ row: 1, col: 0 }, "extend");
  assert.equal((await grid.copySelection({})).text, "Ada\nGrace");
  grid.selection.select({ row: 4, col: 1 }, "extend");
  await assert.rejects(grid.copySelection({}), ViewBuildingError);
  grid.selectionChanged();
  assert.equal(grid.summary, null);
  assert.equal(grid.summaryPending, true);
  await assert.rejects(grid.find("Ken", 1, false), ViewBuildingError);
  // A sort keeps the rows of the table, so their statistics are known; a filter's are not yet.
  assert.equal(grid.statsAvailable, true);
  source.finish(byBirth);
  await until(() => !grid.viewBuilding);
  assert.equal(grid.readableRows, 5);
  assert.equal(grid.view.status, "ready");
  assert.match((await grid.copySelection({})).text, /Linus\t1969$/);
  await until(() => grid.summary !== null);
  assert.equal(grid.summary?.numericCount, 5);
  assert.equal(await grid.find("Ken", 1, false), true);
  grid.dispose();
});

test("a newer query stops following an older view that is still building", async () => {
  const source = sortingSource();
  const grid = await readyGrid(source);
  await grid.setQuery(byBirth);
  const older = grid.view.id;
  await until(() => source.polls.length > 0);
  const filtered: ViewQuery = { ...byBirth, filters: [{ type: "compare", column: 1, op: "gt", value: 1900 }] };
  await grid.setQuery(filtered);
  assert.notEqual(grid.view.id, older);
  assert.equal(grid.statsAvailable, false);
  assert.equal(grid.stats(0), null);
  const polled = source.polls.length;
  // The old view finishes; its state must not replace the current one.
  source.finish(byBirth);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(grid.viewBuilding, true);
  assert.equal(grid.view.rowCount, 4);
  assert.equal(grid.readableRows, READABLE);
  assert.ok(source.polls.slice(polled).every((query) => query === JSON.stringify(filtered)));
  source.finish(filtered);
  await until(() => !grid.viewBuilding);
  assert.equal(grid.readableRows, 4);
  grid.dispose();
});

test("sources without viewInfo are asked for the view without a preview", async () => {
  const source = sortingSource({ poll: false });
  const grid = await readyGrid(source);
  await grid.setQuery(byBirth);
  assert.equal(grid.viewBuilding, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  source.finish(byBirth);
  await until(() => !grid.viewBuilding);
  assert.equal(grid.readableRows, 5);
  grid.dispose();
});

test("stopping and starting the grid resumes following a view that is building", async () => {
  const source = sortingSource();
  const grid = await readyGrid(source);
  await grid.setQuery(byBirth);
  grid.stop();
  source.finish(byBirth);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(grid.viewBuilding, true);
  grid.start();
  await until(() => !grid.viewBuilding);
  grid.dispose();
});
