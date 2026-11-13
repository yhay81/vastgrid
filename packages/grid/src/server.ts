/**
 * What a Server Component or a server render calls (§7 of react.md). Imports no React.
 */
import {
  checkPlan,
  displayedColumns,
  emptyDocument,
  type GridDocument,
  MESSAGE_LIMITS,
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
    const checked = checkPlan(plan, info.columns, planOptions(info.capabilities));
    const probe =
      plan.aggregate?.pivot === undefined
        ? undefined
        : await client.request<RowsResult>(
            "rows",
            { table: info.table, revision: info.revision, plan, start: 0, end: 0, columns: [] },
            options.signal,
          );
    const viewColumns = probe ? probe.view.columns : checked.columns;
    const columns = displayedColumns(document, viewColumns).map((item) => item.column.name);
    if (
      document.rowKey !== undefined &&
      !columns.includes(document.rowKey) &&
      viewColumns.some((column) => column.name === document.rowKey)
    ) {
      columns.push(document.rowKey);
    }
    const wanted = Math.max(0, Math.floor(options.rows ?? 100));
    const knownRowCount = probe ? probe.view.rowCount : plan.aggregate ? null : info.rowCount;
    let end = Math.min(knownRowCount === null ? wanted : Math.min(wanted, knownRowCount), MESSAGE_LIMITS.rows);
    if (end > 0 && columns.length > 0 && end * columns.length > MESSAGE_LIMITS.cells) {
      end = Math.max(1, Math.floor(MESSAGE_LIMITS.cells / columns.length));
    }
    if (probe && (end === 0 || columns.length === 0)) return { table: info, plan, rows: probe };
    const rows = await client.request<RowsResult>(
      "rows",
      {
        table: info.table,
        revision: info.revision,
        plan,
        start: 0,
        end: columns.length === 0 ? 0 : end,
        columns: end === 0 ? [] : columns,
      },
      options.signal,
    );
    return { table: info, plan, rows };
  } finally {
    await client.request("close", { table: info.table }).catch(() => {});
  }
}
