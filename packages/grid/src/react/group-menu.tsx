import { use, useState, useTransition } from "react";
import { type Aggregate, type GridCommand, MEASURES, type MeasureName, measureTakes } from "vastgrid-spec";
import { measureName, offers, rowColumns } from "../core/measures.js";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** The measures the menu offers; `quantile` needs a `p`, which it does not ask for. */
const OFFERED = MEASURES.filter((fn) => fn !== "quantile");

/**
 * The content of the toolbar's group menu, loaded when it first opens (§6.2 of the specification): the columns that the rows are grouped by and the measures of
 * each group (§4.5), each change dispatched as `group.set` with the whole aggregate, or `group.clear` when nothing is
 * left. It is there when the engine groups rows.
 */
export default function GroupPanel() {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const table = useGridSelector((snapshot) => snapshot.table);
  const plan = useGridSelector((snapshot) => snapshot.document.plan);
  const [fn, setFn] = useState<MeasureName>("sum");
  const [column, setColumn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startDispatch] = useTransition();
  if (!table || !offers(table.capabilities, "count")) return null;

  const aggregate: Aggregate = plan?.aggregate ?? { keys: [], measures: [] };
  const rows = rowColumns(plan, table);
  const measures = OFFERED.filter((name) => offers(table.capabilities, name));
  const columnsFor = (name: MeasureName) => rows.filter((item) => measureTakes(name, item));
  const target = column === "" ? undefined : rows.find((item) => item.name === column);
  const canAdd = target ? measureTakes(fn, target) : fn === "count";

  const dispatch = (command: GridCommand) =>
    startDispatch(async () => {
      const outcome = await store.dispatch(command);
      setError(outcome.ok ? null : outcome.error.message);
    });
  const set = (next: Aggregate) =>
    dispatch(
      next.keys.length === 0 && next.measures.length === 0
        ? { command: "group.clear" }
        : { command: "group.set", aggregate: next },
    );
  const pivots = table.capabilities.plan?.pivot !== false;
  const pivot = aggregate.pivot?.columns ?? [];
  // A pivot makes a column per value of its columns and measure (§4.6), so it needs a measure: rows are counted.
  const setPivot = (columns: string[]) => {
    const { pivot: _pivot, ...rest } = aggregate;
    const measures =
      columns.length > 0 && rest.measures.length === 0
        ? [{ name: measureName("count", undefined, new Set(rest.keys)), fn: "count" as const }]
        : rest.measures;
    set(columns.length > 0 ? { ...rest, measures, pivot: { columns } } : rest);
  };
  const taken = () => new Set([...aggregate.keys, ...aggregate.measures.map((measure) => measure.name)]);
  const addMeasure = () => {
    if (!canAdd) return;
    const name = measureName(fn, target?.name, taken());
    set({ ...aggregate, measures: [...aggregate.measures, { name, fn, ...(target ? { column: target.name } : {}) }] });
  };

  return (
    <>
      <fieldset className="vg-groups__part" disabled={pending}>
        <legend>{messages.groupKeys}</legend>
        <ul className="vg-groups__list">
          {aggregate.keys.map((key) => (
            <li key={key}>
              <span>{key}</span>
              <button
                type="button"
                className="vg-button vg-button--small"
                aria-label={messages.remove(key)}
                onClick={() => set({ ...aggregate, keys: aggregate.keys.filter((other) => other !== key) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <select
          className="vg-input"
          aria-label={messages.addKey}
          value=""
          onChange={(event) => {
            const key = event.target.value;
            if (!key) return;
            // Rows grouped for the first time are counted.
            const measures = plan?.aggregate
              ? aggregate.measures
              : [{ name: measureName("count", undefined, new Set([key])), fn: "count" as const }];
            set({ ...aggregate, keys: [...aggregate.keys, key], measures });
          }}
        >
          <option value="">{messages.addKey}</option>
          {rows
            // Keys are the columns whose values order (§3.9), as `min` takes them.
            .filter((item) => !aggregate.keys.includes(item.name) && measureTakes("min", item))
            .map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
        </select>
      </fieldset>
      {pivots && (
        <fieldset className="vg-groups__part" disabled={pending}>
          <legend>{messages.pivotBy}</legend>
          <ul className="vg-groups__list">
            {pivot.map((name) => (
              <li key={name}>
                <span>{name}</span>
                <button
                  type="button"
                  className="vg-button vg-button--small"
                  aria-label={messages.remove(name)}
                  onClick={() => setPivot(pivot.filter((other) => other !== name))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <select
            className="vg-input"
            aria-label={messages.pivotBy}
            value=""
            onChange={(event) => {
              if (event.target.value) setPivot([...pivot, event.target.value]);
            }}
          >
            <option value="">{messages.addPivot}</option>
            {rows
              .filter(
                (item) =>
                  !aggregate.keys.includes(item.name) && !pivot.includes(item.name) && measureTakes("min", item),
              )
              .map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
          </select>
        </fieldset>
      )}
      <fieldset className="vg-groups__part" disabled={pending}>
        <legend>{messages.measures}</legend>
        <ul className="vg-groups__list">
          {aggregate.measures.map((measure) => (
            <li key={measure.name}>
              <span>{measure.name}</span>
              <button
                type="button"
                className="vg-button vg-button--small"
                aria-label={messages.remove(measure.name)}
                onClick={() =>
                  set({ ...aggregate, measures: aggregate.measures.filter((other) => other.name !== measure.name) })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="vg-groups__add">
          <select
            className="vg-input"
            aria-label={messages.measures}
            value={fn}
            onChange={(event) => setFn(event.target.value as MeasureName)}
          >
            {measures.map((name) => (
              <option key={name} value={name}>
                {messages.measureNames[name]}
              </option>
            ))}
          </select>
          <select
            className="vg-input"
            aria-label={messages.measureColumn}
            value={column}
            onChange={(event) => setColumn(event.target.value)}
          >
            {fn === "count" && <option value="">{messages.allRows}</option>}
            {fn !== "count" && column === "" && <option value="">{messages.measureColumn}</option>}
            {columnsFor(fn).map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <button type="button" className="vg-button" disabled={!canAdd} onClick={addMeasure}>
            {messages.addMeasure}
          </button>
        </div>
      </fieldset>
      {error !== null && (
        <p role="alert" className="vg-filter__error">
          {error}
        </p>
      )}
      {plan?.aggregate && (
        <button
          type="button"
          className="vg-menu__item"
          disabled={pending}
          onClick={() => dispatch({ command: "group.clear" })}
        >
          {messages.ungroup}
        </button>
      )}
    </>
  );
}
