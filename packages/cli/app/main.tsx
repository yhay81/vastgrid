/**
 * The page of `vastgrid` (docs/cli.md): the files that the command was started with, in 0.2's grid, read by DuckDB
 * in the command over HTTP (docs/spec.md §8.8). `?file=` names the file shown and `&sheet=` a sheet of a
 * workbook: the address keeps them, for loading the page again and for the browser's back and forward.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DataGrid, type GridStore, httpTransport, useCreateGridStore } from "vastgrid";
import "vastgrid/styles.css";
import "./app.css";

/** What `/files` answers. */
interface Listing {
  files: string[];
  save: boolean;
}

/** The file and sheet shown. */
interface Place {
  file: string | null;
  sheet: string | null;
}

const transport = httpTransport("/api", { events: "/api/events" });
const ja = navigator.language.startsWith("ja");

function readPlace(): Place {
  const params = new URLSearchParams(location.search);
  return { file: params.get("file"), sheet: params.get("sheet") };
}

function addressOf(place: Place) {
  const params = new URLSearchParams();
  if (place.file !== null) params.set("file", place.file);
  if (place.sheet !== null) params.set("sheet", place.sheet);
  return `/?${params}`;
}

function useSheets(store: GridStore) {
  const sheets = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheets);
  const sheet = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheet);
  return { sheets: sheets?.filter((item) => !item.hidden) ?? [], sheet };
}

function Grid({ file, sheet, onSheet }: { file: string; sheet: string | null; onSheet: (sheet: string) => void }) {
  const store = useCreateGridStore({ transport, table: file, ...(sheet === null ? {} : { open: { sheet } }) });
  const sheets = useSheets(store);
  return (
    <>
      {sheets.sheets.length > 1 && (
        <nav className="vastgrid-bar vastgrid-sheets" aria-label={ja ? "シート" : "Sheets"}>
          {sheets.sheets.map((item) => (
            <button
              key={item.name}
              type="button"
              aria-pressed={item.name === sheets.sheet}
              onClick={() => item.name !== sheets.sheet && onSheet(item.name)}
            >
              {item.name}
            </button>
          ))}
        </nav>
      )}
      <DataGrid store={store} toolbar statusBar checkboxes aria-label={file} className="vastgrid-grid" />
    </>
  );
}

function App() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [place, setPlace] = useState(readPlace);
  useEffect(() => {
    fetch("/files")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        setListing((await response.json()) as Listing);
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    const back = () => setPlace(readPlace());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const go = (next: Place) => {
    history.pushState(null, "", addressOf(next));
    setPlace(next);
  };
  const file = place.file ?? listing?.files[0] ?? null;
  useEffect(() => {
    document.title = file === null ? "vastgrid" : `${file} — vastgrid`;
  }, [file]);

  if (failure !== null) return <p className="vastgrid-message">{failure}</p>;
  if (listing === null) return null;
  if (file === null) {
    return (
      <p className="vastgrid-message">
        {ja
          ? "CSV・TSV・Parquet・JSON Lines・Excel のファイルがありません。"
          : "There are no CSV, TSV, Parquet, JSON Lines or Excel files."}
      </p>
    );
  }
  // A file typed into the address is in the list too; the engine opens it if it may.
  const files = listing.files.includes(file) ? listing.files : [file, ...listing.files];
  return (
    <div className="vastgrid-app">
      {files.length > 1 && (
        <div className="vastgrid-bar">
          <select
            aria-label={ja ? "ファイル" : "File"}
            value={file}
            onChange={(event) => go({ file: event.target.value, sheet: null })}
          >
            {files.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      )}
      <Grid
        key={`${file}\u0000${place.sheet ?? ""}`}
        file={file}
        sheet={place.sheet}
        onSheet={(sheet) => go({ file, sheet })}
      />
    </div>
  );
}

const element = document.getElementById("root");
if (!element) throw new Error("There is no #root.");
createRoot(element).render(<App />);
