/**
 * What a host adds to the drawing of the grid through props (§5.1 of the specification: functions are not state, and
 * they win over the document's formats and styles), and the column groups of the header.
 */
import type { Column, JsonValue } from "vastgrid-spec";
import type { GridTheme } from "./theme.js";

/** A cell of the view that the grid shows. */
export interface GridCell {
  /** The view position of its row. */
  row: number;
  column: Column;
  value: JsonValue;
  /** The text the grid shows: by the column's format, or the text form (§2.4). */
  text: string;
}

/** The colors of a cell, and what they mean for screen readers. */
export interface CellStyle {
  color?: string;
  background?: string;
  description?: string;
}

/** What a cell does when it is clicked or Space is pressed on it: a link goes somewhere, a button acts in place. */
export interface CellAction {
  kind: "link" | "button";
  /** The name for screen readers, instead of the cell's text. */
  label?: string;
  /** The CSS cursor over the cell; `pointer` by default. */
  cursor?: string;
}

/** The cell, its box and the canvas, for `drawCell`. */
export interface DrawCellArgs extends GridCell {
  /** The canvas in CSS pixels, with the cell font, `textBaseline = "middle"` and the column's alignment. */
  ctx: CanvasRenderingContext2D;
  rect: { x: number; y: number; width: number; height: number };
  style: CellStyle | null;
  theme: GridTheme;
  /** Draws the cell as the grid does. */
  drawDefault(): void;
}

export interface CellHooks {
  /** The text of a cell instead of the grid's; null or undefined keeps the grid's. */
  cellText?: (cell: GridCell) => string | null | undefined;
  /** The colors of a cell instead of the column's style rules; null or undefined keeps them. */
  cellStyle?: (cell: GridCell) => CellStyle | null | undefined;
  /** Draws a cell on the canvas; the canvas's state is restored afterwards. */
  drawCell?: (args: DrawCellArgs) => void;
  /** Makes cells links or buttons; null or undefined for plain cells. */
  cellAction?: (cell: GridCell) => CellAction | null | undefined;
}

/** A group of columns named in a header row above the column names; nested groups add rows. */
export interface ColumnGroup {
  name: string;
  /** Column names of the view, and groups. */
  children: (string | ColumnGroup)[];
}
