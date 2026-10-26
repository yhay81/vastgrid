import { type FormEvent, use, useId, useRef, useState, useTransition } from "react";
import {
  type CheckOptions,
  type Column,
  checkPlan,
  compileFormula,
  type Derived,
  FormulaError,
  formulaText,
  type GridCommand,
  planOptions,
} from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** The text of a derived column's expression as a formula (§4.11), or its JSON when it has none. */
function textOf(derived: Derived): string {
  try {
    return formulaText(derived.expr);
  } catch {
    return JSON.stringify(derived.expr);
  }
}

/**
 * One derived column, or a new one when `derived` is null: its name and formula, compiled against the columns
 * before it (§4.11) and dispatched as `derive.add` or `derive.update` (§6.2.2). A formula that does not compile is
 * not dispatched: its error is shown, and the characters at fault are selected.
 */
function FormulaForm({
  derived,
  columns,
  options,
}: {
  derived: Derived | null;
  columns: readonly Column[];
  options: CheckOptions;
}) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const [name, setName] = useState(derived?.name ?? "");
  const [text, setText] = useState(derived ? textOf(derived) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startDispatch] = useTransition();
  const formulaRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const run = (command: GridCommand, reset: boolean) =>
    startDispatch(async () => {
      const outcome = await store.dispatch(command);
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      setError(null);
      if (reset) {
        setName("");
        setText("");
      }
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let expr: Derived["expr"];
    try {
      expr = compileFormula(text, columns, options).expr;
    } catch (failure) {
      if (!(failure instanceof FormulaError)) throw failure;
      setError(failure.message);
      const input = formulaRef.current;
      input?.focus();
      input?.setSelectionRange(failure.start, Math.max(failure.start, failure.end));
      return;
    }
    if (derived === null) run({ command: "derive.add", name, expr }, true);
    else
      run(
        { command: "derive.update", name: derived.name, expr, ...(name === derived.name ? {} : { rename: name }) },
        false,
      );
  };

  return (
    <form className="vg-formulas__row" onSubmit={submit} aria-label={derived?.name ?? messages.newFormula}>
      <input
        className="vg-input vg-formulas__name"
        aria-label={messages.formulaName}
        placeholder={messages.formulaName}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        ref={formulaRef}
        className="vg-input vg-formulas__formula"
        aria-label={messages.formula}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
        placeholder={messages.formulaExample}
        required
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="vg-button" disabled={pending}>
        {derived === null ? messages.addFormula : messages.applyFormula}
      </button>
      {derived !== null && (
        <button
          type="button"
          className="vg-button"
          disabled={pending}
          onClick={() => run({ command: "derive.remove", name: derived.name }, false)}
        >
          {messages.removeFormula}
        </button>
      )}
      {error !== null && (
        <p id={errorId} role="alert" className="vg-formulas__error">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The content of the toolbar's formula menu, loaded when it first opens: the derived columns of the plan (§4.1) as formulas (§4.11), which can be changed,
 * renamed and removed, and a form that adds one. It is there when the engine derives columns.
 */
export default function FormulaPanel() {
  const table = useGridSelector((snapshot) => snapshot.table);
  const derive = useGridSelector((snapshot) => snapshot.document.plan?.derive);
  if (!table || table.capabilities.plan?.derive === false) return null;
  const options = planOptions(table.capabilities);
  const list = derive ?? [];
  // Each formula uses the table's columns and the derived columns before it.
  const scopes: Column[][] = [];
  let rows: Column[] = table.columns;
  for (const [index, derived] of list.entries()) {
    scopes.push(rows);
    try {
      rows = checkPlan({ derive: list.slice(0, index + 1) }, table.columns, options).rows;
    } catch {
      rows = [...rows, { name: derived.name, type: "string" }];
    }
  }

  return (
    <>
      {list.map((derived, index) => (
        // A formula changed elsewhere (an agent, undo) shows anew.
        <FormulaForm
          key={`${derived.name}\u0000${textOf(derived)}`}
          derived={derived}
          columns={scopes[index]}
          options={options}
        />
      ))}
      <FormulaForm key={list.length} derived={null} columns={rows} options={options} />
    </>
  );
}
