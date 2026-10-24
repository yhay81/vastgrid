/**
 * Events of the grid. Three coordinates describe a cell:
 *
 * - `row`: the position in the current view (0-based), after sorting and filters; what the grid shows.
 * - `rowId`: the position in the original table (0-based). It equals `row` without sort and filters,
 *   and comes with the rows the grid reads for a view, so it is `null` until that row is loaded.
 * - `col`: the position among the visible columns (0-based), in display order, and `column`: the index
 *   of the column in the table schema (`TableInfo.columns`), as in `ViewQuery`. Moving or hiding
 *   columns changes `col`, never `column`.
 *
 * Events are sent only when the selection, the columns or the settings change, never for scrolling,
 * hovering or drawing.
 */

import type { CellValue, RowSelection } from "vastgrid-core";

export interface GridCell {
  /** Row in the current view. */
  row: number;
  /** Row in the original table, or `null` while the row of a view is not loaded. */
  rowId: number | null;
  /** Visible column, in display order. */
  col: number;
  /** Index of the column in the table schema, or -1 when the table has no visible column. */
  column: number;
}

export interface GridSelectionRange {
  /** First and last rows of the view (inclusive). */
  top: number;
  bottom: number;
  /** First and last visible columns (inclusive). */
  left: number;
  right: number;
  /** Schema indexes of the columns from `left` to `right`. */
  columns: number[];
  /** The range is whole columns: it keeps every row when the row count changes. */
  allRows: boolean;
  /** The range is whole rows: it keeps every column when columns are hidden or shown. */
  allCols: boolean;
}

export interface GridSelectionEvent {
  /**
   * The active cell. Sent again when its `rowId` arrives with its row, and when the cell it points to
   * changes without a new selection: the table's columns arrive, a new view starts at its first row, or
   * columns are moved or hidden.
   */
  active: GridCell;
  /** The selected ranges, the last one being the one that the keyboard extends. */
  ranges: GridSelectionRange[];
}

export type GridColumnsChangeReason =
  /** A column's width was set by dragging its edge, fitting it, or `resizeColumn`. */
  | "resize"
  | "move"
  /** Columns were hidden or shown. */
  | "visibility"
  | "freeze"
  /** A state was applied (`applyState` or `initialState`). */
  | "state"
  /** The table was read again and its columns changed. */
  | "schema";

export interface GridColumn {
  /** Index in the table schema. */
  column: number;
  name: string;
  /** Visible position, or -1 when hidden. */
  col: number;
  width: number;
  hidden: boolean;
  /** The width was set by the user (it is saved in the state); otherwise the grid fits it. */
  sized: boolean;
  frozen: boolean;
}

export interface GridColumnsEvent {
  reason: GridColumnsChangeReason;
  /** Every column in display order, hidden ones included. */
  columns: GridColumn[];
  /** Visible columns frozen at the left. */
  frozenColumns: number;
}

export interface GridCellEvent extends GridCell {
  /** The loaded value (text cut for display ends with "…"), or `undefined` while it is not loaded. */
  value: CellValue | undefined;
  /** A pointer, or the key that does the same: Space for a click, F2 for a double click. */
  trigger: "pointer" | "keyboard";
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /**
   * Stops what the grid does next: opening the cell inspector on a double click or F2, and checking the
   * row with Space when the rows have checkboxes.
   */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export type GridRowSelectionChangeReason =
  /** The user clicked a checkbox or pressed Space. */
  | "user"
  /** The app set the checked rows (`setRowSelection` or the `rowSelection` prop). */
  | "api"
  /** The table has a new revision: rows keyed by their position were unchecked. */
  | "revision"
  /** The key column or, for every row matching a query, the filtered columns are gone: rows were unchecked. */
  | "schema"
  /**
   * The view no longer shows only rows matching the query of an `exclude` selection, so the grid listed
   * the keys of those rows: the selection is now an `include` of the same rows.
   */
  | "query"
  /** The key column changed (`rowKey`): rows were unchecked. */
  | "key";

export interface GridRowSelectionEvent {
  reason: GridRowSelectionChangeReason;
  /** The checked rows, as keys (see `RowSelection`). */
  selection: RowSelection;
  /** Checked rows, or null when the rows matching the query of an `exclude` selection were not counted. */
  count: number | null;
}
