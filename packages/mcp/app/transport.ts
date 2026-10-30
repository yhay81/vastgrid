/**
 * The App's side of the server (docs/mcp-app.md): requests of §8 carried by tool calls through the host (§8.8),
 * and the calls that keep the App's document and session in step with the grid's.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Transport } from "vastgrid";
import type { GridDocument, GridSession } from "vastgrid-spec";

type Json = Record<string, unknown>;

/** A tool that failed: its code (§8.7, `grid_not_found`, `invalid_command`) and message. */
export class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** Calls a tool of the server and gives its `structuredContent`, or throws what it failed with. */
export async function callTool(app: App, name: string, args: Json, signal?: AbortSignal): Promise<Json> {
  const answer = await app.callServerTool({ name, arguments: args }, signal ? { signal } : undefined);
  const content = (answer.structuredContent ?? {}) as Json;
  if (answer.isError) {
    const error = (content.error ?? {}) as { code?: string; message?: string };
    const text = answer.content?.find((item) => item.type === "text") as { text?: string } | undefined;
    throw new ToolCallError(error.code ?? "internal", error.message ?? text?.text ?? `${name} failed.`);
  }
  return content;
}

/** Where the App's requests go: the grid that the server shows, and the App's own name among its clients. */
export interface GridLink {
  grid: string;
  readonly client: string;
}

/**
 * The transport of an App's `DataGrid`: requests through `vastgrid_message`, events from `grid_sync`, and the files
 * of exports from `grid_export_file`, which the host downloads (the App's frame cannot).
 */
export interface McpTransport extends Transport {
  /** Gives events that `grid_sync` brought to the grid's store. */
  deliver(events: readonly unknown[]): void;
}

export function mcpTransport(app: App, link: GridLink): McpTransport {
  const listeners = new Set<(event: unknown) => void>();
  return {
    send: (request) => callTool(app, "vastgrid_message", { grid: link.grid, client: link.client, message: request }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliver(events) {
      for (const event of events) for (const listener of listeners) listener(event);
    },
    async downloadExport(target) {
      if (!app.getHostCapabilities()?.downloadFile) {
        throw new ToolCallError(
          "not_allowed",
          "The host does not download files: ask the agent to export into a folder.",
        );
      }
      const answer = await app.callServerTool({ name: "grid_export_file", arguments: { target } });
      const file = answer.content?.find((item) => item.type === "resource");
      if (answer.isError || !file) {
        const error = ((answer.structuredContent ?? {}) as Json).error as
          | { code?: string; message?: string }
          | undefined;
        throw new ToolCallError(error?.code ?? "internal", error?.message ?? "The export could not be read.");
      }
      // The host asks the person where to save it; a refusal is theirs, and not a failure.
      await app.downloadFile({ contents: [file] });
    },
  };
}

/** An answer of `grid_sync`: the grid's version, the parts the App does not have yet, and events. */
export interface SyncAnswer {
  version: number;
  document?: GridDocument;
  session?: GridSession;
  events: unknown[];
}

export function sync(
  app: App,
  link: GridLink,
  state: { version: number; document?: GridDocument; session?: GridSession },
  signal?: AbortSignal,
): Promise<SyncAnswer> {
  return callTool(app, "grid_sync", { grid: link.grid, client: link.client, ...state }, signal) as Promise<
    Json & SyncAnswer
  >;
}
