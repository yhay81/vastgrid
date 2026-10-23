import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import {
  type CellValue,
  type ColumnFormatter,
  type ColumnSchema,
  type ColumnType,
  type DistinctValues,
  type Filter,
  isAbortError,
  isNumericType,
  isTemporalType,
  plainText,
} from "vastgrid-core";
import type { Messages } from "../messages.js";

type Operator = keyof Messages["operators"] | "none";

const numericOperators: Operator[] = ["none", "eq", "ne", "gt", "ge", "lt", "le", "between", "blank", "notBlank"];
const textOperators: Operator[] = [
  "none",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "equals",
  "notEquals",
  "blank",
  "notBlank",
];

const NULL_KEY = "\u0000null";

function keyOf(value: CellValue) {
  return value === null ? NULL_KEY : plainText(value);
}

function initialCondition(filter: Filter | null): { operator: Operator; first: string; second: string } {
  if (!filter) return { operator: "none", first: "", second: "" };
  switch (filter.type) {
    case "compare":
      return { operator: filter.op, first: plainText(filter.value), second: "" };
    case "between":
      return {
        operator: "between",
        first: filter.min === undefined ? "" : plainText(filter.min),
        second: filter.max === undefined ? "" : plainText(filter.max),
      };
    case "text":
      return { operator: filter.op, first: filter.value, second: "" };
    case "blank":
      return { operator: filter.blank ? "blank" : "notBlank", first: "", second: "" };
    default:
      return { operator: "none", first: "", second: "" };
  }
}

/**
 * Converts typed text for a numeric column into a number when it is one. Decimals and integers that a
 * JavaScript number cannot hold exactly (beyond 2^53) stay text, which servers compare exactly.
 */
export function comparable(text: string, type: ColumnType): string | number {
  if (!isNumericType(type)) return text;
  const digits = text.trim().replaceAll(",", "");
  const number = Number(digits);
  if (digits === "" || !Number.isFinite(number)) return text;
  if (type === "decimal" || (/^[+-]?\d+$/.test(digits) && !Number.isSafeInteger(number))) return digits;
  return number;
}

/**
 * The filter for one column, in the manner of spreadsheet filters: a searchable list of values with
 * check boxes, or a condition (comparison, text match, range, blank).
 */
export function FilterPanel({
  column,
  schema,
  filter,
  messages,
  formatter,
  count,
  load,
  onApply,
}: {
  column: number;
  schema: ColumnSchema;
  filter: Filter | null;
  messages: Messages;
  formatter: ColumnFormatter;
  count: (value: number) => string;
  load: (search: string, signal: AbortSignal) => Promise<DistinctValues> | null;
  onApply: (filter: Filter | null) => void;
}) {
  const id = useId();
  const numeric = isNumericType(schema.type) || isTemporalType(schema.type);
  const operators = numeric
    ? numericOperators
    : schema.type === "boolean"
      ? (["none", "blank", "notBlank"] as Operator[])
      : textOperators;
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<DistinctValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Untouched values follow `base`; `toggled` holds the values the user changed.
  const [base, setBase] = useState(() => !(filter?.type === "values" && !filter.exclude));
  const [toggled, setToggled] = useState<Map<string, CellValue>>(() => {
    if (filter?.type !== "values") return new Map();
    return new Map(filter.values.map((value) => [keyOf(value), value]));
  });
  const [condition, setCondition] = useState(() => initialCondition(filter));

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setLoading(true);
        const request = load(search, controller.signal);
        if (!request) {
          setLoading(false);
          return;
        }
        request
          .then((result) => {
            if (controller.signal.aborted) return;
            setValues(result);
            setError(null);
            setLoading(false);
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted || isAbortError(cause)) return;
            setError(cause instanceof Error ? cause.message : String(cause));
            setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, search]);

  const isChecked = (value: CellValue) => (toggled.has(keyOf(value)) ? !base : base);
  const shown = values?.values ?? [];
  const allChecked = toggled.size === 0 ? base : shown.every((item) => isChecked(item.value)) && base;

  function toggle(value: CellValue) {
    setToggled((current) => {
      const next = new Map(current);
      const key = keyOf(value);
      if (next.has(key)) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  function selectAll(checked: boolean) {
    setBase(checked);
    setToggled(new Map());
  }

  const valuesFilter = useMemo((): Filter | null => {
    const list = [...toggled.values()];
    if (base && list.length === 0) return null;
    if (base) return { type: "values", column, values: list, exclude: true };
    return { type: "values", column, values: list };
  }, [base, toggled, column]);

  function conditionFilter(): Filter | null {
    const { operator, first, second } = condition;
    switch (operator) {
      case "none":
        return null;
      case "blank":
      case "notBlank":
        return { type: "blank", column, blank: operator === "blank" };
      case "between":
        if (!first && !second) return null;
        return {
          type: "between",
          column,
          ...(first ? { min: comparable(first, schema.type) } : {}),
          ...(second ? { max: comparable(second, schema.type) } : {}),
        };
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
        return first === "" ? null : { type: "compare", column, op: operator, value: comparable(first, schema.type) };
      default:
        return first === "" ? null : { type: "text", column, op: operator, value: first };
    }
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    onApply(condition.operator === "none" ? valuesFilter : conditionFilter());
  }

  const needsValue =
    condition.operator !== "none" && condition.operator !== "blank" && condition.operator !== "notBlank";

  return (
    <form className="vg-filter" onSubmit={apply}>
      <p className="vg-panel__title" id={`${id}-title`}>
        {messages.filterBy(formatter.label)}
      </p>
      <input
        type="search"
        className="vg-input"
        placeholder={messages.valuesSearch}
        aria-label={messages.valuesSearch}
        value={search}
        data-autofocus
        onChange={(event) => setSearch(event.target.value)}
        disabled={condition.operator !== "none"}
      />
      <fieldset className="vg-filter__values" aria-labelledby={`${id}-title`} aria-busy={loading}>
        {!search && (
          <label className="vg-check vg-check--all">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(event) => selectAll(event.target.checked)}
              disabled={condition.operator !== "none"}
            />
            <span>{messages.selectAll}</span>
          </label>
        )}
        {shown.map((item) => (
          <label className="vg-check" key={keyOf(item.value)}>
            <input
              type="checkbox"
              checked={isChecked(item.value)}
              onChange={() => toggle(item.value)}
              disabled={condition.operator !== "none"}
            />
            <span className="vg-check__label">
              {item.value === null || item.value === "" ? messages.blank : formatter.format(item.value)}
            </span>
            <span className="vg-check__count">{count(item.count)}</span>
          </label>
        ))}
        {loading && shown.length === 0 && <p className="vg-panel__muted">{messages.loading}</p>}
        {error && <p className="vg-panel__error">{error}</p>}
      </fieldset>
      {values?.truncated && <p className="vg-panel__muted">{messages.valuesTruncated(count(shown.length))}</p>}
      <fieldset className="vg-filter__condition">
        <legend>{messages.condition}</legend>
        <select
          className="vg-input"
          aria-label={messages.condition}
          value={condition.operator}
          onChange={(event) => setCondition({ ...condition, operator: event.target.value as Operator })}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {operator === "none" ? messages.conditionNone : messages.operators[operator]}
            </option>
          ))}
        </select>
        {needsValue && (
          <input
            className="vg-input"
            aria-label={condition.operator === "between" ? messages.minimum : messages.value}
            placeholder={condition.operator === "between" ? messages.minimum : messages.value}
            value={condition.first}
            onChange={(event) => setCondition({ ...condition, first: event.target.value })}
          />
        )}
        {condition.operator === "between" && (
          <input
            className="vg-input"
            aria-label={messages.maximum}
            placeholder={messages.maximum}
            value={condition.second}
            onChange={(event) => setCondition({ ...condition, second: event.target.value })}
          />
        )}
      </fieldset>
      <div className="vg-panel__actions">
        <button type="button" className="vg-button" onClick={() => onApply(null)}>
          {messages.clear}
        </button>
        <button type="submit" className="vg-button vg-button--primary">
          {messages.apply}
        </button>
      </div>
    </form>
  );
}
