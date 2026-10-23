import {
  type CellValue,
  ColumnLayout,
  type ColumnSchema,
  type ColumnStats,
  type DistinctValues,
  type Filter,
  isAbortError,
  isNumericType,
  plainText,
  RowCache,
  ScrollAxis,
  SelectionModel,
  type SelectionSummary,
  type SortDirection,
  type TableInfo,
  type TableSource,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  ValueFormatter,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid-core";

export interface GridOptions {
  rowHeight: number;
  headerHeight: number;
  locale?: string;
  nullText: string;
  frozenColumns: number;
  minColumnWidth: number;
  maxAutoWidth: number;
  /** Cells copied at most at once. */
  copyLimit: number;
}

export interface ColumnState {
  /** Index in the table schema. */
  index: number;
  width: number;
  hidden: boolean;
  /** Width set by the user or fitted to the content, not to be changed automatically. */
  sized: boolean;
}

export type HitZone = "corner" | "header" | "gutter" | "cell" | "outside";

export interface Hit {
  zone: HitZone;
  /** Row in the view, or -1. */
  row: number;
  /** Visible column, or -1. */
  col: number;
  /** Visible column whose right edge is under the pointer (for resizing), or -1. */
  resize: number;
  /** The pointer is over the header's menu button. */
  menu: boolean;
}

export class CopyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Select at most ${limit} cells to copy.`);
  }
}

const defaultWidths: Partial<Record<ColumnSchema["type"], number>> = {
  integer: 96,
  bigint: 120,
  float: 110,
  decimal: 110,
  boolean: 72,
  date: 104,
  time: 96,
  timestamp: 176,
  timestamptz: 196,
  uuid: 290,
};

/** Header space around the name: padding, the type mark and the menu button. */
const HEADER_CHROME = 62;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The stable `code` of a source's error (see `SourceError`), if it has one. */
function codeOf(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Whether a loaded value may be text that the source cut for display (it then ends with "…"). */
function mayBeCut(value: CellValue) {
  return typeof value === "string" && value.endsWith("…");
}

function hasQuery(query: ViewQuery) {
  return Boolean(query.sort?.length || query.filters?.length || query.search?.trim());
}

/** Filters on one column (the grid edits one filter per column). */
export function filterColumn(filter: Filter) {
  return filter.column;
}

/**
 * State and behavior of one grid: the table and its view, columns, selection, scrolling and the row
 * cache. It is independent of React; the component forwards DOM events here and draws with
 * `CanvasRenderer`. Frequent changes (scrolling, hover) only request a frame; changes that the React
 * UI shows bump `version` and notify subscribers.
 */
export class GridController {
  readonly source: TableSource;
  readonly options: GridOptions;
  readonly cache: RowCache;
  readonly selection = new SelectionModel();
  readonly scrollX = new ScrollAxis();
  readonly scrollY = new ScrollAxis();
  formatter: ValueFormatter;
  /** Changes whenever `formatter` is replaced, so that cached display text is rebuilt. */
  formatVersion = 0;

  info: TableInfo | null = null;
  loadError: string | null = null;
  query: ViewQuery = {};
  view: ViewInfo = { id: null, rowCount: 0, query: {} };
  viewPending = false;
  viewError: string | null = null;
  columns: ColumnState[] = [];
  visible: ColumnState[] = [];
  layout = new ColumnLayout([]);
  frozen = 0;
  frozenWidth = 0;
  gutterWidth = 48;
  width = 0;
  height = 0;
  hover: Hit | null = null;
  /** The visible column being resized, for drawing the guide. */
  resizing = -1;
  findText = "";
  findCaseSensitive = false;
  summary: SelectionSummary | null = null;
  summaryPending = false;
  /** Increments on every change shown by the React UI. */
  version = 0;
  /** Measures text in the cell or header font; set by the renderer. */
  measure: ((text: string, header: boolean) => number) | null = null;

  private scroller: HTMLElement | null = null;
  private sizer: HTMLElement | null = null;
  private readonly stateListeners = new Set<() => void>();
  private readonly renderListeners = new Set<() => void>();
  private lifecycle = new AbortController();
  private viewAbort: AbortController | null = null;
  private summaryAbort: AbortController | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | undefined;
  private autoSized = false;
  private disposed = false;
  private polling = false;
  private activeValue: CellValue | undefined;

  constructor(source: TableSource, options: GridOptions) {
    this.source = source;
    this.options = options;
    this.formatter = new ValueFormatter({ locale: options.locale, nullText: options.nullText });
    this.cache = new RowCache(source);
    this.cache.onChange(() => {
      this.autoSize();
      this.requestRender();
      const active = this.selection.active;
      const value = this.value(active.row, active.col);
      if (value !== this.activeValue) {
        this.activeValue = value;
        this.emit();
      }
    });
  }

  /** Changes the locale and the text for blanks. */
  setFormat(locale: string | undefined, nullText: string) {
    this.options.locale = locale;
    this.options.nullText = nullText;
    this.formatter = new ValueFormatter({ locale, nullText });
    this.formatVersion++;
    this.requestRender();
  }

  // ----- subscriptions -----

  subscribe = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  onRender(listener: () => void) {
    this.renderListeners.add(listener);
    return () => {
      this.renderListeners.delete(listener);
    };
  }

  emit() {
    this.version++;
    for (const listener of this.stateListeners) listener();
  }

  requestRender() {
    for (const listener of this.renderListeners) listener();
  }

  // ----- lifecycle -----

  attach(scroller: HTMLElement, sizer: HTMLElement) {
    this.scroller = scroller;
    this.sizer = sizer;
    this.syncSizer();
  }

  /** Starts reading the table. Safe to call again after `stop()`. */
  start() {
    if (this.polling && !this.lifecycle.signal.aborted) return;
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController();
    this.polling = true;
    const signal = this.lifecycle.signal;
    void this.poll(signal).finally(() => {
      if (this.lifecycle.signal === signal) this.polling = false;
    });
  }

  /** Reads the table again (for example after the file changed). */
  reload() {
    this.lifecycle.abort();
    this.polling = false;
    this.loadError = null;
    this.start();
  }

  /** Stops loading and cancels requests. `start()` resumes. */
  stop() {
    this.lifecycle.abort();
    this.polling = false;
    this.viewAbort?.abort();
    this.summaryAbort?.abort();
    clearTimeout(this.summaryTimer);
    if (this.viewPending) {
      this.viewPending = false;
      this.emit();
    }
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.cache.clear();
    this.stateListeners.clear();
    this.renderListeners.clear();
  }

  private async poll(signal: AbortSignal) {
    let delay = 100;
    while (!signal.aborted) {
      let info: TableInfo;
      try {
        info = await this.source.info(signal);
      } catch (error) {
        if (signal.aborted) return;
        if (isAbortError(error)) {
          // Someone else's request was cancelled; ask again.
          await sleep(delay, signal);
          continue;
        }
        this.loadError = messageOf(error);
        this.emit();
        this.requestRender();
        return;
      }
      if (signal.aborted) return;
      this.applyInfo(info);
      if (info.status !== "loading") return;
      await sleep(delay, signal);
      delay = Math.min(500, delay * 1.4);
    }
  }

  private applyInfo(info: TableInfo) {
    const previous = this.info;
    this.info = info;
    this.loadError = null;
    const names = (table: TableInfo | null) => table?.columns.map((column) => column.name).join("\u0000");
    const types = (table: TableInfo | null) => table?.columns.map((column) => column.type).join("\u0000");
    const reset = !previous || previous.revision !== info.revision || names(previous) !== names(info);
    if (reset) {
      // Settings follow their columns by name, also when the file's columns moved.
      const old = new Map(this.columns.map((column) => [previous?.columns[column.index]?.name ?? "", column]));
      this.columns = info.columns.map((column, index) => {
        const kept =
          previous && names(previous) === names(info)
            ? this.columns.find((item) => item.index === index)
            : old.get(column.name);
        return {
          index,
          width: kept?.width ?? defaultWidths[column.type] ?? 150,
          hidden: kept?.hidden ?? false,
          sized: kept?.sized ?? false,
        };
      });
      if (!previous) this.frozen = Math.min(this.options.frozenColumns, this.columns.length);
      this.autoSized = this.columns.every((column) => column.sized);
      this.viewAbort?.abort();
      this.view = { id: null, rowCount: info.rowCount ?? info.readableRows, query: {} };
      this.viewPending = false;
      this.cache.clear();
      this.selection.select({ row: 0, col: 0 });
      // The summary of the previous selection no longer applies.
      this.scheduleSummary();
    } else if (previous.status !== info.status && types(previous) !== types(info)) {
      // The final types differ from the preview's (for example all columns read as text).
      this.cache.clear();
    }
    if (this.view.id === null) {
      this.view = { id: null, rowCount: info.rowCount ?? info.readableRows, query: {} };
    }
    this.updateLayout();
    if (info.status === "ready" && (reset || previous?.status !== "ready") && hasQuery(this.query)) {
      void this.setQuery(this.query);
    }
    this.emit();
    this.requestRender();
  }

  // ----- derived values -----

  get status() {
    return this.loadError ? "error" : (this.info?.status ?? "loading");
  }

  get schema(): ColumnSchema[] {
    return this.info?.columns ?? [];
  }

  /** Rows in the current view. */
  get rowCount() {
    return this.view.id !== null ? this.view.rowCount : (this.info?.rowCount ?? this.info?.readableRows ?? 0);
  }

  /** Rows that can be read now (less than `rowCount` while a table loads). */
  get readableRows() {
    return this.view.id !== null ? this.view.rowCount : (this.info?.readableRows ?? 0);
  }

  get totalRows() {
    return this.info?.rowCount ?? null;
  }

  columnSchema(col: number): ColumnSchema | undefined {
    const state = this.visible[col];
    return state ? this.schema[state.index] : undefined;
  }

  get bodyHeight() {
    return Math.max(0, this.height - this.options.headerHeight);
  }

  /** Row labels: the position in the original table for views, otherwise the row number. */
  rowLabel(row: number) {
    if (this.view.id === null) return row + 1;
    const id = this.cache.rowId(row);
    return id === undefined ? null : id + 1;
  }

  updateLayout() {
    this.visible = this.columns.filter((column) => !column.hidden);
    this.frozen = Math.min(this.frozen, this.visible.length);
    this.layout = new ColumnLayout(this.visible.map((column) => column.width));
    this.frozenWidth = this.layout.left(this.frozen);
    const largest = Math.max(this.info?.rowCount ?? 0, this.rowCount, 1);
    const digits = String(largest).length;
    this.gutterWidth = Math.max(
      44,
      Math.ceil(this.measure ? this.measure("0".repeat(digits), false) : digits * 8) + 22,
    );
    this.selection.setBounds(this.rowCount, this.visible.length);
    this.cache.setView(this.view.id, this.rowCount, this.readableRows, this.schema.length);
    this.syncSizer();
  }

  /** Sizes the native scroll content and applies the current positions. */
  syncSizer() {
    const nativeWidth = this.scrollX.resize(this.gutterWidth + this.layout.total, this.width);
    const nativeHeight = this.scrollY.resize(
      this.options.headerHeight + this.rowCount * this.options.rowHeight,
      this.height,
    );
    if (this.sizer) {
      this.sizer.style.width = `${Math.ceil(nativeWidth)}px`;
      this.sizer.style.height = `${Math.ceil(nativeHeight)}px`;
    }
    if (this.scroller) {
      const left = this.scrollX.scrollTo(this.scrollX.position);
      const top = this.scrollY.scrollTo(this.scrollY.position);
      if (Math.abs(this.scroller.scrollLeft - left) > 1) this.scroller.scrollLeft = left;
      if (Math.abs(this.scroller.scrollTop - top) > 1) this.scroller.scrollTop = top;
    }
  }

  setViewport(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.syncSizer();
    this.requestRender();
  }

  handleScroll() {
    if (!this.scroller) return;
    this.scrollX.onNativeScroll(this.scroller.scrollLeft);
    this.scrollY.onNativeScroll(this.scroller.scrollTop);
    this.requestRender();
  }

  /** Visible rows `[first, last)`. */
  visibleRows(): [number, number] {
    const rowHeight = this.options.rowHeight;
    const first = Math.max(0, Math.floor(this.scrollY.position / rowHeight));
    const last = Math.min(this.rowCount, Math.ceil((this.scrollY.position + this.bodyHeight) / rowHeight));
    return [first, Math.max(first, last)];
  }

  /** Visible scrollable columns `[first, last]` (inclusive), or `[0, -1]`. */
  visibleScrollColumns(): [number, number] {
    const count = this.visible.length;
    if (count <= this.frozen) return [0, -1];
    const start = this.frozenWidth + this.scrollX.position;
    const end = this.scrollX.position + this.width - this.gutterWidth;
    if (start >= this.layout.total) return [0, -1];
    const first = Math.max(this.frozen, this.layout.indexAt(start));
    const last = Math.min(count - 1, this.layout.indexAt(Math.max(start, end - 0.001)));
    return [first, last];
  }

  /** Screen x of a visible column's left edge. */
  columnX(col: number) {
    return col < this.frozen
      ? this.gutterWidth + this.layout.left(col)
      : this.gutterWidth + this.layout.left(col) - this.scrollX.position;
  }

  rowY(row: number) {
    return this.options.headerHeight + row * this.options.rowHeight - this.scrollY.position;
  }

  /** The visible column at screen x, or -1. */
  columnAt(x: number) {
    if (x < this.gutterWidth || this.visible.length === 0) return -1;
    const frozenRight = this.gutterWidth + this.frozenWidth;
    if (x < frozenRight) return this.layout.indexAt(x - this.gutterWidth);
    const position = x - this.gutterWidth + this.scrollX.position;
    if (position >= this.layout.total) return -1;
    return Math.max(this.frozen, this.layout.indexAt(position));
  }

  rowAt(y: number) {
    if (y < this.options.headerHeight) return -1;
    const row = Math.floor((y - this.options.headerHeight + this.scrollY.position) / this.options.rowHeight);
    return row >= 0 && row < this.rowCount ? row : -1;
  }

  hitTest(x: number, y: number): Hit {
    const header = y < this.options.headerHeight;
    const gutter = x < this.gutterWidth;
    const col = gutter ? -1 : this.columnAt(x);
    const row = header ? -1 : this.rowAt(y);
    let zone: HitZone = "outside";
    if (header && gutter) zone = "corner";
    else if (header && col >= 0) zone = "header";
    else if (gutter && row >= 0) zone = "gutter";
    else if (row >= 0 && col >= 0) zone = "cell";
    let resize = -1;
    let menu = false;
    if (header && !gutter) {
      const nearest = col >= 0 ? col : this.visible.length - 1;
      const right = this.columnX(nearest) + this.layout.width(nearest);
      const left = this.columnX(nearest);
      if (Math.abs(x - right) <= 5) resize = nearest;
      else if (nearest > 0 && Math.abs(x - left) <= 5 && (nearest !== this.frozen || this.scrollX.position === 0))
        resize = nearest - 1;
      menu = col >= 0 && resize < 0 && x >= right - 24 && x < right - 4;
    }
    return { zone, row, col, resize, menu };
  }

  // ----- scrolling -----

  scrollToVirtual(left: number | null, top: number | null) {
    if (!this.scroller) return;
    if (top !== null) this.scroller.scrollTop = this.scrollY.scrollTo(top);
    if (left !== null) this.scroller.scrollLeft = this.scrollX.scrollTo(left);
    this.requestRender();
  }

  /** Scrolls the least amount that shows the cell. */
  ensureVisible(row: number, col: number) {
    const rowHeight = this.options.rowHeight;
    let top: number | null = null;
    if (row >= 0) {
      const y = row * rowHeight;
      if (y < this.scrollY.position) top = y;
      else if (y + rowHeight > this.scrollY.position + this.bodyHeight) top = y + rowHeight - this.bodyHeight;
    }
    let left: number | null = null;
    if (col >= this.frozen && col < this.visible.length) {
      const start = this.layout.left(col) - this.frozenWidth;
      const end = this.layout.right(col) - this.frozenWidth;
      const view = this.width - this.gutterWidth - this.frozenWidth;
      if (start < this.scrollX.position) left = start;
      else if (end > this.scrollX.position + view) left = Math.min(start, end - view);
    }
    if (top !== null || left !== null) this.scrollToVirtual(left, top);
  }

  // ----- selection -----

  /** Rows a page key moves. */
  get pageRows() {
    return Math.max(1, Math.floor(this.bodyHeight / this.options.rowHeight) - 1);
  }

  selectionChanged(scrollTo?: { row: number; col: number }) {
    if (scrollTo) this.ensureVisible(scrollTo.row, scrollTo.col);
    this.scheduleSummary();
    this.requestRender();
    this.emit();
  }

  private scheduleSummary() {
    clearTimeout(this.summaryTimer);
    this.summaryAbort?.abort();
    const ranges = this.selectionRanges();
    const cells = ranges.reduce((total, range) => total + (range.end - range.start) * range.columns.length, 0);
    if (cells <= 1 || !this.source.aggregate || this.info?.status !== "ready") {
      this.summary = null;
      this.summaryPending = false;
      return;
    }
    this.summaryPending = true;
    this.summaryTimer = setTimeout(() => {
      const controller = new AbortController();
      this.summaryAbort = controller;
      this.source
        .aggregate?.({ view: this.view.id, ranges }, controller.signal)
        .then((summary) => {
          if (controller.signal.aborted) return;
          this.summary = summary;
          this.summaryPending = false;
          this.emit();
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          this.summary = null;
          this.summaryPending = false;
          this.emit();
        });
    }, 180);
  }

  /** The selection as row ranges of schema columns. */
  selectionRanges() {
    return this.selection.ranges.map((range) => ({
      start: range.top,
      end: range.bottom + 1,
      columns: this.visible.slice(range.left, range.right + 1).map((column) => column.index),
    }));
  }

  // ----- reading -----

  value(row: number, col: number): CellValue | undefined {
    const state = this.visible[col];
    return state ? this.cache.value(row, state.index) : undefined;
  }

  /** Reads a cell with a large text limit, for showing its full value. */
  async fullValue(row: number, col: number, signal?: AbortSignal): Promise<CellValue> {
    const state = this.visible[col];
    if (!state) return null;
    const block = await this.source.readRows(
      { view: this.view.id, start: row, end: row + 1, columns: [state.index], textLimit: 1_000_000 },
      signal,
    );
    return block.columns[0]?.[0] ?? null;
  }

  /** Builds clipboard text from values per column. */
  private clipboardText(
    columns: ColumnState[],
    values: CellValue[][],
    rows: number,
    options: { headers?: boolean; markdown?: boolean },
  ) {
    const header = columns.map((column) => this.schema[column.index]?.name ?? "");
    const body: string[][] = [];
    for (let row = 0; row < rows; row++) body.push(values.map((column) => plainText(column[row] ?? null)));
    if (options.markdown) return { text: toMarkdownTable(header, body), html: null, cells: rows * columns.length };
    const table = options.headers ? [header, ...body] : body;
    return { text: toTsv(table), html: toHtmlTable(table, options.headers ? 1 : 0), cells: rows * columns.length };
  }

  /**
   * The current range's values from the cache, or null when some are not loaded, may have been cut
   * for display, or the range is large.
   */
  private cachedRange() {
    const range = this.selection.current;
    if (!range) return null;
    const columns = this.visible.slice(range.left, range.right + 1);
    const rows = range.bottom - range.top + 1;
    if (rows * columns.length > 50_000) return null;
    const values: CellValue[][] = [];
    for (const column of columns) {
      const list: CellValue[] = [];
      for (let row = range.top; row <= range.bottom; row++) {
        const value = this.cache.value(row, column.index);
        if (value === undefined || mayBeCut(value)) return null;
        list.push(value);
      }
      values.push(list);
    }
    return { columns, values, rows };
  }

  /** Clipboard text for the current range when every cell is loaded; otherwise null (use `copySelection`). */
  copySelectionSync(options: { headers?: boolean; markdown?: boolean }) {
    const cached = this.cachedRange();
    return cached ? this.clipboardText(cached.columns, cached.values, cached.rows, options) : null;
  }

  /** Copies the current range as TSV and HTML (or Markdown), reading cells that are not loaded. */
  async copySelection(
    options: { headers?: boolean; markdown?: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string; html: string | null; cells: number }> {
    const range = this.selection.current;
    if (!range) return { text: "", html: null, cells: 0 };
    const columns = this.visible.slice(range.left, range.right + 1);
    const rows = range.bottom - range.top + 1;
    if (rows * columns.length > this.options.copyLimit) throw new CopyTooLargeError(this.options.copyLimit);
    const cached = this.cachedRange();
    if (cached) return this.clipboardText(cached.columns, cached.values, cached.rows, options);
    const values = await this.cache.read(
      range.top,
      range.bottom + 1,
      columns.map((column) => column.index),
      signal,
    );
    return this.clipboardText(columns, values, rows, options);
  }

  // ----- views -----

  async setQuery(query: ViewQuery) {
    this.query = query;
    this.viewAbort?.abort();
    if (this.info?.status !== "ready") {
      this.emit();
      return;
    }
    const controller = new AbortController();
    this.viewAbort = controller;
    this.viewPending = true;
    this.viewError = null;
    this.emit();
    this.requestRender();
    try {
      const view = await this.createView(query, controller.signal);
      if (controller.signal.aborted || this.disposed) return;
      this.view = view;
      this.viewPending = false;
      this.cache.clear();
      this.updateLayout();
      this.selection.select({ row: 0, col: Math.min(this.selection.active.col, Math.max(0, this.visible.length - 1)) });
      this.scrollToVirtual(null, 0);
      this.scheduleSummary();
    } catch (error) {
      // Only this grid's own cancellation (a newer query replaced this one) is silent.
      if (controller.signal.aborted) return;
      this.viewPending = false;
      this.viewError = messageOf(error);
      // The server is loading the table again (it closed it, for example because the file changed):
      // follow that load, which applies the query once the table is ready.
      if (codeOf(error) === "not_ready") this.reload();
    }
    this.emit();
    this.requestRender();
  }

  /**
   * Creates a view, asking once more when the source cancelled it without being asked to: a server
   * cancels the build when it closes the table (for example because the file changed), and the next
   * request opens the table again.
   */
  private async createView(query: ViewQuery, signal: AbortSignal) {
    try {
      return await this.source.createView(query, signal);
    } catch (error) {
      if (signal.aborted || codeOf(error) !== "cancelled") throw error;
      return this.source.createView(query, signal);
    }
  }

  sortBy(col: number, direction: SortDirection, add = false) {
    const state = this.visible[col];
    if (!state) return;
    const others = add ? (this.query.sort ?? []).filter((key) => key.column !== state.index) : [];
    void this.setQuery({ ...this.query, sort: [...others, { column: state.index, direction }] });
  }

  clearSort() {
    void this.setQuery({ ...this.query, sort: [] });
  }

  /** Replaces the filter of a schema column (`null` removes it). */
  setFilter(column: number, filter: Filter | null) {
    const filters = (this.query.filters ?? []).filter((item) => item.column !== column);
    if (filter) filters.push(filter);
    return this.setQuery({ ...this.query, filters });
  }

  /** Keeps the rows whose value in the cell's column is the cell's value (or all others, with `exclude`). */
  async filterByValue(row: number, col: number, exclude = false) {
    const state = this.visible[col];
    let value = this.value(row, col);
    if (!state || value === undefined) return;
    // A value cut for display would match nothing: filter by the whole text.
    if (mayBeCut(value)) value = await this.fullValue(row, col);
    await this.setFilter(state.index, { type: "values", column: state.index, values: [value], exclude });
  }

  filterOf(column: number) {
    return this.query.filters?.find((filter) => filter.column === column) ?? null;
  }

  clearFilters() {
    void this.setQuery({ ...this.query, filters: [], search: "" });
  }

  setSearch(search: string) {
    void this.setQuery({ ...this.query, search });
  }

  sortOf(column: number): { direction: SortDirection; order: number } | null {
    const sort = this.query.sort ?? [];
    const index = sort.findIndex((key) => key.column === column);
    return index < 0 ? null : { direction: sort[index].direction, order: index + 1 };
  }

  // ----- columns -----

  private changeColumns() {
    this.updateLayout();
    this.selectionChanged();
  }

  resizeColumn(col: number, width: number) {
    const state = this.visible[col];
    if (!state) return;
    state.width = Math.max(this.options.minColumnWidth, Math.round(width));
    state.sized = true;
    this.updateLayout();
    this.requestRender();
  }

  hideColumn(col: number) {
    const state = this.visible[col];
    if (!state || this.visible.length <= 1) return;
    state.hidden = true;
    if (col < this.frozen) this.frozen--;
    this.changeColumns();
  }

  setColumnHidden(index: number, hidden: boolean) {
    const state = this.columns.find((column) => column.index === index);
    if (!state) return;
    if (hidden && this.visible.length <= 1) return;
    state.hidden = hidden;
    this.changeColumns();
  }

  showAllColumns() {
    for (const column of this.columns) column.hidden = false;
    this.changeColumns();
  }

  freezeUpTo(col: number) {
    this.frozen = Math.max(0, Math.min(col + 1, this.visible.length));
    this.scrollToVirtual(0, null);
    this.changeColumns();
  }

  /** Moves a visible column before another visible column. */
  moveColumn(from: number, to: number) {
    const moving = this.visible[from];
    const target = this.visible[to];
    if (!moving || !target || from === to) return;
    const list = this.columns.filter((column) => column !== moving);
    const at = list.indexOf(target);
    list.splice(from < to ? at + 1 : at, 0, moving);
    this.columns = list;
    this.changeColumns();
  }

  /** Width that fits the header and the loaded values of a column. */
  fittedWidth(col: number) {
    const state = this.visible[col];
    const schema = this.columnSchema(col);
    if (!state || !schema || !this.measure) return state?.width ?? 120;
    let widest = this.measure(schema.name, true) + HEADER_CHROME;
    const [first, last] = this.visibleRows();
    const end = Math.min(this.readableRows, Math.max(last, first + 200));
    for (let row = first; row < end; row++) {
      const value = this.cache.value(row, state.index);
      if (value === undefined) continue;
      widest = Math.max(widest, this.measure(this.formatter.format(value, schema.type), false) + 18);
    }
    return Math.max(this.options.minColumnWidth, Math.ceil(widest));
  }

  autoFit(col: number) {
    this.resizeColumn(col, Math.min(this.fittedWidth(col), 1000));
  }

  /**
   * Widens columns whose numbers did not fit (numbers are never cut, since a cut number reads as a
   * different number). Called by the renderer with the widths it needed; columns the user sized
   * keep their width.
   */
  growColumns(widths: Map<number, number>) {
    let changed = false;
    for (const [col, width] of widths) {
      const state = this.visible[col];
      // At most 600 px: wider numbers stay cut, and asking again for them changes nothing.
      const next = Math.min(Math.ceil(width), 600);
      if (!state || state.sized || next <= state.width) continue;
      state.width = next;
      changed = true;
    }
    if (changed) {
      this.updateLayout();
      this.requestRender();
    }
  }

  /** Fits columns to the first loaded rows once, unless the user sized them. */
  private autoSize() {
    if (this.autoSized || !this.measure || this.view.id !== null || this.readableRows === 0) return;
    const first = this.visible[0];
    if (!first || this.cache.value(0, first.index) === undefined) return;
    this.autoSized = true;
    this.visible.forEach((state, col) => {
      if (state.sized) return;
      const schema = this.schema[state.index];
      if (!schema || !this.measure) return;
      let widest = this.measure(schema.name, true) + HEADER_CHROME;
      for (let row = 0; row < Math.min(this.readableRows, 200); row++) {
        const value = this.cache.value(row, state.index);
        if (value === undefined || value === null) continue;
        widest = Math.max(widest, this.measure(this.formatter.format(value, schema.type), false) + 18);
      }
      const cap = isNumericType(schema.type) ? 240 : this.options.maxAutoWidth;
      state.width = Math.max(this.options.minColumnWidth, Math.min(cap, Math.ceil(widest)));
      void col;
    });
    this.updateLayout();
    this.emit();
  }

  // ----- statistics, values, find -----

  stats(col: number, signal?: AbortSignal): Promise<ColumnStats> | null {
    const state = this.visible[col];
    if (!state || !this.source.columnStats) return null;
    return this.source.columnStats(this.view.id, state.index, signal);
  }

  distinct(column: number, search: string, signal?: AbortSignal): Promise<DistinctValues> | null {
    if (!this.source.distinctValues) return null;
    // Values come from the table as a whole, so that filtering a column keeps showing its other values.
    return this.source.distinctValues({ view: null, column, search, limit: 1000 }, signal);
  }

  /** Moves to the next cell containing `text`. Returns whether one was found. */
  async find(text: string, direction: 1 | -1, caseSensitive: boolean, signal?: AbortSignal) {
    this.findText = text;
    this.findCaseSensitive = caseSensitive;
    this.requestRender();
    if (!text || !this.source.find) return false;
    const active = this.selection.active;
    const result = await this.source.find(
      {
        view: this.view.id,
        text,
        columns: this.visible.map((column) => column.index),
        row: Math.min(active.row, Math.max(0, this.rowCount - 1)),
        column: active.col,
        direction,
        caseSensitive,
      },
      signal,
    );
    if (!result || signal?.aborted) return false;
    this.selection.select({ row: result.row, col: result.column });
    this.selectionChanged(result ? { row: result.row, col: result.column } : undefined);
    return true;
  }
}
