import { type Column, columnsOf, type DisplayedColumn, type JsonValue, partsOf, textOf } from "vastgrid-spec";
import { allState, checkState } from "../core/checked.js";
import { compileRule, type Rule } from "../core/evaluate.js";
import { formatterFor } from "../core/format.js";
import type { GridStore } from "../core/store.js";
import { now, track } from "../core/trace.js";
import type { GridSnapshot } from "../core/types.js";
import { CHECK_WIDTH, Geometry, MENU_WIDTH } from "./geometry.js";
import type { CellAction, CellHooks, CellStyle, ColumnGroup, GridCell } from "./hooks.js";
import { ColumnLayout, fitFrozen } from "./layout.js";
import { TextFitter } from "./text.js";
import { cssLength, type GridTheme, resolveTheme } from "./theme.js";

const PADDING = 8;
const MIN_WIDTH = 40;
const MAX_AUTO_WIDTH = 360;
/** Lines of a row while a displayed column wraps its text (§5.1 of the specification). */
const DEFAULT_WRAP_LINES = 2;
/** How long scrolling must pause before the accessibility rows and the session follow (§6.1 of react.md). */
export const SETTLE_MS = 150;

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
  groupHeaderHeight?: number;
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

/** The rows of groups that a list of groups needs: the depth of its nesting. */
function depthOf(groups: readonly (string | ColumnGroup)[]): number {
  let depth = 0;
  for (const item of groups) if (typeof item !== "string") depth = Math.max(depth, 1 + depthOf(item.children));
  return depth;
}

/**
 * The group of each displayed column in each of `rows` rows of groups, the innermost group in the row just above the
 * names. A column named in several groups takes the first.
 */
function groupPaths(
  groups: readonly ColumnGroup[],
  columns: readonly DisplayedColumn[],
  rows: number,
): ({ id: number; name: string } | null)[][] {
  const paths = new Map<string, { id: number; name: string }[]>();
  let id = 0;
  const walk = (items: readonly (string | ColumnGroup)[], path: { id: number; name: string }[]) => {
    for (const item of items) {
      if (typeof item === "string") {
        if (!paths.has(item)) paths.set(item, path);
      } else {
        walk(item.children, [...path, { id: id++, name: item.name }]);
      }
    }
  };
  walk(groups, []);
  return columns.map((item) => {
    const path = paths.get(item.column.name) ?? [];
    return Array.from({ length: rows }, (_, level) => path[level - (rows - path.length)] ?? null);
  });
}

/**
 * Draws the view on screen of a store onto a canvas and scrolls it, without React (§1 and §6 of react.md):
 * cells, headers, row numbers, the selection and the columns pinned at each side, at most once per frame and only
 * what is on screen. It tells the store which rows it shows, so that the store reads them.
 */
export class GridCanvas {
  readonly geometry = new Geometry();
  /** Where dragged columns would go, while a header is dragged. */
  private dropX: number | null = null;
  private wrapLines = DEFAULT_WRAP_LINES;
  private hooks: CellHooks = {};
  private groups: readonly ColumnGroup[] = [];
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
  private columns: readonly DisplayedColumn[] = [];
  private index = new Map<string, number>();
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

  /** Shows where dragged columns would go, a line at `x`, or nothing. */
  previewDrop(x: number | null) {
    if (this.dropX === x) return;
    this.dropX = x;
    this.schedule();
  }

  /** Shows a column at a width while it is dragged, before the command that sets it. */
  previewWidth(column: number, width: number | null) {
    this.resizing = width === null ? null : { column, width: Math.max(MIN_WIDTH, Math.round(width)) };
    this.relayout();
  }

  /** Text, colors, drawing and actions of cells from the host (§5.1: they win over the document). */
  setHooks(hooks: CellHooks) {
    this.hooks = hooks;
    this.texts.clear();
    this.schedule();
  }

  /** Groups of columns in header rows above the names, each `groupHeight` pixels high (or the CSS's). */
  setColumnGroups(groups: readonly ColumnGroup[] | undefined, groupHeight: number | undefined) {
    this.groups = groups ?? [];
    this.options = { ...this.options, groupHeaderHeight: groupHeight };
    this.refreshTheme();
    this.relayout();
  }

  /** How many lines rows have while a displayed column wraps its text. */
  setWrapLines(lines: number | undefined) {
    const next = Math.max(1, Math.floor(lines ?? DEFAULT_WRAP_LINES));
    if (next === this.wrapLines) return;
    this.wrapLines = next;
    this.relayout();
  }

  /** Shows a check box for each row in the gutter, and one for every row in the corner. */
  setCheckboxes(on: boolean) {
    if (this.geometry.checkboxes === on) return;
    this.geometry.checkboxes = on;
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
    return wraps ? Math.max(this.baseRowHeight, Math.ceil(lineHeight * this.wrapLines + 8)) : this.baseRowHeight;
  }

  /** Row and header heights given as props, instead of the CSS custom properties. */
  setSizes(rowHeight: number | undefined, headerHeight: number | undefined) {
    if (this.options.rowHeight === rowHeight && this.options.headerHeight === headerHeight) return;
    this.options = { ...this.options, rowHeight, headerHeight };
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
      this.geometry.width = scroller.clientWidth;
      this.geometry.height = scroller.clientHeight;
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
    // Pages mark their theme on the root element, and hosts on the body too: VS Code's webviews by a class
    // (`vscode-dark`), JupyterLab by `data-jp-theme-light`.
    const marks = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-jp-theme-light"] };
    themeObserver?.observe(document.documentElement, marks);
    if (document.body) themeObserver?.observe(document.body, marks);
    // And the grid's own class and style, as `className` and `style` of DataGrid set them.
    const grid = elements.root.closest(".vg-root") ?? elements.root;
    themeObserver?.observe(grid, { attributes: true, attributeFilter: ["class", "style"] });
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
    this.geometry.rowHeight = this.wrappedHeight(this.columns);
    this.geometry.nameHeight = this.options.headerHeight ?? cssLength(elements.root, "--vg-header-height", 32);
    this.geometry.groupHeight =
      this.options.groupHeaderHeight ?? cssLength(elements.root, "--vg-group-header-height", 24);
    this.geometry.groupRows = depthOf(this.groups);
    this.geometry.headerHeight = this.geometry.groupTop + this.geometry.nameHeight;
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
      if (session.scroll && session.scroll.row !== this.geometry.topRow()) this.scrollToRow(session.scroll.row, "top");
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
    this.geometry.layout = new ColumnLayout(widths);
    this.geometry.rowHeight = this.wrappedHeight(columns);
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
    this.geometry.groupPaths = groupPaths(this.groups, columns, this.geometry.groupRows);
    this.texts.clear();
    const left = columns.filter((item) => item.setting.pin === "left").length;
    const right = columns.filter((item) => item.setting.pin === "right").length;
    const rowCount = snapshot?.view?.rowCount ?? 0;
    this.geometry.rowCount = rowCount;
    const totals = !snapshot?.document.plan?.aggregate && columns.some((item) => item.setting.total !== undefined);
    this.geometry.footer = totals ? this.geometry.rowHeight : 0;
    const digits = String(Math.max(1, rowCount)).length;
    this.geometry.gutterWidth =
      Math.max(40, Math.ceil(digits * 8 + PADDING * 2)) + (this.geometry.checkboxes ? CHECK_WIDTH : 0);
    const fitted = fitFrozen(this.geometry.layout, left, right, this.geometry.width - this.geometry.gutterWidth);
    this.geometry.frozenLeft = fitted.left;
    this.geometry.frozenRight = fitted.right;
    const elements = this.elements;
    if (elements) {
      const height = this.geometry.scrollY.resize(
        this.geometry.headerHeight + rowCount * this.geometry.rowHeight + this.geometry.footer,
        this.geometry.height,
      );
      const width = this.geometry.scrollX.resize(
        this.geometry.gutterWidth + this.geometry.layout.total,
        this.geometry.width,
      );
      elements.sizer.style.width = `${width}px`;
      elements.sizer.style.height = `${height}px`;
    }
    this.updateViewport();
    // Columns that came or went (a derived column, a hidden one) change the columns on screen.
    const [first, last] = this.geometry.visibleScrollColumns();
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
    const [first, last] = this.geometry.visibleRows();
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
    this.geometry.scrollX.onNativeScroll(scroller.scrollLeft);
    this.geometry.scrollY.onNativeScroll(scroller.scrollTop);
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

  private updateViewport() {
    const store = this.store;
    if (!store) return;
    const [first, last] = this.geometry.visibleRows();
    const [left, right] = this.geometry.visibleScrollColumns();
    const names: string[] = [];
    for (let column = 0; column < this.geometry.frozenLeft; column++) names.push(this.columns[column].column.name);
    for (let column = left; column <= right; column++) names.push(this.columns[column].column.name);
    for (let column = this.geometry.rightStart; column < this.columns.length; column++) {
      names.push(this.columns[column].column.name);
    }
    for (const name of this.ruleColumns) if (!names.includes(name)) names.push(name);
    store.setViewport({ top: first, rows: Math.max(1, last - first), columns: names });
  }

  /** Scrolls so that a row is at the top, or just visible. */
  scrollToRow(row: number, place: "top" | "nearest") {
    const scroller = this.elements?.scroller;
    if (!scroller) return;
    const body = Math.max(this.geometry.rowHeight, this.geometry.bottom - this.geometry.headerHeight);
    const y = row * this.geometry.rowHeight;
    let target = this.geometry.scrollY.position;
    if (place === "top") target = y;
    else if (y < target) target = y;
    else if (y + this.geometry.rowHeight > target + body) target = y + this.geometry.rowHeight - body;
    if (target === this.geometry.scrollY.position) return;
    scroller.scrollTop = this.geometry.scrollY.scrollTo(target);
    this.updateViewport();
    this.schedule();
  }

  /** Scrolls so that a cell is on screen. */
  reveal(row: number, column: number) {
    this.scrollToRow(row, "nearest");
    const scroller = this.elements?.scroller;
    if (!scroller || column < this.geometry.frozenLeft || column >= this.geometry.rightStart) return;
    const left = this.geometry.layout.left(column);
    const right = this.geometry.layout.right(column);
    const start = this.geometry.frozenWidth + this.geometry.scrollX.position;
    const room = this.geometry.width - this.geometry.gutterWidth - this.geometry.frozenRightWidth;
    let target = this.geometry.scrollX.position;
    if (left < start) target = left - this.geometry.frozenWidth;
    else if (right > this.geometry.scrollX.position + room) target = right - room;
    if (target !== this.geometry.scrollX.position) {
      scroller.scrollLeft = this.geometry.scrollX.scrollTo(target);
      this.updateViewport();
      this.schedule();
    }
  }

  /** Puts the place on screen in the session (§5.2) once scrolling pauses. */
  private reportScroll() {
    const store = this.store;
    const snapshot = this.snapshot;
    if (!store || !snapshot?.view || this.columns.length === 0) return;
    const row = this.geometry.topRow();
    const [left] = this.geometry.visibleScrollColumns();
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
    const [top, last] = this.geometry.visibleRows();
    const [left, right] = this.geometry.visibleScrollColumns();
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
    const shown = this.formatters.get(column.name)?.(value) ?? textOf(value, column) ?? "";
    const text = this.hooks.cellText?.({ row, column, value, text: shown }) ?? shown;
    if (this.texts.size > 50_000) this.texts.clear();
    this.texts.set(key, { value, text });
    return text;
  }

  /** Follows the frames the canvas draws, for what is placed over it (the cell editor). */
  subscribeFrames = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

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
    const pixelWidth = Math.max(1, Math.round(this.geometry.width * ratio));
    const pixelHeight = Math.max(1, Math.round(this.geometry.height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || this.ratio !== ratio) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${this.geometry.width}px`;
      canvas.style.height = `${this.geometry.height}px`;
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
    ctx.fillRect(0, 0, this.geometry.width, this.geometry.height);
    const snapshot = this.snapshot;
    const store = this.store;
    if (!snapshot?.view || !store || this.columns.length === 0) return;
    const [first, last] = this.geometry.visibleRows();
    const [left, right] = this.geometry.visibleScrollColumns();
    const top = this.geometry.headerHeight;
    const scrollLeft = this.geometry.gutterWidth + this.geometry.frozenWidth;
    const scrollRight = this.geometry.width - this.geometry.frozenRightWidth;
    const regions: [number, number, number, number][] = [
      [scrollLeft, scrollRight, left, right],
      [this.geometry.gutterWidth, scrollLeft, 0, this.geometry.frozenLeft - 1],
      [scrollRight, this.geometry.width, this.geometry.rightStart, this.columns.length - 1],
    ];
    for (const [x0, x1, from, to] of regions) {
      if (x1 <= x0 || to < from) continue;
      this.clipped(ctx, x0, top, x1 - x0, this.geometry.bottom - top, () => {
        for (let column = from; column <= to; column++) this.drawCells(ctx, theme, store, column, first, last);
        this.drawLines(ctx, theme, from, to, first, last);
        this.drawSelection(ctx, theme, snapshot, from, to);
      });
    }
    this.drawHeaders(ctx, theme, snapshot, left, right);
    this.drawGutter(ctx, theme, snapshot, first, last);
    if (this.geometry.footer > 0) this.drawTotals(ctx, theme, snapshot, left, right);
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, 0, this.geometry.gutterWidth, top);
    if (this.geometry.checkboxes) {
      const all = allState(snapshot.session.checked, snapshot.document.plan, snapshot.view.rowCount);
      this.drawCheck(
        ctx,
        theme,
        this.geometry.groupTop + this.geometry.nameHeight / 2,
        all === "all" ? "checked" : all === "none" ? "unchecked" : "unknown",
      );
    }
    ctx.strokeStyle = theme.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const headerLine = this.snap(top) - 0.5 / this.ratio;
    ctx.moveTo(0, headerLine);
    ctx.lineTo(this.geometry.width, headerLine);
    const gutterLine = this.snap(this.geometry.gutterWidth) - 0.5 / this.ratio;
    ctx.moveTo(gutterLine, 0);
    ctx.lineTo(gutterLine, this.geometry.height);
    for (const edge of [
      this.geometry.frozenLeft > 0 ? scrollLeft : -1,
      this.geometry.frozenRight > 0 ? scrollRight : -1,
    ]) {
      if (edge < 0) continue;
      const x = this.snap(edge) - 0.5 / this.ratio;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.geometry.height);
    }
    ctx.stroke();
    if (snapshot.pending) {
      // The view on screen stays until the new one's first rows arrive (§4.2 of react.md).
      ctx.fillStyle = theme.background;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(
        this.geometry.gutterWidth,
        top,
        this.geometry.width - this.geometry.gutterWidth,
        this.geometry.bottom - top,
      );
      ctx.globalAlpha = 1;
    }
    if (this.resizing) {
      const x = this.geometry.columnX(this.resizing.column) + this.geometry.layout.width(this.resizing.column);
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x - 1, 0, 2, this.geometry.height);
    }
    if (this.dropX !== null) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(this.dropX - 1.5, 0, 3, this.geometry.height);
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
    const x = this.geometry.columnX(column);
    const width = this.geometry.layout.width(column);
    const numeric = isNumeric(item.column);
    const align =
      item.setting.format?.align ?? (numeric ? "right" : item.column.type === "boolean" ? "center" : "left");
    const wrap = item.setting.format?.wrap === true;
    ctx.font = fitter.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = align;
    const textX = align === "right" ? x + width - PADDING : align === "center" ? x + width / 2 : x + PADDING;
    for (let row = first; row < last; row++) {
      const y = this.geometry.rowY(row);
      const value = store.cell(row, item.column.name);
      if (value === undefined) {
        ctx.fillStyle = theme.placeholder;
        ctx.fillRect(
          x + PADDING,
          y + this.geometry.rowHeight / 2 - 4,
          Math.max(0, Math.min(width - PADDING * 2, 64)),
          8,
        );
        continue;
      }
      const style = this.cellStyleOf(row, item.column, value);
      const text = value === null ? "" : this.text(row, item.column, value);
      const action = value === null ? null : this.actionOf(row, item.column, value, text);
      const drawDefault = () => {
        if (style?.background) {
          ctx.fillStyle = style.background;
          ctx.fillRect(x, y, width, this.geometry.rowHeight);
        }
        if (value === null) return;
        const shown = store.isCut(row, item.column.name) ? `${text}…` : text;
        ctx.fillStyle = style?.color ?? (action?.kind === "link" ? theme.link : theme.text);
        const lines = wrap
          ? fitter.lines(
              shown,
              width - PADDING * 2,
              Math.max(1, Math.floor((this.geometry.rowHeight - 4) / theme.lineHeight)),
            )
          : [fitter.fit(shown, width - PADDING * 2)];
        const lineHeight = wrap ? theme.lineHeight : this.geometry.rowHeight;
        const top = y + (this.geometry.rowHeight - lines.length * lineHeight) / 2 + lineHeight / 2;
        lines.forEach((line, index) => {
          if (!line) return;
          const middle = top + index * lineHeight;
          ctx.fillText(line, textX, middle);
          // Links are underlined.
          if (action?.kind !== "link") return;
          const lineWidth = fitter.width(line);
          const start = align === "right" ? textX - lineWidth : align === "center" ? textX - lineWidth / 2 : textX;
          ctx.fillRect(start, middle + theme.fontSize / 2, lineWidth, 1);
        });
      };
      const draw = this.hooks.drawCell;
      if (!draw || value === null) {
        drawDefault();
        continue;
      }
      ctx.save();
      draw({
        row,
        column: item.column,
        value,
        text,
        ctx,
        rect: { x, y, width, height: this.geometry.rowHeight },
        style: style ?? null,
        theme,
        drawDefault,
      });
      ctx.restore();
      ctx.font = fitter.font;
      ctx.textBaseline = "middle";
      ctx.textAlign = align;
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
      const x = this.snap(this.geometry.columnX(column) + this.geometry.layout.width(column)) - 0.5 / this.ratio;
      ctx.moveTo(x, this.geometry.headerHeight);
      ctx.lineTo(x, Math.min(this.geometry.height, this.geometry.rowY(last)));
    }
    for (let row = first; row <= last; row++) {
      const y = this.snap(this.geometry.rowY(row)) - 0.5 / this.ratio;
      if (y < this.geometry.headerHeight) continue;
      ctx.moveTo(this.geometry.gutterWidth, y);
      ctx.lineTo(this.geometry.width, y);
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
      const x0 = Math.min(...visible.map((column) => this.geometry.columnX(column)));
      const x1 = Math.max(
        ...visible.map((column) => this.geometry.columnX(column) + this.geometry.layout.width(column)),
      );
      const y0 = this.geometry.rowY(rows[0]);
      const y1 = this.geometry.rowY(rows[1]);
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
    const x = this.geometry.columnX(column);
    const y = this.geometry.rowY(active.row);
    ctx.strokeStyle = theme.activeBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, this.geometry.layout.width(column) - 2, this.geometry.rowHeight - 2);
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
      const x = this.geometry.columnX(column);
      const width = this.geometry.layout.width(column);
      ctx.fillStyle = theme.headerBackground;
      ctx.fillRect(x, 0, width, this.geometry.headerHeight);
      const nameMiddle = this.geometry.groupTop + this.geometry.nameHeight / 2;
      const at = sort.findIndex((key) => key.column === item.column.name);
      const mark = at < 0 ? "" : `${sort[at].direction === "asc" ? "▲" : "▼"}${sort.length > 1 ? at + 1 : ""}`;
      ctx.font = fitter.font;
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.headerText;
      ctx.textAlign = "left";
      const space = width - PADDING * 2 - MENU_WIDTH - (mark ? 18 : 0);
      ctx.fillText(fitter.fit(item.setting.format?.label ?? item.column.name, space), x + PADDING, nameMiddle);
      if (mark) {
        ctx.fillStyle = theme.accent;
        ctx.textAlign = "right";
        ctx.fillText(mark, x + width - PADDING - MENU_WIDTH, nameMiddle);
        ctx.textAlign = "left";
      }
      const middle = nameMiddle;
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
      ctx.moveTo(edge, this.geometry.groupTop + 6);
      ctx.lineTo(edge, this.geometry.headerHeight - 6);
      ctx.stroke();
    };
    const groups = (from: number, to: number) => {
      if (this.geometry.groupRows > 0 && to >= from) this.drawGroups(ctx, theme, from, to);
    };
    const scrollLeft = this.geometry.gutterWidth + this.geometry.frozenWidth;
    const scrollRight = this.geometry.width - this.geometry.frozenRightWidth;
    this.clipped(ctx, scrollLeft, 0, scrollRight - scrollLeft, this.geometry.headerHeight, () => {
      for (let column = left; column <= right; column++) draw(column);
      groups(left, right);
    });
    this.clipped(ctx, this.geometry.gutterWidth, 0, this.geometry.frozenWidth, this.geometry.headerHeight, () => {
      for (let column = 0; column < this.geometry.frozenLeft; column++) draw(column);
      groups(0, this.geometry.frozenLeft - 1);
    });
    this.clipped(ctx, scrollRight, 0, this.geometry.frozenRightWidth, this.geometry.headerHeight, () => {
      for (let column = this.geometry.rightStart; column < this.columns.length; column++) draw(column);
      groups(this.geometry.rightStart, this.columns.length - 1);
    });
  }

  /** The columns of a group header: the run of display positions next to `column` in the same group. */
  groupSpan(column: number, level: number): [number, number] | null {
    const id = this.geometry.groupPaths[column]?.[level]?.id;
    if (id === undefined) return null;
    const region = (at: number) => (at < this.geometry.frozenLeft ? 0 : at >= this.geometry.rightStart ? 2 : 1);
    let first = column;
    let last = column;
    while (first > 0 && this.geometry.groupPaths[first - 1]?.[level]?.id === id && region(first - 1) === region(column))
      first--;
    while (
      last < this.columns.length - 1 &&
      this.geometry.groupPaths[last + 1]?.[level]?.id === id &&
      region(last + 1) === region(column)
    ) {
      last++;
    }
    return [first, last];
  }

  /** The names of a column's groups, from the outermost, for screen readers. */
  groupNames(column: number): string[] {
    return (this.geometry.groupPaths[column] ?? []).flatMap((group) => (group ? [group.name] : []));
  }

  /**
   * The rows of groups over display positions `[from, to]` of one region: each group over the run of its columns
   * that are next to each other there, so a group whose columns were moved apart, hidden or pinned is split, and
   * each part shows its name.
   */
  private drawGroups(ctx: CanvasRenderingContext2D, theme: GridTheme, from: number, to: number) {
    const fitter = this.headerText;
    if (!fitter) return;
    ctx.font = fitter.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.lineWidth = 1;
    for (let level = 0; level < this.geometry.groupRows; level++) {
      const top = level * this.geometry.groupHeight;
      let column = from;
      while (column <= to) {
        const group = this.geometry.groupPaths[column]?.[level];
        let last = column;
        while (last < to && group && this.geometry.groupPaths[last + 1]?.[level]?.id === group.id) last++;
        if (group) {
          const x = this.geometry.columnX(column);
          const width = this.geometry.columnX(last) + this.geometry.layout.width(last) - x;
          ctx.fillStyle = theme.headerText;
          ctx.fillText(fitter.fit(group.name, width - PADDING * 2), x + PADDING, top + this.geometry.groupHeight / 2);
          ctx.strokeStyle = theme.line;
          ctx.beginPath();
          const bottom = this.snap(top + this.geometry.groupHeight) - 0.5 / this.ratio;
          ctx.moveTo(x + 4, bottom);
          ctx.lineTo(x + width - 4, bottom);
          const edge = this.snap(x + width) - 0.5 / this.ratio;
          ctx.moveTo(edge, top + 4);
          ctx.lineTo(edge, top + this.geometry.groupHeight);
          ctx.stroke();
        }
        column = last + 1;
      }
    }
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
    this.clipped(
      ctx,
      0,
      this.geometry.headerHeight,
      this.geometry.gutterWidth,
      this.geometry.bottom - this.geometry.headerHeight,
      () => {
        ctx.fillStyle = theme.gutterBackground;
        ctx.fillRect(
          0,
          this.geometry.headerHeight,
          this.geometry.gutterWidth,
          this.geometry.bottom - this.geometry.headerHeight,
        );
        ctx.font = fitter.font;
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";
        for (let row = first; row < last; row++) {
          const y = this.geometry.rowY(row);
          if (row === active) {
            ctx.fillStyle = theme.headerActive;
            ctx.fillRect(0, y, this.geometry.gutterWidth, this.geometry.rowHeight);
          }
          ctx.fillStyle = row === active ? theme.headerText : theme.gutterText;
          ctx.fillText(String(row + 1), this.geometry.gutterWidth - PADDING, y + this.geometry.rowHeight / 2);
          const key = this.geometry.checkboxes ? this.store?.rowKey(row) : undefined;
          if (key) {
            this.drawCheck(
              ctx,
              theme,
              y + this.geometry.rowHeight / 2,
              checkState(snapshot.session.checked, snapshot.document.plan, key),
            );
            ctx.textAlign = "right";
          }
        }
        ctx.textAlign = "left";
      },
    );
  }

  /** The colors of a cell: the host's `cellStyle`, or else the column's style rules. */
  private cellStyleOf(row: number, column: Column, value: JsonValue): CellStyle | undefined {
    const hook = this.hooks.cellStyle;
    if (hook) {
      const style = hook({ row, column, value, text: value === null ? "" : this.text(row, column, value) });
      if (style) return style;
    }
    return this.styleOf(row, column.name);
  }

  /** What a cell does, by the host's `cellAction`. */
  private actionOf(row: number, column: Column, value: JsonValue, text: string): CellAction | null {
    return this.hooks.cellAction?.({ row, column, value, text }) ?? null;
  }

  /** The action of a cell at a display position, while its value is read; null for plain cells. */
  actionAt(row: number, columnIndex: number): { action: CellAction; cell: GridCell } | null {
    const column = this.columns[columnIndex]?.column;
    const store = this.store;
    if (!column || !store || !this.hooks.cellAction) return null;
    const value = store.cell(row, column.name);
    if (value === undefined || value === null) return null;
    const text = this.text(row, column, value);
    const action = this.actionOf(row, column, value, text);
    return action ? { action, cell: { row, column, value, text } } : null;
  }

  /** The style rule that colors a cell: the first whose `when` is true for its row (§5.1); undefined for none. */
  styleOf(row: number, name: string): CellStyle | undefined {
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
    const top = this.geometry.bottom;
    const middle = top + this.geometry.footer / 2;
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, top, this.geometry.width, this.geometry.footer);
    ctx.font = fitter.font;
    ctx.textBaseline = "middle";
    const totals = snapshot.totals;
    const draw = (column: number) => {
      const item = this.columns[column];
      if (!item?.setting.total) return;
      const x = this.geometry.columnX(column);
      const width = this.geometry.layout.width(column);
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
    const scrollLeft = this.geometry.gutterWidth + this.geometry.frozenWidth;
    const scrollRight = this.geometry.width - this.geometry.frozenRightWidth;
    this.clipped(ctx, scrollLeft, top, scrollRight - scrollLeft, this.geometry.footer, () => {
      for (let column = left; column <= right; column++) draw(column);
    });
    this.clipped(ctx, this.geometry.gutterWidth, top, this.geometry.frozenWidth, this.geometry.footer, () => {
      for (let column = 0; column < this.geometry.frozenLeft; column++) draw(column);
    });
    this.clipped(ctx, scrollRight, top, this.geometry.frozenRightWidth, this.geometry.footer, () => {
      for (let column = this.geometry.rightStart; column < this.columns.length; column++) draw(column);
    });
    ctx.fillStyle = theme.gutterText;
    ctx.textAlign = "right";
    ctx.fillText("Σ", this.geometry.gutterWidth - PADDING, middle);
    ctx.textAlign = "left";
    ctx.strokeStyle = theme.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const line = this.snap(top) - 0.5 / this.ratio;
    ctx.moveTo(0, line);
    ctx.lineTo(this.geometry.width, line);
    ctx.stroke();
  }
}
