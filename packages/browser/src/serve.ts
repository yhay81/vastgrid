import { SourceError } from "vastgrid-core";
import type { WorkerRequest, WorkerResponse, WorkerScope } from "./messages.js";
import { BrowserTable } from "./table.js";

/**
 * Answers the requests of one `BrowserSource` in a worker. `vastgrid-browser/worker` calls it with the
 * worker's global scope; call it yourself to run the table in a worker of your own.
 */
export function serveTable(scope: WorkerScope) {
  let table: BrowserTable | null = null;
  const running = new Map<number, AbortController>();
  const send = (message: WorkerResponse) => scope.postMessage(message);

  scope.addEventListener("message", (event: MessageEvent) => {
    const request = event.data as WorkerRequest;
    switch (request.type) {
      case "open":
        table?.close();
        table = new BrowserTable(request.input, request.options);
        return;
      case "cancel":
        running.get(request.id)?.abort();
        return;
      case "close":
        for (const controller of running.values()) controller.abort();
        table?.close();
        table = null;
        return;
      case "call": {
        const { id, method, args } = request;
        const controller = new AbortController();
        running.set(id, controller);
        const current = table;
        const call = async () => {
          if (!current) throw new SourceError("table_not_found", "The table is closed.", 404);
          if (method === "transfer") return current.transfer();
          const operation = current[method] as (...values: unknown[]) => Promise<unknown>;
          return operation.apply(current, [...args, controller.signal]);
        };
        call()
          .then(
            (result) => send({ type: "result", id, result }),
            (error: unknown) => {
              const failure = error instanceof Error ? error : new Error(String(error));
              send({
                type: "error",
                id,
                error: {
                  name: failure.name,
                  message: failure.message,
                  code: failure instanceof SourceError ? failure.code : undefined,
                  status: failure instanceof SourceError ? failure.status : undefined,
                },
              });
            },
          )
          .finally(() => running.delete(id));
        return;
      }
    }
  });
  scope.start?.();
}
