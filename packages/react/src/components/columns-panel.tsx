import { useState } from "react";
import type { ColumnSchema } from "vastgrid-core";
import type { ColumnState } from "../controller.js";
import type { Messages } from "../messages.js";

/** Shows and hides columns. */
export function ColumnsPanel({
  columns,
  schema,
  labelOf,
  messages,
  onToggle,
  onShowAll,
  broken = [],
  onAddFormula,
  onEditFormula,
}: {
  columns: ColumnState[];
  schema: ColumnSchema[];
  /** The name shown for a schema column. */
  labelOf: (index: number) => string;
  messages: Messages;
  onToggle: (index: number, hidden: boolean) => void;
  onShowAll: () => void;
  /** Formula columns not shown because of an error, with its text. */
  broken?: { name: string; error: string }[];
  /** Opens the editor of a new formula column; left out when the source does not evaluate formulas. */
  onAddFormula?: () => void;
  onEditFormula?: (name: string) => void;
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
          </label>
        ))}
      </div>
      {broken.length > 0 && (
        <div className="vg-columns__broken">
          <p className="vg-panel__muted">{messages.formulaBroken}</p>
          {broken.map((item) => (
            <button
              type="button"
              key={item.name}
              className="vg-columns__formula"
              title={item.error}
              onClick={() => onEditFormula?.(item.name)}
            >
              <span className="vg-check__label">{item.name}</span>
              <span className="vg-panel__error">{item.error}</span>
            </button>
          ))}
        </div>
      )}
      <div className="vg-panel__actions">
        {onAddFormula && (
          <button type="button" className="vg-button" onClick={onAddFormula}>
            {messages.addFormula}
          </button>
        )}
        <button type="button" className="vg-button" onClick={onShowAll} disabled={visibleCount === columns.length}>
          {messages.showAllColumns}
        </button>
      </div>
    </div>
  );
}
