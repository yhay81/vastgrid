/**
 * Messages (docs/spec.md §8): requests, responses, errors and events, their checks, and the encodings of
 * blocks on transports (§8.8).
 */
import { checkRowKey, checkValue, StateError } from "./state.js";
import { LOGICAL_TYPES } from "./types.js";
import { fromBase64, toBase64 } from "./values.js";

/** The version of the messages of this document (§8.1). */
export const PROTOCOL_VERSION = 2;

/** The operations of §8.2. */
export const OPERATIONS = [
  "open",
  "info",
  "rows",
  "summarize",
  "find",
  "locate",
  "write",
  "save",
  "export",
  "changes",
  "reload",
  "cancel",
  "close",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/** The error codes of §8.7 and their HTTP statuses. */
export const ERROR_STATUS = {
  invalid_request: 400,
  invalid_plan: 400,
  table_not_found: 404,
  not_ready: 409,
  revision_changed: 409,
  edit_conflict: 409,
  file_changed: 409,
  read_only: 403,
  not_allowed: 403,
  invalid_value: 422,
  too_many_columns: 422,
  save_unsupported: 422,
  load_failed: 422,
  export_too_large: 413,
  cancelled: 499,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** The limits of §8.1 and §8.2. */
export const MESSAGE_LIMITS = {
  /** Code points of a name or a string. */
  text: 1_000_000,
  /** Levels of objects and lists in a message, and the items of one list or the members of one object. */
  depth: 256,
  items: 1_000_000,
  /** Code points of an error's message: it quotes names and values of the request shortened. */
  errorText: 1000,
  /** Rows of one `rows` request, and its cells. */
  rows: 1_000_000,
  cells: 1_000_000,
  /** `textLimit`: at most, and when it is absent. */
  textLimit: 1_000_000,
  textLimitDefault: 2000,
  /** Ranges of one `summarize` request. */
  ranges: 1000,
  /** Keys of one `locate` request. */
  keys: 10_000,
  /** Updates of one `write` request. */
  updates: 100_000,
} as const;

export const EXPORT_FORMATS = ["csv", "tsv", "parquet", "json", "xlsx"] as const;

/** The media type of an HTTP response with its block attached (§8.8). */
export const ARROW_MEDIA_TYPE = "application/vnd.vastgrid.v2+arrow";

/** A block or `export`'s data in a message (§8.8): as text, as bytes, or attached after the JSON. */
export type BlockValue = { base64: string } | { bytes: Uint8Array } | { attached: number };

export type ProtocolErrorReason = "syntax" | "unknown_op" | "version" | "limit";

/**
 * A message that does not follow §8: `invalid_request` for requests (§8.7), and `invalid_response` for the
 * responses and events that a client checks. `path` is a JSON Pointer into the message.
 */
export class ProtocolError extends Error {
  readonly code: "invalid_request" | "invalid_response";
  readonly path: string;
  readonly reason: ProtocolErrorReason;

  constructor(
    code: "invalid_request" | "invalid_response",
    path: string,
    reason: ProtocolErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.path = path;
    this.reason = reason;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** Whether a text holds more than `limit` code points. A string of no more UTF-16 units has no more code points. */
function longer(text: string, limit: number) {
  return text.length > limit && [...text].length > limit;
}

/** A member name or an index as one step of a JSON Pointer. */
function step(key: string | number) {
  return `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** A path beyond the limit of §8.1 (one through a name that is too long) cut to the member that holds the name. */
function fitPath(path: string) {
  while (longer(path, MESSAGE_LIMITS.text)) path = path.slice(0, path.lastIndexOf("/"));
  return path;
}

/** A text cut to `limit` code points, with "…" for what is left out. */
function fitText(text: string, limit: number) {
  if (!longer(text, limit)) return text;
  return `${[...text.slice(0, 2 * limit)].slice(0, limit - 1).join("")}…`;
}

/** A name or a value as an error's message quotes it: its JSON, cut to 60 code points. */
export function quoted(value: unknown): string {
  return fitText(value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value)), 60);
}

/**
 * The `id` that answers a message (§8.1): the message's own, or null when the message has no valid `id`, so that
 * the answer is not taken for that of a request whose `id` is 0.
 */
export function answerId(message: unknown): number | null {
  const id = isObject(message) ? message.id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * An error response (§8.1, §8.7) that follows §8 whatever it quotes of a request: its message cut to 1,000 code
 * points, and its path to the limit of §8.1.
 */
export function errorResponse(
  id: number | null,
  code: ErrorCode,
  message: string,
  extra: { path?: string; reason?: string; details?: Json } = {},
): Json {
  const error: Json = { code, message: fitText(message, MESSAGE_LIMITS.errorText) };
  if (extra.path !== undefined) error.path = fitPath(extra.path);
  if (extra.reason !== undefined) error.reason = extra.reason;
  if (extra.details !== undefined) error.details = extra.details;
  return { v: 2, id, error };
}

/** Checks one message, failing with the checker's code. */
class Checker {
  constructor(readonly code: "invalid_request" | "invalid_response") {}

  fail(path: string, reason: ProtocolErrorReason, message: string): never {
    throw new ProtocolError(this.code, fitPath(path), reason, fitText(message, MESSAGE_LIMITS.errorText));
  }

  /**
   * Checks the limits of §8.1 through the whole message, plans, keys and values included: names and strings,
   * levels, and items of lists and members of objects. Walks without recursion, whatever the depth.
   */
  bounds(message: unknown) {
    const pending: [unknown, string, number][] = [[message, "", 1]];
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
      const [value, path, level] = item;
      if (typeof value === "string") {
        if (longer(value, MESSAGE_LIMITS.text))
          this.fail(path, "limit", "A string holds at most 1,000,000 code points.");
        continue;
      }
      if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) continue;
      if (level > MESSAGE_LIMITS.depth) this.fail(path, "limit", "A message nests at most 256 objects and lists.");
      const keys = Array.isArray(value) ? null : Object.keys(value);
      if ((keys ?? (value as unknown[])).length > MESSAGE_LIMITS.items) {
        this.fail(path, "limit", "A list or an object holds at most 1,000,000 items.");
      }
      if (keys === null) {
        (value as unknown[]).forEach((child, index) => {
          pending.push([child, `${path}${step(index)}`, level + 1]);
        });
        continue;
      }
      for (const key of keys) {
        // A pointer to a name that is too long would be too long itself: the error names the object.
        if (longer(key, MESSAGE_LIMITS.text)) this.fail(path, "limit", "A name holds at most 1,000,000 code points.");
        pending.push([(value as Json)[key], `${path}${step(key)}`, level + 1]);
      }
    }
  }

  object(value: unknown, path: string, what: string): Json {
    if (!isObject(value)) this.fail(path, "syntax", `${what} is an object.`);
    return value;
  }

  members(value: Json, required: readonly string[], optional: readonly string[], path: string) {
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key))
        this.fail(`${path}${step(key)}`, "syntax", `${quoted(key)} is not a member here.`);
    }
    for (const key of required) {
      if (value[key] === undefined) this.fail(`${path}/${key}`, "syntax", `"${key}" is required.`);
    }
  }

  string(value: unknown, path: string): string {
    if (typeof value !== "string") this.fail(path, "syntax", "Expected a string.");
    if (value.length > MESSAGE_LIMITS.text && [...value].length > MESSAGE_LIMITS.text) {
      this.fail(path, "limit", "A string holds at most 1,000,000 code points.");
    }
    return value;
  }

  optionalString(value: unknown, path: string) {
    if (value !== undefined) this.string(value, path);
  }

  nullableString(value: unknown, path: string) {
    if (value !== null) this.string(value, path);
  }

  boolean(value: unknown, path: string, optional = false) {
    if (optional && value === undefined) return;
    if (typeof value !== "boolean") this.fail(path, "syntax", "Expected a boolean.");
  }

  integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      this.fail(path, "syntax", `Expected an integer from ${min} to ${max}.`);
    }
    return value;
  }

  nullableInteger(value: unknown, path: string) {
    if (value !== null) this.integer(value, path);
  }

  fraction(value: unknown, path: string, nullable = false) {
    if (nullable && value === null) return;
    if (typeof value !== "number" || !(value >= 0 && value <= 1))
      this.fail(path, "syntax", "Expected a number from 0 to 1.");
  }

  names(value: unknown, path: string, nonEmpty = true): string[] {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0))
      this.fail(path, "syntax", "Expected a list of names.");
    return value.map((item, index) => this.string(item, `${path}/${index}`));
  }

  choice(value: unknown, values: readonly string[], path: string) {
    if (typeof value !== "string" || !values.includes(value))
      this.fail(path, "syntax", `Expected one of ${values.join(", ")}.`);
  }

  /** Runs a check of `state.ts`, as an error of this message. */
  state<T>(check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (error instanceof StateError) this.fail(error.path, "syntax", error.message);
      throw error;
    }
  }

  edits(value: unknown, path: string) {
    const edits = this.object(value, path, "edits");
    this.members(edits, ["version", "cells"], [], path);
    this.integer(edits.version, `${path}/version`);
    this.integer(edits.cells, `${path}/cells`);
  }

  column(value: unknown, path: string) {
    const column = this.object(value, path, "A column");
    this.members(
      column,
      ["name", "type"],
      ["precision", "scale", "bits", "unit", "sourceType", "readOnly", "pivot"],
      path,
    );
    this.string(column.name, `${path}/name`);
    this.choice(column.type, LOGICAL_TYPES, `${path}/type`);
    if (column.type === "decimal") {
      const precision = this.integer(column.precision, `${path}/precision`, 1, 38);
      this.integer(column.scale, `${path}/scale`, 0, precision);
    } else {
      for (const member of ["precision", "scale"]) {
        if (column[member] !== undefined)
          this.fail(`${path}/${member}`, "syntax", "Only decimals have a precision and a scale.");
      }
    }
    if (column.bits !== undefined && (column.type !== "float" || (column.bits !== 32 && column.bits !== 64))) {
      this.fail(`${path}/bits`, "syntax", "bits is 32 or 64, for floats.");
    }
    if (column.unit !== undefined) {
      if (column.type !== "timestamp") this.fail(`${path}/unit`, "syntax", "Only timestamps have a unit.");
      this.choice(column.unit, ["s", "ms", "us", "ns"], `${path}/unit`);
    }
    this.optionalString(column.sourceType, `${path}/sourceType`);
    this.boolean(column.readOnly, `${path}/readOnly`, true);
    if (column.pivot !== undefined) {
      const pivot = this.object(column.pivot, `${path}/pivot`, "pivot");
      this.members(pivot, ["values", "measure"], [], `${path}/pivot`);
      if (!Array.isArray(pivot.values)) this.fail(`${path}/pivot/values`, "syntax", "values is a list.");
      pivot.values.forEach((item, index) => {
        this.state(() => checkValue(item, `${path}/pivot/values/${index}`));
      });
      this.string(pivot.measure, `${path}/pivot/measure`);
    }
  }

  columns(value: unknown, path: string) {
    if (!Array.isArray(value)) this.fail(path, "syntax", "columns is a list of columns (§2.1).");
    value.forEach((item, index) => {
      this.column(item, `${path}/${index}`);
    });
  }

  capabilities(value: unknown, path: string) {
    const capabilities = this.object(value, path, "capabilities");
    const flags = ["summarize", "find", "locate", "write", "save", "preview", "partialViews"];
    this.members(capabilities, [], ["plan", "functions", "measures", "export", "changes", ...flags], path);
    if (capabilities.plan !== undefined) {
      const plan = this.object(capabilities.plan, `${path}/plan`, "plan");
      const members = ["derive", "where", "aggregate", "pivot", "having", "sort", "search"];
      this.members(plan, [], members, `${path}/plan`);
      for (const member of members) this.boolean(plan[member], `${path}/plan/${member}`, true);
    }
    for (const member of ["functions", "measures"]) {
      if (capabilities[member] !== undefined) this.names(capabilities[member], `${path}/${member}`, false);
    }
    for (const member of flags) this.boolean(capabilities[member], `${path}/${member}`, true);
    if (capabilities.export !== undefined) {
      const options = this.object(capabilities.export, `${path}/export`, "export");
      this.members(options, ["formats", "delivery"], [], `${path}/export`);
      this.names(options.formats, `${path}/export/formats`, false).forEach((format, index) => {
        this.choice(format, EXPORT_FORMATS, `${path}/export/formats/${index}`);
      });
      this.choice(options.delivery, ["file", "data"], `${path}/export/delivery`);
    }
    if (capabilities.changes !== undefined) this.choice(capabilities.changes, ["push", "poll"], `${path}/changes`);
  }

  tableInfo(value: unknown, path: string) {
    const info = this.object(value, path, "TableInfo");
    this.members(
      info,
      ["table", "revision", "edits", "status", "progress", "rowCount", "readableRows", "columns", "capabilities"],
      ["format", "byteSize", "notes", "sheets", "sheet", "error", "fileChanged"],
      path,
    );
    this.string(info.table, `${path}/table`);
    this.nullableString(info.revision, `${path}/revision`);
    this.edits(info.edits, `${path}/edits`);
    this.choice(info.status, ["loading", "ready", "error"], `${path}/status`);
    this.fraction(info.progress, `${path}/progress`, true);
    this.nullableInteger(info.rowCount, `${path}/rowCount`);
    this.integer(info.readableRows, `${path}/readableRows`);
    this.columns(info.columns, `${path}/columns`);
    this.capabilities(info.capabilities, `${path}/capabilities`);
    this.optionalString(info.format, `${path}/format`);
    if (info.byteSize !== undefined) this.integer(info.byteSize, `${path}/byteSize`);
    if (info.notes !== undefined) this.names(info.notes, `${path}/notes`, false);
    if (info.sheets !== undefined) {
      if (!Array.isArray(info.sheets)) this.fail(`${path}/sheets`, "syntax", "sheets is a list.");
      info.sheets.forEach((item, index) => {
        const at = `${path}/sheets/${index}`;
        const sheet = this.object(item, at, "A sheet");
        this.members(sheet, ["name"], ["hidden"], at);
        this.string(sheet.name, `${at}/name`);
        this.boolean(sheet.hidden, `${at}/hidden`, true);
      });
    }
    this.optionalString(info.sheet, `${path}/sheet`);
    this.optionalString(info.error, `${path}/error`);
    this.boolean(info.fileChanged, `${path}/fileChanged`, true);
  }

  /** A block or data (§8.8) in one of the encodings. */
  block(value: unknown, path: string) {
    if (value instanceof Uint8Array) this.fail(path, "syntax", "A block is { base64 }, { bytes } or { attached }.");
    const block = this.object(value, path, "A block");
    if ("base64" in block) {
      this.members(block, ["base64"], [], path);
      const text = this.string(block.base64, `${path}/base64`);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
        this.fail(`${path}/base64`, "syntax", "base64 is RFC 4648 base64 with padding.");
      }
    } else if ("bytes" in block) {
      this.members(block, ["bytes"], [], path);
      if (!(block.bytes instanceof Uint8Array)) this.fail(`${path}/bytes`, "syntax", "bytes is a Uint8Array.");
    } else if ("attached" in block) {
      this.members(block, ["attached"], [], path);
      this.integer(block.attached, `${path}/attached`);
    } else {
      this.fail(path, "syntax", "A block is { base64 }, { bytes } or { attached }.");
    }
  }

  plan(value: unknown, path: string) {
    // The plan is checked against the table by the engine (invalid_plan, §4.7).
    this.object(value, path, "plan");
  }
}

function envelope(checker: Checker, message: unknown): Json {
  const value = checker.object(message, "", "A message");
  if (value.v !== PROTOCOL_VERSION) checker.fail("/v", "version", "This reader knows messages of version 2.");
  checker.bounds(value);
  return value;
}

/** The members of each request after `v`, `id` and `op`: required and optional. */
const REQUESTS: Record<Operation, [readonly string[], readonly string[]]> = {
  open: [["ref"], ["read"]],
  info: [["table"], []],
  rows: [
    ["table", "revision", "plan", "start", "end", "columns"],
    ["textLimit", "preview"],
  ],
  summarize: [["table", "revision", "plan", "ranges", "columns"], []],
  find: [["table", "revision", "plan", "text", "columns", "from", "direction"], ["caseSensitive"]],
  locate: [["table", "revision", "plan", "keys"], ["rowKey"]],
  write: [["table", "revision", "updates"], ["rowKey"]],
  save: [["table"], []],
  export: [
    ["table", "revision", "plan", "format"],
    ["target", "columns", "headers", "numberFormats"],
  ],
  changes: [["table"], []],
  reload: [["table"], []],
  cancel: [["request"], []],
  close: [["table"], []],
};

/** Checks that a request follows §8.1 and §8.2, and gives it. Throws a `ProtocolError` (`invalid_request`). */
export function checkRequest(message: unknown): Json & { v: 2; id: number; op: Operation } {
  const check: Checker = new Checker("invalid_request");
  const request = envelope(check, message);
  check.integer(request.id, "/id");
  if (typeof request.op !== "string") check.fail("/op", "syntax", "op is a string.");
  if (!(OPERATIONS as readonly string[]).includes(request.op))
    check.fail("/op", "unknown_op", `There is no operation ${quoted(request.op)}.`);
  const op = request.op as Operation;
  const [required, optional] = REQUESTS[op];
  check.members(request, ["v", "id", "op", ...required], optional, "");
  if (required.includes("table")) check.string(request.table, "/table");
  if (required.includes("revision")) check.nullableString(request.revision, "/revision");
  if (required.includes("plan")) check.plan(request.plan, "/plan");
  switch (op) {
    case "open": {
      check.string(request.ref, "/ref");
      if (request.read !== undefined) {
        const read = check.object(request.read, "/read", "read");
        check.members(read, [], ["sheet", "headerRow", "delimiter", "keepEmptyRows", "keepEmptyColumns"], "/read");
        check.optionalString(read.sheet, "/read/sheet");
        if (read.headerRow !== undefined) check.integer(read.headerRow, "/read/headerRow");
        if (read.delimiter !== undefined) {
          check.string(read.delimiter, "/read/delimiter");
          if ((read.delimiter as string).length !== 1 || !/^[\t\x20-\x21\x23-\x7e]$/.test(read.delimiter as string)) {
            check.fail(
              "/read/delimiter",
              "syntax",
              "delimiter is tab or one printable ASCII character other than a quote.",
            );
          }
        }
        check.boolean(read.keepEmptyRows, "/read/keepEmptyRows", true);
        check.boolean(read.keepEmptyColumns, "/read/keepEmptyColumns", true);
      }
      break;
    }
    case "rows": {
      const start = check.integer(request.start, "/start");
      const end = check.integer(request.end, "/end", start);
      // No columns read the view, its positions and row IDs only (§8.2).
      const columns = check.names(request.columns, "/columns", false);
      if (end - start > MESSAGE_LIMITS.rows) check.fail("/end", "limit", "A request reads at most 1,000,000 rows.");
      if ((end - start) * columns.length > MESSAGE_LIMITS.cells) {
        check.fail("/columns", "limit", "A request reads at most 1,000,000 cells.");
      }
      if (request.textLimit !== undefined) check.integer(request.textLimit, "/textLimit", 1, MESSAGE_LIMITS.textLimit);
      check.boolean(request.preview, "/preview", true);
      break;
    }
    case "summarize": {
      if (!Array.isArray(request.ranges)) check.fail("/ranges", "syntax", "ranges is a list of [start, end) pairs.");
      if (request.ranges.length > MESSAGE_LIMITS.ranges)
        check.fail("/ranges", "limit", "A request has at most 1,000 ranges.");
      request.ranges.forEach((range, index) => {
        const at = `/ranges/${index}`;
        if (!Array.isArray(range) || range.length !== 2) check.fail(at, "syntax", "A range is [start, end).");
        const start = check.integer(range[0], `${at}/0`);
        check.integer(range[1], `${at}/1`, start);
      });
      check.names(request.columns, "/columns");
      break;
    }
    case "find": {
      check.string(request.text, "/text");
      const columns = check.names(request.columns, "/columns");
      const from = check.object(request.from, "/from", "from");
      check.members(from, ["row", "column"], [], "/from");
      check.integer(from.row, "/from/row");
      check.integer(from.column, "/from/column", 0, columns.length - 1);
      if (request.direction !== 1 && request.direction !== -1)
        check.fail("/direction", "syntax", "direction is 1 or -1.");
      check.boolean(request.caseSensitive, "/caseSensitive", true);
      break;
    }
    case "locate": {
      if (!Array.isArray(request.keys)) check.fail("/keys", "syntax", "keys is a list of row keys.");
      if (request.keys.length > MESSAGE_LIMITS.keys)
        check.fail("/keys", "limit", "A request locates at most 10,000 keys.");
      request.keys.forEach((key, index) => {
        check.state(() => checkRowKey(key, `/keys/${index}`));
      });
      check.optionalString(request.rowKey, "/rowKey");
      break;
    }
    case "write": {
      if (!Array.isArray(request.updates)) check.fail("/updates", "syntax", "updates is a list.");
      if (request.updates.length > MESSAGE_LIMITS.updates) {
        check.fail("/updates", "limit", "A write holds at most 100,000 updates.");
      }
      request.updates.forEach((item, index) => {
        const at = `/updates/${index}`;
        const update = check.object(item, at, "An update");
        check.members(update, ["key", "column", "value"], ["previous"], at);
        check.state(() => checkRowKey(update.key, `${at}/key`));
        check.string(update.column, `${at}/column`);
        check.state(() => checkValue(update.value, `${at}/value`));
        if (update.previous !== undefined) check.state(() => checkValue(update.previous, `${at}/previous`));
      });
      check.optionalString(request.rowKey, "/rowKey");
      break;
    }
    case "export": {
      check.choice(request.format, EXPORT_FORMATS, "/format");
      check.optionalString(request.target, "/target");
      const columns = request.columns === undefined ? null : check.names(request.columns, "/columns");
      for (const member of ["headers", "numberFormats"]) {
        const list = request[member];
        if (list === undefined) continue;
        if (!Array.isArray(list)) check.fail(`/${member}`, "syntax", `${member} is a list.`);
        if (columns && list.length !== columns.length) {
          check.fail(`/${member}`, "syntax", `${member} has one item per column.`);
        }
        list.forEach((item, index) => {
          if (member === "numberFormats" && item === null) return;
          check.string(item, `/${member}/${index}`);
        });
      }
      break;
    }
    case "cancel":
      check.integer(request.request, "/request");
      break;
  }
  return request as Json & { v: 2; id: number; op: Operation };
}

function checkError(check: Checker, value: unknown) {
  const error = check.object(value, "/error", "error");
  check.members(error, ["code", "message"], ["path", "reason", "details"], "/error");
  check.choice(error.code, Object.keys(ERROR_STATUS), "/error/code");
  check.string(error.message, "/error/message");
  check.optionalString(error.path, "/error/path");
  check.optionalString(error.reason, "/error/reason");
  if (error.details !== undefined) check.object(error.details, "/error/details", "details");
}

function checkResult(check: Checker, op: Operation, value: unknown) {
  const path = "/result";
  switch (op) {
    case "open":
    case "info":
    case "reload":
      check.tableInfo(value, path);
      return;
    case "rows": {
      const result = check.object(value, path, "The result");
      check.members(result, ["view", "start", "end", "rowIds", "block"], ["truncated"], path);
      const view = check.object(result.view, `${path}/view`, "view");
      check.members(
        view,
        ["hash", "status", "rowCount", "rowCountExact", "readableRows", "columns", "edits"],
        ["partial"],
        `${path}/view`,
      );
      if (typeof view.hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(view.hash)) {
        check.fail(`${path}/view/hash`, "syntax", "hash is a plan hash (§4.8).");
      }
      check.choice(view.status, ["building", "ready"], `${path}/view/status`);
      check.integer(view.rowCount, `${path}/view/rowCount`);
      check.boolean(view.rowCountExact, `${path}/view/rowCountExact`);
      check.integer(view.readableRows, `${path}/view/readableRows`);
      check.columns(view.columns, `${path}/view/columns`);
      check.edits(view.edits, `${path}/view/edits`);
      check.boolean(view.partial, `${path}/view/partial`, true);
      const start = check.integer(result.start, `${path}/start`);
      const end = check.integer(result.end, `${path}/end`, start);
      if (result.rowIds !== null) {
        if (!Array.isArray(result.rowIds) || result.rowIds.length !== end - start) {
          check.fail(`${path}/rowIds`, "syntax", "rowIds has one row ID per row, or is null.");
        }
        result.rowIds.forEach((id, index) => {
          check.integer(id, `${path}/rowIds/${index}`);
        });
      }
      check.block(result.block, `${path}/block`);
      if (result.truncated !== undefined) {
        const truncated = check.object(result.truncated, `${path}/truncated`, "truncated");
        for (const [name, offsets] of Object.entries(truncated)) {
          const at = `${path}/truncated/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
          if (!Array.isArray(offsets)) check.fail(at, "syntax", "A column's cut values are a list of offsets.");
          offsets.forEach((offset, index) => {
            check.integer(offset, `${at}/${index}`, 0, end - start - 1);
          });
        }
      }
      return;
    }
    case "summarize": {
      const result = check.object(value, path, "The result");
      check.members(result, ["count", "numericCount", "sum", "min", "max", "average"], [], path);
      check.integer(result.count, `${path}/count`);
      check.integer(result.numericCount, `${path}/numericCount`);
      for (const member of ["sum", "min", "max", "average"]) {
        const number = result[member];
        if (number !== null && typeof number !== "number" && number !== "Infinity" && number !== "-Infinity") {
          check.fail(`${path}/${member}`, "syntax", `${member} is a float (§2.2) or null.`);
        }
      }
      return;
    }
    case "find": {
      if (value === null) return;
      const result = check.object(value, path, "The result");
      check.members(result, ["row", "column"], [], path);
      check.integer(result.row, `${path}/row`);
      check.integer(result.column, `${path}/column`);
      return;
    }
    case "locate": {
      const result = check.object(value, path, "The result");
      check.members(result, ["rows"], [], path);
      if (!Array.isArray(result.rows)) check.fail(`${path}/rows`, "syntax", "rows is a list.");
      result.rows.forEach((row, index) => {
        check.nullableInteger(row, `${path}/rows/${index}`);
      });
      return;
    }
    case "write":
    case "save": {
      const result = check.object(value, path, "The result");
      const count = op === "write" ? "updated" : "records";
      check.members(result, [count, "edits"], [], path);
      check.integer(result[count], `${path}/${count}`);
      check.edits(result.edits, `${path}/edits`);
      return;
    }
    case "export": {
      const result = check.object(value, path, "The result");
      check.members(result, ["target", "rows"], ["data"], path);
      check.nullableString(result.target, `${path}/target`);
      check.integer(result.rows, `${path}/rows`);
      if (result.data !== undefined) check.block(result.data, `${path}/data`);
      return;
    }
    case "changes": {
      const result = check.object(value, path, "The result");
      check.members(result, ["revision", "edits"], ["fileChanged"], path);
      check.nullableString(result.revision, `${path}/revision`);
      check.edits(result.edits, `${path}/edits`);
      check.boolean(result.fileChanged, `${path}/fileChanged`, true);
      return;
    }
    case "cancel":
      check.fail("", "syntax", "cancel has no response.");
      break;
    case "close":
      if (value !== null) check.fail(path, "syntax", "The result of close is null.");
      return;
  }
}

/**
 * Checks that a response to a request of `op`, or an error, follows §8.1 and §8.2. Throws a `ProtocolError`
 * (`invalid_response`).
 */
export function checkResponse(message: unknown, op: Operation): Json & { v: 2; id: number | null } {
  const check: Checker = new Checker("invalid_response");
  const response = envelope(check, message);
  // A null id answers a request without a valid id, which is invalid (§8.1).
  if (response.id !== null || response.error === undefined) check.integer(response.id, "/id");
  if (response.error !== undefined) {
    check.members(response, ["v", "id", "error"], [], "");
    checkError(check, response.error);
    if (response.id === null && (response.error as Json).code !== "invalid_request") {
      check.fail("/id", "syntax", "Only invalid_request answers with a null id.");
    }
  } else {
    check.members(response, ["v", "id", "result"], [], "");
    checkResult(check, op, response.result);
  }
  return response as Json & { v: 2; id: number | null };
}

/** Checks that an event follows §8.5. Throws a `ProtocolError` (`invalid_response`). */
export function checkEvent(message: unknown): Json & { v: 2; event: string } {
  const check: Checker = new Checker("invalid_response");
  const event = envelope(check, message);
  check.choice(event.event, ["changed", "progress", "view"], "/event");
  switch (event.event) {
    case "changed":
      check.members(event, ["v", "event", "table", "revision", "edits"], ["fileChanged"], "");
      check.string(event.table, "/table");
      check.nullableString(event.revision, "/revision");
      check.edits(event.edits, "/edits");
      check.boolean(event.fileChanged, "/fileChanged", true);
      break;
    case "progress":
      check.members(event, ["v", "event", "table", "status", "progress", "readableRows", "rowCount"], [], "");
      check.string(event.table, "/table");
      check.choice(event.status, ["loading", "ready", "error"], "/status");
      check.fraction(event.progress, "/progress", true);
      check.integer(event.readableRows, "/readableRows");
      check.nullableInteger(event.rowCount, "/rowCount");
      break;
    case "view":
      check.members(
        event,
        ["v", "event", "table", "hash", "status", "readableRows", "rowCount", "rowCountExact"],
        [],
        "",
      );
      check.string(event.table, "/table");
      if (typeof event.hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(event.hash)) {
        check.fail("/hash", "syntax", "hash is a plan hash (§4.8).");
      }
      check.choice(event.status, ["building", "ready"], "/status");
      check.integer(event.readableRows, "/readableRows");
      check.integer(event.rowCount, "/rowCount");
      check.boolean(event.rowCountExact, "/rowCountExact");
      break;
  }
  return event as Json & { v: 2; event: string };
}

/** The member of a response that holds its block: `block` of `rows`, `data` of `export`. */
function blockSlot(message: Json): [Json, string] | null {
  const result = message.result;
  if (!isObject(result)) return null;
  if (result.block !== undefined) return [result, "block"];
  if (result.data !== undefined) return [result, "data"];
  return null;
}

function blockBytes(value: unknown): Uint8Array {
  if (isObject(value) && value.bytes instanceof Uint8Array) return value.bytes;
  if (isObject(value) && typeof value.base64 === "string") return fromBase64(value.base64);
  throw new TypeError("The block is neither { bytes } nor { base64 }.");
}

function withBlock(message: Json, block: BlockValue): Json {
  const slot = blockSlot(message);
  if (!slot) return message;
  const [result, member] = slot;
  return { ...message, result: { ...result, [member]: block } };
}

/** The message with its block in the text encoding, `{ base64 }` (§8.8). */
export function toTextEncoding(message: Json): Json {
  const slot = blockSlot(message);
  if (!slot) return message;
  return withBlock(message, { base64: toBase64(blockBytes(slot[0][slot[1]])) });
}

/** The message with its block in the structured encoding, `{ bytes }` (§8.8). */
export function toStructuredEncoding(message: Json): Json {
  const slot = blockSlot(message);
  if (!slot) return message;
  return withBlock(message, { bytes: blockBytes(slot[0][slot[1]]) });
}

/**
 * The bytes of a response with its block attached (§8.8): the length n of the JSON (4 bytes, little-endian),
 * the n bytes of the JSON in UTF-8 with `{ "attached": m }` in place of the block, then the m bytes of the
 * block.
 */
export function frameAttached(message: Json): Uint8Array {
  const slot = blockSlot(message);
  const block = slot ? blockBytes(slot[0][slot[1]]) : new Uint8Array(0);
  const json = new TextEncoder().encode(
    JSON.stringify(slot ? withBlock(message, { attached: block.length }) : message),
  );
  const bytes = new Uint8Array(4 + json.length + block.length);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  bytes.set(block, 4 + json.length);
  return bytes;
}

/** Reads a response with its block attached (§8.8), giving the block in the structured encoding. */
export function readAttached(bytes: Uint8Array): Json {
  if (bytes.length < 4)
    throw new ProtocolError("invalid_response", "", "syntax", "The response is shorter than its length.");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + length > bytes.length) throw new ProtocolError("invalid_response", "", "syntax", "The JSON is cut off.");
  const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + length))) as Json;
  const slot = blockSlot(message);
  if (!slot) return message;
  const attached = slot[0][slot[1]];
  if (!isObject(attached) || typeof attached.attached !== "number") return message;
  const size = attached.attached;
  if (4 + length + size !== bytes.length) {
    throw new ProtocolError("invalid_response", "", "syntax", "The attached block does not end the response.");
  }
  return withBlock(message, { bytes: bytes.slice(4 + length, 4 + length + size) });
}
