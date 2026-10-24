import { type FormEvent, useId, useState } from "react";
import {
  AGGREGATE_FUNCTIONS,
  type AggregateFunction,
  aggregateApplies,
  type ColumnSchema,
  type GroupAggregate,
  isGroupableType,
  MAX_GROUP_AGGREGATES,
  MAX_GROUP_KEYS,
} from "vastgrid-core";
import type { Messages } from "../messages.js";

/** The grouping being edited: schema indexes of the keys, and the aggregates. */
export interface GroupDraft {
  keys: number[];
  aggregates: GroupAggregate[];
}

/** Value of the column select that counts rows instead of a column's values. */
const ROWS = "rows";

/** The first column an aggregate applies to, or none for counting rows. */
function columnFor(fn: AggregateFunction, schema: ColumnSchema[], current?: number) {
  if (current !== undefined && schema[current] && aggregateApplies(fn, schema[current].type)) return current;
  if (fn === "count") return undefined;
  const index = schema.findIndex((column) => aggregateApplies(fn, column.type));
  return index < 0 ? undefined : index;
}

/**
 * Picks the columns to group rows by and the aggregates to compute for each group. The grid then shows
 * the groups as a table (see `GroupedSource`).
 */
export function GroupPanel({
  schema,
  labelOf,
  messages,
  initial,
  grouped,
  pending,
  error,
  onApply,
  onUngroup,
  onCancel,
}: {
  schema: ColumnSchema[];
  labelOf: (index: number) => string;
  messages: Messages;
  initial: GroupDraft | null;
  /** The grid shows groups now: the panel offers to show the rows again. */
  grouped: boolean;
  pending: boolean;
  error: string | null;
  onApply: (draft: GroupDraft) => void;
  onUngroup: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [keys, setKeys] = useState<number[]>(initial?.keys ?? []);
  const [aggregates, setAggregates] = useState<GroupAggregate[]>(initial?.aggregates ?? [{ fn: "count" }]);
  const empty = keys.length === 0 && aggregates.length === 0;
  const columns = schema.map((column, index) => ({ column, index }));

  function toggleKey(index: number, checked: boolean) {
    setKeys((current) => (checked ? [...current, index] : current.filter((key) => key !== index)));
  }

  function setAggregate(position: number, aggregate: GroupAggregate | null) {
    setAggregates((current) =>
      aggregate === null
        ? current.filter((_, at) => at !== position)
        : current.map((item, at) => (at === position ? aggregate : item)),
    );
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    if (empty) return;
    onApply({ keys, aggregates });
  }

  return (
    <form className="vg-group" onSubmit={apply} aria-labelledby={`${id}-title`}>
      <p className="vg-panel__title" id={`${id}-title`}>
        {messages.groupTitle}
      </p>
      <fieldset className="vg-export__group">
        <legend className="vg-export__legend">{messages.groupKeys}</legend>
        <div className="vg-filter__values">
          {columns.map(({ column, index }) =>
            isGroupableType(column.type) ? (
              <label className="vg-check" key={index}>
                <input
                  type="checkbox"
                  checked={keys.includes(index)}
                  disabled={!keys.includes(index) && keys.length >= MAX_GROUP_KEYS}
                  onChange={(event) => toggleKey(index, event.target.checked)}
                />
                <span className="vg-check__label">{labelOf(index)}</span>
                {/* The order in which columns were picked is the order of the keys. */}
                <span className="vg-check__count">{keys.includes(index) ? keys.indexOf(index) + 1 : ""}</span>
              </label>
            ) : null,
          )}
        </div>
      </fieldset>
      <fieldset className="vg-export__group">
        <legend className="vg-export__legend">{messages.groupValues}</legend>
        <ul className="vg-builder__list">
          {aggregates.map((aggregate, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: aggregates have no identity of their own.
            <li className="vg-builder__leaf" key={position}>
              <select
                className="vg-input"
                aria-label={messages.groupFunction}
                value={aggregate.fn}
                onChange={(event) => {
                  const fn = event.target.value as AggregateFunction;
                  const column = columnFor(fn, schema, aggregate.column);
                  setAggregate(position, column === undefined ? { fn: "count" } : { fn, column });
                }}
              >
                {AGGREGATE_FUNCTIONS.map((fn) => (
                  <option key={fn} value={fn} disabled={columnFor(fn, schema) === undefined && fn !== "count"}>
                    {messages.aggregateNames[fn]}
                  </option>
                ))}
              </select>
              <select
                className="vg-input"
                aria-label={messages.conditionColumn}
                value={aggregate.column === undefined ? ROWS : String(aggregate.column)}
                onChange={(event) => {
                  const value = event.target.value;
                  setAggregate(
                    position,
                    value === ROWS ? { fn: "count" } : { fn: aggregate.fn, column: Number(value) },
                  );
                }}
              >
                {aggregate.fn === "count" && <option value={ROWS}>{messages.groupRows}</option>}
                {columns.map(({ column, index }) =>
                  aggregateApplies(aggregate.fn, column.type) ? (
                    <option key={index} value={index}>
                      {labelOf(index)}
                    </option>
                  ) : null,
                )}
              </select>
              <button
                type="button"
                className="vg-chip__remove"
                aria-label={messages.removeValue}
                title={messages.removeValue}
                onClick={() => setAggregate(position, null)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="vg-builder__add">
          <button
            type="button"
            className="vg-button vg-button--small"
            disabled={aggregates.length >= MAX_GROUP_AGGREGATES}
            onClick={() => setAggregates((current) => [...current, { fn: "count" }])}
          >
            + {messages.addValue}
          </button>
        </div>
      </fieldset>
      {error && (
        <p className="vg-panel__error" role="alert">
          {error}
        </p>
      )}
      <div className="vg-panel__actions">
        {grouped && (
          <button type="button" className="vg-button" onClick={onUngroup}>
            {messages.ungroup}
          </button>
        )}
        <span className="vg-toolbar__spacer" />
        <button type="button" className="vg-button" onClick={onCancel}>
          {messages.cancel}
        </button>
        <button type="submit" className="vg-button vg-button--primary" disabled={empty || pending}>
          {pending ? messages.grouping : messages.apply}
        </button>
      </div>
    </form>
  );
}
