import {
  type CellValue,
  type ColumnSchema,
  type ColumnType,
  type CompareOperator,
  type Filter,
  type FilterNode,
  type GroupAggregate,
  type GroupRequest,
  groupSort,
  isFilterGroup,
  isNumericType,
  isTemporalType,
  MAX_TEXT_LIMIT,
  pruneFilterNode,
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
          const list = values.map((value) => {
            // A DOUBLE in the list would make DuckDB compare 64-bit integers as doubles, inexactly.
            if (column.type === "bigint" && typeof value === "number") {
              return Number.isInteger(value) ? `TRY_CAST(${params.add(String(value))} AS ${column.sqlType})` : "NULL";
            }
            return typedValue(column, value as string | number | boolean, params);
          });
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

/**
 * Compiles a condition tree to a boolean SQL expression, or null when it has no conditions. A filter
 * whose expression is NULL for a row counts as not matching: groups only combine with AND and OR, under
 * which NULL leaves out the row exactly where FALSE would.
 */
export function conditionExpression(
  node: FilterNode | undefined,
  columns: readonly SqlColumn[],
  params: Parameters,
): string | null {
  const pruned = pruneFilterNode(node);
  if (!pruned) return null;
  if (!isFilterGroup(pruned)) return filterExpression(pruned, columns, params);
  const parts = pruned.filters.map((child) => conditionExpression(child, columns, params) as string);
  return `(${parts.join(pruned.type === "and" ? " AND " : " OR ")})`;
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

/** How a result column of a grouping is read: integers exactly, other values as the grid reads them. */
export interface GroupOutput {
  expression: string;
  integer: boolean;
}

function groupOutput(alias: string, column: ColumnSchema): GroupOutput {
  if (column.type === "integer" || column.type === "bigint") {
    // HUGEINT sums do not fit JavaScript numbers; their digits are read and sent as numbers when exact.
    return { expression: `CAST(${alias} AS VARCHAR)`, integer: true };
  }
  const sqlType = column.sourceType ?? (column.type === "float" ? "DOUBLE" : "VARCHAR");
  return { expression: selectExpression({ name: alias, sqlType, type: column.type }, MAX_TEXT_LIMIT), integer: false };
}

/** The number of a row's combination of column-axis values in a cross tabulation. */
const PIVOT_COLUMN = "__vg_pivot";

function aggregateExpression(aggregate: GroupAggregate, column: SqlColumn | undefined, cell: number | null) {
  const conditions: string[] = [];
  // Only the rows of one combination of column-axis values; the number is generated, not a value.
  if (cell !== null) conditions.push(`${PIVOT_COLUMN} = ${cell}`);
  const id = column ? quoteIdentifier(column.name) : null;
  // NaN and infinities are left out, as in the column statistics.
  if (id && column?.type === "float" && aggregate.fn !== "count") conditions.push(`isfinite(${id})`);
  const filter = conditions.length > 0 ? ` FILTER (WHERE ${conditions.join(" AND ")})` : "";
  return `${id ? `${aggregate.fn}(${id})` : "count(*)"}${filter}`;
}

/**
 * The distinct combinations of column-axis values of a cross tabulation, numbered in their order (each
 * column ascending, blanks last), as `p0`, `p1`, … and `n`.
 */
function pivotCombinations(pivot: readonly number[], columns: readonly SqlColumn[], from: string) {
  const axis = pivot.map((index) => columns[index]);
  const aliases = axis.map((_, at) => `p${at}`);
  const schemas = axis.map((column) => ({ name: column.name, type: column.type }));
  const order = [
    ...groupOrder(
      aliases.map((_, column) => ({ column, direction: "asc" as const })),
      aliases,
      schemas,
    ),
    ...aliases.map((alias) => `${alias} ASC NULLS LAST`),
  ];
  const distinct = `SELECT DISTINCT ${axis.map((column, at) => `${quoteIdentifier(column.name)} AS p${at}`).join(", ")} FROM ${from}`;
  return { aliases, order, distinct };
}

/**
 * The combinations of column-axis values of a cross tabulation (see `GroupRequest.pivot`), in their
 * order, with how many there are: at most `limit` are read.
 */
export function pivotStatement(pivot: readonly number[], columns: readonly SqlColumn[], from: string, limit: number) {
  const { aliases, order, distinct } = pivotCombinations(pivot, columns, from);
  const outputs = pivot.map((index, at) => {
    const column = columns[index];
    return groupOutput(aliases[at], { name: column.name, type: column.type, sourceType: column.sqlType });
  });
  const select = outputs.map((output, at) => `${output.expression} AS o${at}`);
  select.push("count(*) OVER () AS __vg_combinations");
  return {
    sql: `SELECT ${select.join(", ")} FROM (${distinct}) AS d ORDER BY ${order.join(", ")} LIMIT ${limit}`,
    outputs,
  };
}

/** ORDER BY terms of result columns, by alias: blanks last as in views. */
function groupOrder(sort: readonly SortKey[], aliases: readonly string[], result: readonly ColumnSchema[]) {
  return sort.map((key) => {
    const alias = aliases[key.column];
    const value = result[key.column]?.type === "string" ? `NULLIF(${alias}, '')` : alias;
    return `${value} ${key.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  });
}

/**
 * A grouping as one statement over the rows of `from` (see `GroupRequest`): the result columns, then
 * the number of groups. `result` is the result schema (`groupColumns`). Every value in it comes from
 * the request's indexes, so it needs no parameters.
 */
export function groupStatement(
  request: GroupRequest,
  columns: readonly SqlColumn[],
  result: readonly ColumnSchema[],
  from: string,
  limit: number,
  /** With a pivot: how many combinations of column-axis values there are (`pivotStatement`). */
  cells = 0,
) {
  const inner: string[] = [];
  const aliases: string[] = [];
  request.keys.forEach((index, at) => {
    aliases.push(`k${at}`);
    inner.push(`${quoteIdentifier(columns[index].name)} AS k${at}`);
  });
  const pivot = request.pivot?.columns;
  for (let cell = 0; cell < (pivot ? cells : 1); cell++) {
    request.aggregates.forEach((aggregate) => {
      const alias = `a${aliases.length - request.keys.length}`;
      aliases.push(alias);
      const column = aggregate.column === undefined ? undefined : columns[aggregate.column];
      inner.push(`${aggregateExpression(aggregate, column, pivot ? cell : null)} AS ${alias}`);
    });
  }
  let rows = from;
  if (pivot) {
    // Each row gets the number of its combination of column-axis values, joined from the few combinations.
    const { aliases: axis, order, distinct } = pivotCombinations(pivot, columns, from);
    const numbered = `SELECT *, row_number() OVER (ORDER BY ${order.join(", ")}) - 1 AS n FROM (${distinct}) AS d`;
    const matches = pivot.map(
      (index, at) => `f.${quoteIdentifier(columns[index].name)} IS NOT DISTINCT FROM c.${axis[at]}`,
    );
    rows = `(SELECT f.*, c.n AS ${PIVOT_COLUMN} FROM ${from} AS f JOIN (${numbered}) AS c ON ${matches.join(" AND ")})`;
  }
  // Totals of a cross tabulation without rows: one row without columns.
  if (inner.length === 0) inner.push("count(*) AS __vg_empty");
  const outputs = result.map((column, at) => groupOutput(aliases[at], column));
  const groupBy = request.keys.length > 0 ? ` GROUP BY ${request.keys.map((_, at) => at + 1).join(", ")}` : "";
  const order =
    request.keys.length > 0
      ? [
          ...groupOrder(groupSort(request), aliases, result),
          // Ties follow the keys, with the empty string as a value of its own.
          ...request.keys.map((_, at) => `k${at} ASC NULLS LAST`),
        ]
      : [];
  const select = outputs.map((output, at) => `${output.expression} AS o${at}`);
  select.push("count(*) OVER () AS __vg_groups");
  const sql = `SELECT ${select.join(", ")} FROM (SELECT ${inner.join(", ")} FROM ${rows}${groupBy}) AS g${order.length > 0 ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT ${limit}`;
  return { sql, outputs };
}
