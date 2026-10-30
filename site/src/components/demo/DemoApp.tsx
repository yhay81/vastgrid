import { useEffect, useMemo, useRef, useState } from "react";
import { type ColumnGroup, DataGrid, type DataGridHandle, type GridDocument } from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";
import { localTransport } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";
import { ordersTable } from "../../data/orders.ts";

type Theme = "auto" | "light" | "dark";
type Language = "en" | "ja";

const ORDER_ROWS = 200_000;

const texts = {
  en: {
    orders: "Orders · 200,000 rows",
    open: "Open your file",
    note: "Generated in your browser and held by the memory engine. Open a column's menu (▾ or Alt+↓) to sort, filter, group or see its statistics, type over a cell to edit it (⌘/Ctrl+Z undoes), drag across cells to see their sum below, press ⌘/Ctrl+F to find, and export from the toolbar.",
    theme: "Theme",
    auto: "Auto",
    light: "Light",
    dark: "Dark",
    language: "Language",
    docs: "Docs",
  },
  ja: {
    orders: "注文 · 20 万行",
    open: "手元のファイルを開く",
    note: "ブラウザーで生成し、メモリエンジンに持たせた表です。列の見出しのメニュー（▾ か Alt+↓）で並べ替え・絞り込み・グループ化・統計、セルは上から入力して編集（⌘/Ctrl+Z で元に戻す）、セルをドラッグで選ぶと下に合計、⌘/Ctrl+F で検索、ツールバーから書き出せます。",
    theme: "テーマ",
    auto: "自動",
    light: "ライト",
    dark: "ダーク",
    language: "言語",
    docs: "ドキュメント",
  },
} satisfies Record<Language, Record<string, string>>;

/** The theme Starlight stores, so that the documentation and the demo share it. */
const themeKey = "starlight-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(themeKey);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** The demo's address in a language: /demo/ in English, /ja/demo/ in Japanese, as the documentation's. */
const paths: Record<Language, string> = { en: "/demo/", ja: "/ja/demo/" };

/** Keeps the language in the address, so that a link opens the same demo. */
function updateAddress(update: (url: URL) => void) {
  const url = new URL(location.href);
  update(url);
  history.replaceState(null, "", url);
}

/** Header groups over the orders' columns, in the demo's language. */
function orderGroups(language: Language): ColumnGroup[] {
  const ja = language === "ja";
  return [
    {
      name: ja ? "顧客" : "Customer",
      children: ["customer", { name: ja ? "所在地" : "Location", children: ["city", "country"] }],
    },
    {
      name: ja ? "明細" : "Line",
      children: ["category", "product", "quantity", "unit_price", "total"],
    },
  ];
}

/** The order number stays at the left as the grid scrolls sideways. */
const pinned: GridDocument = { kind: "vastgrid/document", version: 2, columns: [{ name: "order_id", pin: "left" }] };

export default function DemoApp({ language: pageLanguage }: { language: Language }) {
  const [language, setLanguage] = useState<Language>(pageLanguage);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const grid = useRef<DataGridHandle>(null);
  const transport = useMemo(() => localTransport(memoryEngine({ tables: { orders: ordersTable(ORDER_ROWS) } })), []);
  const groups = useMemo(() => orderGroups(language), [language]);
  const t = texts[language];

  useEffect(() => {
    // For trying things from the console: `grid.current.dispatch({ command: "sort.set", … })`.
    (window as unknown as { grid: typeof grid }).grid = grid;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.colorScheme = theme === "auto" ? "light dark" : theme;
    root.dataset.theme = theme;
    try {
      localStorage.setItem(themeKey, theme === "auto" ? "" : theme);
    } catch {
      // Storage may be unavailable (private windows); the choice then lasts for this page.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    grid.current?.focus();
  }, []);

  return (
    <div className="demo">
      <header className="demo__bar">
        <a className="demo__brand" href={language === "ja" ? "/ja/" : "/"}>
          <img src="/favicon.svg" alt="" width="22" height="22" />
          vastgrid
        </a>
        <span className="demo__dataset">{t.orders}</span>
        <div className="demo__options">
          <a href={language === "ja" ? "/ja/open/" : "/open/"}>{t.open}</a>
          <label>
            <span className="demo__hidden">{t.theme}</span>
            <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
              <option value="auto">
                {t.theme}: {t.auto}
              </option>
              <option value="light">
                {t.theme}: {t.light}
              </option>
              <option value="dark">
                {t.theme}: {t.dark}
              </option>
            </select>
          </label>
          <label>
            <span className="demo__hidden">{t.language}</span>
            <select
              value={language}
              onChange={(event) => {
                const next = event.target.value as Language;
                setLanguage(next);
                updateAddress((url) => {
                  url.pathname = paths[next];
                });
              }}
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <a href={language === "ja" ? "/ja/getting-started/" : "/getting-started/"}>{t.docs}</a>
          <a href="https://github.com/yhay81/vastgrid">GitHub</a>
        </div>
        <p className="demo__note">{t.note}</p>
      </header>
      <main className="demo__grid">
        <DataGrid
          ref={grid}
          transport={transport}
          table="orders"
          defaultDocument={pinned}
          locale={language}
          messages={language === "ja" ? ja : undefined}
          toolbar
          statusBar
          checkboxes
          columnGroups={groups}
          aria-label={t.orders}
        />
      </main>
    </div>
  );
}
