import {
  EXPORT_EXTENSIONS,
  type ExportFormat,
  type ExportRequest,
  type ExportResult,
  type ExportSupport,
  excelNumberFormat,
  type TableInfo,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_ROWS,
} from "vastgrid-core";
import type { GridController } from "./controller.js";

/** What the user chose in the export panel. */
export interface ExportChoice {
  format: ExportFormat;
  /**
   * `view`: the rows of the current view, with its filters, search and sort. `table`: every row of the
   * table in its original order.
   */
  rows: "view" | "table";
  /** `visible`: the shown columns in display order. `all`: every column in schema order. */
  columns: "visible" | "all";
  /**
   * Write the labels of `columnFormats` as headers (`csv`, `tsv`, `xlsx`) and, for `xlsx`, their number
   * and date formats as Excel number formats. Otherwise the schema names and default formats are used.
   */
  displaySettings: boolean;
  /** The file name the user entered, with its extension. */
  fileName: string;
}

/** An export about to run (or finished): the choice, the request for the source and how the file is delivered. */
export interface ExportContext {
  choice: ExportChoice;
  /** The request passed to `source.exportView`. `target` is the file name until `GridExportOptions.target` changes it. */
  request: ExportRequest;
  delivery: ExportSupport["delivery"];
  /** Rows that will be written. */
  rowCount: number;
  /** Aborts when the user cancels the export. */
  signal: AbortSignal;
}

/**
 * How the grid's export panel saves files. The grid offers the panel when the source can export
 * (`capabilities.export`, `exportView`); the host decides where files go.
 */
export interface GridExportOptions {
  /** Formats to offer, among those the source can write. Defaults to all of them. */
  formats?: ExportFormat[];
  /** The suggested file name without extension. Defaults to `export`. */
  fileName?: string;
  /**
   * Decides the `target` of the export after the user confirmed it, for example by asking for a path
   * or mapping the file name to a folder of the server. Return `null` to cancel. Defaults to the file
   * name the user entered. For sources that return the data (`delivery: "data"`), it is the download name.
   */
  target?: (context: ExportContext) => string | null | Promise<string | null>;
  /**
   * Called when the source finished the file. Without it, data returned by the source
   * (`result.data`, from `ArraySource` for example) is downloaded by the browser, and files written by
   * the source (a server) are only reported. Use it to save the data elsewhere, or to offer a file the
   * server wrote for download (for example by opening a URL of your server).
   */
  onExported?: (result: ExportResult, context: ExportContext) => void | Promise<void>;
}

const legacyFormats: ExportFormat[] = ["csv", "tsv", "parquet", "json"];

/** What the source can export, or `null` when it cannot (see `TableInfo.exports`). */
export function exportSupport(info: TableInfo | null, exportView: unknown): ExportSupport | null {
  if (info?.status !== "ready" || !info.capabilities.export || typeof exportView !== "function") return null;
  return info.exports ?? { formats: legacyFormats, delivery: "file" };
}

/** The formats to offer: those of the source, limited to `formats` when given. */
export function offeredFormats(support: ExportSupport, formats?: ExportFormat[]) {
  return support.formats.filter((format) => !formats || formats.includes(format));
}

/** Gives a file name the extension of `format`, replacing another export extension. */
export function fileNameFor(name: string, format: ExportFormat) {
  const base = name.trim().replace(/\.(csv|tsv|parquet|json|xlsx)$/i, "") || "export";
  return `${base}${EXPORT_EXTENSIONS[format]}`;
}

/** Rows the choice writes, or `null` while the view is still being built. */
export function exportRowCount(controller: GridController, rows: ExportChoice["rows"]) {
  if (rows === "table") return controller.totalRows;
  if (controller.viewPending || controller.viewBuilding) return null;
  return controller.rowCount;
}

/** Schema column indexes the choice writes, in order. */
export function exportColumns(controller: GridController, columns: ExportChoice["columns"]) {
  return columns === "all"
    ? controller.schema.map((_, index) => index)
    : controller.visible.map((column) => column.index);
}

/** Why an Excel sheet cannot hold the choice, or `null`. */
export function xlsxLimit(rows: number | null, columns: number) {
  if (rows !== null && rows + 1 > XLSX_MAX_ROWS) return "rows";
  if (columns > XLSX_MAX_COLUMNS) return "columns";
  return null;
}

/** The request for the source's `exportView`. */
export function exportRequest(controller: GridController, choice: ExportChoice): ExportRequest {
  const columns = exportColumns(controller, choice.columns);
  const request: ExportRequest = {
    view: choice.rows === "view" ? controller.view.id : null,
    format: choice.format,
    columns,
    target: fileNameFor(choice.fileName, choice.format),
  };
  if (choice.displaySettings) {
    if (choice.format !== "parquet" && choice.format !== "json") {
      request.headers = columns.map((index) => controller.columnLabel(index));
    }
    if (choice.format === "xlsx") {
      const formats = controller.options.columnFormats ?? {};
      const numberFormats = columns.map((index) => {
        const schema = controller.schema[index];
        return excelNumberFormat(schema, formats[schema.name], {
          locale: controller.options.locale,
          grouping: controller.formatter.grouping,
        });
      });
      if (numberFormats.some((format) => format !== null)) request.numberFormats = numberFormats;
    }
  }
  return request;
}

/** Saves a `Blob` as a download in the browser. */
export function downloadBlob(data: Blob, fileName: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can stop the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Runs an export as the panel does: asks the host for the target, calls `exportView`, then hands the
 * result to the host (or downloads returned data). Returns `null` when the host cancelled.
 */
export async function runExport(
  controller: GridController,
  choice: ExportChoice,
  options: GridExportOptions,
  signal: AbortSignal,
): Promise<{ result: ExportResult; context: ExportContext } | null> {
  const support = exportSupport(controller.info, controller.source.exportView);
  const exportView = controller.source.exportView?.bind(controller.source);
  if (!support || !exportView) throw new Error("This table cannot be exported.");
  const rowCount = exportRowCount(controller, choice.rows);
  if (rowCount === null) throw new Error("The view is still being sorted.");
  const context: ExportContext = {
    choice,
    request: exportRequest(controller, choice),
    delivery: support.delivery,
    rowCount,
    signal,
  };
  const target = options.target ? await options.target(context) : context.request.target;
  if (target === null || signal.aborted) return null;
  context.request = { ...context.request, target };
  const result = await exportView(context.request, signal);
  if (options.onExported) await options.onExported(result, context);
  else if (result.data) downloadBlob(result.data, fileNameFor(target.split(/[\\/]/).pop() ?? target, choice.format));
  return { result, context };
}
