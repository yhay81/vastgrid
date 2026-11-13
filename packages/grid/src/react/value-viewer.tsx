import { type KeyboardEvent, use, useId, useLayoutEffect, useRef, useState } from "react";
import type { JsonValue } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useFullValue, valueText } from "./full-value.js";
import { useGridRows, useGridSelector, useGridStore } from "./hooks.js";

/** The cell that the viewer opens with: a row of the view and a column of it, shown or hidden. */
export interface ViewerTarget {
  row: number;
  column: string;
}

/** The largest text limit (§8.4): a longer value is read cut to it. */
const TEXT_LIMIT = 1_000_000;
/** Text longer than this is not parsed to see whether it is JSON. */
const JSON_LIMIT = 5_000_000;

/**
 * The viewer of a value (docs/react.md §6.13): a modal dialog that shows a cell's value in full in a body of its
 * own that scrolls, with its size, wrapping or not, JSON indented, a copy button, and the rows before and after
 * it in the same column (Alt+↑ and Alt+↓, which move the active cell too). Esc closes it.
 */
export function ValueViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const store = useGridStore();
  const { messages, number, locale } = use(LocaleContext);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [row, setRow] = useState(target.row);
  const [wrap, setWrap] = useState(true);
  const [indent, setIndent] = useState(false);
  const [copied, setCopied] = useState(false);
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const column = useGridSelector((snapshot) => snapshot.view?.columns.find((item) => item.name === target.column));
  const format = useGridSelector(
    (snapshot) => snapshot.document.columns?.find((item) => item.name === target.column)?.format,
  );
  const [values] = useGridRows({ start: row, end: column ? row + 1 : row, columns: column ? [column.name] : [] });
  const full = useFullValue(row, target.column, values?.[0]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(".vg-viewer__text")?.focus();
  }, []);

  const text =
    full.error !== undefined
      ? messages.failed(full.error)
      : full.value === undefined || !column
        ? null
        : valueText(full.value, column, format, locale);
  const json = text !== null && full.error === undefined && !full.cut ? jsonOf(full.value, text) : undefined;
  const shown = text === null ? messages.loading : indent && json !== undefined ? JSON.stringify(json, null, 2) : text;
  const label = format?.label ?? target.column;

  const step = (by: number) => {
    const next = Math.max(0, Math.min(rowCount - 1, row + by));
    if (next === row) return;
    setRow(next);
    setCopied(false);
    // The grid follows, in its active column, when that column is shown.
    const snapshot = store.getSnapshot();
    const active = snapshot.session.active?.column;
    if (active && snapshot.displayed.some((item) => item.column.name === active)) {
      void store.dispatch({ command: "select", row: next, column: active });
    }
  };
  const copy = () => {
    if (text === null || !navigator.clipboard?.writeText) return;
    const toCopy = indent && json !== undefined ? shown : text;
    void navigator.clipboard.writeText(toCopy).then(
      () => setCopied(true),
      () => {},
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    step(event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Alt+↑ and Alt+↓ bubble from its controls.
    <dialog ref={ref} className="vg-viewer" aria-labelledby={titleId} onClose={onClose} onKeyDown={onKeyDown}>
      <header className="vg-viewer__header">
        <div className="vg-viewer__heading">
          <h2 id={titleId} className="vg-viewer__title">
            {label}
          </h2>
          <p className="vg-viewer__meta">
            {messages.detailOf(number.format(row + 1))}
            {text !== null && full.error === undefined && (
              <> · {messages.valueSize(number.format(lengthOf(text)), number.format(linesOf(text)))}</>
            )}
          </p>
        </div>
        <div className="vg-viewer__actions">
          <button
            type="button"
            className="vg-button vg-button--small"
            aria-label={messages.previousRow}
            title={`${messages.previousRow} (Alt+↑)`}
            disabled={row <= 0}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="vg-button vg-button--small"
            aria-label={messages.nextRow}
            title={`${messages.nextRow} (Alt+↓)`}
            disabled={row >= rowCount - 1}
            onClick={() => step(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="vg-button vg-button--small"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            {messages.wrapText}
          </button>
          {json !== undefined && (
            <button
              type="button"
              className="vg-button vg-button--small"
              aria-pressed={indent}
              onClick={() => {
                setIndent(!indent);
                setCopied(false);
              }}
            >
              {messages.formatJson}
            </button>
          )}
          <button type="button" className="vg-button vg-button--small" disabled={text === null} onClick={copy}>
            {copied ? messages.valueCopied : messages.copy}
          </button>
          <button
            type="button"
            className="vg-button vg-button--small"
            aria-label={messages.close}
            onClick={() => ref.current?.close()}
          >
            ×
          </button>
        </div>
      </header>
      {full.cut && <p className="vg-viewer__note">{messages.valueCut(number.format(TEXT_LIMIT))}</p>}
      <pre
        className="vg-viewer__text"
        data-wrap={wrap ? "" : undefined}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the keyboard scrolls it.
        tabIndex={0}
        aria-label={label}
      >
        {shown}
      </pre>
    </dialog>
  );
}

/** The value as JSON when it is an object or an array, or text of one; undefined otherwise. */
function jsonOf(value: JsonValue | undefined, text: string): JsonValue | undefined {
  if (value !== null && typeof value === "object") return value;
  if (text.length > JSON_LIMIT || !/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The length of a text in code points, as the text limit counts them (§8.4). */
function lengthOf(text: string) {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
    length += 1;
  }
  return length;
}

function linesOf(text: string) {
  let lines = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines += 1;
  return lines;
}
