import {
  type KeyboardEvent,
  lazy,
  type MouseEvent,
  type RefObject,
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { browser } from "react-dom";
import { CommandError, type GridCommand, parseTsv, type RowKey } from "vastgrid-spec";
import { GridCanvas } from "../canvas/grid-canvas.js";
import type { CellAction, CellHooks, ColumnGroup, GridCell } from "../canvas/hooks.js";
import { isApple, type KeyInput, keyCommand, typesText } from "../canvas/keys.js";
import { checkedCount, checkState } from "../core/checked.js";
import type { GridStore } from "../core/store.js";
import { AccessibleRows, cellId } from "./accessible-rows.js";
import { CellEditor, type EditorControl } from "./cell-editor.js";
import type { CellMenuTarget } from "./cell-menu.js";
import type { ViewerTarget } from "./value-viewer.js";
import type { MenuTarget } from "./column-menu.js";
import { LocaleContext, SaveContext } from "./context.js";
import { useGridPointer } from "./grid-pointer.js";
import { useGridSelector, useGridStore } from "./hooks.js";

// The menus load when they first open (§10 of react.md).
const ColumnMenu = lazy(() => import("./column-menu.js").then((module) => ({ default: module.ColumnMenu })));
const CellMenu = lazy(() => import("./cell-menu.js").then((module) => ({ default: module.CellMenu })));

/** The members of a keyboard event that the grid's keys read. */
function pick(event: KeyInput): KeyInput {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  };
}

/** Writes the output of `copy` (§6.6) into a clipboard. */
function writeClipboard(data: DataTransfer, output: unknown) {
  const { tsv, html } = output as { tsv: string; html: string };
  data.setData("text/plain", tsv);
  data.setData("text/html", html);
}

async function writeClipboardLater(output: unknown) {
  const { tsv, html } = output as { tsv: string; html: string };
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return;
  if (typeof ClipboardItem === "function" && clipboard.write) {
    await clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } else {
    await clipboard.writeText(tsv);
  }
}

/** Copies the selection: at once when its rows are read, after reading them otherwise. */
function useClipboard(store: GridStore, scroller: RefObject<HTMLDivElement | null>, announce: (text: string) => void) {
  const { messages, locale, number } = use(LocaleContext);
  const report = useEffectEvent((output: unknown, failure: string | null) => {
    announce(failure === null ? messages.copied(number.format(countCells(output))) : messages.failed(failure));
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Without selected text, browsers disable copying unless "beforecopy" is cancelled.
    const onBeforeCopy = (event: Event) => {
      if (document.activeElement === element) event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      if (document.activeElement !== element || !event.clipboardData) return;
      event.preventDefault();
      const outcome = store.dispatchSync({ command: "copy" }, { locale });
      if (outcome.ok) {
        writeClipboard(event.clipboardData, outcome.output);
        report(outcome.output, null);
        return;
      }
      if (!(outcome.error instanceof CommandError) || outcome.error.reason !== "not_loaded") {
        report(null, outcome.error.message);
        return;
      }
      // The rows are read first; the clipboard is then written through the asynchronous API.
      void store.dispatch({ command: "copy" }, { locale }).then(async (later) => {
        if (!later.ok) {
          report(null, later.error.message);
          return;
        }
        await writeClipboardLater(later.output);
        report(later.output, null);
      });
    };
    document.addEventListener("beforecopy", onBeforeCopy);
    // Pasting writes the clipboard into the selection (§6.5.1).
    const onPaste = (event: ClipboardEvent) => {
      if (document.activeElement !== element || !event.clipboardData) return;
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      const clipboard = text ? { text } : html ? { html } : {};
      void store.dispatch({ command: "edit.paste" }, { clipboard }).then((outcome) => {
        if (!outcome.ok) report(null, outcome.error.message);
      });
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("beforecopy", onBeforeCopy);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [store, scroller, locale]);
}

/** The cells of a copy: its TSV's fields. */
export function countCells(output: unknown) {
  const { tsv } = output as { tsv: string };
  return parseTsv(tsv).reduce((count, row) => count + row.length, 0);
}

/** A click or Space on a cell that is a link or a button (`cellAction`). */
export interface CellActionEvent extends GridCell {
  action: CellAction;
  /** The key of the cell's row (§5.3), when it is read. */
  key: RowKey | undefined;
}

export interface GridBodyProps {
  rowHeight?: number;
  headerHeight?: number;
  /** A check box for each row in the gutter (§5.2.1 of the specification). */
  checkboxes?: boolean;
  columnGroups?: readonly ColumnGroup[];
  groupHeaderHeight?: number;
  wrapLines?: number;
  hooks: CellHooks;
  onCellAction?: (event: CellActionEvent) => void;
  /** Opens the find bar (⌘F or Ctrl+F). */
  onFind?: () => void;
  /** Opens a value in the viewer (the cell menu's Show full value). */
  onView: (target: ViewerTarget) => void;
  label: string;
  /** Receives the scroller, which has the focus of the grid. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  announce: (text: string) => void;
}

/**
 * The canvas and the scroller over it (§6 of react.md): keys and pointers become commands, the canvas draws
 * the store without rendering React, and the accessibility rows follow when scrolling pauses. Rendered only in
 * the browser: on the server, the nearest Suspense boundary sends its fallback, the first rows as HTML.
 */
export function GridBody({
  rowHeight,
  headerHeight,
  checkboxes = false,
  columnGroups,
  groupHeaderHeight,
  wrapLines,
  hooks,
  onCellAction,
  onFind,
  onView,
  label,
  scrollerRef,
  announce,
}: GridBodyProps) {
  use(browser("The grid draws on a canvas, which only the browser has."));
  const store = useGridStore();
  const [canvas] = useState(() => new GridCanvas({ rowHeight, headerHeight }));
  const { geometry } = canvas;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorControl>(null);
  const { messages, locale, number } = use(LocaleContext);
  const saving = use(SaveContext);
  const id = useId();
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const columns = useGridSelector((snapshot) => snapshot.displayed);
  const busy = useGridSelector((snapshot) => snapshot.view === null || snapshot.pending !== null);
  const active = useGridSelector((snapshot) => snapshot.session.active);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const totalsRow = useGridSelector(
    (snapshot) =>
      !snapshot.document.plan?.aggregate && snapshot.displayed.some((item) => item.setting.total !== undefined),
  );
  const [cellMenu, setCellMenu] = useState<CellMenuTarget | null>(null);

  useLayoutEffect(() => {
    canvas.setSizes(rowHeight, headerHeight);
  }, [canvas, rowHeight, headerHeight]);

  useLayoutEffect(() => {
    canvas.setLocale(locale);
  }, [canvas, locale]);

  useLayoutEffect(() => {
    canvas.setCheckboxes(checkboxes);
  }, [canvas, checkboxes]);

  useLayoutEffect(() => {
    canvas.setWrapLines(wrapLines);
  }, [canvas, wrapLines]);

  useLayoutEffect(() => {
    canvas.setColumnGroups(columnGroups, groupHeaderHeight);
  }, [canvas, columnGroups, groupHeaderHeight]);

  const { cellText, cellStyle, drawCell, cellAction } = hooks;
  useLayoutEffect(() => {
    canvas.setHooks({ cellText, cellStyle, drawCell, cellAction });
  }, [canvas, cellText, cellStyle, drawCell, cellAction]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const element = canvasRef.current;
    const scroller = scrollerRef.current;
    const sizer = sizerRef.current;
    if (!root || !element || !scroller || !sizer) return;
    const detach = canvas.attach({ root, canvas: element, scroller, sizer }, store);
    // The first frame is drawn before the browser paints, with the rows the store already has.
    canvas.draw();
    return detach;
  }, [canvas, store, scrollerRef]);

  useClipboard(store, scrollerRef, announce);

  const nameOf = (column: number) => store.getSnapshot().displayed[column]?.column.name;

  /** Dispatches a command of checked rows, and announces how many rows are checked, or why it failed. */
  const dispatchCheck = (command: GridCommand) => {
    void store.dispatch(command).then((outcome) => {
      if (!outcome.ok) {
        announce(
          outcome.error instanceof CommandError && outcome.error.reason === "unknown_state"
            ? messages.checkedUnknown
            : messages.failed(outcome.error.message),
        );
        return;
      }
      const { session, document, view } = store.getSnapshot();
      const count = checkedCount(session.checked, document.plan, view?.rowCount ?? 0);
      announce(count === null ? messages.checkedUnknown : messages.checkedRows(number.format(count)));
    });
  };

  /** Checks a row of the view, or unchecks it when it is checked. */
  const toggleCheck = (row: number) => {
    const key = store.rowKey(row);
    if (!key) return;
    const { session, document } = store.getSnapshot();
    const state = checkState(session.checked, document.plan, key);
    dispatchCheck({ command: state === "checked" ? "uncheck" : "check", keys: [key] });
  };

  const { onPointerDown, onPointerMove, onPointerUp, afterPointerUp } = useGridPointer({
    canvas,
    store,
    scrollerRef,
    columns,
    toggleCheck,
    dispatchCheck,
  });

  /** Opens the menu of a column under its header. */
  const openMenu = (column: string, index: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    setMenu({
      column,
      x: rect.left + Math.max(0, geometry.columnX(index) + geometry.columnWidth(index) - 200),
      y: rect.top + geometry.headerHeight,
    });
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = geometry.hit(event.clientX - rect.left, event.clientY - rect.top);
    const column = nameOf(hit.column);
    if (hit.area === "header" && hit.menu && column !== undefined) openMenu(column, hit.column);
    // A click on a link or a button of a cell acts, after selecting the cell.
    if (hit.area === "cell" && !event.shiftKey && !event.metaKey && !event.ctrlKey) act(hit.row, hit.column);
  };

  /** Calls `onCellAction` for a cell that is a link or a button. */
  const act = (row: number, column: number) => {
    const found = canvas.actionAt(row, column);
    if (!found || !onCellAction) return false;
    onCellAction({ ...found.cell, action: found.action, key: store.rowKey(row) });
    return true;
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = geometry.hit(event.clientX - rect.left, event.clientY - rect.top);
    const column = nameOf(hit.column);
    if ((hit.area !== "header" && hit.area !== "cell") || column === undefined) return;
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    let open: () => void;
    if (hit.area === "header") {
      open = () => setMenu({ column, ...at });
    } else {
      // A cell outside the selection is selected first, as spreadsheets do.
      if (!isSelected(hit.row, column)) void store.dispatch({ command: "select", row: hit.row, column });
      open = () => setCellMenu({ row: hit.row, column, ...at });
    }
    // Where the menu comes as the button goes down (macOS), it opens once the button is up.
    afterPointerUp(open);
  };

  /** Whether a cell is in the selection. */
  const isSelected = (row: number, column: string) => {
    const { selection, active } = store.getSnapshot().session;
    if (!selection) return active?.row === row && active.column === column;
    return selection.some(
      (range) =>
        (range.rows === "all" || (row >= range.rows[0] && row < range.rows[1])) &&
        (range.columns === "all" || range.columns.includes(column)),
    );
  };

  /** Copies the selection from a menu, through the asynchronous clipboard. */
  const copySelection = () => {
    void store.dispatch({ command: "copy" }, { locale }).then(async (outcome) => {
      if (!outcome.ok) {
        announce(messages.failed(outcome.error.message));
        return;
      }
      try {
        await writeClipboardLater(outcome.output);
        announce(messages.copied(number.format(countCells(outcome.output))));
      } catch (error) {
        announce(messages.failed(error instanceof Error ? error.message : String(error)));
      }
    });
  };

  /** Opens the cell menu of the active cell, under it. */
  const openCellMenu = () => {
    const scroller = scrollerRef.current;
    const active = store.getSnapshot().session.active;
    if (!scroller || !active) return;
    const index = columns.findIndex((item) => item.column.name === active.column);
    if (index < 0) return;
    const box = geometry.cellBox(active.row, index);
    const rect = scroller.getBoundingClientRect();
    setCellMenu({
      row: active.row,
      column: active.column,
      x: rect.left + box.left,
      y: rect.top + box.top + box.height,
    });
  };

  const closeCellMenu = () => {
    setCellMenu(null);
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const closeMenu = () => {
    setMenu(null);
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = geometry.hit(event.clientX - rect.left, event.clientY - rect.top);
    const name = nameOf(hit.column);
    // Double-clicking a column's edge fits it to its values again; double-clicking a cell edits it.
    if (hit.area === "header" && hit.edge && name !== undefined)
      void store.dispatch({ command: "column.resize", name, width: null });
    else if (hit.area === "cell") startEditing(undefined);
  };

  /**
   * Opens the editor on the active cell (`edit.begin`, §6.5): with its value, or empty for a key that types text,
   * whose text, an IME's included, then goes into the editor, which takes the focus before the browser handles
   * the key. Tells why when the cell is not written.
   */
  const startEditing = (text: string | undefined) => {
    const outcome = store.dispatchSync(
      text === undefined ? { command: "edit.begin" } : { command: "edit.begin", text },
    );
    if (outcome.ok) {
      if (store.getSnapshot().session.editor) editor.current?.open();
      return true;
    }
    if (outcome.error instanceof CommandError && outcome.error.reason === "read_only") announce(messages.readOnly);
    else announce(messages.failed(outcome.error.message));
    return false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    // While an IME composes, keys are its own (the editor takes them, §6.6 of react.md).
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    // Space acts on a link or a button of the active cell; otherwise it checks the active row, or unchecks it.
    if (!composing && event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const active = store.getSnapshot().session.active;
      if (!active) return;
      const column = columns.findIndex((item) => item.column.name === active.column);
      if (act(active.row, column)) {
        event.preventDefault();
        return;
      }
      if (!checkboxes) return;
      event.preventDefault();
      toggleCheck(active.row);
      return;
    }
    // ⌘F or Ctrl+F opens the find bar, when the engine finds.
    if ((isApple() ? event.metaKey : event.ctrlKey) && (event.key === "f" || event.key === "F") && !event.altKey) {
      if (!onFind || store.getSnapshot().table?.capabilities.find !== true) return;
      event.preventDefault();
      onFind();
      return;
    }
    // Shift+F10 and the context menu key open the menu of the active cell.
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openCellMenu();
      return;
    }
    // Alt+Enter opens the detail panel of the active row, or closes it.
    if (!composing && event.altKey && event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      const open = store.getSnapshot().session.detail?.open === true;
      void store.dispatch({ command: open ? "detail.close" : "detail.open" });
      return;
    }
    // Alt+↓ opens the menu of the active cell's column.
    if (event.altKey && event.key === "ArrowDown" && !event.ctrlKey && !event.metaKey) {
      const column = store.getSnapshot().session.active?.column;
      const index = columns.findIndex((item) => item.column.name === column);
      if (column === undefined || index < 0) return;
      event.preventDefault();
      openMenu(column, index);
      return;
    }
    if (typesText({ ...pick(event), keyCode: event.keyCode, isComposing: event.nativeEvent.isComposing })) {
      // Not prevented: the key's text goes into the editor that now has the focus.
      if (!startEditing("")) event.preventDefault();
      return;
    }
    const command = keyCommand(event, isApple());
    if (!command) return;
    if (command.command === "save") {
      // Without saving, the key is the browser's.
      if (!saving || store.getSnapshot().table?.capabilities.save !== true) return;
      event.preventDefault();
      saving.save();
      return;
    }
    event.preventDefault();
    void store.dispatch(command);
  };

  // The accessibility rows always hold the active cell (§6.4).
  const activeColumn = active ? columns.findIndex((item) => item.column.name === active.column) : 0;
  const activeRow = active?.row ?? 0;
  const activeShown = rowCount > 0 && activeColumn >= 0;

  return (
    <div className="vg-body" ref={rootRef}>
      <canvas className="vg-canvas" ref={canvasRef} />
      {/* biome-ignore lint/a11y/useSemanticElements: a canvas grid cannot use table elements; ARIA grid roles describe it. */}
      <div
        className="vg-scroller"
        ref={scrollerRef}
        role="grid"
        tabIndex={0}
        aria-label={label}
        aria-rowcount={rowCount + 1 + (totalsRow ? 1 : 0)}
        aria-colcount={columns.length}
        aria-multiselectable="true"
        aria-busy={busy}
        aria-activedescendant={activeShown ? cellId(id, activeRow, activeColumn) : undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div className="vg-sizer" ref={sizerRef} />
        <AccessibleRows canvas={canvas} id={id} />
      </div>
      <CellEditor canvas={canvas} scrollerRef={scrollerRef} announce={announce} ref={editor} />
      {menu && (
        <Suspense fallback={null}>
          <ColumnMenu target={menu} onClose={closeMenu} />
        </Suspense>
      )}
      {cellMenu && (
        <Suspense fallback={null}>
          <CellMenu target={cellMenu} onClose={closeCellMenu} copy={copySelection} onView={onView} />
        </Suspense>
      )}
    </div>
  );
}
