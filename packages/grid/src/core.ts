/**
 * The grid without React (§4 of react.md): the store, the client of the messages and the transports. Runs in
 * browsers, workers and servers.
 */
export {
  type ActiveCell,
  type Aggregate,
  type Capabilities,
  type CellRange,
  type CellRef,
  type Checked,
  type Column,
  type ColumnFormat,
  type ColumnSetting,
  CommandError,
  type CommandName,
  type CommandOutputs,
  type DateFormat,
  type Derived,
  type DisplayedColumn,
  type ErrorCode,
  type Expr,
  type Fold,
  type GridCommand,
  type GridDocument,
  type GridSession,
  type GridState,
  type JsonValue,
  type LogicalType,
  type Measure,
  type MeasureName,
  type NumberFormat,
  type Operation,
  type Pin,
  type Pivot,
  type Plan,
  PlanError,
  type RowKey,
  type SortDirection,
  type SortKey,
  type StyleRule,
  type Total,
} from "vastgrid-spec";
export { BLOCK_ROWS } from "./core/cache.js";
export { GridClient, type Transport } from "./core/client.js";
export { type Handler, RequestIds } from "./core/request-ids.js";
export type { Viewport } from "./core/rows.js";
export { CACHE_BYTES, createGridStore, type DispatchOptions, GridStore, type GridStoreOptions } from "./core/store.js";
export {
  type Engine,
  type HttpTransportOptions,
  httpTransport,
  localTransport,
  serveEngine,
  serverFunctionTransport,
  type WorkerLike,
  workerTransport,
} from "./core/transports.js";
export {
  type CommandOutcome,
  type Edits,
  type FailedWrite,
  GridError,
  type GridSnapshot,
  type InitialView,
  type OpenOptions,
  type RequestMessage,
  type RowsResult,
  type TableInfo,
  type ViewInfo,
  type WriteUpdate,
} from "./core/types.js";
