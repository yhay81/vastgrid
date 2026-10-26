/**
 * The page of vastgrid's editor in VS Code (docs/vscode.md): `DataGrid` on the file's engine in the extension,
 * whose requests, responses and events (§8) travel by the webview's messages with blocks as bytes (§8.8). The page
 * keeps its document, session and sheet in the webview's state, so that it shows them again when it loads again.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  DataGrid,
  type GridStore,
  isApple,
  keyCommand,
  useCreateGridStore,
  type WorkerLike,
  workerTransport,
} from "vastgrid-grid";
import "vastgrid-grid/styles.css";
import "./editor.css";
import type { GridDocument, GridSession } from "vastgrid-spec";
import type { HostMessage, ViewMessage } from "../src/messages.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** What the page keeps across loads. */
interface Saved {
  document?: GridDocument;
  session?: GridSession;
  sheet?: string;
}

/** Milliseconds that changes of the state wait to be kept together. */
const KEEP_DELAY = 250;

const vscode = acquireVsCodeApi();
const element = document.getElementById("root");
if (!element) throw new Error("There is no #root.");
const ref = element.dataset.ref ?? "";
const locale = element.dataset.locale === "ja" ? "ja" : "en";
let saved: Saved = (vscode.getState() as Saved | undefined) ?? {};

function keep(next: Partial<Saved>) {
  saved = { ...saved, ...next };
  vscode.setState(saved);
}

/** The extension's side of the webview, as a worker's: messages out, and the window's messages in. */
const port: WorkerLike = {
  postMessage: (message) => vscode.postMessage(message),
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener),
};

function post(message: ViewMessage) {
  vscode.postMessage(message);
}

function useSheets(store: GridStore) {
  const sheets = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheets);
  const sheet = useSyncExternalStore(store.subscribe, () => store.getSnapshot().table?.sheet);
  return { sheets: sheets?.filter((item) => !item.hidden) ?? [], sheet };
}

function Editor({ sheet, onSheet }: { sheet: string | undefined; onSheet: (sheet: string) => void }) {
  const [transport] = useState(() => workerTransport(port));
  const store = useCreateGridStore({
    transport,
    table: ref,
    ...(sheet === undefined ? {} : { open: { sheet } }),
    ...(saved.document ? { document: saved.document } : {}),
    ...(saved.session ? { session: saved.session } : {}),
  });
  const sheets = useSheets(store);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed: Partial<Saved> = {};
    const later = (part: Partial<Saved>) => {
      Object.assign(changed, part);
      timer ??= setTimeout(() => {
        timer = null;
        keep(changed);
      }, KEEP_DELAY);
    };
    const stops = [
      store.on("document", (document) => later({ document })),
      store.on("session", (session) => later({ session })),
    ];
    return () => {
      for (const stop of stops) stop();
      if (timer !== null) clearTimeout(timer);
      // A grid that another sheet replaces keeps nothing of its own.
      if (timer !== null && saved.sheet === sheet) keep(changed);
      transport.close();
    };
  }, [store, transport, sheet]);

  useEffect(() => {
    // The extension's commands (§6), and the key that saves: VS Code saves the file, after the cell being edited
    // is written.
    const receive = (event: MessageEvent) => {
      const message = event.data as HostMessage | null;
      if (message?.vastgrid !== "dispatch") return;
      void store.dispatch(message.command as Parameters<GridStore["dispatch"]>[0]).then((outcome) => {
        if (outcome.ok) post({ vastgrid: "answer", call: message.call, ok: true, output: outcome.output });
        else {
          const { code, message: text } = outcome.error;
          post({ vastgrid: "answer", call: message.call, ok: false, error: { code, message: text } });
        }
      });
    };
    const keydown = (event: KeyboardEvent) => {
      if (keyCommand(event, isApple())?.command !== "save") return;
      event.preventDefault();
      event.stopPropagation();
      const written = store.getSnapshot().session.editor
        ? store.dispatch({ command: "edit.commit" })
        : Promise.resolve({ ok: true });
      void written.then((outcome) => {
        if (outcome.ok) post({ vastgrid: "save" });
      });
    };
    window.addEventListener("message", receive);
    window.addEventListener("keydown", keydown, true);
    post({ vastgrid: "listening", on: true });
    return () => {
      post({ vastgrid: "listening", on: false });
      window.removeEventListener("message", receive);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [store]);

  return (
    <div className="vastgrid-editor">
      {sheets.sheets.length > 1 && (
        <nav className="vastgrid-sheets" aria-label={locale === "ja" ? "シート" : "Sheets"}>
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
      <DataGrid store={store} toolbar statusBar checkboxes locale={locale} aria-label={ref} className="vastgrid-grid" />
    </div>
  );
}

function App() {
  // A revert starts the file's engine again: the grid opens the file anew.
  const [generation, setGeneration] = useState(0);
  const [sheet, setSheet] = useState(saved.sheet);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if ((event.data as HostMessage | null)?.vastgrid === "restart") setGeneration((value) => value + 1);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  const choose = (next: string) => {
    // Another sheet has other columns: its grid starts from the empty document.
    keep({ sheet: next, document: undefined, session: undefined });
    setSheet(next);
  };
  return <Editor key={`${generation}\u0000${sheet ?? ""}`} sheet={sheet} onSheet={choose} />;
}

window.addEventListener("error", (event) => post({ vastgrid: "error", message: String(event.message) }));
window.addEventListener("unhandledrejection", (event) => post({ vastgrid: "error", message: String(event.reason) }));
post({ vastgrid: "ready" });
createRoot(element).render(<App />);
