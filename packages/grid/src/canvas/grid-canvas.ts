import { type Column, columnsOf, type DisplayedColumn, type JsonValue, partsOf, textOf } from "vastgrid-spec";
import { allState, checkState } from "../core/checked.js";
import { compileRule, type Rule } from "../core/evaluate.js";
import { formatterFor } from "../core/format.js";
import type { GridStore } from "../core/store.js";
import { now, track } from "../core/trace.js";
import type { GridSnapshot } from "../core/types.js";
import { ColumnLayout, fitFrozen } from "./layout.js";
import { ScrollAxis } from "./scroll.js";
import { TextFitter } from "./text.js";
import { cssLength, type GridTheme, resolveTheme } from "./theme.js";

const PADDING = 8;
const MIN_WIDTH = 40;
const MAX_AUTO_WIDTH = 360;
/** Lines of a row while a displayed column wraps its text (§5.1 of the specification). */
const WRAP_LINES = 2;
/** The width of the check boxes at the left of the gutter (§5.2.1 of the specification). */
const CHECK_WIDTH = 24;
/** The width of the button at the right of a header that opens the column menu. */
const MENU_WIDTH = 16;
/** How long scrolling must pause before the accessibility rows and the session follow (§6.1 of v2-react.md). */
export const SETTLE_MS = 150;

/** What is under a point of the grid. */
export interface Hit {
  area: "cell" | "header" | "gutter" | "corner" | "none";
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
}

/** The rows on screen once scrolling pauses, for the accessibility rows. */
export interface Settled {
  top: number;
  rows: number;
  /** The first and last display positions on screen. */
  left: number;
  right: number;
  version: number;
}

export interface CanvasElements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  scroller: HTMLElement;
  sizer: HTMLElement;
}

export interface CanvasOptions {
  rowHeight?: number;
  headerHeight?: number;
}

function isNumeric(column: Column) {
  return column.type === "integer" || column.type === "bigint" || column.type === "decimal" || column.type === "float";
}

/** The width a column starts with before its values are measured. */
function defaultWidth(column: Column) {
  switch (column.type) {
    case "boolean":
      return 72;
    case "integer":
    case "bigint":
    case "float":
    case "decimal":
      return 104;
    case "date":
    case "time":
      return 112;
    case "timestamp":
    case "timestamptz":
      return 176;
    default:
      return 160;
  }
}

/**
 * Draws the view on screen of a store onto a canvas and scrolls it, without React (§1 and §6 of v2-react.md):
 * cells, headers, row numbers, the selection and the columns pinned at each side, at most once per frame and only
 * what is on screen. It tells the store which rows it shows, so that the store reads them.
 */
export class GridCanvas {
  readonly scrollX = new ScrollAxis();
  readonly scrollY = new ScrollAxis();
  rowHeight = 24;
  headerHeight = 32;
  width = 0;
  height = 0;
  gutterWidth = 48;
  /** The height of the totals row at the bottom (§5.1 of the specification), 0 without totals. */
  footer = 0;
  /** Whether the gutter has a check box for each row. */
  private checkboxes = false;
  /** The row height of the theme or the props; rows are taller while a column wraps. */
  private baseRowHeight = 24;
  private locale: string | undefined = undefined;
  /** By column name: the text of its values by its format, and its style rules (§5.1). */
  private formatters = new Map<string, (value: JsonValue) => string | null>();
  private rules = new Map<string, { rule: Rule; color?: string; background?: string; description?: string }[]>();
  /** Columns that the style rules read besides those on screen. */
  private ruleColumns: string[] = [];
  private store: GridStore | null = null;
  private elements: CanvasElements | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private theme: GridTheme | null = null;
  private cellText: TextFitter | null = null;
  private headerText: TextFitter | null = null;
  private ratio = 1;
  private frame = 0;
  private snapshot: GridSnapshot | null = null;
  private layout = new ColumnLayout([]);
  private columns: readonly DisplayedColumn[] = [];
  private index = new Map<string, number>();
  private frozenLeft = 0;
  private frozenRight = 0;
  private readonly measured = new Map<string, number>();
  private resizing: { column: number; width: number } | null = null;
  private texts = new Map<string, { value: JsonValue; text: string }>();
  private textsView: unknown = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private settled: Settled = { top: 0, rows: 0, left: 0, right: -1, version: 0 };
  private readonly settledListeners = new Set<() => void>();
  private scrolling = false;
  private lastActive: unknown = null;
  private lastScroll: unknown = null;
  private lastView: unknown = null;
  private durations: number[] = [];
  private readonly frameListeners = new Set<() => void>();

  constructor(private options: CanvasOptions = {}) {}

  /** Shows a check box for each row in the gutter, and one for every row in the corner. */
  setCheckboxes(on: boolean) {
    if (this.checkboxes === on) return;
    this.checkboxes = on;
    this.relayout();
  }

  /** The language that formats show numbers and dates in (§5.1). */
  setLocale(locale: string | undefined) {
    if (this.locale === locale) return;
    this.locale = locale;
    this.relayout();
  }

  /** The row height for displayed columns: room for `WRAP_LINES` lines when one of them wraps. */
  private wrappedHeight(columns: readonly DisplayedColumn[]) {
    const wraps = columns.some((item) => item.setting.format?.wrap === true);
    const lineHeight = this.theme?.lineHeight ?? 16;
    return wraps ? Math.max(this.baseRowHeight, Math.ceil(lineHeight * WRAP_LINES + 8)) : this.baseRowHeight;
  }

  /** Row and header heights given as props, instead of the CSS custom properties. */
  setSizes(rowHeight: number | undefined, headerHeight: number | undefined) {
    if (this.options.rowHeight === rowHeight && this.options.headerHeight === headerHeight) return;
    this.options = { rowHeight, headerHeight };
    this.refreshTheme();
    this.relayout();
  }

  // ----- attaching -----

  /** Draws `store` into the elements and follows both; gives the function that stops it. */
  attach(elements: CanvasElements, store: GridStore): () => void {
    this.elements = elements;
    this.store = store;
    const context = elements.canvas.getContext("2d", { alpha: false });
    this.context = context;
    this.refreshTheme();
    this.snapshot = store.getSnapshot();
    this.lastActive = this.snapshot.session.active;
    this.lastScroll = this.snapshot.session.scroll;
    this.relayout();
    const { scroller } = elements;
    const resize = () => {
      this.width = scroller.clientWidth;
      this.height = scroller.clientHeight;
      this.relayout();
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(scroller);
    const onScroll = () => this.onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const stopState = store.subscribe(() => this.onState());
    const stopRows = store.subscribeRows(() => this.onRows());
    const media = typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: dark)");
    const refresh = () => {
      this.refreshTheme();
      this.relayout();
    };
    media?.addEventListener("change", refresh);
    const themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(refresh);
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    void document.fonts?.ready.then(refresh);
    // The session's place (§5.2) when the grid starts.
    const scroll = this.snapshot.session.scroll;
    if (scroll) this.scrollToRow(scroll.row, "top");
    this.schedule();
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      stopState();
      stopRows();
      media?.removeEventListener("change", refresh);
      themeObserver?.disconnect();
      clearTimeout(this.settleTimer);
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.elements = null;
      this.store = null;
      this.context = null;
    };
  }

  /** Reads the theme again, after the grid's class or style changed. */
  refreshTheme() {
    const elements = this.elements;
    if (!elements || !this.context) return;
    const theme = resolveTheme(elements.root);
    this.theme = theme;
    this.cellText = new TextFitter(this.context, theme.font);
    this.headerText = new TextFitter(this.context, theme.headerFont);
    this.baseRowHeight = this.options.rowHeight ?? cssLength(elements.root, "--vg-row-height", 24);
    this.rowHeight = this.wrappedHeight(this.columns);
    this.headerHeight = this.options.headerHeight ?? cssLength(elements.root, "--vg-header-height", 32);
    this.texts.clear();
    this.schedule();
  }

  // ----- following the store -----

  private onState() {
    const store = this.store;
    if (!store) return;
    const previous = this.snapshot;
    const snapshot = store.getSnapshot();
    this.snapshot = snapshot;
    if (snapshot.displayed !== previous?.displayed || snapshot.view?.rowCount !== previous?.view?.rowCount) {
      this.relayout();
    }
    // Totals that come widen their columns as rows do.
    if (snapshot.totals !== previous?.totals) this.measure();
    if (snapshot.view !== this.lastView) {
      this.lastView = snapshot.view;
      this.texts.clear();
    }
    const session = snapshot.session;
    if (session.scroll !== this.lastScroll) {
      this.lastScroll = session.scroll;
      // A place set by a command or by view.update (§5.4), not the one this canvas reported.
      if (session.scroll && session.scroll.row !== this.topRow()) this.scrollToRow(session.scroll.row, "top");
    }
    if (session.active !== this.lastActive) {
      this.lastActive = session.active;
      if (session.active) {
        const column = this.index.get(session.active.column);
        if (column !== undefined) this.reveal(session.active.row, column);
      }
    }
    this.schedule();
  }

  private onRows() {
    this.measure();
    if (!this.scrolling) this.bumpSettled();
    this.schedule();
  }

  /** The columns and their widths for the displayed columns of the snapshot. */
  relayout() {
    const snapshot = this.snapshot;
    const columns = snapshot?.displayed ?? [];
    this.columns = columns;
    this.index = new Map(columns.map((item, position) => [item.column.name, position]));
    const widths = columns.map((item, position) =>
      this.resizing?.column === position
        ? this.resizing.width
        : (item.setting.width ?? this.measured.get(item.column.name) ?? defaultWidth(item.column)),
    );
    this.layout = new ColumnLayout(widths);
    this.rowHeight = this.wrappedHeight(columns);
    this.formatters = new Map();
    this.rules = new Map();
    const read = new Set<string>();
    const view = snapshot?.view?.columns ?? [];
    for (const item of columns) {
      const format = item.setting.format;
      const formatter = formatterFor(item.column, format, this.locale);
      if (formatter) this.formatters.set(item.column.name, formatter);
      const rules = (format?.styles ?? []).flatMap((style) => {
        // A rule whose `when` the grid does not evaluate over the view is skipped (§5.1).
        const compiled = compileRule(style.when, view);
        if (!compiled) return [];
        for (const name of compiled.columns) read.add(name);
        return [
          { rule: compiled.rule, color: style.color, background: style.background, description: style.description },
        ];
      });
      if (rules.length > 0) this.rules.set(item.column.name, rules);
    }
    this.ruleColumns = [...read];
    this.texts.clear();
    const left = columns.filter((item) => item.setting.pin === "left").length;
    const right = columns.filter((item) => item.setting.pin === "right").length;
    const rowCount = snapshot?.view?.rowCount ?? 0;
    const totals = !snapshot?.document.plan?.aggregate && columns.some((item) => item.setting.total !== undefined);
    this.footer = totals ? this.rowHeight : 0;
    const digits = String(Math.max(1, rowCount)).length;
    this.gutterWidth = Math.max(40, Math.ceil(digits * 8 + PADDING * 2)) + (this.checkboxes ? CHECK_WIDTH : 0);
    const fitted = fitFrozen(this.layout, left, right, this.width - this.gutterWidth);
    this.frozenLeft = fitted.left;
    this.frozenRight = fitted.right;
    const elements = this.elements;
    if (elements) {
      const height = this.scrollY.resize(this.headerHeight + rowCount * this.rowHeight + this.footer, this.height);
      const width = this.scrollX.resize(this.gutterWidth + this.layout.total, this.width);
      elements.sizer.style.width = `${width}px`;
      elements.sizer.style.height = `${height}px`;
    }
    this.updateViewport();
    // Columns that came or went (a derived column, a hidden one) change the columns on screen.
    const [first, last] = this.visibleScrollColumns();
    if (!this.scrolling && (first !== this.settled.left || last !== this.settled.right)) this.bumpSettled();
    this.schedule();
  }

  /** Fits the columns without a width to the values on screen, growing them only. */
  private measure() {
    const store = this.store;
    const fitter = this.cellText;
    const header = this.headerText;
    const context = this.context;
    if (!store || !fitter || !header || !context) return;
    const [first, last] = this.visibleRows();
    let changed = false;
    this.columns.forEach((item) => {
      const name = item.column.name;
      if (item.setting.width !== undefined) return;
      const before = this.measured.get(name);
      if (before !== undefined && before >= MAX_AUTO_WIDTH) return;
      let loaded = false;
      context.font = header.font;
      let widest = Math.max(
        before ?? 0,
        header.width(item.setting.format?.label ?? name) + PADDING * 2 + 18 + MENU_WIDTH,
      );
      context.font = fitter.font;
      for (let row = first; row < Math.min(last, first + 200); row++) {
        const value = store.cell(row, name);
        if (value === undefined) continue;
        loaded = true;
        const text = this.text(row, item.column, value);
        if (text) widest = Math.max(widest, fitter.width(text.length > 120 ? text.slice(0, 120) : text) + PADDING * 2);
      }
      const total = this.totalText(item.column.name);
      if (total) widest = Math.max(widest, fitter.width(total) + PADDING * 2);
      if (!loaded) return;
      // Columns grow to fit the rows that come on screen, and never shrink while the view stays.
      const width = Math.min(MAX_AUTO_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest)));
      if (width === before) return;
      this.measured.set(name, width);
      changed = true;
    });
    if (changed) this.relayout();
  }

  // ----- scrolling -----

  private onScroll() {
    const scroller = this.elements?.scroller;
    if (!scroller) return;
    this.scrollX.onNativeScroll(scroller.scrollLeft);
    this.scrollY.onNativeScroll(scroller.scrollTop);
    this.scrolling = true;
    this.updateViewport();
    this.schedule();
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.scrolling = false;
      this.bumpSettled();
      this.reportScroll();
    }, SETTLE_MS);
  }

  /** The first row on screen. */
  topRow() {
    return Math.max(0, Math.floor(this.scrollY.position / this.rowHeight));
  }

  /** Rows on screen `[first, last)`. */
  visibleRows(): [number, number] {
    const rowCount = this.snapshot?.view?.rowCount ?? 0;
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
    return this.columns.length - this.frozenRight;
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

  private updateViewport() {
    const store = this.store;
    if (!store) return;
    const [first, last] = this.visibleRows();
    const [left, right] = this.visibleScrollColumns();
    const names: string[] = [];
    for (let column = 0; column < this.frozenLeft; column++) names.push(this.columns[column].column.name);
    for (let column = left; column <= right; column++) names.push(this.columns[column].column.name);
    for (let column = this.rightStart; column < this.columns.length; column++) {
      names.push(this.columns[column].column.name);
    }
    for (const name of this.ruleColumns) if (!names.includes(name)) names.push(name);
    store.setViewport({ top: first, rows: Math.max(1, last - first), columns: names });
  }

  /** Scrolls so that a row is at the top, or just visible. */
  scrollToRow(row: number, place: "top" | "nearest") {
    const scroller = this.elements?.scroller;
    if (!scroller) return;
    const body = Math.max(this.rowHeight, this.bottom - this.headerHeight);
    const y = row * this.rowHeight;
    let target = this.scrollY.position;
    if (place === "top") target = y;
    else if (y < target) target = y;
    else if (y + this.rowHeight > target + body) target = y + this.rowHeight - body;
    if (target === this.scrollY.position) return;
    scroller.scrollTop = this.scrollY.scrollTo(target);
    this.updateViewport();
    this.schedule();
  }

  /** Scrolls so that a cell is on screen. */
  reveal(row: number, column: number) {
    this.scrollToRow(row, "nearest");
    const scroller = this.elements?.scroller;
    if (!scroller || column < this.frozenLeft || column >= this.rightStart) return;
    const left = this.layout.left(column);
    const right = this.layout.right(column);
    const start = this.frozenWidth + this.scrollX.position;
    const room = this.width - this.gutterWidth - this.frozenRightWidth;
    let target = this.scrollX.position;
    if (left < start) target = left - this.frozenWidth;
    else if (right > this.scrollX.position + room) target = right - room;
    if (target !== this.scrollX.position) {
      scroller.scrollLeft = this.scrollX.scrollTo(target);
      this.updateViewport();
      this.schedule();
    }
  }

  /** Puts the place on screen in the session (§5.2) once scrolling pauses. */
  private reportScroll() {
    const store = this.store;
    const snapshot = this.snapshot;
    if (!store || !snapshot?.view || this.columns.length === 0) return;
    const row = this.topRow();
    const [left] = this.visibleScrollColumns();
    const column = this.columns[Math.max(left, 0)]?.column.name;
    const current = snapshot.session.scroll;
    if (current?.row === row && current.column === column) return;
    void store.dispatch(column === undefined ? { command: "scroll.to", row } : { command: "scroll.to", row, column });
  }

  // ----- the accessibility rows -----

  getSettled = (): Settled => this.settled;

  subscribeSettled = (listener: () => void): (() => void) => {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  };

  private bumpSettled() {
    const [top, last] = this.visibleRows();
    const [left, right] = this.visibleScrollColumns();
    this.settled = { top, rows: last - top, left, right, version: this.settled.version + 1 };
    for (const listener of this.settledListeners) listener();
  }

  /** The text of a cell as the grid shows it: the value's text form (§2.4). */
  text(row: number, column: Column, value: JsonValue): string {
    if (value === null) return "";
    if (this.textsView !== this.snapshot?.view) {
      this.textsView = this.snapshot?.view;
      this.texts.clear();
    }
    const key = `${row}\u0000${column.name}`;
    // Kept with its value: a cell shows another value while a write of it is being answered.
    const kept = this.texts.get(key);
    if (kept !== undefined && kept.value === value) return kept.text;
    const text = this.formatters.get(column.name)?.(value) ?? textOf(value, column) ?? "";
    if (this.texts.size > 50_000) this.texts.clear();
    this.texts.set(key, { value, text });
    return text;
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

  /** Follows the frames the canvas draws, for what is placed over it (the cell editor). */
  subscribeFrames = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  /** The rows of the view on screen. */
  get rowCount() {
    return this.snapshot?.view?.rowCount ?? 0;
  }

  // ----- hit testing -----

  /** What is at a point given in the scroller's client coordinates. */
  hit(x: number, y: number): Hit {
    const rowCount = this.snapshot?.view?.rowCount ?? 0;
    const none: Hit = { area: "none", row: 0, column: 0, edge: false, menu: false };
    if (x < 0 || y < 0 || x > this.width || y > this.height || y >= this.bottom) return none;
    const row = Math.max(
      0,
      Math.min(rowCount - 1, Math.floor((y - this.headerHeight + this.scrollY.position) / this.rowHeight)),
    );
    if (x < this.gutterWidth) {
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
    if (y < this.headerHeight) {
      return { area: "header", row: 0, column, edge, menu: !edge && x >= right - MENU_WIDTH - 4 };
    }
    if (rowCount === 0 || y - this.headerHeight + this.scrollY.position >= rowCount * this.rowHeight) return none;
    return { area: "cell", row, column, edge: false, menu: false };
  }

  /** The display position of the column at an x of the canvas; -1 when there is none. */
  columnAt(x: number) {
    if (this.columns.length === 0) return -1;
    const rightX = this.width - this.frozenRightWidth;
    if (this.frozenRight > 0 && x >= rightX) {
      return Math.max(this.rightStart, this.layout.indexAt(this.layout.left(this.rightStart) + x - rightX));
    }
    const local = x - this.gutterWidth;
    if (this.frozenLeft > 0 && local < this.frozenWidth) return this.layout.indexAt(local);
    const column = this.layout.indexAt(local + this.scrollX.position);
    return Math.min(column, this.rightStart - 1);
  }

  /** The width of a displayed column. */
  columnWidth(column: number) {
    return this.layout.width(column);
  }

  /** Shows a column at a width while it is dragged, before the command that sets it. */
  previewWidth(column: number, width: number | null) {
    this.resizing = width === null ? null : { column, width: Math.max(MIN_WIDTH, Math.round(width)) };
    this.relayout();
  }

  // ----- drawing -----

  schedule() {
    if (this.frame || !this.elements) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Draws now, as layout effects do before the browser paints. */
  draw() {
    if (!this.context || !this.theme || !this.elements) return;
    const started = now();
    this.paint(this.context, this.theme);
    const duration = now() - started;
    this.durations.push(duration);
    if (this.durations.length > 240) this.durations.shift();
    track("frame", started, "canvas", "secondary");
    for (const listener of this.frameListeners) listener();
  }

  /** Durations of the recent frames in milliseconds, for the bench. */
  frameTimes(): readonly number[] {
    return this.durations;
  }

  private resizeCanvas(context: CanvasRenderingContext2D) {
    const canvas = context.canvas;
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const pixelWidth = Math.max(1, Math.round(this.width * ratio));
    const pixelHeight = Math.max(1, Math.round(this.height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || this.ratio !== ratio) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
      this.ratio = ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** A position for a line one device pixel wide. */
  private snap(value: number) {
    return (Math.round(value * this.ratio) + 0.5) / this.ratio;
  }

  private paint(ctx: CanvasRenderingContext2D, theme: GridTheme) {
    this.resizeCanvas(ctx);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    const snapshot = this.snapshot;
    const store = this.store;
    if (!snapshot?.view || !store || this.columns.length === 0) return;
    const [first, last] = this.visibleRows();
    const [left, right] = this.visibleScrollColumns();
    const top = this.headerHeight;
    const scrollLeft = this.gutterWidth + this.frozenWidth;
    const scrollRight = this.width - this.frozenRightWidth;
    const regions: [number, number, number, number][] = [
      [scrollLeft, scrollRight, left, right],
      [this.gutterWidth, scrollLeft, 0, this.frozenLeft - 1],
      [scrollRight, this.width, this.rightStart, this.columns.length - 1],
    ];
    for (const [x0, x1, from, to] of regions) {
      if (x1 <= x0 || to < from) continue;
      this.clipped(ctx, x0, top, x1 - x0, this.bottom - top, () => {
        for (let column = from; column <= to; column++) this.drawCells(ctx, theme, store, column, first, last);
        this.drawLines(ctx, theme, from, to, first, last);
        this.drawSelection(ctx, theme, snapshot, from, to);
      });
    }
    this.drawHeaders(ctx, theme, snapshot, left, right);
    this.drawGutter(ctx, theme, snapshot, first, last);
    if (this.footer > 0) this.drawTotals(ctx, theme, snapshot, left, right);
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, 0, this.gutterWidth, top);
    if (this.checkboxes) {
      const all = allState(snapshot.session.checked, snapshot.document.plan, snapshot.view.rowCount);
      this.drawCheck(ctx, theme, top / 2, all === "all" ? "checked" : all === "none" ? "unchecked" : "unknown");
    }
    ctx.strokeStyle = theme.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const headerLine = this.snap(top) - 0.5 / this.ratio;
    ctx.moveTo(0, headerLine);
    ctx.lineTo(this.width, headerLine);
    const gutterLine = this.snap(this.gutterWidth) - 0.5 / this.ratio;
    ctx.moveTo(gutterLine, 0);
    ctx.lineTo(gutterLine, this.height);
    for (const edge of [this.frozenLeft > 0 ? scrollLeft : -1, this.frozenRight > 0 ? scrollRight : -1]) {
      if (edge < 0) continue;
      const x = this.snap(edge) - 0.5 / this.ratio;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    ctx.stroke();
    if (snapshot.pending) {
      // The view on screen stays until the new one's first rows arrive (§4.2 of v2-react.md).
      ctx.fillStyle = theme.background;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(this.gutterWidth, top, this.width - this.gutterWidth, this.bottom - top);
      ctx.globalAlpha = 1;
    }
    if (this.resizing) {
      const x = this.columnX(this.resizing.column) + this.layout.width(this.resizing.column);
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x - 1, 0, 2, this.height);
    }
  }

  private clipped(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    draw: () => void,
  ) {
    if (width <= 0 || height <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    draw();
    ctx.restore();
  }

  private drawCells(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    store: GridStore,
    column: number,
    first: number,
    last: number,
  ) {
    const item = this.columns[column];
    const fitter = this.cellText;
    if (!item || !fitter) return;
    const x = this.columnX(column);
    const width = this.layout.width(column);
    const numeric = isNumeric(item.column);
    const align =
      item.setting.format?.align ?? (numeric ? "right" : item.column.type === "boolean" ? "center" : "left");
    const wrap = item.setting.format?.wrap === true;
    ctx.font = fitter.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = align;
    const textX = align === "right" ? x + width - PADDING : align === "center" ? x + width / 2 : x + PADDING;
    for (let row = first; row < last; row++) {
      const y = this.rowY(row);
      const value = store.cell(row, item.column.name);
      if (value === undefined) {
        ctx.fillStyle = theme.placeholder;
        ctx.fillRect(x + PADDING, y + this.rowHeight / 2 - 4, Math.max(0, Math.min(width - PADDING * 2, 64)), 8);
        continue;
      }
      const style = this.styleOf(row, item.column.name);
      if (style?.background) {
        ctx.fillStyle = style.background;
        ctx.fillRect(x, y, width, this.rowHeight);
      }
      if (value === null) continue;
      let text = this.text(row, item.column, value);
      if (store.isCut(row, item.column.name)) text = `${text}…`;
      ctx.fillStyle = style?.color ?? theme.text;
      if (wrap) {
        const lineHeight = theme.lineHeight;
        const lines = fitter.lines(
          text,
          width - PADDING * 2,
          Math.max(1, Math.floor((this.rowHeight - 4) / lineHeight)),
        );
        const top = y + (this.rowHeight - lines.length * lineHeight) / 2 + lineHeight / 2;
        lines.forEach((line, index) => {
          ctx.fillText(line, textX, top + index * lineHeight);
        });
        continue;
      }
      const fitted = fitter.fit(text, width - PADDING * 2);
      if (fitted) ctx.fillText(fitted, textX, y + this.rowHeight / 2);
    }
    ctx.textAlign = "left";
  }

  private drawLines(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    from: number,
    to: number,
    first: number,
    last: number,
  ) {
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let column = from; column <= to; column++) {
      const x = this.snap(this.columnX(column) + this.layout.width(column)) - 0.5 / this.ratio;
      ctx.moveTo(x, this.headerHeight);
      ctx.lineTo(x, Math.min(this.height, this.rowY(last)));
    }
    for (let row = first; row <= last; row++) {
      const y = this.snap(this.rowY(row)) - 0.5 / this.ratio;
      if (y < this.headerHeight) continue;
      ctx.moveTo(this.gutterWidth, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
  }

  /** The selected ranges (§5.2) and the active cell, within the display positions `[from, to]`. */
  private drawSelection(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    snapshot: GridSnapshot,
    from: number,
    to: number,
  ) {
    const session = snapshot.session;
    const rowCount = snapshot.view?.rowCount ?? 0;
    if (rowCount === 0) return;
    const ranges = session.selection ?? [];
    const rect = (rows: [number, number], columns: number[]) => {
      const visible = columns.filter((column) => column >= from && column <= to);
      if (visible.length === 0) return null;
      const x0 = Math.min(...visible.map((column) => this.columnX(column)));
      const x1 = Math.max(...visible.map((column) => this.columnX(column) + this.layout.width(column)));
      const y0 = this.rowY(rows[0]);
      const y1 = this.rowY(rows[1]);
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };
    ranges.forEach((range, position) => {
      const rows: [number, number] =
        range.rows === "all" ? [0, rowCount] : [range.rows[0], Math.min(range.rows[1], rowCount)];
      const columns =
        range.columns === "all"
          ? this.columns.map((_, index) => index)
          : range.columns.flatMap((name) => this.index.get(name) ?? []);
      const area = rect(rows, columns);
      if (!area) return;
      const single = rows[1] - rows[0] === 1 && columns.length === 1 && ranges.length === 1;
      if (!single) {
        ctx.fillStyle = theme.selection;
        ctx.fillRect(area.x, area.y, area.width, area.height);
      }
      if (position === ranges.length - 1 && !single) {
        ctx.strokeStyle = theme.selectionBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(this.snap(area.x), this.snap(area.y), area.width - 1, area.height - 1);
      }
    });
    const active = session.active ?? (this.columns.length > 0 ? { row: 0, column: this.columns[0].column.name } : null);
    if (!active) return;
    const column = this.index.get(active.column);
    if (column === undefined || column < from || column > to || active.row >= rowCount) return;
    const x = this.columnX(column);
    const y = this.rowY(active.row);
    ctx.strokeStyle = theme.activeBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, this.layout.width(column) - 2, this.rowHeight - 2);
  }

  private drawHeaders(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    snapshot: GridSnapshot,
    left: number,
    right: number,
  ) {
    const fitter = this.headerText;
    if (!fitter) return;
    const sort = snapshot.document.plan?.sort ?? [];
    // Columns with conditions of their own (§6.2.1) show a funnel instead of the menu's arrow.
    const filtered = new Set<string>();
    for (const part of partsOf(snapshot.document.plan?.where)) {
      if ("search" in part) continue;
      const names = columnsOf(part);
      if (names.size === 1) for (const name of names) filtered.add(name);
    }
    const draw = (column: number) => {
      const item = this.columns[column];
      const x = this.columnX(column);
      const width = this.layout.width(column);
      ctx.fillStyle = theme.headerBackground;
      ctx.fillRect(x, 0, width, this.headerHeight);
      const at = sort.findIndex((key) => key.column === item.column.name);
      const mark = at < 0 ? "" : `${sort[at].direction === "asc" ? "▲" : "▼"}${sort.length > 1 ? at + 1 : ""}`;
      ctx.font = fitter.font;
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.headerText;
      ctx.textAlign = "left";
      const space = width - PADDING * 2 - MENU_WIDTH - (mark ? 18 : 0);
      ctx.fillText(
        fitter.fit(item.setting.format?.label ?? item.column.name, space),
        x + PADDING,
        this.headerHeight / 2,
      );
      if (mark) {
        ctx.fillStyle = theme.accent;
        ctx.textAlign = "right";
        ctx.fillText(mark, x + width - PADDING - MENU_WIDTH, this.headerHeight / 2);
        ctx.textAlign = "left";
      }
      const middle = this.headerHeight / 2;
      const center = x + width - PADDING / 2 - MENU_WIDTH / 2;
      ctx.beginPath();
      if (filtered.has(item.column.name)) {
        ctx.fillStyle = theme.accent;
        ctx.moveTo(center - 5, middle - 4);
        ctx.lineTo(center + 5, middle - 4);
        ctx.lineTo(center + 1, middle + 1);
        ctx.lineTo(center + 1, middle + 5);
        ctx.lineTo(center - 1, middle + 5);
        ctx.lineTo(center - 1, middle + 1);
      } else {
        ctx.fillStyle = theme.muted;
        ctx.moveTo(center - 4, middle - 2);
        ctx.lineTo(center + 4, middle - 2);
        ctx.lineTo(center, middle + 3);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const edge = this.snap(x + width) - 0.5 / this.ratio;
      ctx.moveTo(edge, 6);
      ctx.lineTo(edge, this.headerHeight - 6);
      ctx.stroke();
    };
    const scrollLeft = this.gutterWidth + this.frozenWidth;
    const scrollRight = this.width - this.frozenRightWidth;
    this.clipped(ctx, scrollLeft, 0, scrollRight - scrollLeft, this.headerHeight, () => {
      for (let column = left; column <= right; column++) draw(column);
    });
    this.clipped(ctx, this.gutterWidth, 0, this.frozenWidth, this.headerHeight, () => {
      for (let column = 0; column < this.frozenLeft; column++) draw(column);
    });
    this.clipped(ctx, scrollRight, 0, this.frozenRightWidth, this.headerHeight, () => {
      for (let column = this.rightStart; column < this.columns.length; column++) draw(column);
    });
  }

  private drawGutter(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    snapshot: GridSnapshot,
    first: number,
    last: number,
  ) {
    const fitter = this.cellText;
    if (!fitter) return;
    const active = snapshot.session.active?.row ?? 0;
    this.clipped(ctx, 0, this.headerHeight, this.gutterWidth, this.bottom - this.headerHeight, () => {
      ctx.fillStyle = theme.gutterBackground;
      ctx.fillRect(0, this.headerHeight, this.gutterWidth, this.bottom - this.headerHeight);
      ctx.font = fitter.font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (let row = first; row < last; row++) {
        const y = this.rowY(row);
        if (row === active) {
          ctx.fillStyle = theme.headerActive;
          ctx.fillRect(0, y, this.gutterWidth, this.rowHeight);
        }
        ctx.fillStyle = row === active ? theme.headerText : theme.gutterText;
        ctx.fillText(String(row + 1), this.gutterWidth - PADDING, y + this.rowHeight / 2);
        const key = this.checkboxes ? this.store?.rowKey(row) : undefined;
        if (key) {
          this.drawCheck(
            ctx,
            theme,
            y + this.rowHeight / 2,
            checkState(snapshot.session.checked, snapshot.document.plan, key),
          );
          ctx.textAlign = "right";
        }
      }
      ctx.textAlign = "left";
    });
  }

  /** The style rule that colors a cell: the first whose `when` is true for its row (§5.1); undefined for none. */
  styleOf(row: number, name: string): { color?: string; background?: string; description?: string } | undefined {
    const rules = this.rules.get(name);
    const store = this.store;
    if (!rules || !store) return undefined;
    const read = (column: string) => store.cell(row, column);
    return rules.find((item) => item.rule(read) === true);
  }

  /** A check box in the gutter, centered at `middle`: checked, not checked, or unknown (a dash). */
  private drawCheck(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    middle: number,
    state: "checked" | "unchecked" | "unknown",
  ) {
    const size = 12;
    const x = Math.round((CHECK_WIDTH - size) / 2) + 2;
    const y = Math.round(middle - size / 2);
    ctx.lineWidth = 1;
    if (state === "unchecked") {
      ctx.strokeStyle = theme.gutterText;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      return;
    }
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = theme.accentText;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    if (state === "checked") {
      ctx.moveTo(x + 2.5, y + 6);
      ctx.lineTo(x + 5, y + 8.5);
      ctx.lineTo(x + 9.5, y + 3.5);
    } else {
      ctx.moveTo(x + 3, y + 6);
      ctx.lineTo(x + 9, y + 6);
    }
    ctx.stroke();
  }

  /** The text of a column's total; undefined while it is read. */
  private totalText(name: string): string | undefined {
    const totals = this.snapshot?.totals;
    const value = totals?.values[name];
    const type = totals?.columns[name];
    if (value === undefined || !type) return undefined;
    return textOf(value, type) ?? "";
  }

  /**
   * The totals row, at the bottom: each displayed column's total (§5.1), in the column's format and alignment, a
   * placeholder while it is read, and Σ in the gutter.
   */
  private drawTotals(
    ctx: CanvasRenderingContext2D,
    theme: GridTheme,
    snapshot: GridSnapshot,
    left: number,
    right: number,
  ) {
    const fitter = this.cellText;
    if (!fitter) return;
    const top = this.bottom;
    const middle = top + this.footer / 2;
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, top, this.width, this.footer);
    ctx.font = fitter.font;
    ctx.textBaseline = "middle";
    const totals = snapshot.totals;
    const draw = (column: number) => {
      const item = this.columns[column];
      if (!item?.setting.total) return;
      const x = this.columnX(column);
      const width = this.layout.width(column);
      const text = this.totalText(item.column.name);
      if (text === undefined) {
        ctx.fillStyle = theme.placeholder;
        ctx.fillRect(x + PADDING, middle - 4, Math.max(0, Math.min(width - PADDING * 2, 64)), 8);
        return;
      }
      const type = totals?.columns[item.column.name] ?? item.column;
      const fitted = fitter.fit(text, width - PADDING * 2);
      ctx.fillStyle = theme.headerText;
      const align = item.setting.format?.align ?? (isNumeric(type) ? "right" : "left");
      ctx.textAlign = align;
      ctx.fillText(
        fitted,
        align === "right" ? x + width - PADDING : align === "center" ? x + width / 2 : x + PADDING,
        middle,
      );
    };
    const scrollLeft = this.gutterWidth + this.frozenWidth;
    const scrollRight = this.width - this.frozenRightWidth;
    this.clipped(ctx, scrollLeft, top, scrollRight - scrollLeft, this.footer, () => {
      for (let column = left; column <= right; column++) draw(column);
    });
    this.clipped(ctx, this.gutterWidth, top, this.frozenWidth, this.footer, () => {
      for (let column = 0; column < this.frozenLeft; column++) draw(column);
    });
    this.clipped(ctx, scrollRight, top, this.frozenRightWidth, this.footer, () => {
      for (let column = this.rightStart; column < this.columns.length; column++) draw(column);
    });
    ctx.fillStyle = theme.gutterText;
    ctx.textAlign = "right";
    ctx.fillText("Σ", this.gutterWidth - PADDING, middle);
    ctx.textAlign = "left";
    ctx.strokeStyle = theme.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const line = this.snap(top) - 0.5 / this.ratio;
    ctx.moveTo(0, line);
    ctx.lineTo(this.width, line);
    ctx.stroke();
  }
}
