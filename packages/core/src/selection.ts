/**
 * Spreadsheet selection in display coordinates (`row` in the view, `col` in display order).
 *
 * Follows Excel and Google Sheets: the active cell stays where the selection started while
 * Shift+click or Shift+arrow moves the opposite corner (`focus`); Ctrl/⌘+click adds a range.
 */

export interface CellPosition {
  row: number;
  col: number;
}

/** An inclusive rectangle. `allRows` / `allCols` keep whole-column and whole-row selections whole when the size changes. */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
  allRows?: boolean;
  allCols?: boolean;
}

export type SelectMode = "replace" | "extend" | "add";

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

function rectangle(a: CellPosition, b: CellPosition): CellRange {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

export function rangeContains(range: CellRange, row: number, col: number) {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

export function rangeSize(range: CellRange) {
  return (range.bottom - range.top + 1) * (range.right - range.left + 1);
}

export class SelectionModel {
  private rows = 0;
  private cols = 0;
  private list: CellRange[] = [];
  private activeCell: CellPosition = { row: 0, col: 0 };
  private anchorCell: CellPosition = { row: 0, col: 0 };
  private focusCell: CellPosition = { row: 0, col: 0 };
  /** What the last range selects as a whole, so that extending keeps whole rows or columns. */
  private lastKind: "cells" | "rows" | "cols" | "all" = "cells";

  constructor(rows = 0, cols = 0) {
    this.setBounds(rows, cols);
  }

  get rowCount() {
    return this.rows;
  }

  get colCount() {
    return this.cols;
  }

  get active(): CellPosition {
    return this.activeCell;
  }

  get focus(): CellPosition {
    return this.focusCell;
  }

  get ranges(): readonly CellRange[] {
    return this.list;
  }

  /** The range that the keyboard extends (the last one). */
  get current(): CellRange | undefined {
    return this.list.at(-1);
  }

  get isEmpty() {
    return this.rows === 0 || this.cols === 0;
  }

  /** Total selected cells (overlaps count twice, as in Excel's status bar). */
  get size() {
    let total = 0;
    for (const range of this.list) total += rangeSize(range);
    return total;
  }

  /** Whether exactly one cell is selected. */
  get single() {
    const range = this.current;
    return this.list.length === 1 && range !== undefined && range.top === range.bottom && range.left === range.right;
  }

  setBounds(rows: number, cols: number) {
    this.rows = Math.max(0, rows);
    this.cols = Math.max(0, cols);
    const maxRow = Math.max(0, this.rows - 1);
    const maxCol = Math.max(0, this.cols - 1);
    const clampCell = (cell: CellPosition) => ({ row: clamp(cell.row, 0, maxRow), col: clamp(cell.col, 0, maxCol) });
    this.activeCell = clampCell(this.activeCell);
    this.anchorCell = clampCell(this.anchorCell);
    this.focusCell = clampCell(this.focusCell);
    this.list = this.list
      .map((range) => ({
        ...range,
        top: range.allRows ? 0 : clamp(range.top, 0, maxRow),
        bottom: range.allRows ? maxRow : clamp(range.bottom, 0, maxRow),
        left: range.allCols ? 0 : clamp(range.left, 0, maxCol),
        right: range.allCols ? maxCol : clamp(range.right, 0, maxCol),
      }))
      .filter((range) => range.top <= range.bottom && range.left <= range.right);
    if (this.list.length === 0 && !this.isEmpty) this.list = [rectangle(this.activeCell, this.activeCell)];
  }

  contains(row: number, col: number) {
    for (const range of this.list) if (rangeContains(range, row, col)) return true;
    return false;
  }

  /** Whether the whole row is selected by some range. */
  rowSelected(row: number) {
    return this.list.some((range) => range.allCols && row >= range.top && row <= range.bottom);
  }

  /** Whether the whole column is selected by some range. */
  colSelected(col: number) {
    return this.list.some((range) => range.allRows && col >= range.left && col <= range.right);
  }

  /** Whether some range touches the row (used to highlight row headers). */
  rowTouched(row: number) {
    return this.list.some((range) => row >= range.top && row <= range.bottom);
  }

  colTouched(col: number) {
    return this.list.some((range) => col >= range.left && col <= range.right);
  }

  private clampCell(cell: CellPosition): CellPosition {
    return { row: clamp(cell.row, 0, Math.max(0, this.rows - 1)), col: clamp(cell.col, 0, Math.max(0, this.cols - 1)) };
  }

  private replaceLast(range: CellRange) {
    if (this.list.length === 0) this.list = [range];
    else this.list = [...this.list.slice(0, -1), range];
  }

  private rangeFor(anchor: CellPosition, focus: CellPosition): CellRange {
    const maxRow = Math.max(0, this.rows - 1);
    const maxCol = Math.max(0, this.cols - 1);
    switch (this.lastKind) {
      case "rows":
        return {
          top: Math.min(anchor.row, focus.row),
          bottom: Math.max(anchor.row, focus.row),
          left: 0,
          right: maxCol,
          allCols: true,
        };
      case "cols":
        return {
          top: 0,
          bottom: maxRow,
          left: Math.min(anchor.col, focus.col),
          right: Math.max(anchor.col, focus.col),
          allRows: true,
        };
      case "all":
        return { top: 0, left: 0, bottom: maxRow, right: maxCol, allRows: true, allCols: true };
      default:
        return rectangle(anchor, focus);
    }
  }

  /** Selects a cell: replaces the selection, extends the current range to it, or adds a new range. */
  select(position: CellPosition, mode: SelectMode = "replace") {
    if (this.isEmpty) return;
    const cell = this.clampCell(position);
    if (mode === "extend") {
      this.focusCell = cell;
      this.replaceLast(this.rangeFor(this.anchorCell, cell));
      return;
    }
    this.lastKind = "cells";
    this.activeCell = cell;
    this.anchorCell = cell;
    this.focusCell = cell;
    const range = rectangle(cell, cell);
    this.list = mode === "add" ? [...this.list, range] : [range];
  }

  /** Selects whole rows from `from` to `to`. */
  selectRows(from: number, to: number, mode: SelectMode = "replace") {
    if (this.isEmpty) return;
    const col = this.activeCell.col;
    if (mode === "extend") {
      this.lastKind = "rows";
      this.focusCell = this.clampCell({ row: to, col });
      this.replaceLast(this.rangeFor(this.anchorCell, this.focusCell));
      return;
    }
    this.lastKind = "rows";
    this.anchorCell = this.clampCell({ row: from, col });
    this.activeCell = this.anchorCell;
    this.focusCell = this.clampCell({ row: to, col });
    const range = this.rangeFor(this.anchorCell, this.focusCell);
    this.list = mode === "add" ? [...this.list, range] : [range];
  }

  /** Selects whole columns from `from` to `to`. */
  selectCols(from: number, to: number, mode: SelectMode = "replace") {
    if (this.isEmpty) return;
    const row = this.activeCell.row;
    if (mode === "extend") {
      this.lastKind = "cols";
      this.focusCell = this.clampCell({ row, col: to });
      this.replaceLast(this.rangeFor(this.anchorCell, this.focusCell));
      return;
    }
    this.lastKind = "cols";
    this.anchorCell = this.clampCell({ row, col: from });
    this.activeCell = this.anchorCell;
    this.focusCell = this.clampCell({ row, col: to });
    const range = this.rangeFor(this.anchorCell, this.focusCell);
    this.list = mode === "add" ? [...this.list, range] : [range];
  }

  selectAll() {
    if (this.isEmpty) return;
    this.lastKind = "all";
    this.list = [this.rangeFor(this.activeCell, this.activeCell)];
    this.anchorCell = this.activeCell;
    this.focusCell = this.activeCell;
  }

  /**
   * Arrow-key movement. Without `extend` the active cell moves and the selection collapses to it.
   * With `extend` the focus corner moves and the active cell stays. Returns the cell to scroll into view.
   */
  move(deltaRow: number, deltaCol: number, extend = false): CellPosition {
    if (this.isEmpty) return this.activeCell;
    if (extend) {
      const focus = this.clampCell({ row: this.focusCell.row + deltaRow, col: this.focusCell.col + deltaCol });
      this.select(focus, "extend");
      return focus;
    }
    const cell = this.clampCell({ row: this.activeCell.row + deltaRow, col: this.activeCell.col + deltaCol });
    this.select(cell, "replace");
    return cell;
  }

  /** Moves to an absolute cell (for example Ctrl+Home), extending the selection when asked. */
  moveTo(position: CellPosition, extend = false): CellPosition {
    const cell = this.clampCell(position);
    this.select(cell, extend ? "extend" : "replace");
    return cell;
  }

  /**
   * Tab and Enter: inside a multi-cell selection the active cell walks through the selection and
   * wraps (Excel); otherwise it moves like an arrow key.
   */
  advance(deltaRow: number, deltaCol: number): CellPosition {
    const range = this.current;
    if (!range || this.single || this.list.length !== 1) return this.move(deltaRow, deltaCol);
    let { row, col } = this.activeCell;
    if (deltaCol !== 0) {
      col += deltaCol;
      if (col > range.right) {
        col = range.left;
        row = row + 1 > range.bottom ? range.top : row + 1;
      } else if (col < range.left) {
        col = range.right;
        row = row - 1 < range.top ? range.bottom : row - 1;
      }
    } else {
      row += deltaRow;
      if (row > range.bottom) {
        row = range.top;
        col = col + 1 > range.right ? range.left : col + 1;
      } else if (row < range.top) {
        row = range.bottom;
        col = col - 1 < range.left ? range.right : col - 1;
      }
    }
    this.activeCell = { row, col };
    return this.activeCell;
  }
}
