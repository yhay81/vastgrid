import { use, useState, useTransition } from "react";
import { type Column, type Expr, formulaText } from "vastgrid-spec";
import { ConditionError, type ConditionNode, nodeId, readConditions, writeConditions } from "../core/conditions.js";
import { type FilterOperator, operatorsFor, takesNoValue } from "../core/filters.js";
import { rowColumns } from "../core/measures.js";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";
import type { GridMessages } from "./messages.js";

type Group = ConditionNode & { kind: "group" };

/** A tree with one node changed, or removed when `change` gives null. */
function changed(group: Group, id: number, change: (node: ConditionNode) => ConditionNode | null): Group {
  const items = group.items.flatMap((item): ConditionNode[] => {
    if (item.id === id) {
      const next = change(item);
      return next ? [next] : [];
    }
    return item.kind === "group" ? [changed(item, id, change)] : [item];
  });
  return group.id === id ? ((change(group) as Group | null) ?? { ...group, items: [] }) : { ...group, items };
}

/** A condition on the first column, with the first operator of its type. */
function newCondition(columns: readonly Column[]): ConditionNode {
  const column = columns[0];
  return {
    kind: "condition",
    id: nodeId(),
    column: column?.name ?? "",
    filter: { kind: "condition", operator: column ? operatorsFor(column.type)[0] : "eq", first: "", second: "" },
  };
}

/** An expression as a formula (§4.11), or its JSON when it has none. */
function expressionText(expr: Expr): string {
  try {
    return formulaText(expr);
  } catch {
    return JSON.stringify(expr);
  }
}

interface NodeProps {
  node: ConditionNode;
  columns: readonly Column[];
  invalid: number | null;
  messages: GridMessages;
  onChange: (id: number, change: (node: ConditionNode) => ConditionNode | null) => void;
}

/** A condition: its column, operator and texts. */
function ConditionRow({ node, columns, invalid, messages, onChange }: NodeProps & { node: { kind: "condition" } }) {
  const column = columns.find((item) => item.name === node.column);
  const operators = column ? operatorsFor(column.type) : [];
  const { operator, first, second } = node.filter;
  // Changes apply to the node as the draft holds it when they apply.
  const set = (filter: Partial<typeof node.filter>) =>
    onChange(node.id, (current) =>
      current.kind === "condition" ? { ...current, filter: { ...current.filter, ...filter } } : current,
    );
  return (
    <li className="vg-conditions__row">
      <select
        className="vg-input"
        aria-label={messages.conditionColumn}
        value={node.column}
        onChange={(event) => {
          const next = columns.find((item) => item.name === event.target.value);
          if (!next) return;
          const kept = operatorsFor(next.type).includes(operator) ? operator : operatorsFor(next.type)[0];
          onChange(node.id, (current) =>
            current.kind === "condition"
              ? { ...current, column: next.name, filter: { ...current.filter, operator: kept } }
              : current,
          );
        }}
      >
        {columns.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name}
          </option>
        ))}
      </select>
      <select
        className="vg-input"
        aria-label={messages.condition}
        value={operator}
        onChange={(event) => set({ operator: event.target.value as FilterOperator })}
      >
        {operators.map((item) => (
          <option key={item} value={item}>
            {messages.operators[item]}
          </option>
        ))}
      </select>
      {!takesNoValue(operator) && (
        <input
          className="vg-input"
          aria-label={operator === "between" ? messages.minimum : messages.value}
          placeholder={operator === "between" ? messages.minimum : messages.value}
          aria-invalid={invalid === node.id}
          value={first}
          onChange={(event) => set({ first: event.target.value })}
        />
      )}
      {operator === "between" && (
        <input
          className="vg-input"
          aria-label={messages.maximum}
          placeholder={messages.maximum}
          aria-invalid={invalid === node.id}
          value={second}
          onChange={(event) => set({ second: event.target.value })}
        />
      )}
      <button
        type="button"
        className="vg-button vg-button--small"
        aria-label={messages.removeCondition}
        onClick={() => onChange(node.id, () => null)}
      >
        ×
      </button>
    </li>
  );
}

/** A group: whether all of its items hold or one of them, its items, and buttons that add to it. */
function GroupBlock({ node, columns, invalid, messages, onChange, top }: NodeProps & { node: Group; top?: boolean }) {
  return (
    <fieldset className={top ? "vg-conditions__group vg-conditions__group--top" : "vg-conditions__group"}>
      <legend>
        <select
          className="vg-input"
          aria-label={messages.matchLabel}
          value={node.op}
          onChange={(event) => {
            const op = event.target.value as "and" | "or";
            onChange(node.id, (current) => (current.kind === "group" ? { ...current, op } : current));
          }}
        >
          <option value="and">{messages.matchAll}</option>
          <option value="or">{messages.matchAny}</option>
        </select>
      </legend>
      {node.items.length === 0 && top && <p className="vg-filter__note">{messages.noConditions}</p>}
      <ul className="vg-conditions__items">
        {node.items.map((item) =>
          item.kind === "group" ? (
            <li key={item.id}>
              <GroupBlock node={item} columns={columns} invalid={invalid} messages={messages} onChange={onChange} />
            </li>
          ) : item.kind === "condition" ? (
            <ConditionRow
              key={item.id}
              node={item}
              columns={columns}
              invalid={invalid}
              messages={messages}
              onChange={onChange}
            />
          ) : (
            <li key={item.id} className="vg-conditions__row">
              <code className="vg-conditions__expression">{expressionText(item.expr)}</code>
              <button
                type="button"
                className="vg-button vg-button--small"
                aria-label={messages.removeCondition}
                onClick={() => onChange(item.id, () => null)}
              >
                ×
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="vg-conditions__add">
        <button
          type="button"
          className="vg-button vg-button--small"
          onClick={() => {
            const added = newCondition(columns);
            onChange(node.id, (current) =>
              current.kind === "group" ? { ...current, items: [...current.items, added] } : current,
            );
          }}
        >
          {messages.addCondition}
        </button>
        <button
          type="button"
          className="vg-button vg-button--small"
          onClick={() => {
            const added: ConditionNode = {
              kind: "group",
              id: nodeId(),
              op: node.op === "and" ? "or" : "and",
              items: [newCondition(columns)],
            };
            onChange(node.id, (current) =>
              current.kind === "group" ? { ...current, items: [...current.items, added] } : current,
            );
          }}
        >
          {messages.addGroup}
        </button>
        {!top && (
          <button type="button" className="vg-button vg-button--small" onClick={() => onChange(node.id, () => null)}>
            {messages.removeGroup}
          </button>
        )}
      </div>
    </fieldset>
  );
}

/**
 * The content of the toolbar's conditions menu (§6.2.1 of the specification): every condition of the plan, those
 * across columns included, as groups of conditions that all hold or one of which holds, nested. It reads `where`
 * when it opens, and applying dispatches `filter.set`, which keeps the search. Expressions that it does not take
 * apart are shown as formulas and kept, or removed. The toolbar loads it when the menu first opens.
 */
export default function ConditionsPanel({ close }: { close: () => void }) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const table = useGridSelector((snapshot) => snapshot.table);
  const plan = useGridSelector((snapshot) => snapshot.document.plan);
  // The conditions as they are when the menu opens, an agent's or the column menu's included.
  const [draft, setDraft] = useState<Group>(() => readConditions(store.getSnapshot().document.plan?.where));
  const [invalid, setInvalid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startApply] = useTransition();
  if (!table) return null;
  const columns = rowColumns(plan, table);

  const apply = (group: Group) => {
    let where: Expr | null;
    try {
      where = writeConditions(group, columns);
    } catch (failure) {
      if (!(failure instanceof ConditionError)) throw failure;
      setInvalid(failure.node);
      setError(messages.invalidCondition);
      return;
    }
    startApply(async () => {
      const outcome = await store.dispatch({ command: "filter.set", where });
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      setInvalid(null);
      setError(null);
      close();
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        apply(draft);
      }}
    >
      <GroupBlock
        top
        node={draft}
        columns={columns}
        invalid={invalid}
        messages={messages}
        onChange={(target, change) => setDraft((current) => changed(current, target, change))}
      />
      {error !== null && (
        <p role="alert" className="vg-filter__error">
          {error}
        </p>
      )}
      <div className="vg-filter__actions">
        <button type="button" className="vg-button" disabled={pending} onClick={() => apply({ ...draft, items: [] })}>
          {messages.clearConditions}
        </button>
        <button type="submit" className="vg-button vg-button--primary" disabled={pending}>
          {messages.apply}
        </button>
      </div>
    </form>
  );
}
