/// <reference lib="webworker" />
/**
 * The engine of the home page's grid, in a Web Worker: the page posts how many orders to make, and the memory engine
 * makes and holds them here, so that neither making them nor sorting them blocks the page.
 */
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";
import { ordersTable } from "../../data/orders.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function start(event: MessageEvent<{ rows: number }>) {
  scope.removeEventListener("message", start);
  // The grid's requests that come meanwhile wait in the worker's queue for the engine.
  serveEngine(memoryEngine({ tables: { orders: ordersTable(event.data.rows) } }), scope as unknown as WorkerLike);
}

scope.addEventListener("message", start);
