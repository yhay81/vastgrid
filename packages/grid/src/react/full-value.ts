import { useEffect, useState } from "react";
import { type ColumnFormat, formatterFor, type JsonValue, textOf, type ValueType } from "vastgrid-spec";
import { useGridStore } from "./hooks.js";

/** A cell's value in full: undefined while it is read, `cut` when it is longer than the largest text limit. */
export interface FullValue {
  value: JsonValue | undefined;
  cut: boolean;
  error?: string;
}

/**
 * The value of a cell of the view on screen in full: `value` as the grid read it, or, when the engine cut its text
 * to the text limit (§8.4), read again without it (`GridStore.fullValue`), so that the panels show all of it.
 */
export function useFullValue(row: number, column: string, value: JsonValue | undefined): FullValue {
  const store = useGridStore();
  const cut = value !== undefined && store.isCut(row, column);
  const [read, setRead] = useState<{ row: number; column: string; value: JsonValue; result: FullValue } | null>(null);
  useEffect(() => {
    if (!cut || value === undefined) return;
    const abort = new AbortController();
    store.fullValue(row, column, abort.signal).then(
      (result) => setRead({ row, column, value, result: { value: result.value, cut: result.cut } }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setRead({ row, column, value, result: { value: undefined, cut: false, error: message } });
      },
    );
    return () => abort.abort();
  }, [store, row, column, cut, value]);
  if (!cut) return { value, cut: false };
  // The read of another cell, or of this one before the view changed, is not this value.
  if (read && read.row === row && read.column === column && read.value === value) return read.result;
  return { value: undefined, cut: false };
}

/** A value as the panels show it: by the column's format, else as text (§2.2). */
export function valueText(
  value: JsonValue,
  column: ValueType,
  format: ColumnFormat | undefined,
  locale: string | undefined,
): string {
  if (value === null) return "";
  return formatterFor(column, format, locale)?.(value) ?? textOf(value, column) ?? "";
}
