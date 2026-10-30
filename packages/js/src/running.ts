/**
 * Requests as the memory engine answers them (docs/spec.md §8): the errors of §8.7 that they are answered with, and
 * the pauses that let a `cancel` of them in (§8.6).
 */
import type { ErrorCode } from "vastgrid-spec";

export type Json = Record<string, unknown>;

/** An error of §8.7 that a request is answered with. */
export class Failure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { path?: string; reason?: string; details?: Json } = {},
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** A request being answered, which `cancel` marks. */
export interface Running {
  cancelled: boolean;
  /** When the request last let other messages in (`performance.now()`). */
  yielded: number;
  /** Lets go of the columns that the request read whole (lazy.ts), when it ends. */
  releases: (() => void)[];
}

// The page, Web Workers and Node.js all have these; the package is typed without the DOM or Node.js.
declare const performance: { now(): number };
declare function setTimeout(callback: (value?: unknown) => void, delay: number): unknown;

/** A request that has just come in. */
export function started(): Running {
  return { cancelled: false, yielded: performance.now(), releases: [] };
}

/** The work that a request does before it lets other messages in, such as a `cancel` of it (§8.6), in ms. */
const SLICE = 40;

/**
 * Lets other messages in when the request has worked for a slice since it last did, and stops it when it was
 * cancelled (§8.6): a cancel that came in while the request waited for a file is seen at once. Requests that go
 * through many rows call it between batches of them.
 */
export async function pause(running: Running): Promise<void> {
  if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
  if (performance.now() - running.yielded < SLICE) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  running.yielded = performance.now();
  if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
}
