import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { DataGrid, type DataGridHandle, type TableSource } from "vastgrid";
import "vastgrid/styles.css";
import { ComputedSource } from "../../data/computed.ts";
import { ordersSource } from "../../data/orders.ts";

type Dataset = "orders" | "readings";
type Theme = "auto" | "light" | "dark";
type Language = "en" | "ja";

const ORDER_ROWS = 200_000;

const texts = {
  en: {
    datasets: "Data",
    orders: "Orders · 200,000 rows",
    readings: "Sensor readings · 1,000,000,000 rows",
    ordersNote:
      "Generated in your browser and held by ArraySource. Open a column's menu (▾ or Alt+↓) to sort, filter or see its statistics, drag across cells to see their sum below, and press ⌘/Ctrl+F to find.",
    readingsNote:
      "Nothing is stored: a small TableSource computes each cell as the grid reads it. Press ⌘/Ctrl+↓ to jump to the last row, or drag the scrollbar anywhere. Sorting and filtering are off because this source does not offer them.",
    theme: "Theme",
    auto: "Auto",
    light: "Light",
    dark: "Dark",
    language: "Language",
    frame: "Frame",
    frameTitle: "Time to draw a frame on the canvas, average and slowest of the last frames drawn",
    slowest: "slowest",
    docs: "Docs",
  },
  ja: {
    datasets: "データ",
    orders: "注文 · 20 万行",
    readings: "センサーの記録 · 10 億行",
    ordersNote:
      "ブラウザーで生成し、ArraySource に持たせた表です。列の見出しのメニュー（▾ か Alt+↓）で並べ替え・絞り込み・統計、セルをドラッグで選ぶと下に合計、⌘/Ctrl+F で検索できます。",
    readingsNote:
      "データはどこにもありません。小さな TableSource が、グリッドが読むたびにセルを計算しています。⌘/Ctrl+↓ で最後の行へ、スクロールバーはどこへでもドラッグできます。このソースは並べ替えと絞り込みを持たないので、それらは使えません。",
    theme: "テーマ",
    auto: "自動",
    light: "ライト",
    dark: "ダーク",
    language: "言語",
    frame: "描画",
    frameTitle: "キャンバスに 1 フレームを描く時間。最近のフレームの平均と最大",
    slowest: "最大",
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

function initialDataset(): Dataset {
  return new URLSearchParams(location.search).get("data") === "readings" ? "readings" : "orders";
}

/** Keeps the choices in the address, so that a link opens the same demo. */
function updateAddress(update: (url: URL) => void) {
  const url = new URL(location.href);
  update(url);
  history.replaceState(null, "", url);
}

function createSource(dataset: Dataset): TableSource {
  return dataset === "orders" ? ordersSource(ORDER_ROWS) : new ComputedSource();
}

function FrameTime({ grid, language }: { grid: RefObject<DataGridHandle | null>; language: Language }) {
  const [timing, setTiming] = useState<{ average: number; slowest: number } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const timings = grid.current?.renderer?.timings();
      if (timings && timings.frames > 0) setTiming({ average: timings.average, slowest: timings.slowest });
    }, 500);
    return () => clearInterval(timer);
  }, [grid]);
  const t = texts[language];
  return (
    <output className="demo__frame" title={t.frameTitle}>
      {t.frame}{" "}
      {timing ? (
        <>
          <strong>{timing.average.toFixed(1)} ms</strong> · {t.slowest} {timing.slowest.toFixed(1)} ms
        </>
      ) : (
        "…"
      )}
    </output>
  );
}

export default function DemoApp({ language: pageLanguage }: { language: Language }) {
  const [dataset, setDataset] = useState<Dataset>(initialDataset);
  const [language, setLanguage] = useState<Language>(pageLanguage);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const grid = useRef<DataGridHandle>(null);
  const source = useMemo(() => createSource(dataset), [dataset]);
  const t = texts[language];

  useEffect(() => {
    // For trying things from the console, as in the playground.
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
        <fieldset className="demo__datasets">
          <legend className="demo__hidden">{t.datasets}</legend>
          {(["orders", "readings"] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={dataset === name}
              onClick={() => {
                setDataset(name);
                updateAddress((url) => {
                  if (name === "orders") url.searchParams.delete("data");
                  else url.searchParams.set("data", name);
                });
              }}
            >
              {t[name]}
            </button>
          ))}
        </fieldset>
        <div className="demo__options">
          <FrameTime grid={grid} language={language} />
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
        <p className="demo__note">{dataset === "orders" ? t.ordersNote : t.readingsNote}</p>
      </header>
      <main className="demo__grid">
        <DataGrid key={dataset} ref={grid} source={source} locale={language} frozenColumns={1} checkboxSelection />
      </main>
    </div>
  );
}
