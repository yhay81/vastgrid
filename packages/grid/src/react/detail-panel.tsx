import { type ComponentType, use, useLayoutEffect, useRef, useState } from "react";
import type { Column, ColumnFormat, JsonValue, RowKey } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useFullValue, valueText } from "./full-value.js";
import { useGridRows, useGridSelector, useGridStore } from "./hooks.js";
import type { ViewerTarget } from "./value-viewer.js";

/**
 * The detail panel of the active row (§5.2 of the specification, `detail`): every column of the view, hidden ones
 * included, with its label and its value in full, by the column's format. It follows the active cell, reads the
 * row's values that the canvas did not (`useGridRows`), and is opened and closed by `detail.open` and
 * `detail.close`; the focus stays in the grid, and goes back to it when the panel is closed from inside (× or Esc).
 */
export function DetailPanel({
  custom,
  onClosed,
  onView,
}: {
  custom?: ComponentType<DetailPanelProps>;
  /** Called when the panel is closed from inside it, to give the focus back to the grid. */
  onClosed: () => void;
  /** Opens a value in the viewer. */
  onView: (target: ViewerTarget) => void;
}) {
  const open = useGridSelector((snapshot) => snapshot.session.detail?.open === true);
  // Closed, it follows no rows: scrolling commits nothing (§10 of react.md).
  return open ? <OpenDetail Custom={custom} onClosed={onClosed} onView={onView} /> : null;
}

/** What a host's own detail panel (`detailPanel`) gets: the active row's position, the view's columns and values. */
export interface DetailPanelProps {
  row: number;
  columns: readonly Column[];
  values: readonly JsonValue[];
  /** The row's key (§5.3), when it is read. */
  rowKey: RowKey | undefined;
}

function OpenDetail({
  Custom,
  onClosed,
  onView,
}: {
  Custom?: ComponentType<DetailPanelProps>;
  onClosed: () => void;
  onView: (target: ViewerTarget) => void;
}) {
  const store = useGridStore();
  const { messages, number } = use(LocaleContext);
  const row = useGridSelector((snapshot) => snapshot.session.active?.row ?? 0);
  const rowCount = useGridSelector((snapshot) => snapshot.view?.rowCount ?? 0);
  const columns = useGridSelector((snapshot) => snapshot.view?.columns);
  const settings = useGridSelector((snapshot) => snapshot.document.columns);
  // The columns shown whole: they stay so while the active row moves.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const names = columns && rowCount > 0 ? columns.map((column) => column.name) : [];
  const [values] = useGridRows({ start: row, end: names.length > 0 ? row + 1 : row, columns: names });
  if (!columns) return null;
  const byName = new Map((settings ?? []).map((setting) => [setting.name, setting]));
  const title = rowCount > 0 ? messages.detailOf(number.format(row + 1)) : messages.details;
  const close = () => {
    void store.dispatch({ command: "detail.close" });
    onClosed();
  };
  const toggle = (name: string) => {
    const next = new Set(expanded);
    if (!next.delete(name)) next.add(name);
    setExpanded(next);
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape bubbles from its controls.
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
              <DetailItem
                key={column.name}
                row={row}
                column={column}
                format={byName.get(column.name)?.format}
                value={values?.[index]}
                expanded={expanded.has(column.name)}
                onToggle={() => toggle(column.name)}
                onView={() => onView({ row, column: column.name })}
              />
            ))}
          </dl>
        )
      )}
    </aside>
  );
}

/**
 * A column of the detail panel: its label and its value in full (read again when the engine cut it, §8.4). A long
 * value shows its first lines (`--vg-detail-lines`) until Show more, and opens in the viewer.
 */
function DetailItem({
  row,
  column,
  format,
  value,
  expanded,
  onToggle,
  onView,
}: {
  row: number;
  column: Column;
  format: ColumnFormat | undefined;
  value: JsonValue | undefined;
  expanded: boolean;
  onToggle: () => void;
  onView: () => void;
}) {
  const { messages, locale } = use(LocaleContext);
  const full = useFullValue(row, column.name, value);
  const text =
    full.error !== undefined
      ? messages.failed(full.error)
      : full.value === undefined
        ? messages.loading
        : valueText(full.value, column, format, locale);
  const ref = useRef<HTMLElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    // Shown whole, it overflows as it did: Show less stays.
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  const label = format?.label ?? column.name;
  const long = overflows || full.cut;
  return (
    <div className="vg-detail__item">
      <dt>
        <span className="vg-detail__label">{label}</span>
        {long && (
          <span className="vg-detail__actions">
            <button type="button" className="vg-detail__action" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? messages.showLess : messages.showMore}
            </button>
            <button
              type="button"
              className="vg-detail__action"
              aria-label={messages.openViewerOf(label)}
              onClick={onView}
            >
              {messages.openViewer}
            </button>
          </span>
        )}
      </dt>
      <dd ref={ref} data-clamped={overflows && !expanded ? "" : undefined} data-expanded={expanded ? "" : undefined}>
        {text}
      </dd>
    </div>
  );
}
