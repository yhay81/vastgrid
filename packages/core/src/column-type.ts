import type { ColumnType } from "./types.js";

const numericTypes = new Set<ColumnType>(["integer", "bigint", "float", "decimal"]);

/** Whether values of the type are numbers (right-aligned, summable). */
export function isNumericType(type: ColumnType) {
  return numericTypes.has(type);
}

/** Whether values of the type are dates or times. */
export function isTemporalType(type: ColumnType) {
  return type === "date" || type === "time" || type === "timestamp" || type === "timestamptz";
}
