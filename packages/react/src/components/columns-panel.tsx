import { useState } from "react";
import type { ColumnPin, ColumnSchema } from "vastgrid-core";
import type { ColumnState } from "../controller.js";
import type { Messages } from "../messages.js";

/** Shows and hides columns, and freezes them at the left or the right. */
export function ColumnsPanel({
  columns,
  schema,
  labelOf,
  messages,
  pinOf,
  onToggle,
  onPin,
  onShowAll,
}: {
  columns: ColumnState[];
  schema: ColumnSchema[];
  /** The name shown for a schema column. */
  labelOf: (index: number) => string;
  messages: Messages;
  /** Where a schema column is frozen. */
  pinOf: (index: number) => ColumnPin;
  onToggle: (index: number, hidden: boolean) => void;
  onPin: (index: number, pin: ColumnPin) => void;
  onShowAll: () => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visibleCount = columns.filter((column) => !column.hidden).length;
  const shown = columns.filter(
    (column) =>
      !needle ||
      (schema[column.index]?.name ?? "").toLowerCase().includes(needle) ||
      labelOf(column.index).toLowerCase().includes(needle),
  );
  return (
    <div className="vg-columns">
      <p className="vg-panel__title">{messages.columns}</p>
      <input
        type="search"
        className="vg-input"
        placeholder={messages.search}
        aria-label={messages.search}
        value={search}
        data-autofocus
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="vg-filter__values">
        {shown.map((column) => (
          <label className="vg-check" key={column.index}>
            <input
              type="checkbox"
              checked={!column.hidden}
              disabled={!column.hidden && visibleCount <= 1}
              onChange={(event) => onToggle(column.index, !event.target.checked)}
            />
            <span className="vg-check__label">{labelOf(column.index)}</span>
            <span className="vg-check__count">{messages.types[schema[column.index]?.type ?? "unknown"]}</span>
            <select
              className="vg-input vg-columns__pin"
              aria-label={messages.columnPin(labelOf(column.index))}
              value={pinOf(column.index) ?? ""}
              disabled={column.hidden}
              onChange={(event) => {
                const value = event.target.value;
                onPin(column.index, value === "left" || value === "right" ? value : null);
              }}
            >
              <option value="">{messages.pinNone}</option>
              <option value="left">{messages.pinLeft}</option>
              <option value="right">{messages.pinRight}</option>
            </select>
          </label>
        ))}
      </div>
      <div className="vg-panel__actions">
        <button type="button" className="vg-button" onClick={onShowAll} disabled={visibleCount === columns.length}>
          {messages.showAllColumns}
        </button>
      </div>
    </div>
  );
}
