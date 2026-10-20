import { ErrorCodes, isInvalidRequest, parseProtocolRequest, SourceError } from "vastgrid-core";
import type { TableEngine } from "./engine.js";

export interface TableHandlerOptions {
  engine: TableEngine | (() => TableEngine | Promise<TableEngine>);
  /**
   * Resolves the `ref` of a request to an absolute file path. This is where a host checks that the
   * file may be opened (for example that it is inside a workspace). Throw to refuse.
   */
  resolve: (ref: string) => string | Promise<string>;
  /** Resolves an export `target` to an absolute path for a new file. Without it, exports are refused. */
  resolveTarget?: (target: string) => string | Promise<string>;
  /** Receives errors that are not caused by the request, for logging. */
  onError?: (error: unknown) => void;
}

async function engineOf(options: TableHandlerOptions) {
  return typeof options.engine === "function" ? options.engine() : options.engine;
}

/**
 * Answers one protocol request (already parsed from JSON). Returns the `result` to send, or throws
 * `SourceError` (or an invalid-request error) to report.
 */
export async function handleTableRequest(body: unknown, options: TableHandlerOptions, signal?: AbortSignal) {
  const request = parseProtocolRequest(body);
  const engine = await engineOf(options);
  switch (request.op) {
    case "info": {
      const table = await engine.open(await options.resolve(request.ref));
      const info = table.info();
      if (!options.resolveTarget) info.capabilities.export = false;
      return { table: table.id, ...info };
    }
    case "view":
      return engine.get(request.table).createView(request.query, signal);
    case "rows":
      return engine.get(request.table).readRows(request, signal);
    case "stats":
      return engine.get(request.table).columnStats(request.view, request.column, signal);
    case "distinct":
      return engine.get(request.table).distinctValues(request, signal);
    case "aggregate":
      return engine.get(request.table).aggregate(request, signal);
    case "find":
      return engine.get(request.table).find(request, signal);
    case "export": {
      if (!options.resolveTarget) throw new SourceError("export_disabled", "Exporting is not enabled.", 403);
      const target = await options.resolveTarget(request.target);
      return engine.get(request.table).exportView(request, target, signal);
    }
    case "close":
      await engine.close(request.table);
      return null;
  }
}

/** DuckDB errors caused by the request's values (for example a filter value that is not a number). */
const queryErrors = /^(Conversion|Invalid Input|Binder|Parser|Out of Range|Constraint|Permission|IO) Error/;

/** The status and body of an error response. */
export function errorBody(error: unknown, onError?: (error: unknown) => void): { status: number; body: unknown } {
  if (isInvalidRequest(error)) {
    return {
      status: 400,
      body: { error: { code: ErrorCodes.invalidRequest, message: (error as Error).message } },
    };
  }
  if (error instanceof SourceError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (queryErrors.test(message)) {
    return { status: 422, body: { error: { code: "query_failed", message } } };
  }
  onError?.(error);
  return { status: 500, body: { error: { code: "internal_error", message: "The table server failed." } } };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A Fetch API handler (`Request` → `Response`) for the vastgrid protocol, for frameworks that use
 * web requests (Next.js route handlers, Hono, Deno, Bun, …). Pass the request's signal so that
 * cancelled requests stop their queries.
 */
export function createTableHandler(options: TableHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: { code: ErrorCodes.invalidRequest, message: "The body must be JSON." } });
    }
    try {
      return json(200, { result: await handleTableRequest(body, options, request.signal) });
    } catch (error) {
      const { status, body: payload } = errorBody(error, options.onError);
      return json(status, payload);
    }
  };
}
