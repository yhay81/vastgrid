import { ARROW_MEDIA_TYPE, readAttached, toStructuredEncoding } from "vastgrid-spec";
import type { Transport } from "./client.js";
import type { RequestMessage } from "./types.js";

/** An engine in the same thread: it answers request messages, and may send events (§8.5). */
export interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

/** Carries messages to an engine in the same thread, as function calls with blocks as bytes (§8.8). */
export function localTransport(engine: Engine): Transport {
  const transport: Transport = { send: (request) => engine.handle(request) };
  if (engine.subscribe) {
    const subscribe = engine.subscribe.bind(engine);
    transport.subscribe = (listener) => subscribe(listener);
  }
  return transport;
}

/** The side of a worker that `workerTransport` talks to: `self` in a worker, or a `MessagePort`. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}

/**
 * Carries messages to an engine in a Web Worker (or behind a `MessagePort`), which answers with
 * `serveEngine`. Blocks travel as bytes and their buffers are transferred (§8.8).
 */
export function workerTransport(worker: WorkerLike): Transport & { close(): void } {
  const waiting = new Map<number, (response: unknown) => void>();
  const listeners = new Set<(event: unknown) => void>();
  const receive = (event: MessageEvent) => {
    const data = event.data as { id?: unknown; event?: unknown } | null;
    if (data === null || typeof data !== "object") return;
    if (typeof data.event === "string") {
      for (const listener of listeners) listener(data);
      return;
    }
    if (typeof data.id !== "number") return;
    const resolve = waiting.get(data.id);
    waiting.delete(data.id);
    resolve?.(data);
  };
  worker.addEventListener("message", receive);
  worker.start?.();
  return {
    send(request: RequestMessage) {
      if (request.op === "cancel") {
        worker.postMessage(request);
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => {
        waiting.set(request.id, resolve);
        worker.postMessage(request);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      worker.removeEventListener("message", receive);
      waiting.clear();
      listeners.clear();
    },
  };
}

/** Answers the requests that `workerTransport` sends, in a worker (`serveEngine(engine, self)`). */
export function serveEngine(engine: Engine, scope: WorkerLike): () => void {
  const receive = (event: MessageEvent) => {
    void engine.handle(event.data).then((response) => {
      if (response === undefined) return;
      const block = (response as { result?: { block?: { bytes?: unknown }; data?: { bytes?: unknown } } }).result;
      const bytes = block?.block?.bytes ?? block?.data?.bytes;
      scope.postMessage(response, bytes instanceof Uint8Array ? [bytes.buffer as ArrayBuffer] : []);
    });
  };
  scope.addEventListener("message", receive);
  scope.start?.();
  const stop = engine.subscribe?.((event) => scope.postMessage(event));
  return () => {
    scope.removeEventListener("message", receive);
    stop?.();
  };
}

export interface HttpTransportOptions {
  /** `fetch`, by default the global one. */
  fetch?: typeof fetch;
  /** Headers sent with every request, such as an authorization. */
  headers?: Record<string, string>;
  /** A URL of Server-Sent Events that carries the engine's events (§8.8). */
  events?: string;
}

/**
 * Carries messages over HTTP (§8.8): each request is a `POST` of its JSON, and the answers of `rows` and `export`
 * come with their blocks attached. Aborting a request aborts its HTTP request.
 */
export function httpTransport(url: string, options: HttpTransportOptions = {}): Transport {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const transport: Transport = {
    cancels: "signal",
    async send(message, { signal }) {
      const response = await request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: `${ARROW_MEDIA_TYPE}, application/json`,
          ...options.headers,
        },
        body: JSON.stringify(message),
        signal,
      });
      const type = response.headers.get("content-type") ?? "";
      if (type.startsWith(ARROW_MEDIA_TYPE)) return readAttached(new Uint8Array(await response.arrayBuffer()));
      return toStructuredEncoding((await response.json()) as Record<string, unknown>);
    },
  };
  const events = options.events;
  if (events !== undefined) {
    transport.subscribe = (listener) => {
      const source = new EventSource(events);
      source.onmessage = (event) => {
        try {
          listener(JSON.parse(event.data as string));
        } catch {
          // An event that is not JSON is not an event of §8.5.
        }
      };
      return () => source.close();
    };
  }
  return transport;
}

/**
 * Carries messages through a Server Function (`"use server"`), which passes each to an engine on the server and
 * returns its answer (§7 of v2-react.md). The function receives what any client may send: it checks every
 * request with `checkRequest`, as engines do.
 */
export function serverFunctionTransport(action: (request: RequestMessage) => Promise<unknown>): Transport {
  return { send: (request) => action(request) };
}
