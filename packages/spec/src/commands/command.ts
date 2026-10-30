/**
 * What a command is (docs/spec.md §6.1): its arguments, the context it is applied with, what it gives and why
 * it fails, with the readers of its arguments.
 */
import type { Aggregate, Capabilities, Expr, SortKey } from "../plan.js";
import {
  type ColumnFormat,
  type GridDocument,
  type GridSession,
  type HistoryUpdate,
  type RowKey,
  StateError,
  type Total,
} from "../state.js";
import type { Column, JsonValue } from "../types.js";
import { isObject } from "../values.js";

/** Rows of the view that the core has read (§6.1). */
export interface LoadedRows {
  /** The view position of the first row. */
  start: number;
  /** The rows' keys (§5.3), absent for views without row IDs. */
  keys?: RowKey[];
  /** The columns of `values`, by name: all the view's columns, in view order, when absent. */
  columns?: string[];
  /** One array of values per row. */
  values: JsonValue[][];
}

/** A row of the view that the core has read: its key, and the values of the columns it has. */
export interface LoadedRow {
  key?: RowKey;
  has(column: string): boolean;
  /** The value of a column; null for a column the row does not have. */
  get(column: string): JsonValue;
}

/** What the core knows when it applies a command (§6.1). */
export interface CommandContext {
  /** The table's columns. */
  table: Column[];
  revision: string | null;
  /** The current view of the document's plan. */
  view: { columns: Column[]; rowCount: number; rowIds: boolean };
  rows?: LoadedRows[];
  /**
   * The rows that the core has read, by view position, instead of `rows`: a core that keeps its rows in its
   * own form gives them without copying them into blocks. Commands ask only for the rows they use.
   */
  lookup?: (row: number) => LoadedRow | undefined;
  /** Rows on a page, for Page Up and Page Down. */
  page: number;
  /** What the engine offers; everything when absent. */
  capabilities?: Capabilities;
  /** What `edit.paste` pastes. */
  clipboard?: { text?: string; html?: string };
  /** The locale of formatted values (`copy`, §6.6), a BCP 47 tag; Intl's default when absent. */
  locale?: string;
}

/** A command (§6): its name and its arguments. */
export interface Command {
  command: string;
  [argument: string]: unknown;
}

type Direction = "up" | "down" | "left" | "right";
type SelectMode = "replace" | "extend" | "add";

/**
 * The commands of §6 with their arguments, as `commands.schema.json` describes them: what hosts, agents and UIs
 * dispatch. `applyCommand` takes any `Command` and checks it.
 */
export type GridCommand =
  | { command: "sort.set"; keys: SortKey[] }
  | { command: "sort.toggle"; column: string; add?: boolean }
  | { command: "sort.clear" | "filter.clear" | "group.clear" }
  | { command: "filter.set"; where: Expr | null }
  | { command: "filter.column"; column: string; where: Expr | null }
  | { command: "search.set"; text: string }
  | { command: "derive.add"; name: string; expr: Expr; before?: string }
  | { command: "derive.update"; name: string; expr?: Expr; rename?: string }
  | { command: "derive.remove"; name: string }
  | { command: "group.set"; aggregate: Aggregate }
  | { command: "having.set"; having: Expr | null }
  | { command: "column.resize"; name: string; width: number | null }
  | { command: "column.move"; names: string[]; before: string | null }
  | { command: "column.hide"; names: string[] }
  | { command: "column.show"; names: string[] }
  | { command: "column.show"; all: true }
  | { command: "column.pin"; name: string; side: "left" | "right" | null }
  | { command: "column.format"; name: string; format: ColumnFormat | null }
  | { command: "column.total"; name: string; total: Total | null }
  | { command: "select"; row: number; column: string; mode?: SelectMode }
  | { command: "select.rows"; from: number; to: number; mode?: SelectMode }
  | { command: "select.columns"; from: string; to: string; mode?: SelectMode }
  | { command: "move"; direction: Direction; extend?: boolean; jump?: boolean; page?: boolean }
  | { command: "move.home" | "move.end"; extend?: boolean; jump?: boolean }
  | { command: "advance"; axis: "row" | "column"; back?: boolean }
  | { command: "scroll.to"; row: number; column?: string }
  | { command: "check" | "uncheck"; keys: RowKey[] }
  | {
      command:
        | "select.all"
        | "check.all"
        | "check.clear"
        | "detail.open"
        | "detail.close"
        | "edit.cancel"
        | "edit.clear"
        | "edit.paste"
        | "history.undo"
        | "history.redo"
        | "save";
    }
  | { command: "edit.begin"; text?: string }
  | { command: "edit.change"; text: string }
  | { command: "edit.commit"; move?: Direction | null }
  | { command: "edit.fill"; direction: "down" | "right" }
  | { command: "copy"; headers?: boolean; values?: "raw" | "formatted" }
  | { command: "export"; format: string; columns?: "displayed" | "all"; rows?: "view" | "table"; target?: string }
  | { command: "view.update"; hash: string; located?: { key: RowKey; row: number | null }[] }
  | { command: "history.push"; updates: HistoryUpdate[] }
  | { command: "history.undone" | "history.redone" | "history.clear" };

/** The name of a command of §6. */
export type CommandName = GridCommand["command"];

/** The outputs of the commands that give one (§6.5, §6.6). */
export interface CommandOutputs {
  copy: { tsv: string; html: string; markdown: string };
  "edit.paste": { cutRows: number; cutColumns: number };
}

/** A request that a command gives (§8.2), without `v`, `id` and `table`. */
export interface CommandRequest {
  op: string;
  [argument: string]: unknown;
}

export interface CommandResult {
  document: GridDocument;
  session: GridSession;
  requests: CommandRequest[];
  output?: unknown;
}

/** Why a command fails (§6.1), in the order in which they are checked. */
export const COMMAND_ERRORS = [
  "unknown_command",
  "syntax",
  "unknown_column",
  "no_editor",
  "nothing",
  "unsupported",
  "unknown_state",
  "last_column",
  "type",
  "copy_layout",
  "paste_ranges",
  "read_only",
  "too_many_cells",
  "not_loaded",
  "invalid_value",
  "invalid_plan",
] as const;

export type CommandErrorReason = (typeof COMMAND_ERRORS)[number];

/** A command that cannot be applied (§6.1): `path` is a JSON Pointer into the command. */
export class CommandError extends Error {
  readonly code = "invalid_command";
  readonly path: string;
  readonly reason: CommandErrorReason;
  readonly details?: Record<string, unknown>;

  constructor(path: string, reason: CommandErrorReason, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CommandError";
    this.path = path;
    this.reason = reason;
    if (details !== undefined) this.details = details;
  }
}

export function fail(
  path: string,
  reason: CommandErrorReason,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new CommandError(path, reason, message, details);
}

export function takes(command: Command, allowed: readonly string[]) {
  for (const key of Object.keys(command)) {
    if (key !== "command" && !allowed.includes(key)) fail(`/${key}`, "syntax", `${command.command} takes no "${key}".`);
  }
}

export function stringArgument(command: Command, name: string): string {
  const value = command[name];
  if (typeof value !== "string") fail(`/${name}`, "syntax", `${name} is a string.`);
  return value;
}

export function optionalString(command: Command, name: string): string | undefined {
  return command[name] === undefined ? undefined : stringArgument(command, name);
}

export function booleanArgument(command: Command, name: string): boolean {
  const value = command[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(`/${name}`, "syntax", `${name} is a boolean.`);
  return value;
}

export function positionArgument(command: Command, name: string): number {
  const value = command[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`/${name}`, "syntax", `${name} is a view position: an integer from 0.`);
  }
  return value;
}

export function choice<T extends string>(command: Command, name: string, values: readonly T[], fallback?: T): T {
  const value = command[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(`/${name}`, "syntax", `${name} is one of ${values.join(", ")}.`);
  }
  return value as T;
}

export function expressionArgument(command: Command, name: string): Expr | null {
  const value = command[name];
  if (value === null) return null;
  if (!isObject(value)) fail(`/${name}`, "syntax", `${name} is an expression (§4.3) or null.`);
  return value as unknown as Expr;
}

export function namesArgument(command: Command, name: string): string[] {
  const value = command[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    fail(`/${name}`, "syntax", `${name} is a list of column names.`);
  }
  return value as string[];
}

/** Runs a check of `state.ts` on an argument, as an error of the command. */
export function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof StateError) fail(error.path, "syntax", error.message);
    throw error;
  }
}
