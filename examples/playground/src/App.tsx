import { useEffect, useRef, useState } from "react";
import {
  ArraySource,
  type CellValue,
  DataGrid,
  type DataGridHandle,
  downloadBlob,
  type GridExportOptions,
  RemoteSource,
  type SheetInfo,
  type TableSource,
} from "vastgrid";
import { BrowserSource, type Transfer } from "vastgrid-browser";
import BrowserWorker from "vastgrid-browser/worker?worker";

interface FileEntry {
  path: string;
  size: number;
}

const GENERATED = "\u0000generated";
const LOCAL = "\u0000local";

type Engine = "server" | "browser";

/** Where the browser engine can read a file: Parquet over HTTP Range from the dev server's `/data/`. */
function readableInBrowser(file: string) {
  return /\.parquet$/i.test(file);
}

/**
 * Exports: the table server writes files into `exports/` of the data folder, and the browser then
 * downloads them from `/data/`. Data returned by an in-memory source is downloaded directly.
 */
const exportOptions: GridExportOptions = {
  target: ({ request, delivery }) => (delivery === "file" ? `exports/${request.target}` : request.target),
  onExported: (result) => {
    if (result.data) {
      downloadBlob(result.data, result.target);
      return;
    }
    const link = document.createElement("a");
    link.href = `/data/${result.target.split("/").map(encodeURIComponent).join("/")}`;
    link.download = result.target.split("/").pop() ?? result.target;
    link.click();
  },
};

function browserSource(options: { file: File } | { url: string }) {
  return new BrowserSource({ ...options, worker: () => new BrowserWorker() });
}

/** Bytes the browser engine read and how long opening took, for comparing with the file size. */
function BrowserMeter({ source }: { source: BrowserSource }) {
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  useEffect(() => {
    const started = performance.now();
    let cancelled = false;
    const poll = async () => {
      const info = await source.info();
      if (info.status === "loading") {
        if (!cancelled) setTimeout(poll, 50);
        return;
      }
      if (!cancelled) setOpened(performance.now() - started);
    };
    poll().catch(() => {});
    const timer = setInterval(() => {
      source.transfer().then(setTransfer, () => {});
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [source]);
  return (
    <p className="app__hint">
      Browser worker: opened in {opened === null ? "…" : `${Math.round(opened)} ms`}, read{" "}
      {transfer ? `${formatSize(transfer.bytes)} in ${transfer.requests} reads` : "…"}
    </p>
  );
}

function formatSize(size: number) {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

/** 200,000 rows generated in the browser, for trying the grid without a server. */
function generated(): TableSource {
  const rows = 200_000;
  const cities = ["東京", "大阪", "名古屋", "福岡", "札幌", "Paris", "New York", null];
  const columns: CellValue[][] = [[], [], [], [], [], []];
  for (let index = 0; index < rows; index++) {
    columns[0].push(index + 1);
    columns[1].push(`Item ${(index * 7919) % 50_000}`);
    columns[2].push(cities[index % cities.length]);
    columns[3].push(Math.round(Math.sin(index) * 100_000) / 100);
    columns[4].push(index % 3 === 0);
    columns[5].push(index % 997 === 0 ? `A long note for row ${index} — ${"lorem ipsum ".repeat(20)}` : null);
  }
  return new ArraySource({ columns: ["id", "item", "city", "amount", "flag", "note"], columnData: columns });
}

export function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<string>(GENERATED);
  /** The sheets of the selected workbook, and the one shown (`undefined`: the first visible one). */
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [sheet, setSheet] = useState<string | undefined>();
  const [engine, setEngine] = useState<Engine>("server");
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [source, setSource] = useState<TableSource | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [locale, setLocale] = useState("ja");
  const grid = useRef<DataGridHandle>(null);
  useEffect(() => {
    // For trying things from the console.
    (window as unknown as { grid: typeof grid }).grid = grid;
  }, []);

  useEffect(() => {
    fetch("/api/files")
      .then((response) => response.json())
      .then((data: { root: string; files: FileEntry[] }) => {
        setFiles(data.files);
        setRoot(data.root);
      })
      .catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let next: TableSource;
    if (selected === GENERATED) next = generated();
    else if (selected === LOCAL && localFile) next = browserSource({ file: localFile });
    else if (engine === "browser" && readableInBrowser(selected))
      next = browserSource({ url: `/data/${selected.split("/").map(encodeURIComponent).join("/")}` });
    else
      next = new RemoteSource({
        endpoint: "/api/table",
        ref: selected,
        ...(sheet === undefined ? {} : { read: { sheet } }),
      });
    setSource(next);
    // For trying things from the console.
    (window as unknown as { source: TableSource }).source = next;
    // A browser source ends its worker.
    return () => (next as Partial<BrowserSource>).close?.();
  }, [selected, sheet, engine, localFile]);

  useEffect(() => {
    if (!source) return;
    let current = true;
    void source
      .info()
      .then((info) => {
        if (current && info.sheets) setSheets(info.sheets);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [source]);

  const choose = (file: string) => {
    setSelected(file);
    setSheet(undefined);
    setSheets([]);
  };

  return (
    <div className="app">
      <aside className="app__files">
        <h1>vastgrid</h1>
        <p className="app__hint">Files in {root || "…"}</p>
        <ul>
          <li>
            <button type="button" aria-current={selected === GENERATED} onClick={() => choose(GENERATED)}>
              <span>Generated (200,000 rows, in memory)</span>
            </button>
          </li>
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-current={selected === file.path}
                disabled={engine === "browser" && !readableInBrowser(file.path)}
                onClick={() => choose(file.path)}
              >
                <span>{file.path}</span>
                <small>{formatSize(file.size)}</small>
              </button>
            </li>
          ))}
          <li>
            <label className="app__open">
              <span>{localFile && selected === LOCAL ? localFile.name : "Open a local file in the browser…"}</span>
              <input
                type="file"
                accept=".parquet,.csv,.tsv,.jsonl,.ndjson,.json,.txt"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setLocalFile(file);
                  setSelected(LOCAL);
                }}
              />
            </label>
          </li>
        </ul>
        {source instanceof BrowserSource && <BrowserMeter source={source} />}
        <div className="app__options">
          {sheets.length > 1 && (
            <label>
              Sheet{" "}
              <select
                value={sheet ?? sheets.find((item) => !item.hidden)?.name}
                onChange={(event) => setSheet(event.target.value)}
              >
                {sheets.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.hidden ? `${item.name} (hidden)` : item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Engine{" "}
            <select value={engine} onChange={(event) => setEngine(event.target.value as Engine)}>
              <option value="server">DuckDB server</option>
              <option value="browser">Browser worker (Parquet URLs)</option>
            </select>
          </label>
          <label>
            Theme{" "}
            <select value={theme} onChange={(event) => setTheme(event.target.value as "light" | "dark")}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Locale{" "}
            <select value={locale} onChange={(event) => setLocale(event.target.value)}>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </label>
          <button type="button" onClick={() => grid.current?.reload()}>
            Reload
          </button>
        </div>
      </aside>
      <main className="app__grid">
        {source && (
          <DataGrid
            key={`${engine}:${selected}\n${sheet ?? ""}`}
            ref={grid}
            source={source}
            locale={locale}
            exportOptions={{
              ...exportOptions,
              fileName: selected.startsWith("\u0000") ? "export" : (selected.split("/").pop() ?? "export"),
            }}
          />
        )}
      </main>
    </div>
  );
}
