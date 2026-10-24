import type { BrowserTableOptions, TableInput } from "./table.js";

/** Operations of `BrowserTable` that `BrowserSource` calls in the worker. */
export type TableMethod =
  | "info"
  | "createView"
  | "readRows"
  | "columnStats"
  | "distinctValues"
  | "aggregate"
  | "find"
  | "checkChanges"
  | "transfer";

/** Messages from `BrowserSource` to the worker. */
export type WorkerRequest =
  | { type: "open"; input: TableInput; options: BrowserTableOptions }
  | { type: "call"; id: number; method: TableMethod; args: unknown[] }
  | { type: "cancel"; id: number }
  | { type: "close" };

/** Answers of the worker. */
export type WorkerResponse =
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; error: { name: string; code?: string; message: string; status?: number } };

/** The part of `Worker` (or `MessagePort`) that `BrowserSource` uses. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  terminate?(): void;
  start?(): void;
  close?(): void;
}

/** Where the worker receives requests: the worker's global scope, or a `MessagePort`. */
export interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}
