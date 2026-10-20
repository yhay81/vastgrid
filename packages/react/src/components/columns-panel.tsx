import { useState } from "react";
import type { ColumnSchema } from "vastgrid-core";
import type { ColumnState } from "../controller.js";
import type { Messages } from "../messages.js";

/** Shows and hides columns. */
export function ColumnsPanel({
  columns,
  schema,
  messages,
  onToggle,
  onShowAll,
}: {
  columns: ColumnState[];
  schema: ColumnSchema[];
  messages: Messages;
  onToggle: (index: number, hidden: boolean) => void;
  onShowAll: () => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visibleCount = columns.filter((column) => !column.hidden).length;
  const shown = columns.filter(
    (column) => !needle || (schema[column.index]?.name ?? "").toLowerCase().includes(needle),
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
            <span className="vg-check__label">{schema[column.index]?.name}</span>
            <span className="vg-check__count">{messages.types[schema[column.index]?.type ?? "unknown"]}</span>
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
