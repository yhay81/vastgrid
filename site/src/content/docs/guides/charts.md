---
title: Charts
description: Draw the groups of the grid's rows with a chart library of your choice, following the grid's filters and sort.
---

vastgrid draws no charts and depends on no chart library. It gives a chart what it needs instead: the
groups of the rows the grid shows, computed by the source and bounded by a `limit`, so a chart of a
hundred-million-row table receives twenty numbers, not the table. Pass them to the library your app
already uses (Chart.js, ECharts, Vega-Lite, Recharts, …).

The [playground](https://github.com/yhay81/vastgrid/tree/main/examples/playground) has a working example
with Chart.js (`examples/playground/src/ChartPanel.tsx`): turn on "Chart" and filter or sort the grid.

## 1. Follow the grid

`onStateChange` reports the grid's state whenever its filters, condition tree, search, sort or columns
change, also while it shows groups (the state's `query` stays the query of the rows). Its column indexes
refer to the state's `schema`, so map them onto the table with `resolveGridState`:

```tsx
const [state, setState] = useState<GridState | null>(null);

<DataGrid source={source} onStateChange={setState} />;

const names = info.columns.map((column) => column.name);
const query: ViewQuery = (state && resolveGridState(state, names).query) || {};
```

## 2. Ask the source for the groups

Create a view of the same rows (without the sort: it does not change the groups), and group it. Engines
that keep views, such as `vastgrid-duckdb`, answer with the view the grid already built. Order the groups
by the grid's sort when it sorts by the chart's columns, and ask for no more groups than the chart draws.
Cancel the previous request when the query changes:

```ts
useEffect(() => {
  if (!info.capabilities.group || !source.group) return; // the source cannot group
  const abort = new AbortController();
  const { sort, ...rows } = query;
  const first = sort?.[0];
  const order: SortKey[] =
    first?.column === key ? [{ column: 0, direction: first.direction }] // by the bars' labels
    : first?.column === value ? [{ column: 1, direction: first.direction }] // by the bars' heights
    : [{ column: 1, direction: "desc" }]; // the largest first
  (async () => {
    const view = isEmptyQuery(rows) ? null : (await source.createView(rows, abort.signal)).id;
    return source.group({ view, keys: [key], aggregates: [{ fn: "sum", column: value }], sort: order, limit: 20 }, abort.signal);
  })().then(setResult, (error) => {
    if (!isAbortError(error)) setError(error);
  });
  return () => abort.abort();
}, [source, info, JSON.stringify(query), key, value]);
```

To follow changes of the table itself (for example rows appended to a file), also read the groups again
when `source.subscribe` reports a change (see [optional methods](/guides/custom-source/#optional-methods)).

## 3. Draw

`result.rows` holds one `[key, value]` array per group. A chart needs numbers: integers beyond 2^53 and
decimals arrive as text (exact, as the [types](/guides/grouping/#what-the-groups-mean) say), so convert
them with `Number`, which is precise enough for a bar's height. Null and empty keys are groups of their
own; give them a label.

```ts
import { BarController, BarElement, CategoryScale, Chart, LinearScale } from "chart.js";
Chart.register(BarController, BarElement, CategoryScale, LinearScale);

const chart = new Chart(canvas, { type: "bar", data: { labels: [], datasets: [{ data: [] }] } });

// On each result:
chart.data.labels = result.rows.map(([key]) => (key === null ? "(null)" : String(key)));
chart.data.datasets[0].data = result.rows.map(([, value]) => (value === null ? null : Number(value)));
chart.update();
```

The same rows suit other libraries, for example `result.rows.map(([label, value]) => ({ label, value: Number(value) }))`
for Vega-Lite's or Recharts' data. `result.truncated` and `result.groups` tell when the chart shows the
first groups of more ("20 of 1,234 groups"); `result.columns[1].name` (`sum(amount)`) names the axis.

## Notes

- The chart's numbers come from the source, over every row the grid keeps, not from the rows on screen,
  and the `limit` bounds what reaches the browser.
- A cross tabulation (`pivot`) gives one series per column-axis value: `result.pivot` lists the values of
  each generated column.
- Check `capabilities.group` (and `pivot`) before offering a chart: `vastgrid-browser` groups only with
  `fullScan`.
