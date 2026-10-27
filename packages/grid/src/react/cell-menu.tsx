import { type KeyboardEvent, type ToggleEvent, use, useLayoutEffect, useRef, useState } from "react";
import { type GridCommand, isBlank, type JsonValue, joinParts, textOf } from "vastgrid-spec";
import { filterParts } from "../core/filters.js";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

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
 * column to the cell's value or excluding it (`filter.column`, replacing the column's conditions), showing the
 * value in full (read again without the text limit when the engine cut it, §8.4), and the detail panel.
 */
export function CellMenu({
  target,
  onClose,
  copy,
}: {
  target: CellMenuTarget | null;
  onClose: () => void;
  copy: () => void;
}) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setFull(null);
  }
  const column = useGridSelector((snapshot) =>
    target ? snapshot.displayed.find((item) => item.column.name === target.column)?.column : undefined,
  );
  const filters = useGridSelector(
    (snapshot) => snapshot.table?.capabilities.plan?.where !== false && snapshot.document.plan?.aggregate === undefined,
  );

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target) return;
    if (!menu.matches(":popover-open")) menu.showPopover();
    menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [target]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`;
  });

  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") onClose();
  };

  const value: JsonValue | undefined = target ? store.cell(target.row, target.column) : undefined;
  if (!target || !column || value === undefined) {
    return <div ref={ref} popover="auto" className="vg-menu vg-cell-menu" onToggle={onToggle} />;
  }
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
    if (!store.isCut(target.row, target.column)) {
      setFull(textOf(value, column) ?? "");
      return;
    }
    setFull(messages.loading);
    store
      .fullValue(target.row, target.column)
      .then((read) => setFull(textOf(read.value, read.column) ?? ""))
      .catch((error: unknown) => setFull(messages.failed(error instanceof Error ? error.message : String(error))));
  };

  return (
    <div
      ref={ref}
      popover="auto"
      role="dialog"
      className="vg-menu vg-cell-menu"
      aria-label={messages.cellMenu}
      onToggle={onToggle}
    >
      {full !== null ? (
        <section aria-label={messages.fullValue}>
          <p className="vg-filter__title">{column.name}</p>
          <pre className="vg-cell-menu__value" tabIndex={-1}>
            {full}
          </pre>
          <button type="button" className="vg-menu__item" onClick={close}>
            {messages.close}
          </button>
        </section>
      ) : (
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
          <button
            type="button"
            role="menuitem"
            className="vg-menu__item"
            onClick={() => run({ command: "detail.open" })}
          >
            {messages.details}
          </button>
        </div>
      )}
    </div>
  );
}
