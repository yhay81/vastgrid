/**
 * The engine over HTTP (docs/spec.md §8.8): a request is a `POST` of its JSON; the response is JSON with blocks
 * in base64, or, to a client that accepts `application/vnd.vastgrid.v2+arrow`, that type with its block attached;
 * errors have the statuses of §8.7; events go out as Server-Sent Events; the files of exports without a target are
 * downloaded with a `GET` of `<path>/exports/<name>`.
 */
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import {
  ARROW_MEDIA_TYPE,
  answerId,
  ERROR_STATUS,
  type ErrorCode,
  toStructuredEncoding,
  toTextEncoding,
} from "vastgrid-spec";
import type { DuckDBEngine } from "./engine.js";

export interface HttpHandlerOptions {
  /** The path that requests are posted to. `/` by default. */
  path?: string;
  /** The path of the events. The path of requests and `events` by default (`/events`, `/api/events`). */
  events?: string;
  /**
   * The path under which the files of exports without a target are downloaded, by the `target` that their answer
   * gave. The path of requests and `exports/` by default (`/exports/`, `/api/exports/`).
   */
  exports?: string;
  /** The largest body of a request, in bytes; larger ones are answered with 413. 64 MiB by default. */
  maxBody?: number;
  /** Milliseconds between the comments that keep a stream of events open. 15 seconds by default. */
  keepAlive?: number;
  /** Host headers accepted on non-loopback or reverse-proxied deployments (`example.com`, `example.com:8080`). */
  allowedHosts?: string[];
  /** Browser origins (`https://app.example.com`) explicitly permitted to call this handler cross-origin. */
  allowedOrigins?: string[];
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
  // No request was read, so none is answered (§8.1).
  sendJson(response, status, { v: 2, id: null, error: { code: "invalid_request", message, path: "", reason } });
}

function forbidden(response: ServerResponse, message: string) {
  sendJson(response, 403, { v: 2, id: null, error: { code: "not_allowed", message } });
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  return (
    address === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address)
  );
}

function isLoopbackHost(host: string) {
  return /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d{1,5})?$/i.test(host);
}

function checkRequestOrigin(request: IncomingMessage, options: HttpHandlerOptions): string | null {
  const host = typeof request.headers.host === "string" ? request.headers.host.trim() : undefined;
  if (options.allowedHosts) {
    if (!host) return "The Host header is missing.";
    const bare = host.startsWith("[") ? host.replace(/\]:\d+$/, "]") : host.replace(/:\d+$/, "");
    const allowed = options.allowedHosts.some(
      (entry) => entry.toLowerCase() === host.toLowerCase() || entry.toLowerCase() === bare.toLowerCase(),
    );
    if (!allowed) return "The Host header is not allowed.";
  } else if (host !== undefined) {
    const localAddress = request.socket?.localAddress;
    if ((localAddress === undefined || isLoopbackAddress(localAddress)) && !isLoopbackHost(host)) {
      return "Loopback requests require a loopback Host header.";
    }
  }
  const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : undefined;
  const allowedOrigins = options.allowedOrigins?.map((item) => item.toLowerCase());
  const originAllowed =
    origin !== undefined && allowedOrigins !== undefined && allowedOrigins.includes(origin.toLowerCase());
  const fetchSite =
    typeof request.headers["sec-fetch-site"] === "string"
      ? request.headers["sec-fetch-site"].trim().toLowerCase()
      : undefined;
  if (!originAllowed && fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return "Cross-origin browser requests are not allowed.";
  }
  if (origin !== undefined && !originAllowed) {
    if (!host || origin === "null") return "The Origin header is not allowed.";
    let parsed: URL;
    let expected: URL;
    try {
      parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The Origin header is not allowed.";
      expected = new URL(`${parsed.protocol}//${host}`);
    } catch {
      return "The Origin header is not allowed.";
    }
    if (parsed.origin === "null" || parsed.origin !== expected.origin) {
      return "The Origin header does not match Host.";
    }
  }
  return null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

type BodyRead = { kind: "ok"; text: string } | { kind: "too_large" } | { kind: "invalid_utf8" };

/**
 * The body of a request, or why it was refused before JSON parsing. The rest of a body that is too large is read and
 * dropped, up to twice the limit, so that the client has sent it all when the error is answered: a connection
 * closed while data still comes in is reset, and the client may lose the answer.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<BodyRead> {
  const declared = request.headers["content-length"];
  const overLimit = typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > limit;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > 2 * limit) return { kind: "too_large" };
    if (!overLimit && length <= limit) chunks.push(chunk as Buffer);
  }
  if (overLimit || length > limit) return { kind: "too_large" };
  try {
    return { kind: "ok", text: utf8.decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length)) };
  } catch {
    return { kind: "invalid_utf8" };
  }
}

function hasBlock(answer: Json) {
  const result = answer.result as { block?: unknown; data?: unknown } | null | undefined;
  return result !== null && typeof result === "object" && (result.block !== undefined || result.data !== undefined);
}

/** Writes an attached-block response (§8.8) without copying the Arrow block into a second buffer. */
function sendAttached(response: ServerResponse, answer: Json) {
  const structured = toStructuredEncoding(answer);
  const result = structured.result as Json;
  const member = result.block !== undefined ? "block" : "data";
  const block = (result[member] as { bytes: Uint8Array }).bytes;
  const json = Buffer.from(
    JSON.stringify({ ...structured, result: { ...result, [member]: { attached: block.byteLength } } }),
    "utf8",
  );
  const prefix = Buffer.allocUnsafe(4 + json.length);
  prefix.writeUInt32LE(json.length, 0);
  json.copy(prefix, 4);
  response.writeHead(200, {
    "content-type": ARROW_MEDIA_TYPE,
    "content-length": prefix.length + block.byteLength,
    "cache-control": "no-store",
  });
  response.cork();
  response.write(prefix);
  response.end(block);
  response.uncork();
}

/**
 * A handler of the engine's requests and events: a listener for `http.createServer`, and middleware for servers
 * that pass `next` (Connect, Express, Vite), which other paths go on to.
 */
export function createHttpHandler(engine: DuckDBEngine, options: HttpHandlerOptions = {}) {
  const base = options.path ?? "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const events = options.events ?? `${prefix}events`;
  const exportsPath = options.exports ?? `${prefix}exports/`;
  const limit = options.maxBody ?? 64 * 1024 * 1024;
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    onRequestId: (id: number | null) => void,
    next?: (error?: unknown) => void,
  ) => {
    let url: URL;
    let exportName: string | undefined;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith(exportsPath)) {
        exportName = decodeURIComponent(url.pathname.slice(exportsPath.length));
      }
    } catch {
      invalid(response, 400, "The request URL is not valid.", "syntax");
      return;
    }
    const isEvents = url.pathname === events && request.method === "GET";
    const isExport = url.pathname.startsWith(exportsPath) && (request.method === "GET" || request.method === "HEAD");
    if (!isEvents && !isExport && url.pathname !== base) {
      if (next) next();
      else invalid(response, 404, "There is nothing at this path.", "syntax");
      return;
    }
    response.setHeader?.("vary", "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site");
    const originProblem = checkRequestOrigin(request, options);
    if (originProblem) {
      forbidden(response, originProblem);
      return;
    }
    if (isEvents) {
      streamEvents(engine, response, options.keepAlive ?? 15_000);
      return;
    }
    if (isExport) {
      sendExport(engine, exportName as string, request, response);
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      invalid(response, 405, "Requests are POSTs of their JSON (§8.8).", "syntax");
      return;
    }
    if (!/^\s*application\/json\s*(?:;|$)/i.test(String(request.headers["content-type"] ?? ""))) {
      invalid(response, 415, "Requests have content-type: application/json (§8.8).", "syntax");
      return;
    }
    const body = await readBody(request, limit);
    if (body.kind === "too_large") {
      // The connection closes once the answer is sent, also when the rest of the body was not read.
      response.setHeader("connection", "close");
      invalid(response, 413, "The request is too large.", "limit");
      return;
    }
    if (body.kind === "invalid_utf8") {
      invalid(response, 400, "The body is not valid UTF-8.", "syntax");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body.text);
    } catch {
      invalid(response, 400, "The body is not JSON.", "syntax");
      return;
    }
    onRequestId(answerId(message));
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
      sendAttached(response, answer);
      return;
    }
    sendJson(response, 200, toTextEncoding(answer));
  };
  // http.createServer does not consume a listener's rejected promise. In particular, an interrupted body
  // rejects readBody with ECONNRESET; it must only end that request, not the server process.
  return async (request: IncomingMessage, response: ServerResponse, next?: (error?: unknown) => void) => {
    let requestId: number | null = null;
    try {
      await handle(request, response, (id) => (requestId = id), next);
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent || request.errored || (request.destroyed && !request.complete)) response.destroy();
      else if (next) next(error);
      else if (requestId !== null) {
        sendJson(response, 500, { v: 2, id: requestId, error: { code: "internal", message: "The request failed." } });
      } else {
        invalid(response, 400, "The request could not be read.", "syntax");
      }
    }
  };
}

/** Sends the file of an export as a download, or 404 when the engine does not keep one of that name (any more). */
function sendExport(engine: DuckDBEngine, name: string, request: IncomingMessage, response: ServerResponse) {
  const kept = engine.exportFile(name);
  if (!kept) {
    // Not a message of §8: a download, whose answer is the file or not found.
    send(response, 404, "text/plain; charset=utf-8", "There is no such export (any more).\n");
    return;
  }
  // The name in ASCII for old clients, and in UTF-8 (RFC 6266, RFC 8187).
  const ascii = kept.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  response.writeHead(200, {
    "content-type": kept.mediaType,
    "content-length": kept.size,
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(kept.fileName)}`,
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  void pipeline(createReadStream(kept.path), response).catch(() => response.destroy());
}

/** Sends the engine's events (§8.5) as Server-Sent Events until the client goes away or the engine closes. */
function streamEvents(engine: DuckDBEngine, response: ServerResponse, keepAlive: number) {
  if (engine.disposeSignal.aborted) {
    sendJson(response, 500, { v: 2, id: null, error: { code: "internal", message: "The engine was closed." } });
    return;
  }
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
  const onDispose = () => response.end();
  engine.disposeSignal.addEventListener("abort", onDispose, { once: true });
  response.on("close", () => {
    clearInterval(timer);
    engine.disposeSignal.removeEventListener("abort", onDispose);
    stop();
  });
}
