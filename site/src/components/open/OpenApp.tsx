import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { createGridStore, DataGrid, GridProvider, type Transport, useGridSelector, workerTransport } from "vastgrid";
import "vastgrid/styles.css";

type Theme = "auto" | "light" | "dark";
type Language = "en" | "ja";

const SAMPLE_ROWS = 1_000_000;

const texts = {
  en: {
    drop: "Drop a CSV, TSV, JSON Lines, Parquet or Excel file here",
    or: "or",
    choose: "Choose a file",
    sample: "Try a sample of 1,000,000 rows",
    another: "Open another file",
    reading: "Reading",
    note: "The file stays in your browser: vastgrid's memory engine reads it in a Web Worker. Open a column's menu to sort, filter or group, type over a cell or double-click it to edit, and export CSV, TSV, JSON or Excel from the toolbar. The file itself is not changed: export to keep your edits.",
    sheet: "Sheet",
    hidden: "hidden",
    theme: "Theme",
    auto: "Auto",
    light: "Light",
    dark: "Dark",
    language: "Language",
    docs: "Docs",
  },
  ja: {
    drop: "CSV・TSV・JSON Lines・Parquet・Excel のファイルをここにドロップ",
    or: "または",
    choose: "ファイルを選ぶ",
    sample: "100 万行のサンプルで試す",
    another: "別のファイルを開く",
    reading: "読み込み中",
    note: "ファイルはブラウザーの外へ出ません。vastgrid のメモリエンジンが Web Worker の中で読みます。列のメニューで並べ替え・絞り込み・グループ化、セルは上から入力するかダブルクリックで編集、ツールバーから CSV・TSV・JSON・Excel に書き出せます。元のファイルは変わらないので、編集を残すには書き出してください。",
    sheet: "シート",
    hidden: "非表示",
    theme: "テーマ",
    auto: "自動",
    light: "ライト",
    dark: "ダーク",
    language: "言語",
    docs: "ドキュメント",
  },
} satisfies Record<Language, Record<string, string>>;

/** The theme Starlight stores, so that the documentation and this page share it. */
const themeKey = "starlight-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(themeKey);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** The page's address in a language, as the documentation's. */
const paths: Record<Language, string> = { en: "/open/", ja: "/ja/open/" };

/** A file opened by an engine in its own worker, which ends when another file is opened. */
interface Opened {
  worker: Worker;
  transport: Transport & { close(): void };
  name: string;
  size: number;
}

function formatSize(bytes: number, language: Language) {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${size.toLocaleString(language, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export default function OpenApp({ language: pageLanguage }: { language: Language }) {
  const [language, setLanguage] = useState<Language>(pageLanguage);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  /** The worker of the file shown, and the one of a file being read. */
  const shown = useRef<Worker | null>(null);
  const pending = useRef<Worker | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const t = texts[language];
  // One store for the grid and the choice of sheet, made again for another file or sheet.
  const store = useMemo(
    () =>
      opened &&
      createGridStore({
        transport: opened.transport,
        table: opened.name,
        ...(sheet === undefined ? {} : { open: { sheet } }),
      }),
    [opened, sheet],
  );
  useEffect(() => store?.connect(), [store]);

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

  // The workers end with the page.
  useEffect(
    () => () => {
      shown.current?.terminate();
      pending.current?.terminate();
    },
    [],
  );

  /**
   * Starts an engine in a new worker for the file. The file before stays shown until the new one is read, and its
   * worker then ends; a file still being read is given up.
   */
  const open = (message: { file: File } | { sample: number }) => {
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    pending.current?.terminate();
    pending.current = worker;
    setReading("file" in message ? message.file.name : `sample-${message.sample}.csv`);
    worker.addEventListener("message", function ready(event: MessageEvent) {
      const data = event.data as { ready?: string; size?: number };
      if (data.ready === undefined) return;
      worker.removeEventListener("message", ready);
      if (pending.current !== worker) return;
      pending.current = null;
      shown.current?.terminate();
      shown.current = worker;
      setOpened({ worker, transport: workerTransport(worker), name: data.ready, size: data.size ?? 0 });
      setSheet(undefined);
      setReading(null);
    });
    worker.postMessage(message);
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) open({ file });
  };

  const page = (
    // biome-ignore lint/a11y/noStaticElementInteractions: a file can be dropped anywhere on the page; buttons open one too.
    <div
      className="demo"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target || !event.relatedTarget) setDragging(false);
      }}
      onDrop={drop}
    >
      <header className="demo__bar">
        <a className="demo__brand" href={language === "ja" ? "/ja/" : "/"}>
          <img src="/favicon.svg" alt="" width="22" height="22" />
          vastgrid
        </a>
        {opened && (
          <span className="open__file">
            {opened.name} · {formatSize(opened.size, language)}
          </span>
        )}
        {opened && (
          <button type="button" className="open__button" onClick={() => input.current?.click()}>
            {t.another}
          </button>
        )}
        {store && <SheetSelect sheet={sheet} onSheet={setSheet} language={language} />}
        <div className="demo__options">
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
                const url = new URL(location.href);
                url.pathname = paths[next];
                history.replaceState(null, "", url);
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
      <main className="demo__grid open__main">
        {store && opened ? (
          <DataGrid
            store={store}
            locale={language}
            style={{ height: "100%", colorScheme: theme === "auto" ? "light dark" : theme }}
            aria-label={opened.name}
          />
        ) : (
          <div className="open__empty">
            <p>{t.drop}</p>
            <p className="open__or">{t.or}</p>
            <div className="open__actions">
              <button
                type="button"
                className="open__button open__button--primary"
                onClick={() => input.current?.click()}
              >
                {t.choose}
              </button>
              <button type="button" className="open__button" onClick={() => open({ sample: SAMPLE_ROWS })}>
                {t.sample}
              </button>
            </div>
          </div>
        )}
        {reading && (
          <div className="open__reading" role="status">
            {t.reading} {reading}…
          </div>
        )}
        {dragging && <div className="open__drop">{t.drop}</div>}
      </main>
      <input
        ref={input}
        type="file"
        hidden
        accept=".csv,.tsv,.tab,.txt,.jsonl,.ndjson,.parquet,.xlsx,.xlsm"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) open({ file });
        }}
      />
    </div>
  );
  return store ? <GridProvider store={store}>{page}</GridProvider> : page;
}

/** The sheets of a workbook, from the table's `TableInfo`, to choose the one shown. */
function SheetSelect({
  sheet,
  onSheet,
  language,
}: {
  sheet?: string;
  onSheet: (sheet: string) => void;
  language: Language;
}) {
  // While a chosen sheet is read, the choice stays.
  const sheets =
    useGridSelector((snapshot) => snapshot.table?.sheets) ?? (sheet === undefined ? [] : [{ name: sheet }]);
  const shown = useGridSelector((snapshot) => snapshot.table?.sheet);
  const t = texts[language];
  if (sheets.length < 2 && sheet === undefined) return null;
  return (
    <label className="open__sheet">
      {t.sheet}{" "}
      <select value={sheet ?? shown} onChange={(event) => onSheet(event.target.value)}>
        {sheets.map((item) => (
          <option key={item.name} value={item.name}>
            {item.hidden ? `${item.name} (${t.hidden})` : item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
