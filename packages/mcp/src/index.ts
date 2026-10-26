/**
 * vastgrid's MCP App (docs/mcp-app.md): tools that open table files in grids, which the person sees in the chat
 * and the agent reads and changes with the commands of the specification, and the App that shows them.
 */
export {
  Grid,
  type GridEngine,
  type GridState,
  Grids,
  type GridsOptions,
  ROWS_LIMIT,
  type SyncAnswer,
  ToolError,
} from "./grids.js";
export { type Handler, RequestIds } from "./ids.js";
export { APP_URI, registerVastgrid, type VastgridToolsOptions } from "./server.js";
