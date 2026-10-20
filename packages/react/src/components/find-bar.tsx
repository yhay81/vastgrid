import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { isAbortError } from "vastgrid-core";
import type { Messages } from "../messages.js";

/** Find in the table (⌘F / Ctrl+F): moves the active cell to each match, wrapping at the ends. */
export function FindBar({
  messages,
  initial,
  onFind,
  onClose,
}: {
  messages: Messages;
  initial: string;
  onFind: (text: string, direction: 1 | -1, caseSensitive: boolean, signal: AbortSignal) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState<"idle" | "searching" | "notFound">("idle");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return () => pending.current?.abort();
  }, []);

  async function find(direction: 1 | -1) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setStatus("searching");
    try {
      const found = await onFind(text, direction, caseSensitive, controller.signal);
      if (!controller.signal.aborted) setStatus(found || !text ? "idle" : "notFound");
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setStatus("notFound");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void find(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <search className="vg-find" aria-label={messages.find}>
      <input
        ref={input}
        type="search"
        className="vg-input"
        placeholder={messages.findPlaceholder}
        aria-label={messages.findPlaceholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setStatus("idle");
        }}
        onKeyDown={onKeyDown}
      />
      <span className="vg-find__status" role="status">
        {status === "searching" ? messages.searching : status === "notFound" ? messages.notFound : ""}
      </span>
      <button
        type="button"
        className="vg-icon-button"
        aria-label={messages.findPrevious}
        title={`${messages.findPrevious} (Shift+Enter)`}
        onClick={() => void find(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="vg-icon-button"
        aria-label={messages.findNext}
        title={`${messages.findNext} (Enter)`}
        onClick={() => void find(1)}
      >
        ↓
      </button>
      <label className="vg-find__case" title={messages.matchCase}>
        <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
        <span aria-hidden="true">Aa</span>
        <span className="vg-sr-only">{messages.matchCase}</span>
      </label>
      <button
        type="button"
        className="vg-icon-button"
        aria-label={messages.close}
        title={`${messages.close} (Esc)`}
        onClick={onClose}
      >
        ×
      </button>
    </search>
  );
}
