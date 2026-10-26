import { type ToggleEvent, use, useId, useRef, useState, useTransition } from "react";
import type { GridCommand } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/**
 * The toolbar's columns menu (§6.3 of the specification): every column of the view, the displayed ones in display
 * order and then the hidden ones, each with a check box that shows or hides it (`column.show`, `column.hide`) and
 * buttons that move it by one place (`column.move`), and a box that finds columns by name.
 */
export function ColumnsMenu() {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const displayed = useGridSelector((snapshot) => snapshot.displayed);
  const view = useGridSelector((snapshot) => snapshot.view?.columns);
  const [find, setFind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startDispatch] = useTransition();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!view) return null;

  const shown = new Set(displayed.map((item) => item.column.name));
  const hidden = view.filter((column) => !shown.has(column.name));
  const needle = find.trim().toLowerCase();
  const matches = (name: string) => needle === "" || name.toLowerCase().includes(needle);

  const run = (command: GridCommand) =>
    startDispatch(async () => {
      const outcome = await store.dispatch(command);
      setError(outcome.ok ? null : outcome.error.message);
    });

  const place = (event: ToggleEvent<HTMLDivElement>) => {
    const button = buttonRef.current;
    if (event.newState !== "open" || !button) return;
    const rect = button.getBoundingClientRect();
    const menu = event.currentTarget;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  };

  return (
    <>
      <button ref={buttonRef} type="button" className="vg-button" popoverTarget={id}>
        {messages.columns}
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        className="vg-menu vg-columns"
        aria-label={messages.columns}
        onToggle={place}
      >
        <input
          type="search"
          className="vg-input"
          aria-label={messages.findColumn}
          placeholder={messages.findColumn}
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
        <ul className="vg-columns__list" aria-busy={pending}>
          {displayed.map((item, index) =>
            matches(item.column.name) ? (
              <li key={item.column.name} className="vg-columns__item">
                <label>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => run({ command: "column.hide", names: [item.column.name] })}
                  />
                  <span className="vg-filter__label">{item.column.name}</span>
                </label>
                {item.setting.pin && <span className="vg-filter__count">{messages.pinned[item.setting.pin]}</span>}
                <button
                  type="button"
                  className="vg-button vg-button--small"
                  aria-label={messages.moveUp(item.column.name)}
                  disabled={index === 0}
                  onClick={() =>
                    run({ command: "column.move", names: [item.column.name], before: displayed[index - 1].column.name })
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="vg-button vg-button--small"
                  aria-label={messages.moveDown(item.column.name)}
                  disabled={index === displayed.length - 1}
                  onClick={() =>
                    run({
                      command: "column.move",
                      names: [item.column.name],
                      before: displayed[index + 2]?.column.name ?? null,
                    })
                  }
                >
                  ↓
                </button>
              </li>
            ) : null,
          )}
          {hidden
            .filter((column) => matches(column.name))
            .map((column) => (
              <li key={column.name} className="vg-columns__item">
                <label>
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => run({ command: "column.show", names: [column.name] })}
                  />
                  <span className="vg-filter__label">{column.name}</span>
                </label>
              </li>
            ))}
        </ul>
        {error !== null && (
          <p role="alert" className="vg-filter__error">
            {error}
          </p>
        )}
        {hidden.length > 0 && (
          <button
            type="button"
            className="vg-menu__item"
            disabled={pending}
            onClick={() => run({ command: "column.show", all: true })}
          >
            {messages.showAllColumns}
          </button>
        )}
      </div>
    </>
  );
}
