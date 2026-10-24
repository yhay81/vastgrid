import { type ComponentType, type FocusEvent, forwardRef, type KeyboardEvent, useId } from "react";
import type { CellValue, ColumnSchema } from "vastgrid-core";
import type { DetailStatus } from "../detail.js";
import type { Messages } from "../messages.js";

/** A column of the record, in display order. */
export interface DetailField {
  /** Index of the column in the table schema. */
  column: number;
  /** Schema name. */
  name: string;
  /** Name shown for the column (its `columnFormats` label, or the schema name). */
  label: string;
  /** The column is hidden in the grid. */
  hidden: boolean;
  /** The value, read in full; `undefined` while it is being read. */
  value: CellValue | undefined;
  /** The value as the column shows it (`columnFormats`), or "" while it is being read. */
  text: string;
}

/** Props of the component that shows the record in the detail panel (`detailPanel`). */
export interface DetailPanelProps {
  /** Row in the current view. */
  row: number;
  /** Row in the original table, or `null` while the row of a view is not loaded. */
  rowId: number | null;
  /** Values by schema column index; `undefined` while a value is being read. */
  values: (CellValue | undefined)[];
  schema: ColumnSchema[];
  status: DetailStatus;
  /** Why reading the row failed, when `status` is `"error"`. */
  error: string | null;
  /** Every column in display order, hidden ones included, with its label and shown text. */
  fields: DetailField[];
  /** Reads the row again. */
  retry(): void;
  messages: Messages;
}

/** The built-in content: each column's label and its formatted value. */
export function DetailFields({ fields, status, error, retry, messages }: DetailPanelProps) {
  return (
    <>
      {status === "error" && (
        <div className="vg-detail__error" role="alert">
          <span>
            {messages.detailFailed} {error}
          </span>
          <button type="button" className="vg-button" onClick={retry}>
            {messages.retry}
          </button>
        </div>
      )}
      <dl className="vg-detail__fields">
        {fields.map((field) => (
          <div key={field.column} className="vg-detail__field" data-hidden={field.hidden || undefined}>
            <dt title={field.label !== field.name ? field.name : undefined}>
              {field.label}
              {field.hidden && <span className="vg-panel__muted"> · {messages.detailHidden}</span>}
            </dt>
            <dd data-null={field.value === null || undefined} aria-busy={field.value === undefined || undefined}>
              {field.value === undefined ? messages.loading : field.value === null ? "NULL" : field.text}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/**
 * The detail panel next to the grid (below it when the grid is narrow): a labelled complementary
 * region with a title, a close button and the record. Esc closes it and Alt+Enter returns to the grid.
 */
export const DetailPanel = forwardRef<
  HTMLElement,
  {
    title: string;
    messages: Messages;
    content: ComponentType<DetailPanelProps>;
    props: DetailPanelProps | null;
    onClose: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  }
>(function DetailPanel({ title, messages, content: Content, props, onClose, onKeyDown, onFocus, onBlur }, ref) {
  const titleId = useId();
  return (
    <aside
      ref={ref}
      className="vg-detail"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="vg-detail__header">
        <h2 id={titleId} className="vg-detail__title">
          {title}
        </h2>
        <button type="button" className="vg-icon-button" aria-label={messages.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="vg-detail__body" aria-busy={props?.status === "loading" || undefined}>
        {props ? <Content {...props} /> : <p className="vg-panel__muted">{messages.detailEmpty}</p>}
      </div>
    </aside>
  );
});
