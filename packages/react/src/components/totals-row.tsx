import { type CSSProperties, useEffect, useReducer } from "react";
import type { GridController } from "../controller.js";
import type { Messages } from "../messages.js";

/** The text of a schema column's total, formatted like the column when it has the column's kind of value. */
export function totalText(controller: GridController, index: number): string {
  const fn = controller.totalOf(index);
  if (!fn) return "";
  const value = controller.totalValues?.get(index);
  if (value === undefined) return controller.totalsPending ? "…" : "";
  // A count is a number of rows, not a value of the column.
  if (fn === "count") return controller.formatter.format(value, "bigint");
  if (fn === "avg" && !controller.formatterOf(index).numeric) return controller.formatter.format(value, "float");
  return controller.formatterOf(index).text(value);
}

/**
 * The totals row below the grid's rows: an aggregate of each column that has one (see
 * `GridController.setTotal`), over the current view, computed by the source. It stays at the bottom
 * while the rows scroll, and follows the columns' widths and horizontal scrolling.
 *
 * It is not a row of the grid: the selection, copying, exports and the keyboard's cell navigation
 * leave it out. Its cells are buttons in the tab order after the grid, which open the menu of the
 * column's aggregate; screen readers read their name and value.
 */
export function TotalsRow({
  controller,
  messages,
  onOpen,
}: {
  controller: GridController;
  messages: Messages;
  /** Opens the aggregate menu of a visible column, below a cell's button. */
  onOpen: (col: number, button: HTMLButtonElement) => void;
}) {
  // Follows scrolling and resizing, which redraw the canvas without a React update.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let frame = 0;
    const stop = controller.onRender(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(redraw);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [controller]);

  const c = controller;
  const [first, last] = c.visibleScrollColumns();
  const columns: number[] = [];
  for (let col = 0; col < c.frozen; col++) columns.push(col);
  for (let col = Math.max(first, c.frozen); col <= last; col++) columns.push(col);
  // Columns frozen at the right stay at the right edge, as in the grid.
  const rightStart = c.rightStart;
  for (let col = rightStart; col < c.visible.length; col++) columns.push(col);
  const scrollLeft = c.gutterWidth + c.frozenWidth;

  function cell(col: number) {
    const state = c.visible[col];
    if (!state) return null;
    const fn = c.totalOf(state.index);
    const left =
      col < c.frozen
        ? c.columnX(col) - c.gutterWidth
        : col >= rightStart
          ? c.columnX(col) - c.frozenRightX
          : c.columnX(col) - scrollLeft;
    const label = c.columnLabel(state.index);
    const text = totalText(c, state.index);
    const style: CSSProperties = { left, width: c.layout.width(col) };
    return (
      <button
        type="button"
        key={state.index}
        className="vg-totals__cell"
        data-align={c.formatterOf(state.index).align}
        data-empty={fn ? undefined : true}
        style={style}
        title={fn ? `${messages.aggregateNames[fn]}: ${text}` : messages.totalOf(label)}
        aria-label={fn ? `${label}, ${messages.aggregateNames[fn]}: ${text}` : messages.totalOf(label)}
        onClick={(event) => onOpen(col, event.currentTarget)}
      >
        {fn && <span className="vg-totals__fn">{messages.aggregateNames[fn]}</span>}
        <span className="vg-totals__value">{text}</span>
      </button>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of the totals' buttons, not a form's fieldset.
    <div className="vg-totals" role="group" aria-label={messages.totals} style={{ width: c.width }}>
      <span className="vg-totals__gutter" style={{ width: c.gutterWidth }} title={c.totalsError ?? undefined}>
        {c.totalsError ? `${messages.totals} ⚠` : messages.totals}
      </span>
      <div className="vg-totals__frozen" style={{ left: c.gutterWidth, width: c.frozenWidth }}>
        {columns.filter((col) => col < c.frozen).map(cell)}
      </div>
      <div className="vg-totals__scroll" style={{ left: scrollLeft, right: c.frozenRightWidth }}>
        {columns.filter((col) => col >= c.frozen && col < rightStart).map(cell)}
      </div>
      {rightStart < c.visible.length && (
        <div className="vg-totals__frozen" style={{ left: c.frozenRightX, width: c.frozenRightWidth }}>
          {columns.filter((col) => col >= rightStart).map(cell)}
        </div>
      )}
    </div>
  );
}
