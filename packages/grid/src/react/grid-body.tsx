import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { browser } from "react-dom";
import { CommandError } from "vastgrid-spec";
import { GridCanvas, type Hit } from "../canvas/grid-canvas.js";
import { isApple, type KeyInput, keyCommand, typesText } from "../canvas/keys.js";
import type { GridStore } from "../core/store.js";
import { AccessibleRows, cellId } from "./accessible-rows.js";
import { CellEditor, type EditorControl } from "./cell-editor.js";
import { ColumnMenu, type MenuTarget } from "./column-menu.js";
import { LocaleContext, SaveContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

interface Drag {
  kind: "cells" | "rows" | "resize";
  pointer: number;
  /** The last cell or row the pointer was over, so that moves within it dispatch nothing. */
  last: string;
  /** For a resize: the column, its width and the pointer's x when the drag started. */
  column: number;
  width: number;
  x: number;
}

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
  const { messages, number } = use(LocaleContext);
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
      const outcome = store.dispatchSync({ command: "copy" });
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
      void store.dispatch({ command: "copy" }).then(async (later) => {
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
  }, [store, scroller]);
}

/** The cells of a copy: its TSV's fields. */
function countCells(output: unknown) {
  const { tsv } = output as { tsv: string };
  if (tsv === "") return 0;
  return tsv.split("\n").reduce((count, line) => count + line.split("\t").length, 0);
}

export interface GridBodyProps {
  rowHeight?: number;
  headerHeight?: number;
  label: string;
  /** Receives the scroller, which has the focus of the grid. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  announce: (text: string) => void;
}

/**
 * The canvas and the scroller over it (§6 of v2-react.md): keys and pointers become commands, the canvas draws
 * the store without rendering React, and the accessibility rows follow when scrolling pauses. Rendered only in
 * the browser: on the server, the nearest Suspense boundary sends its fallback, the first rows as HTML.
 */
export function GridBody({ rowHeight, headerHeight, label, scrollerRef, announce }: GridBodyProps) {
  use(browser("The grid draws on a canvas, which only the browser has."));
  const store = useGridStore();
  const [canvas] = useState(() => new GridCanvas({ rowHeight, headerHeight }));
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const editor = useRef<EditorControl>(null);
  const { messages } = use(LocaleContext);
  const saving = use(SaveContext);
  const follow = useRef<{ frame: number; x: number; y: number } | null>(null);
  const id = useId();
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const columns = useGridSelector((snapshot) => snapshot.displayed);
  const busy = useGridSelector((snapshot) => snapshot.view === null || snapshot.pending !== null);
  const active = useGridSelector((snapshot) => snapshot.session.active);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const pressed = useRef(false);
  const later = useRef<MenuTarget | null>(null);

  useLayoutEffect(() => {
    canvas.setSizes(rowHeight, headerHeight);
  }, [canvas, rowHeight, headerHeight]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const element = canvasRef.current;
    const scroller = scrollerRef.current;
    const sizer = sizerRef.current;
    if (!root || !element || !scroller || !sizer) return;
    const detach = canvas.attach({ root, canvas: element, scroller, sizer }, store);
    // The first frame is drawn before the browser paints, with the rows the store already has.
    canvas.draw();
    return () => {
      if (follow.current) cancelAnimationFrame(follow.current.frame);
      follow.current = null;
      detach();
    };
  }, [canvas, store, scrollerRef]);

  useClipboard(store, scrollerRef, announce);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const nameOf = (column: number) => store.getSnapshot().displayed[column]?.column.name;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressed.current = event.buttons !== 0;
    if (event.button !== 0) return;
    const scroller = event.currentTarget;
    const { x, y } = point(event);
    // Clicks on the scroll bars scroll.
    if (x > scroller.clientWidth || y > scroller.clientHeight) return;
    scroller.focus({ preventScroll: true });
    event.preventDefault();
    const hit: Hit = canvas.hit(x, y);
    const primary = isApple() ? event.metaKey : event.ctrlKey;
    const mode = event.shiftKey ? "extend" : primary ? "add" : "replace";
    const start = (kind: Drag["kind"], last: string, extra: Partial<Drag> = {}) => {
      drag.current = { kind, pointer: event.pointerId, last, column: 0, width: 0, x: event.clientX, ...extra };
      scroller.setPointerCapture(event.pointerId);
    };
    if (hit.area === "cell") {
      const column = nameOf(hit.column);
      if (column === undefined) return;
      void store.dispatch({ command: "select", row: hit.row, column, mode });
      start("cells", `${hit.row}:${hit.column}`);
    } else if (hit.area === "gutter") {
      void store.dispatch({ command: "select.rows", from: hit.row, to: hit.row, mode });
      start("rows", String(hit.row));
    } else if (hit.area === "corner") {
      void store.dispatch({ command: "select.all" });
    } else if (hit.area === "header") {
      const column = nameOf(hit.column);
      if (column === undefined) return;
      // The menu opens on the click, after the pointer is up: a popover shown before closes as the pointer goes up.
      if (hit.menu) return;
      if (hit.edge) start("resize", "", { column: hit.column, width: canvas.columnWidth(hit.column) });
      else void store.dispatch({ command: "sort.toggle", column, ...(event.shiftKey ? { add: true } : {}) });
    }
  };

  /** Extends the selection being dragged to the cell or the row at a point, kept within the body. */
  const extendTo = (scroller: HTMLElement, current: Drag, x: number, y: number) => {
    const hit = canvas.hit(
      Math.max(canvas.gutterWidth + 1, Math.min(scroller.clientWidth - 1, x)),
      Math.max(canvas.headerHeight + 1, Math.min(scroller.clientHeight - 1, y)),
    );
    if (current.kind === "cells" && hit.area === "cell") {
      const key = `${hit.row}:${hit.column}`;
      const column = nameOf(hit.column);
      if (key === current.last || column === undefined) return;
      current.last = key;
      void store.dispatch({ command: "select", row: hit.row, column, mode: "extend" });
    } else if (current.kind === "rows" && (hit.area === "cell" || hit.area === "gutter")) {
      const key = String(hit.row);
      if (key === current.last) return;
      current.last = key;
      const anchor = store.getSnapshot().session.anchor?.row ?? hit.row;
      void store.dispatch({ command: "select.rows", from: anchor, to: hit.row, mode: "extend" });
    }
  };

  const stopFollowing = () => {
    if (follow.current) cancelAnimationFrame(follow.current.frame);
    follow.current = null;
  };

  /** While a drag is beyond the body, scrolls towards the pointer every frame and extends the selection. */
  const followPointer = (scroller: HTMLElement, x: number, y: number) => {
    const beyondY =
      y < canvas.headerHeight ? y - canvas.headerHeight : y > scroller.clientHeight ? y - scroller.clientHeight : 0;
    const beyondX =
      x < canvas.gutterWidth ? x - canvas.gutterWidth : x > scroller.clientWidth ? x - scroller.clientWidth : 0;
    if (beyondX === 0 && beyondY === 0) {
      stopFollowing();
      return;
    }
    if (follow.current) {
      follow.current.x = x;
      follow.current.y = y;
      return;
    }
    const state = { frame: 0, x, y };
    follow.current = state;
    const step = () => {
      const current = drag.current;
      if (follow.current !== state || !current) return;
      const dy =
        state.y < canvas.headerHeight ? state.y - canvas.headerHeight : Math.max(0, state.y - scroller.clientHeight);
      const dx =
        state.x < canvas.gutterWidth ? state.x - canvas.gutterWidth : Math.max(0, state.x - scroller.clientWidth);
      // Faster the farther the pointer is.
      scroller.scrollTop += Math.sign(dy) * Math.min(80, Math.abs(dy) / 2 + 4);
      if (current.kind === "cells") scroller.scrollLeft += Math.sign(dx) * Math.min(80, Math.abs(dx) / 2 + 4);
      extendTo(scroller, current, state.x, state.y);
      state.frame = requestAnimationFrame(step);
    };
    state.frame = requestAnimationFrame(step);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const { x, y } = point(event);
    if (!current) {
      const hit = canvas.hit(x, y);
      event.currentTarget.style.cursor = hit.area === "header" && hit.edge ? "col-resize" : "";
      return;
    }
    if (current.kind === "resize") {
      canvas.previewWidth(current.column, current.width + event.clientX - current.x);
      return;
    }
    extendTo(event.currentTarget, current, x, y);
    followPointer(event.currentTarget, x, y);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pressed.current = false;
    if (later.current && event.type === "pointerup") setMenu(later.current);
    later.current = null;
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    stopFollowing();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.kind !== "resize") return;
    const name = nameOf(current.column);
    const width = Math.max(40, Math.min(100_000, Math.round(current.width + event.clientX - current.x)));
    if (name !== undefined) {
      void store
        .dispatch({ command: "column.resize", name, width })
        .then(() => canvas.previewWidth(current.column, null));
    } else {
      canvas.previewWidth(current.column, null);
    }
  };

  /** Opens the menu of a column under its header. */
  const openMenu = (column: string, index: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    setMenu({
      column,
      x: rect.left + Math.max(0, canvas.columnX(index) + canvas.columnWidth(index) - 200),
      y: rect.top + canvas.headerHeight,
    });
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = canvas.hit(event.clientX - rect.left, event.clientY - rect.top);
    const column = nameOf(hit.column);
    if (hit.area === "header" && hit.menu && column !== undefined) openMenu(column, hit.column);
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = canvas.hit(event.clientX - rect.left, event.clientY - rect.top);
    const column = nameOf(hit.column);
    if (hit.area !== "header" || column === undefined) return;
    event.preventDefault();
    const target = { column, x: event.clientX, y: event.clientY };
    // Where the menu comes as the button goes down (macOS), it opens once the button is up.
    if (pressed.current) later.current = target;
    else setMenu(target);
  };

  const closeMenu = () => {
    setMenu(null);
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = canvas.hit(event.clientX - rect.left, event.clientY - rect.top);
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
        aria-rowcount={rowCount + 1}
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
      <ColumnMenu target={menu} onClose={closeMenu} />
    </div>
  );
}
