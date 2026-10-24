/**
 * The engine over HTTP (docs/v2-spec.md §8.8): a request is a `POST` of its JSON; the response is JSON with blocks
 * in base64, or, to a client that accepts `application/vnd.vastgrid.v2+arrow`, that type with its block attached;
 * errors have the statuses of §8.7; events go out as Server-Sent Events.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ARROW_MEDIA_TYPE, ERROR_STATUS, type ErrorCode, frameAttached, toTextEncoding } from "vastgrid-spec";
import type { DuckDBEngine } from "./engine.js";

export interface HttpHandlerOptions {
  /** The path that requests are posted to. `/` by default. */
  path?: string;
  /** The path of the events. The path of requests and `events` by default (`/events`, `/api/events`). */
  events?: string;
  /** The largest body of a request, in bytes. 64 MiB by default. */
  maxBody?: number;
  /** Milliseconds between the comments that keep a stream of events open. 15 seconds by default. */
  keepAlive?: number;
}

type Json = Record<string, unknown>;

function send(response: ServerResponse, status: number, type: string, body: string | Uint8Array) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function invalid(response: ServerResponse, status: number, message: string, reason: string) {
  sendJson(response, status, { v: 2, id: 0, error: { code: "invalid_request", message, path: "", reason } });
}

async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasBlock(answer: Json) {
  const result = answer.result as { block?: unknown; data?: unknown } | null | undefined;
  return result !== null && typeof result === "object" && (result.block !== undefined || result.data !== undefined);
}

/**
 * A handler of the engine's requests and events: a listener for `http.createServer`, and middleware for servers
 * that pass `next` (Connect, Express, Vite), which other paths go on to.
 */
export function createHttpHandler(engine: DuckDBEngine, options: HttpHandlerOptions = {}) {
  const base = options.path ?? "/";
  const events = options.events ?? `${base.endsWith("/") ? base : `${base}/`}events`;
  const limit = options.maxBody ?? 64 * 1024 * 1024;
  return async (request: IncomingMessage, response: ServerResponse, next?: (error?: unknown) => void) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === events && request.method === "GET") {
      streamEvents(engine, response, options.keepAlive ?? 15_000);
      return;
    }
    if (url.pathname !== base) {
      if (next) next();
      else invalid(response, 404, "There is nothing at this path.", "syntax");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      invalid(response, 405, "Requests are POSTs of their JSON (§8.8).", "syntax");
      return;
    }
    const body = await readBody(request, limit);
    if (body === null) {
      // The rest of the body is not read: the connection closes once the answer is sent.
      response.setHeader("connection", "close");
      response.on("finish", () => request.destroy());
      invalid(response, 413, "The request is too large.", "limit");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      invalid(response, 400, "The body is not JSON.", "syntax");
      return;
    }
    // A client that goes away cancels its request (§8.6).
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const answer = await engine.handle(message, { signal: controller.signal });
    if (response.destroyed) return;
    if (answer === undefined) {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const error = answer.error as { code?: ErrorCode } | undefined;
    if (error) {
      sendJson(response, ERROR_STATUS[error.code as ErrorCode] ?? 500, answer);
      return;
    }
    const accepts = String(request.headers.accept ?? "").includes(ARROW_MEDIA_TYPE);
    if (accepts && hasBlock(answer)) {
      send(response, 200, ARROW_MEDIA_TYPE, frameAttached(answer));
      return;
    }
    sendJson(response, 200, toTextEncoding(answer));
  };
}

/** Sends the engine's events (§8.5) as Server-Sent Events until the client goes away. */
function streamEvents(engine: DuckDBEngine, response: ServerResponse, keepAlive: number) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(": vastgrid events\n\n");
  const stop = engine.subscribe((event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const timer = setInterval(() => response.write(": keep-alive\n\n"), keepAlive);
  timer.unref?.();
  response.on("close", () => {
    clearInterval(timer);
    stop();
  });
}
