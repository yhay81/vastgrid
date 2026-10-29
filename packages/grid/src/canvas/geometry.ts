import { ColumnLayout } from "./layout.js";
import { ScrollAxis } from "./scroll.js";

/** The width of the check boxes at the left of the gutter (§5.2.1 of the specification). */
export const CHECK_WIDTH = 24;
/** The width of the button at the right of a header that opens the column menu. */
export const MENU_WIDTH = 16;

/** What is under a point of the grid. */
export interface Hit {
  area: "cell" | "header" | "group" | "gutter" | "corner" | "none";
  /** A view position, for cells and the gutter; clamped to the rows. */
  row: number;
  /** A display position, for cells and headers. */
  column: number;
  /** Within a few pixels of the right edge of a header, where dragging resizes the column. */
  edge: boolean;
  /** On the button of a header that opens the column menu. */
  menu: boolean;
  /** On the check box of a row (the gutter) or of every row (the corner). */
  check?: boolean;
  /** For a group header: its row of groups, from the top. */
  level?: number;
}

/**
 * Where the parts of the grid are on the canvas (§6 of react.md): the rows of groups and the column names at the
 * top, the gutter at the left, the rows, the totals row at the bottom, and the columns pinned at each side with those
 * that scroll between them. The canvas lays it out and draws with it; React places what it puts over the canvas
 * with it.
 */
export class Geometry {
  readonly scrollX = new ScrollAxis();
  readonly scrollY = new ScrollAxis();
  width = 0;
  height = 0;
  rowHeight = 24;
  headerHeight = 32;
  /** The height of the row of column names; `headerHeight` adds the rows of groups above it. */
  nameHeight = 32;
  groupHeight = 24;
  /** Rows of groups above the column names. */
  groupRows = 0;
  /** By display position: its group in each row of groups (an id and a name), or null. */
  groupPaths: ({ id: number; name: string } | null)[][] = [];
  gutterWidth = 48;
  /** Whether the gutter has a check box for each row. */
  checkboxes = false;
  /** The height of the totals row at the bottom (§5.1 of the specification), 0 without totals. */
  footer = 0;
  /** The rows of the view on screen. */
  rowCount = 0;
  /** The widths of the displayed columns, by display position. */
  layout = new ColumnLayout([]);
  /** How many displayed columns are pinned at the left and at the right. */
  frozenLeft = 0;
  frozenRight = 0;

  /** The top of the row of column names: the rows of groups are above it. */
  get groupTop() {
    return this.groupRows * this.groupHeight;
  }

  /** The first row on screen. */
  topRow() {
    return Math.max(0, Math.floor(this.scrollY.position / this.rowHeight));
  }

  /** Rows on screen `[first, last)`. */
  visibleRows(): [number, number] {
    const rowCount = this.rowCount;
    const body = Math.max(0, this.bottom - this.headerHeight);
    const first = Math.min(rowCount, this.topRow());
    const last = Math.min(rowCount, Math.ceil((this.scrollY.position + body) / this.rowHeight));
    return [first, Math.max(first, last)];
  }

  /** The bottom of the rows: the top of the totals row. */
  get bottom() {
    return this.height - this.footer;
  }

  get frozenWidth() {
    return this.layout.left(this.frozenLeft);
  }

  get rightStart() {
    return this.layout.count - this.frozenRight;
  }

  get frozenRightWidth() {
    return this.layout.total - this.layout.left(this.rightStart);
  }

  /** Display positions `[first, last]` of the scrolling columns on screen, or `[0, -1]`. */
  visibleScrollColumns(): [number, number] {
    const rightStart = this.rightStart;
    if (rightStart <= this.frozenLeft) return [0, -1];
    const start = this.frozenWidth + this.scrollX.position;
    const end = Math.min(
      this.scrollX.position + this.width - this.gutterWidth - this.frozenRightWidth,
      this.layout.left(rightStart),
    );
    if (start >= this.layout.left(rightStart) || end <= start) return [0, -1];
    const first = Math.max(this.frozenLeft, this.layout.indexAt(start));
    const last = Math.min(rightStart - 1, this.layout.indexAt(Math.max(start, end - 0.001)));
    return [first, last];
  }

  /** The x of a displayed column's left edge on the canvas. */
  columnX(column: number) {
    if (column < this.frozenLeft) return this.gutterWidth + this.layout.left(column);
    if (column >= this.rightStart) {
      return this.width - this.frozenRightWidth + this.layout.left(column) - this.layout.left(this.rightStart);
    }
    return this.gutterWidth + this.layout.left(column) - this.scrollX.position;
  }

  rowY(row: number) {
    return this.headerHeight + row * this.rowHeight - this.scrollY.position;
  }

  /** The width of a displayed column. */
  columnWidth(column: number) {
    return this.layout.width(column);
  }

  /**
   * Where a cell is, in the body's coordinates, and whether it is on screen: outside the header and the gutter,
   * and for a scrolling column, between the columns pinned at each side.
   */
  cellBox(row: number, column: number): { left: number; top: number; width: number; height: number; shown: boolean } {
    const left = this.columnX(column);
    const top = this.rowY(row);
    const width = this.layout.width(column);
    const height = this.rowHeight;
    const scrolls = column >= this.frozenLeft && column < this.rightStart;
    const from = scrolls ? this.gutterWidth + this.frozenWidth : this.gutterWidth;
    const to = scrolls ? this.width - this.frozenRightWidth : this.width;
    const shown = top + height > this.headerHeight && top < this.bottom && left + width > from && left < to;
    return { left, top, width, height, shown };
  }

  /** What is at a point given in the scroller's client coordinates. */
  hit(x: number, y: number): Hit {
    const rowCount = this.rowCount;
    const none: Hit = { area: "none", row: 0, column: 0, edge: false, menu: false };
    if (x < 0 || y < 0 || x > this.width || y > this.height || y >= this.bottom) return none;
    const row = Math.max(
      0,
      Math.min(rowCount - 1, Math.floor((y - this.headerHeight + this.scrollY.position) / this.rowHeight)),
    );
    // Below the last row, the gutter and the cells are empty.
    const empty =
      y >= this.headerHeight &&
      (rowCount === 0 || y - this.headerHeight + this.scrollY.position >= rowCount * this.rowHeight);
    if (x < this.gutterWidth) {
      if (empty) return none;
      return {
        area: y < this.headerHeight ? "corner" : "gutter",
        row,
        column: 0,
        edge: false,
        menu: false,
        check: this.checkboxes && x < CHECK_WIDTH,
      };
    }
    const column = this.columnAt(x);
    if (column < 0) return none;
    const right = this.columnX(column) + this.layout.width(column);
    const edge = Math.abs(x - right) <= 4;
    if (y < this.groupTop) {
      const level = Math.floor(y / this.groupHeight);
      return {
        area: this.groupPaths[column]?.[level] ? "group" : "none",
        row: 0,
        column,
        edge: false,
        menu: false,
        level,
      };
    }
    if (y < this.headerHeight) {
      return { area: "header", row: 0, column, edge, menu: !edge && x >= right - MENU_WIDTH - 4 };
    }
    if (empty) return none;
    return { area: "cell", row, column, edge: false, menu: false };
  }

  /** The display position of the column at an x of the canvas; -1 when there is none. */
  columnAt(x: number) {
    if (this.layout.count === 0) return -1;
    const rightX = this.width - this.frozenRightWidth;
    if (this.frozenRight > 0 && x >= rightX) {
      return Math.max(this.rightStart, this.layout.indexAt(this.layout.left(this.rightStart) + x - rightX));
    }
    const local = x - this.gutterWidth;
    if (this.frozenLeft > 0 && local < this.frozenWidth) return this.layout.indexAt(local);
    const column = this.layout.indexAt(local + this.scrollX.position);
    return Math.min(column, this.rightStart - 1);
  }
}
