/**
 * Types and values (docs/spec.md §2). Values are written as JSON and read with the type of their column
 * or literal (§2.2).
 */

/** Logical types (§2.1). */
export const LOGICAL_TYPES = [
  "boolean",
  "integer",
  "bigint",
  "decimal",
  "float",
  "string",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "binary",
] as const;

export type LogicalType = (typeof LOGICAL_TYPES)[number];

export type TimestampUnit = "s" | "ms" | "us" | "ns";

/** A logical type with the members it needs (§2.1). */
export interface ValueType {
  type: LogicalType;
  /** Decimals: digits in all, from 1 to 38. */
  precision?: number;
  /** Decimals: digits after the point, from 0 to `precision`. */
  scale?: number;
  /** Floats: 32 or 64 (the default). */
  bits?: 32 | 64;
  /** Timestamps: `us` by default. */
  unit?: TimestampUnit;
}

/** A column of a table or a view (§2.1, §4.2). */
export interface Column extends ValueType {
  name: string;
  /** The engine's own type name, such as `DECIMAL(10,2)`. */
  sourceType?: string;
  /** The engine does not write this column (§7). */
  readOnly?: boolean;
  /** A generated column of a pivot (§4.6): the values of its combination and its measure. */
  pivot?: { values: JsonValue[]; measure: string };
}

/** A value as JSON (§2.2). */
export type JsonValue = string | number | boolean | null;
