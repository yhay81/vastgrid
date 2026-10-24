/**
 * The errors of docs/v2-spec.md §8.7 that the engine answers with.
 */
import type { ErrorCode } from "vastgrid-spec";

/** What an error carries besides its code and message (§8.1). */
export interface ErrorMembers {
  path?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

/** An error that the engine answers a request with (§8.7). */
export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly members: ErrorMembers;

  constructor(code: ErrorCode, message: string, members: ErrorMembers = {}) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.members = members;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cancelled(): EngineError {
  return new EngineError("cancelled", "The request was cancelled.");
}

/** Whether DuckDB stopped a query because the engine interrupted it. */
export function isInterrupt(error: unknown): boolean {
  return /interrupt/i.test(errorMessage(error));
}
