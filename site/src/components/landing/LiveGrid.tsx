import { useEffect, useRef, useState } from "react";
import { DataGrid, type DataGridHandle, type GridDocument, type Transport, workerTransport } from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";

export type PresetName = "all" | "grouped" | "pivot" | "formulas";

/** The order number stays at the left as the grid scrolls sideways, with totals at the foot. */
const allRows: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  columns: [
    { name: "order_id", pin: "left" },
    { name: "quantity", total: { fn: "sum" } },
    { name: "total", total: { fn: "sum" } },
  ],
};

/** Sales and order counts by country and category across all 100,000 rows, largest revenue first. */
const groupedByCountry: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: {
    aggregate: {
      keys: ["country", "category"],
      measures: [
        { name: "orders", fn: "count" },
        { name: "units", fn: "sum", column: "quantity" },
        { name: "revenue", fn: "sum", column: "total" },
        { name: "avg_order", fn: "avg", column: "total" },
      ],
    },
    sort: [{ column: "revenue", direction: "desc" }],
  },
  columns: [
    { name: "country", pin: "left" },
    { name: "avg_order", format: { number: { minimumFractionDigits: 2, maximumFractionDigits: 2 } } },
  ],
};

/** Cross-tabulation of country by product category, summing order totals. */
const pivotByCategory: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: {
    aggregate: {
      keys: ["country"],
      measures: [{ name: "sales", fn: "sum", column: "total" }],
      pivot: { columns: ["category"] },
    },
    sort: [{ column: "country", direction: "asc" }],
  },
  columns: [{ name: "country", pin: "left" }],
};

/** A computed decimal column (`with_tax`) with exact rounding and conditional cell highlights. */
const formulasAndRules: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: {
    derive: [
      {
        name: "with_tax",
        expr: {
          fn: "round",
          args: [{ fn: "mul", args: [{ col: "total" }, { lit: "1.10", type: "decimal" }] }, { lit: 2 }],
        },
      },
    ],
    sort: [{ column: "with_tax", direction: "desc" }],
  },
  columns: [
    { name: "order_id", pin: "left" },
    { name: "customer" },
    { name: "product" },
    { name: "quantity", total: { fn: "sum" } },
    { name: "total", total: { fn: "sum" } },
    {
      name: "with_tax",
      total: { fn: "sum" },
      format: {
        styles: [
          {
            when: { fn: "ge", args: [{ col: "with_tax" }, { lit: 200000 }] },
            background: "rgba(35, 105, 224, 0.18)",
          },
        ],
      },
    },
    {
      name: "paid",
      format: {
        styles: [
          {
            when: { fn: "not", args: [{ col: "paid" }] },
            color: "#e5484d",
          },
        ],
      },
    },
  ],
};

const presets: Record<PresetName, GridDocument> = {
  all: allRows,
  grouped: groupedByCountry,
  pivot: pivotByCategory,
  formulas: formulasAndRules,
};

function presetOf(value: string | undefined): PresetName {
  return value === "grouped" || value === "pivot" || value === "formulas" ? value : "all";
}

interface Props {
  locale?: "en" | "ja";
  rows?: number;
}

/** The home page's grid: made-up orders, made and held by the memory engine in a Web Worker. */
export function LiveGrid({ locale = "en", rows = 100_000 }: Props) {
  const [transport, setTransport] = useState<Transport>();
  const grid = useRef<DataGridHandle>(null);
  const [initialPreset] = useState<PresetName>(() =>
    presetOf(typeof document !== "undefined" ? document.getElementById("lp-live-grid")?.dataset.view : undefined),
  );
  const activePreset = useRef<PresetName | null>(initialPreset);

  useEffect(() => {
    const worker = new Worker(new URL("./orders-worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ rows });
    const opened = workerTransport(worker);
    // oxlint-disable-next-line react/set-state-in-effect -- the transport is the Worker's, made and closed with it.
    setTransport(opened);
    return () => {
      opened.close();
      worker.terminate();
    };
  }, [rows]);

  useEffect(() => {
    const host = document.getElementById("lp-live-grid");
    if (!host || !transport) return;
    const current = host.dataset.view;
    if (current) {
      const name = presetOf(current);
      activePreset.current = name;
      grid.current?.store.setDocument(presets[name]);
    }
    const onView = (event: Event) => {
      const name = presetOf((event as CustomEvent<string>).detail);
      activePreset.current = name;
      grid.current?.store.setDocument(presets[name]);
    };
    host.addEventListener("lp-view", onView);
    return () => host.removeEventListener("lp-view", onView);
  }, [transport]);

  if (!transport) return null;
  return (
    <DataGrid
      ref={grid}
      transport={transport}
      table="orders"
      defaultDocument={presets[initialPreset]}
      onDocumentChange={(next) => {
        const name = activePreset.current;
        if (!name) return;
        if (JSON.stringify(next.plan ?? {}) !== JSON.stringify(presets[name].plan ?? {})) {
          activePreset.current = null;
          document.getElementById("lp-live-grid")?.dispatchEvent(new CustomEvent("lp-view-clear"));
        }
      }}
      locale={locale}
      messages={locale === "ja" ? ja : undefined}
      aria-label={locale === "ja" ? "架空の注文" : "Made-up orders"}
    />
  );
}
