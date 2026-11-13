import { type DragEvent, useEffect, useRef, useState } from "react";
import { createGridStore, DataGrid, GridProvider, type GridStore, useGridSelector, workerTransport } from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";
import { type Language, type Theme, useAppPrefs } from "../app-prefs.ts";

const SAMPLE_ROWS = 1_000_000;

const titles: Record<Language, string> = { en: "Open a file — vastgrid", ja: "ファイルを開く — vastgrid" };
const paths: Record<Language, string> = { en: "/open/", ja: "/ja/open/" };

const texts = {
  en: {
    drop: "Drop a CSV, TSV, JSON Lines, Parquet or Excel file here",
    or: "or",
    choose: "Choose a file",
    sample: "Try a sample of 1,000,000 rows",
    another: "Open another file",
    reading: "Reading",
    failed: "Could not read",
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
    failed: "読み込めませんでした",
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

interface SheetItem {
  name: string;
  hidden?: boolean;
}

/** A file opened by an engine in its own worker, which ends when another file is opened. */
interface Opened {
  store: GridStore;
  sheet?: string;
  sheets?: readonly SheetItem[];
  name: string;
  size: number;
}

interface ActiveWorker {
  worker: Worker;
  transport: ReturnType<typeof workerTransport>;
  disconnect?: () => void;
}

function close(active: ActiveWorker | null) {
  active?.disconnect?.();
  active?.transport.close();
  active?.worker.terminate();
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
  const { language, changeLanguage, theme, setTheme } = useAppPrefs(pageLanguage, paths, titles);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The worker and transport of the file shown, and the worker of a file being read. */
  const shown = useRef<ActiveWorker | null>(null);
  const pending = useRef<ActiveWorker | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const t = texts[language];
  const store = opened?.store;
  useEffect(
    () => () => {
      close(pending.current);
      close(shown.current);
      pending.current = shown.current = null;
    },
    [],
  );

  const selectSheet = (sheet: string) => {
    const active = shown.current;
    if (!active || !opened) return;
    const sheets = opened.store.getSnapshot().table?.sheets ?? opened.sheets;
    active.disconnect?.();
    const store = createGridStore({ transport: active.transport, table: opened.name, open: { sheet } });
    active.disconnect = store.connect();
    setOpened({ ...opened, sheet, sheets, store });
  };

  /**
   * Starts an engine in a new worker for the file. The file before stays shown until the new one is read, and its
   * worker then ends; a file still being read is given up.
   */
  const open = (message: { file: File } | { sample: number }) => {
    const name = "file" in message ? message.file.name : `sample-${message.sample}.csv`;
    close(pending.current);
    pending.current = null;
    setFailure(null);
    setReading(name);
    const failed = (detail?: string) => {
      setFailure(`${t.failed}: ${name}${detail ? `: ${detail}` : ""}`);
      setReading(null);
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      failed(error instanceof Error ? error.message : undefined);
      return;
    }
    const active: ActiveWorker = { worker, transport: workerTransport(worker) };
    pending.current = active;
    const fail = (detail?: string) => {
      if (pending.current !== active) return;
      pending.current = null;
      close(active);
      failed(detail);
    };
    const workerError = (event: Event) => fail(event instanceof ErrorEvent ? event.message : undefined);
    worker.addEventListener("error", workerError);
    worker.addEventListener("messageerror", workerError);
    worker.addEventListener("message", function ready(event: MessageEvent) {
      const data = event.data as { ready?: string; size?: number };
      if (data.ready === undefined || pending.current !== active) return;
      worker.removeEventListener("message", ready);
      const store = createGridStore({ transport: active.transport, table: name });
      const unsubscribe = store.subscribe(() => {
        if (pending.current !== active) return;
        const { error, table, view } = store.getSnapshot();
        if (error || table?.status === "error") {
          fail(error?.message ?? table?.error);
          return;
        }
        // A first file can show a preview. Keep an existing file until its replacement has finished reading.
        if (!view || (shown.current && table?.status !== "ready")) return;
        unsubscribe();
        worker.removeEventListener("error", workerError);
        worker.removeEventListener("messageerror", workerError);
        pending.current = null;
        close(shown.current);
        shown.current = active;
        setOpened({ store, sheets: table?.sheets, name, size: data.size ?? 0 });
        setReading(null);
      });
      const disconnect = store.connect();
      active.disconnect = () => {
        unsubscribe();
        disconnect();
      };
    });
    try {
      worker.postMessage(message);
    } catch (error) {
      fail(error instanceof Error ? error.message : undefined);
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) open({ file });
  };

  const page = (
    // A file can be dropped anywhere on the page; buttons open one too.
    <div
      className="demo"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
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
        {store && (
          <SheetSelect sheet={opened?.sheet} knownSheets={opened?.sheets} onSheet={selectSheet} language={language} />
        )}
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
            <select value={language} onChange={(event) => changeLanguage(event.target.value as Language)}>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <a href={language === "ja" ? "/ja/getting-started/" : "/getting-started/"}>{t.docs}</a>
          <a href="https://github.com/yhay81/vastgrid">GitHub</a>
        </div>
        <p className="demo__note">{t.note}</p>
        {failure && (
          <p className="open__error" role="alert">
            {failure}
          </p>
        )}
      </header>
      <main className="demo__grid open__main">
        {store && opened ? (
          <DataGrid
            store={store}
            locale={language}
            messages={language === "ja" ? ja : undefined}
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
        accept=".csv,.tsv,.tab,.txt,.jsonl,.ndjson,.parquet,.pq,.xlsx,.xlsm"
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
  knownSheets,
  onSheet,
  language,
}: {
  sheet?: string;
  knownSheets?: readonly SheetItem[];
  onSheet: (sheet: string) => void;
  language: Language;
}) {
  // While a chosen sheet is read (or if reading it fails), the workbook's list of sheets stays available.
  const sheets =
    useGridSelector((snapshot) => snapshot.table?.sheets) ??
    knownSheets ??
    (sheet === undefined ? [] : [{ name: sheet }]);
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
