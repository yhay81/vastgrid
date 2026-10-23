import { useMemo, useState } from "react";
import { DataGrid } from "vastgrid";
import "vastgrid/styles.css";
import { ordersSource } from "../data/orders.ts";

interface ExampleProps {
  /** The page's language, for the grid's texts and number formats. */
  locale?: string;
}

/** The grid on the home page: 100,000 made-up orders in an `ArraySource`. */
export function HeroGrid({ locale = "en" }: ExampleProps) {
  const source = useMemo(() => ordersSource(100_000), []);
  return (
    <div className="example example--hero not-content">
      <DataGrid source={source} locale={locale} frozenColumns={1} />
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
  const source = useMemo(() => ordersSource(10_000), []);
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
          source={source}
          locale={locale}
          className={`theme-${theme.name}`}
          rowHeight={theme.rowHeight}
          statusBar={false}
        />
      </div>
    </div>
  );
}
