import { type KeyboardEvent, type ToggleEvent, use, useEffect, useLayoutEffect, useRef } from "react";
import { type GridCommand, isBlank, type JsonValue, joinParts } from "vastgrid-spec";
import { filterParts } from "../core/filters.js";
import { LocaleContext } from "./context.js";
import { useGridRows, useGridSelector, useGridStore } from "./hooks.js";
import type { ViewerTarget } from "./value-viewer.js";

/** Where the cell menu opens: a cell of the view, at a point of the page. */
export interface CellMenuTarget {
  row: number;
  column: string;
  x: number;
  y: number;
}

/** Arrows, Home and End move the focus among the items of a menu (the menu pattern of the ARIA Authoring Practices). */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : -1;
  if (next < 0 || items.length === 0) return;
  event.preventDefault();
  items[next].focus();
}

/**
 * The menu of a cell (a right click on it, Shift+F10 or the context menu key): copying the selection, filtering the
 * column to the cell's value or excluding it (`filter.column`, replacing the column's conditions), the value in
 * full in the viewer (read again without the text limit when the engine cut it, §8.4), and the detail panel.
 */
export function CellMenu({
  target,
  onClose,
  copy,
  onView,
}: {
  target: CellMenuTarget | null;
  onClose: () => void;
  copy: () => void;
  /** Opens the cell's value in the viewer. */
  onView: (target: ViewerTarget) => void;
}) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const ref = useRef<HTMLDivElement>(null);
  const column = useGridSelector((snapshot) =>
    target ? snapshot.displayed.find((item) => item.column.name === target.column)?.column : undefined,
  );
  const filters = useGridSelector(
    (snapshot) => snapshot.table?.capabilities.plan?.where !== false && snapshot.document.plan?.aggregate === undefined,
  );

  const [values] = useGridRows({
    start: target ? target.row : 0,
    end: target && column ? target.row + 1 : target ? target.row : 0,
    columns: target && column ? [column.name] : [],
  });
  const value: JsonValue | undefined = values?.[0];
  const loaded = Boolean(target && column && value !== undefined);

  useEffect(() => {
    if (target && !column) onClose();
  }, [target, column, onClose]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target || !loaded) return;
    if (!menu.matches(":popover-open")) menu.showPopover();
    (menu.querySelector<HTMLElement>("button:not(:disabled)") ?? menu).focus();
  }, [target, loaded]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target || !loaded) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`;
  });

  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") onClose();
  };

  useEffect(() => {
    if (!target || !loaded) return;
    const onFocusIn = (event: FocusEvent) => {
      const menu = ref.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target) && menu.matches(":popover-open")) {
        menu.hidePopover();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [target, loaded]);

  if (!target || !column || value === undefined) return null;
  const close = () => ref.current?.hidePopover();
  const run = (command: GridCommand) => {
    close();
    void store.dispatch(command);
  };
  const filterTo = (exclude: boolean) => {
    const blank = isBlank(value, column);
    const where = joinParts(filterParts({ kind: "values", values: blank ? [] : [value], blank, exclude }, column));
    run({ command: "filter.column", column: column.name, where: where ?? null });
  };
  const showFull = () => {
    close();
    onView({ row: target.row, column: target.column });
  };

  return (
    <div
      ref={ref}
      popover="auto"
      role="dialog"
      tabIndex={-1}
      className="vg-menu vg-cell-menu"
      aria-label={messages.cellMenu}
      onToggle={onToggle}
    >
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- focus moves among its items. */}
      <div role="menu" aria-label={messages.cellMenu} onKeyDown={moveFocus}>
        <button
          type="button"
          role="menuitem"
          className="vg-menu__item"
          onClick={() => {
            close();
            copy();
          }}
        >
          {messages.copy}
        </button>
        {filters && (
          <>
            <button type="button" role="menuitem" className="vg-menu__item" onClick={() => filterTo(false)}>
              {messages.filterToValue}
            </button>
            <button type="button" role="menuitem" className="vg-menu__item" onClick={() => filterTo(true)}>
              {messages.excludeValue}
            </button>
          </>
        )}
        <button type="button" role="menuitem" className="vg-menu__item" disabled={value === null} onClick={showFull}>
          {messages.fullValue}
        </button>
        <button type="button" role="menuitem" className="vg-menu__item" onClick={() => run({ command: "detail.open" })}>
          {messages.details}
        </button>
      </div>
    </div>
  );
}
