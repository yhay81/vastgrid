/**
 * What a Server Component or a server render calls (§7 of react.md). Imports no React.
 */
import {
  checkPlan,
  displayedColumns,
  emptyDocument,
  type GridDocument,
  planOptions,
  repairDocument,
} from "vastgrid-spec";
import { GridClient, type Transport } from "./core/client.js";
import type { InitialView, OpenOptions, RowsResult, TableInfo } from "./core/types.js";

export interface ReadInitialOptions {
  /** The `ref` of the table to open (§8.2). */
  table: string;
  open?: OpenOptions;
  /** The document the grid starts with; its plan is the view read. */
  document?: GridDocument;
  /** Rows to read from the start of the view; 100 by default. */
  rows?: number;
  signal?: AbortSignal;
}

/**
 * Reads the table, the view of a document and its first rows, for `initial` (§7 of react.md): give the result,
 * or the promise of it, to `DataGrid`. Opens the table and closes it again.
 */
export async function readInitialView(transport: Transport, options: ReadInitialOptions): Promise<InitialView> {
  const client = new GridClient(transport);
  const info = await client.request<TableInfo>(
    "open",
    { ref: options.table, ...(options.open ? { read: options.open } : {}) },
    options.signal,
  );
  try {
    const document = repairDocument(
      options.document ?? emptyDocument(),
      info.columns,
      planOptions(info.capabilities),
    ).document;
    const plan = document.plan ?? {};
    const view = checkPlan(plan, info.columns, planOptions(info.capabilities));
    const columns = displayedColumns(document, view.columns).map((item) => item.column.name);
    if (document.rowKey !== undefined && !columns.includes(document.rowKey)) columns.push(document.rowKey);
    const wanted = options.rows ?? 100;
    const end = info.rowCount === null ? wanted : Math.min(wanted, info.rowCount);
    const rows = await client.request<RowsResult>(
      "rows",
      { table: info.table, revision: info.revision, plan, start: 0, end: Math.max(end, 1), columns },
      options.signal,
    );
    return { table: info, plan, rows };
  } finally {
    await client.request("close", { table: info.table }).catch(() => {});
  }
}
