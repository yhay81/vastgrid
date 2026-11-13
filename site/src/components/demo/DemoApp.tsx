import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnGroup,
  DataGrid,
  type DataGridHandle,
  type GridDocument,
  type Transport,
  workerTransport,
} from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";
import { type Language, type Theme, useAppPrefs } from "../app-prefs.ts";

const ORDER_ROWS = 200_000;

const titles: Record<Language, string> = { en: "vastgrid demo", ja: "vastgrid デモ" };
const paths: Record<Language, string> = { en: "/demo/", ja: "/ja/demo/" };

const texts = {
  en: {
    orders: "Orders · 200,000 rows",
    open: "Open your file",
    note: "Generated in your browser and held by the memory engine in a Web Worker. Open a column's menu (▾ or Alt+↓) to sort, filter, group or see its statistics, type over a cell to edit it (⌘/Ctrl+Z undoes), drag across cells to see their sum below, press ⌘/Ctrl+F to find, and export from the toolbar.",
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
    note: "ブラウザーの Web Worker の中で生成し、メモリエンジンに持たせた表です。列の見出しのメニュー（▾ か Alt+↓）で並べ替え・絞り込み・グループ化・統計、セルは上から入力して編集（⌘/Ctrl+Z で元に戻す）、セルをドラッグで選ぶと下に合計、⌘/Ctrl+F で検索、ツールバーから書き出せます。",
    theme: "テーマ",
    auto: "自動",
    light: "ライト",
    dark: "ダーク",
    language: "言語",
    docs: "ドキュメント",
  },
} satisfies Record<Language, Record<string, string>>;

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
  const { language, changeLanguage, theme, setTheme } = useAppPrefs(pageLanguage, paths, titles);
  const [transport, setTransport] = useState<Transport>();
  const grid = useRef<DataGridHandle>(null);
  const groups = useMemo(() => orderGroups(language), [language]);
  const t = texts[language];

  useEffect(() => {
    const worker = new Worker(new URL("../landing/orders-worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ rows: ORDER_ROWS });
    const opened = workerTransport(worker);
    // oxlint-disable-next-line react/set-state-in-effect -- the transport is the Worker's, made and closed with it.
    setTransport(opened);
    return () => {
      opened.close();
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    // For trying things from the console: `grid.current.dispatch({ command: "sort.set", … })`.
    (window as unknown as { grid: typeof grid }).grid = grid;
  }, []);

  useEffect(() => {
    if (transport) grid.current?.focus();
  }, [transport]);

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
            <select value={language} onChange={(event) => changeLanguage(event.target.value as Language)}>
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
        {transport && (
          <DataGrid
            ref={grid}
            transport={transport}
            table="orders"
            defaultDocument={pinned}
            locale={language}
            messages={language === "ja" ? ja : undefined}
            checkboxes
            columnGroups={groups}
            aria-label={t.orders}
          />
        )}
      </main>
    </div>
  );
}
