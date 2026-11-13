import { type PointerEvent, type RefObject, useLayoutEffect, useRef } from "react";
import type { DisplayedColumn, GridCommand } from "vastgrid-spec";
import type { Hit } from "../canvas/geometry.js";
import type { GridCanvas } from "../canvas/grid-canvas.js";
import { isApple } from "../canvas/keys.js";
import { allState } from "../core/checked.js";
import type { GridStore } from "../core/store.js";

interface Drag {
  kind: "cells" | "rows" | "resize" | "move";
  pointer: number;
  /** The last cell or row the pointer was over, so that moves within it dispatch nothing. */
  last: string;
  /** For a resize: the column, its width and the pointer's x when the drag started. */
  column: number;
  width: number;
  x: number;
  /** For a move: the columns dragged, whether the pointer moved enough to drag, and where they would go. */
  names?: string[];
  moving?: boolean;
  before?: string | null;
  /** Shift was held when a header was pressed: a click adds a sort key. */
  shift?: boolean;
}

interface PointerOptions {
  canvas: GridCanvas;
  store: GridStore;
  scrollerRef: RefObject<HTMLDivElement | null>;
  columns: readonly DisplayedColumn[];
  toggleCheck: (row: number) => void;
  dispatchCheck: (command: GridCommand) => void;
}

/** Pointer gestures and their state: selection, column moves and resizing, and scrolling during a drag. */
export function useGridPointer({ canvas, store, scrollerRef, columns, toggleCheck, dispatchCheck }: PointerOptions) {
  const { geometry } = canvas;
  const drag = useRef<Drag | null>(null);
  const follow = useRef<{ frame: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const later = useRef<(() => void) | null>(null);

  // A detached or replaced canvas must stop following the pointer, also during Strict Mode's remount.
  useLayoutEffect(() => {
    return () => {
      if (follow.current) cancelAnimationFrame(follow.current.frame);
      follow.current = null;
    };
  }, [canvas, store, scrollerRef]);

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
    const hit: Hit = geometry.hit(x, y);
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
    } else if (hit.area === "gutter" && hit.check) {
      toggleCheck(hit.row);
    } else if (hit.area === "corner" && hit.check) {
      const { session, document, view } = store.getSnapshot();
      const all = allState(session.checked, document.plan, view?.rowCount ?? 0);
      // The header's box checks every row of the view, or none once they all are.
      dispatchCheck(all === "all" ? { command: "check.clear" } : { command: "check.all" });
    } else if (hit.area === "group" && hit.level !== undefined) {
      // A group's header selects its columns.
      const span = canvas.groupSpan(hit.column, hit.level);
      const from = span && nameOf(span[0]);
      const to = span && nameOf(span[1]);
      if (from && to && span) {
        void store.dispatch({ command: "select.columns", from, to, mode });
        // Dragging a group's header moves its columns.
        const names = columns.slice(span[0], span[1] + 1).map((item) => item.column.name);
        start("move", "", { column: span[0], names });
      }
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
      if (hit.edge) start("resize", "", { column: hit.column, width: geometry.columnWidth(hit.column) });
      // A click sorts by the column; dragging it moves it (with the other columns selected whole with it).
      else start("move", "", { column: hit.column, names: movedWith(column), shift: event.shiftKey });
    }
  };

  /** Extends the selection being dragged to the cell or the row at a point, kept within the body. */
  const extendTo = (scroller: HTMLElement, current: Drag, x: number, y: number) => {
    if (geometry.rowCount <= 0 || geometry.layout.count <= 0) return;
    const maxColumnX =
      geometry.frozenRight > 0
        ? scroller.clientWidth - 1
        : Math.min(
            scroller.clientWidth - 1,
            geometry.gutterWidth + geometry.layout.total - geometry.scrollX.position - 1,
          );
    const maxRowY = Math.min(
      geometry.bottom - 1,
      geometry.headerHeight + geometry.rowCount * geometry.rowHeight - geometry.scrollY.position - 1,
    );
    const hit = geometry.hit(
      Math.max(geometry.gutterWidth + 1, Math.min(maxColumnX, x)),
      Math.max(geometry.headerHeight + 1, Math.min(maxRowY, y)),
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
      y < geometry.headerHeight ? y - geometry.headerHeight : y > geometry.bottom ? y - geometry.bottom : 0;
    const beyondX =
      x < geometry.gutterWidth ? x - geometry.gutterWidth : x > scroller.clientWidth ? x - scroller.clientWidth : 0;
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
        state.y < geometry.headerHeight ? state.y - geometry.headerHeight : Math.max(0, state.y - geometry.bottom);
      const dx =
        state.x < geometry.gutterWidth ? state.x - geometry.gutterWidth : Math.max(0, state.x - scroller.clientWidth);
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
      const hit = geometry.hit(x, y);
      const action = hit.area === "cell" ? canvas.actionAt(hit.row, hit.column)?.action : undefined;
      event.currentTarget.style.cursor =
        hit.area === "header" && hit.edge ? "col-resize" : action ? (action.cursor ?? "pointer") : "";
      return;
    }
    if (current.kind === "resize") {
      canvas.previewWidth(current.column, current.width + event.clientX - current.x);
      return;
    }
    if (current.kind === "move") {
      if (!current.moving && Math.abs(event.clientX - current.x) < 5) return;
      current.moving = true;
      const target = dropAt(x, current.names ?? []);
      current.before = target?.before;
      canvas.previewDrop(target ? target.x : null);
      return;
    }
    extendTo(event.currentTarget, current, x, y);
    followPointer(event.currentTarget, x, y);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pressed.current = false;
    if (later.current && event.type === "pointerup") later.current();
    later.current = null;
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    stopFollowing();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.kind === "move") {
      canvas.previewDrop(null);
      const name = nameOf(current.column);
      if (!current.moving) {
        // A click on a column's name sorts by it; a click on a group's header only selected its columns.
        if (current.names?.length === 1 && name !== undefined && event.type === "pointerup") {
          void store.dispatch({ command: "sort.toggle", column: name, ...(current.shift ? { add: true } : {}) });
        }
        return;
      }
      if (current.before !== undefined && current.names && event.type === "pointerup") {
        void store.dispatch({ command: "column.move", names: current.names, before: current.before });
      }
      return;
    }
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

  /** The columns a header drags: the column, or every column of a selection of whole columns that holds it. */
  const movedWith = (name: string): string[] => {
    const last = store.getSnapshot().session.selection?.at(-1);
    if (last && last.rows === "all" && last.columns !== "all" && last.columns.includes(name)) {
      return columns.map((item) => item.column.name).filter((item) => (last.columns as string[]).includes(item));
    }
    return [name];
  };

  /**
   * Where dragged columns would go for a pointer at `x`: before the column under it (after it past its middle), as
   * `column.move`'s `before` (null after the last), and the x of the line that shows it; undefined where they stay.
   */
  const dropAt = (x: number, names: readonly string[]): { before: string | null; x: number } | undefined => {
    if (columns.length === 0) return undefined;
    let at = geometry.columnAt(Math.max(geometry.gutterWidth, x));
    if (at < 0) at = x < geometry.gutterWidth ? 0 : columns.length - 1;
    const middle = geometry.columnX(at) + geometry.columnWidth(at) / 2;
    const index = x < middle ? at : at + 1;
    const before = index < columns.length ? columns[index].column.name : null;
    const moved = names.map((name) => columns.findIndex((item) => item.column.name === name));
    // Before one of the moved columns, or right after the last of them, they stay.
    if (before !== null && names.includes(before)) return undefined;
    if (moved.length > 0 && index === Math.max(...moved) + 1 && moved.every((item, i) => item === moved[0] + i)) {
      return undefined;
    }
    const lineX = index < columns.length ? geometry.columnX(index) : geometry.columnX(at) + geometry.columnWidth(at);
    return { before, x: lineX };
  };

  /** A menu triggered on pointer-down opens on release, so that release does not close it again. */
  const afterPointerUp = (action: () => void) => {
    if (pressed.current) later.current = action;
    else action();
  };

  return { onPointerDown, onPointerMove, onPointerUp, afterPointerUp };
}
