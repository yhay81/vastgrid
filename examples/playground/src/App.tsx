import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArraySource,
  type CellValue,
  DataGrid,
  type DataGridHandle,
  RemoteSource,
  type SheetInfo,
  type TableSource,
} from "vastgrid";

interface FileEntry {
  path: string;
  size: number;
}

const GENERATED = "\u0000generated";

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

  const source = useMemo(
    () =>
      selected === GENERATED
        ? generated()
        : new RemoteSource({
            endpoint: "/api/table",
            ref: selected,
            ...(sheet === undefined ? {} : { read: { sheet } }),
          }),
    [selected, sheet],
  );

  useEffect(() => {
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
              <button type="button" aria-current={selected === file.path} onClick={() => choose(file.path)}>
                <span>{file.path}</span>
                <small>{formatSize(file.size)}</small>
              </button>
            </li>
          ))}
        </ul>
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
        <DataGrid key={`${selected}\n${sheet ?? ""}`} ref={grid} source={source} locale={locale} />
      </main>
    </div>
  );
}
