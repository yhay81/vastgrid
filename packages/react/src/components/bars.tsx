import { useEffect, useRef, useState } from "react";
import { filtersRows, pruneFilterNode } from "vastgrid-core";
import type { GridController } from "../controller.js";
import { conditionLabel, countFormat, filterLabel, numberFormat } from "../labels.js";
import type { Messages } from "../messages.js";

/** Search box, active sort, filters and conditions, row count and the columns button. */
export function Toolbar({
  controller,
  messages,
  onConditions,
  onColumns,
}: {
  controller: GridController;
  messages: Messages;
  /** Opens the conditions builder. */
  onConditions: (button: HTMLButtonElement) => void;
  onColumns: (button: HTMLButtonElement) => void;
}) {
  const query = controller.query;
  const [search, setSearch] = useState(query.search ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const applied = query.search ?? "";
  const lastApplied = useRef(applied);
  // Follow changes made elsewhere (for example "Clear all").
  if (applied !== lastApplied.current) {
    lastApplied.current = applied;
    if (search !== applied) setSearch(applied);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  const ready = controller.info?.status === "ready";
  const capabilities = controller.info?.capabilities;
  const count = countFormat(controller.options.locale);
  const filters = query.filters ?? [];
  const where = pruneFilterNode(query.where);
  const sort = query.sort ?? [];
  const total = controller.totalRows;
  const filtered = controller.view.id !== null && filtersRows(query);
  let rows: string;
  if (controller.info?.status === "loading") {
    const progress = controller.info.progress;
    rows =
      progress !== null && progress !== undefined && progress > 0
        ? messages.loadingProgress(`${Math.round(progress * 100)}%`)
        : messages.loadingRows(count(controller.readableRows));
  } else if (controller.viewBuilding) {
    rows = messages.sortingRows(count(controller.readableRows), count(controller.rowCount));
  } else if (filtered && total !== null) {
    rows = messages.rowsOf(count(controller.rowCount), count(total));
  } else {
    rows = messages.rows(count(controller.rowCount));
  }

  function change(value: string) {
    setSearch(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => controller.setSearch(value), 350);
  }

  return (
    <div className="vg-toolbar">
      <input
        type="search"
        className="vg-input vg-toolbar__search"
        placeholder={messages.searchPlaceholder}
        aria-label={messages.search}
        value={search}
        disabled={!ready || !capabilities?.search}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            clearTimeout(timer.current);
            controller.setSearch(search);
          }
        }}
      />
      {sort.length > 0 && (
        <span className="vg-chip">
          <span>
            {messages.sortedBy(
              sort
                .map(
                  (key) =>
                    `${controller.schema[key.column] ? controller.columnLabel(key.column) : key.column} ${key.direction === "asc" ? "↑" : "↓"}`,
                )
                .join(", "),
            )}
          </span>
          <button
            type="button"
            className="vg-chip__remove"
            aria-label={messages.clearSort}
            title={messages.clearSort}
            onClick={() => controller.clearSort()}
          >
            ×
          </button>
        </span>
      )}
      {filters.map((filter) => {
        const formatter = controller.schema[filter.column] ? controller.formatterOf(filter.column) : undefined;
        const label = filterLabel(filter, formatter, messages);
        return (
          <span className="vg-chip vg-chip--filter" key={filter.column}>
            <span title={label}>{label}</span>
            <button
              type="button"
              className="vg-chip__remove"
              aria-label={messages.removeFilter(label)}
              title={messages.removeFilter(label)}
              onClick={() => controller.setFilter(filter.column, null)}
            >
              ×
            </button>
          </span>
        );
      })}
      {where &&
        (() => {
          const label = conditionLabel(
            where,
            (column) => (controller.schema[column] ? controller.formatterOf(column) : undefined),
            messages,
          );
          return (
            <span className="vg-chip vg-chip--filter">
              <button
                type="button"
                className="vg-chip__label"
                title={`${messages.editConditions} ${label}`}
                onClick={(event) => onConditions(event.currentTarget)}
              >
                {label}
              </button>
              <button
                type="button"
                className="vg-chip__remove"
                aria-label={messages.removeFilter(label)}
                title={messages.removeFilter(label)}
                onClick={() => {
                  const { where: _, ...rest } = query;
                  void controller.setQuery(rest);
                }}
              >
                ×
              </button>
            </span>
          );
        })()}
      <button
        type="button"
        className="vg-button vg-button--small"
        disabled={!ready || !capabilities?.filter || !capabilities.conditions}
        onClick={(event) => onConditions(event.currentTarget)}
      >
        {messages.conditions}
      </button>
      {filtersRows(query) && (
        <button type="button" className="vg-button vg-button--small" onClick={() => controller.clearFilters()}>
          {messages.clearFilters}
        </button>
      )}
      <span className="vg-toolbar__spacer" />
      <span className="vg-toolbar__count" aria-live="polite">
        {controller.viewPending ? messages.buildingView : rows}
      </span>
      <button
        type="button"
        className="vg-button vg-button--small"
        onClick={(event) => onColumns(event.currentTarget)}
        disabled={!controller.info}
      >
        {messages.columns}
      </button>
    </div>
  );
}

/** The active cell and, for multi-cell selections, count, sum, average, minimum and maximum. */
export function StatusBar({ controller, messages }: { controller: GridController; messages: Messages }) {
  const count = countFormat(controller.options.locale);
  const number = numberFormat(controller.options.locale);
  const active = controller.selection.active;
  const schema = controller.columnSchema(active.col);
  const summary = controller.summary;
  const label = controller.rowLabel(active.row);
  const notes = (controller.info?.notes ?? []).map((note) => messages.notes[note] ?? note);
  return (
    <div className="vg-statusbar">
      {controller.rowCount > 0 && schema && (
        <span className="vg-statusbar__cell">
          {messages.cell(count(active.row + 1), controller.columnLabel(controller.visible[active.col].index))}
          {controller.view.id !== null && label !== null && (
            <span className="vg-statusbar__muted"> · {messages.originalRow(count(label))}</span>
          )}
        </span>
      )}
      {notes.length > 0 && <span className="vg-statusbar__note">{notes.join(" ")}</span>}
      <span className="vg-toolbar__spacer" />
      {summary && (
        <span className="vg-statusbar__summary">
          <span>
            {messages.summary.count}: {count(summary.count)}
          </span>
          {summary.numericCount > 0 && summary.sum !== null && (
            <>
              <span>
                {messages.summary.average}: {number(summary.average ?? 0)}
              </span>
              <span>
                {messages.summary.min}: {number(summary.min ?? 0)}
              </span>
              <span>
                {messages.summary.max}: {number(summary.max ?? 0)}
              </span>
              <span>
                {messages.summary.sum}: {number(summary.sum)}
              </span>
            </>
          )}
        </span>
      )}
      {!summary && controller.summaryPending && <span className="vg-statusbar__muted">…</span>}
    </div>
  );
}
