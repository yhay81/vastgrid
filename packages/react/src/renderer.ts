import {
  type CacheBlock,
  type CellRange,
  type CellStyle,
  type CellValue,
  type ColumnAlign,
  type ColumnFormatter,
  type ColumnType,
  rangeContains,
} from "vastgrid-core";
import type { CellAction, DrawCell, GridCellContent } from "./cell-render.js";
import type { GridController } from "./controller.js";
import { TextFitter } from "./text.js";
import type { GridTheme } from "./theme.js";

const PADDING = 8;
const ICON_SPACE = 18;

/** A short mark for the column type, drawn before the column name. */
function typeMark(type: ColumnType) {
  switch (type) {
    case "integer":
    case "bigint":
    case "float":
    case "decimal":
      return "#";
    case "boolean":
      return "✓";
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
    case "interval":
      return "◷";
    case "list":
    case "struct":
    case "map":
    case "json":
      return "{}";
    case "string":
      return "A";
    default:
      return "·";
  }
}

/**
 * Draws a `GridController` onto a canvas: cells, headers, row numbers, grid lines and the
 * selection. Draws at most once per animation frame, only what is visible.
 */
export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private theme: GridTheme;
  private cellText!: TextFitter;
  private headerText!: TextFitter;
  private smallText!: TextFitter;
  private frame = 0;
  private ratio = 1;
  private formatKey = "";
  /** The cell font as the context gives it back, to tell whether it is set. */
  private cellFont = "";
  /** Widths numeric columns needed in the last frame. */
  private readonly needed = new Map<number, number>();
  /** Durations of the last frames in milliseconds, for diagnostics (`timings()`). */
  private readonly durations: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly controller: GridController,
    theme: GridTheme,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is not available.");
    this.context = context;
    this.theme = theme;
    this.setTheme(theme);
    controller.measure = (text, header) => {
      const fitter = header ? this.headerText : this.cellText;
      this.context.font = fitter.font;
      return fitter.width(text);
    };
  }

  setTheme(theme: GridTheme) {
    this.theme = theme;
    this.cellText = new TextFitter(this.context, theme.font);
    this.headerText = new TextFitter(this.context, theme.headerFont);
    this.smallText = new TextFitter(this.context, theme.smallFont);
    this.formatKey = "";
    this.controller.options.lineHeight = theme.lineHeight;
    this.controller.updateLayout();
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.controller.measure = null;
  }

  /** A 1-device-pixel line position. */
  private snap(value: number) {
    return (Math.round(value * this.ratio) + 0.5) / this.ratio;
  }

  private resize() {
    const { width, height } = this.controller;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight || this.ratio !== ratio) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.ratio = ratio;
    }
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** Average and slowest draw time of the recent frames, in milliseconds. */
  timings() {
    const count = this.durations.length;
    const total = this.durations.reduce((sum, value) => sum + value, 0);
    return { frames: count, average: count ? total / count : 0, slowest: count ? Math.max(...this.durations) : 0 };
  }

  draw() {
    const started = performance.now();
    this.paint();
    this.durations.push(performance.now() - started);
    if (this.durations.length > 120) this.durations.shift();
  }

  private paint() {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    this.resize();
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, c.width, c.height);
    if (!c.info || c.visible.length === 0) return;
    this.formatKey = String(c.formatVersion);

    const [firstRow, lastRow] = c.visibleRows();
    const [firstCol, lastCol] = c.visibleScrollColumns();
    const wanted: number[] = [];
    for (let col = 0; col < c.frozen; col++) wanted.push(c.visible[col].index);
    for (let col = firstCol; col <= lastCol; col++) wanted.push(c.visible[col].index);
    // The checkboxes need the key column, also when it is hidden or scrolled away.
    const keyColumn = c.options.checkboxSelection ? c.rowKeyColumn : -1;
    if (keyColumn >= 0 && !wanted.includes(keyColumn)) wanted.push(keyColumn);
    c.cache.want(firstRow, lastRow, wanted);

    const headerHeight = c.options.headerHeight;
    const scrollLeft = c.gutterWidth + c.frozenWidth;
    // Scrollable columns.
    this.clipped(scrollLeft, headerHeight, c.width - scrollLeft, c.height - headerHeight, () => {
      for (let col = firstCol; col <= lastCol; col++) this.drawCells(col, firstRow, lastRow);
      this.drawCheckedRows(scrollLeft, firstRow, lastRow);
      this.drawLines(firstCol, lastCol, firstRow, lastRow);
      this.drawSelection(false);
    });
    // Frozen columns.
    if (c.frozen > 0) {
      this.clipped(c.gutterWidth, headerHeight, c.frozenWidth, c.height - headerHeight, () => {
        for (let col = 0; col < c.frozen; col++) this.drawCells(col, firstRow, lastRow);
        this.drawCheckedRows(c.gutterWidth, firstRow, lastRow);
        this.drawLines(0, c.frozen - 1, firstRow, lastRow);
        this.drawSelection(true);
      });
    }
    this.drawHeaders(firstCol, lastCol);
    this.drawGutter(firstRow, lastRow);
    this.drawCorner();
    if (this.needed.size > 0) {
      const needed = new Map(this.needed);
      this.needed.clear();
      c.growColumns(needed);
    }
    if (c.frozen > 0) {
      ctx.strokeStyle = t.lineStrong;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x = this.snap(scrollLeft) - 0.5 / this.ratio;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.stroke();
    }
    if (c.resizing >= 0) {
      const x = c.columnX(c.resizing) + c.layout.width(c.resizing);
      ctx.fillStyle = t.accent;
      ctx.fillRect(x - 1, 0, 2, c.height);
    }
  }

  private clipped(x: number, y: number, width: number, height: number, draw: () => void) {
    if (width <= 0 || height <= 0) return;
    const ctx = this.context;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    draw();
    ctx.restore();
  }

  private textOf(block: CacheBlock, column: number, row: number, value: CellValue, formatter: ColumnFormatter) {
    if (block.textKey !== this.formatKey || !block.text) {
      block.text = block.columns.map(() => []);
      block.styles = null;
      block.textKey = this.formatKey;
    }
    const list = block.text[column - block.firstColumn];
    const offset = row - block.start;
    let text = list[offset];
    if (text === undefined) {
      text = formatter.format(value);
      list[offset] = text;
    }
    return text;
  }

  /** The colors of a cell from its column's `style` setting, kept with the block's text. */
  private styleOf(
    block: CacheBlock,
    column: number,
    row: number,
    value: CellValue,
    text: string,
    formatter: ColumnFormatter,
  ) {
    block.styles ??= block.columns.map(() => []);
    const list = block.styles[column - block.firstColumn];
    const offset = row - block.start;
    let style = list[offset];
    if (style === undefined) {
      style = formatter.style(value, text);
      list[offset] = style;
    }
    return style;
  }

  private drawCells(col: number, firstRow: number, lastRow: number) {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    const state = c.visible[col];
    const schema = c.schema[state.index];
    if (!schema) return;
    const x = c.columnX(col);
    const width = c.layout.width(col);
    const rowHeight = c.rowHeight;
    const formatter = c.formatterOf(state.index);
    const numeric = formatter.numeric;
    const align = formatter.align;
    const wrap = formatter.wrap;
    const maxLines = c.maxLines;
    const lineHeight = c.options.lineHeight ?? 18;
    this.cellLines = wrap ? maxLines : 0;
    this.cellLineHeight = lineHeight;
    const styled = formatter.styled;
    const { drawCell, cellAction } = c.options;
    const textWidth = width - PADDING * 2;
    const find = c.findText ? (c.findCaseSensitive ? c.findText : c.findText.toLowerCase()) : "";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, c.options.headerHeight, width, c.height);
    ctx.clip();
    ctx.font = this.cellText.font;
    this.cellFont = ctx.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = align;
    for (let row = firstRow; row < lastRow; row++) {
      const y = c.rowY(row);
      const block = c.cache.blockAt(row, state.index);
      if (block?.state !== "ready" || !block.values || row >= block.end) {
        if (row < c.readableRows && textWidth > 12) {
          ctx.fillStyle = block?.state === "error" ? t.error : t.placeholder;
          const length = Math.min(textWidth, 24 + ((row * 7919 + state.index * 104729) % 48));
          const left =
            align === "right"
              ? x + width - PADDING - length
              : align === "center"
                ? x + (width - length) / 2
                : x + PADDING;
          ctx.fillRect(left, y + rowHeight / 2 - 3, length, 6);
        }
        continue;
      }
      const value = block.values[state.index - block.firstColumn]?.[row - block.start] ?? null;
      const text = this.textOf(block, state.index, row, value, formatter);
      const style = styled ? this.styleOf(block, state.index, row, value, text, formatter) : null;
      const matched = find !== "" && text !== "" && (c.findCaseSensitive ? text : text.toLowerCase()).includes(find);
      if (numeric && value !== null && text !== "" && !state.sized) {
        const needed = this.cellText.width(text) + PADDING * 2 + 2;
        if (needed > width && needed > (this.needed.get(col) ?? 0)) this.needed.set(col, needed);
      }
      if (!drawCell && !cellAction) {
        this.paintCell(x, y, width, rowHeight, text, value, style, align, matched, null);
        continue;
      }
      const content: GridCellContent = {
        row,
        rowId: c.rowId(row),
        col,
        column: state.index,
        value,
        schema,
        type: schema.type,
        text,
      };
      const action = cellAction?.(content) ?? null;
      if (drawCell) this.customCell(drawCell, content, x, y, width, rowHeight, style, align, matched, action);
      else this.paintCell(x, y, width, rowHeight, text, value, style, align, matched, action);
    }
    ctx.restore();
  }

  /**
   * Shades the checked rows from `left` to the right edge, over the cells, so that cell backgrounds
   * (conditional formats, `drawCell`) keep showing the rows as checked.
   */
  private drawCheckedRows(left: number, firstRow: number, lastRow: number) {
    const c = this.controller;
    if (!c.options.checkboxSelection || c.rowSelection.empty) return;
    const ctx = this.context;
    ctx.fillStyle = this.theme.checkedRow;
    // Rows grow while a column wraps.
    const rowHeight = c.rowHeight;
    for (let row = firstRow; row < lastRow; row++) {
      if (c.rowChecked(row) === true) ctx.fillRect(left, c.rowY(row), c.width - left, rowHeight);
    }
  }

  /** A checkbox centered at x, y: checked, unchecked, mixed, or `null` for unknown (drawn faint). */
  private checkbox(x: number, y: number, state: boolean | "mixed" | null, hovered: boolean) {
    const ctx = this.context;
    const t = this.theme;
    const size = 13;
    const left = Math.round(x - size / 2) + 0.5;
    const top = Math.round(y - size / 2) + 0.5;
    ctx.save();
    if (state === null) ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, top, size - 1, size - 1, 3);
    if (state === true || state === "mixed") {
      ctx.fillStyle = t.accent;
      ctx.fill();
      ctx.strokeStyle = t.accentText;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      if (state === true) {
        ctx.moveTo(left + 3, top + 6.5);
        ctx.lineTo(left + 5.2, top + 8.8);
        ctx.lineTo(left + 9.2, top + 3.6);
      } else {
        ctx.moveTo(left + 3, top + 6);
        ctx.lineTo(left + 9, top + 6);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = t.background;
      ctx.fill();
      ctx.strokeStyle = hovered ? t.accent : t.muted;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Lines a wrapping column draws in each cell (0: one line, cut to fit), set for each column drawn. */
  private cellLines = 0;
  private cellLineHeight = 18;

  /** The standard drawing of a loaded cell. `ctx.textAlign` must already be `align`. */
  private paintCell(
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
    value: CellValue,
    style: CellStyle | null,
    align: ColumnAlign,
    matched: boolean,
    action: CellAction | null,
    color?: string,
    underline?: boolean,
  ) {
    const ctx = this.context;
    const t = this.theme;
    const background = style?.background;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(x, y, width, height);
    }
    if (matched) {
      ctx.fillStyle = t.match;
      ctx.fillRect(x, y, width, height);
    }
    if (text === "") return;
    const link = action?.kind === "link";
    ctx.fillStyle = color ?? style?.color ?? (link ? t.link : value === null ? t.nullText : t.text);
    const textX = align === "right" ? x + width - PADDING : align === "center" ? x + width / 2 : x + PADDING;
    // A wrapping column draws up to `cellLines` lines, centered in the row so that one line is level
    // with the other columns.
    const lines =
      this.cellLines > 0
        ? this.cellText.lines(text, width - PADDING * 2, this.cellLines)
        : [this.cellText.fit(text, width - PADDING * 2)];
    const lineHeight = this.cellLines > 0 ? this.cellLineHeight : height;
    let middle = y + (height - lines.length * lineHeight) / 2 + lineHeight / 2 + 0.5;
    for (const shown of lines) {
      ctx.fillText(shown, textX, middle);
      if (underline ?? link) {
        const length = this.cellText.width(shown);
        const left = align === "right" ? textX - length : align === "center" ? textX - length / 2 : textX;
        ctx.fillRect(left, Math.round(middle + this.theme.fontSize / 2), length, 1);
      }
      middle += lineHeight;
    }
  }

  /** Sets the cell font, unless it is set: setting a font costs more than drawing a cell. */
  private useCellFont() {
    if (this.context.font !== this.cellFont) {
      this.context.font = this.cellText.font;
      this.cellFont = this.context.font;
    }
  }

  /** Lets the `drawCell` hook draw a loaded cell, clipped to it. */
  private customCell(
    drawCell: DrawCell,
    content: GridCellContent,
    x: number,
    y: number,
    width: number,
    height: number,
    style: CellStyle | null,
    align: ColumnAlign,
    matched: boolean,
    action: CellAction | null,
  ) {
    const c = this.controller;
    const ctx = this.context;
    const { row, col } = content;
    const hover = c.hover;
    const active = c.selection.active;
    ctx.save();
    try {
      drawCell({
        ...content,
        ctx,
        rect: { x, y, width, height },
        style,
        align,
        action,
        selected: c.selection.contains(row, col),
        active: active.row === row && active.col === col,
        hovered: hover?.zone === "cell" && hover.row === row && hover.col === col,
        matched,
        theme: this.theme,
        padding: PADDING,
        drawDefault: (options = {}) => {
          const cellAlign = options.align ?? align;
          this.useCellFont();
          if (ctx.textBaseline !== "middle") ctx.textBaseline = "middle";
          if (ctx.textAlign !== cellAlign) ctx.textAlign = cellAlign;
          const cellStyle = options.background === undefined ? style : { ...style, background: options.background };
          this.paintCell(
            x,
            y,
            width,
            height,
            options.text ?? content.text,
            content.value,
            cellStyle,
            cellAlign,
            matched,
            action,
            options.color,
            options.underline,
          );
        },
        fitText: (text, maxWidth) => {
          this.useCellFont();
          return this.cellText.fit(text, maxWidth);
        },
      });
    } finally {
      ctx.restore();
    }
  }

  private drawLines(firstCol: number, lastCol: number, firstRow: number, lastRow: number) {
    const c = this.controller;
    const ctx = this.context;
    const top = c.options.headerHeight;
    const bottom = Math.min(c.height, c.rowY(c.rowCount));
    const left = firstCol < c.frozen ? c.gutterWidth : c.gutterWidth + c.frozenWidth;
    const right = lastCol >= 0 ? Math.min(c.width, c.columnX(lastCol) + c.layout.width(lastCol)) : left;
    ctx.strokeStyle = this.theme.line;
    ctx.lineWidth = 1 / this.ratio;
    ctx.beginPath();
    for (let row = firstRow; row < lastRow; row++) {
      const y = this.snap(c.rowY(row + 1)) - 1 / this.ratio;
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    for (let col = firstCol; col <= lastCol; col++) {
      const x = this.snap(c.columnX(col) + c.layout.width(col)) - 1 / this.ratio;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();
  }

  /** The screen rectangle of a range within the frozen or the scrollable columns, or null. */
  private rangeRect(range: CellRange, frozen: boolean) {
    const c = this.controller;
    const left = frozen ? range.left : Math.max(range.left, c.frozen);
    const right = frozen ? Math.min(range.right, c.frozen - 1) : range.right;
    if (left > right) return null;
    const x0 = c.columnX(left);
    const x1 = c.columnX(right) + c.layout.width(right);
    const y0 = Math.max(c.options.headerHeight - 2, c.rowY(range.top));
    const y1 = Math.min(c.height + 2, c.rowY(range.bottom + 1));
    if (y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  private drawSelection(frozen: boolean) {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    if (c.rowCount === 0) return;
    const ranges = c.selection.ranges;
    const active = c.selection.active;
    const single = c.selection.single;
    const activeRect = this.rangeRect(
      { top: active.row, bottom: active.row, left: active.col, right: active.col },
      frozen,
    );
    if (!single) {
      ctx.fillStyle = t.selection;
      ranges.forEach((range) => {
        const rect = this.rangeRect(range, frozen);
        if (!rect) return;
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        // The active cell stays unshaded inside the selection, as in spreadsheets.
        if (activeRect && rangeContains(range, active.row, active.col)) {
          ctx.rect(activeRect.x, activeRect.y, activeRect.width, activeRect.height);
        }
        ctx.fill("evenodd");
      });
      ctx.strokeStyle = t.selectionBorder;
      ranges.forEach((range, index) => {
        const rect = this.rangeRect(range, frozen);
        if (!rect) return;
        ctx.lineWidth = index === ranges.length - 1 ? 2 : 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
      });
    }
    if (activeRect) {
      ctx.strokeStyle = t.activeBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(activeRect.x + 1, activeRect.y + 1, activeRect.width - 2, activeRect.height - 2);
    }
  }

  private drawHeaders(firstCol: number, lastCol: number) {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    const height = c.options.headerHeight;
    ctx.fillStyle = t.headerBackground;
    ctx.fillRect(0, 0, c.width, height);
    const scrollLeft = c.gutterWidth + c.frozenWidth;
    this.clipped(scrollLeft, 0, c.width - scrollLeft, height, () => {
      for (let col = firstCol; col <= lastCol; col++) this.drawHeader(col);
    });
    this.clipped(c.gutterWidth, 0, c.frozenWidth, height, () => {
      for (let col = 0; col < c.frozen; col++) this.drawHeader(col);
    });
    ctx.strokeStyle = t.lineStrong;
    ctx.lineWidth = 1 / this.ratio;
    ctx.beginPath();
    const y = this.snap(height) - 1 / this.ratio;
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
  }

  private drawHeader(col: number) {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    const state = c.visible[col];
    const schema = c.schema[state.index];
    if (!schema) return;
    const x = c.columnX(col);
    const width = c.layout.width(col);
    const height = c.options.headerHeight;
    const hovered = c.hover?.zone === "header" && c.hover.col === col;
    if (c.selection.colSelected(col)) {
      ctx.fillStyle = t.selection;
      ctx.fillRect(x, 0, width, height);
    } else if (c.selection.colTouched(col) || hovered) {
      ctx.fillStyle = t.headerActive;
      ctx.fillRect(x, 0, width, height);
    }
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    // Indicators on the right: menu (while hovered or active), filter, sort.
    let right = x + width - 6;
    const sort = c.sortOf(state.index);
    const filtered = c.isFiltered(state.index);
    if (hovered || c.selection.active.col === col) {
      if (hovered && c.hover?.menu) {
        ctx.fillStyle = t.headerActive;
        ctx.fillRect(right - 18, height / 2 - 9, 18, 18);
      }
      this.chevron(right - 9, height / 2, t.muted);
      right -= 20;
    }
    if (filtered) {
      this.funnel(right - 6, height / 2, t.accent);
      right -= 16;
    }
    if (sort) {
      this.triangle(right - 5, height / 2, sort.direction === "asc", t.accent);
      right -= 14;
      if ((c.query.sort?.length ?? 0) > 1) {
        ctx.font = this.smallText.font;
        ctx.fillStyle = t.accent;
        ctx.textAlign = "right";
        ctx.fillText(String(sort.order), right, height / 2 + 0.5);
        ctx.textAlign = "left";
        right -= 8;
      }
      right -= 2;
    }
    // The type mark gives way to the name in narrow columns.
    let start = x + PADDING;
    if (right - start - ICON_SPACE >= 28) {
      ctx.font = this.smallText.font;
      ctx.fillStyle = t.muted;
      ctx.fillText(typeMark(schema.type), start, height / 2 + 0.5);
      start += ICON_SPACE;
    }
    ctx.font = this.headerText.font;
    ctx.fillStyle = t.headerText;
    ctx.fillText(this.headerText.fit(c.columnLabel(state.index), right - start), start, height / 2 + 0.5);
    // Separator.
    ctx.strokeStyle = t.line;
    ctx.lineWidth = 1 / this.ratio;
    ctx.beginPath();
    const line = this.snap(x + width) - 1 / this.ratio;
    ctx.moveTo(line, 6);
    ctx.lineTo(line, height - 6);
    ctx.stroke();
  }

  private chevron(x: number, y: number, color: string) {
    const ctx = this.context;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 2);
    ctx.lineTo(x, y + 2);
    ctx.lineTo(x + 4, y - 2);
    ctx.stroke();
  }

  private triangle(x: number, y: number, up: boolean, color: string) {
    const ctx = this.context;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x - 4.5, y + 3);
      ctx.lineTo(x + 4.5, y + 3);
      ctx.lineTo(x, y - 4);
    } else {
      ctx.moveTo(x - 4.5, y - 3);
      ctx.lineTo(x + 4.5, y - 3);
      ctx.lineTo(x, y + 4);
    }
    ctx.closePath();
    ctx.fill();
  }

  private funnel(x: number, y: number, color: string) {
    const ctx = this.context;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5.5, y - 5);
    ctx.lineTo(x + 5.5, y - 5);
    ctx.lineTo(x + 1.2, y);
    ctx.lineTo(x + 1.2, y + 5);
    ctx.lineTo(x - 1.2, y + 3.5);
    ctx.lineTo(x - 1.2, y);
    ctx.closePath();
    ctx.fill();
  }

  private drawGutter(firstRow: number, lastRow: number) {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    const width = c.gutterWidth;
    const top = c.options.headerHeight;
    const rowHeight = c.rowHeight;
    ctx.fillStyle = t.gutterBackground;
    ctx.fillRect(0, top, width, c.height - top);
    this.clipped(0, top, width, c.height - top, () => {
      ctx.font = this.smallText.font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      const viewed = c.view.id !== null;
      const boxes = c.checkboxWidth;
      for (let row = firstRow; row < lastRow; row++) {
        const y = c.rowY(row);
        if (boxes > 0) {
          const hovered = c.hover?.zone === "gutter" && c.hover.checkbox && c.hover.row === row;
          this.checkbox(boxes / 2 + 2, y + rowHeight / 2, c.rowChecked(row), hovered);
        }
        if (c.selection.rowSelected(row)) {
          ctx.fillStyle = t.selection;
          ctx.fillRect(0, y, width, rowHeight);
        } else if (c.selection.rowTouched(row)) {
          ctx.fillStyle = t.headerActive;
          ctx.fillRect(0, y, width, rowHeight);
        }
        const label = c.rowLabel(row);
        if (label === null) continue;
        ctx.fillStyle = viewed ? t.gutterViewText : t.gutterText;
        ctx.fillText(String(label), width - 8, y + rowHeight / 2 + 0.5);
      }
    });
    ctx.strokeStyle = t.lineStrong;
    ctx.lineWidth = 1 / this.ratio;
    ctx.beginPath();
    const x = this.snap(width) - 1 / this.ratio;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
    ctx.stroke();
  }

  private drawCorner() {
    const c = this.controller;
    const ctx = this.context;
    const t = this.theme;
    const width = c.gutterWidth;
    const height = c.options.headerHeight;
    const boxes = c.checkboxWidth;
    ctx.fillStyle = c.hover?.zone === "corner" && !c.hover.checkbox ? t.headerActive : t.headerBackground;
    ctx.fillRect(0, 0, width, height);
    if (boxes > 0) {
      const state = c.rowSelectionPending ? null : c.allRowsChecked;
      this.checkbox(boxes / 2 + 2, height / 2, state, c.hover?.zone === "corner" && c.hover.checkbox);
    }
    ctx.fillStyle = t.muted;
    ctx.beginPath();
    ctx.moveTo(width - 6, height - 14);
    ctx.lineTo(width - 6, height - 6);
    ctx.lineTo(width - 14, height - 6);
    ctx.closePath();
    ctx.fill();
  }
}
