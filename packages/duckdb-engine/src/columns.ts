/**
 * DuckDB's types as the logical types of docs/spec.md §2.1, and how the engine reads their values as typed
 * JSON (§2.2).
 */
import {
  type Column,
  dateText,
  floatJson,
  type JsonValue,
  parseTimestampText,
  type TimestampUnit,
  timestampText,
  type ValueType,
} from "vastgrid-spec";
import { duckdbType, FIRST_DATE, LAST_DATE, quoteIdentifier, temporalParam, textSql } from "vastgrid-sql";

/** A column of a source as DuckDB describes it. */
export interface SourceColumn {
  /** The column's name in the source, which is also its name in the table (§4.2). */
  name: string;
  /** DuckDB's type, such as `DECIMAL(10,2)` or `VARCHAR[]`. */
  sqlType: string;
}

const INTEGERS = new Set(["TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT"]);
const WIDE = new Set(["UBIGINT", "HUGEINT", "UHUGEINT"]);
const TIMESTAMPS: Record<string, ValueType> = {
  TIMESTAMP: { type: "timestamp" },
  TIMESTAMP_S: { type: "timestamp", unit: "s" },
  TIMESTAMP_MS: { type: "timestamp", unit: "ms" },
  TIMESTAMP_NS: { type: "timestamp", unit: "ns" },
  "TIMESTAMP WITH TIME ZONE": { type: "timestamptz" },
};
const SAME: Record<string, ValueType> = {
  BOOLEAN: { type: "boolean" },
  BIGINT: { type: "bigint" },
  UINTEGER: { type: "bigint" },
  FLOAT: { type: "float", bits: 32 },
  DOUBLE: { type: "float" },
  VARCHAR: { type: "string" },
  DATE: { type: "date" },
  TIME: { type: "time" },
  INTERVAL: { type: "interval" },
  UUID: { type: "uuid" },
  BLOB: { type: "binary" },
};

/**
 * The column of the table that a source column is (§2.1): its logical type, with `sourceType`, and `readOnly`
 * for the types that are read as their text (lists, structs, maps, unions, JSON, enums, bit strings and others).
 */
export function tableColumn(source: SourceColumn): Column {
  const sqlType = source.sqlType.toUpperCase();
  const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(sqlType);
  let type: ValueType | undefined;
  if (decimal) type = { type: "decimal", precision: Number(decimal[1]), scale: Number(decimal[2]) };
  else if (WIDE.has(sqlType)) type = { type: "decimal", precision: 38, scale: 0 };
  else if (INTEGERS.has(sqlType)) type = { type: "integer" };
  else type = TIMESTAMPS[sqlType] ?? SAME[sqlType];
  if (!type) return { name: source.name, type: "string", sourceType: source.sqlType, readOnly: true };
  return { name: source.name, ...type, sourceType: source.sqlType };
}

/**
 * The SQL that gives a source column as its table column: cast to the DuckDB type of its logical type, so that
 * plans mean the same on every source (§3). Values of more than 38 digits read as null (§2.1).
 */
export function sourceExpression(source: SourceColumn, column: Column): string {
  const name = quoteIdentifier(source.name);
  const target = duckdbType(column);
  if (column.readOnly && column.type === "string") return `CAST(${name} AS VARCHAR)`;
  if (source.sqlType.toUpperCase() === target) return name;
  return column.type === "decimal" ? `TRY_CAST(${name} AS ${target})` : `CAST(${name} AS ${target})`;
}

/** The SQL of a timestamp's count of its unit since 1970-01-01 00:00:00. */
const EPOCHS: Record<TimestampUnit, (sql: string) => string> = {
  s: (sql) => `CAST(epoch(${sql}) AS BIGINT)`,
  ms: (sql) => `epoch_ms(${sql})`,
  us: (sql) => `epoch_us(${sql})`,
  ns: (sql) => `epoch_ns(${sql})`,
};

/**
 * The SQL that reads a value of a column for `readValue`: exact numbers, times as their text forms (§2.4), dates
 * as days and timestamps as counts of their unit from 1970-01-01, binary values as base64, and strings with a
 * mark in front, `.` for a whole value and `+` for one cut at `textLimit` code points. The mark keeps a U+FEFF at
 * the start of a string, which `@duckdb/node-api` would drop (Appendix B). Values that are not dates or
 * timestamps of §2.2 (`infinity`, and dates beyond the first and the last) read as null (§12).
 */
export function readExpression(column: Column, sql: string, textLimit: number): string {
  switch (column.type) {
    case "boolean":
    case "integer":
    case "bigint":
    case "float":
      return sql;
    case "string":
      return `(CASE WHEN length(${sql}) > ${textLimit} THEN '+' || left(${sql}, ${textLimit}) ELSE '.' || ${sql} END)`;
    case "date":
      return `(CASE WHEN isfinite(${sql}) AND ${sql} BETWEEN ${FIRST_DATE} AND ${LAST_DATE} THEN ${sql} - DATE '1970-01-01' END)`;
    case "timestamp":
      return `(CASE WHEN isfinite(${sql}) THEN ${EPOCHS[column.unit ?? "us"](sql)} END)`;
    case "timestamptz":
      return `(CASE WHEN isfinite(${sql}) THEN epoch_us(${sql}) END)`;
    case "time":
      return `(CASE WHEN ${sql} < TIME '24:00:00' THEN CAST(${sql} AS VARCHAR) END)`;
    case "binary":
      return `to_base64(${sql})`;
    default:
      return textSql(sql, column);
  }
}

/** A value that `readExpression` read, as typed JSON (§2.2); `cut` is true for a string cut at the limit. */
export function readValue(column: Column, value: unknown): { value: JsonValue; cut: boolean } {
  if (value === null || value === undefined) return { value: null, cut: false };
  switch (column.type) {
    case "boolean":
      return { value: Boolean(value), cut: false };
    case "integer":
      return { value: Number(value), cut: false };
    case "bigint": {
      const number = BigInt(value as bigint | number);
      const safe = number >= BigInt(Number.MIN_SAFE_INTEGER) && number <= BigInt(Number.MAX_SAFE_INTEGER);
      return { value: safe ? Number(number) : number.toString(), cut: false };
    }
    case "float":
      return { value: floatJson(Number(value)), cut: false };
    case "string": {
      const text = String(value);
      return { value: text.slice(1), cut: text[0] === "+" };
    }
    case "date":
    case "timestamp":
    case "timestamptz":
      return { value: temporalJson(column, value), cut: false };
    default:
      return { value: String(value), cut: false };
  }
}

/** The text of a date or a timestamp (§2.2) from its count, or null for one beyond the dates. */
function temporalJson(column: Column, value: unknown): string | null {
  try {
    if (column.type === "date") return dateText(Number(value));
    const count = BigInt(value as bigint | number);
    if (column.type === "timestamptz") return `${timestampText(count, "us")}+00`;
    return timestampText(count, column.unit ?? "us");
  } catch {
    return null;
  }
}

/**
 * The SQL of a typed JSON value of a column (§2.2), with its parameters: numbers as text, which DuckDB reads
 * back exactly (`@duckdb/node-api` binds whole numbers as BIGINT).
 */
export function valueExpression(value: JsonValue, type: ValueType, params: unknown[]): string {
  const target = duckdbType(type);
  if (value === null) return `CAST(NULL AS ${target})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  params.push(String(value));
  if (type.type === "binary") return `from_base64(CAST($${params.length} AS VARCHAR))`;
  // DuckDB's VARCHAR cast overflows near the TIMESTAMP_NS limits: give it the exact count.
  if (type.type === "timestamp" && type.unit === "ns") {
    params[params.length - 1] = String(parseTimestampText(String(value), "ns"));
    return `make_timestamp_ns(CAST($${params.length} AS BIGINT))`;
  }
  if (type.type === "date" || type.type === "timestamp" || type.type === "timestamptz") {
    params[params.length - 1] = temporalParam(String(value));
  }
  return `CAST(CAST($${params.length} AS VARCHAR) AS ${target})`;
}
