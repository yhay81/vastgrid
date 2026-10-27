import { type ToggleEvent, use, useId, useRef, useState, useTransition } from "react";
import { CommandError } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** The media types of the formats of §8.2, for files that an engine answers as data. */
const MEDIA_TYPES: Record<string, string> = {
  csv: "text/csv;charset=utf-8",
  tsv: "text/tab-separated-values;charset=utf-8",
  json: "application/json;charset=utf-8",
  parquet: "application/vnd.apache.parquet",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Downloads a file at a URL, as a link with `download` does: under `name`, or the name the server gives. */
function download(url: string, name = "") {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The toolbar's export menu (§6.6 of the specification): the rows of the view or the whole table, with the hidden
 * columns or not, in one of the formats the engine exports. It runs as an Action: the button shows that it runs, and
 * the outcome is announced. An export without a target is downloaded from where the transport gives it
 * (`Transport.exportUrl`), or, from an engine that answers the file's bytes (`delivery` `data`), as a file made of
 * them.
 */
export function ExportMenu({ announce }: { announce: (text: string) => void }) {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const formats = useGridSelector((snapshot) => snapshot.table?.capabilities.export?.formats);
  const [rows, setRows] = useState<"view" | "table">("view");
  const [allColumns, setAllColumns] = useState(false);
  const [pending, startExport] = useTransition();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!formats || formats.length === 0) return null;

  // The menu opens under its button, its right edge at the button's (popovers open in the middle otherwise).
  const place = (event: ToggleEvent<HTMLDivElement>) => {
    const button = buttonRef.current;
    if (event.newState !== "open" || !button) return;
    const rect = button.getBoundingClientRect();
    const menu = event.currentTarget;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  };

  const run = (format: string) => {
    document.getElementById(id)?.hidePopover?.();
    startExport(async () => {
      const outcome = await store.dispatch({
        command: "export",
        format,
        rows,
        columns: allColumns ? "all" : "displayed",
      });
      if (!outcome.ok) {
        const reason = outcome.error instanceof CommandError ? outcome.error.reason : null;
        announce(messages.failed(reason === "not_loaded" ? messages.loading : outcome.error.message));
        return;
      }
      const result = outcome.output as { target: string | null; rows: number; data?: { bytes: Uint8Array } };
      if (result.data) {
        const url = URL.createObjectURL(
          new Blob([result.data.bytes as Uint8Array<ArrayBuffer>], { type: MEDIA_TYPES[format] ?? "" }),
        );
        download(url, store.exportName(format));
        // The link has started the download; the browser keeps the file's bytes until it is done.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const url = result.target === null ? null : store.exportUrl(result.target);
        if (url) download(url);
      }
      announce(messages.exported(number.format(result.rows)));
    });
  };

  return (
    <>
      <button ref={buttonRef} type="button" className="vg-button" popoverTarget={id} disabled={pending}>
        {pending ? messages.exporting : messages.export}
      </button>
      <div id={id} popover="auto" role="dialog" className="vg-menu" aria-label={messages.export} onToggle={place}>
        <fieldset className="vg-menu__group">
          <label>
            <input type="radio" name={`${id}-rows`} checked={rows === "view"} onChange={() => setRows("view")} />
            {messages.exportView}
          </label>
          <label>
            <input type="radio" name={`${id}-rows`} checked={rows === "table"} onChange={() => setRows("table")} />
            {messages.exportTable}
          </label>
          <label>
            <input type="checkbox" checked={allColumns} onChange={(event) => setAllColumns(event.target.checked)} />
            {messages.exportAllColumns}
          </label>
        </fieldset>
        {formats.map((format) => (
          <button key={format} type="button" className="vg-menu__item" onClick={() => run(format)}>
            {messages.exportFormats[format] ?? format}
          </button>
        ))}
      </div>
    </>
  );
}
