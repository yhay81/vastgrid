/**
 * The grid of the notebook (docs/notebook.md): an anywidget module that shows vastgrid's `DataGrid` in a cell's
 * output, with the engine in the kernel (the Python package `vastgrid`). Messages travel over the widget's comm as
 * custom messages; the bytes of blocks and exports travel as its buffers, which a mark stands for in the message.
 */
import { createRoot } from "react-dom/client";
import { createGridStore, DataGrid, type WorkerLike, workerTransport } from "vastgrid";
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

function render({ model, el }: { model: Model; el: HTMLElement }) {
  const port = kernelPort(model);
  const transport = workerTransport(port);
  const sheet = model.get("sheet") as string | null;
  const document = (model.get("document") as GridDocument | null) ?? undefined;
  const store = createGridStore({
    transport,
    table: model.get("ref") as string,
    ...(sheet === null ? {} : { open: { sheet } }),
    ...(document === undefined ? {} : { document }),
  });
  const disconnect = store.connect();
  const locale = (model.get("locale") as string | undefined) || "en";
  el.classList.add("vastgrid-notebook");
  // The grid's keys are its own. Notebook 7 handles keys before the page does (JupyterLab after it), and its keys of
  // command mode (A adds a cell, the arrows move between cells) skip a notebook marked `jp-mod-readWrite`, as it is
  // while one of its text fields has the focus. The notebook sets the mark at every focus, so the grid sets it after.
  const keepKeys = () => {
    if (el.contains(el.ownerDocument.activeElement)) el.closest(".jp-Notebook")?.classList.add("jp-mod-readWrite");
  };
  window.addEventListener("focusin", keepKeys);
  const root = createRoot(el);
  root.render(
    <DataGrid
      store={store}
      locale={locale}
      messages={messagesFor(locale)}
      style={{ height: `${model.get("height") as number}px` }}
      aria-label={model.get("name") as string}
      // The notebook reads the plan and the columns' settings of the grid (`Grid.document`).
      onDocumentChange={(next) => {
        model.set("document", next);
        model.save_changes();
      }}
    />,
  );
  // The output's grid ends with the output (a cell run again, cleared or closed): its tables are closed, and the
  // kernel keeps the written cells for the `Grid` until it is closed.
  return () => {
    window.removeEventListener("focusin", keepKeys);
    root.unmount();
    disconnect();
    transport.close();
    port.close();
  };
}

export default { render };
