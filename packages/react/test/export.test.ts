import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArraySource,
  ErrorCodes,
  type ExportRequest,
  type ExportResult,
  SourceError,
  type TableChangeListener,
  type TableInfo,
  type TableSource,
} from "vastgrid-core";
import { GridController } from "../src/controller.ts";
import {
  type ExportChoice,
  ExportInterruptedError,
  exportRequest,
  exportRowCount,
  exportSupport,
  fileNameFor,
  offeredFormats,
  runExport,
  xlsxLimit,
} from "../src/export.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

function people() {
  return new ArraySource({
    columns: [
      { name: "name", type: "string" },
      { name: "born", type: "integer" },
      { name: "score", type: "float" },
    ],
    rows: [
      ["Ada", 1815, 0.5],
      ["Grace", 1906, 0.25],
      ["Linus", 1969, 0.125],
    ],
  });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

async function readyGrid(source: TableSource, columnFormats = {}) {
  const grid = new GridController(source, { ...options, columnFormats });
  grid.start();
  await until(() => grid.info?.status === "ready" && !grid.viewPending);
  return grid;
}

const choice: ExportChoice = {
  format: "xlsx",
  rows: "view",
  columns: "visible",
  displaySettings: true,
  fileName: "people",
};

test("the request follows the view, the shown columns in display order and the column settings", async () => {
  const grid = await readyGrid(people(), {
    born: { label: "Born" },
    score: { label: "Score", number: { style: "percent", fractionDigits: 1 } },
  });
  await grid.setQuery({ filters: [{ type: "compare", column: 1, op: "gt", value: 1900 }] });
  await until(() => !grid.viewPending);
  grid.moveColumn(2, 0);
  grid.hideColumn(2);
  assert.deepEqual(
    grid.visible.map((column) => column.index),
    [2, 0],
  );
  const request = exportRequest(grid, choice);
  assert.deepEqual(request, {
    view: grid.view.id,
    format: "xlsx",
    columns: [2, 0],
    target: "people.xlsx",
    headers: ["Score", "name"],
    numberFormats: ["#,##0.0%", null],
  });
  assert.equal(exportRowCount(grid, "view"), 2);
  assert.equal(exportRowCount(grid, "table"), 3);
  // CSV gets the labels but no number formats; JSON and Parquet keep the names.
  assert.deepEqual(exportRequest(grid, { ...choice, format: "csv" }).headers, ["Score", "name"]);
  assert.equal(exportRequest(grid, { ...choice, format: "csv" }).numberFormats, undefined);
  assert.equal(exportRequest(grid, { ...choice, format: "json" }).headers, undefined);
  // Without display settings, the whole table and every column in schema order.
  assert.deepEqual(exportRequest(grid, { ...choice, rows: "table", columns: "all", displaySettings: false }), {
    view: null,
    format: "xlsx",
    columns: [0, 1, 2],
    target: "people.xlsx",
  });
  grid.dispose();
});

test("runs an export: the host picks the target and receives the data", async () => {
  const grid = await readyGrid(people());
  const seen: { result: ExportResult; target: string }[] = [];
  const done = await runExport(
    grid,
    { ...choice, format: "csv", fileName: "list.txt" },
    {
      target: (context) => {
        assert.equal(context.delivery, "data");
        assert.equal(context.rowCount, 3);
        assert.equal(context.request.target, "list.txt.csv");
        return "chosen.csv";
      },
      onExported: (result, context) => {
        seen.push({ result, target: context.request.target });
      },
    },
    new AbortController().signal,
  );
  assert.equal(done?.result.rows, 3);
  assert.equal(seen[0].target, "chosen.csv");
  assert.equal(await seen[0].result.data?.text(), "name,born,score\nAda,1815,0.5\nGrace,1906,0.25\nLinus,1969,0.125\n");
  // Returning null from `target` cancels before anything is written.
  let called = false;
  const cancelled = await runExport(
    grid,
    choice,
    {
      target: () => null,
      onExported: () => {
        called = true;
      },
    },
    new AbortController().signal,
  );
  assert.equal(cancelled, null);
  assert.equal(called, false);
  grid.dispose();
});

test("a source that writes files gets the target and is aborted by the signal", async () => {
  const requests: ExportRequest[] = [];
  const base = people();
  const source: TableSource = {
    info: async (): Promise<TableInfo> => {
      const info = await base.info();
      // A server from before `exports`: CSV, TSV, Parquet and JSON files.
      const { exports: _exports, ...rest } = info;
      return rest;
    },
    createView: (query, signal) => base.createView(query, signal),
    readRows: (request) => base.readRows(request),
    exportView: (request, signal) =>
      new Promise((_resolve, reject) => {
        requests.push(request);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  };
  const grid = await readyGrid(source);
  const support = exportSupport(grid.info, source.exportView);
  assert.deepEqual(support, { formats: ["csv", "tsv", "parquet", "json"], delivery: "file" });
  assert.deepEqual(offeredFormats(support as NonNullable<typeof support>, ["parquet", "xlsx"]), ["parquet"]);
  const controller = new AbortController();
  const running = runExport(
    grid,
    { ...choice, format: "parquet" },
    { target: ({ request }) => `exports/${request.target}` },
    controller.signal,
  );
  await until(() => requests.length === 1);
  assert.equal(requests[0].target, "exports/people.parquet");
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  grid.dispose();
});

test("export is not offered when the source cannot export", async () => {
  const info = await people().info();
  assert.equal(
    exportSupport({ ...info, capabilities: { ...info.capabilities, export: false } }, () => {}),
    null,
  );
  assert.equal(exportSupport(info, undefined), null);
  assert.equal(
    exportSupport({ ...info, status: "loading" }, () => {}),
    null,
  );
});

test("file names and Excel limits", () => {
  assert.equal(fileNameFor("report.csv", "xlsx"), "report.xlsx");
  assert.equal(fileNameFor("  ", "json"), "export.json");
  assert.equal(fileNameFor("a.b", "tsv"), "a.b.tsv");
  assert.equal(xlsxLimit(1_048_575, 16_384), null);
  assert.equal(xlsxLimit(1_048_576, 1), "rows");
  assert.equal(xlsxLimit(10, 16_385), "columns");
});

test("a change of the table during an export interrupts it", async () => {
  const base = people();
  const listeners = new Set<TableChangeListener>();
  let finish: ((value: ExportResult) => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  const source: TableSource = {
    info: () => base.info(),
    createView: (query, signal) => base.createView(query, signal),
    readRows: (request) => base.readRows(request),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportView: (request, signal) =>
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        void request;
      }),
  };
  const grid = new GridController(source, { ...options, changeDelay: 10_000 });
  grid.start();
  await until(() => grid.info?.status === "ready");
  const subscribed = listeners.size;
  // The source reports a change: the export stops.
  const changed = runExport(grid, choice, {}, new AbortController().signal);
  await until(() => finish !== null && listeners.size === subscribed + 1);
  for (const listener of listeners) listener({ revision: "2" });
  await assert.rejects(changed, ExportInterruptedError);
  assert.equal(listeners.size, subscribed);
  // The server closed the table (its file changed): the same error.
  finish = null;
  const closed = runExport(grid, choice, {}, new AbortController().signal);
  await until(() => fail !== null && finish !== null);
  (fail as unknown as (error: unknown) => void)(new SourceError(ErrorCodes.cancelled, "The file changed", 409));
  await assert.rejects(closed, ExportInterruptedError);
  // Cancelled by the user: an abort, not an interruption.
  finish = null;
  const user = new AbortController();
  const aborted = runExport(grid, choice, {}, user.signal);
  await until(() => finish !== null);
  user.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  grid.dispose();
});

test("wrap, style, align and format functions do not change exports", async () => {
  const grid = await readyGrid(people(), {
    name: { label: "Name", wrap: true, align: "center", style: () => ({ color: "red" }) },
    score: { number: { fractionDigits: 2 }, style: (value: unknown) => (value ? { background: "#fee" } : null) },
    born: { format: (value: unknown) => `b${value}` },
  });
  const request = exportRequest(grid, { ...choice, rows: "table" });
  assert.deepEqual(request.headers, ["Name", "born", "score"]);
  assert.deepEqual(request.numberFormats, [null, null, "#,##0.00"]);
  grid.dispose();
});
