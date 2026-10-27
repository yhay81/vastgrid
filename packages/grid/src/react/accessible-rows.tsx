import { startTransition, useEffect, useState } from "react";
import { type ActiveCell, type CellRange, type DisplayedColumn, type SortKey, textOf } from "vastgrid-spec";
import type { GridCanvas, Settled } from "../canvas/grid-canvas.js";
import type { GridStore } from "../core/store.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** Rows and columns that the accessibility tree holds at most. */
const MAX_ROWS = 200;
const MAX_COLUMNS = 60;

/** The id of the element of a cell, for `aria-activedescendant`. */
export function cellId(id: string, row: number, column: number) {
  return `${id}-r${row}-c${column}`;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Cell extends Box {
  column: number;
  name: string;
  text: string;
  /** What the colors of a style rule mean (§5.1), read by screen readers. */
  description?: string;
  /** A link or a button (`cellAction`), with its name for screen readers. */
  action?: { kind: "link" | "button"; label?: string };
}

interface ShownRow {
  row: number;
  cells: Cell[];
}

/** The display positions of the columns on screen: those that scroll into view, and those pinned. */
function shownColumns(settled: Settled, columns: readonly DisplayedColumn[]): number[] {
  const shown: number[] = [];
  for (let column = 0; column < columns.length && shown.length < MAX_COLUMNS; column++) {
    const scrolls = column >= settled.left && column <= settled.right;
    if (scrolls || columns[column].setting.pin !== undefined) shown.push(column);
  }
  return shown;
}

/** A box of the canvas, in the scroller's content. */
function boxOf(canvas: GridCanvas, x: number, y: number, width: number, height: number): Box {
  return { left: canvas.geometry.scrollX.native + x, top: canvas.geometry.scrollY.native + y, width, height };
}

/** A row's cells; a row that is not on screen is placed at the top of the screen. */
function readRow(
  canvas: GridCanvas,
  store: GridStore,
  columns: readonly DisplayedColumn[],
  shown: readonly number[],
  row: number,
  onScreen: boolean,
): ShownRow {
  const { geometry } = canvas;
  const y = onScreen ? geometry.rowY(row) : geometry.headerHeight;
  const cells = shown.map((column) => {
    const item = columns[column].column;
    const value = store.cell(row, item.name);
    return {
      column,
      name: item.name,
      text: value === undefined || value === null ? "" : canvas.text(row, item, value),
      description: canvas.styleOf(row, item.name)?.description,
      action: canvas.actionAt(row, column)?.action,
      ...boxOf(canvas, geometry.columnX(column), y, geometry.columnWidth(column), geometry.rowHeight),
    };
  });
  return { row, cells };
}

/**
 * Where the headers and the cells on screen are, in the scroller's content, and their text. The canvas and the
 * cache change inside their objects, so `settled` is an argument: they are read again when scrolling pauses or
 * rows arrive (memoization, React Compiler's included, keys on it), and not when the selection moves.
 */
function readScreen(canvas: GridCanvas, store: GridStore, settled: Settled, columns: readonly DisplayedColumn[]) {
  const { geometry } = canvas;
  const shown = shownColumns(settled, columns);
  const header = shown.map((column) => ({
    column,
    name: columns[column].column.name,
    text: columns[column].setting.format?.label ?? columns[column].column.name,
    groups: canvas.groupNames(column).join(" › "),
    ...boxOf(canvas, geometry.columnX(column), 0, geometry.columnWidth(column), geometry.headerHeight),
  }));
  const rows: ShownRow[] = [];
  const end = Math.min(settled.top + settled.rows, settled.top + MAX_ROWS);
  for (let row = settled.top; row < end; row++) rows.push(readRow(canvas, store, columns, shown, row, true));
  return { header, rows, shown, end };
}

/** The display positions of a row's selected cells (§5.2), as text that stays the same while they do. */
function selectedOf(ranges: readonly CellRange[] | undefined, active: ActiveCell | undefined, row: ShownRow) {
  const selected: number[] = [];
  for (const cell of row.cells) {
    const inRange = (ranges ?? []).some(
      (range) =>
        (range.rows === "all" || (row.row >= range.rows[0] && row.row < range.rows[1])) &&
        (range.columns === "all" || range.columns.includes(cell.name)),
    );
    if (inRange || (active?.row === row.row && active.column === cell.name)) selected.push(cell.column);
  }
  return selected.join(",");
}

function sortOf(sort: readonly SortKey[] | undefined, column: string) {
  const key = sort?.find((item) => item.column === column);
  return key ? (key.direction === "asc" ? "ascending" : "descending") : undefined;
}

const style = (box: Box) => ({ left: box.left, top: box.top, width: box.width, height: box.height });

/** A row of the accessibility tree; it renders again only when its cells or its selected cells change. */
function AccessibleRow({ id, row, selected }: { id: string; row: ShownRow; selected: string }) {
  const marked = new Set(selected === "" ? [] : selected.split(",").map(Number));
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
    <div role="row" aria-rowindex={row.row + 2}>
      {row.cells.map((cell) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
        // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
        <div
          key={cell.name}
          id={cellId(id, row.row, cell.column)}
          role="gridcell"
          aria-colindex={cell.column + 1}
          aria-selected={marked.has(cell.column)}
          aria-description={cell.description}
          style={style(cell)}
        >
          {cell.action?.kind === "link" ? (
            // biome-ignore lint/a11y/useSemanticElements: the cell's link is drawn on the canvas; this names it.
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
            <span role="link" aria-label={cell.action.label}>
              {cell.text}
            </span>
          ) : cell.action?.kind === "button" ? (
            // biome-ignore lint/a11y/useSemanticElements: the cell's button is drawn on the canvas; this names it.
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
            <span role="button" aria-label={cell.action.label}>
              {cell.text}
            </span>
          ) : (
            cell.text
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The rows on screen as ARIA rows and cells under the canvas (§6.4 of react.md), placed over the cells they
 * stand for and drawn transparent, with the row of the active cell when it is elsewhere. They follow the canvas
 * when scrolling pauses, in a Transition: one commit at a lower priority than anything the person does.
 */
export function AccessibleRows({ canvas, id }: { canvas: GridCanvas; id: string }) {
  const { geometry } = canvas;
  const store = useGridStore();
  const [settled, setSettled] = useState(() => canvas.getSettled());
  useEffect(
    () =>
      canvas.subscribeSettled(() => {
        startTransition(() => setSettled(canvas.getSettled()));
      }),
    [canvas],
  );
  const columns = useGridSelector((snapshot) => snapshot.displayed);
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const selection = useGridSelector((snapshot) => snapshot.session.selection);
  const active = useGridSelector((snapshot) => snapshot.session.active);
  const totals = useGridSelector((snapshot) => snapshot.totals);
  const screen = readScreen(canvas, store, settled, columns);
  const elsewhere =
    active && (active.row < settled.top || active.row >= screen.end) && active.row < geometry.rowCount
      ? readRow(canvas, store, columns, screen.shown, active.row, false)
      : null;
  const rows = elsewhere ? [...screen.rows, elsewhere].sort((a, b) => a.row - b.row) : screen.rows;
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
    <div className="vg-a11y" role="rowgroup">
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas. */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant). */}
      <div role="row" aria-rowindex={1}>
        {screen.header.map((cell) => (
          // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
          <div
            key={cell.name}
            role="columnheader"
            aria-colindex={cell.column + 1}
            aria-sort={sortOf(sort, cell.name)}
            aria-description={cell.groups || undefined}
            style={style(cell)}
          >
            {cell.text}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <AccessibleRow key={row.row} id={id} row={row} selected={selectedOf(selection, active, row)} />
      ))}
      {geometry.footer > 0 && (
        // The totals row (§5.1 of the specification), after the rows.
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
        // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
        <div role="row" aria-rowindex={geometry.rowCount + 2}>
          {screen.header.map((cell) => {
            const value = totals?.values[cell.name];
            const type = totals?.columns[cell.name];
            return (
              // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern over a canvas.
              // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant).
              <div
                key={cell.name}
                role="gridcell"
                aria-colindex={cell.column + 1}
                style={{
                  left: cell.left,
                  top: geometry.bottom,
                  width: cell.width,
                  height: geometry.footer,
                }}
              >
                {value === undefined || value === null || !type ? "" : (textOf(value, type) ?? "")}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
