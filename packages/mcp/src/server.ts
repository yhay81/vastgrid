/**
 * The tools and the App of vastgrid's MCP server (docs/mcp-app.md). The agent opens files in grids that the
 * person sees, reads their state and rows, and applies the commands of the specification (§6); the App shows
 * each grid with `DataGrid`, carries its requests (§8.8) and follows the grid's state.
 */
import { readFile } from "node:fs/promises";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { findTableFiles } from "vastgrid-duckdb";
import { COMMANDS, toTextEncoding } from "vastgrid-spec";
import { z } from "zod";
import { type Grid, type GridEngine, Grids, ROWS_LIMIT, ToolError } from "./grids.js";

/** The URI of the App's page. */
export const APP_URI = "ui://vastgrid/grid.html";

export interface VastgridToolsOptions {
  /** The engine that reads the files: `DuckDBEngine`. */
  engine: GridEngine;
  /** The folders whose files `list_files` lists (those that the engine may open). */
  folders: string[];
  /** The App's page: one HTML file with its script and styles inside. `dist/app.html` of the package by default. */
  html?: () => Promise<string>;
  /** Milliseconds that the App's `grid_sync` waits for a change. 20 seconds by default. */
  wait?: number;
  /** The grids to show, shared by the servers of one process (`serveStdio` may make more than one). */
  grids?: Grids;
}

/** The commands an agent sends (§6, without those of §6.7), for the tools' descriptions. */
const AGENT_COMMANDS = COMMANDS.filter(
  (name) => !["view.update", "history.push", "history.undone", "history.redone"].includes(name),
);

function json(value: unknown) {
  return JSON.stringify(value);
}

function result(structured: Record<string, unknown>, text = json(structured)): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function failure(error: unknown): CallToolResult {
  const known = error instanceof ToolError || (error instanceof Error && "code" in error);
  const code = known ? String((error as { code: unknown }).code) : "internal";
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ToolError ? error.details : {};
  const structured = { error: { code, message, ...details } };
  return { isError: true, content: [{ type: "text", text: json(structured) }], structuredContent: structured };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

/** The App's page as the package builds it (`npm run build`), next to `src` and `dist`. */
async function builtHtml() {
  return readFile(new URL("../dist/app.html", import.meta.url), "utf8");
}

const documentSchema = z
  .record(z.string(), z.unknown())
  .describe("A document of the specification (§5.1): { kind: 'vastgrid/document', version: 2, plan?, columns? }.");

/** Registers vastgrid's tools and App on an MCP server. Gives the grids, which the host disposes with the server. */
export function registerVastgrid(server: McpServer, options: VastgridToolsOptions): Grids {
  const grids = options.grids ?? new Grids({ engine: options.engine, wait: options.wait });
  const html = options.html ?? builtHtml;
  const ui = { resourceUri: APP_URI };
  const appOnly = { resourceUri: APP_URI, visibility: ["app" as const] };
  const describe = (grid: Grid) => {
    const state = grid.state();
    const rows = state.view?.rowCount ?? state.table?.rowCount;
    const text =
      `Grid ${state.grid} shows ${state.file}: ${rows ?? "?"} rows, columns ` +
      `${state.columns.map((column) => `${column.name} (${column.type})`).join(", ")}. ` +
      "Read it with grid_state and grid_rows, change it with grid_command.";
    return result({ ...state }, text);
  };

  registerAppResource(
    server,
    "vastgrid grid",
    APP_URI,
    { description: "The grid of a table file, read by DuckDB on the server." },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await html(),
          // Everything the page needs is inside it; it reaches the server through the host's tool calls.
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List table files",
      description:
        "Lists the CSV, TSV, Parquet, JSON Lines and Excel files that vastgrid may open, in the allowed folders " +
        `(${options.folders.join(", ")}), up to two folders deep.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        return result({ files: await findTableFiles(options.folders, 500) });
      }),
  );

  registerAppTool(
    server,
    "open_grid",
    {
      title: "Open a table in a grid",
      description:
        "Opens a CSV, TSV, Parquet, JSON Lines or Excel file of the allowed folders in a grid that the person sees " +
        "and works in. Files of any size open: DuckDB reads them on the server. Gives the grid's id, its columns and " +
        "its state. `document` (§5.1 of the vastgrid v2 specification) sets the view to start with: its plan " +
        "(filters, sort, groups, derived columns) and its columns (widths, pins, formats).",
      inputSchema: z.object({
        file: z.string().min(1).max(4096).describe("The file: a path, absolute or in the first allowed folder."),
        sheet: z.string().max(256).optional().describe("The sheet of an Excel workbook."),
        document: documentSchema.optional(),
      }),
      _meta: { ui },
    },
    async ({ file, sheet, document }, ctx) =>
      guarded(async () => describe(await grids.open(file, { document, sheet }, ctx.mcpReq.signal))),
  );

  server.registerTool(
    "grid_state",
    {
      title: "Read a grid's state",
      description:
        "Reads the state of a grid as the person sees it now: the document (§5.1: plan and columns), the session " +
        "(§5.2: active cell, selection, checked rows, editor, undo history), the displayed columns, the row count " +
        "of the view and the unsaved edits.",
      inputSchema: z.object({ grid: z.string().max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ grid }) => guarded(async () => result({ ...grids.get(grid).state() })),
  );

  server.registerTool(
    "grid_rows",
    {
      title: "Read rows of a grid",
      description:
        "Reads rows of the grid's view (its filters, sort and groups applied, edits included) as JSON values: " +
        "big integers, decimals, dates and times as strings. Strings are cut to 1,000 code points (truncated " +
        `lists the offsets). At most ${ROWS_LIMIT} rows at once; columns are the displayed ones by default.`,
      inputSchema: z.object({
        grid: z.string().max(100),
        start: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(ROWS_LIMIT).optional(),
        columns: z.array(z.string().max(1000)).max(1000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ grid, start, count, columns }, ctx) =>
      guarded(async () => result(await grids.get(grid).rows({ start, count, columns }, ctx.mcpReq.signal))),
  );

  server.registerTool(
    "grid_command",
    {
      title: "Change a grid",
      description:
        "Applies a command of the vastgrid v2 specification (§6) to a grid, as the person's keys and menus do: " +
        "the person sees the result at once. A command is { command, …arguments }, for example " +
        '{ "command": "sort.set", "keys": [{ "column": "price", "direction": "desc" }] }, ' +
        '{ "command": "filter.column", "column": "region", "where": { "fn": "eq", "args": [{ "col": "region" }, { "lit": "EU" }] } }, ' +
        '{ "command": "select", "row": 0, "column": "price" } then { "command": "edit.begin", "text": "12.50" } and ' +
        '{ "command": "edit.commit" } to write a cell. Commands: ' +
        `${AGENT_COMMANDS.join(", ")}. A command that fails changes nothing and tells why (invalid_command with a ` +
        "reason and a path into the command).",
      inputSchema: z.object({
        grid: z.string().max(100),
        command: z.looseObject({ command: z.string().max(100) }),
      }),
    },
    async ({ grid, command }, ctx) =>
      guarded(async () => {
        const target = grids.get(grid);
        const output = await target.command(command, ctx.mcpReq.signal);
        const state = target.state();
        return result({ ...(output === undefined ? {} : { output }), ...state });
      }),
  );

  registerAppTool(
    server,
    "vastgrid_message",
    {
      title: "vastgrid request",
      description: "Carries a request of the vastgrid v2 specification (§8) from the App to the engine.",
      inputSchema: z.object({
        grid: z.string().max(100),
        client: z.string().max(100),
        message: z.record(z.string(), z.unknown()),
      }),
      _meta: { ui: appOnly },
    },
    async ({ grid, client, message }, ctx) =>
      guarded(async () => {
        const answer = await grids.get(grid).message(client, message, ctx.mcpReq.signal);
        // The response travels as JSON, with its block in base64 (§8.8).
        return {
          content: [{ type: "text", text: "vastgrid response" }],
          structuredContent: toTextEncoding(answer as never),
        };
      }),
  );

  registerAppTool(
    server,
    "grid_sync",
    {
      title: "Follow a grid",
      description:
        "Keeps the App's document and session in step with the grid's: gives the person's changes and waits for " +
        "the agent's, and for the engine's events of the App's tables.",
      inputSchema: z.object({
        grid: z.string().max(100),
        client: z.string().max(100),
        version: z.number().int().min(-1),
        document: z.record(z.string(), z.unknown()).optional(),
        session: z.record(z.string(), z.unknown()).optional(),
      }),
      _meta: { ui: appOnly },
    },
    async ({ grid, client, version, document, session }, ctx) =>
      guarded(async () => {
        const answer = await grids.get(grid).sync(client, { version, document, session }, ctx.mcpReq.signal);
        return { content: [{ type: "text", text: `version ${answer.version}` }], structuredContent: { ...answer } };
      }),
  );

  return grids;
}
