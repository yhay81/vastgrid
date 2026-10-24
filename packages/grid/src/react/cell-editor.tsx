import {
  type CompositionEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
  use,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CommandError, type Editor } from "vastgrid-spec";
import type { GridCanvas } from "../canvas/grid-canvas.js";
import { isApple } from "../canvas/keys.js";
import type { GridStore } from "../core/store.js";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** What the grid asks of the editor while it handles a key. */
export interface EditorControl {
  /** Places the editor over the editor's cell and gives it the focus, before the key's text arrives. */
  open(): void;
}

/** Whether an editor of the session is for the same cell as another. */
function sameCell(a: Editor | undefined, b: Editor | undefined) {
  return a !== undefined && b !== undefined && a.row === b.row && a.column === b.column;
}

/** Grows the editor with its lines, from the cell's height up. */
function fit(textarea: HTMLTextAreaElement) {
  textarea.style.height = "";
  textarea.style.height = `${Math.max(textarea.offsetHeight, textarea.scrollHeight)}px`;
}

/** Places the editor's box over the cell of the session's editor, hidden while the cell is scrolled away. */
function place(box: HTMLDivElement | null, store: GridStore, canvas: GridCanvas) {
  const current = store.getSnapshot().session.editor;
  if (!box || !current) return;
  const at = store.getSnapshot().displayed.findIndex((item) => item.column.name === current.column);
  if (at < 0) return;
  const cell = canvas.cellBox(current.row, at);
  box.style.left = `${cell.left}px`;
  box.style.top = `${cell.top}px`;
  box.style.minWidth = `${Math.max(cell.width, 60)}px`;
  box.style.setProperty("--vg-editor-height", `${cell.height}px`);
  box.style.visibility = cell.shown ? "" : "hidden";
}

export interface CellEditorProps {
  canvas: GridCanvas;
  scrollerRef: RefObject<HTMLDivElement | null>;
  announce: (text: string) => void;
  ref?: Ref<EditorControl>;
}

/**
 * The text field over the cell being edited (§6.5 of the specification), the session's `editor`. It stays in the
 * page while no cell is edited, so that a key that types text, an IME's included, moves into it with its text:
 * the grid opens the editor and gives it the focus before the browser handles the key. Enter saves and moves down
 * (Shift+Enter up), Tab saves and moves right (Shift+Tab left), Esc cancels, and Alt+Enter (also ⌃↩ on Apple
 * platforms) starts a new line. Keys that end an IME composition are left to the IME.
 */
export function CellEditor({ canvas, scrollerRef, announce, ref }: CellEditorProps) {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const editor = useGridSelector((snapshot) => snapshot.session.editor);
  const columns = useGridSelector((snapshot) => snapshot.displayed);
  const boxRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<Editor | undefined>(undefined);
  const [problem, setProblem] = useState<{ editor: Editor; text: string } | null>(null);
  const hintId = useId();
  const errorId = useId();
  const column = editor ? columns.findIndex((item) => item.column.name === editor.column) : -1;
  const open = editor !== undefined && column >= 0;
  const error = problem && sameCell(problem.editor, editor) ? problem.text : null;

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        place(boxRef.current, store, canvas);
        textareaRef.current?.focus({ preventScroll: true });
      },
    }),
    [store, canvas],
  );

  // Over its cell, and again at every frame the canvas draws (scrolling, resizing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor's row and column are the triggers.
  useLayoutEffect(() => {
    if (!open) return;
    const box = boxRef.current;
    place(box, store, canvas);
    return canvas.subscribeFrames(() => place(box, store, canvas));
  }, [canvas, store, open, editor?.row, column]);

  // An editor that opens starts with its text: the cell's (F2, a double click) or empty for the key being typed.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const before = shown.current;
    shown.current = editor;
    if (!textarea) return;
    if (editor && !sameCell(before, editor)) {
      textarea.value = editor.text;
      textarea.setSelectionRange(editor.text.length, editor.text.length);
      textarea.style.height = "";
      if (document.activeElement !== textarea) textarea.focus({ preventScroll: true });
      fit(textarea);
    } else if (!editor && before && document.activeElement === textarea) {
      // Closed: the focus goes back to the grid.
      scrollerRef.current?.focus({ preventScroll: true });
    }
  }, [editor, scrollerRef]);

  const change = (text: string) => {
    if (store.getSnapshot().session.editor) store.dispatchSync({ command: "edit.change", text });
  };

  const commit = (move: "up" | "down" | "left" | "right" | null) => {
    const textarea = textareaRef.current;
    const current = store.getSnapshot().session.editor;
    if (!textarea || !current) return;
    setProblem(null);
    change(textarea.value);
    void store.dispatch({ command: "edit.commit", move }).then((outcome) => {
      if (outcome.ok) return;
      const reason = outcome.error instanceof CommandError ? outcome.error.reason : null;
      if (reason === "invalid_value") setProblem({ editor: current, text: messages.invalidValue(current.column) });
      else if (reason === "read_only") setProblem({ editor: current, text: messages.readOnly });
      else announce(messages.failed(outcome.error.message));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The grid does not handle keys typed into the editor.
    event.stopPropagation();
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const textarea = event.currentTarget;
    if (event.key === "Escape") {
      event.preventDefault();
      store.dispatchSync({ command: "edit.cancel" });
    } else if (event.key === "Enter" && (event.altKey || (isApple() && event.ctrlKey))) {
      event.preventDefault();
      textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
      change(textarea.value);
      fit(textarea);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(event.shiftKey ? "up" : "down");
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit(event.shiftKey ? "left" : "right");
    }
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    fit(event.currentTarget);
    // While an IME composes, the text is not the person's yet: it is taken when the composition ends.
    if (!(event.nativeEvent as InputEvent).isComposing) change(event.currentTarget.value);
  };

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => change(event.currentTarget.value);

  // Leaving the editor for another place of the page saves it, as a spreadsheet does.
  const onBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (open && event.relatedTarget !== null) commit(null);
  };

  return (
    <div className="vg-editor" ref={boxRef} data-open={open || undefined} data-invalid={error ? true : undefined}>
      <textarea
        ref={textareaRef}
        className="vg-editor-input"
        tabIndex={open ? 0 : -1}
        aria-hidden={open ? undefined : true}
        aria-label={editor ? messages.editing(number.format(editor.row + 1), editor.column) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={open ? (error ? `${errorId} ${hintId}` : hintId) : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        rows={1}
        onKeyDown={onKeyDown}
        onInput={onInput}
        onCompositionEnd={onCompositionEnd}
        onBlur={onBlur}
      />
      {open && (
        <span id={hintId} className="vg-sr-only">
          {messages.editorHint}
        </span>
      )}
      {open && error && (
        <div className="vg-editor-note">
          <span id={errorId} className="vg-editor-error" role="alert">
            {error}
          </span>
        </div>
      )}
    </div>
  );
}
