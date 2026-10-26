import { use, useEffect, useState } from "react";
import type { CellRange } from "vastgrid-spec";
import type { GridStore } from "../core/store.js";
import { LocaleContext, SaveContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

interface Summary {
  count: number;
  numericCount: number;
  sum: unknown;
  average: unknown;
}

/** How long the selection must stay before it is summed. */
const SUMMARY_DELAY = 150;

/**
 * The count and sum of a selection of one range of several cells (`summarize`, §8.2), read once the selection has
 * stayed for a moment, so that holding a key or dragging never waits for it; null otherwise.
 */
function useSummary(store: GridStore, selection: readonly CellRange[] | undefined): Summary | null {
  const [result, setResult] = useState<{ selection: readonly CellRange[]; summary: Summary } | null>(null);
  const summarizes = useGridSelector((snapshot) => snapshot.table?.capabilities.summarize === true);
  const range = selection?.length === 1 ? selection[0] : undefined;
  const several =
    range !== undefined &&
    (range.rows === "all" || range.rows[1] - range.rows[0] > 1 || range.columns === "all" || range.columns.length > 1);
  useEffect(() => {
    if (!summarizes || !several || !selection || !range) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const snapshot = store.getSnapshot();
      const rowCount = snapshot.view?.rowCount ?? 0;
      const rows: [number, number] = range.rows === "all" ? [0, rowCount] : [range.rows[0], range.rows[1]];
      const columns = range.columns === "all" ? snapshot.displayed.map((item) => item.column.name) : range.columns;
      store
        .summarize([rows], columns, abort.signal)
        .then((summary) => setResult({ selection, summary }))
        .catch(() => {});
    }, SUMMARY_DELAY);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [store, summarizes, several, selection, range]);
  return result && result.selection === selection ? result.summary : null;
}

function format(number: Intl.NumberFormat, value: unknown) {
  if (typeof value === "number") return number.format(value);
  return typeof value === "string" ? value : "";
}

/**
 * The status bar: the active cell, the sum of the selection, what the grid is doing (saving and the outcome of the
 * last save included) or that the file changed on disk, the cells not saved yet and the rows.
 */
export function StatusBar() {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const saving = use(SaveContext);
  const saves = useGridSelector((snapshot) => snapshot.table?.capabilities.save === true);
  const edits = useGridSelector((snapshot) => snapshot.table?.edits);
  const revision = useGridSelector((snapshot) => snapshot.table?.revision);
  const fileChanged = useGridSelector((snapshot) => snapshot.table?.fileChanged === true);
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount);
  const status = useGridSelector((snapshot) => snapshot.status);
  const building = useGridSelector((snapshot) => snapshot.view?.status === "building");
  const pending = useGridSelector((snapshot) => snapshot.pending !== null);
  const error = useGridSelector((snapshot) => snapshot.error);
  const active = useGridSelector((snapshot) => snapshot.session.active);
  const selection = useGridSelector((snapshot) => snapshot.session.selection);
  const summary = useSummary(store, selection);
  const doing =
    status === "error" && error
      ? messages.failed(error.message)
      : rowCount === undefined
        ? messages.loading
        : saving?.pending
          ? messages.saving
          : saving?.outcome && edits && revision === saving.outcome.revision && edits.version <= saving.outcome.version
            ? saving.outcome.text
            : fileChanged
              ? messages.changedOnDisk
              : pending || building
                ? messages.reading
                : "";
  return (
    <div className="vg-statusbar">
      <span className="vg-statusbar__cell">
        {active && rowCount !== undefined && rowCount > 0
          ? messages.cell(number.format(active.row + 1), active.column)
          : ""}
      </span>
      <span className="vg-toolbar__spacer" />
      {summary && (
        <span className="vg-statusbar__summary">
          <span>{messages.count(number.format(summary.count))}</span>
          {summary.numericCount > 0 && <span>{messages.sum(format(number, summary.sum))}</span>}
          {summary.numericCount > 0 && <span>{messages.average(format(number, summary.average))}</span>}
        </span>
      )}
      <span className="vg-statusbar__muted" role="status">
        {doing}
      </span>
      {saves && edits && edits.cells > 0 && (
        <span className="vg-statusbar__unsaved">{messages.unsaved(number.format(edits.cells))}</span>
      )}
      <span className="vg-toolbar__count">{rowCount === undefined ? "" : messages.rows(number.format(rowCount))}</span>
    </div>
  );
}
