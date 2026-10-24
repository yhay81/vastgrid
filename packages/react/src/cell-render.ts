/**
 * Hooks for drawing cells and for cells that do something (links, buttons).
 *
 * Both run only for loaded cells in the visible rows and columns: the grid never calls them for the
 * rest of the table, and cells that are still loading keep their placeholder. They run while drawing,
 * so keep them fast, and keep the functions stable (define them outside components or memoize them),
 * since a new function draws the grid again.
 *
 * Actionable cells follow the grid's events (see `events.ts`):
 *
 * - Pointer: over a cell for which `cellAction` returns an action, the pointer becomes `cursor`
 *   (`pointer` by default). A click on it is `onCellClick` with `trigger: "pointer"`, after the cell
 *   is selected as usual (the event has the modifier keys); a drag selects without clicking.
 * - Keyboard: Space on the active cell is `onCellClick` with `trigger: "keyboard"`; F2 and a double
 *   click are `onCellDoubleClick`. Enter, Tab and the arrows keep moving the active cell, as in
 *   spreadsheets, so that a grid full of links can still be walked through.
 * - Screen readers: the active cell's content gets the action's role (`link` or `button`), its
 *   `label` as name when given, and `aria-keyshortcuts="Space"`. A style's `description` is read after
 *   the value, since colors are not announced.
 *
 * The grid does not open links itself: handle `onCellClick` (for example with `window.open`).
 */

import type { CellStyle, CellValue, ColumnAlign, ColumnSchema, ColumnType } from "vastgrid-core";
import type { GridCell } from "./events.js";
import type { GridTheme } from "./theme.js";

/** A loaded cell, as the hooks see it. */
export interface GridCellContent extends GridCell {
  /** The loaded value (text cut for display ends with "…"). */
  value: CellValue;
  /** The column's schema entry. */
  schema: ColumnSchema;
  type: ColumnType;
  /** The text the grid shows, in one line, after the column's settings (`columnFormats`). */
  text: string;
}

/** What a cell does when it is clicked or Space is pressed on it. */
export interface CellAction {
  /** `link` opens or goes to something; `button` does something in place. Drawn links are underlined. */
  kind: "link" | "button";
  /** Name for screen readers, instead of the shown text, for example "Open order 1042". */
  label?: string;
  /** CSS cursor over the cell. Defaults to `pointer`. */
  cursor?: string;
}

/** Tells which cells do something; return `null` or `undefined` for plain cells. */
export type CellActionHook = (cell: GridCellContent) => CellAction | null | undefined;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Changes to the standard drawing of a cell (`drawDefault`). */
export interface DrawDefaultOptions {
  text?: string;
  color?: string;
  background?: string;
  align?: ColumnAlign;
  underline?: boolean;
}

export interface DrawCellArgs extends GridCellContent {
  /**
   * The canvas, in CSS pixels, with the cell font, `textBaseline = "middle"` and the column's
   * `textAlign`. It is clipped to the column, not to the cell: draw inside `rect`, or clip yourself.
   * Its state (colors, font, clip, transform) is restored after the hook.
   */
  ctx: CanvasRenderingContext2D;
  /** The cell on the canvas, grid line included at the right and bottom edges. */
  rect: CellRect;
  /** The colors from the column's `style` setting, or null. */
  style: CellStyle | null;
  align: ColumnAlign;
  /** The cell's action from `cellAction`, or null. */
  action: CellAction | null;
  /** The cell is in a selected range. The selection is drawn over the cell after the hook. */
  selected: boolean;
  /** The cell is the active cell. */
  active: boolean;
  /** The pointer is over the cell. */
  hovered: boolean;
  /** The cell's text matches the find bar's text; `drawDefault` highlights it. */
  matched: boolean;
  theme: GridTheme;
  /** Space the grid keeps at the left and right of the text, in pixels. */
  padding: number;
  /**
   * Draws the cell as the grid would: the style's background, the find highlight and the text, in the
   * style's color (or the link color for links). Options replace parts of it.
   */
  drawDefault(options?: DrawDefaultOptions): void;
  /** Shortens text with "…" to fit `width` pixels in the cell font. */
  fitText(text: string, width: number): string;
}

/**
 * Draws a cell instead of the grid. Call `args.drawDefault()` to draw the standard cell first and add
 * to it (a badge, an icon, a bar), or draw everything yourself. Cells that are not loaded keep their
 * placeholder and are not passed.
 */
export type DrawCell = (args: DrawCellArgs) => void;
