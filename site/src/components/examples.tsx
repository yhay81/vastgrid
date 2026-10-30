import { useMemo, useState } from "react";
import { DataGrid, type GridDocument, GridProvider, useCreateGridStore, useGridRows, useGridSelector } from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";
import { localTransport } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";
import { ordersTable } from "../data/orders.ts";

interface ExampleProps {
  /** The page's language, for the grid's texts and number formats. */
  locale?: string;
}

/** The order number stays at the left as the grid scrolls sideways. */
const pinned: GridDocument = { kind: "vastgrid/document", version: 2, columns: [{ name: "order_id", pin: "left" }] };

/** Made-up orders in the memory engine, in the page. */
function useOrders(rows: number) {
  return useMemo(() => localTransport(memoryEngine({ tables: { orders: ordersTable(rows) } })), [rows]);
}

/** The grid on the home page: 100,000 made-up orders. */
export function HeroGrid({ locale = "en" }: ExampleProps) {
  const transport = useOrders(100_000);
  return (
    <div className="example example--hero not-content">
      <DataGrid
        transport={transport}
        table="orders"
        defaultDocument={pinned}
        locale={locale}
        messages={locale === "ja" ? ja : undefined}
        statusBar
        aria-label="orders"
      />
    </div>
  );
}

const themes = [
  { name: "default", label: { en: "Default", ja: "標準" }, rowHeight: undefined },
  { name: "compact", label: { en: "Compact", ja: "詰める" }, rowHeight: 20 },
  { name: "paper", label: { en: "Paper", ja: "紙" }, rowHeight: 28 },
  { name: "terminal", label: { en: "Terminal", ja: "端末" }, rowHeight: undefined },
] as const;

/** A grid restyled by CSS custom properties alone (the classes are in docs.css). */
export function ThemedGrid({ locale = "en" }: ExampleProps) {
  const transport = useOrders(10_000);
  const [theme, setTheme] = useState<(typeof themes)[number]>(themes[0]);
  const language = locale === "ja" ? "ja" : "en";
  return (
    <div className="example not-content">
      <div className="example-toolbar">
        {themes.map((item) => (
          <button key={item.name} type="button" aria-pressed={item === theme} onClick={() => setTheme(item)}>
            {item.label[language]}
          </button>
        ))}
      </div>
      <div className="example-grid">
        <DataGrid
          transport={transport}
          table="orders"
          locale={locale}
          messages={locale === "ja" ? ja : undefined}
          className={`theme-${theme.name}`}
          rowHeight={theme.rowHeight}
          aria-label="orders"
        />
      </div>
    </div>
  );
}

/** Sales by category, largest first: the grid groups the orders, and the chart draws the groups it shows. */
const byCategory: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: {
    aggregate: { keys: ["category"], measures: [{ name: "sales", fn: "sum", column: "total" }] },
    sort: [{ column: "sales", direction: "desc" }],
  },
};

/** A grid and a chart of the same view: change the groups, the measure, the filters or the sort in the grid. */
export function ChartGrid({ locale = "en" }: ExampleProps) {
  const transport = useOrders(10_000);
  const store = useCreateGridStore({ transport, table: "orders", document: byCategory });
  return (
    <div className="example not-content">
      <GridProvider store={store}>
        <Bars />
        <div className="example-grid">
          <DataGrid
            store={store}
            locale={locale}
            messages={locale === "ja" ? ja : undefined}
            toolbar
            aria-label="orders"
          />
        </div>
      </GridProvider>
    </div>
  );
}

const BAR_ROWS = 12;

function sameNames(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * The first rows of the view as bars: the first displayed column names each bar, and the first numeric column
 * after it is its length. Rows come from the store's cache, as the canvas reads them.
 */
function Bars() {
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const names = useGridSelector((snapshot) => {
    const [label, ...rest] = snapshot.displayed;
    const value = rest.find((column) => ["integer", "bigint", "decimal", "float"].includes(column.column.type));
    return label && value ? [label.column.name, value.column.name] : [];
  }, sameNames);
  const rows = useGridRows({ start: 0, end: Math.min(rowCount, BAR_ROWS), columns: names });
  const bars = rows.map(([label, value]) => ({ label: String(label ?? ""), value: Number(value ?? 0) }));
  const largest = Math.max(0, ...bars.map((bar) => bar.value));
  return (
    <svg
      className="example-chart"
      viewBox={`0 0 600 ${bars.length * 22 + 4}`}
      role="img"
      aria-label={names.join(" / ")}
    >
      {bars.map((bar, index) => (
        // A grouped view has one row for each key, so the labels are unique.
        <g key={bar.label} transform={`translate(0 ${index * 22 + 2})`}>
          <text x="0" y="14" className="example-chart__label">
            {bar.label}
          </text>
          <rect x="160" y="2" height="16" rx="2" width={largest > 0 ? (Math.max(0, bar.value) / largest) * 360 : 0} />
          <text x="526" y="14" textAnchor="end" className="example-chart__value">
            {bar.value.toLocaleString()}
          </text>
        </g>
      ))}
    </svg>
  );
}
