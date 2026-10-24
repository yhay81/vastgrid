import {
  type AggregateFunction,
  aggregateApplies,
  type CellPosition,
  type CellStyle,
  type CellValue,
  type ColumnFormat,
  type ColumnFormatter,
  type ColumnGroup,
  type ColumnGroupSpan,
  ColumnLayout,
  type ColumnPin,
  type ColumnSchema,
  type ColumnStats,
  type CompiledFormula,
  type CopyValues,
  columnGroupDepth,
  columnGroupPaths,
  columnGroupSpans,
  compileFormulas,
  copyLayout,
  type DistinctValues,
  ErrorCodes,
  type Filter,
  type FilterGroup,
  type FilterNode,
  type FormulaColumn,
  filterLeaves,
  filtersRows,
  fitFrozen,
  formulaSchema,
  GRID_STATE_VERSION,
  type GridState,
  isAbortError,
  isEmptyQuery,
  isFilterGroup,
  MAX_TEXT_LIMIT,
  mapFilterNode,
  parseGridState,
  parseRowSelection,
  pruneFilterNode,
  RowCache,
  type RowKey,
  type RowSelection,
  RowSelectionModel,
  resolveGridState,
  rowKeyOf,
  rowSelectionQuery,
  ScrollAxis,
  SelectionModel,
  type SelectionSummary,
  type SortDirection,
  sameRowQuery,
  spanAt,
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
import type { CellAction, CellActionHook, DrawCell, GridCellContent } from "./cell-render.js";
import type {
  GridCell,
  GridCellEvent,
  GridColumnsChangeReason,
  GridColumnsEvent,
  GridRowSelectionChangeReason,
  GridRowSelectionEvent,
  GridSelectionEvent,
} from "./events.js";

export interface GridOptions {
  /** Height of rows with one line of text. */
  rowHeight: number;
  /** Lines shown at most in cells of columns that wrap (`ColumnFormat.wrap`). Defaults to 3. */
  maxLines?: number;
  /** Height of each further line of wrapped text. Defaults to 18; the renderer sets it from the font. */
  lineHeight?: number;
  /** Height of the row of column names. Group rows (`columnGroups`) add to the header's height. */
  headerHeight: number;
  /** Groups of columns shown in header rows above the column names (see `ColumnGroup`). */
  columnGroups?: readonly ColumnGroup[];
  /** Height of each header row of groups. Defaults to 24. */
  groupHeaderHeight?: number;
  locale?: string;
  nullText: string;
  frozenColumns: number;
  /** Columns frozen at the right when the table opens. */
  frozenRightColumns?: number;
  minColumnWidth: number;
  maxAutoWidth: number;
  /** Cells copied at most at once. */
  copyLimit: number;
  /** Display settings by schema column name. */
  columnFormats?: Record<string, ColumnFormat>;
  /** Text copied for cells: the values (`raw`, the default) or the shown text (`formatted`). */
  copyValues?: CopyValues;
  /** Shows a checkbox for each row in the row header (see `rowSelection`). */
  checkboxSelection?: boolean;
  /**
   * Schema column name whose values identify the rows (a primary key). Without it, a row's key is its
   * position in the table, which is valid for one `TableInfo.revision`.
   */
  rowKey?: string;
  /** After the table changed, show its end when the last row was shown before (for appended rows). */
  followTail?: boolean;
  /** Milliseconds to wait after a change of the table before reading it again, to merge changes (default 300). */
  changeDelay?: number;
  /** Draws loaded cells instead of the standard drawing (see `DrawCell`). */
  drawCell?: DrawCell;
  /** Tells which cells are links or buttons (see `CellActionHook`). */
  cellAction?: CellActionHook;
}

export interface ColumnState {
  /** Index in the table schema. */
  index: number;
  width: number;
  hidden: boolean;
  /** Width set by the user or fitted to the content, not to be changed automatically. */
  sized: boolean;
}

export type HitZone = "corner" | "group" | "header" | "gutter" | "cell" | "outside";

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
  /** The pointer is over a row's checkbox (`gutter`) or the checkbox of every row (`corner`). */
  checkbox: boolean;
  /** The group header under the pointer (zone `group`); `col` is then the column under the pointer. */
  group?: ColumnGroupSpan;
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

/** Width of the checkboxes at the left of the row header. */
const CHECKBOX_WIDTH = 28;

/**
 * Rows of an `exclude` selection that the grid lists as keys when the view no longer shows only rows it
 * covers (see `GridController.rowSelection`). Larger selections stay as they are.
 */
const ROW_SELECTION_LIST_LIMIT = 100_000;

/** Rows a shift-click on a checkbox checks at once. */
const ROW_RANGE_LIMIT = 10_000;

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
  const { sort, filters, where, search, ...rest } = query;
  return {
    ...rest,
    ...(sort && capabilities.sort ? { sort } : {}),
    ...(filters && capabilities.filter ? { filters } : {}),
    ...(where && capabilities.filter && capabilities.conditions ? { where } : {}),
    ...(search && capabilities.search ? { search } : {}),
  };
}

/** Formula columns as plain values, without other properties. */
function plainFormulas(formulas: readonly FormulaColumn[]): FormulaColumn[] {
  return formulas.map((formula) => ({ name: formula.name, expression: formula.expression }));
}

/** Whether two display settings are the same. Functions are compared by identity. */
function sameFormat(a: ColumnFormat | undefined, b: ColumnFormat | undefined) {
  if (a === b) return true;
  if (!a || !b || a.format !== b.format || a.style !== b.style) return false;
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
  /**
   * The checked rows, by key (see `rowKey`). They stay checked when the view is sorted or filtered; a
   * new revision of the table unchecks them unless the keys come from a key column.
   */
  readonly rowSelection = new RowSelectionModel();
  /** The grid is listing the keys of an `exclude` selection (see `ROW_SELECTION_LIST_LIMIT`). */
  rowSelectionPending = false;
  readonly scrollX = new ScrollAxis();
  readonly scrollY = new ScrollAxis();
  formatter: ValueFormatter;
  /** Changes whenever `formatter` or a column's settings change, so that cached display text is rebuilt. */
  formatVersion = 0;
  /** Formatters of the schema columns, with their display settings. */
  private formatters: ColumnFormatter[] = [];

  /** The table with the formula columns that can be evaluated after its own columns. */
  info: TableInfo | null = null;
  /** The table as the source reports it, without formula columns. */
  tableInfo: TableInfo | null = null;
  /** Formula columns as set, also ones with errors; see `formulaResults`. */
  formulas: FormulaColumn[] = [];
  /** Each formula checked over the table's columns, in the order of `formulas`. */
  formulaResults: CompiledFormula[] = [];
  loadError: string | null = null;
  query: ViewQuery = {};
  view: ViewInfo = { id: null, rowCount: 0, query: {} };
  viewPending = false;
  viewError: string | null = null;
  columns: ColumnState[] = [];
  visible: ColumnState[] = [];
  layout = new ColumnLayout([]);
  /**
   * Visible columns frozen at each side, as the user or the app set them: the first `left` and the last
   * `right` ones. `frozen` and `frozenRight` are the columns drawn frozen, fewer when the grid is too
   * narrow for them (see `fitFrozen`).
   */
  readonly pinned = { left: 0, right: 0 };
  /** Visible columns drawn frozen at the left. */
  frozen = 0;
  frozenWidth = 0;
  /** Visible columns drawn frozen at the right: the last `frozenRight` ones. */
  frozenRight = 0;
  frozenRightWidth = 0;
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
  /** The aggregate shown for each schema column in the totals row at the bottom (see `setTotal`). */
  totals = new Map<number, AggregateFunction>();
  /** The totals of the current view by schema column; null while they are read, or when they failed. */
  totalValues: Map<number, CellValue> | null = null;
  totalsPending = false;
  totalsError: string | null = null;
  /** Increments on every change shown by the React UI. */
  version = 0;
  /** Groups of each schema column name, outermost first (see `columnGroupPaths`). */
  private groupPaths = new Map<string, ColumnGroup[]>();
  /** Header rows of groups. */
  private groupDepth = 0;
  /** The spans of the group rows and what they were computed for. */
  private spans: { key: string; schema: ColumnSchema[]; rows: ColumnGroupSpan[][] } | null = null;
  /** Measures text in the cell or header font; set by the renderer. */
  measure: ((text: string, header: boolean) => number) | null = null;

  private scroller: HTMLElement | null = null;
  private sizer: HTMLElement | null = null;
  private readonly stateListeners = new Set<() => void>();
  private readonly renderListeners = new Set<() => void>();
  private readonly selectionListeners = new Set<(event: GridSelectionEvent) => void>();
  private readonly columnsListeners = new Set<(event: GridColumnsEvent) => void>();
  private readonly gridStateListeners = new Set<(state: GridState) => void>();
  private readonly rowSelectionListeners = new Set<(event: GridRowSelectionEvent) => void>();
  private readonly formulasListeners = new Set<(formulas: FormulaColumn[]) => void>();
  /** The formula columns in the query and the schema: the ones without errors, when the source evaluates them. */
  private shownFormulas: FormulaColumn[] = [];
  /** The last change of the checked rows not yet reported. */
  private rowSelectionChange: GridRowSelectionChangeReason | null = null;
  /** Rows matching the query of an `exclude` selection, when the grid counted them. */
  private rowSelectionRows: { query: string; rows: number } | null = null;
  private rowSelectionAbort: AbortController | null = null;
  /** The row whose checkbox was clicked last, where a shift-click starts. */
  private checkedAnchor: number | null = null;
  /** A state applied before the table's columns were known, and the query it was applied over. */
  private pendingState: { state: GridState; query: ViewQuery } | null = null;
  /** The last change of the column settings not yet reported. */
  private columnChange: GridColumnsChangeReason | null = null;
  /** Increments on every change of the column settings that the state keeps. */
  private columnsRevision = 0;
  /** Increments when the totals row changes its aggregates, which the state keeps. */
  private totalsRevision = 0;
  /** What the shown totals were read for, so that unchanged totals are not read again. */
  private totalsKey = "";
  private totalsAbort: AbortController | null = null;
  /** Increments when the table is read anew (a new revision or other columns). */
  private dataRevision = 0;
  /** Increments when the visible columns or their order change. */
  private visibleRevision = 0;
  private visibleKey = "";
  /** What the last events reported, so that unchanged values are not reported again. */
  private reported: { selection: string; query: ViewQuery; columns: number; totals: number };
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
  private activeChecked: boolean | null = null;
  /** Stops listening to the source's changes (`TableSource.subscribe`). */
  private unsubscribe: (() => void) | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The source reported a change; applied to the next table info (see `applyInfo`). */
  private changeReported = false;
  /** Where the grid was when it started reading the table again, to return there once it is read. */
  private restore: { top: number; left: number; active: CellPosition; tail: boolean; lastRow: boolean } | null = null;
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
    this.groupPaths = columnGroupPaths(options.columnGroups ?? []);
    this.groupDepth = columnGroupDepth(options.columnGroups ?? []);
    this.cache = new RowCache(source);
    this.cache.onChange(() => {
      this.autoSize();
      this.requestRender();
      const active = this.selection.active;
      const value = this.value(active.row, active.col);
      const rowId = this.rowId(active.row);
      // The active row's checkbox is described to screen readers once its key arrives.
      const checked = this.options.checkboxSelection ? this.rowChecked(active.row) : null;
      if (value !== this.activeValue || rowId !== this.activeRowId || checked !== this.activeChecked) {
        this.activeValue = value;
        this.activeRowId = rowId;
        this.activeChecked = checked;
        this.emit();
      }
    });
    this.reported = { selection: this.selectionKey(), query: this.query, columns: 0, totals: 0 };
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

  /** Calls `listener` when rows are checked or unchecked, by the user, the app or the grid. */
  onRowSelectionChange(listener: (event: GridRowSelectionEvent) => void) {
    this.rowSelectionListeners.add(listener);
    return () => {
      this.rowSelectionListeners.delete(listener);
    };
  }

  /** Calls `listener` with `getState()` when the query or the column settings change. */
  /** Called when the formula columns change (by the user or `setFormulas`). */
  onFormulasChange(listener: (formulas: FormulaColumn[]) => void) {
    this.formulasListeners.add(listener);
    return () => {
      this.formulasListeners.delete(listener);
    };
  }

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
    const rowReason = this.rowSelectionChange;
    if (rowReason) {
      this.rowSelectionChange = null;
      if (this.rowSelectionListeners.size > 0) {
        const event: GridRowSelectionEvent = {
          reason: rowReason,
          selection: this.rowSelection.value(),
          count: this.checkedCount,
        };
        for (const listener of this.rowSelectionListeners) listener(event);
      }
    }
    if (
      this.query !== this.reported.query ||
      this.columnsRevision !== this.reported.columns ||
      this.totalsRevision !== this.reported.totals
    ) {
      this.reported.query = this.query;
      this.reported.columns = this.columnsRevision;
      this.reported.totals = this.totalsRevision;
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
    if (!this.unsubscribe && this.source.subscribe) {
      this.unsubscribe = this.source.subscribe(() => this.sourceChanged());
    }
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

  /**
   * Reads the table again (for example after the file changed), keeping the query, the column settings,
   * the scroll position and the active cell. With `followTail`, a grid that showed the last row shows the
   * new last row.
   */
  reload() {
    if (!this.restore && this.info) {
      const [, last] = this.visibleRows();
      const end = this.rowCount > 0 && last >= this.rowCount;
      this.restore = {
        top: this.scrollY.position,
        left: this.scrollX.position,
        active: this.selection.active,
        tail: this.options.followTail === true && end,
        lastRow: this.selection.active.row === this.rowCount - 1,
      };
    }
    this.lifecycle.abort();
    this.polling = false;
    this.loadError = null;
    this.start();
  }

  /** Merges the changes reported within `changeDelay` into one reload. */
  private sourceChanged() {
    if (this.disposed || this.changeTimer !== undefined) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.disposed) return;
      this.changeReported = true;
      this.reload();
    }, this.options.changeDelay ?? 300);
  }

  /** Stops loading and cancels requests. `start()` resumes. */
  stop() {
    this.lifecycle.abort();
    this.polling = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.viewAbort?.abort();
    this.summaryAbort?.abort();
    this.rowSelectionAbort?.abort();
    this.totalsAbort?.abort();
    this.totalsKey = "";
    this.totalsPending = false;
    clearTimeout(this.summaryTimer);
    if (this.rowSelectionPending) this.rowSelectionPending = false;
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
    this.rowSelectionListeners.clear();
    this.formulasListeners.clear();
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

  /** Checks the formulas over the table's columns and adds the ones the source can evaluate to its columns. */
  private withFormulas(table: TableInfo): TableInfo {
    this.formulaResults = compileFormulas(table.columns, this.formulas);
    // While loading, the source's capabilities are not known yet.
    const evaluated = table.status === "loading" || table.capabilities.formulas === true;
    const valid = evaluated ? this.formulaResults.filter((formula) => formula.tree) : [];
    this.shownFormulas = plainFormulas(valid);
    return valid.length === 0 ? table : { ...table, columns: formulaSchema(table.columns, valid) };
  }

  /** The query with the formula columns that the schema has. */
  private formulaQuery(query: ViewQuery): ViewQuery {
    if (JSON.stringify(query.formulas ?? []) === JSON.stringify(this.shownFormulas)) return query;
    const { formulas: _, ...rest } = query;
    return this.shownFormulas.length > 0 ? { formulas: this.shownFormulas, ...rest } : rest;
  }

  private applyInfo(table: TableInfo) {
    // A reopened file may not have its preview schema yet. Keep the old names until new names arrive.
    if (this.tableInfo && table.status === "loading" && table.columns.length === 0) {
      table = { ...table, columns: this.tableInfo.columns };
    }
    // A state applied before the columns were known brings its formula columns.
    const waiting = this.pendingState;
    if (waiting?.state.formulas && table.columns.length > 0) this.formulas = plainFormulas(waiting.state.formulas);
    this.tableInfo = table;
    let info = this.withFormulas(table);
    const shown = this.info;
    // A source that reported a change but has no revision cannot tell the new data from the old: read it
    // as a new revision, so that cached rows and checked rows keyed by position are not kept.
    const previous =
      shown && this.changeReported && shown.revision === undefined && info.revision === undefined
        ? { ...shown, revision: "\u0000changed" }
        : shown;
    this.changeReported = false;
    const names = (table: TableInfo | null) => table?.columns.map((column) => column.name).join("\u0000");
    const types = (table: TableInfo | null) => table?.columns.map((column) => column.type).join("\u0000");
    const expressions = (table: TableInfo | null) =>
      table?.columns.map((column) => column.expression ?? "").join("\u0000");
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
    const reset =
      !previous ||
      previous.revision !== info.revision ||
      names(previous) !== names(info) ||
      expressions(previous) !== expressions(info);
    if (previous) this.keepRowSelection(previous, info);
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
        const { where: tree, ...rest } = this.query;
        const where =
          tree &&
          mapFilterNode(tree, (filter) => {
            const column = indexOf(filter.column);
            return column < 0 ? null : { ...filter, column };
          });
        this.query = {
          ...rest,
          ...(sort ? { sort } : {}),
          ...(filters ? { filters } : {}),
          ...(where ? { where } : {}),
        };
        // Totals follow their columns by name.
        const totals = new Map<number, AggregateFunction>();
        for (const [column, fn] of this.totals) {
          const index = indexOf(column);
          if (index >= 0) totals.set(index, fn);
        }
        if (totals.size !== this.totals.size) this.totalsRevision++;
        this.totals = totals;
        this.columnsChanged(this.columnChange === "formulas" ? "formulas" : "schema");
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
      if (previous && this.columnChange === "formulas") {
        // Columns keep their order when formula columns come and go; new ones follow.
        const order = new Map([...old.keys()].map((name, position) => [name, position]));
        const rank = (state: ColumnState) =>
          order.get(info.columns[state.index]?.name ?? "") ?? order.size + state.index;
        this.columns.sort((a, b) => rank(a) - rank(b));
      }
      if (!previous) {
        this.pinned.left = Math.min(this.options.frozenColumns, this.columns.length);
        this.pinned.right = Math.min(this.options.frozenRightColumns ?? 0, this.columns.length - this.pinned.left);
      }
      const pending = this.pendingState;
      if (pending && info.columns.length > 0) {
        this.pendingState = null;
        const query = this.applyColumns(pending.state);
        // A query set after the state wins over the state's.
        if (query && this.query === pending.query) this.query = query;
      }
      this.autoSized = this.columns.every((column) => column.sized);
      this.viewAbort?.abort();
      this.dataRevision++;
      this.view = { id: null, rowCount: info.rowCount ?? info.readableRows, query: {} };
      this.viewPending = false;
      this.cache.clear();
      // A reload returns to the active cell once the table is read (see `finishRestore`).
      if (!this.restore) this.selection.select({ row: 0, col: 0 });
      // The summary of the previous selection no longer applies.
      this.scheduleSummary();
    } else if (previous.status !== info.status && types(previous) !== types(info)) {
      // The final types differ from the preview's (for example all columns read as text).
      this.cache.clear();
    }
    this.query = this.formulaQuery(this.query);
    if (this.view.id === null) {
      this.view = { id: null, rowCount: info.rowCount ?? info.readableRows, query: {} };
    }
    this.updateLayout();
    if (info.status === "ready" && (reset || previous?.status !== "ready") && !isEmptyQuery(this.query)) {
      void this.runQuery(this.query, true);
    } else if (info.status === "ready" && this.restore && !this.viewPending) {
      this.finishRestore();
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
    // Formula columns are counted in their view, once it exists.
    if (this.view.id === null && this.shownFormulas.length > 0) return false;
    return !this.viewBuilding || !filtersRows(this.view.query);
  }

  get totalRows() {
    return this.info?.rowCount ?? null;
  }

  /** Whether formula columns can be added now: the table is ready and its source evaluates them. */
  get formulasAvailable() {
    return this.info?.status === "ready" && this.info.capabilities.formulas === true;
  }

  /** The formula of a schema column, or null for a column of the table. */
  formulaOf(index: number): FormulaColumn | null {
    const name = this.schema[index]?.expression === undefined ? undefined : this.schema[index].name;
    return name === undefined ? null : (this.formulas.find((formula) => formula.name === name) ?? null);
  }

  /**
   * Replaces the formula columns. Each is a column computed per row by an expression over the table's
   * columns (see `FormulaColumn`); the source evaluates it, so it sorts, filters and exports like the
   * others. Formulas with an error stay in `formulas` (with `formulaResults` telling why) but are not
   * shown until they are fixed, for example when a column they use is gone. Sorts, filters and settings of
   * columns follow their names; the scroll position and the active cell stay.
   */
  setFormulas(formulas: readonly FormulaColumn[], options: { after?: number } = {}) {
    const next = plainFormulas(formulas);
    if (JSON.stringify(next) === JSON.stringify(this.formulas)) return;
    const added = next.filter((formula) => !this.formulas.some((item) => item.name === formula.name));
    const after = options.after === undefined ? undefined : this.schema[options.after]?.name;
    this.formulas = next;
    this.columnsChanged("formulas");
    const table = this.tableInfo;
    if (table && this.info) {
      if (!this.restore) {
        this.restore = {
          top: this.scrollY.position,
          left: this.scrollX.position,
          active: this.selection.active,
          tail: false,
          lastRow: false,
        };
      }
      this.applyInfo(table);
      // A new column is placed after the column it was added from.
      if (after !== undefined && added.length > 0)
        this.placeAfter(
          added.map((formula) => formula.name),
          after,
        );
    } else {
      this.emit();
    }
    for (const listener of this.formulasListeners) listener(this.formulas);
  }

  /** Moves the columns with these names after the column named `after`, in display order. */
  private placeAfter(names: string[], after: string) {
    const moved = this.columns.filter((column) => names.includes(this.schema[column.index]?.name ?? ""));
    const rest = this.columns.filter((column) => !moved.includes(column));
    const at = rest.findIndex((column) => this.schema[column.index]?.name === after);
    if (moved.length === 0 || at < 0) return;
    rest.splice(at + 1, 0, ...moved);
    this.columns = rest;
    this.updateLayout();
    this.emit();
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
    return Math.max(0, this.height - this.headerHeight);
  }

  // ----- column groups -----

  /** Height of the whole header: the rows of groups and the row of column names. Rows start below it. */
  get headerHeight() {
    return this.groupRows * this.groupHeaderHeight + this.options.headerHeight;
  }

  /** Header rows of groups above the column names (0 without groups). */
  get groupRows() {
    return this.groupDepth;
  }

  get groupHeaderHeight() {
    return this.options.groupHeaderHeight ?? 24;
  }

  /**
   * Replaces the column groups. Throws a `RangeError` for invalid groups (see `columnGroupPaths`),
   * keeping the current ones. The header grows or shrinks with the groups' depth; the first visible
   * row stays in place.
   */
  setColumnGroups(groups: readonly ColumnGroup[] | undefined) {
    if (groups === this.options.columnGroups) return;
    const paths = columnGroupPaths(groups ?? []);
    this.options.columnGroups = groups;
    this.groupPaths = paths;
    this.groupDepth = columnGroupDepth(groups ?? []);
    this.spans = null;
    this.syncSizer();
    this.requestRender();
    this.emit();
  }

  /** Changes the height of the group rows. */
  setGroupHeaderHeight(height: number | undefined) {
    if (height === this.options.groupHeaderHeight) return;
    this.options.groupHeaderHeight = height;
    this.syncSizer();
    this.requestRender();
    this.emit();
  }

  /** The first visible column of each region that scrolls apart, where group headers are split. */
  private groupBreaks() {
    const breaks: number[] = [];
    if (this.frozen > 0) breaks.push(this.frozen);
    // Columns frozen at the right start a part of their own too.
    const right = this.visible.length - this.frozenRight;
    if (this.frozenRight > 0 && right > 0 && right !== this.frozen) breaks.push(right);
    return breaks;
  }

  /**
   * The group headers of the visible columns: one list of spans for each group row, outermost first.
   * A group is split where its columns are not side by side (moved apart, or some hidden between
   * others) and between frozen and scrolling columns; each part shows the group's name.
   */
  groupSpans(): ColumnGroupSpan[][] {
    if (this.groupDepth === 0) return [];
    const breaks = this.groupBreaks();
    const key = `${this.visibleKey}|${breaks.join(",")}`;
    const schema = this.schema;
    if (this.spans?.key !== key || this.spans.schema !== schema) {
      const paths = this.visible.map((column) => this.groupPaths.get(schema[column.index]?.name ?? ""));
      this.spans = { key, schema, rows: columnGroupSpans(paths, this.groupDepth, breaks) };
    }
    return this.spans.rows;
  }

  /** The groups of a visible column, outermost first, as their spans. */
  groupsOf(col: number): ColumnGroupSpan[] {
    return this.groupSpans().flatMap((row) => spanAt(row, col) ?? []);
  }

  /**
   * Screen y where a visible column's own header starts: below its groups. Above a column with fewer
   * groups than the header has rows, its header reaches up into the empty group rows.
   */
  headerTop(col: number) {
    return this.groupsOf(col).length * this.groupHeaderHeight;
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

  /** A loaded cell as the drawing and action hooks see it, or null while it is not loaded. */
  cellContent(row: number, col: number): GridCellContent | null {
    const state = this.visible[col];
    const schema = state ? this.schema[state.index] : undefined;
    if (!state || !schema) return null;
    const value = this.cache.value(row, state.index);
    if (value === undefined) return null;
    const text = this.formatterOf(state.index).format(value);
    return { ...this.cell(row, col), value, schema, type: schema.type, text };
  }

  /** The action of a loaded cell from the `cellAction` option, or null. */
  cellActionAt(row: number, col: number): CellAction | null {
    const hook = this.options.cellAction;
    const content = hook ? this.cellContent(row, col) : null;
    return content && hook ? (hook(content) ?? null) : null;
  }

  /** The colors of a loaded cell from its column's `style` setting, or null. */
  cellStyleAt(row: number, col: number): CellStyle | null {
    const state = this.visible[col];
    if (!state) return null;
    const formatter = this.formatterOf(state.index);
    const value = formatter.styled ? this.cache.value(row, state.index) : undefined;
    return value === undefined ? null : formatter.style(value);
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
          frozen: position >= 0 && this.pinOf(position) !== null,
          pin: position >= 0 ? this.pinOf(position) : null,
        };
      }),
      frozenColumns: this.pinned.left,
      frozenRightColumns: this.pinned.right,
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
    this.pinned.left = Math.min(this.pinned.left, this.visible.length);
    this.pinned.right = Math.min(this.pinned.right, this.visible.length - this.pinned.left);
    this.layout = new ColumnLayout(this.visible.map((column) => column.width));
    const largest = Math.max(this.info?.rowCount ?? 0, this.rowCount, 1);
    const digits = String(largest).length;
    this.gutterWidth =
      Math.max(44, Math.ceil(this.measure ? this.measure("0".repeat(digits), false) : digits * 8) + 22) +
      this.checkboxWidth;
    this.fitFrozen();
    this.selection.setBounds(this.rowCount, this.visible.length);
    // Formula columns are read from views only.
    const columns = this.view.id === null ? (this.tableInfo?.columns.length ?? 0) : this.schema.length;
    this.cache.setView(this.view.id, this.rowCount, this.readableRows, columns);
    this.syncSizer();
    this.refreshTotals();
  }

  // ----- totals row -----

  /** Whether the source computes totals (`capabilities.group`) and the table is ready. */
  get totalsAvailable() {
    return Boolean(this.source.group && this.info?.status === "ready" && this.info.capabilities.group);
  }

  /** The aggregate shown for a schema column in the totals row, or null. */
  totalOf(index: number): AggregateFunction | null {
    return this.totals.get(index) ?? null;
  }

  /**
   * Shows an aggregate of a schema column in the totals row at the bottom of the grid, computed by the
   * source over the current view; `null` removes it. Functions that do not apply to the column's type
   * are ignored (see `aggregateApplies`).
   */
  setTotal(index: number, fn: AggregateFunction | null) {
    const type = this.schema[index]?.type;
    if (fn !== null && (!type || !aggregateApplies(fn, type))) return;
    if ((this.totals.get(index) ?? null) === fn) return;
    if (fn === null) this.totals.delete(index);
    else this.totals.set(index, fn);
    this.totalsRevision++;
    this.refreshTotals();
    this.emit();
  }

  /** Reads the totals of the current view once it is ready, unless they are already shown. */
  private refreshTotals() {
    const entries = [...this.totals].filter(([index, fn]) => {
      const type = this.schema[index]?.type;
      return type !== undefined && aggregateApplies(fn, type);
    });
    if (entries.length === 0 || !this.totalsAvailable) {
      this.totalsAbort?.abort();
      this.totalsKey = "";
      this.totalValues = null;
      this.totalsPending = false;
      this.totalsError = null;
      return;
    }
    // A view still building has not got all its rows: the totals wait for it.
    if (this.viewPending || this.viewBuilding) {
      this.totalsAbort?.abort();
      this.totalsKey = "";
      this.totalsPending = true;
      return;
    }
    const key = `${this.view.id}|${this.dataRevision}|${JSON.stringify(entries)}`;
    if (key === this.totalsKey) return;
    this.totalsKey = key;
    this.totalsAbort?.abort();
    const controller = new AbortController();
    this.totalsAbort = controller;
    this.totalsPending = true;
    this.totalsError = null;
    const aggregates = entries.map(([column, fn]) => ({ fn, column }));
    this.source.group?.({ view: this.view.id, keys: [], aggregates }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        const row = result.rows[0] ?? [];
        this.totalValues = new Map(entries.map(([column], at) => [column, row[at] ?? null]));
        this.totalsPending = false;
        this.emit();
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        // Asked again with the next view or setting.
        this.totalsKey = "";
        this.totalValues = null;
        this.totalsPending = false;
        this.totalsError = messageOf(error);
        this.emit();
      },
    );
  }

  /** Sets the columns drawn frozen from the settings and the grid's width. */
  private fitFrozen() {
    const fitted = fitFrozen(this.layout, this.pinned.left, this.pinned.right, this.width - this.gutterWidth);
    this.frozen = fitted.left;
    this.frozenRight = fitted.right;
    this.frozenWidth = this.layout.left(this.frozen);
    this.frozenRightWidth = this.layout.total - this.layout.left(this.visible.length - this.frozenRight);
  }

  /** The first visible column frozen at the right (the number of visible columns without any). */
  get rightStart() {
    return this.visible.length - this.frozenRight;
  }

  /** Where a visible column is set to be frozen (`pinned`), whether or not it is drawn frozen now. */
  pinOf(col: number): ColumnPin {
    if (col < this.pinned.left) return "left";
    if (col >= this.visible.length - this.pinned.right) return "right";
    return null;
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
    const nativeHeight = this.scrollY.resize(this.headerHeight + this.rowCount * rowHeight, this.height);
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
    this.fitFrozen();
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
    const rightStart = this.rightStart;
    if (rightStart <= this.frozen) return [0, -1];
    const start = this.frozenWidth + this.scrollX.position;
    const end = Math.min(
      this.scrollX.position + this.width - this.gutterWidth - this.frozenRightWidth,
      this.layout.left(rightStart),
    );
    if (start >= this.layout.left(rightStart)) return [0, -1];
    const first = Math.max(this.frozen, this.layout.indexAt(start));
    const last = Math.min(rightStart - 1, this.layout.indexAt(Math.max(start, end - 0.001)));
    return [first, last];
  }

  /** Screen x where the columns frozen at the right start (the grid's width without any). */
  get frozenRightX() {
    return this.width - this.frozenRightWidth;
  }

  /** Whether a visible column is drawn frozen at the right. */
  isFrozenRight(col: number) {
    return this.frozenRight > 0 && col >= this.rightStart && col < this.visible.length;
  }

  /**
   * Screen x of a visible column's left edge. Columns frozen at the left follow the row header, those
   * frozen at the right end at the grid's right edge, and the others scroll between them.
   */
  columnX(col: number) {
    if (col < this.frozen) return this.gutterWidth + this.layout.left(col);
    if (this.isFrozenRight(col)) return this.frozenRightX + this.layout.left(col) - this.layout.left(this.rightStart);
    return this.gutterWidth + this.layout.left(col) - this.scrollX.position;
  }

  rowY(row: number) {
    return this.headerHeight + row * this.rowHeight - this.scrollY.position;
  }

  /** The visible column at screen x, or -1. */
  columnAt(x: number) {
    if (x < this.gutterWidth || this.visible.length === 0) return -1;
    if (x < this.gutterWidth + this.frozenWidth) return this.layout.indexAt(x - this.gutterWidth);
    const rightStart = this.rightStart;
    if (this.frozenRight > 0 && x >= this.frozenRightX) {
      if (x >= this.width) return -1;
      const position = this.layout.left(rightStart) + x - this.frozenRightX;
      return Math.max(rightStart, this.layout.indexAt(position));
    }
    const position = x - this.gutterWidth + this.scrollX.position;
    if (position >= this.layout.left(rightStart)) return -1;
    return Math.max(this.frozen, this.layout.indexAt(position));
  }

  rowAt(y: number) {
    if (y < this.headerHeight) return -1;
    const row = Math.floor((y - this.headerHeight + this.scrollY.position) / this.rowHeight);
    return row >= 0 && row < this.rowCount ? row : -1;
  }

  hitTest(x: number, y: number): Hit {
    const header = y < this.headerHeight;
    const gutter = x < this.gutterWidth;
    const col = gutter ? -1 : this.columnAt(x);
    const row = header ? -1 : this.rowAt(y);
    // A group row above a column that has a group there; otherwise the column's own header.
    const level = header && !gutter && col >= 0 ? Math.floor(y / this.groupHeaderHeight) : -1;
    const group = level >= 0 && level < this.groupRows ? spanAt(this.groupSpans()[level], col) : null;
    if (group) return { zone: "group", row: -1, col, resize: -1, menu: false, checkbox: false, group };
    let zone: HitZone = "outside";
    if (header && gutter) zone = "corner";
    else if (header && col >= 0) zone = "header";
    else if (gutter && row >= 0) zone = "gutter";
    else if (row >= 0 && col >= 0) zone = "cell";
    let resize = -1;
    let menu = false;
    const checkbox = (zone === "gutter" || zone === "corner") && x < this.checkboxWidth;
    if (header && !gutter && this.frozenRight > 0 && x >= this.frozenRightX - 5) {
      // Columns frozen at the right are resized at their left edge, since their right edge stays in place.
      const nearest = col >= this.rightStart ? col : this.rightStart;
      const left = this.columnX(nearest);
      const right = left + this.layout.width(nearest);
      if (Math.abs(x - left) <= 5) resize = nearest;
      else if (nearest + 1 < this.visible.length && Math.abs(x - right) <= 5) resize = nearest + 1;
      menu = col >= 0 && resize < 0 && x >= right - 24 && x < right - 4;
    } else if (header && !gutter) {
      const nearest = col >= 0 ? col : this.rightStart - 1;
      const right = this.columnX(nearest) + this.layout.width(nearest);
      const left = this.columnX(nearest);
      if (nearest < 0) {
        // Every column is frozen at the right.
      } else if (Math.abs(x - right) <= 5) resize = nearest;
      else if (nearest > 0 && Math.abs(x - left) <= 5 && (nearest !== this.frozen || this.scrollX.position === 0))
        resize = nearest - 1;
      // The menu button is in the row of column names.
      const names = y >= this.headerHeight - this.options.headerHeight;
      menu = col >= 0 && resize < 0 && names && x >= right - 24 && x < right - 4;
    }
    return { zone, row, col, resize, menu, checkbox };
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
    if (col >= this.frozen && col < this.rightStart) {
      const start = this.layout.left(col) - this.frozenWidth;
      const end = this.layout.right(col) - this.frozenWidth;
      const view = this.width - this.gutterWidth - this.frozenWidth - this.frozenRightWidth;
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

  // ----- checked rows -----

  /** Width of the row checkboxes, or 0 without them. */
  get checkboxWidth() {
    return this.options.checkboxSelection ? CHECKBOX_WIDTH : 0;
  }

  /** Shows or hides the row checkboxes. Hiding them keeps the checked rows. */
  setCheckboxSelection(enabled: boolean) {
    if (Boolean(this.options.checkboxSelection) === enabled) return;
    this.options.checkboxSelection = enabled;
    this.updateLayout();
    this.requestRender();
    this.emit();
  }

  /**
   * Changes the key column (see `GridOptions.rowKey`). Keys of another kind name other rows, so the
   * checked rows are unchecked.
   */
  setRowKey(name: string | undefined) {
    if (name === this.options.rowKey) return;
    this.options.rowKey = name;
    this.rowSelectionRows = null;
    this.checkedAnchor = null;
    if (this.rowSelection.empty) {
      this.requestRender();
      return;
    }
    this.cancelRowListing();
    this.rowSelection.clear();
    this.rowSelectionChanged("key");
  }

  /** The schema index of the key column, or -1 when rows are keyed by position or the column is missing. */
  get rowKeyColumn() {
    const name = this.options.rowKey;
    return name === undefined ? -1 : this.schema.findIndex((column) => column.name === name);
  }

  /**
   * A row's key: its value in the key column, or its position in the table. Null while it is not loaded,
   * and for a blank key.
   */
  rowKey(row: number): RowKey | null {
    if (this.options.rowKey === undefined) return this.rowId(row);
    const column = this.rowKeyColumn;
    return column < 0 ? null : rowKeyOf(this.cache.value(row, column));
  }

  /**
   * Whether a row of the view is checked, or null when it is not known: its key is not loaded, or every
   * row matching a query is checked and this view may show other rows (see `RowSelectionModel.covers`).
   */
  rowChecked(row: number): boolean | null {
    const key = this.rowKey(row);
    return key === null ? null : this.rowSelection.has(key, this.view.query);
  }

  /** The checkbox of every row: every row of the view is checked, none, or some (`"mixed"`). */
  get allRowsChecked() {
    return this.rowSelection.state(this.view.query);
  }

  /** Checked rows, or null when the grid has not counted the rows of an `exclude` selection. */
  get checkedCount(): number | null {
    const selection = this.rowSelection;
    const query = selection.query;
    let rows: number | null = null;
    if (selection.type === "exclude" && !query) rows = this.info?.rowCount ?? null;
    else if (query && this.view.id !== null && sameRowQuery(query, rowSelectionQuery(this.view.query)))
      rows = this.view.rowCount;
    else if (query && this.rowSelectionRows?.query === JSON.stringify(query)) rows = this.rowSelectionRows.rows;
    return selection.count(rows);
  }

  getRowSelection(): RowSelection {
    return this.rowSelection.value();
  }

  /**
   * Replaces the checked rows. Returns false, changing nothing, when the value is not a row selection
   * (see `parseRowSelection`).
   */
  setRowSelection(selection: RowSelection, reason: GridRowSelectionChangeReason = "api") {
    const parsed = parseRowSelection(selection);
    if (!parsed) return false;
    if (this.rowSelection.equals(parsed)) return true;
    this.cancelRowListing();
    this.rowSelection.set(parsed);
    this.checkedAnchor = null;
    this.rowSelectionChanged(reason);
    this.listRowSelection();
    return true;
  }

  /**
   * Checks or unchecks a row, as the user does. With `range`, every row from the row whose checkbox was
   * clicked last gets the same state, when their keys are loaded. Returns whether the row changed.
   */
  toggleRow(row: number, range = false) {
    const checked = this.rowChecked(row);
    const key = this.rowKey(row);
    if (checked === null || key === null) return false;
    let keys = [key];
    const anchor = this.checkedAnchor;
    if (range && anchor !== null && anchor !== row && Math.abs(anchor - row) < ROW_RANGE_LIMIT) {
      const list: RowKey[] = [];
      for (let at = Math.min(anchor, row); at <= Math.max(anchor, row); at++) {
        const item = this.rowKey(at);
        if (item === null) break;
        list.push(item);
      }
      if (list.length === Math.abs(anchor - row) + 1) keys = list;
    }
    this.checkedAnchor = row;
    if (!this.rowSelection.setRows(keys, !checked, this.view.query)) return false;
    this.rowSelectionChanged("user");
    return true;
  }

  /**
   * The checkbox of every row, as the user clicks it: unchecks every row when all of the view's rows are
   * checked, and otherwise checks every row of the view — every row of the table, or with filters or a
   * search, every row matching them — without listing their keys.
   */
  toggleAllRows() {
    if (!this.info) return;
    this.cancelRowListing();
    if (this.allRowsChecked === true) this.rowSelection.clear();
    else this.rowSelection.selectAll(this.view.query);
    this.checkedAnchor = null;
    this.rowSelectionChanged("user");
  }

  /** Unchecks every row. */
  clearRowSelection(reason: GridRowSelectionChangeReason = "user") {
    if (this.rowSelection.empty) return;
    this.cancelRowListing();
    this.rowSelection.clear();
    this.checkedAnchor = null;
    this.rowSelectionChanged(reason);
  }

  private rowSelectionChanged(reason: GridRowSelectionChangeReason) {
    this.rowSelectionChange = reason;
    this.requestRender();
    this.emit();
  }

  private cancelRowListing() {
    this.rowSelectionAbort?.abort();
    this.rowSelectionAbort = null;
    this.rowSelectionPending = false;
  }

  /**
   * The table was read again. Positions name other records in a new revision, so checked rows keyed by
   * position are unchecked then; keys from a key column stay, and are unchecked when that column is
   * gone. A selection of every row matching a query is unchecked when the columns change, since its
   * filters name columns by position.
   */
  private keepRowSelection(previous: TableInfo, info: TableInfo) {
    if (previous.revision !== info.revision) this.rowSelectionRows = null;
    if (this.rowSelection.empty) return;
    const names = (table: TableInfo) => table.columns.map((column) => column.name).join("\u0000");
    const columnsKnown = previous.columns.length > 0 && info.columns.length > 0;
    let reason: GridRowSelectionChangeReason | null = null;
    if (this.options.rowKey === undefined) {
      if (previous.revision !== info.revision) reason = "revision";
    } else if (info.columns.length > 0 && !info.columns.some((column) => column.name === this.options.rowKey)) {
      reason = "schema";
    }
    if (!reason && this.rowSelection.query && columnsKnown && names(previous) !== names(info)) reason = "schema";
    if (!reason) return;
    this.cancelRowListing();
    this.rowSelection.clear();
    this.checkedAnchor = null;
    // Reported by the `emit()` of `applyInfo`.
    this.rowSelectionChange = reason;
  }

  /**
   * Lists the keys of every row matching the query of an `exclude` selection when the view may show rows
   * that do not match it, so that each row can be told checked or not: for up to
   * `ROW_SELECTION_LIST_LIMIT` rows, the selection becomes the list of those keys (reason `query`).
   * Larger selections, and sources that cannot list them, keep the selection as it is; its rows then
   * show as unknown in this view and cannot be toggled.
   */
  private listRowSelection() {
    const selection = this.rowSelection;
    const query = selection.query;
    if (!query || selection.covers(this.view.query) || this.rowSelectionPending) return;
    if (this.info?.status !== "ready") return;
    const column = this.rowKeyColumn;
    if (this.options.rowKey !== undefined && column < 0) return;
    const controller = new AbortController();
    this.rowSelectionAbort = controller;
    this.rowSelectionPending = true;
    const signal = controller.signal;
    const unchecked = new Set(selection.value().keys);
    void (async () => {
      try {
        const view = await this.source.createView(query, signal);
        if (signal.aborted) return;
        this.rowSelectionRows = { query: JSON.stringify(query), rows: view.rowCount };
        if (view.rowCount > ROW_SELECTION_LIST_LIMIT) return;
        const keys: RowKey[] = [];
        for (let start = 0; start < view.rowCount; start += 50_000) {
          const end = Math.min(view.rowCount, start + 50_000);
          const block = await this.source.readRows(
            { view: view.id, start, end, columns: column < 0 ? [] : [column] },
            signal,
          );
          if (signal.aborted || block.end - block.start !== end - start) return;
          if (column < 0 && view.id !== null && !block.rowIds) return;
          for (let offset = 0; offset < end - start; offset++) {
            const key = column < 0 ? (block.rowIds?.[offset] ?? start + offset) : rowKeyOf(block.columns[0]?.[offset]);
            if (key !== null && !unchecked.has(key)) keys.push(key);
          }
        }
        this.rowSelection.set({ type: "include", keys });
        this.rowSelectionChange = "query";
      } catch {
        // The selection stays as it is.
      } finally {
        if (this.rowSelectionAbort === controller) {
          this.rowSelectionAbort = null;
          this.rowSelectionPending = false;
          if (!this.disposed) {
            this.requestRender();
            this.emit();
          }
        }
      }
    })();
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

  setQuery(query: ViewQuery) {
    // A query of the user's own starts at the top, also while a reload would return elsewhere.
    this.restore = null;
    return this.runQuery(query, false);
  }

  /** Returns to where the grid was before `reload()`, now that the table and its view are read. */
  private finishRestore() {
    const restore = this.restore;
    if (!restore) return;
    this.restore = null;
    this.updateLayout();
    const lastRow = Math.max(0, this.rowCount - 1);
    const col = Math.min(restore.active.col, Math.max(0, this.visible.length - 1));
    const row = restore.tail && restore.lastRow ? lastRow : Math.min(restore.active.row, lastRow);
    this.selection.select({ row, col });
    const top = restore.tail ? this.rowCount * this.options.rowHeight : restore.top;
    this.scrollToVirtual(restore.left, top);
    this.scheduleSummary();
  }

  private async runQuery(query: ViewQuery, restoring: boolean) {
    this.query = query;
    this.viewAbort?.abort();
    if (this.info?.status !== "ready") {
      this.emit();
      return;
    }
    // A saved query may ask for what this source cannot do; those parts are left out. The formula
    // columns are the grid's own (see `setFormulas`).
    query = this.formulaQuery(supportedQuery(query, this.info.capabilities));
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
      this.checkedAnchor = null;
      this.updateLayout();
      this.listRowSelection();
      if (restoring && this.restore) {
        this.finishRestore();
      } else {
        this.selection.select({
          row: 0,
          col: Math.min(this.selection.active.col, Math.max(0, this.visible.length - 1)),
        });
        this.scrollToVirtual(null, 0);
        this.scheduleSummary();
      }
      if (this.viewBuilding) void this.followView(query, controller);
    } catch (error) {
      // Only this grid's own cancellation (a newer query replaced this one) is silent.
      if (controller.signal.aborted) return;
      this.viewPending = false;
      this.viewError = messageOf(error);
      // The server is loading the table again (it closed it, for example because the file changed):
      // follow that load, which applies the query once the table is ready.
      if (codeOf(error) === ErrorCodes.notReady) this.reload();
      else this.restore = null;
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

  /** Whether a filter or a condition of the condition tree uses a schema column. */
  isFiltered(column: number) {
    return this.filterOf(column) !== null || filterLeaves(this.query.where).some((filter) => filter.column === column);
  }

  /** Every condition of the query as one AND group: `filters`, then the condition tree. */
  get condition(): FilterGroup {
    const where = pruneFilterNode(this.query.where);
    const filters: FilterNode[] = [...(this.query.filters ?? [])];
    if (where && isFilterGroup(where) && where.type === "and") filters.push(...where.filters);
    else if (where) filters.push(where);
    return { type: "and", filters };
  }

  /**
   * Replaces every condition of the query (`null` removes them). Conditions directly under a top AND
   * group that are the only one on their column become `filters`, which the column menus edit; the rest
   * becomes the condition tree (`where`).
   */
  setCondition(condition: FilterNode | null) {
    const { where: _, ...rest } = this.query;
    const node = pruneFilterNode(condition ?? undefined);
    const filters: Filter[] = [];
    const others: FilterNode[] = [];
    if (node && isFilterGroup(node) && node.type === "and") {
      const counts = new Map<number, number>();
      for (const child of node.filters) {
        if (!isFilterGroup(child)) counts.set(child.column, (counts.get(child.column) ?? 0) + 1);
      }
      for (const child of node.filters) {
        if (!isFilterGroup(child) && counts.get(child.column) === 1) filters.push(child);
        else others.push(child);
      }
    } else if (node && !isFilterGroup(node)) {
      filters.push(node);
    } else if (node) {
      others.push(node);
    }
    const where: FilterNode | undefined = others.length > 1 ? { type: "and", filters: others } : others[0];
    return this.setQuery({ ...rest, filters, ...(where ? { where } : {}) });
  }

  clearFilters() {
    const { where: _, ...rest } = this.query;
    void this.setQuery({ ...rest, filters: [], search: "" });
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
    const pin = this.pinOf(col);
    state.hidden = true;
    if (pin === "left") this.pinned.left--;
    else if (pin === "right") this.pinned.right--;
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

  /** Freezes the visible columns up to `col` at the left (none with -1). */
  freezeUpTo(col: number) {
    const left = Math.max(0, Math.min(col + 1, this.visible.length));
    const right = Math.min(this.pinned.right, this.visible.length - left);
    const changed = left !== this.pinned.left || right !== this.pinned.right;
    this.pinned.left = left;
    this.pinned.right = right;
    this.scrollToVirtual(0, null);
    this.changeColumns(changed ? "freeze" : null);
  }

  /** Freezes the visible columns from `col` to the last one at the right (none with the column count). */
  freezeFrom(col: number) {
    const count = this.visible.length;
    const right = Math.max(0, Math.min(count - col, count));
    const left = Math.min(this.pinned.left, count - right);
    const changed = left !== this.pinned.left || right !== this.pinned.right;
    this.pinned.left = left;
    this.pinned.right = right;
    this.changeColumns(changed ? "freeze" : null);
  }

  /**
   * Freezes a column (by schema index) at the left or the right, or makes it scroll (`null`). The column
   * moves to the inner end of the frozen columns of that side, or to the scrolling column next to the
   * side it leaves. Hidden columns are left as they are.
   */
  setColumnPin(index: number, pin: ColumnPin) {
    const moving = this.columns.find((column) => column.index === index);
    const col = moving ? this.visible.indexOf(moving) : -1;
    if (!moving || col < 0) return;
    const current = this.pinOf(col);
    if (current === pin) return;
    if (current === "left") this.pinned.left--;
    else if (current === "right") this.pinned.right--;
    const rest = this.visible.filter((column) => column !== moving);
    const at =
      pin === "left" || (pin === null && current === "left") ? this.pinned.left : rest.length - this.pinned.right;
    const target = rest[at];
    const list = this.columns.filter((column) => column !== moving);
    list.splice(target ? list.indexOf(target) : list.length, 0, moving);
    this.columns = list;
    if (pin === "left") this.pinned.left++;
    else if (pin === "right") this.pinned.right++;
    this.changeColumns("freeze");
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

  /**
   * Moves the visible columns `first` to `last` (inclusive, for example a group's span), keeping their
   * order, before the visible column `to` when moving left, or after it when moving right. Nothing
   * moves when `to` is one of them.
   */
  moveColumns(first: number, last: number, to: number) {
    const moving = this.visible.slice(first, last + 1);
    const target = this.visible[to];
    if (moving.length === 0 || !target || (to >= first && to <= last)) return;
    const list = this.columns.filter((column) => !moving.includes(column));
    const at = list.indexOf(target);
    list.splice(to > last ? at + 1 : at, 0, ...moving);
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
    const { formulas: _, ...query } = this.query;
    return {
      version: GRID_STATE_VERSION,
      schema: this.schema.map((column) => column.name),
      ...(this.formulas.length > 0 ? { formulas: plainFormulas(this.formulas) } : {}),
      query,
      columns: this.columns.map((state) => {
        const total = this.totals.get(state.index);
        return {
          name: this.schema[state.index]?.name ?? "",
          ...(state.sized ? { width: state.width } : {}),
          ...(state.hidden ? { hidden: true } : {}),
          ...(total ? { total } : {}),
        };
      }),
      frozenColumns: this.pinned.left,
      frozenRightColumns: this.pinned.right,
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
    if (parsed.formulas) this.setFormulas(parsed.formulas);
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
      // Columns the state does not list go before the columns frozen at the right.
      let split = listed.length;
      for (let right = resolved.frozenRightColumns ?? this.pinned.right; right > 0 && split > 0; ) {
        split--;
        if (!listed[split].hidden) right--;
      }
      const others = this.columns.filter((column) => current.has(column.index));
      this.columns = [...listed.slice(0, split), ...others, ...listed.slice(split)];
      // Listed columns without a total show none, as they show when `hidden` is left out.
      const totals = new Map([...this.totals].filter(([index]) => current.has(index)));
      for (const { index, total } of resolved.columns) {
        const type = this.schema[index]?.type;
        if (total && type && aggregateApplies(total, type)) totals.set(index, total);
      }
      if (JSON.stringify([...totals]) !== JSON.stringify([...this.totals])) {
        this.totals = totals;
        this.totalsRevision++;
      }
      if (this.columns.length > 0 && this.columns.every((column) => column.hidden)) this.columns[0].hidden = false;
      this.autoSized = this.columns.every((column) => column.sized);
    }
    if (resolved.frozenColumns !== undefined) this.pinned.left = resolved.frozenColumns;
    if (resolved.frozenRightColumns !== undefined) this.pinned.right = resolved.frozenRightColumns;
    if (resolved.columns || resolved.frozenColumns !== undefined || resolved.frozenRightColumns !== undefined) {
      this.columnsChanged("state");
    }
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
