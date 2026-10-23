import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, SourceError, type ViewQuery } from "vastgrid-core";
import { GridController } from "../src/controller.ts";

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

async function readyGrid(source: ArraySource) {
  const grid = new GridController(source, { ...options });
  grid.start();
  while (grid.info?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 1));
  return grid;
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
