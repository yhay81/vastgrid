import {
  type CellValue,
  type ColumnType,
  type CompareOperator,
  type Filter,
  isNumericType,
  isTemporalType,
  type SortKey,
} from "vastgrid-core";

/** A column as DuckDB sees it: the quoted identifier and its DuckDB type name. */
export interface SqlColumn {
  name: string;
  /** The column's name in the file, when the engine reads it under another `name` (one it needs itself). */
  label?: string;
  /** DuckDB type, for example `BIGINT`, `DECIMAL(10,2)` or `VARCHAR[]`. */
  sqlType: string;
  type: ColumnType;
}

/** Quotes an identifier ("my ""column"""). */
export function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quotes a string literal. Prefer parameters; use this only where DuckDB does not accept them. */
export function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Maps a DuckDB type name onto the shared column types. */
export function columnTypeOf(sqlType: string): ColumnType {
  const type = sqlType.toUpperCase();
  if (type.endsWith("]")) return "list";
  if (type.startsWith("STRUCT")) return "struct";
  if (type.startsWith("MAP")) return "map";
  if (type.startsWith("UNION")) return "struct";
  if (type.startsWith("DECIMAL") || type.startsWith("NUMERIC")) return "decimal";
  switch (type) {
    case "TINYINT":
    case "SMALLINT":
    case "INTEGER":
    case "UTINYINT":
    case "USMALLINT":
    case "UINTEGER":
      return "integer";
    case "BIGINT":
    case "UBIGINT":
    case "HUGEINT":
    case "UHUGEINT":
    case "BIGNUM":
    case "VARINT":
      return "bigint";
    case "FLOAT":
    case "DOUBLE":
      return "float";
    case "BOOLEAN":
      return "boolean";
    case "VARCHAR":
      return "string";
    case "DATE":
      return "date";
    case "TIME":
    case "TIME_NS":
    case "TIME WITH TIME ZONE":
      return "time";
    case "TIMESTAMP":
    case "TIMESTAMP_S":
    case "TIMESTAMP_MS":
    case "TIMESTAMP_NS":
      return "timestamp";
    case "TIMESTAMP WITH TIME ZONE":
      return "timestamptz";
    case "INTERVAL":
      return "interval";
    case "UUID":
      return "uuid";
    case "BLOB":
    case "BIT":
      return "binary";
    case "JSON":
      return "json";
  }
  if (type.startsWith("ENUM")) return "string";
  return "unknown";
}

/**
 * The expression that reads a column for the grid. Types that JavaScript cannot hold exactly
 * (decimals, 128-bit integers, dates, nested values) are converted to their text in DuckDB, and long
 * text is cut to `textLimit` characters.
 */
export function selectExpression(column: SqlColumn, textLimit: number) {
  const id = quoteIdentifier(column.name);
  switch (column.type) {
    case "integer":
    case "float":
    case "boolean":
      return id;
    case "bigint":
      return /^(BIGINT|UBIGINT)$/i.test(column.sqlType) ? id : `CAST(${id} AS VARCHAR)`;
    case "decimal":
      return `CAST(${id} AS VARCHAR)`;
    default: {
      const text = column.type === "string" ? id : `CAST(${id} AS VARCHAR)`;
      return `CASE WHEN length(${text}) > ${textLimit} THEN left(${text}, ${textLimit}) || '…' ELSE ${text} END`;
    }
  }
}

/** The text of a column used by search and text filters. */
export function textExpression(column: SqlColumn) {
  const id = quoteIdentifier(column.name);
  return column.type === "string" ? id : `CAST(${id} AS VARCHAR)`;
}

/** Converts a value read with `getColumnsJS()` into a wire value. */
export function wireValue(value: unknown): CellValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    default:
      if (value === null || value === undefined) return null;
      if (value instanceof Date) return value.toISOString();
      return String(value);
  }
}

/** Collects positional parameters ($1, $2, …) while building a statement. */
export class Parameters {
  readonly values: (string | number | boolean | null)[] = [];

  add(value: string | number | boolean | null) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** A decimal bound truncated to the column's scale, with any discarded fraction kept separately. */
function decimalBound(column: SqlColumn, value: string | number | boolean) {
  if (column.type !== "decimal" || typeof value === "boolean") return null;
  const type = /^DECIMAL\((\d+),\s*(\d+)\)$/i.exec(column.sqlType);
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
  if (!type || !match || !(match[2] || match[3])) return null;
  const width = Number(type[1]);
  const scale = Number(type[2]);
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "") || "0";
  const negative = digits !== "0" && match[1] === "-";
  const end = digits === "0" ? 1 : digits.length + Number(match[4] ?? 0) - (match[3]?.length ?? 0) + scale;
  if (end > width) return { text: "0", negative, remainder: false, outside: true };
  const remainder = /[1-9]/.test(digits.slice(Math.max(0, end)));
  const kept = (end <= 0 ? "0" : digits.slice(0, end).padEnd(end, "0")).padStart(scale + 1, "0");
  const text = scale === 0 ? kept : `${kept.slice(0, -scale)}.${kept.slice(-scale)}`;
  return { text: `${negative ? "-" : ""}${text}`, negative, remainder, outside: false };
}

/** A value used by IN; an inexact decimal bound cannot equal any value in the column. */
function typedValue(column: SqlColumn, value: string | number | boolean, params: Parameters) {
  const decimal = decimalBound(column, value);
  if (decimal) {
    if (decimal.outside || decimal.remainder) return "NULL";
    return `CAST(${params.add(decimal.text)} AS ${column.sqlType})`;
  }
  const placeholder = params.add(value);
  if (isNumericType(column.type)) {
    if (typeof value === "number") return `CAST(${placeholder} AS DOUBLE)`;
    return column.type === "float" || column.type === "integer"
      ? `CAST(${placeholder} AS DOUBLE)`
      : `CAST(${placeholder} AS ${column.sqlType})`;
  }
  if (column.type === "boolean") return `CAST(${placeholder} AS BOOLEAN)`;
  if (isTemporalType(column.type)) return `CAST(${placeholder} AS ${column.sqlType})`;
  return `CAST(${placeholder} AS VARCHAR)`;
}

function comparedExpression(column: SqlColumn) {
  return isNumericType(column.type) || column.type === "boolean" || isTemporalType(column.type)
    ? quoteIdentifier(column.name)
    : textExpression(column);
}

const comparisonSql = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" } as const;

function comparisonExpression(
  column: SqlColumn,
  op: CompareOperator,
  value: string | number | boolean,
  params: Parameters,
) {
  const decimal = decimalBound(column, value);
  if (!decimal) return `(${comparedExpression(column)} ${comparisonSql[op]} ${typedValue(column, value, params)})`;
  const id = quoteIdentifier(column.name);
  if (decimal.outside) {
    const matches = op === "ne" || (decimal.negative ? op === "gt" || op === "ge" : op === "lt" || op === "le");
    return matches ? `${id} IS NOT NULL` : "FALSE";
  }
  if (decimal.remainder) {
    if (op === "eq") return "FALSE";
    if (op === "ne") return `${id} IS NOT NULL`;
    // Values lie on the column's scale: compare to the adjacent representable bound without rounding it.
    op = op === "gt" || op === "ge" ? (decimal.negative ? "ge" : "gt") : decimal.negative ? "lt" : "le";
  }
  return `(${id} ${comparisonSql[op]} CAST(${params.add(decimal.text)} AS ${column.sqlType}))`;
}

function blankExpression(column: SqlColumn) {
  const id = quoteIdentifier(column.name);
  return column.type === "string" ? `(${id} IS NULL OR ${id} = '')` : `(${id} IS NULL)`;
}

/** Compiles a filter to a boolean SQL expression. Values become parameters. */
export function filterExpression(filter: Filter, columns: readonly SqlColumn[], params: Parameters): string {
  const column = columns[filter.column];
  if (!column) throw new RangeError(`Column ${filter.column} does not exist.`);
  switch (filter.type) {
    case "blank":
      return filter.blank ? blankExpression(column) : `NOT ${blankExpression(column)}`;
    case "values": {
      const parts: string[] = [];
      const values = filter.values.filter((value) => value !== null);
      if (values.length > 0) {
        if (isNumericType(column.type) || column.type === "boolean") {
          const list = values.map((value) => typedValue(column, value as string | number | boolean, params));
          parts.push(`${quoteIdentifier(column.name)} IN (${list.join(", ")})`);
        } else {
          const list = values.map((value) => params.add(String(value)));
          parts.push(`${textExpression(column)} IN (${list.join(", ")})`);
        }
      }
      if (filter.values.some((value) => value === null)) parts.push(blankExpression(column));
      const matched = parts.length === 0 ? "FALSE" : `(${parts.join(" OR ")})`;
      // A blank cell is not "one of the values" unless asked for, also when excluding.
      return filter.exclude ? `(NOT coalesce(${matched}, FALSE))` : `coalesce(${matched}, FALSE)`;
    }
    case "compare":
      return comparisonExpression(column, filter.op, filter.value, params);
    case "between": {
      const parts: string[] = [];
      if (filter.min !== undefined) parts.push(comparisonExpression(column, "ge", filter.min, params));
      if (filter.max !== undefined) parts.push(comparisonExpression(column, "le", filter.max, params));
      return parts.length === 0 ? "TRUE" : `(${parts.join(" AND ")})`;
    }
    case "text": {
      const text = filter.caseSensitive ? textExpression(column) : `lower(${textExpression(column)})`;
      const needle = params.add(filter.caseSensitive ? filter.value : filter.value.toLowerCase());
      switch (filter.op) {
        case "contains":
          return `coalesce(contains(${text}, ${needle}), FALSE)`;
        case "notContains":
          return `NOT coalesce(contains(${text}, ${needle}), FALSE)`;
        case "startsWith":
          return `coalesce(starts_with(${text}, ${needle}), FALSE)`;
        case "endsWith":
          return `coalesce(ends_with(${text}, ${needle}), FALSE)`;
        case "equals":
          return `coalesce(${text} = ${needle}, FALSE)`;
        case "notEquals":
          return `coalesce(${text} <> ${needle}, TRUE)`;
      }
    }
  }
  throw new RangeError("Unknown filter.");
}

/** Rows where any column contains `text` (case-insensitive). */
export function searchExpression(text: string, columns: readonly SqlColumn[], params: Parameters) {
  if (columns.length === 0) return "FALSE";
  const needle = params.add(text.toLowerCase());
  return `(${columns.map((column) => `coalesce(contains(lower(${textExpression(column)}), ${needle}), FALSE)`).join(" OR ")})`;
}

/** ORDER BY terms. Blanks go last in both directions, as in spreadsheets. */
export function orderTerms(sort: readonly SortKey[], columns: readonly SqlColumn[]) {
  return sort.map((key) => {
    const column = columns[key.column];
    if (!column) throw new RangeError(`Column ${key.column} does not exist.`);
    const id = quoteIdentifier(column.name);
    const value = column.type === "string" ? `NULLIF(${id}, '')` : id;
    return `${value} ${key.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  });
}
