/// <reference lib="webworker" />
/**
 * The memory engine of `vastgrid-js` in a Web Worker, for `?engine=worker`: the table is made here, and the page
 * talks to the engine through `workerTransport`, so that sorting a million rows never blocks the page.
 */
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";
import { benchTable } from "./data.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function start(event: MessageEvent) {
  const init = (event.data as { init?: { rows: number; columns: number } } | null)?.init;
  if (!init) return;
  scope.removeEventListener("message", start);
  const table = benchTable(init.rows, init.columns);
  const engine = memoryEngine({
    tables: {
      bench: {
        columns: table.columns.map((column) => (column.type === "float" ? { ...column, bits: 64 } : column)),
        rows: table.rowData,
        editable: true,
      },
    },
  });
  serveEngine(engine, scope as unknown as WorkerLike);
  scope.postMessage({ ready: true });
}

scope.addEventListener("message", start);
