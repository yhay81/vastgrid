/**
 * Commands (docs/v2-spec.md §6): a command applied to a state with a context gives a new state, the requests
 * that the core then sends (§8.2, without `v`, `id` and `table`) and, for some commands, an output. The same
 * state, command and context give the same result, and a command that fails changes nothing.
 */
import { checkPlan, planOptions } from "./check.js";
import { parseHtmlTable, parseTsv, toHtmlTable, toMarkdownTable, toTsv } from "./clipboard.js";
import { excelNumberFormat } from "./excel.js";
import { canonicalJson } from "./hash.js";
import { editText, readCellText } from "./input.js";
import {
  type Aggregate,
  type Capabilities,
  type Expr,
  type Plan,
  PlanError,
  type Search,
  type SortKey,
} from "./plan.js";
import {
  type ActiveCell,
  type CellRange,
  type CellRef,
  type Checked,
  type ColumnFormat,
  type ColumnSetting,
  checkColumnFormat,
  checkRowKey,
  checkTotal,
  checkValue,
  columnsOf,
  displayedColumns,
  type GridDocument,
  type GridSession,
  type GridState,
  HISTORY_LIMITS,
  type HistoryStep,
  type HistoryUpdate,
  joinParts,
  measureTakes,
  partsOf,
  type RowKey,
  SELECTION_RANGES,
  StateError,
  sameKey,
  type Total,
} from "./state.js";
import type { Column, JsonValue, LogicalType, ValueType } from "./types.js";
import { floatOf, sameType, textOf, trimSpaces } from "./values.js";

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

/** Cells that one command writes at most (§7.2). */
export const WRITE_LIMIT = 100_000;

/** Cells that one copy holds at most (§6.6). */
export const COPY_LIMIT = 1_000_000;

function fail(path: string, reason: CommandErrorReason, message: string, details?: Record<string, unknown>): never {
  throw new CommandError(path, reason, message, details);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function takes(command: Command, allowed: readonly string[]) {
  for (const key of Object.keys(command)) {
    if (key !== "command" && !allowed.includes(key)) fail(`/${key}`, "syntax", `${command.command} takes no "${key}".`);
  }
}

function stringArgument(command: Command, name: string): string {
  const value = command[name];
  if (typeof value !== "string") fail(`/${name}`, "syntax", `${name} is a string.`);
  return value;
}

function optionalString(command: Command, name: string): string | undefined {
  return command[name] === undefined ? undefined : stringArgument(command, name);
}

function booleanArgument(command: Command, name: string): boolean {
  const value = command[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(`/${name}`, "syntax", `${name} is a boolean.`);
  return value;
}

function positionArgument(command: Command, name: string): number {
  const value = command[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`/${name}`, "syntax", `${name} is a view position: an integer from 0.`);
  }
  return value;
}

function choice<T extends string>(command: Command, name: string, values: readonly T[], fallback?: T): T {
  const value = command[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(`/${name}`, "syntax", `${name} is one of ${values.join(", ")}.`);
  }
  return value as T;
}

function expressionArgument(command: Command, name: string): Expr | null {
  const value = command[name];
  if (value === null) return null;
  if (!isObject(value)) fail(`/${name}`, "syntax", `${name} is an expression (§4.3) or null.`);
  return value as unknown as Expr;
}

function namesArgument(command: Command, name: string): string[] {
  const value = command[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    fail(`/${name}`, "syntax", `${name} is a list of column names.`);
  }
  return value as string[];
}

/** Runs a check of `state.ts` on an argument, as an error of the command. */
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof StateError) fail(error.path, "syntax", error.message);
    throw error;
  }
}

function isSearch(expr: Expr): expr is Search {
  return "search" in expr;
}

function renameExpr(expr: Expr, from: string, to: string): Expr {
  if ("col" in expr) return expr.col === from ? { col: to } : expr;
  if ("fn" in expr) return { fn: expr.fn, args: expr.args.map((arg) => renameExpr(arg, from, to)) };
  return expr;
}

/** Whether a value is blank (§3.2). */
function isBlank(value: JsonValue, type: ValueType) {
  return value === null || (type.type === "string" && value === "");
}

/** Whether two values of a type are the same value (§3.1), whichever JSON writes them (§2.2). */
export function sameCellValue(a: JsonValue, b: JsonValue, type: ValueType): boolean {
  if (a === null || b === null) return a === b;
  switch (type.type) {
    case "integer":
    case "bigint":
      return BigInt(a as number | string) === BigInt(b as number | string);
    case "float": {
      const x = floatOf(a);
      const y = floatOf(b);
      return Number.isNaN(x) ? Number.isNaN(y) : x === y;
    }
    default:
      return a === b;
  }
}

/** The plan without empty `derive`, `where`, `having` and `sort` members. */
function tidyPlan(plan: Plan): Plan {
  const tidy: Plan = {};
  if (plan.derive && plan.derive.length > 0) tidy.derive = plan.derive;
  if (plan.where !== undefined) tidy.where = plan.where;
  if (plan.aggregate !== undefined) tidy.aggregate = plan.aggregate;
  if (plan.having !== undefined) tidy.having = plan.having;
  if (plan.sort && plan.sort.length > 0) tidy.sort = plan.sort;
  return tidy;
}

/**
 * The column settings as commands that change columns leave them (§6.1): a setting for every column of the
 * view, the columns pinned left first, then the others (columns without pin, hidden columns and the settings
 * of names that the view does not have) and then the columns pinned right, each in their order, with the
 * columns that had no setting after the other columns without pin, in view order.
 */
export function orderColumns(settings: readonly ColumnSetting[], view: readonly Column[]): ColumnSetting[] {
  const listed = new Set(settings.map((setting) => setting.name));
  const all = [
    ...settings,
    ...view.filter((column) => !listed.has(column.name)).map((column) => ({ name: column.name })),
  ];
  const names = new Set(view.map((column) => column.name));
  const side = (setting: ColumnSetting) =>
    !names.has(setting.name) || setting.hidden ? 1 : setting.pin === "left" ? 0 : setting.pin === "right" ? 2 : 1;
  return [0, 1, 2].flatMap((group) => all.filter((setting) => side(setting) === group));
}

/** A cell in display positions: a view position and a position among the displayed columns. */
interface Point {
  row: number;
  col: number;
}

/** A range in display positions: `[start, end)` or all rows, and sorted displayed columns or all of them. */
interface Rect {
  rows: [number, number] | "all";
  cols: number[] | "all";
}

type Kind = "cells" | "rows" | "columns" | "all";

/** The selection of a session in display positions, with the defaults of its absent members (§5.2). */
interface Grid {
  columns: string[];
  index: Map<string, number>;
  active: Point;
  anchor: Point;
  focus: Point;
  ranges: Rect[];
}

/** A cell that a command reads or writes. */
interface Target {
  row: number;
  column: string;
}

function cellRect(point: Point): Rect {
  return { rows: [point.row, point.row + 1], cols: [point.col] };
}

function span(a: number, b: number): number[] {
  const [low, high] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

/** What the last range selects as a whole, which extending it keeps. */
function kindOf(rect: Rect): Kind {
  if (rect.rows === "all") return rect.cols === "all" ? "all" : "columns";
  return rect.cols === "all" ? "rows" : "cells";
}

function rectFor(anchor: Point, focus: Point, kind: Kind): Rect {
  const rows: [number, number] = [Math.min(anchor.row, focus.row), Math.max(anchor.row, focus.row) + 1];
  const cols = span(anchor.col, focus.col);
  switch (kind) {
    case "all":
      return { rows: "all", cols: "all" };
    case "rows":
      return { rows, cols: "all" };
    case "columns":
      return { rows: "all", cols };
    case "cells":
      return { rows, cols };
  }
}

function sameList(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Spans `[start, end)` of sorted, distinct positions. */
function spansOf(rows: Iterable<number>): [number, number][] {
  const spans: [number, number][] = [];
  for (const row of [...rows].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && row === last[1]) last[1] = row + 1;
    else spans.push([row, row + 1]);
  }
  return spans;
}

/** A row of `context.rows`: what the blocks that hold it give, later blocks winning (§6.1). */
class BlockRow implements LoadedRow {
  key?: RowKey;
  readonly values = new Map<string, JsonValue>();

  has(column: string) {
    return this.values.has(column);
  }

  get(column: string) {
    return this.values.get(column) ?? null;
  }
}

/** The rows of blocks by view position, each read from the blocks the first time a command asks for it. */
function blockLookup(blocks: readonly LoadedRows[], view: readonly Column[]): (row: number) => LoadedRow | undefined {
  const viewNames = view.map((column) => column.name);
  const rows = new Map<number, BlockRow | undefined>();
  return (row) => {
    if (rows.has(row)) return rows.get(row);
    let entry: BlockRow | undefined;
    for (const block of blocks) {
      const offset = row - block.start;
      const values = block.values[offset];
      if (offset < 0 || values === undefined) continue;
      entry ??= new BlockRow();
      const key = block.keys?.[offset];
      if (key !== undefined && key !== null) entry.key = key;
      const names = block.columns ?? viewNames;
      for (let index = 0; index < names.length && index < values.length; index++) {
        entry.values.set(names[index], values[index]);
      }
    }
    rows.set(row, entry);
    return entry;
  };
}

/** Displayed columns by the document's settings and the view's columns, which commands keep when they can. */
const displayedCache = new WeakMap<object, WeakMap<object, { columns: string[]; index: Map<string, number> }>>();
const NO_SETTINGS: ColumnSetting[] = [];

/** Whether two JSON values are the same: the same members with the same values, arrays in the same order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameJson(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * The members of `next` that are the same as those of `previous` take their objects from `previous`, and
 * `next` as a whole is `previous` when every member is. Members of `byIdentity` are compared as objects only,
 * since they may be large and commands replace them rather than change them.
 */
function share<T extends object>(previous: T, next: T, byIdentity: readonly string[]): T {
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  let same = Object.keys(before).length === Object.keys(after).length;
  for (const key of Object.keys(after)) {
    const value = after[key];
    if (!Object.hasOwn(before, key)) {
      same = false;
      continue;
    }
    const old = before[key];
    if (value !== old && !byIdentity.includes(key) && sameJson(value, old)) after[key] = old;
    if (after[key] !== old) same = false;
  }
  return same ? previous : next;
}

/**
 * One command being applied. The document and the session start as shallow copies of the state's; a command
 * replaces their members, or copies a member with `own` before it changes it, so that what it does not change
 * stays the state's own and costs nothing to keep (an undo history of a million updates is not copied for a
 * move of the active cell).
 */
class Run {
  readonly context: CommandContext;
  readonly state: GridState;
  document: GridDocument;
  session: GridSession;
  readonly requests: CommandRequest[] = [];
  output: unknown;
  private readonly lookup: (row: number) => LoadedRow | undefined;

  constructor(state: GridState, context: CommandContext) {
    this.context = context;
    this.state = state;
    this.document = { ...state.document };
    this.session = { ...state.session };
    this.lookup = context.lookup ?? blockLookup(context.rows ?? [], context.view.columns);
  }

  /** A member of the session to change: a copy of the state's, made once per command. */
  own<K extends "active" | "anchor" | "focus" | "scroll" | "checked" | "editor" | "selection" | "history">(
    member: K,
  ): NonNullable<GridSession[K]> {
    const value = this.session[member];
    if (value === undefined) throw new Error(`The session has no ${member}.`);
    if (value !== this.state.session[member]) return value as NonNullable<GridSession[K]>;
    let copy: unknown;
    if (member === "history") {
      // Steps are never changed, only added and removed.
      const history = value as NonNullable<GridSession["history"]>;
      copy = { undo: [...history.undo], redo: [...history.redo] };
    } else if (member === "checked") {
      const checked = value as Checked;
      copy = { ...checked, keys: [...checked.keys] };
    } else {
      copy = structuredClone(value);
    }
    this.session[member] = copy as GridSession[K];
    return copy as NonNullable<GridSession[K]>;
  }

  get plan(): Plan {
    return this.document.plan ?? {};
  }

  get rowCount() {
    return this.context.view.rowCount;
  }

  /** The last view position that a cell may have; 0 in a view without rows. */
  get lastRow() {
    return Math.max(0, this.rowCount - 1);
  }

  /** The names of the displayed columns and their display positions, kept while the settings and the view stay. */
  displayedIndex(): { columns: string[]; index: Map<string, number> } {
    const settings = this.document.columns ?? NO_SETTINGS;
    const view = this.context.view.columns;
    let byView = displayedCache.get(settings);
    if (!byView) {
      byView = new WeakMap();
      displayedCache.set(settings, byView);
    }
    let entry = byView.get(view);
    if (!entry) {
      const columns = displayedColumns(this.document, view).map((item) => item.column.name);
      entry = { columns, index: new Map(columns.map((name, position) => [name, position])) };
      byView.set(view, entry);
    }
    return entry;
  }

  displayed(): string[] {
    return this.displayedIndex().columns;
  }

  viewColumn(name: string): Column | undefined {
    return this.context.view.columns.find((column) => column.name === name);
  }

  offers(capability: "write" | "save"): boolean {
    return this.context.capabilities === undefined || this.context.capabilities[capability] === true;
  }

  /** A column whose cells can be written by key (§7.1). */
  writableColumn(name: string): boolean {
    const column = this.context.table.find((item) => item.name === name);
    return (
      this.offers("write") &&
      column !== undefined &&
      column.readOnly !== true &&
      column.type !== "interval" &&
      column.type !== "binary"
    );
  }

  /** A column of the view whose cells can be written (§7.1). */
  writableCell(name: string): boolean {
    return this.plan.aggregate === undefined && this.writableColumn(name);
  }

  // ----- the plan -----

  /** Checks a plan against the table, failing the command with `invalid_plan`. */
  checkPlan(plan: Plan) {
    try {
      checkPlan(plan, this.context.table, planOptions(this.context.capabilities));
    } catch (error) {
      if (error instanceof PlanError) {
        fail("", "invalid_plan", error.message, { path: error.path, reason: error.reason });
      }
      throw error;
    }
  }

  validates(plan: Plan): boolean {
    try {
      checkPlan(plan, this.context.table, planOptions(this.context.capabilities));
      return true;
    } catch (error) {
      if (error instanceof PlanError) return false;
      throw error;
    }
  }

  setPlan(plan: Plan) {
    const tidy = tidyPlan(plan);
    this.checkPlan(tidy);
    this.document.plan = tidy;
  }

  /** A copy of the plan to change. */
  draft(): Plan {
    return structuredClone(this.plan);
  }

  /** Removes the parts of `having` and the sort keys that do not validate (§6.2). */
  keepValid(plan: Plan): Plan {
    const { having, sort, ...base } = plan;
    const rest: Plan = base;
    if (having !== undefined) {
      const kept: Expr[] = [];
      for (const part of partsOf(having)) {
        if (this.validates({ ...rest, having: joinParts([...kept, part]) })) kept.push(part);
      }
      const joined = joinParts(kept);
      if (joined) rest.having = joined;
    }
    const keys: SortKey[] = [];
    for (const key of sort ?? []) {
      if (this.validates({ ...rest, sort: [...keys, key] })) keys.push(key);
    }
    if (keys.length > 0) rest.sort = keys;
    return rest;
  }

  derivedIndex(member: string, name: string): number {
    const index = (this.plan.derive ?? []).findIndex((item) => item.name === name);
    if (index < 0) fail(`/${member}`, "unknown_column", `There is no derived column "${name}".`);
    return index;
  }

  // ----- columns -----

  /** The settings in the order of `orderColumns`, to change. */
  settings(): ColumnSetting[] {
    return orderColumns(structuredClone(this.document.columns ?? []), this.context.view.columns);
  }

  setColumns(settings: ColumnSetting[]) {
    this.document.columns = orderColumns(settings, this.context.view.columns);
    this.fit();
  }

  viewName(command: Command, member: string, path = `/${member}`, name = stringArgument(command, member)): string {
    if (!this.viewColumn(name)) fail(path, "unknown_column", `The view has no column "${name}".`);
    return name;
  }

  displayedName(command: Command, member: string, path = `/${member}`, name = stringArgument(command, member)) {
    if (!this.displayed().includes(name)) fail(path, "unknown_column", `"${name}" is not a displayed column.`);
    return name;
  }

  // ----- the selection -----

  grid(): Grid {
    const { columns, index } = this.displayedIndex();
    const clampRow = (row: number) => Math.min(row, this.lastRow);
    const stored = this.session.active;
    const active = stored ? { row: clampRow(stored.row), col: index.get(stored.column) ?? 0 } : { row: 0, col: 0 };
    const point = (cell: CellRef | undefined): Point => {
      const col = cell ? index.get(cell.column) : undefined;
      return cell && col !== undefined ? { row: clampRow(cell.row), col } : active;
    };
    const ranges = (this.session.selection ?? []).flatMap((range) => {
      const rect = this.rect(range, index);
      return rect ? [rect] : [];
    });
    return {
      columns,
      index,
      active,
      anchor: point(this.session.anchor),
      focus: point(this.session.focus),
      ranges: ranges.length > 0 ? ranges : [cellRect(active)],
    };
  }

  /** A range of the session in display positions, clamped to the rows; null when it has no displayed column. */
  rect(range: CellRange, index: Map<string, number>): Rect | null {
    let cols: Rect["cols"] = "all";
    if (range.columns !== "all") {
      cols = [...new Set(range.columns.flatMap((name) => index.get(name) ?? []))].sort((a, b) => a - b);
      if (cols.length === 0) return null;
    }
    if (range.rows === "all") return { rows: "all", cols };
    const start = Math.min(range.rows[0], this.lastRow);
    return { rows: [start, Math.max(start + 1, Math.min(range.rows[1], this.lastRow + 1))], cols };
  }

  /** The rows of a range that are rows of the view. */
  cellRows(rect: Rect): [number, number] {
    if (rect.rows === "all") return [0, this.rowCount];
    return [rect.rows[0], Math.min(rect.rows[1], this.rowCount)];
  }

  colsOf(rect: Rect, grid: Grid): number[] {
    return rect.cols === "all" ? span(0, grid.columns.length - 1) : rect.cols;
  }

  /** The active cell at a point, with its row's key when the core read it (or kept when the row is the same). */
  activeAt(grid: Grid, point: Point): ActiveCell {
    const cell: ActiveCell = { row: point.row, column: grid.columns[point.col] };
    const previous = this.session.active;
    const key = this.loadedKey(point.row) ?? (previous?.row === point.row ? previous.key : undefined);
    if (key !== undefined) cell.key = key;
    return cell;
  }

  /** Writes the active cell, the corners and the ranges (the last 1,000) into the session. */
  select(grid: Grid, active: Point, anchor: Point, focus: Point, ranges: Rect[]) {
    const cell = (point: Point): CellRef => ({ row: point.row, column: grid.columns[point.col] });
    this.session.active = this.activeAt(grid, active);
    this.session.anchor = cell(anchor);
    this.session.focus = cell(focus);
    this.session.selection = ranges.slice(-SELECTION_RANGES).map((rect) => ({
      rows: rect.rows,
      columns: rect.cols === "all" ? "all" : rect.cols.map((col) => grid.columns[col]),
    }));
  }

  moveTo(grid: Grid, target: Point, extend: boolean) {
    const point = {
      row: Math.max(0, Math.min(target.row, this.lastRow)),
      col: Math.max(0, Math.min(target.col, grid.columns.length - 1)),
    };
    if (extend) {
      const ranges = [...grid.ranges];
      ranges[ranges.length - 1] = rectFor(grid.anchor, point, kindOf(ranges[ranges.length - 1]));
      this.select(grid, grid.active, grid.anchor, point, ranges);
    } else {
      this.select(grid, point, point, point, [cellRect(point)]);
    }
  }

  /** Enter and Tab (§6.4): the active cell walks through a selection of one range of several cells. */
  advance(axis: "row" | "column", back: boolean) {
    const grid = this.grid();
    if (grid.columns.length === 0) return;
    const range = grid.ranges.length === 1 ? grid.ranges[0] : undefined;
    const [start, end] = range ? (range.rows === "all" ? [0, this.lastRow + 1] : range.rows) : [0, 0];
    const cols = range ? this.colsOf(range, grid) : [];
    const { row, col } = grid.active;
    const inside = row >= start && row < end && cols.includes(col);
    if (!range || (end - start) * cols.length < 2 || !inside) {
      const delta = back ? -1 : 1;
      this.moveTo(grid, axis === "row" ? { row: row + delta, col } : { row, col: col + delta }, false);
      return;
    }
    let next = row;
    let at = cols.indexOf(col);
    if (axis === "column") {
      at += back ? -1 : 1;
      if (at >= cols.length) {
        at = 0;
        next = next + 1 >= end ? start : next + 1;
      } else if (at < 0) {
        at = cols.length - 1;
        next = next - 1 < start ? end - 1 : next - 1;
      }
    } else {
      next += back ? -1 : 1;
      if (next >= end) {
        next = start;
        at = at + 1 >= cols.length ? 0 : at + 1;
      } else if (next < start) {
        next = end - 1;
        at = at - 1 < 0 ? cols.length - 1 : at - 1;
      }
    }
    this.select(grid, { row: next, col: cols[at] }, grid.anchor, grid.focus, grid.ranges);
  }

  /** Fits the session to the view and its displayed columns (§5.4, step 3). */
  fit() {
    const session = this.session;
    const { columns, index } = this.displayedIndex();
    const clampRow = (row: number) => Math.min(row, this.lastRow);
    if (session.active) {
      const active = this.own("active");
      active.row = clampRow(active.row);
      if (!index.has(active.column) && columns.length > 0) active.column = columns[0];
    }
    for (const member of ["anchor", "focus"] as const) {
      const cell = session[member];
      if (!cell) continue;
      if (index.has(cell.column)) this.own(member).row = clampRow(cell.row);
      else delete session[member];
    }
    if (session.selection) {
      const ranges = session.selection.flatMap((range): CellRange[] => {
        const rect = this.rect(range, index);
        if (!rect) return [];
        return [{ rows: rect.rows, columns: rect.cols === "all" ? "all" : rect.cols.map((col) => columns[col]) }];
      });
      if (ranges.length > 0) session.selection = ranges;
      else delete session.selection;
    }
    if (session.scroll) {
      const scroll = this.own("scroll");
      scroll.row = clampRow(scroll.row);
      if (scroll.column !== undefined && !index.has(scroll.column)) delete scroll.column;
    }
    if (session.editor && (!index.has(session.editor.column) || session.editor.row >= this.rowCount)) {
      delete session.editor;
    }
  }

  // ----- rows and cells -----

  /**
   * Fails with `not_loaded` when the keys (with `keyed`) or the values of cells are not in `context.rows`;
   * `details` gives the spans of rows and the columns to read.
   */
  need(groups: { cells: Iterable<Target>; keyed: boolean }[]) {
    const rows = new Set<number>();
    const columns = new Set<string>();
    for (const { cells, keyed } of groups) {
      for (const cell of cells) {
        const entry = this.lookup(cell.row);
        if (!entry?.has(cell.column)) {
          rows.add(cell.row);
          columns.add(cell.column);
        } else if (keyed && entry.key === undefined) {
          rows.add(cell.row);
        }
      }
    }
    if (rows.size === 0) return;
    const order = this.context.view.columns.map((column) => column.name).filter((name) => columns.has(name));
    fail("", "not_loaded", "The command needs rows that are not loaded.", { rows: spansOf(rows), columns: order });
  }

  valueAt(cell: Target): JsonValue {
    return this.lookup(cell.row)?.get(cell.column) ?? null;
  }

  loadedKey(row: number): RowKey | undefined {
    return this.lookup(row)?.key;
  }

  keyAt(row: number): RowKey {
    const key = this.lookup(row)?.key;
    if (key === undefined) throw new Error(`The key of row ${row} is not loaded.`);
    return key;
  }

  typeOf(name: string): ValueType {
    const column = this.viewColumn(name) ?? this.context.table.find((item) => item.name === name);
    if (!column) throw new Error(`There is no column "${name}".`);
    return column;
  }

  /** Gives a `write` request of the updates whose value is not the cell's value (§6.5). */
  write(updates: { key: RowKey; column: string; value: JsonValue; previous: JsonValue }[]) {
    const changed = updates.filter(
      (update) => !sameCellValue(update.value, update.previous, this.typeOf(update.column)),
    );
    if (changed.length === 0) return;
    const request: CommandRequest = { op: "write", revision: this.context.revision, updates: changed };
    if (this.document.rowKey !== undefined) request.rowKey = this.document.rowKey;
    this.requests.push(request);
  }

  /** Fails with `read_only` when a cell of the columns is not writable (§7.1). */
  writable(columns: Iterable<string>) {
    for (const column of columns) {
      if (!this.writableCell(column)) fail("", "read_only", `The cells of "${column}" are not written.`, { column });
    }
  }

  /** The cells of ranges, range by range and row by row, once each. */
  cellsOf(grid: Grid, rects: readonly Rect[]): Target[] {
    const cells: Target[] = [];
    const seen = rects.length > 1 ? new Set<string>() : null;
    for (const rect of rects) {
      const [start, end] = this.cellRows(rect);
      const cols = this.colsOf(rect, grid);
      for (let row = start; row < end; row++) {
        for (const col of cols) {
          if (seen) {
            const id = `${row}:${col}`;
            if (seen.has(id)) continue;
            seen.add(id);
          }
          cells.push({ row, column: grid.columns[col] });
        }
      }
    }
    return cells;
  }

  /** Session members that are empty or closed are left out (§6.1). */
  tidy() {
    const session = this.session;
    if (session.checked && session.checked.mode === "include" && session.checked.keys.length === 0) {
      delete session.checked;
    }
    if (session.detail && !session.detail.open) delete session.detail;
    if (session.history && session.history.undo.length === 0 && session.history.redo.length === 0) {
      delete session.history;
    }
  }
}

// ----- commands -----

type Handler = (run: Run, command: Command) => void;

const DIRECTIONS = ["up", "down", "left", "right"] as const;
const MODES = ["replace", "extend", "add"] as const;

/** Whether every row of the view can be told checked or not (§5.2.1). */
function covers(checked: Checked, plan: Plan): boolean {
  if (checked.mode === "include" || checked.where === undefined) return true;
  const view = partsOf(plan.where).map((part) => ({ part, json: canonicalJson(part) }));
  return partsOf(checked.where).every((part) => {
    const json = canonicalJson(part);
    return view.some(
      (item) => item.json === json || (isSearch(part) && isSearch(item.part) && item.part.search.includes(part.search)),
    );
  });
}

function setChecked(run: Run, command: Command, check: boolean) {
  takes(command, ["keys"]);
  if (!Array.isArray(command.keys)) fail("/keys", "syntax", "keys is a list of row keys.");
  const keys = checked(() => (command.keys as unknown[]).map((key, index) => checkRowKey(key, `/keys/${index}`)));
  const current = run.session.checked ?? { mode: "include", keys: [] };
  if (!covers(current, run.plan)) fail("", "unknown_state", "The rows of this view may not match the checked rows.");
  // In the exclude mode, the listed keys are the rows that are not checked.
  const listed = current.mode === "include" ? check : !check;
  const next = current.keys.filter((key) => listed || !keys.some((item) => sameKey(item, key)));
  if (listed) {
    for (const key of keys) if (!next.some((item) => sameKey(item, key))) next.push(key);
  }
  run.session.checked = { ...current, keys: next };
}

function moveCommand(run: Run, command: Command, to: "home" | "end" | null) {
  takes(command, to ? ["extend", "jump"] : ["direction", "extend", "jump", "page"]);
  const direction = to ? null : choice(command, "direction", DIRECTIONS);
  const extend = booleanArgument(command, "extend");
  const jump = booleanArgument(command, "jump");
  const page = to ? false : booleanArgument(command, "page");
  if (page && (direction === "left" || direction === "right")) {
    fail("/page", "syntax", "page moves up and down.");
  }
  const grid = run.grid();
  if (grid.columns.length === 0) return;
  const base = extend ? grid.focus : grid.active;
  const last = grid.columns.length - 1;
  let { row, col } = base;
  const step = page ? run.context.page : 1;
  switch (to ?? direction) {
    case "down":
      row = jump ? run.lastRow : row + step;
      break;
    case "up":
      row = jump ? 0 : row - step;
      break;
    case "right":
      col = jump ? last : col + 1;
      break;
    case "left":
      col = jump ? 0 : col - 1;
      break;
    case "home":
      row = jump ? 0 : row;
      col = 0;
      break;
    case "end":
      row = jump ? run.lastRow : row;
      col = last;
      break;
  }
  run.moveTo(grid, { row, col }, extend);
}

function wherePartsArgument(command: Command, column?: string): Expr[] {
  const where = expressionArgument(command, "where");
  const parts = partsOf(where ?? undefined);
  for (const part of parts) {
    if (isSearch(part)) fail("/where", "syntax", "Conditions hold no search: search.set sets it.");
    if (column !== undefined) {
      const names = columnsOf(part);
      if (names.size !== 1 || !names.has(column)) {
        fail("/where", "syntax", `The conditions of "${column}" use that column and no other.`);
      }
    }
  }
  return parts;
}

/** Inserts columns at a place of the ordered settings: before a displayed column, or at the end. */
function insertBefore(list: ColumnSetting[], moving: ColumnSetting[], before: ColumnSetting | undefined) {
  const at = before ? list.indexOf(before) : list.length;
  list.splice(at, 0, ...moving);
}

const HANDLERS: Record<CommandName, Handler> = {
  // ----- the plan (§6.2) -----

  "sort.set"(run, command) {
    takes(command, ["keys"]);
    if (!Array.isArray(command.keys)) fail("/keys", "syntax", "keys is a list of sort keys.");
    run.setPlan({ ...run.draft(), sort: command.keys as SortKey[] });
  },

  "sort.toggle"(run, command) {
    takes(command, ["column", "add"]);
    const column = run.viewName(command, "column");
    const add = booleanArgument(command, "add");
    const plan = run.draft();
    const sort = plan.sort ?? [];
    const at = sort.findIndex((key) => key.column === column);
    const current = at >= 0 ? sort[at].direction : null;
    if (!add) {
      plan.sort =
        current === "asc" ? [{ column, direction: "desc" }] : current === "desc" ? [] : [{ column, direction: "asc" }];
    } else if (current === "asc") {
      sort[at] = { column, direction: "desc" };
      plan.sort = sort;
    } else if (current === "desc") {
      sort.splice(at, 1);
      plan.sort = sort;
    } else {
      plan.sort = [...sort, { column, direction: "asc" }];
    }
    run.setPlan(plan);
  },

  "sort.clear"(run, command) {
    takes(command, []);
    const { sort: _sort, ...plan } = run.draft();
    run.setPlan(plan);
  },

  "filter.set"(run, command) {
    takes(command, ["where"]);
    const parts = wherePartsArgument(command);
    const plan = run.draft();
    plan.where = joinParts([...partsOf(plan.where).filter(isSearch), ...parts]);
    run.setPlan(plan);
  },

  "filter.column"(run, command) {
    takes(command, ["column", "where"]);
    const column = stringArgument(command, "column");
    const rows = [...run.context.table.map((item) => item.name), ...(run.plan.derive ?? []).map((item) => item.name)];
    if (!rows.includes(column)) fail("/column", "unknown_column", `The rows have no column "${column}".`);
    const parts = wherePartsArgument(command, column);
    const plan = run.draft();
    const current = partsOf(plan.where);
    const ofColumn = (part: Expr) => {
      const names = columnsOf(part);
      return !isSearch(part) && names.size === 1 && names.has(column);
    };
    const first = current.findIndex(ofColumn);
    const kept = current.filter((part) => !ofColumn(part));
    // The parts before the first condition of the column are kept, so it is also its place among them.
    kept.splice(first < 0 ? kept.length : first, 0, ...parts);
    plan.where = joinParts(kept);
    run.setPlan(plan);
  },

  "filter.clear"(run, command) {
    takes(command, []);
    const plan = run.draft();
    plan.where = joinParts(partsOf(plan.where).filter(isSearch));
    run.setPlan(plan);
  },

  "search.set"(run, command) {
    takes(command, ["text"]);
    const text = stringArgument(command, "text");
    const plan = run.draft();
    const conditions = partsOf(plan.where).filter((part) => !isSearch(part));
    plan.where = joinParts(trimSpaces(text) === "" ? conditions : [{ search: text }, ...conditions]);
    run.setPlan(plan);
  },

  "derive.add"(run, command) {
    takes(command, ["name", "expr", "before"]);
    const name = stringArgument(command, "name");
    const expr = expressionArgument(command, "expr");
    if (expr === null) fail("/expr", "syntax", "expr is an expression (§4.3).");
    const before = optionalString(command, "before");
    const plan = run.draft();
    const derive = plan.derive ?? [];
    const at = before === undefined ? derive.length : run.derivedIndex("before", before);
    derive.splice(at, 0, { name, expr });
    plan.derive = derive;
    run.setPlan(plan);
  },

  "derive.update"(run, command) {
    takes(command, ["name", "expr", "rename"]);
    const name = stringArgument(command, "name");
    const index = run.derivedIndex("name", name);
    let expr: Expr | undefined;
    if (command.expr !== undefined) {
      const value = expressionArgument(command, "expr");
      if (value === null) fail("/expr", "syntax", "expr is an expression (§4.3).");
      expr = value;
    }
    const rename = optionalString(command, "rename");
    const plan = run.draft();
    const derive = plan.derive ?? [];
    if (expr !== undefined) derive[index] = { name, expr };
    if (rename === undefined || rename === name) {
      run.setPlan(plan);
      return;
    }
    const aggregate = plan.aggregate;
    const keyed = aggregate?.keys.includes(name) ?? false;
    // `{ col }` in having, sort keys of an aggregated view and styles name the view's columns.
    const viewScope = aggregate === undefined || keyed;
    plan.derive = derive.map((item) => ({
      name: item.name === name ? rename : item.name,
      expr: renameExpr(item.expr, name, rename),
    }));
    if (plan.where) plan.where = renameExpr(plan.where, name, rename);
    if (aggregate) {
      plan.aggregate = {
        ...aggregate,
        keys: aggregate.keys.map((key) => (key === name ? rename : key)),
        measures: aggregate.measures.map((measure) =>
          measure.column === name ? { ...measure, column: rename } : measure,
        ),
      };
      if (aggregate.pivot) {
        plan.aggregate.pivot = {
          ...aggregate.pivot,
          columns: aggregate.pivot.columns.map((column) => (column === name ? rename : column)),
        };
      }
      if (keyed && plan.having) plan.having = renameExpr(plan.having, name, rename);
    }
    if (plan.sort && viewScope) {
      plan.sort = plan.sort.map((key) => (key.column === name ? { ...key, column: rename } : key));
    }
    run.setPlan(plan);
    if (run.document.columns) {
      const ownSetting = viewScope || !run.viewColumn(name);
      run.document.columns = run.document.columns
        .filter((setting) => !(ownSetting && setting.name === rename))
        .map((setting) => {
          const next = ownSetting && setting.name === name ? { ...setting, name: rename } : setting;
          if (!viewScope || !next.format?.styles) return next;
          return {
            ...next,
            format: {
              ...next.format,
              styles: next.format.styles.map((rule) => ({ ...rule, when: renameExpr(rule.when, name, rename) })),
            },
          };
        });
    }
    const session = run.session;
    if (session.checked?.where) run.own("checked").where = renameExpr(session.checked.where, name, rename);
    if (viewScope) {
      for (const member of ["active", "anchor", "focus", "editor"] as const) {
        if (session[member]?.column === name) run.own(member).column = rename;
      }
      if (session.scroll?.column === name) run.own("scroll").column = rename;
      if (session.selection) {
        for (const range of run.own("selection")) {
          if (range.columns !== "all")
            range.columns = range.columns.map((column) => (column === name ? rename : column));
        }
      }
    }
  },

  "derive.remove"(run, command) {
    takes(command, ["name"]);
    const name = stringArgument(command, "name");
    run.derivedIndex("name", name);
    const plan = run.draft();
    const removed = new Set([name]);
    for (const item of plan.derive ?? []) {
      if ([...columnsOf(item.expr)].some((column) => removed.has(column))) removed.add(item.name);
    }
    const uses = (expr: Expr) => [...columnsOf(expr)].some((column) => removed.has(column));
    plan.derive = (plan.derive ?? []).filter((item) => !removed.has(item.name));
    plan.where = joinParts(partsOf(plan.where).filter((part) => !uses(part)));
    if (plan.aggregate) {
      const { keys, measures, pivot } = plan.aggregate;
      plan.aggregate = {
        keys: keys.filter((key) => !removed.has(key)),
        measures: measures.filter((measure) => measure.column === undefined || !removed.has(measure.column)),
      };
      if (pivot && !pivot.columns.some((column) => removed.has(column))) plan.aggregate.pivot = pivot;
      if (plan.aggregate.keys.length === 0 && plan.aggregate.measures.length === 0) {
        delete plan.aggregate;
        delete plan.having;
      }
    }
    run.setPlan(run.keepValid(plan));
    if (run.document.columns) {
      const view = new Set(checkPlan(run.plan, run.context.table).columns.map((column) => column.name));
      run.document.columns = run.document.columns.filter(
        (setting) => !removed.has(setting.name) || view.has(setting.name),
      );
    }
  },

  "group.set"(run, command) {
    takes(command, ["aggregate"]);
    if (!isObject(command.aggregate)) fail("/aggregate", "syntax", "aggregate is an object (§4.1).");
    const { having, sort, ...plan } = run.draft();
    plan.aggregate = command.aggregate as unknown as Plan["aggregate"];
    run.checkPlan(plan);
    run.setPlan(run.keepValid({ ...plan, having, sort }));
  },

  "group.clear"(run, command) {
    takes(command, []);
    const { aggregate: _aggregate, having: _having, ...plan } = run.draft();
    run.setPlan(run.keepValid(plan));
  },

  "having.set"(run, command) {
    takes(command, ["having"]);
    const having = expressionArgument(command, "having");
    const plan = run.draft();
    if (having === null) delete plan.having;
    else plan.having = having;
    run.setPlan(plan);
  },

  // ----- columns (§6.3) -----

  "column.resize"(run, command) {
    takes(command, ["name", "width"]);
    const name = run.viewName(command, "name");
    const width = command.width;
    if (width !== null && (typeof width !== "number" || !(width >= 1 && width <= 100_000))) {
      fail("/width", "syntax", "width is from 1 to 100,000 pixels, or null.");
    }
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    if (width === null) delete setting.width;
    else setting.width = width;
    run.setColumns(settings);
  },

  "column.move"(run, command) {
    takes(command, ["names", "before"]);
    const names = namesArgument(command, "names");
    names.forEach((name, index) => {
      run.displayedName(command, "names", `/names/${index}`, name);
    });
    if (new Set(names).size !== names.length) fail("/names", "syntax", "names lists each column once.");
    let before: string | null = null;
    if (command.before !== null) {
      before = run.displayedName(command, "before");
      if (names.includes(before)) fail("/before", "syntax", "before is not one of the moved columns.");
    }
    const displayed = run.displayed();
    const settings = run.settings();
    const moving = settings
      .filter((setting) => names.includes(setting.name))
      .sort((a, b) => displayed.indexOf(a.name) - displayed.indexOf(b.name));
    const rest = settings.filter((setting) => !names.includes(setting.name));
    const target = before === null ? undefined : rest.find((setting) => setting.name === before);
    const pin = target?.pin;
    for (const setting of moving) {
      if (pin) setting.pin = pin;
      else delete setting.pin;
    }
    const at =
      target ?? rest.find((setting) => setting.pin === "right" && displayed.includes(setting.name) && !setting.hidden);
    insertBefore(rest, moving, at);
    run.setColumns(rest);
  },

  "column.hide"(run, command) {
    takes(command, ["names"]);
    const names = namesArgument(command, "names");
    names.forEach((name, index) => {
      run.viewName(command, "names", `/names/${index}`, name);
    });
    const settings = run.settings();
    for (const setting of settings) {
      if (!names.includes(setting.name)) continue;
      setting.hidden = true;
      delete setting.pin;
    }
    const view = new Set(run.context.view.columns.map((column) => column.name));
    if (!settings.some((setting) => view.has(setting.name) && !setting.hidden)) {
      fail("/names", "last_column", "At least one column stays displayed.");
    }
    run.setColumns(settings);
  },

  "column.show"(run, command) {
    takes(command, ["names", "all"]);
    const all = booleanArgument(command, "all");
    if (all === (command.names !== undefined)) fail("", "syntax", "column.show takes names, or all: true.");
    const names = all ? run.context.view.columns.map((column) => column.name) : namesArgument(command, "names");
    if (!all) {
      names.forEach((name, index) => {
        run.viewName(command, "names", `/names/${index}`, name);
      });
    }
    const settings = run.settings();
    for (const setting of settings) if (names.includes(setting.name)) delete setting.hidden;
    run.setColumns(settings);
  },

  "column.pin"(run, command) {
    takes(command, ["name", "side"]);
    const name = run.displayedName(command, "name");
    const side = command.side === null ? null : choice(command, "side", ["left", "right"] as const);
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    const current = setting.pin ?? null;
    if (current === side) {
      run.setColumns(settings);
      return;
    }
    const displayed = new Set(run.displayed());
    const rest = settings.filter((item) => item !== setting);
    const shown = (item: ColumnSetting) => displayed.has(item.name) && !item.hidden;
    // The left side's inner end is before the first column not pinned left; the right side's, before the first one pinned right.
    const leftSide = side === "left" || (side === null && current === "left");
    const at = leftSide
      ? rest.find((item) => shown(item) && item.pin !== "left")
      : rest.find((item) => shown(item) && item.pin === "right");
    if (side) setting.pin = side;
    else delete setting.pin;
    insertBefore(rest, [setting], at);
    run.setColumns(rest);
  },

  "column.format"(run, command) {
    takes(command, ["name", "format"]);
    const name = run.viewName(command, "name");
    if (command.format === undefined) fail("/format", "syntax", "format is a format or null.");
    const format = command.format === null ? null : checked(() => checkColumnFormat(command.format, "/format"));
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    if (format === null) delete setting.format;
    else setting.format = format;
    run.setColumns(settings);
  },

  "column.total"(run, command) {
    takes(command, ["name", "total"]);
    const name = run.viewName(command, "name");
    if (command.total === undefined) fail("/total", "syntax", "total is { fn, p? } or null.");
    const total = command.total === null ? null : checked(() => checkTotal(command.total, "/total"));
    const column = run.viewColumn(name) as Column;
    if (total && !measureTakes(total.fn, column)) {
      fail("/total/fn", "type", `${total.fn} does not measure the values of "${name}".`);
    }
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    if (total === null) delete setting.total;
    else setting.total = total;
    run.setColumns(settings);
  },

  // ----- the selection, scrolling and checked rows (§6.4) -----

  select(run, command) {
    takes(command, ["row", "column", "mode"]);
    const row = positionArgument(command, "row");
    const column = stringArgument(command, "column");
    const mode = choice(command, "mode", MODES, "replace");
    const grid = run.grid();
    const col = grid.index.get(column);
    if (col === undefined) fail("/column", "unknown_column", `"${column}" is not a displayed column.`);
    const cell = { row: Math.min(row, run.lastRow), col };
    if (mode === "extend") {
      const ranges = [...grid.ranges];
      ranges[ranges.length - 1] = rectFor(grid.anchor, cell, kindOf(ranges[ranges.length - 1]));
      run.select(grid, grid.active, grid.anchor, cell, ranges);
    } else {
      run.select(grid, cell, cell, cell, mode === "add" ? [...grid.ranges, cellRect(cell)] : [cellRect(cell)]);
    }
  },

  "select.rows"(run, command) {
    takes(command, ["from", "to", "mode"]);
    const from = Math.min(positionArgument(command, "from"), run.lastRow);
    const to = Math.min(positionArgument(command, "to"), run.lastRow);
    const mode = choice(command, "mode", MODES, "replace");
    const grid = run.grid();
    if (grid.columns.length === 0) return;
    const col = grid.active.col;
    const focus = { row: to, col };
    if (mode === "extend") {
      const ranges = [...grid.ranges];
      ranges[ranges.length - 1] = rectFor(grid.anchor, focus, "rows");
      run.select(grid, grid.active, grid.anchor, focus, ranges);
      return;
    }
    const anchor = { row: from, col };
    const range = rectFor(anchor, focus, "rows");
    run.select(grid, anchor, anchor, focus, mode === "add" ? [...grid.ranges, range] : [range]);
  },

  "select.columns"(run, command) {
    takes(command, ["from", "to", "mode"]);
    const grid = run.grid();
    const position = (member: string) => {
      const name = stringArgument(command, member);
      const col = grid.index.get(name);
      if (col === undefined) fail(`/${member}`, "unknown_column", `"${name}" is not a displayed column.`);
      return col;
    };
    const from = position("from");
    const to = position("to");
    const mode = choice(command, "mode", MODES, "replace");
    const row = grid.active.row;
    const focus = { row, col: to };
    if (mode === "extend") {
      const ranges = [...grid.ranges];
      ranges[ranges.length - 1] = rectFor(grid.anchor, focus, "columns");
      run.select(grid, grid.active, grid.anchor, focus, ranges);
      return;
    }
    const anchor = { row, col: from };
    const range = rectFor(anchor, focus, "columns");
    run.select(grid, anchor, anchor, focus, mode === "add" ? [...grid.ranges, range] : [range]);
  },

  "select.all"(run, command) {
    takes(command, []);
    const grid = run.grid();
    if (grid.columns.length === 0) return;
    run.select(grid, grid.active, grid.active, grid.active, [{ rows: "all", cols: "all" }]);
  },

  move(run, command) {
    moveCommand(run, command, null);
  },

  "move.home"(run, command) {
    moveCommand(run, command, "home");
  },

  "move.end"(run, command) {
    moveCommand(run, command, "end");
  },

  advance(run, command) {
    takes(command, ["axis", "back"]);
    const axis = choice(command, "axis", ["row", "column"] as const);
    run.advance(axis, booleanArgument(command, "back"));
  },

  "scroll.to"(run, command) {
    takes(command, ["row", "column"]);
    const row = Math.min(positionArgument(command, "row"), run.lastRow);
    const column = optionalString(command, "column");
    if (column !== undefined) run.displayedName(command, "column", "/column", column);
    run.session.scroll = column === undefined ? { row } : { row, column };
  },

  check(run, command) {
    setChecked(run, command, true);
  },

  uncheck(run, command) {
    setChecked(run, command, false);
  },

  "check.all"(run, command) {
    takes(command, []);
    const where = run.plan.where;
    run.session.checked = where === undefined ? { mode: "exclude", keys: [] } : { mode: "exclude", keys: [], where };
  },

  "check.clear"(run, command) {
    takes(command, []);
    delete run.session.checked;
  },

  "detail.open"(run, command) {
    takes(command, []);
    run.session.detail = { open: true };
  },

  "detail.close"(run, command) {
    takes(command, []);
    delete run.session.detail;
  },

  // ----- editing (§6.5) -----

  "edit.begin"(run, command) {
    takes(command, ["text"]);
    const given = optionalString(command, "text");
    const grid = run.grid();
    if (grid.columns.length === 0 || run.rowCount === 0) return;
    const cell = { row: grid.active.row, column: grid.columns[grid.active.col] };
    run.writable([cell.column]);
    run.need([{ cells: [cell], keyed: true }]);
    const value = run.valueAt(cell);
    const text = given ?? editText(value, run.typeOf(cell.column));
    run.session.editor = { row: cell.row, column: cell.column, key: run.keyAt(cell.row), text, value };
  },

  "edit.change"(run, command) {
    takes(command, ["text"]);
    const text = stringArgument(command, "text");
    if (!run.session.editor) fail("", "no_editor", "No cell is being edited.");
    run.own("editor").text = text;
  },

  "edit.cancel"(run, command) {
    takes(command, []);
    if (!run.session.editor) fail("", "no_editor", "No cell is being edited.");
    delete run.session.editor;
  },

  "edit.commit"(run, command) {
    takes(command, ["move"]);
    const move = command.move === undefined || command.move === null ? null : choice(command, "move", DIRECTIONS);
    const editor = run.session.editor;
    if (!editor) fail("", "no_editor", "No cell is being edited.");
    run.writable([editor.column]);
    const read = readCellText(editor.text, run.typeOf(editor.column));
    if (!read.ok) {
      fail("", "invalid_value", `The text is not a value of "${editor.column}".`, {
        row: editor.row,
        column: editor.column,
        error: read.error,
      });
    }
    run.write([{ key: editor.key, column: editor.column, value: read.value, previous: editor.value }]);
    delete run.session.editor;
    if (move === "down" || move === "up") run.advance("row", move === "up");
    else if (move) run.advance("column", move === "left");
  },

  "edit.clear"(run, command) {
    takes(command, []);
    const grid = run.grid();
    if (grid.columns.length === 0) return;
    const cells = run.cellsOf(grid, grid.ranges);
    if (cells.length === 0) return;
    const targets = cells.filter((cell) => run.writableCell(cell.column));
    if (targets.length === 0) fail("", "read_only", "No selected cell is written.", { column: cells[0].column });
    if (targets.length > WRITE_LIMIT) fail("", "too_many_cells", "A write holds at most 100,000 cells.");
    run.need([{ cells: targets, keyed: true }]);
    run.write(
      targets.flatMap((cell) => {
        const value = run.valueAt(cell);
        if (isBlank(value, run.typeOf(cell.column))) return [];
        return [{ key: run.keyAt(cell.row), column: cell.column, value: null, previous: value }];
      }),
    );
  },

  "edit.paste"(run, command) {
    takes(command, []);
    const clipboard = run.context.clipboard ?? {};
    const values = clipboard.text
      ? parseTsv(clipboard.text)
      : clipboard.html
        ? (parseHtmlTable(clipboard.html) ?? [])
        : [];
    const height = values.length;
    const width = values.reduce((most, row) => Math.max(most, row.length), 0);
    const grid = run.grid();
    if (height === 0 || width === 0 || grid.columns.length === 0) return;
    if (grid.ranges.length > 1 && !(height === 1 && width === 1)) {
      fail("", "paste_ranges", "Several values cannot be pasted into several ranges.");
    }
    let cutRows = 0;
    let cutColumns = 0;
    const areas = grid.ranges.map((rect) => {
      const top = rect.rows === "all" ? 0 : rect.rows[0];
      const rows = rect.rows === "all" ? run.rowCount : rect.rows[1] - rect.rows[0];
      const cols = run.colsOf(rect, grid);
      // A range that holds the values a whole number of times is filled with them.
      const repeat = grid.ranges.length > 1 || (rows % height === 0 && cols.length % width === 0);
      const areaRows = repeat ? rows : height;
      const wanted = repeat ? cols : span(cols[0], cols[0] + width - 1);
      cutRows = Math.max(cutRows, top + areaRows - run.rowCount);
      cutColumns = Math.max(cutColumns, wanted.filter((col) => col >= grid.columns.length).length);
      return {
        top,
        end: Math.min(top + areaRows, run.rowCount),
        cols: wanted.filter((col) => col < grid.columns.length),
      };
    });
    run.writable(new Set(areas.flatMap((area) => area.cols.map((col) => grid.columns[col]))));
    const count = areas.reduce((total, area) => total + Math.max(0, area.end - area.top) * area.cols.length, 0);
    if (count > WRITE_LIMIT) fail("", "too_many_cells", "A write holds at most 100,000 cells.");
    const targets: (Target & { text: string })[] = [];
    const seen = new Set<string>();
    for (const area of areas) {
      for (let row = area.top; row < area.end; row++) {
        area.cols.forEach((col, index) => {
          const id = `${row}:${col}`;
          if (seen.has(id)) return;
          seen.add(id);
          const text = values[(row - area.top) % height]?.[index % width] ?? "";
          targets.push({ row, column: grid.columns[col], text });
        });
      }
    }
    run.need([{ cells: targets, keyed: true }]);
    const updates = targets.map((cell) => {
      const read = readCellText(cell.text, run.typeOf(cell.column), { grouping: true });
      if (!read.ok) {
        fail("", "invalid_value", `"${cell.text}" is not a value of "${cell.column}".`, {
          row: cell.row,
          column: cell.column,
          error: read.error,
        });
      }
      return { key: run.keyAt(cell.row), column: cell.column, value: read.value, previous: run.valueAt(cell) };
    });
    run.write(updates);
    run.output = { cutRows: Math.max(0, cutRows), cutColumns };
  },

  "edit.fill"(run, command) {
    takes(command, ["direction"]);
    const down = choice(command, "direction", ["down", "right"] as const) === "down";
    const grid = run.grid();
    if (grid.columns.length === 0) return;
    // Along the fill, the line filled from and the lines filled; across it, the cells of the range.
    const areas = grid.ranges.flatMap((rect) => {
      const [start, end] = run.cellRows(rect);
      const cols = run.colsOf(rect, grid);
      if (end <= start || cols.length === 0) return [];
      if (down) {
        const from = end - start === 1 ? start - 1 : start;
        const first = end - start === 1 ? start : start + 1;
        return from < 0 || first >= end ? [] : [{ from, lines: span(first, end - 1), across: cols }];
      }
      const from = cols.length === 1 ? cols[0] - 1 : cols[0];
      const lines = cols.length === 1 ? cols : cols.slice(1);
      return from < 0 ? [] : [{ from, lines, across: span(start, end - 1) }];
    });
    const columnsFilled = down
      ? areas.flatMap((area) => area.across.map((col) => grid.columns[col]))
      : areas.flatMap((area) => area.lines.map((col) => grid.columns[col]));
    run.writable(new Set(columnsFilled));
    const count = areas.reduce((total, area) => total + area.lines.length * area.across.length, 0);
    if (count > WRITE_LIMIT) fail("", "too_many_cells", "A write holds at most 100,000 cells.");
    const targets: { target: Target; source: Target }[] = [];
    const seen = new Set<string>();
    for (const area of areas) {
      // Row by row, and in a row column by column, as every write lists its cells.
      const [rows, cols] = down ? [area.lines, area.across] : [area.across, area.lines];
      for (const row of rows) {
        for (const col of cols) {
          const id = `${row}:${col}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const source = down
            ? { row: area.from, column: grid.columns[col] }
            : { row, column: grid.columns[area.from] };
          targets.push({ target: { row, column: grid.columns[col] }, source });
        }
      }
    }
    run.need([
      { cells: targets.map((item) => item.target), keyed: true },
      { cells: targets.map((item) => item.source), keyed: false },
    ]);
    const updates = targets.map(({ target, source }) => {
      const value = run.valueAt(source);
      const from = run.typeOf(source.column);
      const to = run.typeOf(target.column);
      let next = value;
      if (value !== null && !sameType(from, to)) {
        const read = readCellText(textOf(value, from) ?? "", to);
        if (!read.ok) {
          fail("", "invalid_value", `A value of "${source.column}" is not a value of "${target.column}".`, {
            row: target.row,
            column: target.column,
            error: read.error,
          });
        }
        next = read.value;
      }
      return { key: run.keyAt(target.row), column: target.column, value: next, previous: run.valueAt(target) };
    });
    run.write(updates);
  },

  "history.undo"(run, command) {
    takes(command, []);
    const step = run.session.history?.undo.at(-1);
    if (!step) fail("", "nothing", "There is nothing to undo.");
    for (const update of step.updates) {
      if (!run.writableColumn(update.column)) {
        fail("", "read_only", `The cells of "${update.column}" are not written.`, { column: update.column });
      }
    }
    run.requests.push(historyWrite(run, step.updates, "before"));
  },

  "history.redo"(run, command) {
    takes(command, []);
    const step = run.session.history?.redo.at(-1);
    if (!step) fail("", "nothing", "There is nothing to redo.");
    for (const update of step.updates) {
      if (!run.writableColumn(update.column)) {
        fail("", "read_only", `The cells of "${update.column}" are not written.`, { column: update.column });
      }
    }
    run.requests.push(historyWrite(run, step.updates, "after"));
  },

  // ----- copying and exporting (§6.6) -----

  copy(run, command) {
    takes(command, ["headers", "values"]);
    const headers = booleanArgument(command, "headers");
    if (choice(command, "values", ["raw", "formatted"] as const, "raw") === "formatted") {
      fail("/values", "unsupported", "The reference implementation copies raw values only (§6.6).");
    }
    const grid = run.grid();
    const layout = copyLayout(run, grid);
    if (!layout) fail("", "copy_layout", "These ranges cannot be copied together.");
    const rows = layout.rows.flatMap(([start, end]) => span(start, end - 1).filter((row) => row < run.rowCount));
    if (rows.length * layout.cols.length > COPY_LIMIT)
      fail("", "too_many_cells", "A copy holds at most 1,000,000 cells.");
    const names = layout.cols.map((col) => grid.columns[col]);
    run.need([{ cells: rows.flatMap((row) => names.map((column) => ({ row, column }))), keyed: false }]);
    const body = rows.map((row) =>
      names.map((column) => textOf(run.valueAt({ row, column }), run.typeOf(column)) ?? ""),
    );
    const table = headers ? [names, ...body] : body;
    run.output = {
      tsv: toTsv(table),
      html: toHtmlTable(table, headers ? 1 : 0),
      markdown: toMarkdownTable(headers ? names : names.map(() => ""), body),
    };
  },

  export(run, command) {
    takes(command, ["format", "columns", "rows", "target"]);
    const format = stringArgument(command, "format");
    const columns = choice(command, "columns", ["displayed", "all"] as const, "displayed");
    const rows = choice(command, "rows", ["view", "table"] as const, "view");
    const target = optionalString(command, "target");
    const capabilities = run.context.capabilities;
    if (capabilities && !capabilities.export?.formats.includes(format)) {
      fail("/format", "unsupported", `The engine does not export ${format}.`);
    }
    // The whole table is its rows as they are, without the plan, in the displayed order of its columns.
    const source = rows === "view" ? run.context.view.columns : run.context.table;
    const known = new Set(source.map((column) => column.name));
    let displayed = run.displayed().filter((name) => known.has(name));
    if (displayed.length === 0 && rows === "table") displayed = source.map((column) => column.name);
    const names =
      columns === "displayed"
        ? displayed
        : [...displayed, ...source.map((column) => column.name).filter((name) => !displayed.includes(name))];
    const settings = new Map((run.document.columns ?? []).map((setting) => [setting.name, setting]));
    const request: CommandRequest = {
      op: "export",
      revision: run.context.revision,
      plan: rows === "view" ? run.plan : {},
      format,
      columns: names,
      headers: names.map((name) => settings.get(name)?.format?.label ?? name),
    };
    if (format === "xlsx") {
      // A workbook shows numbers and dates as the grid formats them.
      const types = new Map(source.map((column) => [column.name, column.type]));
      const codes = names.map((name) => excelNumberFormat(types.get(name) as LogicalType, settings.get(name)?.format));
      if (codes.some((code) => code !== null)) request.numberFormats = codes;
    }
    if (target !== undefined) request.target = target;
    run.requests.push(request);
  },

  save(run, command) {
    takes(command, []);
    if (!run.offers("save")) fail("", "unsupported", "The engine does not save.");
    run.requests.push({ op: "save" });
  },

  // ----- commands of the core (§6.7) -----

  "view.update"(run, command) {
    takes(command, ["hash", "located"]);
    const hash = stringArgument(command, "hash");
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) fail("/hash", "syntax", "hash is a plan hash (§4.8).");
    const located = command.located ?? [];
    if (!Array.isArray(located)) fail("/located", "syntax", "located is a list of { key, row }.");
    const positions = checked(() =>
      located.map((item, index) => {
        const at = `/located/${index}`;
        if (!isObject(item)) throw new StateError(at, "syntax", "A located key is { key, row }.");
        const row = item.row;
        if (row !== null && (typeof row !== "number" || !Number.isSafeInteger(row) || row < 0)) {
          throw new StateError(`${at}/row`, "syntax", "row is a view position or null.");
        }
        return { key: checkRowKey(item.key, `${at}/key`), row: row as number | null };
      }),
    );
    const session = run.session;
    const revision = run.context.revision;
    if (session.revision !== undefined && session.revision !== revision) {
      if (session.checked) {
        session.checked = { ...session.checked, keys: session.checked.keys.filter((key) => !("rowId" in key)) };
      }
      if (session.active?.key && "rowId" in session.active.key) delete run.own("active").key;
      delete session.history;
      delete session.editor;
    }
    session.revision = revision;
    if (session.view !== undefined && session.view !== hash) {
      if (session.active) {
        const active = run.own("active");
        const key = active.key;
        const found = key ? positions.find((item) => sameKey(item.key, key)) : undefined;
        const row = found?.row ?? 0;
        if (found?.row === undefined || found.row === null) {
          // The key is not in the new view: the active cell is its first row, whose key the core may have read.
          const loaded = run.loadedKey(row);
          if (loaded === undefined) delete active.key;
          else active.key = loaded;
        }
        if (row !== active.row) session.scroll = { ...session.scroll, row };
        active.row = row;
      }
      delete session.anchor;
      delete session.focus;
      delete session.selection;
      delete session.editor;
    }
    session.view = hash;
    run.fit();
  },

  "history.push"(run, command) {
    takes(command, ["updates"]);
    if (!Array.isArray(command.updates))
      fail("/updates", "syntax", "updates is a list of { key, column, before, after }.");
    const updates = checked(() =>
      (command.updates as unknown[]).map((item, index): HistoryUpdate => {
        const at = `/updates/${index}`;
        if (!isObject(item)) throw new StateError(at, "syntax", "An update is { key, column, before, after }.");
        for (const key of Object.keys(item)) {
          if (!["key", "column", "before", "after"].includes(key)) {
            throw new StateError(`${at}/${key}`, "syntax", `"${key}" is not a member here.`);
          }
        }
        if (typeof item.column !== "string") throw new StateError(`${at}/column`, "syntax", "column is a name.");
        return {
          key: checkRowKey(item.key, `${at}/key`),
          column: item.column,
          before: checkValue(item.before, `${at}/before`),
          after: checkValue(item.after, `${at}/after`),
        };
      }),
    );
    const history = run.session.history ? run.own("history") : { undo: [], redo: [] };
    history.redo = [];
    if (updates.length > HISTORY_LIMITS.updates) {
      delete run.session.history;
      return;
    }
    history.undo.push({ updates });
    let total = history.undo.reduce((count, step) => count + step.updates.length, 0);
    while (history.undo.length > HISTORY_LIMITS.steps || total > HISTORY_LIMITS.updates) {
      total -= (history.undo.shift() as { updates: HistoryUpdate[] }).updates.length;
    }
    run.session.history = history;
  },

  "history.undone"(run, command) {
    takes(command, []);
    if (!run.session.history?.undo.length) fail("", "nothing", "There is nothing to undo.");
    const history = run.own("history");
    history.redo.push(history.undo.pop() as HistoryStep);
  },

  "history.redone"(run, command) {
    takes(command, []);
    if (!run.session.history?.redo.length) fail("", "nothing", "There is nothing to redo.");
    const history = run.own("history");
    history.undo.push(history.redo.pop() as HistoryStep);
  },

  "history.clear"(run, command) {
    takes(command, []);
    delete run.session.history;
  },
};

/** The write of a step's values before (undo) or after (redo), each with the other as `previous` (§7.4). */
function historyWrite(run: Run, updates: readonly HistoryUpdate[], values: "before" | "after"): CommandRequest {
  const request: CommandRequest = {
    op: "write",
    revision: run.context.revision,
    updates: updates.map((update) => ({
      key: update.key,
      column: update.column,
      value: values === "before" ? update.before : update.after,
      previous: values === "before" ? update.after : update.before,
    })),
  };
  if (run.document.rowKey !== undefined) request.rowKey = run.document.rowKey;
  return request;
}

/**
 * How ranges are copied together (§6.6): ranges with the same rows side by side, ranges with the same
 * columns one below the other, in display order and without the cells between them; null otherwise.
 */
function copyLayout(run: Run, grid: Grid): { rows: [number, number][]; cols: number[] } | null {
  const ranges = grid.ranges.map((rect) => ({
    rows: (rect.rows === "all" ? [0, run.lastRow + 1] : rect.rows) as [number, number],
    cols: run.colsOf(rect, grid),
  }));
  const first = ranges[0];
  if (ranges.every((range) => range.rows[0] === first.rows[0] && range.rows[1] === first.rows[1])) {
    const cols = [...new Set(ranges.flatMap((range) => range.cols))].sort((a, b) => a - b);
    return { rows: [first.rows], cols };
  }
  if (ranges.every((range) => sameList(range.cols, first.cols))) {
    const rows: [number, number][] = [];
    for (const range of [...ranges].sort((a, b) => a.rows[0] - b.rows[0])) {
      const last = rows.at(-1);
      if (last && range.rows[0] <= last[1]) last[1] = Math.max(last[1], range.rows[1]);
      else rows.push([range.rows[0], range.rows[1]]);
    }
    return { rows, cols: first.cols };
  }
  return null;
}

/** The commands of §6, by name. */
export const COMMANDS = Object.keys(HANDLERS);

/**
 * Applies a command to a state with a context (§6.1). Throws a `CommandError` when the command cannot be
 * applied; the state given is not changed either way.
 */
export function applyCommand(state: GridState, command: unknown, context: CommandContext): CommandResult {
  if (!isObject(command) || typeof command.command !== "string") {
    fail("/command", "syntax", "A command is { command, …arguments }.");
  }
  const handler = Object.hasOwn(HANDLERS, command.command) ? HANDLERS[command.command as CommandName] : undefined;
  if (!handler) fail("/command", "unknown_command", `There is no command "${command.command}".`);
  const run = new Run(state, context);
  handler(run, command as Command);
  run.tidy();
  const result: CommandResult = {
    // Members are compared by value, so that a command that gives one again unchanged keeps its object; the
    // history only by identity, since it may hold a million updates and only history commands replace it.
    document: share(state.document, run.document, []),
    session: share(state.session, run.session, ["history"]),
    requests: run.requests,
  };
  if (run.output !== undefined) result.output = run.output;
  return result;
}
