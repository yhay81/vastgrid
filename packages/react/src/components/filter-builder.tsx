import { type FormEvent, useId, useState } from "react";
import {
  type ColumnFormatter,
  type ColumnSchema,
  type Filter,
  type FilterGroup,
  type FilterNode,
  isFilterGroup,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  pruneFilterNode,
} from "vastgrid-core";
import { filterLabel } from "../labels.js";
import type { Messages } from "../messages.js";
import { type Condition, conditionFilter, initialCondition, type Operator, operatorsFor } from "./filter-panel.js";

/** A condition being edited. A value list (set in a column's filter panel) is kept as it is. */
interface DraftLeaf {
  kind: "leaf";
  key: number;
  column: number;
  condition: Condition;
  values: Extract<Filter, { type: "values" }> | null;
}

interface DraftGroup {
  kind: "group";
  key: number;
  type: FilterGroup["type"];
  children: DraftNode[];
}

type DraftNode = DraftLeaf | DraftGroup;

let nextKey = 1;

function leafOf(filter: Filter): DraftLeaf {
  return {
    kind: "leaf",
    key: nextKey++,
    column: filter.column,
    condition: initialCondition(filter),
    values: filter.type === "values" ? filter : null,
  };
}

function draftOf(node: FilterNode): DraftNode {
  if (!isFilterGroup(node)) return leafOf(node);
  return { kind: "group", key: nextKey++, type: node.type, children: node.filters.map(draftOf) };
}

/** A new condition on a column, with the first operator its type offers. */
function newLeaf(schema: ColumnSchema[], column: number): DraftLeaf {
  const type = schema[column]?.type ?? "string";
  return { kind: "leaf", key: nextKey++, column, condition: emptyCondition(operatorsFor(type)[1]), values: null };
}

function emptyCondition(operator: Operator): Condition {
  return { operator, first: "", second: "" };
}

/**
 * The draft the builder opens with. With `combine`, a column's filter panel asked to join its filter
 * (which replaces the column's current filter) and a new condition on the column by AND or OR.
 */
export function initialDraft(
  condition: FilterGroup,
  schema: ColumnSchema[],
  combine?: { column: number; filter: Filter | null; type: FilterGroup["type"] },
): DraftGroup {
  const root = draftOf(condition) as DraftGroup;
  if (!combine) return root;
  const { column, filter, type } = combine;
  root.children = root.children.filter((child) => child.kind === "group" || child.column !== column);
  const added: DraftNode[] = [...(filter ? [leafOf(filter)] : []), newLeaf(schema, column)];
  if (type === "and" || added.length === 1) root.children.push(...added);
  else root.children.push({ kind: "group", key: nextKey++, type: "or", children: added });
  return root;
}

/** The tree a draft makes. Incomplete conditions and groups left without conditions are left out. */
function treeOf(node: DraftNode, schema: ColumnSchema[]): FilterNode | undefined {
  if (node.kind === "leaf") {
    if (node.values) return node.values;
    return conditionFilter(node.column, schema[node.column]?.type ?? "string", node.condition) ?? undefined;
  }
  return pruneFilterNode({
    type: node.type,
    filters: node.children.flatMap((child) => {
      const tree = treeOf(child, schema);
      return tree ? [tree] : [];
    }),
  });
}

function countNodes(node: DraftNode): number {
  return node.kind === "leaf" ? 1 : node.children.reduce((total, child) => total + countNodes(child), 1);
}

/** The draft with the node of `key` replaced by `update`'s result (`null` removes it). */
function replace(node: DraftNode, key: number, update: (node: DraftNode) => DraftNode | null): DraftNode | null {
  if (node.key === key) return update(node);
  if (node.kind === "leaf") return node;
  const children = node.children.flatMap((child) => {
    const next = replace(child, key, update);
    return next ? [next] : [];
  });
  return { ...node, children };
}

/**
 * Builds a condition tree: groups whose conditions must all match (AND) or of which one must match
 * (OR), nested, with any number of conditions per column.
 */
export function FilterBuilder({
  schema,
  initial,
  messages,
  formatterOf,
  onApply,
  onCancel,
}: {
  schema: ColumnSchema[];
  initial: DraftGroup;
  messages: Messages;
  formatterOf: (column: number) => ColumnFormatter;
  onApply: (condition: FilterNode | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [root, setRoot] = useState<DraftGroup>(initial);
  const full = countNodes(root) >= MAX_FILTER_NODES;

  function update(key: number, change: (node: DraftNode) => DraftNode | null) {
    setRoot((current) => (replace(current, key, change) as DraftGroup | null) ?? { ...current, children: [] });
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    onApply(treeOf(root, schema) ?? null);
  }

  function renderLeaf(leaf: DraftLeaf) {
    const type = schema[leaf.column]?.type ?? "string";
    const operators = operatorsFor(type).filter((operator) => operator !== "none");
    const { operator } = leaf.condition;
    const needsValue = !leaf.values && operator !== "blank" && operator !== "notBlank";
    return (
      <li className="vg-builder__leaf" key={leaf.key}>
        <select
          className="vg-input"
          aria-label={messages.conditionColumn}
          value={leaf.column}
          onChange={(event) =>
            // The same key keeps the row and its focus.
            update(leaf.key, () => ({ ...newLeaf(schema, Number(event.target.value)), key: leaf.key }))
          }
        >
          {schema.map((_, index) => (
            // Columns may repeat a name; their position tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: the schema does not change while the builder is open
            <option key={index} value={index}>
              {formatterOf(index).label}
            </option>
          ))}
        </select>
        <select
          className="vg-input"
          aria-label={messages.condition}
          value={leaf.values ? "values" : operator}
          onChange={(event) =>
            update(leaf.key, () => ({
              ...leaf,
              values: null,
              condition: { ...leaf.condition, operator: event.target.value as Operator },
            }))
          }
        >
          {leaf.values && <option value="values">{leaf.values.exclude ? messages.noneOf : messages.oneOf}</option>}
          {operators.map((item) => (
            <option key={item} value={item}>
              {messages.operators[item as keyof Messages["operators"]]}
            </option>
          ))}
        </select>
        {leaf.values && (
          <span className="vg-builder__values" title={filterLabel(leaf.values, formatterOf(leaf.column), messages)}>
            {filterLabel(leaf.values, formatterOf(leaf.column), messages)}
          </span>
        )}
        {needsValue && (
          <input
            className="vg-input"
            aria-label={operator === "between" ? messages.minimum : messages.value}
            placeholder={operator === "between" ? messages.minimum : messages.value}
            value={leaf.condition.first}
            onChange={(event) =>
              update(leaf.key, () => ({ ...leaf, condition: { ...leaf.condition, first: event.target.value } }))
            }
          />
        )}
        {needsValue && operator === "between" && (
          <input
            className="vg-input"
            aria-label={messages.maximum}
            placeholder={messages.maximum}
            value={leaf.condition.second}
            onChange={(event) =>
              update(leaf.key, () => ({ ...leaf, condition: { ...leaf.condition, second: event.target.value } }))
            }
          />
        )}
        <button
          type="button"
          className="vg-chip__remove"
          aria-label={messages.removeCondition}
          title={messages.removeCondition}
          onClick={() => update(leaf.key, () => null)}
        >
          ×
        </button>
      </li>
    );
  }

  function renderGroup(group: DraftGroup, depth: number) {
    const lastColumn = [...group.children].reverse().find((child) => child.kind === "leaf")?.column ?? 0;
    return (
      <fieldset className="vg-builder__group" aria-label={group.type === "and" ? messages.matchAll : messages.matchAny}>
        <div className="vg-builder__head">
          <select
            className="vg-input"
            aria-label={messages.condition}
            value={group.type}
            onChange={(event) =>
              update(group.key, () => ({ ...group, type: event.target.value as DraftGroup["type"] }))
            }
          >
            <option value="and">{messages.matchAll}</option>
            <option value="or">{messages.matchAny}</option>
          </select>
          {depth > 0 && (
            <button
              type="button"
              className="vg-chip__remove"
              aria-label={messages.removeGroup}
              title={messages.removeGroup}
              onClick={() => update(group.key, () => null)}
            >
              ×
            </button>
          )}
        </div>
        {group.children.length === 0 && depth === 0 && <p className="vg-panel__muted">{messages.noConditions}</p>}
        <ul className="vg-builder__list">
          {group.children.map((child) =>
            child.kind === "leaf" ? renderLeaf(child) : <li key={child.key}>{renderGroup(child, depth + 1)}</li>,
          )}
        </ul>
        <div className="vg-builder__add">
          <button
            type="button"
            className="vg-button vg-button--small"
            disabled={full || schema.length === 0}
            onClick={() =>
              update(group.key, () => ({ ...group, children: [...group.children, newLeaf(schema, lastColumn)] }))
            }
          >
            + {messages.addCondition}
          </button>
          <button
            type="button"
            className="vg-button vg-button--small"
            // A new group comes with its first condition.
            disabled={
              full || schema.length === 0 || depth + 1 >= MAX_FILTER_DEPTH || countNodes(root) + 2 > MAX_FILTER_NODES
            }
            onClick={() =>
              update(group.key, () => ({
                ...group,
                children: [
                  ...group.children,
                  {
                    kind: "group",
                    key: nextKey++,
                    type: group.type === "and" ? "or" : "and",
                    children: [newLeaf(schema, lastColumn)],
                  },
                ],
              }))
            }
          >
            + {messages.addGroup}
          </button>
        </div>
      </fieldset>
    );
  }

  return (
    <form className="vg-builder" onSubmit={apply} aria-labelledby={`${id}-title`}>
      <p className="vg-panel__title" id={`${id}-title`}>
        {messages.conditionsTitle}
      </p>
      {renderGroup(root, 0)}
      <div className="vg-panel__actions">
        <button type="button" className="vg-button" onClick={() => onApply(null)}>
          {messages.clear}
        </button>
        <span className="vg-toolbar__spacer" />
        <button type="button" className="vg-button" onClick={onCancel}>
          {messages.cancel}
        </button>
        <button type="submit" className="vg-button vg-button--primary">
          {messages.apply}
        </button>
      </div>
    </form>
  );
}

export type { DraftGroup as FilterDraft };
