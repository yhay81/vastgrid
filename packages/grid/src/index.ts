"use client";

export type { CommandName, CommandOutputs, GridCommand, GridDocument, GridSession } from "vastgrid-spec";
export type { Geometry, Hit } from "./canvas/geometry.js";
export { GridCanvas, type Settled } from "./canvas/grid-canvas.js";
export type { CellAction, CellHooks, CellStyle, ColumnGroup, DrawCellArgs, GridCell } from "./canvas/hooks.js";
export { isApple, type KeyInput, keyCommand } from "./canvas/keys.js";
/**
 * vastgrid v2 for React (v2-react.md): `DataGrid`, the hooks that read and change its store, and what the store
 * and the transports give (also in `vastgrid/core`, without React).
 */
export * from "./core.js";
export { DataGrid, type DataGridHandle, type DataGridProps, GridProvider } from "./react/data-grid.js";
export type { DetailPanelProps } from "./react/detail-panel.js";
export type { CellActionEvent } from "./react/grid-body.js";
export {
  readRows,
  shallowEqual,
  useCreateGridStore,
  useGridDispatch,
  useGridRows,
  useGridSelector,
  useGridStore,
} from "./react/hooks.js";
export { type GridMessages, messagesFor } from "./react/messages.js";
