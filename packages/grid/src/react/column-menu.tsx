import {
  type FormEvent,
  type KeyboardEvent,
  type ToggleEvent,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  type Column,
  type Expr,
  type GridCommand,
  type JsonValue,
  joinParts,
  measureTakes,
  type SortDirection,
  textOf,
} from "vastgrid-spec";
import {
  type ColumnFilter,
  conditionsOf,
  type FilterOperator,
  FilterTextError,
  filterParts,
  isBlank,
  operatorsFor,
  readFilter,
  takesNoValue,
} from "../core/filters.js";
import { measureName, offers, statisticsOf, TOTALS } from "../core/measures.js";
import { LocaleContext } from "./context.js";
import { FormatForm } from "./format-form.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** Where the column menu opens: a column of the view, at a point of the page. */
export interface MenuTarget {
  column: string;
  x: number;
  y: number;
}

/** The key of a value in the list; blank values (§3.2) share one. */
const BLANK = "\u0000blank";

function keyOf(value: JsonValue, column: Column) {
  return isBlank(value, column) ? BLANK : JSON.stringify(value);
}

/** `filter.column` with the parts of a filter, or null when its text is not a value of the column. */
function filterCommand(filter: ColumnFilter | null, column: Column): GridCommand | null {
  let parts: Expr[] = [];
  try {
    if (filter) parts = filterParts(filter, column);
  } catch (cause) {
    if (cause instanceof FilterTextError) return null;
    throw cause;
  }
  return { command: "filter.column", column: column.name, where: joinParts(parts) ?? null };
}

/** How long typing in the values' search box must pause before the list is read again. */
const SEARCH_DELAY = 250;

/**
 * The filter of one column (§6.2.1): a list of its values with how many rows have each, read under the other
 * filters (`GridStore.values`) when the engine groups rows, and a condition on typed text. Applying dispatches
 * `filter.column` with the parts it makes, replacing the column's conditions.
 */
function FilterForm({ column, onDone }: { column: Column; onDone: () => void }) {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const id = useId();
  const parts = useGridSelector((snapshot) => snapshot.document.plan?.where);
  const lists = useGridSelector((snapshot) => {
    const capabilities = snapshot.table?.capabilities;
    return capabilities?.plan?.aggregate !== false && (capabilities?.measures?.includes("count") ?? true);
  });
  const [initial] = useState(() => readFilter(conditionsOf(parts, column.name), column.name));
  const read = initial === "other" ? null : initial;
  const operators = operatorsFor(column.type);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<{ values: { value: JsonValue; count: number }[]; truncated: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Values not toggled follow `base`; `toggled` holds the values changed from it.
  const [base, setBase] = useState(() => !(read?.kind === "values" && !read.exclude));
  const [toggled, setToggled] = useState(() => {
    const map = new Map<string, JsonValue>();
    if (read?.kind !== "values") return map;
    for (const value of read.values) map.set(keyOf(value, column), value);
    if (read.blank) map.set(BLANK, null);
    return map;
  });
  const [operator, setOperator] = useState<FilterOperator | "none">(
    read?.kind === "condition" && operators.includes(read.operator) ? read.operator : "none",
  );
  const [first, setFirst] = useState(read?.kind === "condition" ? read.first : "");
  const [second, setSecond] = useState(read?.kind === "condition" ? read.second : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startApply] = useTransition();

  useEffect(() => {
    if (!lists) return;
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        store
          .values(column.name, { search }, abort.signal)
          .then((result) => {
            setList(result);
            setFailure(null);
          })
          .catch((cause: unknown) => {
            if (!abort.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
          });
      },
      search ? SEARCH_DELAY : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [store, lists, column.name, search]);

  // Blank values (null and the empty string) are one item.
  const items: { key: string; value: JsonValue; count: number }[] = [];
  for (const item of list?.values ?? []) {
    const key = keyOf(item.value, column);
    const same = items.find((other) => other.key === key);
    if (same) same.count += item.count;
    else items.push({ key, value: item.value, count: item.count });
  }
  const checked = (key: string) => (toggled.has(key) ? !base : base);
  const conditionOn = operator !== "none";
  const allChecked = toggled.size === 0 ? base : base && items.every((item) => checked(item.key));

  const toggle = (key: string, value: JsonValue) =>
    setToggled((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, value);
      return next;
    });

  const filterOf = (): ColumnFilter | null => {
    if (conditionOn) return { kind: "condition", operator, first, second };
    if (base && toggled.size === 0) return null;
    const values = [...toggled].flatMap(([key, value]) => (key === BLANK ? [] : [value]));
    return { kind: "values", values, blank: toggled.has(BLANK), exclude: base };
  };

  const apply = (filter: ColumnFilter | null) => {
    const command = filterCommand(filter, column);
    if (!command) {
      setError(messages.invalidValue(column.name));
      return;
    }
    startApply(async () => {
      const outcome = await store.dispatch(command);
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      onDone();
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply(filterOf());
  };

  const label = (value: JsonValue) => (isBlank(value, column) ? messages.blank : (textOf(value, column) ?? ""));

  return (
    <form className="vg-filter" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <p className="vg-filter__title" id={`${id}-title`}>
        {messages.filterBy(column.name)}
      </p>
      {initial === "other" && <p className="vg-filter__note">{messages.otherConditions}</p>}
      {lists && (
        <>
          <input
            type="search"
            className="vg-input"
            aria-label={messages.valuesSearch}
            placeholder={messages.valuesSearch}
            value={search}
            disabled={conditionOn}
            onChange={(event) => setSearch(event.target.value)}
          />
          <fieldset
            className="vg-filter__values"
            aria-labelledby={`${id}-title`}
            aria-busy={list === null}
            disabled={conditionOn}
          >
            {!search && (
              <label className="vg-filter__value">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(event) => {
                    setBase(event.target.checked);
                    setToggled(new Map());
                  }}
                />
                <span>{messages.selectAll}</span>
              </label>
            )}
            {items.map((item) => (
              <label className="vg-filter__value" key={item.key}>
                <input type="checkbox" checked={checked(item.key)} onChange={() => toggle(item.key, item.value)} />
                <span className="vg-filter__label">{label(item.value)}</span>
                <span className="vg-filter__count">{number.format(item.count)}</span>
              </label>
            ))}
            {list === null && failure === null && <p className="vg-filter__note">{messages.loading}</p>}
            {failure !== null && <p className="vg-filter__error">{messages.failed(failure)}</p>}
          </fieldset>
          {list?.truncated && (
            <p className="vg-filter__note">{messages.valuesTruncated(number.format(list.values.length))}</p>
          )}
        </>
      )}
      <fieldset className="vg-filter__condition">
        <legend>{messages.condition}</legend>
        <select
          className="vg-input"
          aria-label={messages.condition}
          value={operator}
          onChange={(event) => setOperator(event.target.value as FilterOperator | "none")}
        >
          <option value="none">{messages.conditionNone}</option>
          {operators.map((item) => (
            <option key={item} value={item}>
              {messages.operators[item]}
            </option>
          ))}
        </select>
        {conditionOn && !takesNoValue(operator) && (
          <input
            className="vg-input"
            aria-label={operator === "between" ? messages.minimum : messages.value}
            placeholder={operator === "between" ? messages.minimum : messages.value}
            aria-invalid={error !== null}
            value={first}
            onChange={(event) => setFirst(event.target.value)}
          />
        )}
        {operator === "between" && (
          <input
            className="vg-input"
            aria-label={messages.maximum}
            placeholder={messages.maximum}
            aria-invalid={error !== null}
            value={second}
            onChange={(event) => setSecond(event.target.value)}
          />
        )}
      </fieldset>
      {error !== null && (
        <p role="alert" className="vg-filter__error">
          {error}
        </p>
      )}
      <div className="vg-filter__actions">
        <button type="button" className="vg-button" disabled={pending} onClick={() => apply(null)}>
          {messages.clearFilter}
        </button>
        <button type="submit" className="vg-button vg-button--primary" disabled={pending}>
          {messages.apply}
        </button>
      </div>
    </form>
  );
}

/**
 * The statistics of a column over the rows of the view (`GridStore.aggregate`): the rows, the values and the empty
 * ones, the distinct values, and the measures that take its type, read by the engine when the panel opens.
 */
function Statistics({ column }: { column: Column }) {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const capabilities = useGridSelector((snapshot) => snapshot.table?.capabilities);
  const [result, setResult] = useState<{
    values: Record<string, JsonValue>;
    columns: Record<string, Column>;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const statistics = statisticsOf(column, capabilities);

  useEffect(() => {
    const abort = new AbortController();
    store
      .aggregate(
        statisticsOf(column, capabilities).map((statistic) => statistic.measure),
        abort.signal,
      )
      .then((read) => {
        setResult(read);
        setFailure(null);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
      });
    return () => abort.abort();
  }, [store, column, capabilities]);

  const text = (name: string) => {
    const value = result?.values[name];
    if (value === undefined || value === null) return "";
    if (typeof value === "number") return number.format(value);
    return textOf(value, result?.columns[name] ?? column) ?? "";
  };
  const rows = Number(result?.values.rows ?? 0);
  const values = Number(result?.values.values ?? 0);
  return (
    <section className="vg-statistics" aria-label={messages.statisticsOf(column.name)} aria-busy={result === null}>
      <p className="vg-filter__title">{messages.statisticsOf(column.name)}</p>
      {failure !== null && <p className="vg-filter__error">{messages.failed(failure)}</p>}
      {failure === null && result === null && <p className="vg-filter__note">{messages.loading}</p>}
      {result && (
        <dl className="vg-statistics__list">
          {statistics.flatMap((statistic) => [
            <div key={statistic.kind}>
              <dt>{messages.statisticNames[statistic.kind]}</dt>
              <dd>{text(statistic.kind)}</dd>
            </div>,
            // The empty values (null) follow the values.
            ...(statistic.kind === "values"
              ? [
                  <div key="nulls">
                    <dt>{messages.statisticNames.nulls}</dt>
                    <dd>{number.format(rows - values)}</dd>
                  </div>,
                ]
              : []),
          ])}
        </dl>
      )}
    </section>
  );
}

/**
 * The menu of a column of the view, opened from its header (the arrow at its right, a right click, or Alt+↓ on the
 * active cell): sorting by it (§6.2), its filter, and its pin, width and visibility (§6.3), all as commands. It is
 * a popover: Esc and a click outside close it, and the focus goes back to the grid.
 */
export function ColumnMenu({ target, onClose }: { target: MenuTarget | null; onClose: () => void }) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const ref = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<"filter" | "statistics" | "total" | "format" | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setPanel(null);
  }
  const name = target?.column;
  const item = useGridSelector((snapshot) => snapshot.displayed.find((entry) => entry.column.name === name));
  const displayed = useGridSelector((snapshot) => snapshot.displayed.length);
  const hidden = useGridSelector((snapshot) => (snapshot.view?.columns.length ?? 0) > snapshot.displayed.length);
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const aggregate = useGridSelector((snapshot) => snapshot.document.plan?.aggregate);
  const grouped = aggregate !== undefined;
  const capabilities = useGridSelector((snapshot) => snapshot.table?.capabilities);
  const ready = useGridSelector((snapshot) => snapshot.table?.status === "ready");

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target) return;
    if (!menu.matches(":popover-open")) menu.showPopover();
    menu.querySelector<HTMLElement>("button:not(:disabled), input, select")?.focus();
  }, [target]);

  // The menu opens at its point, kept inside the window.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !target) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`;
  });

  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") onClose();
  };

  if (!target || !item) {
    return <div ref={ref} popover="auto" className="vg-menu vg-column-menu" onToggle={onToggle} />;
  }
  const column = item.column;
  const close = () => ref.current?.hidePopover();
  const run = (command: GridCommand) => {
    close();
    void store.dispatch(command);
  };
  const sorts = capabilities?.plan?.sort !== false;
  const own = sort?.find((key) => key.column === column.name);
  const others = (sort ?? []).filter((key) => key.column !== column.name);
  const sortBy = (direction: SortDirection, add: boolean) =>
    run({ command: "sort.set", keys: [...(add ? others : []), { column: column.name, direction }] });
  const filters = ready && !grouped && capabilities?.plan?.where !== false;
  const pin = item.setting.pin;
  const measures = ready && !grouped && offers(capabilities, "count");
  const totals = TOTALS.filter((fn) => offers(capabilities, fn) && measureTakes(fn, column));
  const keys = aggregate?.keys ?? [];
  const groupBy = () =>
    run({
      command: "group.set",
      aggregate: {
        keys: [column.name],
        measures: [{ name: measureName("count", undefined, new Set([column.name])), fn: "count" }],
      },
    });
  const ungroupBy = () => {
    const rest = keys.filter((key) => key !== column.name);
    run(
      rest.length === 0 || !aggregate
        ? { command: "group.clear" }
        : { command: "group.set", aggregate: { ...aggregate, keys: rest } },
    );
  };
  const back = (
    <button type="button" className="vg-menu__item" onClick={() => setPanel(null)}>
      ← {messages.back}
    </button>
  );

  return (
    <div
      ref={ref}
      popover="auto"
      role="dialog"
      className="vg-menu vg-column-menu"
      aria-label={messages.columnMenu(column.name)}
      onToggle={onToggle}
    >
      {panel === "filter" ? (
        <>
          {back}
          <FilterForm key={column.name} column={column} onDone={close} />
        </>
      ) : panel === "format" ? (
        <>
          {back}
          <FormatForm key={column.name} column={column} setting={item.setting} onDone={close} />
        </>
      ) : panel === "statistics" ? (
        <>
          {back}
          <Statistics key={column.name} column={column} />
        </>
      ) : panel === "total" ? (
        <>
          {back}
          <div role="menu" aria-label={messages.total} onKeyDown={moveFocus}>
            <MenuItem
              radio
              checked={item.setting.total === undefined}
              onClick={() => run({ command: "column.total", name: column.name, total: null })}
            >
              {messages.noTotal}
            </MenuItem>
            {totals.map((fn) => (
              <MenuItem
                key={fn}
                radio
                checked={item.setting.total?.fn === fn}
                onClick={() => run({ command: "column.total", name: column.name, total: { fn } })}
              >
                {messages.measureNames[fn]}
              </MenuItem>
            ))}
          </div>
        </>
      ) : (
        <div role="menu" aria-label={messages.columnMenu(column.name)} onKeyDown={moveFocus}>
          {sorts && (
            <>
              <MenuItem checked={own?.direction === "asc" && others.length === 0} onClick={() => sortBy("asc", false)}>
                {messages.sortAscending}
              </MenuItem>
              <MenuItem
                checked={own?.direction === "desc" && others.length === 0}
                onClick={() => sortBy("desc", false)}
              >
                {messages.sortDescending}
              </MenuItem>
              {others.length > 0 && (
                <>
                  <MenuItem onClick={() => sortBy("asc", true)}>{messages.thenSortAscending}</MenuItem>
                  <MenuItem onClick={() => sortBy("desc", true)}>{messages.thenSortDescending}</MenuItem>
                </>
              )}
              {sort && sort.length > 0 && (
                <MenuItem onClick={() => run({ command: "sort.clear" })}>{messages.clearSort}</MenuItem>
              )}
              <hr className="vg-menu__line" />
            </>
          )}
          {filters && <MenuItem onClick={() => setPanel("filter")}>{messages.filter}</MenuItem>}
          {measures && <MenuItem onClick={() => setPanel("statistics")}>{messages.statistics}</MenuItem>}
          {!grouped && totals.length > 0 && (
            <MenuItem onClick={() => setPanel("total")}>
              {item.setting.total
                ? `${messages.total}: ${messages.measureNames[item.setting.total.fn]}`
                : `${messages.total}…`}
            </MenuItem>
          )}
          {measures && capabilities?.plan?.aggregate !== false && (
            <MenuItem onClick={groupBy}>{messages.groupByColumn}</MenuItem>
          )}
          {keys.includes(column.name) && <MenuItem onClick={ungroupBy}>{messages.removeFromGroups}</MenuItem>}
          {grouped && <MenuItem onClick={() => run({ command: "group.clear" })}>{messages.ungroup}</MenuItem>}
          {(filters || measures || grouped || totals.length > 0) && <hr className="vg-menu__line" />}
          <MenuItem onClick={() => setPanel("format")}>{messages.format}</MenuItem>
          <MenuItem onClick={() => run({ command: "column.resize", name: column.name, width: null })}>
            {messages.autoFit}
          </MenuItem>
          {pin !== "left" && (
            <MenuItem onClick={() => run({ command: "column.pin", name: column.name, side: "left" })}>
              {messages.pinLeft}
            </MenuItem>
          )}
          {pin !== "right" && (
            <MenuItem onClick={() => run({ command: "column.pin", name: column.name, side: "right" })}>
              {messages.pinRight}
            </MenuItem>
          )}
          {pin !== undefined && (
            <MenuItem onClick={() => run({ command: "column.pin", name: column.name, side: null })}>
              {messages.unpin}
            </MenuItem>
          )}
          <MenuItem disabled={displayed <= 1} onClick={() => run({ command: "column.hide", names: [column.name] })}>
            {messages.hideColumn}
          </MenuItem>
          {hidden && (
            <MenuItem onClick={() => run({ command: "column.show", all: true })}>{messages.showAllColumns}</MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

/** Arrows, Home and End move the focus among the items of a menu (the menu pattern of the ARIA Authoring Practices). */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : -1;
  if (next < 0 || items.length === 0) return;
  event.preventDefault();
  items[next].focus();
}

function MenuItem({
  checked,
  radio,
  disabled,
  onClick,
  children,
}: {
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  if (checked === undefined) {
    return (
      <button type="button" role="menuitem" className="vg-menu__item" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }
  if (radio) {
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className="vg-menu__item"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="vg-menu__item"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
