import {
  type CellValue,
  type ColumnFormat,
  type ColumnFormatter,
  ColumnLayout,
  type ColumnSchema,
  type ColumnStats,
  type CopyValues,
  copyLayout,
  type DistinctValues,
  ErrorCodes,
  type Filter,
  filtersRows,
  GRID_STATE_VERSION,
  type GridState,
  isAbortError,
  isEmptyQuery,
  MAX_TEXT_LIMIT,
  parseGridState,
  RowCache,
  resolveGridState,
  ScrollAxis,
  SelectionModel,
  type SelectionSummary,
  type SortDirection,
  type TableCapabilities,
  type TableInfo,
  type TableSource,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  ValueFormatter,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid-core";
import type {
  GridCell,
  GridCellEvent,
  GridColumnsChangeReason,
  GridColumnsEvent,
  GridSelectionEvent,
} from "./events.js";

export interface GridOptions {
  /** Height of rows with one line of text. */
  rowHeight: number;
  /** Lines shown at most in cells of columns that wrap (`ColumnFormat.wrap`). Defaults to 3. */
  maxLines?: number;
  /** Height of each further line of wrapped text. Defaults to 18; the renderer sets it from the font. */
  lineHeight?: number;
  headerHeight: number;
  locale?: string;
  nullText: string;
  frozenColumns: number;
  minColumnWidth: number;
  maxAutoWidth: number;
  /** Cells copied at most at once. */
  copyLimit: number;
  /** Display settings by schema column name. */
  columnFormats?: Record<string, ColumnFormat>;
  /** Text copied for cells: the values (`raw`, the default) or the shown text (`formatted`). */
  copyValues?: CopyValues;
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

/** The selected ranges have neither the same rows nor the same columns, so they cannot be copied together. */
export class CopyRangesError extends Error {
  constructor() {
    super("Ranges can be copied together when they have the same rows or the same columns.");
  }
}

/** The operation needs rows of the view that are still being sorted (see `GridController.viewBuilding`). */
export class ViewBuildingError extends Error {
  constructor() {
    super("The view is still being sorted.");
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

function sameQuery(a: ViewQuery, b: ViewQuery) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The parts of a query that a source with these capabilities can run. */
function supportedQuery(query: ViewQuery, capabilities: TableCapabilities): ViewQuery {
  const { sort, filters, search, ...rest } = query;
  return {
    ...rest,
    ...(sort && capabilities.sort ? { sort } : {}),
    ...(filters && capabilities.filter ? { filters } : {}),
    ...(search && capabilities.search ? { search } : {}),
  };
}

/** Whether two display settings are the same. Functions are compared by identity. */
function sameFormat(a: ColumnFormat | undefined, b: ColumnFormat | undefined) {
  if (a === b) return true;
  if (!a || !b || a.format !== b.format) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a loaded value may be text that the source cut for display (it then ends with "…"). */
function mayBeCut(value: CellValue) {
  return typeof value === "string" && value.endsWith("…");
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
  /** Changes whenever `formatter` or a column's settings change, so that cached display text is rebuilt. */
  formatVersion = 0;
  /** Formatters of the schema columns, with their display settings. */
  private formatters: ColumnFormatter[] = [];

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
  private readonly selectionListeners = new Set<(event: GridSelectionEvent) => void>();
  private readonly columnsListeners = new Set<(event: GridColumnsEvent) => void>();
  private readonly gridStateListeners = new Set<(state: GridState) => void>();
  /** A state applied before the table's columns were known, and the query it was applied over. */
  private pendingState: { state: GridState; query: ViewQuery } | null = null;
  /** The last change of the column settings not yet reported. */
  private columnChange: GridColumnsChangeReason | null = null;
  /** Increments on every change of the column settings that the state keeps. */
  private columnsRevision = 0;
  /** Increments when the visible columns or their order change. */
  private visibleRevision = 0;
  private visibleKey = "";
  /** What the last events reported, so that unchanged values are not reported again. */
  private reported: { selection: string; query: ViewQuery; columns: number };
  /** A column's width changed while its edge is dragged. */
  private resized = false;
  private activeRowId: number | null = 0;
  private lifecycle = new AbortController();
  private viewAbort: AbortController | null = null;
  private summaryAbort: AbortController | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | undefined;
  private autoSized = false;
  private disposed = false;
  private polling = false;
  private activeValue: CellValue | undefined;
  /** Lines of text in each row: `maxLines` while a visible column wraps, otherwise 1. */
  private wrapLines = 1;
  /** The row height the vertical scroll was last sized with. */
  private sizedRowHeight = 0;

  constructor(source: TableSource, options: GridOptions) {
    this.source = source;
    this.options = options;
    this.formatter = new ValueFormatter({ locale: options.locale, nullText: options.nullText });
    this.options.columnFormats ??= {};
    this.checkFormats(this.options.columnFormats);
    this.cache = new RowCache(source);
    this.cache.onChange(() => {
      this.autoSize();
      this.requestRender();
      const active = this.selection.active;
      const value = this.value(active.row, active.col);
      const rowId = this.rowId(active.row);
      if (value !== this.activeValue || rowId !== this.activeRowId) {
        this.activeValue = value;
        this.activeRowId = rowId;
        this.emit();
      }
    });
    this.reported = { selection: this.selectionKey(), query: this.query, columns: 0 };
  }

  /** Changes the locale and the text for blanks. */
  setFormat(locale: string | undefined, nullText: string) {
    this.options.locale = locale;
    this.options.nullText = nullText;
    this.formatter = new ValueFormatter({ locale, nullText });
    this.formatChanged(this.schema.map((_, index) => index));
  }

  /**
   * Changes the display settings of the columns (by schema name). Columns whose settings changed are
   * drawn again and, unless the user sized them, fitted to their new text.
   */
  setColumnFormats(formats: Record<string, ColumnFormat> = {}) {
    const previous = this.options.columnFormats ?? {};
    this.checkFormats(formats);
    this.options.columnFormats = formats;
    const changed = this.schema.flatMap((column, index) =>
      sameFormat(previous[column.name], formats[column.name]) ? [] : [index],
    );
    if (changed.length > 0) this.formatChanged(changed);
  }

  /** Throws a `RangeError` for invalid settings now, rather than while drawing. */
  private checkFormats(formats: Record<string, ColumnFormat>) {
    for (const [name, format] of Object.entries(formats)) this.formatter.column({ name, type: "unknown" }, format);
  }

  private formatChanged(columns: number[]) {
    this.formatters = [];
    this.formatVersion++;
    this.refit(columns);
    this.syncSizer();
    this.emit();
    this.requestRender();
  }

  /** The formatter of a schema column, with its display settings. */
  formatterOf(index: number): ColumnFormatter {
    let formatter = this.formatters[index];
    if (!formatter) {
      const schema = this.schema[index] ?? { name: "", type: "unknown" };
      formatter = this.formatter.column(schema, this.options.columnFormats?.[schema.name]);
      this.formatters[index] = formatter;
    }
    return formatter;
  }

  /** The name shown for a schema column: its label, or its name. */
  columnLabel(index: number) {
    return this.formatterOf(index).label;
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
    this.report();
    for (const listener of this.stateListeners) listener();
  }

  /** Calls `listener` when the selection changes (see `GridSelectionEvent`). */
  onSelectionChange(listener: (event: GridSelectionEvent) => void) {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  /** Calls `listener` when the user or the app changes the columns' width, order, visibility or freezing. */
  onColumnsChange(listener: (event: GridColumnsEvent) => void) {
    this.columnsListeners.add(listener);
    return () => {
      this.columnsListeners.delete(listener);
    };
  }

  /** Calls `listener` with `getState()` when the query or the column settings change. */
  onStateChange(listener: (state: GridState) => void) {
    this.gridStateListeners.add(listener);
    return () => {
      this.gridStateListeners.delete(listener);
    };
  }

  /** Sends the events of the changes since the last report. */
  private report() {
    const reason = this.columnChange;
    if (reason) {
      this.columnChange = null;
      if (this.columnsListeners.size > 0) {
        const event = this.columnsEvent(reason);
        for (const listener of this.columnsListeners) listener(event);
      }
    }
    const selection = this.selectionKey();
    if (selection !== this.reported.selection) {
      this.reported.selection = selection;
      if (this.selectionListeners.size > 0) {
        const event = this.selectionEvent();
        for (const listener of this.selectionListeners) listener(event);
      }
    }
    if (this.query !== this.reported.query || this.columnsRevision !== this.reported.columns) {
      this.reported.query = this.query;
      this.reported.columns = this.columnsRevision;
      if (this.gridStateListeners.size > 0) {
        const state = this.getState();
        for (const listener of this.gridStateListeners) listener(state);
      }
    }
  }

  private selectionKey() {
    const { active, ranges } = this.selection;
    const list = ranges.map(
      (range) =>
        `${range.top},${range.left},${range.bottom},${range.right},${range.allRows ? 1 : 0}${range.allCols ? 1 : 0}`,
    );
    return `${this.view.id}|${this.visibleRevision}|${active.row},${active.col},${this.rowId(active.row)}|${list.join(";")}`;
  }

  private columnsChanged(reason: GridColumnsChangeReason) {
    this.columnChange = reason;
    this.columnsRevision++;
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
    if (this.viewBuilding) {
      // `stop()` ended the polling of the view.
      const controller = new AbortController();
      this.viewAbort = controller;
      void this.followView(this.view.query, controller);
    }
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
    this.selectionListeners.clear();
    this.columnsListeners.clear();
    this.gridStateListeners.clear();
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
    const names = (table: TableInfo | null) => table?.columns.map((column) => column.name).join("\u0000");
    const types = (table: TableInfo | null) => table?.columns.map((column) => column.type).join("\u0000");
    // A reopened file may not have its preview schema yet. Keep the old names until new names arrive.
    if (previous && info.status === "loading" && info.columns.length === 0) {
      info = { ...info, columns: previous.columns };
    }
    this.info = info;
    this.loadError = null;
    if (names(previous) !== names(info) || types(previous) !== types(info)) {
      this.formatters = [];
      this.formatVersion++;
    }
    const reset = !previous || previous.revision !== info.revision || names(previous) !== names(info);
    if (reset) {
      if (previous?.columns.length && names(previous) !== names(info)) {
        const indexOf = (column: number) => {
          const name = previous.columns[column]?.name;
          return name === undefined ? -1 : info.columns.findIndex((item) => item.name === name);
        };
        const sort = this.query.sort?.flatMap((key) => {
          const column = indexOf(key.column);
          return column < 0 ? [] : [{ ...key, column }];
        });
        const filters = this.query.filters?.flatMap((filter) => {
          const column = indexOf(filter.column);
          return column < 0 ? [] : [{ ...filter, column }];
        });
        this.query = { ...this.query, ...(sort ? { sort } : {}), ...(filters ? { filters } : {}) };
        this.columnsChanged("schema");
      }
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
      const pending = this.pendingState;
      if (pending && info.columns.length > 0) {
        this.pendingState = null;
        const query = this.applyColumns(pending.state);
        // A query set after the state wins over the state's.
        if (query && this.query === pending.query) this.query = query;
      }
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
    if (info.status === "ready" && (reset || previous?.status !== "ready") && !isEmptyQuery(this.query)) {
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

  /** Rows that can be read now (less than `rowCount` while a table loads or a sorted view is building). */
  get readableRows() {
    return this.view.id !== null ? (this.view.readableRows ?? this.view.rowCount) : (this.info?.readableRows ?? 0);
  }

  /**
   * The view shows its first rows while the source still sorts the rest. Scrolling and selecting work
   * on every row; rows past `readableRows` show as loading, and copies, summaries, statistics of
   * filtered views and find wait until the view is ready.
   */
  get viewBuilding() {
    return this.view.status === "building";
  }

  /** Whether the statistics of a column can be computed now. */
  get statsAvailable() {
    return !this.viewBuilding || !filtersRows(this.view.query);
  }

  get totalRows() {
    return this.info?.rowCount ?? null;
  }

  columnSchema(col: number): ColumnSchema | undefined {
    const state = this.visible[col];
    return state ? this.schema[state.index] : undefined;
  }

  /**
   * Height of every row: `rowHeight`, and `lineHeight` more for each further line while a visible column
   * wraps. All rows have the same height, so that any row's position is known without reading the rows.
   */
  get rowHeight() {
    return this.options.rowHeight + (this.wrapLines - 1) * (this.options.lineHeight ?? 18);
  }

  /** Lines shown at most in cells that wrap, between 1 and 20. */
  get maxLines() {
    const lines = Math.floor(this.options.maxLines ?? 3);
    return Number.isFinite(lines) ? Math.min(20, Math.max(1, lines)) : 3;
  }

  /** Changes the lines shown at most in cells that wrap, keeping the first visible row in place. */
  setMaxLines(maxLines: number | undefined) {
    if (maxLines === this.options.maxLines) return;
    this.options.maxLines = maxLines;
    this.syncSizer();
    this.requestRender();
  }

  /** Changes the height of further lines of wrapped text, keeping the first visible row in place. */
  setLineHeight(lineHeight: number) {
    if (lineHeight === this.options.lineHeight) return;
    this.options.lineHeight = lineHeight;
    this.syncSizer();
    this.requestRender();
  }

  get bodyHeight() {
    return Math.max(0, this.height - this.options.headerHeight);
  }

  /**
   * A row's position in the original table: the row itself without sort and filters; in a view, the
   * position read with the row, or null while it is not loaded.
   */
  rowId(row: number): number | null {
    if (this.view.id === null) return row;
    return this.cache.rowId(row) ?? null;
  }

  /** The coordinates of a cell given by its view row and visible column. */
  cell(row: number, col: number): GridCell {
    return { row, rowId: this.rowId(row), col, column: this.visible[col]?.index ?? -1 };
  }

  /** An event for a click or double click on a cell, or for the key that does the same. */
  cellEvent(
    row: number,
    col: number,
    trigger: GridCellEvent["trigger"],
    keys: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  ): GridCellEvent {
    let prevented = false;
    return {
      ...this.cell(row, col),
      value: this.value(row, col),
      trigger,
      shiftKey: keys.shiftKey,
      ctrlKey: keys.ctrlKey,
      metaKey: keys.metaKey,
      altKey: keys.altKey,
      preventDefault() {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    };
  }

  selectionEvent(): GridSelectionEvent {
    const active = this.selection.active;
    return {
      active: this.cell(active.row, active.col),
      ranges: this.selection.ranges.map((range) => ({
        top: range.top,
        bottom: range.bottom,
        left: range.left,
        right: range.right,
        columns: this.visible.slice(range.left, range.right + 1).map((column) => column.index),
        allRows: range.allRows === true,
        allCols: range.allCols === true,
      })),
    };
  }

  columnsEvent(reason: GridColumnsChangeReason): GridColumnsEvent {
    let col = 0;
    return {
      reason,
      columns: this.columns.map((state) => {
        const position = state.hidden ? -1 : col++;
        return {
          column: state.index,
          name: this.schema[state.index]?.name ?? "",
          col: position,
          width: state.width,
          hidden: state.hidden,
          sized: state.sized,
          frozen: position >= 0 && position < this.frozen,
        };
      }),
      frozenColumns: this.frozen,
    };
  }

  /** Row labels: the position in the original table for views, otherwise the row number. */
  rowLabel(row: number) {
    if (this.view.id === null) return row + 1;
    const id = this.cache.rowId(row);
    return id === undefined ? null : id + 1;
  }

  updateLayout() {
    this.visible = this.columns.filter((column) => !column.hidden);
    const visibleKey = this.visible.map((column) => column.index).join(",");
    if (visibleKey !== this.visibleKey) {
      this.visibleKey = visibleKey;
      this.visibleRevision++;
    }
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

  /**
   * Sizes the native scroll content and applies the current positions. When the row height changed (a
   * wrapping column was shown, hidden or set, or the lines changed), the first visible row stays in place.
   */
  syncSizer() {
    this.wrapLines = this.visible.some((column) => this.formatterOf(column.index).wrap) ? this.maxLines : 1;
    const rowHeight = this.rowHeight;
    const topRow =
      this.sizedRowHeight > 0 && rowHeight !== this.sizedRowHeight ? this.scrollY.position / this.sizedRowHeight : null;
    this.sizedRowHeight = rowHeight;
    const nativeWidth = this.scrollX.resize(this.gutterWidth + this.layout.total, this.width);
    const nativeHeight = this.scrollY.resize(this.options.headerHeight + this.rowCount * rowHeight, this.height);
    if (topRow !== null) this.scrollY.scrollTo(topRow * rowHeight);
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
    const rowHeight = this.rowHeight;
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
    return this.options.headerHeight + row * this.rowHeight - this.scrollY.position;
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
    const row = Math.floor((y - this.options.headerHeight + this.scrollY.position) / this.rowHeight);
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
    const rowHeight = this.rowHeight;
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
    return Math.max(1, Math.floor(this.bodyHeight / this.rowHeight) - 1);
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
    if (cells <= 1 || !this.source.aggregate || this.info?.status !== "ready" || !this.info.capabilities.aggregate) {
      this.summary = null;
      this.summaryPending = false;
      return;
    }
    if (this.viewBuilding && ranges.some((range) => range.end > this.readableRows)) {
      // Summarized once the view is ready.
      this.summary = null;
      this.summaryPending = true;
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
      { view: this.view.id, start: row, end: row + 1, columns: [state.index], textLimit: MAX_TEXT_LIMIT },
      signal,
    );
    return block.columns[0]?.[0] ?? null;
  }

  /**
   * Builds clipboard text from values per column. With `copyValues: "raw"` (the default) cells are their
   * values and headers the schema names; with `"formatted"` they are the shown text and the labels.
   * A column's own `copy` setting decides for its cells.
   */
  private clipboardText(
    columns: ColumnState[],
    values: CellValue[][],
    rows: number,
    options: { headers?: boolean; markdown?: boolean },
  ) {
    const mode = this.options.copyValues ?? "raw";
    const formatters = columns.map((column) => this.formatterOf(column.index));
    const header = formatters.map((formatter) => (mode === "formatted" ? formatter.label : formatter.schema.name));
    const body: string[][] = [];
    for (let row = 0; row < rows; row++) {
      body.push(values.map((column, index) => formatters[index].copyText(column[row] ?? null, mode)));
    }
    if (options.markdown) return { text: toMarkdownTable(header, body), html: null, cells: rows * columns.length };
    const table = options.headers ? [header, ...body] : body;
    return { text: toTsv(table), html: toHtmlTable(table, options.headers ? 1 : 0), cells: rows * columns.length };
  }

  /** The rows and columns that the selection copies (see `copyLayout`), or null when they cannot be combined. */
  private copyCells() {
    const layout = copyLayout(this.selection.ranges);
    if (!layout) return null;
    const columns = layout.cols.flatMap((col) => this.visible[col] ?? []);
    let rows = 0;
    for (const span of layout.rows) rows += span.end - span.start;
    return { spans: layout.rows, columns, rows };
  }

  /**
   * The selection's values from the cache, or null when some are not loaded, may have been cut for
   * display, the selection is large, or its ranges cannot be copied together.
   */
  private cachedRange() {
    const cells = this.copyCells();
    if (!cells) return null;
    const { spans, columns, rows } = cells;
    if (rows * columns.length > 50_000) return null;
    const values: CellValue[][] = [];
    for (const column of columns) {
      const list: CellValue[] = [];
      for (const span of spans) {
        for (let row = span.start; row < span.end; row++) {
          const value = this.cache.value(row, column.index);
          if (value === undefined || mayBeCut(value)) return null;
          list.push(value);
        }
      }
      values.push(list);
    }
    return { columns, values, rows };
  }

  /** Clipboard text for the selection when every cell is loaded; otherwise null (use `copySelection`). */
  copySelectionSync(options: { headers?: boolean; markdown?: boolean }) {
    const cached = this.cachedRange();
    return cached ? this.clipboardText(cached.columns, cached.values, cached.rows, options) : null;
  }

  /**
   * Copies the selection as TSV and HTML (or Markdown), reading cells that are not loaded. Several
   * ranges are combined as `copyLayout` describes; `copyLimit` applies to the combined cells.
   */
  async copySelection(
    options: { headers?: boolean; markdown?: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string; html: string | null; cells: number }> {
    if (this.selection.ranges.length === 0) return { text: "", html: null, cells: 0 };
    const cells = this.copyCells();
    if (!cells) throw new CopyRangesError();
    const { spans, columns, rows } = cells;
    if (rows * columns.length > this.options.copyLimit) throw new CopyTooLargeError(this.options.copyLimit);
    if (this.viewBuilding && spans.some((span) => span.end > this.readableRows)) throw new ViewBuildingError();
    const cached = this.cachedRange();
    if (cached) return this.clipboardText(cached.columns, cached.values, cached.rows, options);
    const indexes = columns.map((column) => column.index);
    const values: CellValue[][] = columns.map(() => []);
    for (const span of spans) {
      // Sources may finish a request that was canceled; stop before reading the next range.
      signal?.throwIfAborted();
      const read = await this.cache.read(span.start, span.end, indexes, signal);
      read.forEach((list, index) => {
        const target = values[index];
        for (const value of list) target.push(value);
      });
    }
    signal?.throwIfAborted();
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
    // A saved query may ask for what this source cannot do; those parts are left out.
    query = supportedQuery(query, this.info.capabilities);
    this.query = query;
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
      if (this.viewBuilding) void this.followView(query, controller);
    } catch (error) {
      // Only this grid's own cancellation (a newer query replaced this one) is silent.
      if (controller.signal.aborted) return;
      this.viewPending = false;
      this.viewError = messageOf(error);
      // The server is loading the table again (it closed it, for example because the file changed):
      // follow that load, which applies the query once the table is ready.
      if (codeOf(error) === ErrorCodes.notReady) this.reload();
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
      return await this.source.createView(query, signal, { preview: true });
    } catch (error) {
      if (signal.aborted || codeOf(error) !== ErrorCodes.cancelled) throw error;
      return this.source.createView(query, signal, { preview: true });
    }
  }

  /**
   * Polls a view that is building until it is ready, then makes the rest of its rows readable. The rows
   * shown so far stay: they are the first rows of the finished view. A newer query stops the polling,
   * so that the state of an old view never replaces the current one.
   */
  private async followView(query: ViewQuery, controller: AbortController) {
    const signal = controller.signal;
    let id = this.view.id;
    let delay = 150;
    while (id !== null && this.viewAbort === controller && this.viewBuilding && !signal.aborted) {
      await sleep(delay, signal);
      delay = Math.min(1000, delay * 1.5);
      if (signal.aborted) return;
      let next: ViewInfo;
      try {
        // Sources without `viewInfo` answer a request without a preview once the view is ready.
        next = this.source.viewInfo
          ? await this.source.viewInfo(id, signal)
          : await this.source.createView(query, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // The server stopped or forgot the build: the next poll asks for the view again.
        if (codeOf(error) === ErrorCodes.cancelled) continue;
        this.viewError = messageOf(error);
        this.view = { ...this.view, status: "error" };
        this.emit();
        this.requestRender();
        return;
      }
      if (signal.aborted || this.viewAbort !== controller || this.disposed) return;
      if (next.status === "error") this.viewError = next.error ?? null;
      const changed =
        next.id !== id || next.status !== this.view.status || next.readableRows !== this.view.readableRows;
      this.view = next;
      if (!changed) continue;
      // Another view of the same query has the same rows, but they are read under its id.
      if (next.id !== id) this.cache.clear();
      id = next.id;
      this.updateLayout();
      if (!this.viewBuilding) this.scheduleSummary();
      this.emit();
      this.requestRender();
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

  private changeColumns(reason: GridColumnsChangeReason | null) {
    if (reason) this.columnsChanged(reason);
    this.updateLayout();
    this.selectionChanged();
  }

  /**
   * Sets a column's width. While the user drags the column's edge (`resizing`), the change is reported
   * once, by `finishResize()`.
   */
  resizeColumn(col: number, width: number) {
    const state = this.visible[col];
    if (!state) return;
    const next = Math.max(this.options.minColumnWidth, Math.round(width));
    if (next === state.width && state.sized) return;
    state.width = next;
    state.sized = true;
    this.updateLayout();
    this.requestRender();
    if (this.resizing >= 0) {
      this.resized = true;
    } else {
      this.columnsChanged("resize");
      this.emit();
    }
  }

  /** Ends dragging a column's edge. */
  finishResize() {
    if (this.resizing < 0) return;
    this.resizing = -1;
    this.requestRender();
    if (this.resized) {
      this.resized = false;
      this.columnsChanged("resize");
      this.emit();
    }
  }

  hideColumn(col: number) {
    const state = this.visible[col];
    if (!state || this.visible.length <= 1) return;
    state.hidden = true;
    if (col < this.frozen) this.frozen--;
    this.changeColumns("visibility");
  }

  setColumnHidden(index: number, hidden: boolean) {
    const state = this.columns.find((column) => column.index === index);
    if (!state || state.hidden === hidden) return;
    if (hidden && this.visible.length <= 1) return;
    state.hidden = hidden;
    this.changeColumns("visibility");
  }

  showAllColumns() {
    const changed = this.columns.some((column) => column.hidden);
    for (const column of this.columns) column.hidden = false;
    this.changeColumns(changed ? "visibility" : null);
  }

  freezeUpTo(col: number) {
    const frozen = Math.max(0, Math.min(col + 1, this.visible.length));
    const changed = frozen !== this.frozen;
    this.frozen = frozen;
    this.scrollToVirtual(0, null);
    this.changeColumns(changed ? "freeze" : null);
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
    this.changeColumns("move");
  }

  // ----- state -----

  /**
   * The grid's settings as JSON that can be saved: the query and the columns' order, set widths,
   * visibility and freezing. The selection and the scroll position are not part of it. Before the
   * table's columns are known, it is the state applied meanwhile, as it was given, or only the query.
   */
  getState(): GridState {
    if (this.schema.length === 0) return this.pendingState?.state ?? { version: GRID_STATE_VERSION, query: this.query };
    return {
      version: GRID_STATE_VERSION,
      schema: this.schema.map((column) => column.name),
      query: this.query,
      columns: this.columns.map((state) => ({
        name: this.schema[state.index]?.name ?? "",
        ...(state.sized ? { width: state.width } : {}),
        ...(state.hidden ? { hidden: true } : {}),
      })),
      frozenColumns: this.frozen,
    };
  }

  /**
   * Applies a saved state (see `GridState`); parts it leaves out keep their current settings. Values
   * from storage are checked with `parseGridState`. Before the table's columns are known, the state is
   * kept and applied when they arrive. Returns false when the value is not a state this version reads.
   */
  applyState(state: GridState): boolean {
    const parsed = parseGridState(state);
    if (!parsed) return false;
    if (this.schema.length === 0) {
      this.pendingState = { state: parsed, query: this.query };
      return true;
    }
    this.pendingState = null;
    const query = this.applyColumns(parsed);
    this.updateLayout();
    this.autoSize();
    if (query && !sameQuery(query, this.query)) void this.setQuery(query);
    this.selectionChanged();
    return true;
  }

  /** Applies a state's column settings and returns its query mapped onto the table's columns. */
  private applyColumns(state: GridState) {
    const resolved = resolveGridState(
      state,
      this.schema.map((column) => column.name),
    );
    if (resolved.columns) {
      const current = new Map(this.columns.map((column) => [column.index, column]));
      const listed = resolved.columns.flatMap(({ index, width, hidden }): ColumnState[] => {
        const column = current.get(index);
        if (!column) return [];
        current.delete(index);
        if (width !== undefined) {
          return [{ index, hidden, sized: true, width: Math.max(this.options.minColumnWidth, Math.round(width)) }];
        }
        const type = this.schema[index]?.type;
        const automatic = column.sized ? ((type && defaultWidths[type]) ?? 150) : column.width;
        return [{ index, hidden, sized: false, width: automatic }];
      });
      this.columns = [...listed, ...this.columns.filter((column) => current.has(column.index))];
      if (this.columns.length > 0 && this.columns.every((column) => column.hidden)) this.columns[0].hidden = false;
      this.autoSized = this.columns.every((column) => column.sized);
    }
    if (resolved.frozenColumns !== undefined) this.frozen = resolved.frozenColumns;
    if (resolved.columns || resolved.frozenColumns !== undefined) this.columnsChanged("state");
    return resolved.query;
  }

  /** Width that fits the header and the loaded values of a column in rows `[first, end)`. */
  private contentWidth(state: ColumnState, first: number, end: number, blanks: boolean) {
    if (!this.measure) return state.width;
    const formatter = this.formatterOf(state.index);
    let widest = this.measure(formatter.label, true) + HEADER_CHROME;
    for (let row = first; row < Math.min(this.readableRows, end); row++) {
      const value = this.cache.value(row, state.index);
      if (value === undefined || (value === null && !blanks)) continue;
      widest = Math.max(widest, this.measure(formatter.format(value), false) + 18);
    }
    return Math.max(this.options.minColumnWidth, Math.ceil(widest));
  }

  /** Width that fits the header and the loaded values of a column. */
  fittedWidth(col: number) {
    const state = this.visible[col];
    if (!state || !this.columnSchema(col) || !this.measure) return state?.width ?? 120;
    const [first, last] = this.visibleRows();
    return this.contentWidth(state, first, Math.max(last, first + 200), true);
  }

  /** The automatic width of a column: its content, at most `maxAutoWidth` (240 px for numbers). */
  private autoWidth(state: ColumnState, first: number) {
    const cap = this.formatterOf(state.index).numeric ? 240 : this.options.maxAutoWidth;
    return Math.min(cap, this.contentWidth(state, first, first + 200, false));
  }

  /**
   * Fits schema columns again after their text changed (new settings or locale), unless the user sized
   * them. Before the first automatic sizing there is nothing to fit yet.
   */
  private refit(indexes: number[]) {
    if (!this.autoSized || !this.measure) return;
    const [first] = this.visibleRows();
    let changed = false;
    for (const index of indexes) {
      const state = this.columns.find((column) => column.index === index);
      if (!state || state.sized) continue;
      const width = this.autoWidth(state, first);
      if (width !== state.width) {
        state.width = width;
        changed = true;
      }
    }
    if (changed) this.updateLayout();
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
    for (const state of this.visible) {
      if (!state.sized && this.schema[state.index]) state.width = this.autoWidth(state, 0);
    }
    this.updateLayout();
    this.emit();
  }

  // ----- statistics, values, find -----

  stats(col: number, signal?: AbortSignal): Promise<ColumnStats> | null {
    const state = this.visible[col];
    if (!state || !this.source.columnStats || !this.statsAvailable) return null;
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
    if (!text || !this.source.find || !this.info?.capabilities.find) return false;
    // Find walks the whole view.
    if (this.viewBuilding) throw new ViewBuildingError();
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
