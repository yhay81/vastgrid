import { type KeyboardEvent, type RefObject, use, useLayoutEffect, useRef, useState, useTransition } from "react";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/**
 * The find bar (⌘F or Ctrl+F on the grid): finds the next cell of the view whose text contains what is typed, from
 * the active cell, in the displayed columns (`GridStore.find`, `find` of §8.2), and makes it the active cell. Enter
 * finds the next one, Shift+Enter the one before, and Esc closes the bar and gives the focus back to the grid.
 */
export function FindBar({
  onClose,
  scrollerRef,
}: {
  onClose: () => void;
  scrollerRef: RefObject<HTMLDivElement | null>;
}) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const finds = useGridSelector((snapshot) => snapshot.table?.capabilities.find === true);
  const [text, setText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState("");
  const [pending, startFind] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const close = () => {
    onClose();
    scrollerRef.current?.focus({ preventScroll: true });
  };

  const find = (direction: 1 | -1) => {
    if (text === "") return;
    startFind(async () => {
      const { session, displayed } = store.getSnapshot();
      const from = session.active ?? { row: 0, column: displayed[0]?.column.name ?? "" };
      try {
        const found = await store.find(text, { from, direction, caseSensitive });
        if (!found) {
          setStatus(messages.noMatches);
          return;
        }
        setStatus("");
        await store.dispatch({ command: "select", row: found.row, column: found.column });
      } catch (error) {
        setStatus(messages.failed(error instanceof Error ? error.message : String(error)));
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      find(event.shiftKey ? -1 : 1);
    }
  };

  if (!finds) return null;
  return (
    <search className="vg-find" aria-label={messages.find} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="search"
        className="vg-input vg-find__input"
        aria-label={messages.find}
        placeholder={messages.find}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setStatus("");
        }}
      />
      <label className="vg-filter__value">
        <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
        <span>{messages.matchCase}</span>
      </label>
      <button
        type="button"
        className="vg-button vg-button--small"
        aria-label={messages.findPrevious}
        disabled={pending || text === ""}
        onClick={() => find(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="vg-button vg-button--small"
        aria-label={messages.findNext}
        disabled={pending || text === ""}
        onClick={() => find(1)}
      >
        ↓
      </button>
      <span className="vg-find__status" role="status">
        {status}
      </span>
      <button type="button" className="vg-button vg-button--small" aria-label={messages.closeFind} onClick={close}>
        ×
      </button>
    </search>
  );
}
