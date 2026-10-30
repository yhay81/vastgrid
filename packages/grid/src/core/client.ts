import { checkEvent, checkResponse, type Operation, ProtocolError, toStructuredEncoding } from "vastgrid-spec";
import { now, track } from "./trace.js";
import { GridError, type RequestMessage } from "./types.js";

/**
 * Carries messages (§8 of the specification) to an engine and gives back its answers: a function call, a Web
 * Worker, HTTP, a Server Function, an MCP tool call (§4.4 of react.md).
 */
export interface Transport {
  /** Sends a request and gives its response; `cancel` has none. */
  send(request: RequestMessage, options: { signal?: AbortSignal }): Promise<unknown>;
  /** Follows the engine's events (§8.5), when the transport carries them. */
  subscribe?(listener: (event: unknown) => void): () => void;
  /**
   * How a request in flight is cancelled (§8.6): by a `cancel` request (the default), or by the transport itself
   * when the signal given to `send` aborts (an HTTP request is aborted).
   */
  cancels?: "message" | "signal";
  /**
   * Where the file of an `export` without a target can be downloaded, by the `target` of its answer (§8.2): the
   * HTTP transport's `<url>/exports/<target>`. Absent when the transport has no such place.
   */
  exportUrl?(target: string): string;
  /**
   * Downloads the file of an `export` without a target, by the `target` of its answer, where a link to `exportUrl`
   * cannot: an MCP App, whose host downloads the file. Resolves once the download is handed over.
   */
  downloadExport?(target: string): Promise<void>;
}

function cancelled(op: Operation) {
  return new GridError("cancelled", "The request was cancelled.", { op });
}

/** Reads a response: its result, or the error it carries as a `GridError`. */
function read<T>(message: unknown, op: Operation): T {
  let response: Record<string, unknown>;
  try {
    response = checkResponse(message, op);
  } catch (error) {
    // A response that does not follow §8 is an internal error for the client (§8.1).
    if (error instanceof ProtocolError) {
      throw new GridError("internal", `The engine's response does not follow the protocol: ${error.message}`, {
        op,
        reason: error.reason,
        path: error.path,
      });
    }
    throw error;
  }
  const error = response.error as
    | { code: GridError["code"]; message: string; reason?: string; path?: string; details?: Record<string, unknown> }
    | undefined;
  if (error) {
    throw new GridError(error.code, error.message, {
      op,
      reason: error.reason,
      path: error.path,
      details: error.details,
    });
  }
  return toStructuredEncoding(response).result as T;
}

// Clients can share a transport or reach the same engine through different transports. Their requests and
// cancellations must use distinct ids, including after a store is disconnected and another is created.
let nextId = 1;

/** Sends requests through a transport: gives them ids, checks the answers and cancels what is no longer needed. */
export class GridClient {
  constructor(readonly transport: Transport) {}

  request<T>(op: Operation, members: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled(op));
    const id = nextId++;
    const started = now();
    const bySignal = this.transport.cancels === "signal";
    const sent = this.transport.send({ v: 2, id, op, ...members }, bySignal && signal ? { signal } : {});
    if (!signal) return sent.then((response) => read<T>(response, op)).finally(() => track(op, started, "requests"));
    let stop = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => {
        if (!bySignal) {
          this.transport.send({ v: 2, id: nextId++, op: "cancel", request: id }, {}).catch(() => {});
        }
        reject(cancelled(op));
      };
      signal.addEventListener("abort", abort, { once: true });
      stop = () => signal.removeEventListener("abort", abort);
    });
    return Promise.race([sent.then((response) => read<T>(response, op)), aborted]).finally(() => {
      stop();
      track(op, started, "requests");
    });
  }

  /** Follows the engine's events, checked (§8.5); events that do not follow §8 are left out. */
  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    if (!this.transport.subscribe) return () => {};
    return this.transport.subscribe((event) => {
      try {
        listener(checkEvent(event));
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
      }
    });
  }
}
