/**
 * Tables of typed JSON in DuckDB, and reading their values back as typed JSON (docs/spec.md §2.2), for the
 * tests of this package.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  type Column,
  DATE_INFINITY,
  dateText,
  type JsonValue,
  TIMESTAMP_INFINITY,
  timestampText,
  timestamptzText,
} from "vastgrid-spec";
import type { CorpusTable } from "vastgrid-spec/conformance";
import { duckdbType, floatParam, quoteIdentifier, type SqlValue, temporalParam, textSql } from "../src/index.ts";

/** The column of row IDs in the tables of the corpus: the position of each row. */
export const ROW_ID = "vg_corpus_row";

const FLOAT_TOKENS = new Set(["NaN", "Infinity", "-Infinity"]);

/** A typed JSON value (§2.2) as SQL, with its parameter. */
function input(value: JsonValue, column: Column, params: SqlValue[]): string {
  const type = duckdbType(column);
  if (value === null) return `CAST(NULL AS ${type})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (column.type === "float" && typeof value === "string") {
    if (!FLOAT_TOKENS.has(value)) throw new RangeError(`${value} is not a float.`);
    return `CAST('${value}' AS ${type})`;
  }
  if (typeof value === "number" && column.type === "integer") {
    params.push(value);
    return `CAST($${params.length} AS ${type})`;
  }
  const temporal = column.type === "date" || column.type === "timestamp" || column.type === "timestamptz";
  params.push(
    typeof value === "number" && column.type === "float"
      ? floatParam(value)
      : temporal
        ? temporalParam(String(value))
        : String(value),
  );
  if (column.type === "binary") return `from_base64(CAST($${params.length} AS VARCHAR))`;
  return `CAST(CAST($${params.length} AS VARCHAR) AS ${type})`;
}

export async function createTable(connection: DuckDBConnection, name: string, table: CorpusTable) {
  const columns = table.columns.map((column) => `${quoteIdentifier(column.name)} ${duckdbType(column)}`);
  await connection.run(`CREATE TABLE ${quoteIdentifier(name)} (${columns.join(", ")}, ${ROW_ID} BIGINT)`);
  for (const [index, row] of table.rows.entries()) {
    const params: SqlValue[] = [];
    const values = row.map((value, column) => input(value, table.columns[column], params));
    await connection.run(
      `INSERT INTO ${quoteIdentifier(name)} VALUES (${[...values, String(index)].join(", ")})`,
      params,
    );
  }
}

const EPOCHS = { s: "epoch", ms: "epoch_ms", us: "epoch_us", ns: "epoch_ns" };

/**
 * Reads exact numbers and times as their text, which is how JSON writes them (§2.2), and dates and timestamps as
 * counts from 1970-01-01, which `jsonOf` writes. Strings get a leading "." that `jsonOf` removes:
 * `@duckdb/node-api` 2.0.0-r.1 decodes text with a `TextDecoder` that drops a U+FEFF at the start of a value.
 */
/** DuckDB's infinities as the counts of §2.2. */
function infinities(sql: string, count: number | bigint) {
  return `WHEN ${sql} = 'infinity' THEN ${count} WHEN ${sql} = '-infinity' THEN -${count}`;
}

export function output(column: Column, sql: string): string {
  switch (column.type) {
    case "date":
      return `(CASE WHEN isfinite(${sql}) THEN ${sql} - DATE '1970-01-01' ${infinities(sql, DATE_INFINITY)} END)`;
    case "timestamp":
      return `(CASE WHEN isfinite(${sql}) THEN CAST(${EPOCHS[column.unit ?? "us"]}(${sql}) AS BIGINT) ${infinities(sql, TIMESTAMP_INFINITY)} END)`;
    case "timestamptz":
      return `(CASE WHEN isfinite(${sql}) THEN epoch_us(${sql}) ${infinities(sql, TIMESTAMP_INFINITY)} END)`;
    case "string":
      return `('.' || ${sql})`;
    case "decimal":
      return textSql(sql, column);
    case "bigint":
    case "time":
    case "interval":
    case "uuid":
      return `CAST(${sql} AS VARCHAR)`;
    case "binary":
      return `to_base64(${sql})`;
    default:
      return sql;
  }
}

export function jsonOf(value: unknown, column: Column): JsonValue {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "date":
      return dateText(Number(value));
    case "timestamp":
      return timestampText(BigInt(value as bigint), column.unit ?? "us");
    case "timestamptz":
      return timestamptzText(BigInt(value as bigint));
    case "bigint": {
      const text = String(value);
      return Number.isSafeInteger(Number(text)) ? Number(text) : text;
    }
    case "integer":
      return Number(value);
    case "float": {
      const number = Number(value);
      if (Number.isNaN(number)) return "NaN";
      if (number === Number.POSITIVE_INFINITY) return "Infinity";
      if (number === Number.NEGATIVE_INFINITY) return "-Infinity";
      return number;
    }
    case "boolean":
      return Boolean(value);
    case "string":
      return String(value).slice(1);
    default:
      return String(value);
  }
}
