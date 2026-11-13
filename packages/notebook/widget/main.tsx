/**
 * The grid of the notebook (docs/notebook.md): an anywidget module that shows vastgrid's `DataGrid` in a cell's
 * output, with the engine in the kernel (the Python package `vastgrid`). Messages travel over the widget's comm as
 * custom messages; the bytes of blocks and exports travel as its buffers, which a mark stands for in the message.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createGridStore, DataGrid, type Transport, type WorkerLike, workerTransport } from "vastgrid";
import { messagesFor } from "vastgrid/locales";
import "vastgrid/styles.css";
import "./notebook.css";
import type { GridDocument } from "vastgrid-spec";

/** What the module uses of anywidget's model. */
interface Model {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  save_changes(): void;
  on(name: string, callback: (...args: never[]) => void): void;
  off(name?: string | null, callback?: ((...args: never[]) => void) | null): void;
  send(content: unknown, callbacks?: unknown, buffers?: ArrayBuffer[]): void;
}

/** The member of an object that stands for a buffer of the message, by its index. */
const MARK = "vastgrid:buffer";

/** The message with its bytes taken out into `buffers`. */
function split(value: unknown, buffers: ArrayBuffer[]): unknown {
  if (value instanceof Uint8Array) {
    buffers.push(value.slice().buffer);
    return { [MARK]: buffers.length - 1 };
  }
  if (Array.isArray(value)) return value.map((item) => split(item, buffers));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, split(item, buffers)]));
  }
  return value;
}

/** The message with its buffers put back as bytes. */
function join(value: unknown, buffers: Uint8Array[]): unknown {
  if (Array.isArray(value)) return value.map((item) => join(item, buffers));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === MARK) return buffers[entries[0][1] as number];
    return Object.fromEntries(entries.map(([key, item]) => [key, join(item, buffers)]));
  }
  return value;
}

/** The kernel's side of the comm, as a worker's: messages out, and the model's custom messages in. */
function kernelPort(model: Model): WorkerLike & { close(): void } {
  const listeners = new Set<(event: MessageEvent) => void>();
  const receive = (content: unknown, buffers: DataView[] = []) => {
    const bytes = buffers.map((view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    const data = join(content, bytes);
    for (const listener of [...listeners]) listener({ data } as MessageEvent);
  };
  model.on("msg:custom", receive as never);
  return {
    postMessage(message) {
      const buffers: ArrayBuffer[] = [];
      model.send(split(message, buffers), undefined, buffers);
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    close() {
      model.off("msg:custom", receive as never);
      listeners.clear();
    },
  };
}

const EMPTY_DOCUMENT: GridDocument = { kind: "vastgrid/document", version: 2 };

function SheetGrid({
  model,
  transport,
  table,
  sheet,
  locale,
  height,
  name,
}: {
  model: Model;
  transport: Transport;
  table: string;
  sheet: string | null;
  locale: string;
  height: number;
  name: string;
}) {
  const sending = useRef(false);
  const [store] = useState(() => {
    const initial = (model.get("document") as GridDocument | null) ?? undefined;
    return createGridStore({
      transport,
      table,
      ...(sheet === null ? {} : { open: { sheet } }),
      ...(initial === undefined ? {} : { document: initial }),
    });
  });

  useEffect(() => store.connect(), [store]);

  useEffect(() => {
    const onDocument = () => {
      if (sending.current) return;
      const next = (model.get("document") as GridDocument | null) ?? EMPTY_DOCUMENT;
      store.setDocument(next);
    };
    model.on("change:document", onDocument);
    return () => model.off("change:document", onDocument);
  }, [model, store]);

  return (
    <DataGrid
      store={store}
      locale={locale}
      messages={messagesFor(locale)}
      style={{ height: `${height}px` }}
      aria-label={name}
      // The notebook reads the plan and the columns' settings of the grid (`Grid.document`).
      onDocumentChange={(next) => {
        sending.current = true;
        try {
          model.set("document", next);
          model.save_changes();
        } finally {
          sending.current = false;
        }
      }}
    />
  );
}

function NotebookGrid({ model, transport }: { model: Model; transport: Transport }) {
  const [table, setTable] = useState(() => model.get("ref") as string);
  const [sheet, setSheet] = useState(() => model.get("sheet") as string | null);
  const [locale, setLocale] = useState(() => (model.get("locale") as string | undefined) || "en");
  const [height, setHeight] = useState(() => model.get("height") as number);
  const [name, setName] = useState(() => model.get("name") as string);

  useEffect(() => {
    const onRef = () => setTable(model.get("ref") as string);
    const onSheet = () => setSheet(model.get("sheet") as string | null);
    const onLocale = () => setLocale((model.get("locale") as string | undefined) || "en");
    const onHeight = () => setHeight(model.get("height") as number);
    const onName = () => setName(model.get("name") as string);
    model.on("change:ref", onRef);
    model.on("change:sheet", onSheet);
    model.on("change:locale", onLocale);
    model.on("change:height", onHeight);
    model.on("change:name", onName);
    return () => {
      model.off("change:ref", onRef);
      model.off("change:sheet", onSheet);
      model.off("change:locale", onLocale);
      model.off("change:height", onHeight);
      model.off("change:name", onName);
    };
  }, [model]);

  return (
    <SheetGrid
      key={`${table}\u0000${sheet ?? ""}`}
      model={model}
      transport={transport}
      table={table}
      sheet={sheet}
      locale={locale}
      height={height}
      name={name}
    />
  );
}

function render({ model, el }: { model: Model; el: HTMLElement }) {
  const port = kernelPort(model);
  const transport = workerTransport(port);
  el.classList.add("vastgrid-notebook");
  // Lumino's shortcut dispatcher respects this boundary in both notebook UIs, including Notebook 7's capture
  // handler. Keep cell commands and notebook undo/redo from taking keys meant for the grid or its editors.
  el.setAttribute("data-lm-suppress-shortcuts", "true");
  // The notebook's own key handler also uses this mark to leave Enter and arrow keys to an editable output.
  // It resets the mark on focus, so restore it after focus reaches this widget.
  const keepKeys = () => {
    if (el.contains(el.ownerDocument.activeElement)) el.closest(".jp-Notebook")?.classList.add("jp-mod-readWrite");
  };
  window.addEventListener("focusin", keepKeys);
  const root = createRoot(el);
  root.render(<NotebookGrid model={model} transport={transport} />);
  // The output's grid ends with the output (a cell run again, cleared or closed): its tables are closed, and the
  // kernel keeps the written cells for the `Grid` until it is closed.
  return () => {
    window.removeEventListener("focusin", keepKeys);
    el.removeAttribute("data-lm-suppress-shortcuts");
    root.unmount();
    transport.close();
    port.close();
  };
}

export default { render };
