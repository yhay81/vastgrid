import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type ExportFormat, isAbortError, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "vastgrid-core";
import type { GridController } from "../controller.js";
import {
  type ExportChoice,
  ExportInterruptedError,
  exportColumns,
  exportRowCount,
  exportSupport,
  fileNameFor,
  type GridExportOptions,
  offeredFormats,
  runExport,
  xlsxLimit,
} from "../export.js";
import type { Messages } from "../messages.js";

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string }
  | { kind: "cancelled" };

/**
 * Chooses the rows, columns, format and file name of an export, runs it and shows its progress.
 * Closing the panel cancels a running export.
 */
export function ExportPanel({
  controller,
  messages,
  options,
  count,
  onDone,
}: {
  controller: GridController;
  messages: Messages;
  options: GridExportOptions;
  count: (value: number) => string;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const support = exportSupport(controller.info, controller.source.exportView);
  const formats = support ? offeredFormats(support, options.formats) : [];
  const [format, setFormat] = useState<ExportFormat | undefined>(formats[0]);
  // The view is the table itself when nothing is sorted, filtered or searched.
  const hasView = controller.view.id !== null;
  const [rows, setRows] = useState<ExportChoice["rows"]>(hasView ? "view" : "table");
  const [columns, setColumns] = useState<ExportChoice["columns"]>("visible");
  const [displaySettings, setDisplaySettings] = useState(true);
  const [fileName, setFileName] = useState(() => fileNameFor(options.fileName ?? "export", formats[0] ?? "csv"));
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  if (!support || !format) return null;
  const rowCount = exportRowCount(controller, rows);
  const columnCount = exportColumns(controller, columns).length;
  const limit = format === "xlsx" ? xlsxLimit(rowCount, columnCount) : null;
  const running = status.kind === "running";
  const blocked = rowCount === null || limit !== null || columnCount === 0;

  function chooseFormat(next: ExportFormat) {
    setFormat(next);
    setFileName((name) => fileNameFor(name, next));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running || blocked || !format) return;
    const task = new AbortController();
    abort.current = task;
    setStatus({ kind: "running" });
    try {
      const done = await runExport(
        controller,
        { format, rows, columns, displaySettings, fileName: fileNameFor(fileName, format) },
        options,
        task.signal,
      );
      if (!done) {
        setStatus({ kind: "idle" });
        return;
      }
      const text = messages.exported(count(done.result.rows), done.result.target);
      setStatus({ kind: "done", text });
      onDone(text);
    } catch (error) {
      if (error instanceof ExportInterruptedError) setStatus({ kind: "error", text: messages.exportInterrupted });
      else if (task.signal.aborted || isAbortError(error)) setStatus({ kind: "cancelled" });
      else
        setStatus({
          kind: "error",
          text: messages.exportFailed(error instanceof Error ? error.message : String(error)),
        });
    } finally {
      if (abort.current === task) abort.current = null;
    }
  }

  const totalRows = controller.totalRows;
  return (
    <form className="vg-export" onSubmit={submit}>
      <p className="vg-panel__title">{messages.export}</p>
      <fieldset className="vg-export__group" disabled={running}>
        <legend className="vg-export__legend">{messages.exportFormat}</legend>
        <select
          className="vg-input"
          aria-label={messages.exportFormat}
          value={format}
          data-autofocus
          onChange={(event) => chooseFormat(event.target.value as ExportFormat)}
        >
          {formats.map((item) => (
            <option key={item} value={item}>
              {messages.exportFormats[item]}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset className="vg-export__group" disabled={running}>
        <legend className="vg-export__legend">{messages.exportRows}</legend>
        <label className="vg-check">
          <input
            type="radio"
            name={`${id}-rows`}
            checked={rows === "view"}
            disabled={!hasView}
            onChange={() => setRows("view")}
          />
          <span className="vg-check__label">
            {messages.exportViewRows(controller.viewBuilding ? "…" : count(controller.rowCount))}
          </span>
        </label>
        <label className="vg-check">
          <input type="radio" name={`${id}-rows`} checked={rows === "table"} onChange={() => setRows("table")} />
          <span className="vg-check__label">
            {messages.exportTableRows(totalRows === null ? "…" : count(totalRows))}
          </span>
        </label>
      </fieldset>
      <fieldset className="vg-export__group" disabled={running}>
        <legend className="vg-export__legend">{messages.exportColumns}</legend>
        <label className="vg-check">
          <input
            type="radio"
            name={`${id}-columns`}
            checked={columns === "visible"}
            onChange={() => setColumns("visible")}
          />
          <span className="vg-check__label">{messages.exportVisibleColumns(count(controller.visible.length))}</span>
        </label>
        <label className="vg-check">
          <input type="radio" name={`${id}-columns`} checked={columns === "all"} onChange={() => setColumns("all")} />
          <span className="vg-check__label">{messages.exportAllColumns(count(controller.schema.length))}</span>
        </label>
      </fieldset>
      <fieldset className="vg-export__group" disabled={running}>
        <label className="vg-check">
          <input
            type="checkbox"
            checked={displaySettings}
            disabled={format === "parquet" || format === "json"}
            onChange={(event) => setDisplaySettings(event.target.checked)}
          />
          <span className="vg-check__label">{messages.exportDisplaySettings}</span>
        </label>
        <label className="vg-export__field">
          <span>{messages.exportFileName}</span>
          <input
            className="vg-input"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            onBlur={() => setFileName((name) => fileNameFor(name, format))}
          />
        </label>
      </fieldset>
      <p className="vg-panel__muted">
        {support.delivery === "data" ? messages.exportDownloadHint : messages.exportSaveHint}
      </p>
      {rowCount === null && <p className="vg-panel__muted">{messages.waitForSort}</p>}
      {limit === "rows" && <p className="vg-panel__error">{messages.exportXlsxRows(count(XLSX_MAX_ROWS - 1))}</p>}
      {limit === "columns" && <p className="vg-panel__error">{messages.exportXlsxColumns(count(XLSX_MAX_COLUMNS))}</p>}
      <div className="vg-panel__status" aria-live="polite">
        {status.kind === "running" && <p className="vg-panel__muted">{messages.exporting}</p>}
        {status.kind === "cancelled" && <p className="vg-panel__muted">{messages.exportCancelled}</p>}
        {status.kind === "done" && <p className="vg-panel__muted">{status.text}</p>}
        {status.kind === "error" && (
          <p className="vg-panel__error" role="alert">
            {status.text}
          </p>
        )}
      </div>
      <div className="vg-panel__actions">
        {running ? (
          <button type="button" className="vg-button" onClick={() => abort.current?.abort()}>
            {messages.cancel}
          </button>
        ) : (
          <button type="submit" className="vg-button vg-button--primary" disabled={blocked}>
            {support.delivery === "data" ? messages.exportDownload : messages.exportSave}
          </button>
        )}
      </div>
    </form>
  );
}
