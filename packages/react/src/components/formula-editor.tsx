import { type FormEvent, type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import {
  type ColumnSchema,
  compileFormulas,
  FORMULA_FUNCTIONS,
  type FormulaColumn,
  type FormulaError,
  type FormulaType,
  formulaNames,
  formulaReference,
} from "vastgrid-core";
import type { Messages } from "../messages.js";

/** The text of a formula error, in the grid's language. */
export function formulaErrorText(error: FormulaError, messages: Messages) {
  const type = (name: FormulaType) => messages.formulaTypes[name];
  return messages.formulaError(error.code, {
    subject: error.subject,
    expected: error.expected?.map(type).join(" / "),
    actual: error.actual ? type(error.actual) : undefined,
    position: error.code === "syntax" || error.end > error.start ? String(error.start + 1) : undefined,
  });
}

/** The formulas that use a column by name. */
export function formulaUsers(formulas: readonly FormulaColumn[], name: string) {
  return formulas.filter((formula) => formula.name !== name && formulaNames(formula.expression).includes(name));
}

/**
 * Adds or edits a formula column: its name and expression, checked as they are typed over the table's
 * columns and the other formulas. `formula` is the one edited, or null for a new one.
 */
export function FormulaEditor({
  table,
  formulas,
  formula,
  messages,
  onSave,
  onCancel,
}: {
  /** The table's own columns. */
  table: readonly ColumnSchema[];
  /** Every formula column, with the edited one. */
  formulas: readonly FormulaColumn[];
  formula: FormulaColumn | null;
  messages: Messages;
  onSave: (formula: FormulaColumn) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(formula?.name ?? "");
  const [expression, setExpression] = useState(formula?.expression ?? "");
  const [touched, setTouched] = useState(formula !== null);
  const area = useRef<HTMLTextAreaElement>(null);
  const others = useMemo(() => formulas.filter((item) => item !== formula), [formulas, formula]);
  const result = useMemo(() => {
    const list = [...others, { name, expression }];
    return compileFormulas(table, list)[list.length - 1];
  }, [table, others, name, expression]);
  // A renamed column must not be used by other formulas.
  const users = formula && formula.name !== name ? formulaUsers(others, formula.name) : [];
  const error = result.error;
  const nameError = error?.code.startsWith("name_") ? formulaErrorText(error, messages) : null;
  const expressionError = error && !error.code.startsWith("name_") ? formulaErrorText(error, messages) : null;
  const blocked = Boolean(error) || users.length > 0;
  // Repeated names cannot be told apart in a formula, so each is listed once.
  const columns = [...new Set([...table.map((column) => column.name), ...others.map((item) => item.name)])];

  function submit(event?: FormEvent) {
    event?.preventDefault();
    setTouched(true);
    if (!blocked) onSave({ name, expression });
  }

  function insert(text: string) {
    const input = area.current;
    const start = input?.selectionStart ?? expression.length;
    const end = input?.selectionEnd ?? expression.length;
    const next = expression.slice(0, start) + text + expression.slice(end);
    setExpression(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  }

  // Errors show once the user typed something, so that an empty new formula is not red at once.
  const showExpressionError = expressionError !== null && (touched || expression.trim() !== "");
  return (
    <form className="vg-formula" onSubmit={submit}>
      <p className="vg-panel__title">{formula ? messages.formulaEditTitle : messages.formulaAddTitle}</p>
      <div className="vg-formula__field">
        <label htmlFor={`${id}-name-input`}>{messages.formulaName}</label>
        <input
          id={`${id}-name-input`}
          className="vg-input"
          value={name}
          data-autofocus={formula ? undefined : true}
          aria-invalid={nameError !== null && touched}
          aria-describedby={nameError && touched ? `${id}-name` : undefined}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
      {nameError && touched && (
        <p className="vg-panel__error" id={`${id}-name`}>
          {nameError}
        </p>
      )}
      {users.length > 0 && (
        <p className="vg-panel__error">{messages.formulaInUse(users.map((item) => item.name).join(", "))}</p>
      )}
      <div className="vg-formula__field">
        <label htmlFor={`${id}-expression`}>{messages.formulaExpression}</label>
        <textarea
          id={`${id}-expression`}
          ref={area}
          className="vg-input vg-formula__expression"
          value={expression}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-autofocus={formula ? true : undefined}
          aria-invalid={showExpressionError}
          aria-describedby={`${id}-help${showExpressionError ? ` ${id}-error` : ""}`}
          onChange={(event) => setExpression(event.target.value)}
          onKeyDown={keyDown}
        />
      </div>
      <div className="vg-formula__tools">
        <select
          className="vg-input"
          aria-label={messages.formulaInsertColumn}
          value=""
          onChange={(event) => {
            if (event.target.value) insert(formulaReference(event.target.value));
          }}
        >
          <option value="">{messages.formulaInsertColumn}</option>
          {columns.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
        <select
          className="vg-input"
          aria-label={messages.formulaFunctions}
          value=""
          onChange={(event) => {
            if (event.target.value) insert(`${event.target.value}(`);
          }}
        >
          <option value="">{messages.formulaFunctions}</option>
          {FORMULA_FUNCTIONS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <p className="vg-panel__muted" id={`${id}-help`}>
        {messages.formulaHelp}
      </p>
      <div aria-live="polite">
        {showExpressionError ? (
          <p className="vg-panel__error" id={`${id}-error`}>
            {expressionError}
          </p>
        ) : result.tree ? (
          <p className="vg-panel__muted">{messages.formulaResult(messages.formulaTypes[result.tree.type])}</p>
        ) : null}
      </div>
      <div className="vg-panel__actions">
        <button type="button" className="vg-button" onClick={onCancel}>
          {messages.cancel}
        </button>
        <button type="submit" className="vg-button vg-button--primary" disabled={blocked}>
          {formula ? messages.formulaSave : messages.formulaAdd}
        </button>
      </div>
    </form>
  );
}
