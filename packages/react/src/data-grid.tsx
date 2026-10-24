import {
  type ComponentType,
  type CSSProperties,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CellValue,
  type ColumnFormat,
  type ColumnGroup,
  type CopyValues,
  filterLeaves,
  type GridState,
  type RowSelection,
  type TableSource,
  type ViewQuery,
} from "vastgrid-core";
import type { CellActionHook, DrawCell } from "./cell-render.js";
import { StatusBar, Toolbar } from "./components/bars.js";
import { CellInspector } from "./components/cell-inspector.js";
import { ColumnsPanel } from "./components/columns-panel.js";
import { DetailFields, DetailPanel, type DetailPanelProps } from "./components/detail-panel.js";
import { ExportPanel } from "./components/export-panel.js";
import { FilterBuilder, type FilterDraft, initialDraft } from "./components/filter-builder.js";
import { FilterPanel } from "./components/filter-panel.js";
import { FindBar } from "./components/find-bar.js";
import { type Anchor, type MenuItem, MenuList, Popover } from "./components/popover.js";
import { StatsPanel } from "./components/stats-panel.js";
import { CopyRangesError, CopyTooLargeError, GridController, type Hit, ViewBuildingError } from "./controller.js";
import { DetailTracker, detailKeyAction } from "./detail.js";
import type { GridCellEvent, GridColumnsEvent, GridRowSelectionEvent, GridSelectionEvent } from "./events.js";
import { exportSupport, type GridExportOptions, offeredFormats } from "./export.js";
import { countFormat, numberFormat } from "./labels.js";
import { type Messages, messagesFor } from "./messages.js";
import { CanvasRenderer } from "./renderer.js";
import { cssLength, resolveTheme } from "./theme.js";

export interface DataGridProps {
  /** The table to show. A new source starts a new grid. */
  source: TableSource;
  /** Locale for numbers and the built-in texts (`ja` or `en`). Defaults to the browser's language. */
  locale?: string;
  /** Replaces some of the built-in texts. */
  messages?: Partial<Messages>;
  /** Row height in pixels. Defaults to `--vg-row-height` or 24. */
  rowHeight?: number;
  /**
   * Height of the row of column names in pixels. Defaults to `--vg-header-height` or 32. Rows of
   * `columnGroups` add to the header.
   */
  headerHeight?: number;
  /**
   * Groups of columns, named in header rows above the column names; nested groups add rows. Members are
   * schema column names. Groups follow their columns: moving, hiding or freezing columns so that a
   * group's columns are no longer side by side splits its header, each part showing its name. Clicking a
   * group header selects its columns; dragging a selected one moves them together. Groups are not part
   * of `GridState`. Keep the array stable (memoize it).
   */
  columnGroups?: readonly ColumnGroup[];
  /** Height of each header row of groups in pixels. Defaults to `--vg-group-header-height` or 24. */
  groupHeaderHeight?: number;
  /**
   * Lines shown at most in cells of columns that wrap (`wrap` in `columnFormats`), from 1 to 20.
   * Defaults to 3. While a visible column wraps, every row is `rowHeight` plus `--vg-line-height` (1.4
   * times the font size) for each further line; longer text ends with "…" and the cell inspector shows it all.
   */
  maxLines?: number;
  /** Text shown for null cells. Defaults to an empty cell. */
  nullText?: string;
  /** Columns frozen at the left when the table opens. */
  frozenColumns?: number;
  /** Shows the search box, active filters and row count. Defaults to `true`. */
  toolbar?: boolean;
  /** Shows the active cell and the selection summary. Defaults to `true`. */
  statusBar?: boolean;
  /**
   * Changing this value reads the table again, for example when the file changed on disk. Sources that
   * report their changes (`TableSource.subscribe`) are read again by themselves. Either way the grid
   * keeps the query, the column settings, the scroll position and the active cell.
   */
  reloadKey?: unknown;
  /**
   * After the table changed, show its end when the last row was shown before, as `tail -f` does for
   * rows appended to a log. Defaults to `false`.
   */
  followTail?: boolean;
  /** Cells that can be copied at once. Defaults to 1,000,000. */
  copyLimit?: number;
  /**
   * Display settings by schema column name: label, number and date formats, alignment, a format
   * function. They change only what is shown; sorting, filters and statistics use the values.
   * Keep the object stable (memoize it) to avoid comparing it on every render.
   */
  columnFormats?: Record<string, ColumnFormat>;
  /**
   * Text that copying writes for cells: the values (`raw`, the default) with the schema names as
   * headers, or the shown text (`formatted`) with the labels. A column's `copy` setting overrides it.
   */
  copyValues?: CopyValues;
  /**
   * The export panel (the toolbar's Export button), shown when the source can export
   * (`capabilities.export`). The options decide where files go: see `GridExportOptions`. `false` hides
   * the panel. Defaults to `{}`: files returned by the source are downloaded, files written by a server
   * are named by the file name the user enters.
   */
  exportOptions?: GridExportOptions | false;
  /**
   * Draws loaded cells in the visible rows and columns instead of the grid, with the cell's rectangle,
   * value, type, text, selection state and theme; `args.drawDefault()` draws the standard cell. For
   * colors by value, a column's `style` setting in `columnFormats` is enough. Keep the function stable.
   */
  drawCell?: DrawCell;
  /**
   * Makes cells links or buttons: their pointer, their role for screen readers, and links drawn
   * underlined in `--vg-link-fg`. Clicking them or pressing Space calls `onCellClick`. Keep the function stable.
   */
  cellAction?: CellActionHook;
  onQueryChange?: (query: ViewQuery) => void;
  /** Called when the selection or the active cell changes, by the user or by the app. */
  onSelectionChange?: (event: GridSelectionEvent) => void;
  /** Called when the columns' width, order, visibility or freezing change. */
  onColumnsChange?: (event: GridColumnsEvent) => void;
  /** Called when a cell is clicked, or Space is pressed on the active cell. */
  onCellClick?: (event: GridCellEvent) => void;
  /**
   * Called when a cell is double-clicked, or F2 is pressed on the active cell. `event.preventDefault()`
   * keeps the cell inspector closed.
   */
  onCellDoubleClick?: (event: GridCellEvent) => void;
  /**
   * Settings applied when a grid starts (for each new `source`), for example from `getState()` saved
   * earlier. They apply once the table's columns are known.
   */
  initialState?: GridState;
  /** Called with `getState()` when the query or the column settings change. */
  onStateChange?: (state: GridState) => void;
  /**
   * Shows a checkbox for each row, and one for every row in the corner. Checked rows are kept by key
   * (see `rowKey`), so they stay checked when the view is sorted or filtered. Space checks the active
   * row, and Ctrl+Shift+Space (⌘⇧Space on a Mac) every row.
   */
  checkboxSelection?: boolean;
  /**
   * Schema column name whose values identify the rows (a primary key), for checked rows that stay
   * checked when the table is read again with new data. Without it, a row's key is its position in the
   * table, and a new `TableInfo.revision` unchecks every row. Changing it unchecks every row.
   */
  rowKey?: string;
  /**
   * Checked rows to apply: on start, and whenever a different value is passed. Pass back what
   * `onRowSelectionChange` reports to control them. Checked rows are not part of `GridState`.
   */
  rowSelection?: RowSelection;
  /** Called when rows are checked or unchecked, by the user, the app or the grid (see the event's `reason`). */
  onRowSelectionChange?: (event: GridRowSelectionEvent) => void;
  /**
   * Shows the detail panel, with every column of the active row, beside the grid (below it when the
   * grid is narrower than 640px). Set it to control the panel; otherwise Alt+Enter, the context menu
   * and the handle open it.
   */
  detailOpen?: boolean;
  /** Whether the detail panel is open when the grid mounts, when `detailOpen` is not set. */
  defaultDetailOpen?: boolean;
  /** Called when the detail panel is opened or closed by the user or the handle. */
  onDetailOpenChange?: (open: boolean) => void;
  /** Replaces the content of the detail panel. Defaults to the columns' labels and formatted values. */
  detailPanel?: ComponentType<DetailPanelProps>;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export interface DataGridHandle {
  focus(): void;
  reload(): void;
  getQuery(): ViewQuery;
  setQuery(query: ViewQuery): void;
  /** The query and column settings, as JSON to save (see `GridState`). */
  getState(): GridState;
  /** Applies a saved state; returns false when it is not one. Before the columns are known, it waits for them. */
  applyState(state: GridState): boolean;
  /** Scrolls to a row of the current view and makes it active. */
  goToRow(row: number): void;
  /** The checked rows, as keys. */
  getRowSelection(): RowSelection;
  /** Replaces the checked rows; returns false when the value is not a row selection. */
  setRowSelection(selection: RowSelection): boolean;
  /** Opens the export panel (see `exportOptions`), also without the toolbar. Returns false when the source cannot export now. */
  openExport(): boolean;
  /** Opens the detail panel; with `focus`, moves the focus to it. */
  openDetail(options?: { focus?: boolean }): void;
  /** Closes the detail panel. */
  closeDetail(): void;
  /** Whether the detail panel is open. */
  readonly detailOpen: boolean;
  readonly controller: GridController;
  /** The canvas renderer, for diagnostics such as `renderer.timings()`. Null before the grid mounts. */
  readonly renderer: CanvasRenderer | null;
}

type Overlay =
  | { kind: "columnMenu"; col: number; anchor: Anchor }
  | { kind: "contextMenu"; row: number; col: number; anchor: Anchor }
  | { kind: "filter"; column: number; anchor: Anchor }
  | { kind: "stats"; col: number; anchor: Anchor }
  | { kind: "inspector"; row: number; col: number; anchor: Anchor }
  | { kind: "columns"; anchor: Anchor }
  | { kind: "conditions"; anchor: Anchor; draft: FilterDraft }
  | { kind: "export"; anchor: Anchor };

type Drag =
  | { kind: "cells"; pointerId: number; x: number; y: number; row: number; col: number; moved: boolean }
  | { kind: "rows" | "cols"; pointerId: number; x: number; y: number }
  | { kind: "resize"; pointerId: number; col: number; startX: number; startWidth: number }
  | { kind: "move"; pointerId: number; col: number; x: number; y: number; moved: boolean }
  | { kind: "moveGroup"; pointerId: number; first: number; last: number; x: number; y: number; moved: boolean };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

async function writeClipboard(text: Promise<string>, html: Promise<string | null> | null) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error("The clipboard is not available.");
  if (clipboard.write && typeof ClipboardItem !== "undefined") {
    const items: Record<string, Promise<Blob>> = {
      "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
    };
    if (html) items["text/html"] = html.then((value) => new Blob([value ?? ""], { type: "text/html" }));
    await clipboard.write([new ClipboardItem(items)]);
    return;
  }
  await clipboard.writeText(await text);
}

/**
 * A data grid for very large tables. Draws on a canvas, reads rows through a `TableSource` as you
 * scroll, and offers spreadsheet selection and keyboard navigation, copying, sorting, filters,
 * search, column statistics and a selection summary.
 */
export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(props, ref) {
  const {
    source,
    locale,
    rowHeight,
    headerHeight,
    columnGroups,
    groupHeaderHeight,
    maxLines,
    nullText = "",
    frozenColumns = 0,
    toolbar = true,
    statusBar = true,
    reloadKey,
    followTail = false,
    copyLimit = 1_000_000,
    columnFormats,
    copyValues = "raw",
    checkboxSelection = false,
    rowKey,
    rowSelection,
    exportOptions = {},
    onQueryChange,
    className,
    style,
  } = props;
  const resolvedLocale = locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
  const messages = useMemo(
    () => ({ ...messagesFor(resolvedLocale), ...props.messages }),
    [resolvedLocale, props.messages],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const autoScrollRef = useRef(0);
  const cellId = useId();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // One controller per source. Options that can change later are applied in effects below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the other options are applied without recreating the grid.
  const controller = useMemo(() => {
    const grid = new GridController(source, {
      rowHeight: rowHeight ?? 24,
      headerHeight: headerHeight ?? 32,
      columnGroups,
      groupHeaderHeight,
      maxLines,
      locale: resolvedLocale,
      nullText,
      frozenColumns,
      minColumnWidth: 36,
      maxAutoWidth: 360,
      copyLimit,
      columnFormats,
      copyValues,
      checkboxSelection,
      rowKey,
      followTail,
    });
    if (props.initialState) grid.applyState(props.initialState);
    if (rowSelection) grid.setRowSelection(rowSelection);
    return grid;
  }, [source]);
  useSyncExternalStore(controller.subscribe, controller.getVersion, controller.getVersion);

  const count = useMemo(() => countFormat(resolvedLocale), [resolvedLocale]);
  const number = useMemo(() => numberFormat(resolvedLocale), [resolvedLocale]);

  useEffect(() => {
    if (resolvedLocale !== controller.options.locale || nullText !== controller.options.nullText) {
      controller.setFormat(resolvedLocale, nullText);
    }
  }, [controller, resolvedLocale, nullText]);

  useEffect(() => {
    controller.setColumnFormats(columnFormats);
  }, [controller, columnFormats]);

  useEffect(() => {
    controller.setMaxLines(maxLines);
  }, [controller, maxLines]);

  useEffect(() => {
    controller.setColumnGroups(columnGroups);
  }, [controller, columnGroups]);

  useEffect(() => {
    controller.options.copyValues = copyValues;
  }, [controller, copyValues]);

  useEffect(() => {
    controller.setCheckboxSelection(checkboxSelection);
  }, [controller, checkboxSelection]);

  useEffect(() => {
    controller.setRowKey(rowKey);
  }, [controller, rowKey]);

  // A value that equals the checked rows changes nothing, so passing back what was reported is safe.
  useEffect(() => {
    if (rowSelection) controller.setRowSelection(rowSelection);
  }, [controller, rowSelection]);

  useEffect(() => {
    controller.options.followTail = followTail;
  }, [controller, followTail]);

  useEffect(() => {
    controller.options.drawCell = props.drawCell;
    controller.options.cellAction = props.cellAction;
    controller.requestRender();
    controller.emit();
  }, [controller, props.drawCell, props.cellAction]);

  const announce = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Canvas, scrolling, sizes and theme.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    const sizer = sizerRef.current;
    if (!root || !canvas || !scroller || !sizer) return;
    controller.options.rowHeight = rowHeight ?? cssLength(root, "--vg-row-height", 24);
    controller.options.headerHeight = headerHeight ?? cssLength(root, "--vg-header-height", 32);
    controller.setGroupHeaderHeight(groupHeaderHeight ?? cssLength(root, "--vg-group-header-height", 24));
    const renderer = new CanvasRenderer(canvas, controller, resolveTheme(root));
    rendererRef.current = renderer;
    controller.attach(scroller, sizer);
    const stopRender = controller.onRender(() => renderer.schedule());
    const resize = () => controller.setViewport(scroller.clientWidth, scroller.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(scroller);
    const onScroll = () => controller.handleScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Without a text selection, Chromium and Safari disable the copy command unless "beforecopy" is
    // cancelled; then ⌘C and the Edit menu fire "copy", which the grid answers while it has focus.
    const onBeforeCopy = (event: Event) => {
      if (document.activeElement === scroller) event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      if (document.activeElement === scroller) copyHandler.current(event);
    };
    document.addEventListener("beforecopy", onBeforeCopy);
    document.addEventListener("copy", onCopy);
    const refreshTheme = () => renderer.setTheme(resolveTheme(root));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", refreshTheme);
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    void document.fonts?.ready.then(refreshTheme);
    controller.start();
    renderer.schedule();
    return () => {
      controller.stop();
      stopRender();
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      document.removeEventListener("beforecopy", onBeforeCopy);
      document.removeEventListener("copy", onCopy);
      media.removeEventListener("change", refreshTheme);
      themeObserver.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [controller, rowHeight, headerHeight, groupHeaderHeight]);

  // Theme changes through the grid's own class or style.
  // biome-ignore lint/correctness/useExhaustiveDependencies: className and style are the triggers.
  useEffect(() => {
    const root = rootRef.current;
    if (root && rendererRef.current) rendererRef.current.setTheme(resolveTheme(root));
  }, [className, style]);

  const firstReload = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the trigger.
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    controller.reload();
  }, [reloadKey, controller]);

  // Event props are read when an event happens, so that new functions on each render need no new subscription.
  const handlers = useRef(props);
  handlers.current = props;
  useEffect(() => {
    const stops = [
      controller.onSelectionChange((event) => handlers.current.onSelectionChange?.(event)),
      controller.onColumnsChange((event) => handlers.current.onColumnsChange?.(event)),
      controller.onStateChange((state) => handlers.current.onStateChange?.(state)),
      controller.onRowSelectionChange((event) => handlers.current.onRowSelectionChange?.(event)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [controller]);

  // ----- detail panel -----

  const [detailOpenState, setDetailOpenState] = useState(props.defaultDetailOpen ?? false);
  const detailOpen = props.detailOpen ?? detailOpenState;
  const detailOpenRef = useRef(detailOpen);
  detailOpenRef.current = detailOpen;
  const detailRef = useRef<HTMLElement>(null);
  /** Move the focus to the panel once it is shown. */
  const focusDetail = useRef(false);
  /** The focus was in the panel: closing it returns the focus to the grid. */
  const detailFocused = useRef(false);
  const setDetailOpen = useCallback((open: boolean, focus = false) => {
    if (open && focus) {
      if (detailOpenRef.current && detailRef.current) detailRef.current.focus();
      else focusDetail.current = true;
    }
    if (open === detailOpenRef.current) return;
    detailOpenRef.current = open;
    setDetailOpenState(open);
    handlers.current.onDetailOpenChange?.(open);
  }, []);
  useEffect(() => {
    if (detailOpen && focusDetail.current) detailRef.current?.focus();
    focusDetail.current = false;
    if (!detailOpen && detailFocused.current) {
      detailFocused.current = false;
      // The focus was lost with the panel (not moved elsewhere).
      const focused = document.activeElement;
      if (!focused || focused === document.body) scrollerRef.current?.focus({ preventScroll: true });
    }
  }, [detailOpen]);
  const tracker = useMemo(() => new DetailTracker(controller), [controller]);
  useEffect(() => {
    if (!detailOpen) return;
    tracker.start();
    return () => tracker.stop();
  }, [tracker, detailOpen]);
  useSyncExternalStore(tracker.subscribe, tracker.getVersion, tracker.getVersion);

  const lastQuery = useRef(controller.query);
  useEffect(() => {
    if (lastQuery.current !== controller.query) {
      lastQuery.current = controller.query;
      onQueryChange?.(controller.query);
    }
  });

  /** Whether the export panel can open now: the source can export and the host did not hide it. */
  const canExport = useCallback(() => {
    const options = handlers.current.exportOptions ?? {};
    if (options === false) return false;
    const support = exportSupport(controller.info, controller.source.exportView);
    return support !== null && offeredFormats(support, options.formats).length > 0;
  }, [controller]);

  /** Opens the export panel below a button, or at the top right of the grid. */
  const openExport = useCallback(
    (button?: HTMLElement) => {
      if (!canExport() || controller.viewPending) return false;
      const root = rootRef.current?.getBoundingClientRect();
      const rect = button?.getBoundingClientRect();
      setOverlay({
        kind: "export",
        anchor: rect
          ? { x: rect.right - (root?.left ?? 0) - 300, y: rect.top - (root?.top ?? 0), height: rect.height }
          : { x: (root?.width ?? 300) - 304, y: 4 },
      });
      return true;
    },
    [canExport, controller],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => scrollerRef.current?.focus(),
      reload: () => controller.reload(),
      getQuery: () => controller.query,
      setQuery: (query) => void controller.setQuery(query),
      getState: () => controller.getState(),
      applyState: (state) => controller.applyState(state),
      goToRow: (row) => {
        controller.selection.select({ row, col: controller.selection.active.col });
        controller.selectionChanged({ row, col: controller.selection.active.col });
      },
      getRowSelection: () => controller.getRowSelection(),
      setRowSelection: (selection) => controller.setRowSelection(selection),
      openExport: () => openExport(),
      openDetail: (options) => setDetailOpen(true, options?.focus),
      closeDetail: () => setDetailOpen(false),
      get detailOpen() {
        return detailOpenRef.current;
      },
      controller,
      get renderer() {
        return rendererRef.current;
      },
    }),
    [controller, openExport, setDetailOpen],
  );

  // ----- helpers -----

  function local(event: { clientX: number; clientY: number }) {
    const rect = scrollerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  /** A popover anchor at a point of the grid body. */
  function anchorAt(x: number, y: number, height = 0): Anchor {
    const offsetX = bodyRef.current?.offsetLeft ?? 0;
    const offsetY = bodyRef.current?.offsetTop ?? 0;
    return { x: x + offsetX, y: y + offsetY, height };
  }

  function headerAnchor(col: number): Anchor {
    const x = Math.max(controller.gutterWidth, controller.columnX(col));
    return anchorAt(x, 0, controller.headerHeight);
  }

  function cellAnchor(row: number, col: number): Anchor {
    const x = Math.max(controller.gutterWidth, controller.columnX(col));
    const y = Math.max(controller.headerHeight, Math.min(controller.height - 8, controller.rowY(row)));
    return anchorAt(x, y, controller.rowHeight);
  }

  function focusGrid() {
    scrollerRef.current?.focus({ preventScroll: true });
  }

  /** The copy that is reading cells, which Esc or a newer copy cancels. */
  const copyAbort = useRef<AbortController | null>(null);
  useEffect(() => () => copyAbort.current?.abort(), []);
  const copy = useCallback(
    async (options: { headers?: boolean; markdown?: boolean }) => {
      copyAbort.current?.abort();
      const abort = new AbortController();
      copyAbort.current = abort;
      const task = controller.copySelection(options, abort.signal);
      // Say how to cancel when the cells take a moment to read.
      const slow = setTimeout(() => announce(messages.copying), 300);
      try {
        await writeClipboard(
          task.then((result) => result.text),
          options.markdown ? null : task.then((result) => result.html),
        );
        const result = await task;
        announce(messages.copied(count(result.cells)));
      } catch (error) {
        if (abort.signal.aborted) {
          if (copyAbort.current === abort) announce(messages.copyCanceled);
        } else if (error instanceof CopyTooLargeError) announce(messages.copyTooLarge(count(error.limit)));
        else if (error instanceof CopyRangesError) announce(messages.copyRanges);
        else if (error instanceof ViewBuildingError) announce(messages.waitForSort);
        else announce(messages.copyFailed);
      } finally {
        clearTimeout(slow);
        if (copyAbort.current === abort) copyAbort.current = null;
      }
    },
    [announce, controller, count, messages],
  );
  /** Options of a copy started from the keyboard, answered by the browser's own copy event. */
  const pendingCopy = useRef<{ headers?: boolean } | null>(null);
  const copyHandler = useRef<(event: ClipboardEvent) => void>(() => undefined);

  // ----- pointer -----

  function selectMode(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
    if (event.shiftKey) return "extend" as const;
    if (isMac ? event.metaKey : event.ctrlKey) return "add" as const;
    return "replace" as const;
  }

  function dragTo(x: number, y: number) {
    const drag = dragRef.current;
    if (!drag || (drag.kind !== "cells" && drag.kind !== "rows" && drag.kind !== "cols")) return;
    const c = controller;
    const clampedX = Math.min(Math.max(x, c.gutterWidth + 1), c.width - 1);
    const clampedY = Math.min(Math.max(y, c.headerHeight + 1), c.height - 1);
    const col = c.columnAt(clampedX);
    const row = c.rowAt(clampedY);
    if (drag.kind === "rows" && row >= 0) c.selection.selectRows(row, row, "extend");
    else if (drag.kind === "cols" && col >= 0) c.selection.selectCols(col, col, "extend");
    else if (drag.kind === "cells" && row >= 0 && col >= 0) {
      c.selection.select({ row, col }, "extend");
      drag.moved = drag.moved || row !== drag.row || col !== drag.col;
    }
    c.selectionChanged();
  }

  function autoScroll() {
    const drag = dragRef.current;
    if (!drag || (drag.kind !== "cells" && drag.kind !== "rows" && drag.kind !== "cols")) {
      autoScrollRef.current = 0;
      return;
    }
    const c = controller;
    const speed = (distance: number) => Math.sign(distance) * Math.min(80, Math.abs(distance) * 0.6);
    let dx = 0;
    let dy = 0;
    if (drag.y < c.headerHeight) dy = speed(drag.y - c.headerHeight);
    else if (drag.y > c.height) dy = speed(drag.y - c.height);
    if (drag.kind !== "rows") {
      if (drag.x < c.gutterWidth + c.frozenWidth && c.scrollX.position > 0)
        dx = speed(drag.x - c.gutterWidth - c.frozenWidth);
      else if (drag.x > c.width) dx = speed(drag.x - c.width);
    }
    if (dx !== 0 || dy !== 0) {
      c.scrollToVirtual(dx === 0 ? null : c.scrollX.position + dx, dy === 0 ? null : c.scrollY.position + dy);
      dragTo(drag.x, drag.y);
    }
    autoScrollRef.current = requestAnimationFrame(autoScroll);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const scroller = scrollerRef.current;
    if (!scroller || event.button !== 0) return;
    const { x, y } = local(event);
    // Leave the native scrollbars alone.
    if (x > scroller.clientWidth || y > scroller.clientHeight) return;
    focusGrid();
    const c = controller;
    const hit = c.hitTest(x, y);
    const mode = selectMode(event);
    if (hit.resize >= 0) {
      event.preventDefault();
      scroller.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "resize",
        pointerId: event.pointerId,
        col: hit.resize,
        startX: x,
        startWidth: c.layout.width(hit.resize),
      };
      c.resizing = hit.resize;
      c.requestRender();
      return;
    }
    if (hit.menu && hit.col >= 0) {
      event.preventDefault();
      setOverlay({ kind: "columnMenu", col: hit.col, anchor: headerAnchor(hit.col) });
      return;
    }
    if (hit.checkbox) {
      event.preventDefault();
      if (hit.zone === "corner") c.toggleAllRows();
      else c.toggleRow(hit.row, event.shiftKey);
      return;
    }
    switch (hit.zone) {
      case "cell":
        c.selection.select({ row: hit.row, col: hit.col }, mode);
        dragRef.current = { kind: "cells", pointerId: event.pointerId, x, y, row: hit.row, col: hit.col, moved: false };
        break;
      case "header":
        if (mode === "replace" && c.selection.colSelected(hit.col)) {
          dragRef.current = { kind: "move", pointerId: event.pointerId, col: hit.col, x, y, moved: false };
        } else {
          c.selection.selectCols(hit.col, hit.col, mode);
          dragRef.current = { kind: "cols", pointerId: event.pointerId, x, y };
        }
        break;
      case "group": {
        // A group header selects its columns; pressing one whose columns are selected drags them.
        const span = hit.group;
        if (!span) return;
        let selected = mode === "replace";
        for (let col = span.start; col <= span.end && selected; col++) selected = c.selection.colSelected(col);
        if (selected) {
          const { start: first, end: last } = span;
          dragRef.current = { kind: "moveGroup", pointerId: event.pointerId, first, last, x, y, moved: false };
        } else {
          // Shift extends the selection over the whole group, toward the side the group is on.
          if (mode === "extend") {
            const right = span.start > c.selection.active.col;
            c.selection.selectCols(span.start, right ? span.end : span.start, mode);
          } else {
            c.selection.selectCols(span.start, span.end, mode);
          }
          dragRef.current = { kind: "cols", pointerId: event.pointerId, x, y };
        }
        break;
      }
      case "gutter":
        c.selection.selectRows(hit.row, hit.row, mode);
        dragRef.current = { kind: "rows", pointerId: event.pointerId, x, y };
        break;
      case "corner":
        c.selection.selectAll();
        break;
      default:
        return;
    }
    event.preventDefault();
    scroller.setPointerCapture(event.pointerId);
    c.selectionChanged();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { x, y } = local(event);
    const c = controller;
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (drag.kind === "resize") {
        c.resizeColumn(drag.col, drag.startWidth + (x - drag.startX));
        return;
      }
      if (drag.kind === "move" || drag.kind === "moveGroup") {
        drag.moved = drag.moved || Math.abs(x - drag.x) > 4;
        drag.x = x;
        drag.y = y;
        scroller.style.cursor = drag.moved ? "grabbing" : "";
        return;
      }
      drag.x = x;
      drag.y = y;
      dragTo(x, y);
      if (!autoScrollRef.current) autoScrollRef.current = requestAnimationFrame(autoScroll);
      return;
    }
    const hit: Hit =
      x > scroller.clientWidth || y > scroller.clientHeight
        ? { zone: "outside", row: -1, col: -1, resize: -1, menu: false, checkbox: false }
        : c.hitTest(x, y);
    const previous = c.hover;
    c.hover = hit;
    let cursor = hit.resize >= 0 ? "col-resize" : hit.menu || hit.checkbox ? "pointer" : "";
    if (!cursor && hit.zone === "cell" && c.options.cellAction) {
      const action = c.cellActionAt(hit.row, hit.col);
      if (action) cursor = action.cursor ?? "pointer";
    }
    scroller.style.cursor = cursor;
    if (
      previous?.zone !== hit.zone ||
      previous.col !== hit.col ||
      previous.menu !== hit.menu ||
      previous.checkbox !== hit.checkbox ||
      previous.group !== hit.group ||
      (hit.checkbox && previous.row !== hit.row) ||
      // A drawCell hook may draw the hovered cell differently.
      (c.options.drawCell && previous.row !== hit.row)
    )
      c.requestRender();
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = 0;
    const scroller = scrollerRef.current;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    if (scroller) scroller.style.cursor = "";
    const c = controller;
    if (drag.kind === "resize") {
      c.finishResize();
    } else if (drag.kind === "cells") {
      // A click: pressed and released on the same cell.
      const { x, y } = local(event);
      const hit = c.hitTest(x, y);
      if (
        event.type === "pointerup" &&
        !drag.moved &&
        hit.zone === "cell" &&
        hit.row === drag.row &&
        hit.col === drag.col
      ) {
        props.onCellClick?.(c.cellEvent(hit.row, hit.col, "pointer", event));
      }
    } else if (drag.kind === "move") {
      const target = c.columnAt(local(event).x);
      if (drag.moved && target >= 0 && target !== drag.col) {
        c.moveColumn(drag.col, target);
        c.selection.selectCols(target, target);
        c.selectionChanged();
      } else if (!drag.moved) {
        c.selection.selectCols(drag.col, drag.col);
        c.selectionChanged();
      }
    } else if (drag.kind === "moveGroup") {
      const { first, last } = drag;
      const target = c.columnAt(local(event).x);
      if (drag.moved && target >= 0 && (target < first || target > last)) {
        c.moveColumns(first, last, target);
        // The columns now end at the target when moved right, and start there when moved left.
        const start = target > last ? target - (last - first) : target;
        c.selection.selectCols(start, start + last - first);
        c.selectionChanged();
      } else if (!drag.moved) {
        c.selection.selectCols(first, last);
        c.selectionChanged();
      }
    }
  }

  function onPointerLeave() {
    if (controller.hover && !dragRef.current) {
      controller.hover = null;
      controller.requestRender();
    }
  }

  function onDoubleClick(event: MouseEvent<HTMLDivElement>) {
    const { x, y } = local(event);
    const hit = controller.hitTest(x, y);
    if (hit.checkbox) return;
    if (hit.resize >= 0) {
      controller.autoFit(hit.resize);
      controller.emit();
    } else if (hit.zone === "cell") {
      const cellEvent = controller.cellEvent(hit.row, hit.col, "pointer", event);
      props.onCellDoubleClick?.(cellEvent);
      if (!cellEvent.defaultPrevented) {
        setOverlay({ kind: "inspector", row: hit.row, col: hit.col, anchor: cellAnchor(hit.row, hit.col) });
      }
    }
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    const { x, y } = local(event);
    const c = controller;
    const hit = c.hitTest(x, y);
    if (hit.zone === "header") {
      event.preventDefault();
      setOverlay({ kind: "columnMenu", col: hit.col, anchor: anchorAt(x, y) });
      return;
    }
    if (hit.zone !== "cell") return;
    event.preventDefault();
    if (!c.selection.contains(hit.row, hit.col)) {
      c.selection.select({ row: hit.row, col: hit.col });
      c.selectionChanged();
    }
    setOverlay({ kind: "contextMenu", row: hit.row, col: hit.col, anchor: anchorAt(x, y) });
  }

  // ----- keyboard -----

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== scrollerRef.current) return;
    const c = controller;
    const detailAction = detailKeyAction(event, "grid", detailOpen);
    if (detailAction === "open" || detailAction === "focusPanel") {
      event.preventDefault();
      setDetailOpen(true, detailAction === "focusPanel");
      return;
    }
    const primary = isMac ? event.metaKey : event.ctrlKey;
    const extend = event.shiftKey;
    const lastRow = Math.max(0, c.rowCount - 1);
    const lastCol = Math.max(0, c.visible.length - 1);
    const focus = extend ? c.selection.focus : c.selection.active;
    let target: { row: number; col: number } | null = null;
    switch (event.key) {
      case "ArrowDown":
        if (event.altKey) {
          setOverlay({ kind: "columnMenu", col: c.selection.active.col, anchor: headerAnchor(c.selection.active.col) });
          break;
        }
        target = c.selection.moveTo({ row: primary ? lastRow : focus.row + 1, col: focus.col }, extend);
        break;
      case "ArrowUp":
        target = c.selection.moveTo({ row: primary ? 0 : focus.row - 1, col: focus.col }, extend);
        break;
      case "ArrowRight":
        target = c.selection.moveTo({ row: focus.row, col: primary ? lastCol : focus.col + 1 }, extend);
        break;
      case "ArrowLeft":
        target = c.selection.moveTo({ row: focus.row, col: primary ? 0 : focus.col - 1 }, extend);
        break;
      case "PageDown":
        target = event.altKey
          ? c.selection.moveTo({ row: focus.row, col: focus.col + 5 }, extend)
          : c.selection.moveTo({ row: focus.row + c.pageRows, col: focus.col }, extend);
        break;
      case "PageUp":
        target = event.altKey
          ? c.selection.moveTo({ row: focus.row, col: focus.col - 5 }, extend)
          : c.selection.moveTo({ row: focus.row - c.pageRows, col: focus.col }, extend);
        break;
      case "Home":
        target = c.selection.moveTo({ row: event.ctrlKey || event.metaKey ? 0 : focus.row, col: 0 }, extend);
        break;
      case "End":
        target = c.selection.moveTo(
          { row: event.ctrlKey || event.metaKey ? lastRow : focus.row, col: lastCol },
          extend,
        );
        break;
      case "Tab":
        target = c.selection.advance(0, event.shiftKey ? -1 : 1);
        break;
      case "Enter":
        target = c.selection.advance(event.shiftKey ? -1 : 1, 0);
        break;
      case " ":
        if (checkboxSelection && primary && event.shiftKey) {
          c.toggleAllRows();
          announceChecked(null);
          break;
        }
        if (event.shiftKey) c.selection.selectRows(c.selection.active.row, c.selection.active.row);
        else if (event.ctrlKey) c.selection.selectCols(c.selection.active.col, c.selection.active.col);
        else if (
          (props.onCellClick || checkboxSelection) &&
          !event.altKey &&
          !event.metaKey &&
          c.rowCount > 0 &&
          c.visible.length > 0
        ) {
          // Space clicks the active cell, and then checks its row, unless the cell is a link or a button
          // (`cellAction`), which Space activates. Without either, it is left to the browser.
          const { row, col } = c.selection.active;
          const cellEvent = c.cellEvent(row, col, "keyboard", event);
          props.onCellClick?.(cellEvent);
          if (checkboxSelection && !cellEvent.defaultPrevented && !c.cellActionAt(row, col) && c.toggleRow(row)) {
            announceChecked(c.selection.active.row);
          }
          break;
        } else return;
        c.selectionChanged();
        break;
      case "F2": {
        if (c.rowCount > 0 && c.visible.length > 0) {
          const cellEvent = c.cellEvent(c.selection.active.row, c.selection.active.col, "keyboard", event);
          props.onCellDoubleClick?.(cellEvent);
          if (cellEvent.defaultPrevented) break;
        }
        setOverlay({
          kind: "inspector",
          ...c.selection.active,
          anchor: cellAnchor(c.selection.active.row, c.selection.active.col),
        });
        break;
      }
      case "Escape":
        if (copyAbort.current) copyAbort.current.abort();
        else if (findOpen) setFindOpen(false);
        else if (!c.selection.single) {
          c.selection.select(c.selection.active);
          c.selectionChanged();
        } else if (detailAction === "close") setDetailOpen(false);
        else return;
        break;
      case "ContextMenu":
        setOverlay({
          kind: "contextMenu",
          ...c.selection.active,
          anchor: cellAnchor(c.selection.active.row, c.selection.active.col),
        });
        break;
      default:
        if (primary && event.key.toLowerCase() === "a") {
          c.selection.selectAll();
          c.selectionChanged();
        } else if (primary && event.key.toLowerCase() === "c") {
          // Let the browser run its own copy command: it needs no clipboard permission, and onCopy answers
          // it with the loaded cells. Shortcuts the browser does not treat as copying fall back below.
          const options = { headers: event.shiftKey };
          pendingCopy.current = options;
          setTimeout(() => {
            if (pendingCopy.current !== options) return;
            pendingCopy.current = null;
            void copy(options);
          }, 0);
          return;
        } else if (primary && event.key.toLowerCase() === "f") {
          if (c.info?.capabilities.find) setFindOpen(true);
        } else if (event.shiftKey && event.key === "F10") {
          setOverlay({
            kind: "contextMenu",
            ...c.selection.active,
            anchor: cellAnchor(c.selection.active.row, c.selection.active.col),
          });
        } else {
          return;
        }
    }
    event.preventDefault();
    if (target) c.selectionChanged(target);
  }

  /** Tells screen readers the new state of a row's checkbox, or of every row's with `null`. */
  function announceChecked(row: number | null) {
    const c = controller;
    if (row === null) {
      const checked = c.checkedCount;
      announce(
        c.rowSelection.empty ? messages.rowsUnchecked : messages.rowsChecked(checked === null ? null : count(checked)),
      );
      return;
    }
    const label = count(row + 1);
    announce(c.rowChecked(row) ? messages.rowChecked(label) : messages.rowUnchecked(label));
  }

  /** The browser's own copy command (Edit menu): answer synchronously when the cells are loaded. */
  /**
   * The browser's copy command (⌘C, or Copy in the app's Edit menu) while the grid has focus. Loaded
   * cells are written here, synchronously, which needs no clipboard permission; larger selections are
   * read first and written with the asynchronous clipboard API.
   */
  copyHandler.current = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    const options = pendingCopy.current ?? {};
    pendingCopy.current = null;
    const result = controller.copySelectionSync(options);
    if (result) {
      // A copy that is still reading would overwrite this one when it finishes.
      const running = copyAbort.current;
      copyAbort.current = null;
      running?.abort();
      event.clipboardData.setData("text/plain", result.text);
      if (result.html) event.clipboardData.setData("text/html", result.html);
      announce(messages.copied(count(result.cells)));
    } else {
      void copy(options);
    }
  };

  // ----- menus -----

  const c = controller;
  const capabilities = c.info?.capabilities;
  const ready = c.info?.status === "ready";

  function columnMenuItems(col: number): MenuItem[] {
    const state = c.visible[col];
    const schema = c.columnSchema(col);
    if (!state || !schema) return [];
    const sort = c.sortOf(state.index);
    const otherSorts = (c.query.sort ?? []).filter((key) => key.column !== state.index).length > 0;
    const items: MenuItem[] = [
      {
        label: messages.sortAscending,
        onSelect: () => c.sortBy(col, "asc"),
        disabled: !ready || !capabilities?.sort,
        checked: sort?.direction === "asc" && !otherSorts,
      },
      {
        label: messages.sortDescending,
        onSelect: () => c.sortBy(col, "desc"),
        disabled: !ready || !capabilities?.sort,
        checked: sort?.direction === "desc" && !otherSorts,
      },
    ];
    if ((c.query.sort?.length ?? 0) > 0 && !(sort && !otherSorts)) {
      items.push(
        { label: messages.addSortAscending, onSelect: () => c.sortBy(col, "asc", true), disabled: !ready },
        { label: messages.addSortDescending, onSelect: () => c.sortBy(col, "desc", true), disabled: !ready },
      );
    }
    if ((c.query.sort?.length ?? 0) > 0) items.push({ label: messages.clearSort, onSelect: () => c.clearSort() });
    items.push(
      {
        label: messages.filter,
        separator: true,
        disabled: !ready || !capabilities?.filter,
        onSelect: () => setOverlay({ kind: "filter", column: state.index, anchor: headerAnchor(col) }),
      },
      {
        label: messages.statistics,
        disabled: !ready || !capabilities?.stats || !c.statsAvailable,
        onSelect: () => setOverlay({ kind: "stats", col, anchor: headerAnchor(col) }),
      },
      {
        label: messages.autoFit,
        separator: true,
        onSelect: () => {
          c.autoFit(col);
          c.emit();
        },
      },
      col < c.frozen && c.frozen > 0
        ? { label: messages.unfreeze, onSelect: () => c.freezeUpTo(-1) }
        : { label: messages.freezeUpTo, onSelect: () => c.freezeUpTo(col) },
      { label: messages.hideColumn, disabled: c.visible.length <= 1, onSelect: () => c.hideColumn(col) },
      {
        label: messages.copyColumnName,
        onSelect: () =>
          void writeClipboard(Promise.resolve(schema.name), null).then(
            () => announce(messages.copied("1")),
            (error: unknown) => announce(error instanceof Error ? error.message : String(error)),
          ),
      },
    );
    return items;
  }

  function contextMenuItems(row: number, col: number): MenuItem[] {
    const state = c.visible[col];
    const value: CellValue | undefined = c.value(row, col);
    const items: MenuItem[] = [
      { label: messages.copy, shortcut: isMac ? "⌘C" : "Ctrl+C", onSelect: () => void copy({}) },
      {
        label: messages.copyWithHeaders,
        shortcut: isMac ? "⇧⌘C" : "Ctrl+Shift+C",
        onSelect: () => void copy({ headers: true }),
      },
      { label: messages.copyAsMarkdown, onSelect: () => void copy({ markdown: true }) },
    ];
    if (state && value !== undefined) {
      items.push(
        {
          label: messages.filterToValue,
          separator: true,
          disabled: !ready || !capabilities?.filter,
          onSelect: () => void c.filterByValue(row, col),
        },
        {
          label: messages.excludeValue,
          disabled: !ready || !capabilities?.filter,
          onSelect: () => void c.filterByValue(row, col, true),
        },
      );
    }
    items.push(
      {
        label: messages.sortAscending,
        separator: true,
        disabled: !ready || !capabilities?.sort,
        onSelect: () => c.sortBy(col, "asc"),
      },
      {
        label: messages.sortDescending,
        disabled: !ready || !capabilities?.sort,
        onSelect: () => c.sortBy(col, "desc"),
      },
      {
        label: messages.inspectCell,
        separator: true,
        shortcut: "F2",
        onSelect: () => setOverlay({ kind: "inspector", row, col, anchor: cellAnchor(row, col) }),
      },
      {
        label: messages.showDetail,
        shortcut: isMac ? "⌥↩" : "Alt+Enter",
        checked: detailOpen,
        onSelect: () => setDetailOpen(!detailOpen),
      },
    );
    return items;
  }

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const loadDistinct = useCallback(
    (search: string, signal: AbortSignal) =>
      overlay?.kind === "filter" ? controller.distinct(overlay.column, search, signal) : null,
    [controller, overlay],
  );
  const loadStats = useCallback(
    (signal: AbortSignal) => (overlay?.kind === "stats" ? controller.stats(overlay.col, signal) : null),
    [controller, overlay],
  );
  const loadCell = useCallback(
    (signal: AbortSignal) =>
      overlay?.kind === "inspector" ? controller.fullValue(overlay.row, overlay.col, signal) : Promise.resolve(null),
    [controller, overlay],
  );

  // ----- accessibility -----

  const active = c.selection.active;
  const activeSchema = c.columnSchema(active.col);
  const activeValue = c.value(active.row, active.col);
  const activeIndex = c.visible[active.col]?.index;
  const activeText =
    activeValue === undefined || activeIndex === undefined
      ? messages.loading
      : activeValue === null
        ? messages.blank
        : c.formatterOf(activeIndex).text(activeValue);
  const allChecked = c.allRowsChecked;
  const activeChecked = c.rowChecked(active.row);
  const activeAction = c.cellActionAt(active.row, active.col);
  const activeDescription = c.cellStyleAt(active.row, active.col)?.description;
  const labelOf = (col: number) => {
    const state = c.visible[col];
    return state ? c.columnLabel(state.index) : "";
  };
  // Header rows of groups come first: the row of column names is row `groupRows + 1`.
  const groupRows = c.groupRows;
  const activeGroups = activeSchema ? c.groupsOf(active.col) : [];

  const record = detailOpen ? tracker.record : null;
  const detailProps: DetailPanelProps | null = record && {
    row: record.row,
    rowId: record.rowId,
    values: record.values,
    schema: c.schema,
    status: record.status,
    error: record.error,
    fields: c.columns.map((state) => {
      const value = record.values[state.index];
      return {
        column: state.index,
        name: c.schema[state.index]?.name ?? "",
        label: c.columnLabel(state.index),
        hidden: state.hidden,
        value,
        text: value === undefined ? "" : c.formatterOf(state.index).text(value),
      };
    }),
    retry: () => tracker.retry(),
    messages,
  };
  const detailTitle = record
    ? record.rowId !== null && record.rowId !== record.row
      ? `${messages.detailTitle(count(record.row + 1))} · ${messages.originalRow(count(record.rowId + 1))}`
      : messages.detailTitle(count(record.row + 1))
    : messages.detailLabel;

  let overlayMessage: string | null = null;
  if (c.loadError) overlayMessage = `${messages.error} ${c.loadError}`;
  else if (c.info?.status === "error") overlayMessage = `${messages.error} ${c.info.error ?? ""}`;
  else if (c.viewError) overlayMessage = c.viewError;
  else if (!c.info || (c.info.status === "loading" && c.readableRows === 0)) overlayMessage = messages.loading;
  else if (c.rowCount === 0 && !c.viewPending) overlayMessage = messages.noRows;
  // Retrying reads the table again after a load error, and builds the view again after a view error.
  const retry =
    c.loadError || c.info?.status === "error"
      ? () => controller.reload()
      : c.viewError
        ? () => void controller.setQuery(controller.query)
        : null;

  return (
    <div ref={rootRef} className={`vg-root${className ? ` ${className}` : ""}`} style={style} data-status={c.status}>
      {toolbar && (
        <Toolbar
          controller={c}
          messages={messages}
          onConditions={(button) => {
            const root = rootRef.current?.getBoundingClientRect();
            const rect = button.getBoundingClientRect();
            setOverlay({
              kind: "conditions",
              anchor: { x: rect.left - (root?.left ?? 0), y: rect.top - (root?.top ?? 0), height: rect.height },
              draft: initialDraft(c.condition, c.schema),
            });
          }}
          onColumns={(button) => {
            const root = rootRef.current?.getBoundingClientRect();
            const rect = button.getBoundingClientRect();
            setOverlay({
              kind: "columns",
              anchor: { x: rect.right - (root?.left ?? 0) - 260, y: rect.top - (root?.top ?? 0), height: rect.height },
            });
          }}
          onExport={canExport() ? (button) => openExport(button) : undefined}
        />
      )}
      {(c.viewPending || c.viewBuilding || c.info?.status === "loading") && (
        <div
          className="vg-progress"
          role="progressbar"
          aria-label={messages.loading}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={c.info?.progress ? Math.round(c.info.progress * 100) : undefined}
        >
          <span
            style={
              c.info?.progress && !c.viewPending && !c.viewBuilding
                ? { width: `${Math.round(c.info.progress * 100)}%` }
                : undefined
            }
            data-indeterminate={c.viewPending || c.viewBuilding || !c.info?.progress || undefined}
          />
        </div>
      )}
      <div
        ref={bodyRef}
        className="vg-body"
        data-detail={detailOpen || undefined}
        style={groupRows > 0 ? ({ "--vg-header-total": `${c.headerHeight}px` } as CSSProperties) : undefined}
      >
        <canvas ref={canvasRef} className="vg-canvas" />
        {/* biome-ignore lint/a11y/useSemanticElements: a canvas grid cannot use table elements; ARIA grid roles describe it. */}
        <div
          ref={scrollerRef}
          className="vg-scroller"
          role="grid"
          tabIndex={0}
          aria-label={props["aria-label"] ?? messages.gridLabel}
          aria-rowcount={c.rowCount + groupRows + 1}
          aria-colcount={c.visible.length + 1}
          aria-multiselectable="true"
          aria-activedescendant={c.rowCount > 0 && activeSchema ? cellId : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        >
          <div ref={sizerRef} className="vg-sizer" />
          {/*
            The canvas has no accessible content. Screen readers follow the active cell through
            aria-activedescendant on the grid; these hidden elements describe that cell and its column.
            Focus stays on the grid, so the rows and cells are not focusable themselves.
          */}
          {activeSchema && c.rowCount > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas (see above).
            <div className="vg-sr-only" role="rowgroup">
              {activeGroups.map((span) => (
                // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
                <div role="row" aria-rowindex={span.level + 1} key={span.level}>
                  {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
                  {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
                  <div role="columnheader" aria-colindex={span.start + 2} aria-colspan={span.end - span.start + 1}>
                    {span.group.name}
                  </div>
                </div>
              ))}
              {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
              <div role="row" aria-rowindex={groupRows + 1}>
                {checkboxSelection && (
                  // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
                  // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
                  <div role="columnheader" aria-colindex={1}>
                    {/* biome-ignore lint/a11y/useSemanticElements: the checkbox is drawn on the canvas. */}
                    {/* biome-ignore lint/a11y/useFocusableInteractive: Ctrl+Shift+Space toggles it from the grid. */}
                    <span role="checkbox" aria-checked={allChecked} aria-label={messages.checkAllRows} />
                  </div>
                )}
                {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
                <div role="columnheader" aria-colindex={active.col + 2}>
                  {labelOf(active.col)}
                </div>
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
              <div
                role="row"
                aria-rowindex={active.row + groupRows + 2}
                aria-selected={checkboxSelection && activeChecked !== null ? activeChecked : undefined}
              >
                {checkboxSelection && (
                  // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
                  // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
                  <div role="rowheader" aria-colindex={1}>
                    {/* biome-ignore lint/a11y/useSemanticElements: the checkbox is drawn on the canvas. */}
                    {/* biome-ignore lint/a11y/useFocusableInteractive: Space toggles it from the grid. */}
                    <span
                      role="checkbox"
                      aria-checked={activeChecked ?? false}
                      aria-disabled={activeChecked === null || undefined}
                      aria-label={messages.checkRow(count(active.row + 1))}
                    />
                  </div>
                )}
                {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
                <div role="gridcell" id={cellId} aria-colindex={active.col + 2} aria-selected="true">
                  {/* Focus stays on the grid, and Space activates the cell (see cell-render.ts). */}
                  {activeAction?.kind === "link" ? (
                    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
                    // biome-ignore lint/a11y/useSemanticElements: the link is drawn on the canvas; the app opens it.
                    <span
                      role="link"
                      aria-label={activeAction.label}
                      aria-keyshortcuts={props.onCellClick ? "Space" : undefined}
                    >
                      {activeText}
                    </span>
                  ) : activeAction?.kind === "button" ? (
                    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
                    // biome-ignore lint/a11y/useSemanticElements: the button is drawn on the canvas.
                    <span
                      role="button"
                      aria-label={activeAction.label}
                      aria-keyshortcuts={props.onCellClick ? "Space" : undefined}
                    >
                      {activeText}
                    </span>
                  ) : (
                    activeText
                  )}
                  {activeDescription ? `, ${activeDescription}` : null}
                </div>
              </div>
            </div>
          )}
        </div>
        {overlayMessage && (
          <div
            className="vg-message"
            role={c.loadError || c.viewError || c.info?.status === "error" ? "alert" : "status"}
          >
            <span>{overlayMessage}</span>
            {retry && (
              <button type="button" className="vg-button" onClick={retry}>
                {messages.retry}
              </button>
            )}
          </div>
        )}
        {findOpen && (
          <FindBar
            messages={messages}
            initial={c.findText}
            onFind={(text, direction, caseSensitive, signal) => controller.find(text, direction, caseSensitive, signal)}
            onClose={() => {
              setFindOpen(false);
              controller.findText = "";
              controller.requestRender();
              focusGrid();
            }}
          />
        )}
        {notice && (
          <div className="vg-toast" role="status">
            {notice}
          </div>
        )}
        {detailOpen && (
          <DetailPanel
            ref={detailRef}
            title={detailTitle}
            messages={messages}
            content={props.detailPanel ?? DetailFields}
            props={detailProps}
            onFocus={() => {
              detailFocused.current = true;
            }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && !event.currentTarget.contains(next)) detailFocused.current = false;
            }}
            onClose={() => {
              setDetailOpen(false);
              focusGrid();
            }}
            onKeyDown={(event) => {
              const action = detailKeyAction(event, "panel", true);
              if (!action) return;
              event.preventDefault();
              if (action === "close") setDetailOpen(false);
              focusGrid();
            }}
          />
        )}
      </div>
      {statusBar && <StatusBar controller={c} messages={messages} />}
      {overlay?.kind === "columnMenu" && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={labelOf(overlay.col)}
          role="menu"
        >
          <MenuList items={columnMenuItems(overlay.col)} onClose={closeOverlay} />
        </Popover>
      )}
      {overlay?.kind === "contextMenu" && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={messages.copy}
          role="menu"
        >
          <MenuList items={contextMenuItems(overlay.row, overlay.col)} onClose={closeOverlay} />
        </Popover>
      )}
      {overlay?.kind === "filter" && c.schema[overlay.column] && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={messages.filterBy(c.columnLabel(overlay.column))}
          className="vg-popover--panel"
        >
          <FilterPanel
            column={overlay.column}
            schema={c.schema[overlay.column]}
            filter={c.filterOf(overlay.column)}
            messages={messages}
            formatter={c.formatterOf(overlay.column)}
            count={count}
            load={loadDistinct}
            inConditions={filterLeaves(c.query.where).some((filter) => filter.column === overlay.column)}
            onApply={(filter) => {
              c.setFilter(overlay.column, filter);
              setOverlay(null);
              focusGrid();
            }}
            // Sources that cannot run condition trees offer only the column's own filter.
            onCombine={
              c.info?.capabilities.conditions
                ? (filter, type) =>
                    setOverlay({
                      kind: "conditions",
                      anchor: overlay.anchor,
                      draft: initialDraft(c.condition, c.schema, { column: overlay.column, filter, type }),
                    })
                : undefined
            }
            onEditConditions={() =>
              setOverlay({ kind: "conditions", anchor: overlay.anchor, draft: initialDraft(c.condition, c.schema) })
            }
          />
        </Popover>
      )}
      {overlay?.kind === "conditions" && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={messages.conditionsTitle}
          className="vg-popover--panel vg-popover--builder"
        >
          <FilterBuilder
            schema={c.schema}
            initial={overlay.draft}
            messages={messages}
            formatterOf={(column) => c.formatterOf(column)}
            onApply={(condition) => {
              void c.setCondition(condition);
              setOverlay(null);
              focusGrid();
            }}
            onCancel={closeOverlay}
          />
        </Popover>
      )}
      {overlay?.kind === "stats" && c.columnSchema(overlay.col) && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={messages.statistics}
          className="vg-popover--panel"
        >
          <StatsPanel
            schema={c.columnSchema(overlay.col) as NonNullable<ReturnType<typeof c.columnSchema>>}
            messages={messages}
            formatter={c.formatterOf(c.visible[overlay.col].index)}
            count={count}
            number={number}
            load={loadStats}
          />
        </Popover>
      )}
      {overlay?.kind === "inspector" && c.columnSchema(overlay.col) && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          returnFocus={scrollerRef}
          label={messages.inspectCell}
          className="vg-popover--panel vg-popover--wide"
        >
          <CellInspector
            formatter={c.formatterOf(c.visible[overlay.col].index)}
            messages={messages}
            location={messages.cell(count(overlay.row + 1), labelOf(overlay.col))}
            load={loadCell}
            onCopy={(text) =>
              void writeClipboard(Promise.resolve(text), null).then(
                () => announce(messages.copied("1")),
                (error: unknown) => announce(error instanceof Error ? error.message : String(error)),
              )
            }
          />
        </Popover>
      )}
      {overlay?.kind === "export" && exportOptions !== false && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          label={messages.export}
          className="vg-popover--panel vg-popover--export"
        >
          <ExportPanel controller={c} messages={messages} options={exportOptions} count={count} onDone={announce} />
        </Popover>
      )}
      {overlay?.kind === "columns" && (
        <Popover
          anchor={overlay.anchor}
          container={rootRef}
          onClose={closeOverlay}
          label={messages.columns}
          className="vg-popover--panel"
        >
          <ColumnsPanel
            columns={c.columns}
            schema={c.schema}
            labelOf={(index) => c.columnLabel(index)}
            messages={messages}
            onToggle={(index, hidden) => c.setColumnHidden(index, hidden)}
            onShowAll={() => c.showAllColumns()}
          />
        </Popover>
      )}
    </div>
  );
});
