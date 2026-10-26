import { type FormEvent, use, useState, useTransition } from "react";
import {
  type Column,
  type ColumnFormat,
  type ColumnSetting,
  columnsOf,
  type Expr,
  formulaText,
  joinParts,
  type NumberFormat,
  partsOf,
  type StyleRule,
} from "vastgrid-spec";
import {
  type ColumnFilter,
  type FilterOperator,
  FilterTextError,
  filterParts,
  operatorsFor,
  readFilter,
  takesNoValue,
} from "../core/filters.js";
import { isNumeric } from "../core/format.js";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

const TEMPORAL = new Set(["date", "time", "timestamp", "timestamptz"]);

/** A style rule as the form edits it: a condition on one column, or a `when` it does not take apart. */
interface RuleDraft {
  id: number;
  column: string;
  filter: ColumnFilter & { kind: "condition" };
  /** A `when` that is not one condition on one column: kept as it is. */
  kept?: Expr;
  color: string | null;
  background: string | null;
  description: string;
}

let nextRule = 1;

function ruleId() {
  return nextRule++;
}

function draftOf(rule: StyleRule, fallback: string): RuleDraft {
  const names = columnsOf(rule.when);
  const [name] = names;
  const read = names.size === 1 ? readFilter(partsOf(rule.when), name) : null;
  const filter =
    read !== null && read !== "other" && read.kind === "condition"
      ? read
      : ({ kind: "condition", operator: "eq", first: "", second: "" } as const);
  return {
    id: ruleId(),
    column: read !== null && read !== "other" && read.kind === "condition" ? name : fallback,
    filter,
    ...(read !== null && read !== "other" && read.kind === "condition" ? {} : { kept: rule.when }),
    color: rule.color ?? null,
    background: rule.background ?? null,
    description: rule.description ?? "",
  };
}

/** The `when` of a rule, or null when its text is not a value of its column; undefined without text. */
function whenOf(rule: RuleDraft, columns: readonly Column[]): Expr | null | undefined {
  if (rule.kept) return rule.kept;
  const column = columns.find((item) => item.name === rule.column);
  if (!column) return undefined;
  try {
    return joinParts(filterParts(rule.filter, column));
  } catch (error) {
    if (error instanceof FilterTextError) return null;
    throw error;
  }
}

/** Whether Intl formats a currency code. */
function knownCurrency(code: string) {
  try {
    new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

function formulaOf(expr: Expr) {
  try {
    return formulaText(expr);
  } catch {
    return JSON.stringify(expr);
  }
}

/**
 * A column's format (§5.1 of the specification): its label, alignment and wrapping, the number or date format of its
 * type, and rules of conditional colors, each a condition on a column of the view with a text color, a background
 * and what they mean. Applying dispatches `column.format`; Clear removes the format.
 */
export function FormatForm({
  column,
  setting,
  onDone,
}: {
  column: Column;
  setting: ColumnSetting;
  onDone: () => void;
}) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const view = useGridSelector((snapshot) => snapshot.view?.columns ?? []);
  const format = setting.format ?? {};
  const [label, setLabel] = useState(format.label ?? "");
  const [align, setAlign] = useState<ColumnFormat["align"] | "">(format.align ?? "");
  const [wrap, setWrap] = useState(format.wrap === true);
  const [style, setStyle] = useState<NumberFormat["style"] | "">(
    format.number ? (format.number.style ?? "decimal") : "",
  );
  const [currency, setCurrency] = useState(format.number?.currency ?? "");
  const [digits, setDigits] = useState(
    format.number?.fractionDigits === undefined ? "" : String(format.number.fractionDigits),
  );
  const [grouping, setGrouping] = useState(format.number?.grouping !== false);
  const [pattern, setPattern] = useState(format.date?.pattern ?? "");
  const [rules, setRules] = useState(() => (format.styles ?? []).map((rule) => draftOf(rule, column.name)));
  const [error, setError] = useState<string | null>(null);
  const [pending, startApply] = useTransition();
  const numeric = isNumeric(column);
  const temporal = TEMPORAL.has(column.type);

  const dispatch = (next: ColumnFormat | null) =>
    startApply(async () => {
      const outcome = await store.dispatch({ command: "column.format", name: column.name, format: next });
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      onDone();
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (style === "currency" && !knownCurrency(currency)) {
      setError(messages.invalidCurrency);
      return;
    }
    const styles: StyleRule[] = [];
    for (const rule of rules) {
      const when = whenOf(rule, view);
      if (when === null) {
        setError(messages.invalidCondition);
        return;
      }
      if (when === undefined || (!rule.color && !rule.background)) continue;
      styles.push({
        when,
        ...(rule.color ? { color: rule.color } : {}),
        ...(rule.background ? { background: rule.background } : {}),
        ...(rule.description.trim() ? { description: rule.description.trim() } : {}),
      });
    }
    const fraction = digits.trim() === "" ? undefined : Math.min(20, Math.max(0, Math.round(Number(digits))));
    const number: NumberFormat | undefined =
      numeric && style
        ? {
            style,
            ...(style === "currency" ? { currency: currency.toUpperCase() } : {}),
            ...(fraction === undefined || Number.isNaN(fraction) ? {} : { fractionDigits: fraction }),
            ...(grouping ? {} : { grouping: false }),
          }
        : undefined;
    const next: ColumnFormat = {
      ...format,
      ...(label.trim() ? { label: label.trim() } : { label: undefined }),
      align: align === "" ? undefined : align,
      wrap: wrap ? true : undefined,
      number: numeric ? number : format.number,
      date: temporal ? (pattern.trim() ? { ...format.date, pattern: pattern.trim() } : undefined) : format.date,
      styles: styles.length > 0 ? styles : undefined,
    };
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as ColumnFormat;
    dispatch(Object.keys(cleaned).length > 0 ? cleaned : null);
  };

  const change = (id: number, patch: Partial<RuleDraft>) =>
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  return (
    <form className="vg-filter vg-format" onSubmit={submit} aria-label={messages.formatOf(column.name)}>
      <p className="vg-filter__title">{messages.formatOf(column.name)}</p>
      <label className="vg-format__field">
        <span>{messages.columnLabel}</span>
        <input
          className="vg-input"
          value={label}
          placeholder={column.name}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="vg-format__field">
        <span>{messages.alignment}</span>
        <select className="vg-input" value={align} onChange={(event) => setAlign(event.target.value as typeof align)}>
          <option value="">{messages.alignments.auto}</option>
          <option value="left">{messages.alignments.left}</option>
          <option value="center">{messages.alignments.center}</option>
          <option value="right">{messages.alignments.right}</option>
        </select>
      </label>
      <label className="vg-filter__value">
        <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
        <span>{messages.wrapText}</span>
      </label>
      {numeric && (
        <fieldset className="vg-format__group">
          <legend>{messages.numberFormat}</legend>
          <select
            className="vg-input"
            aria-label={messages.numberFormat}
            value={style}
            onChange={(event) => setStyle(event.target.value as typeof style)}
          >
            <option value="">{messages.numberStyles.none}</option>
            <option value="decimal">{messages.numberStyles.decimal}</option>
            <option value="percent">{messages.numberStyles.percent}</option>
            <option value="currency">{messages.numberStyles.currency}</option>
          </select>
          {style === "currency" && (
            <input
              className="vg-input"
              aria-label={messages.currency}
              placeholder="JPY"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            />
          )}
          {style !== "" && (
            <>
              <input
                className="vg-input"
                type="number"
                min={0}
                max={20}
                aria-label={messages.fractionDigits}
                placeholder={messages.fractionDigits}
                value={digits}
                onChange={(event) => setDigits(event.target.value)}
              />
              <label className="vg-filter__value">
                <input type="checkbox" checked={grouping} onChange={(event) => setGrouping(event.target.checked)} />
                <span>{messages.grouping}</span>
              </label>
            </>
          )}
        </fieldset>
      )}
      {temporal && (
        <label className="vg-format__field">
          <span>{messages.datePattern}</span>
          <input
            className="vg-input"
            placeholder="yyyy/MM/dd HH:mm"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
        </label>
      )}
      <fieldset className="vg-format__group">
        <legend>{messages.conditionalColors}</legend>
        {rules.map((rule) => {
          const target = view.find((item) => item.name === rule.column);
          const operators = target ? operatorsFor(target.type) : [];
          return (
            <div key={rule.id} className="vg-format__rule">
              {rule.kept ? (
                <code className="vg-conditions__expression">{formulaOf(rule.kept)}</code>
              ) : (
                <div className="vg-conditions__row">
                  <select
                    className="vg-input"
                    aria-label={messages.conditionColumn}
                    value={rule.column}
                    onChange={(event) => {
                      const next = view.find((item) => item.name === event.target.value);
                      if (!next) return;
                      const kinds = operatorsFor(next.type);
                      const operator = kinds.includes(rule.filter.operator) ? rule.filter.operator : kinds[0];
                      change(rule.id, { column: next.name, filter: { ...rule.filter, operator } });
                    }}
                  >
                    {view.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="vg-input"
                    aria-label={messages.condition}
                    value={rule.filter.operator}
                    onChange={(event) =>
                      change(rule.id, { filter: { ...rule.filter, operator: event.target.value as FilterOperator } })
                    }
                  >
                    {operators.map((item) => (
                      <option key={item} value={item}>
                        {messages.operators[item]}
                      </option>
                    ))}
                  </select>
                  {!takesNoValue(rule.filter.operator) && (
                    <input
                      className="vg-input"
                      aria-label={rule.filter.operator === "between" ? messages.minimum : messages.value}
                      placeholder={rule.filter.operator === "between" ? messages.minimum : messages.value}
                      value={rule.filter.first}
                      onChange={(event) => change(rule.id, { filter: { ...rule.filter, first: event.target.value } })}
                    />
                  )}
                  {rule.filter.operator === "between" && (
                    <input
                      className="vg-input"
                      aria-label={messages.maximum}
                      placeholder={messages.maximum}
                      value={rule.filter.second}
                      onChange={(event) => change(rule.id, { filter: { ...rule.filter, second: event.target.value } })}
                    />
                  )}
                </div>
              )}
              <div className="vg-conditions__row">
                <label className="vg-filter__value">
                  <input
                    type="checkbox"
                    checked={rule.color !== null}
                    onChange={(event) => change(rule.id, { color: event.target.checked ? "#b42318" : null })}
                  />
                  <span>{messages.textColor}</span>
                </label>
                {rule.color !== null && (
                  <input
                    type="color"
                    aria-label={messages.textColor}
                    value={rule.color}
                    onChange={(event) => change(rule.id, { color: event.target.value })}
                  />
                )}
                <label className="vg-filter__value">
                  <input
                    type="checkbox"
                    checked={rule.background !== null}
                    onChange={(event) => change(rule.id, { background: event.target.checked ? "#fde68a" : null })}
                  />
                  <span>{messages.backgroundColor}</span>
                </label>
                {rule.background !== null && (
                  <input
                    type="color"
                    aria-label={messages.backgroundColor}
                    value={rule.background}
                    onChange={(event) => change(rule.id, { background: event.target.value })}
                  />
                )}
              </div>
              <div className="vg-conditions__row">
                <input
                  className="vg-input"
                  aria-label={messages.ruleDescription}
                  placeholder={messages.ruleDescription}
                  value={rule.description}
                  onChange={(event) => change(rule.id, { description: event.target.value })}
                />
                <button
                  type="button"
                  className="vg-button vg-button--small"
                  aria-label={messages.removeRule}
                  onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className="vg-button vg-button--small"
          onClick={() =>
            setRules((current) => [
              ...current,
              {
                id: ruleId(),
                column: column.name,
                filter: { kind: "condition", operator: operatorsFor(column.type)[0], first: "", second: "" },
                color: null,
                background: "#fde68a",
                description: "",
              },
            ])
          }
        >
          {messages.addRule}
        </button>
      </fieldset>
      {error !== null && (
        <p role="alert" className="vg-filter__error">
          {error}
        </p>
      )}
      <div className="vg-filter__actions">
        <button type="button" className="vg-button" disabled={pending} onClick={() => dispatch(null)}>
          {messages.clearFormat}
        </button>
        <button type="submit" className="vg-button vg-button--primary" disabled={pending}>
          {messages.apply}
        </button>
      </div>
    </form>
  );
}
