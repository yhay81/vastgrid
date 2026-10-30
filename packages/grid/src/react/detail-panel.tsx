import { type ComponentType, use } from "react";
import { type Column, formatterFor, type JsonValue, type RowKey, textOf } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useGridRows, useGridSelector, useGridStore } from "./hooks.js";

/**
 * The detail panel of the active row (§5.2 of the specification, `detail`): every column of the view, hidden ones
 * included, with its label and its value in full, by the column's format. It follows the active cell, reads the
 * row's values that the canvas did not (`useGridRows`), and is opened and closed by `detail.open` and
 * `detail.close`; the focus stays in the grid, and goes back to it when the panel is closed from inside (× or Esc).
 */
export function DetailPanel({
  custom,
  onClosed,
}: {
  custom?: ComponentType<DetailPanelProps>;
  /** Called when the panel is closed from inside it, to give the focus back to the grid. */
  onClosed: () => void;
}) {
  const open = useGridSelector((snapshot) => snapshot.session.detail?.open === true);
  // Closed, it follows no rows: scrolling commits nothing (§10 of react.md).
  return open ? <OpenDetail Custom={custom} onClosed={onClosed} /> : null;
}

/** What a host's own detail panel (`detailPanel`) gets: the active row's position, the view's columns and values. */
export interface DetailPanelProps {
  row: number;
  columns: readonly Column[];
  values: readonly JsonValue[];
  /** The row's key (§5.3), when it is read. */
  rowKey: RowKey | undefined;
}

function OpenDetail({ Custom, onClosed }: { Custom?: ComponentType<DetailPanelProps>; onClosed: () => void }) {
  const store = useGridStore();
  const { messages, number, locale } = use(LocaleContext);
  const row = useGridSelector((snapshot) => snapshot.session.active?.row ?? 0);
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const columns = useGridSelector((snapshot) => snapshot.view?.columns);
  const settings = useGridSelector((snapshot) => snapshot.document.columns);
  const names = columns && rowCount > 0 ? columns.map((column) => column.name) : [];
  const [values] = useGridRows({ start: row, end: names.length > 0 ? row + 1 : row, columns: names });
  if (!columns) return null;
  const byName = new Map((settings ?? []).map((setting) => [setting.name, setting]));
  const text = (value: JsonValue | undefined, index: number) => {
    if (value === undefined) return messages.loading;
    if (value === null) return "";
    const column = columns[index];
    const format = byName.get(column.name)?.format;
    return formatterFor(column, format, locale)?.(value) ?? textOf(value, column) ?? "";
  };
  const title = rowCount > 0 ? messages.detailOf(number.format(row + 1)) : messages.details;
  const close = () => {
    void store.dispatch({ command: "detail.close" });
    onClosed();
  };
  return (
    <aside
      className="vg-detail"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        close();
      }}
    >
      <header className="vg-detail__header">
        <h2 className="vg-detail__title">{title}</h2>
        <button type="button" className="vg-button vg-button--small" aria-label={messages.closeDetails} onClick={close}>
          ×
        </button>
      </header>
      {rowCount > 0 && Custom && values?.every((value) => value !== undefined) ? (
        <Custom row={row} columns={columns} values={values as JsonValue[]} rowKey={store.rowKey(row)} />
      ) : rowCount > 0 && Custom ? (
        <p className="vg-filter__note">{messages.loading}</p>
      ) : (
        rowCount > 0 && (
          <dl className="vg-detail__list">
            {columns.map((column, index) => (
              <div key={column.name} className="vg-detail__item">
                <dt>{byName.get(column.name)?.format?.label ?? column.name}</dt>
                <dd>{text(values?.[index], index)}</dd>
              </div>
            ))}
          </dl>
        )
      )}
    </aside>
  );
}
