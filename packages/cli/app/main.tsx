/**
 * The page of `vastgrid` (docs/cli.md): the files that the command was started with, in 0.2's grid, read by DuckDB
 * in the command over HTTP (docs/spec.md §8.8). `?file=` names the file shown and `&sheet=` a sheet of a
 * workbook: the address keeps them, for loading the page again and for the browser's back and forward. Each entry
 * of the browser's history has an id (`history.state`), under which the tab's `sessionStorage` keeps the grid's
 * document and session, so that the page shows the same view when it is loaded again or comes back.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  DataGrid,
  type GridDocument,
  type GridSession,
  type GridStore,
  httpTransport,
  useCreateGridStore,
} from "vastgrid";
import { messagesFor } from "vastgrid/locales";
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

/** What `sessionStorage` keeps of the grid of an entry of the history. */
interface View {
  document?: GridDocument;
  session?: GridSession;
}

/** How long the page waits after a change before it keeps the view, as the VS Code extension does. */
const KEEP_DELAY = 250;

const transport = httpTransport("/api", { events: "/api/events" });
const ja = navigator.language.startsWith("ja");
const messages = messagesFor(navigator.language);

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

/** The id of the entry of the history shown, which it is given the first time. */
function entryId(): string {
  const state: unknown = history.state;
  if (typeof state === "object" && state !== null && typeof (state as { id?: unknown }).id === "string") {
    return (state as { id: string }).id;
  }
  const id = crypto.randomUUID();
  history.replaceState({ id }, "");
  return id;
}

function readView(id: string): View {
  try {
    const text = sessionStorage.getItem(`vastgrid:${id}`);
    return text === null ? {} : (JSON.parse(text) as View);
  } catch {
    return {};
  }
}

function writeView(id: string, view: View) {
  try {
    sessionStorage.setItem(`vastgrid:${id}`, JSON.stringify(view));
  } catch {
    // A full or closed storage keeps nothing; the page still works.
  }
}

function useSheets(store: GridStore) {
  const sheets = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheets);
  const sheet = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheet);
  return { sheets: sheets?.filter((item) => !item.hidden) ?? [], sheet };
}

function Grid({ file, sheet, onSheet }: { file: string; sheet: string | null; onSheet: (sheet: string) => void }) {
  const [id] = useState(entryId);
  const [view] = useState(() => readView(id));
  const store = useCreateGridStore({
    transport,
    table: file,
    ...(sheet === null ? {} : { open: { sheet } }),
    ...(view.document ? { document: view.document } : {}),
    ...(view.session ? { session: view.session } : {}),
  });
  const sheets = useSheets(store);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed: View = {};
    const keep = () => {
      timer = null;
      writeView(id, { ...readView(id), ...changed });
    };
    const later = (part: View) => {
      Object.assign(changed, part);
      timer ??= setTimeout(keep, KEEP_DELAY);
    };
    const stops = [
      store.on("document", (document) => later({ document })),
      store.on("session", (session) => later({ session })),
    ];
    const leave = () => {
      if (timer === null) return;
      clearTimeout(timer);
      keep();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      for (const stop of stops) stop();
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [store, id]);
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
      <DataGrid
        store={store}
        toolbar
        statusBar
        checkboxes
        messages={messages}
        aria-label={file}
        className="vastgrid-grid"
      />
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
