import { BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip } from "chart.js";
import { useEffect, useRef, useState } from "react";
import {
  AGGREGATE_FUNCTIONS,
  type AggregateFunction,
  aggregateApplies,
  type CellValue,
  type GridState,
  type GroupResult,
  isAbortError,
  isEmptyQuery,
  isGroupableType,
  resolveGridState,
  type SortKey,
  type TableInfo,
  type TableSource,
  type ViewQuery,
} from "vastgrid";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

/** Bars drawn at most: the source returns only this many groups. */
const LIMIT = 20;

/** A key value as a bar's label. */
function label(value: CellValue) {
  if (value === null) return "(null)";
  if (value === "") return "(empty)";
  return String(value);
}

/** A value as a bar's height. 64-bit integers and decimals arrive as text; a chart needs numbers. */
function height(value: CellValue) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The groups that a bar chart shows, read with `TableSource.group` for the rows the grid shows: the
 * grid's filters, condition tree and search decide the rows, and its first sort key orders the bars when
 * it sorts by the chart's key or value column. It follows the grid's state (`onStateChange`) and changes
 * of the table (`subscribe`).
 */
function useGroups(
  source: TableSource,
  info: TableInfo | null,
  state: GridState | null,
  key: number,
  fn: AggregateFunction,
  value: number,
) {
  const [result, setResult] = useState<GroupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => source.subscribe?.(() => setChanges((count) => count + 1)), [source]);

  // The query's column indexes refer to the state's `schema`; map them onto the table by name.
  const names = info?.columns.map((column) => column.name) ?? [];
  const query: ViewQuery = (state && resolveGridState(state, names).query) || {};
  const queryKey = JSON.stringify(query);

  // `changes` reads the groups again when the table changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changes is the trigger.
  useEffect(() => {
    if (info?.status !== "ready" || !info.capabilities.group || !source.group) return;
    const abort = new AbortController();
    const { sort, ...rows } = JSON.parse(queryKey) as ViewQuery;
    const first = sort?.[0];
    const order: SortKey[] =
      first?.column === key
        ? [{ column: 0, direction: first.direction }]
        : first?.column === value && fn !== "count"
          ? [{ column: 1, direction: first.direction }]
          : [{ column: 1, direction: "desc" }];
    (async () => {
      // The same query as the grid's: engines that keep views (DuckDB) answer with the grid's view.
      const view = isEmptyQuery(rows) ? null : (await source.createView(rows, abort.signal)).id;
      const aggregate = fn === "count" ? { fn } : { fn, column: value };
      return source.group?.({ view, keys: [key], aggregates: [aggregate], sort: order, limit: LIMIT }, abort.signal);
    })().then(
      (groups) => {
        if (abort.signal.aborted || !groups) return;
        setResult(groups);
        setError(null);
      },
      (failure: unknown) => {
        if (abort.signal.aborted || isAbortError(failure)) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => abort.abort();
  }, [source, info, queryKey, key, fn, value, changes]);

  return { result, error };
}

/** A bar chart of the groups of the grid's rows, drawn with Chart.js. */
export function ChartPanel({ source, state }: { source: TableSource; state: GridState | null }) {
  const [info, setInfo] = useState<TableInfo | null>(null);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await source.info();
      if (!current) return;
      setInfo(next);
      if (next.status === "loading") timer = setTimeout(poll, 300);
    };
    poll().catch(() => undefined);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [source]);

  const columns = info?.columns ?? [];
  const keys = columns.flatMap((column, index) =>
    isGroupableType(column.type) && column.type !== "float" ? [index] : [],
  );
  const [key, setKey] = useState<number | null>(null);
  const [fn, setFn] = useState<AggregateFunction>("sum");
  const [value, setValue] = useState<number | null>(null);
  // Defaults: the first text column, and the first numeric column.
  const chosenKey = key ?? keys.find((index) => columns[index].type === "string") ?? keys[0] ?? 0;
  const values = columns.flatMap((column, index) => (aggregateApplies(fn, column.type) ? [index] : []));
  const chosenValue = value !== null && values.includes(value) ? value : (values[0] ?? 0);
  const chosenFn = fn !== "count" && values.length === 0 ? "count" : fn;

  const { result, error } = useGroups(source, info, state, chosenKey, chosenFn, chosenValue);

  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart<"bar"> | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    chart.current = new Chart(canvas.current, {
      type: "bar",
      data: { labels: [], datasets: [{ data: [], backgroundColor: "#4f7cff" }] },
      options: { animation: false, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    const bars = chart.current;
    if (!bars) return;
    const rows = result?.rows ?? [];
    bars.data.labels = rows.map((row) => label(row[0]));
    bars.data.datasets[0].data = rows.map((row) => height(row[1]));
    bars.data.datasets[0].label = result?.columns[1]?.name ?? "";
    bars.update();
  }, [result]);

  if (info && info.status === "ready" && !info.capabilities.group) {
    return <p className="app__hint">This source cannot group rows, so there is no chart.</p>;
  }
  return (
    <section className="app__chart" aria-label="Chart of the grid's rows">
      <div className="app__chart-options">
        <label>
          Bars by{" "}
          <select value={chosenKey} onChange={(event) => setKey(Number(event.target.value))}>
            {keys.map((index) => (
              <option key={index} value={index}>
                {columns[index].name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Height{" "}
          <select value={chosenFn} onChange={(event) => setFn(event.target.value as AggregateFunction)}>
            {AGGREGATE_FUNCTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>{" "}
          {chosenFn !== "count" && (
            <select value={chosenValue} onChange={(event) => setValue(Number(event.target.value))}>
              {values.map((index) => (
                <option key={index} value={index}>
                  {columns[index].name}
                </option>
              ))}
            </select>
          )}
        </label>
        <span className="app__hint">
          {error ??
            (result
              ? result.truncated
                ? `First ${result.rows.length} of ${result.groups.toLocaleString()} groups, of the rows the grid shows`
                : `${result.groups.toLocaleString()} groups, of the rows the grid shows`
              : "…")}
        </span>
      </div>
      <div className="app__chart-canvas">
        <canvas ref={canvas} />
      </div>
    </section>
  );
}
