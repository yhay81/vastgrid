import type { AggregateRange, CellValue, ExportFormat, Filter, SortKey, TableInfo, ViewQuery } from "./types.js";

/**
 * The JSON protocol between `RemoteSource` and a table server (for example `vastgrid-duckdb`).
 * Every request is a `POST` of one of these objects to a single endpoint. Successful responses are
 * `{ "result": … }`; failures use an HTTP error status and `{ "error": { "code", "message" } }`.
 *
 * `ref` names a table in terms the host understands (for example a path relative to a workspace).
 * The server answers `info` with a `table` handle that the other operations use. Handles can expire
 * (server restart, file changed); the client then reopens with `info`.
 */
export type ProtocolRequest =
  | { op: "info"; ref: string; table?: string }
  | { op: "view"; table: string; query: ViewQuery }
  | {
      op: "rows";
      table: string;
      view: string | null;
      start: number;
      end: number;
      columns: number[];
      textLimit?: number;
    }
  | { op: "stats"; table: string; view: string | null; column: number }
  | { op: "distinct"; table: string; view: string | null; column: number; search?: string; limit?: number }
  | { op: "aggregate"; table: string; view: string | null; ranges: AggregateRange[] }
  | {
      op: "find";
      table: string;
      view: string | null;
      text: string;
      columns: number[];
      row: number;
      column: number;
      direction: 1 | -1;
      caseSensitive?: boolean;
    }
  | { op: "export"; table: string; view: string | null; format: ExportFormat; columns?: number[]; target: string }
  | { op: "close"; table: string };

export type ProtocolOperation = ProtocolRequest["op"];

export interface InfoResult extends TableInfo {
  table: string;
}

export interface ProtocolError {
  code: string;
  message: string;
}

/** Error codes with a defined meaning for clients, as listed in `docs/protocol.md`. */
export const ErrorCodes = {
  /** The request does not match the protocol. */
  invalidRequest: "invalid_request",
  /** The request is not a `POST`. */
  methodNotAllowed: "method_not_allowed",
  /** The table handle is unknown (expired or closed). Reopen with `info`. */
  tableNotFound: "table_not_found",
  /** The view handle is unknown. Recreate the view. */
  viewNotFound: "view_not_found",
  /** The table is still loading and cannot answer this yet. */
  notReady: "not_ready",
  /**
   * The client went away, or the server closed the table while the request ran (for example because the
   * file changed).
   */
  cancelled: "cancelled",
  /** The file could not be read; the message explains why. */
  loadFailed: "load_failed",
  /** A filter value does not fit the column (for example text compared with a number). */
  queryFailed: "query_failed",
  /** Not a table file. */
  unsupportedFormat: "unsupported_format",
  /** The file does not exist. */
  notFound: "not_found",
  /** The path is not a file (for example a folder). */
  notFile: "not_file",
  /** The file, or the folder of an export, is outside the folders the server may use (links are followed). */
  notAllowed: "not_allowed",
  /** The host did not enable exports. */
  exportDisabled: "export_disabled",
  /** The server closed its table engine (for example while it shuts down). */
  disposed: "disposed",
  /** Anything else. */
  internalError: "internal_error",
} as const;

const operations = new Set<ProtocolOperation>([
  "info",
  "view",
  "rows",
  "stats",
  "distinct",
  "aggregate",
  "find",
  "export",
  "close",
]);

class InvalidRequest extends Error {}

function fail(message: string): never {
  throw new InvalidRequest(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length > max) fail(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string, max = 4096): string | undefined {
  return value === undefined ? undefined : string(value, name, max);
}

function index(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
}

function view(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value, "view", 128);
}

function indexes(value: unknown, name: string, maxLength = 100_000): number[] {
  if (!Array.isArray(value) || value.length > maxLength) fail(`${name} must be an array`);
  const result = value.map((item, position) => index(item, `${name}[${position}]`));
  // Repeating a column only multiplies the work a request asks for.
  if (new Set(result).size !== result.length) fail(`${name} must not repeat a column`);
  return result;
}

function cellValue(value: unknown, name: string): CellValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${name} must be finite`);
    return value;
  }
  return string(value, name, 65_536);
}

function comparable(value: unknown, name: string): string | number | boolean {
  const result = cellValue(value, name);
  if (result === null) fail(`${name} must not be null`);
  return result;
}

const sortDirections = new Set(["asc", "desc"]);
const compareOperators = new Set(["eq", "ne", "lt", "le", "gt", "ge"]);
const textOperators = new Set(["contains", "notContains", "startsWith", "endsWith", "equals", "notEquals"]);
const exportFormats = new Set(["csv", "tsv", "parquet", "json"]);

function sortKeys(value: unknown): SortKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) fail("sort must be an array");
  return value.map((item, position) => {
    if (!isRecord(item)) fail(`sort[${position}] must be an object`);
    const direction = item.direction;
    if (typeof direction !== "string" || !sortDirections.has(direction)) fail(`sort[${position}].direction is invalid`);
    return { column: index(item.column, `sort[${position}].column`), direction: direction as SortKey["direction"] };
  });
}

function filter(item: unknown, position: number): Filter {
  const name = `filters[${position}]`;
  if (!isRecord(item)) fail(`${name} must be an object`);
  const column = index(item.column, `${name}.column`);
  switch (item.type) {
    case "values": {
      if (!Array.isArray(item.values) || item.values.length > 100_000) fail(`${name}.values must be an array`);
      return {
        type: "values",
        column,
        values: item.values.map((value, at) => cellValue(value, `${name}.values[${at}]`)),
        exclude: item.exclude === true,
      };
    }
    case "compare": {
      if (typeof item.op !== "string" || !compareOperators.has(item.op)) fail(`${name}.op is invalid`);
      return {
        type: "compare",
        column,
        op: item.op as Extract<Filter, { type: "compare" }>["op"],
        value: comparable(item.value, `${name}.value`),
      };
    }
    case "between": {
      const min = item.min === undefined ? undefined : comparable(item.min, `${name}.min`);
      const max = item.max === undefined ? undefined : comparable(item.max, `${name}.max`);
      return { type: "between", column, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
    }
    case "text": {
      if (typeof item.op !== "string" || !textOperators.has(item.op)) fail(`${name}.op is invalid`);
      return {
        type: "text",
        column,
        op: item.op as Extract<Filter, { type: "text" }>["op"],
        value: string(item.value, `${name}.value`, 65_536),
        caseSensitive: item.caseSensitive === true,
      };
    }
    case "blank":
      return { type: "blank", column, blank: item.blank !== false };
    default:
      fail(`${name}.type is invalid`);
  }
}

function query(value: unknown): ViewQuery {
  if (!isRecord(value)) fail("query must be an object");
  const filters = value.filters;
  if (filters !== undefined && (!Array.isArray(filters) || filters.length > 256)) fail("filters must be an array");
  const result: ViewQuery = {};
  const sort = sortKeys(value.sort);
  if (sort?.length) result.sort = sort;
  if (filters?.length) result.filters = filters.map(filter);
  const search = optionalString(value.search, "search", 4096);
  if (search?.trim()) result.search = search;
  return result;
}

function ranges(value: unknown): AggregateRange[] {
  if (!Array.isArray(value) || value.length > 256) fail("ranges must be an array");
  return value.map((item, position) => {
    if (!isRecord(item)) fail(`ranges[${position}] must be an object`);
    const start = index(item.start, `ranges[${position}].start`);
    const end = index(item.end, `ranges[${position}].end`);
    if (end < start) fail(`ranges[${position}] is empty`);
    return { start, end, columns: indexes(item.columns, `ranges[${position}].columns`, 100_000) };
  });
}

/**
 * Validates an untrusted request body. Throws `Error` with a readable message for invalid input.
 * Servers should answer those with status 400 and the code `invalid_request`.
 */
export function parseProtocolRequest(body: unknown): ProtocolRequest {
  if (!isRecord(body)) fail("request must be an object");
  const op = body.op;
  if (typeof op !== "string" || !operations.has(op as ProtocolOperation)) fail("op is invalid");
  if (op === "info") {
    const table = optionalString(body.table, "table", 128);
    return { op, ref: string(body.ref, "ref"), ...(table ? { table } : {}) };
  }
  const table = string(body.table, "table", 128);
  switch (op as Exclude<ProtocolOperation, "info">) {
    case "view":
      return { op: "view", table, query: query(body.query) };
    case "rows": {
      const start = index(body.start, "start");
      const end = index(body.end, "end");
      if (end < start) fail("end must not be less than start");
      const textLimit = body.textLimit === undefined ? undefined : index(body.textLimit, "textLimit", 10_000_000);
      return {
        op: "rows",
        table,
        view: view(body.view),
        start,
        end,
        columns: indexes(body.columns, "columns"),
        ...(textLimit === undefined ? {} : { textLimit }),
      };
    }
    case "stats":
      return { op: "stats", table, view: view(body.view), column: index(body.column, "column") };
    case "distinct": {
      const search = optionalString(body.search, "search", 4096);
      const limit = body.limit === undefined ? undefined : index(body.limit, "limit", 100_000);
      return {
        op: "distinct",
        table,
        view: view(body.view),
        column: index(body.column, "column"),
        ...(search === undefined ? {} : { search }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case "aggregate":
      return { op: "aggregate", table, view: view(body.view), ranges: ranges(body.ranges) };
    case "find": {
      if (body.direction !== 1 && body.direction !== -1) fail("direction must be 1 or -1");
      return {
        op: "find",
        table,
        view: view(body.view),
        text: string(body.text, "text", 4096),
        columns: indexes(body.columns, "columns"),
        row: index(body.row, "row"),
        column: index(body.column, "column"),
        direction: body.direction,
        caseSensitive: body.caseSensitive === true,
      };
    }
    case "export": {
      const format = body.format;
      if (typeof format !== "string" || !exportFormats.has(format)) fail("format is invalid");
      return {
        op: "export",
        table,
        view: view(body.view),
        format: format as ExportFormat,
        ...(body.columns === undefined ? {} : { columns: indexes(body.columns, "columns") }),
        target: string(body.target, "target"),
      };
    }
    case "close":
      return { op: "close", table };
  }
}

export function isInvalidRequest(error: unknown) {
  return error instanceof InvalidRequest;
}

/** Validates an untrusted `ViewQuery`, as `parseProtocolRequest` does for a view request's query. */
export function parseViewQuery(value: unknown): ViewQuery {
  return query(value);
}
