import { type FocusEvent, forwardRef, type KeyboardEvent, useId } from "react";
import type { Messages } from "../messages.js";

export interface CellEditorProps {
  /** Whether a cell is being edited. While not, the editor stays in the page, hidden, so that typing can move into it. */
  open: boolean;
  label: string;
  error: string | null;
  checking: boolean;
  messages: Messages;
  /** Saves the text; `move` is where the active cell goes afterwards (rows, columns). */
  onCommit: (move: [number, number] | null) => void;
  onCancel: () => void;
  onBlur: (event: FocusEvent<HTMLTextAreaElement>) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Grows the editor with its lines, from the cell's height up. */
function fit(textarea: HTMLTextAreaElement) {
  textarea.style.height = "";
  textarea.style.height = `${Math.max(textarea.offsetHeight, textarea.scrollHeight)}px`;
}

/**
 * The text field over the cell being edited. Enter saves and moves down (Shift+Enter up), Tab saves and
 * moves right (Shift+Tab left), Esc cancels, and Alt+Enter (also ⌃↩ on a Mac) starts a new line. Keys
 * that end an IME composition are left to the IME. The grid places it (see `DataGrid`).
 */
export const CellEditor = forwardRef<HTMLTextAreaElement, CellEditorProps>(function CellEditor(props, ref) {
  const { open, label, error, checking, messages } = props;
  const hintId = useId();
  const errorId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The grid does not handle keys typed into the editor.
    event.stopPropagation();
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const textarea = event.currentTarget;
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    } else if (event.key === "Enter" && (event.altKey || (isMac && event.ctrlKey))) {
      event.preventDefault();
      textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
      fit(textarea);
    } else if (event.key === "Enter") {
      event.preventDefault();
      props.onCommit([event.shiftKey ? -1 : 1, 0]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      props.onCommit([0, event.shiftKey ? -1 : 1]);
    }
  }

  return (
    <div className="vg-editor" data-open={open || undefined} data-invalid={error ? true : undefined}>
      <textarea
        ref={ref}
        className="vg-editor-input"
        tabIndex={open ? 0 : -1}
        aria-hidden={open ? undefined : true}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={open ? (error ? `${errorId} ${hintId}` : hintId) : undefined}
        aria-busy={checking || undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        rows={1}
        onKeyDown={onKeyDown}
        onInput={(event) => fit(event.currentTarget)}
        onBlur={props.onBlur}
      />
      {open && (
        <div className="vg-editor-note">
          {error ? (
            <span id={errorId} className="vg-editor-error" role="alert">
              {error}
            </span>
          ) : checking ? (
            <span role="status">{messages.editChecking}</span>
          ) : null}
          <span id={hintId} className="vg-editor-hint">
            {messages.editHint}
          </span>
        </div>
      )}
    </div>
  );
});
