/**
 * The state of a grid (docs/spec.md §5): the document, the session, displayed columns, row keys, and the
 * repair of a document for a table.
 */
import { type CheckOptions, checkPlan } from "./check.js";
import { canonicalJson } from "./hash.js";
import {
  type Derived,
  type Expr,
  MEASURES,
  type Measure,
  type MeasureName,
  type Plan,
  PlanError,
  type SortKey,
} from "./plan.js";
import type { Column, JsonValue, ValueType } from "./types.js";
import { isObject } from "./values.js";

/** How a column shows numbers: 0.1's `NumberFormat`. */
export interface NumberFormat {
  style?: "decimal" | "percent" | "currency";
  currency?: string;
  currencyDisplay?: "symbol" | "narrowSymbol" | "code" | "name";
  fractionDigits?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  grouping?: boolean;
  notation?: "standard" | "scientific" | "engineering" | "compact";
  signDisplay?: "auto" | "always" | "exceptZero" | "negative" | "never";
  prefix?: string;
  suffix?: string;
}

/** How a column shows dates and times: 0.1's `DateFormat`. */
export interface DateFormat {
  pattern?: string;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
  weekday?: "long" | "short" | "narrow";
  year?: "numeric" | "2-digit";
  month?: "numeric" | "2-digit" | "long" | "short" | "narrow";
  day?: "numeric" | "2-digit";
  hour?: "numeric" | "2-digit";
  minute?: "numeric" | "2-digit";
  second?: "numeric" | "2-digit";
  fractionalSecondDigits?: 1 | 2 | 3;
  hour12?: boolean;
  timeZoneName?: "short" | "long" | "shortOffset" | "longOffset";
  timeZone?: string;
}

/** A rule of conditional colors: the first rule whose `when` is true for the row colors the cell. */
export interface StyleRule {
  when: Expr;
  color?: string;
  background?: string;
  description?: string;
}

export interface ColumnFormat {
  label?: string;
  number?: NumberFormat;
  date?: DateFormat;
  align?: "left" | "center" | "right";
  wrap?: boolean;
  copy?: "raw" | "formatted";
  styles?: StyleRule[];
}

/** A column's value in the totals row: a measure of the column over the whole view. */
export interface Total {
  fn: MeasureName;
  p?: number;
}

export type Pin = "left" | "right";

/** The settings of one column (§5.1). */
export interface ColumnSetting {
  name: string;
  width?: number;
  hidden?: boolean;
  pin?: Pin;
  format?: ColumnFormat;
  total?: Total;
}

/** What a person saves, shares or gives an agent (§5.1). */
export interface GridDocument {
  kind: "vastgrid/document";
  version: 2;
  schema?: string[];
  rowKey?: string;
  plan?: Plan;
  columns?: ColumnSetting[];
}

/** A record's key (§5.3). */
export type RowKey = { rowId: number } | { value: JsonValue };

/** A cell: a view position and a displayed column. */
export interface CellRef {
  row: number;
  column: string;
}

export interface ActiveCell extends CellRef {
  key?: RowKey;
}

/** Selected cells (§5.2): `[start, end)` of view positions or all rows, and displayed columns or all of them. */
export interface CellRange {
  rows: [number, number] | "all";
  columns: string[] | "all";
}

/** Checked rows (§5.2.1). */
export interface Checked {
  mode: "include" | "exclude";
  keys: RowKey[];
  where?: Expr;
}

export interface Editor extends CellRef {
  key: RowKey;
  text: string;
  /** The cell's value when the editor opened. */
  value: JsonValue;
}

export interface HistoryUpdate {
  key: RowKey;
  column: string;
  before: JsonValue;
  after: JsonValue;
}

/** One write that succeeded (§7.4). */
export interface HistoryStep {
  updates: HistoryUpdate[];
}

/** Where the person is (§5.2). */
export interface GridSession {
  kind: "vastgrid/session";
  version: 2;
  view?: string;
  revision?: string | null;
  active?: ActiveCell;
  anchor?: CellRef;
  focus?: CellRef;
  selection?: CellRange[];
  scroll?: { row: number; column?: string };
  checked?: Checked;
  detail?: { open: boolean };
  editor?: Editor;
  history?: { undo: HistoryStep[]; redo: HistoryStep[] };
}

export interface GridState {
  document: GridDocument;
  session: GridSession;
}

export type StateErrorReason = "syntax" | "version" | "duplicate_name" | "limit";

/** A document or a session that does not have the form of §5: `path` is a JSON Pointer to the member at fault. */
export class StateError extends Error {
  readonly code = "invalid_state";
  readonly path: string;
  readonly reason: StateErrorReason;

  constructor(path: string, reason: StateErrorReason, message: string) {
    super(message);
    this.name = "StateError";
    this.path = path;
    this.reason = reason;
  }
}

/** Column settings that a document holds at most (§5.1). */
export const COLUMN_SETTINGS = 100_000;

/** Ranges that a selection holds at most (§5.2). */
export const SELECTION_RANGES = 1000;

/** Steps and updates that the history keeps (§7.4). */
export const HISTORY_LIMITS = { steps: 100, updates: 1_000_000 } as const;

export function emptyDocument(): GridDocument {
  return { kind: "vastgrid/document", version: 2 };
}

export function emptySession(): GridSession {
  return { kind: "vastgrid/session", version: 2 };
}

function fail(path: string, reason: StateErrorReason, message: string): never {
  throw new StateError(path, reason, message);
}

function members(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}/${key}`, "syntax", `"${key}" is not a member here.`);
  }
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 256) {
    fail(path, "syntax", "A name is a string of 1 to 256 characters.");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, "syntax", `Expected one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function position(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "syntax", "A position is an integer from 0.");
  }
  return value;
}

function expression(value: unknown, path: string): Expr {
  if (!isObject(value)) fail(path, "syntax", "An expression is an object (§4.3).");
  return value as unknown as Expr;
}

/** Checks a row key (§5.3) and gives it. */
export function checkRowKey(value: unknown, path: string): RowKey {
  if (!isObject(value)) fail(path, "syntax", "A row key is { rowId } or { value }.");
  if ("rowId" in value) {
    members(value, ["rowId"], path);
    return { rowId: position(value.rowId, `${path}/rowId`) };
  }
  members(value, ["value"], path);
  const key = value.value;
  if (typeof key !== "string" && typeof key !== "number" && typeof key !== "boolean") {
    fail(`${path}/value`, "syntax", "A key's value is a string, a number or a boolean.");
  }
  return { value: key };
}

/** Checks a column format (§5.1) and gives it. */
export function checkColumnFormat(value: unknown, path: string): ColumnFormat {
  if (!isObject(value)) fail(path, "syntax", "A format is an object.");
  members(value, ["label", "number", "date", "align", "wrap", "copy", "styles"], path);
  if (value.label !== undefined && typeof value.label !== "string")
    fail(`${path}/label`, "syntax", "label is a string.");
  if (value.number !== undefined && !isObject(value.number)) fail(`${path}/number`, "syntax", "number is an object.");
  if (value.date !== undefined && !isObject(value.date)) fail(`${path}/date`, "syntax", "date is an object.");
  if (value.align !== undefined) oneOf(value.align, ["left", "center", "right"], `${path}/align`);
  if (value.wrap !== undefined && typeof value.wrap !== "boolean") fail(`${path}/wrap`, "syntax", "wrap is a boolean.");
  if (value.copy !== undefined) oneOf(value.copy, ["raw", "formatted"], `${path}/copy`);
  if (value.styles !== undefined) {
    if (!Array.isArray(value.styles)) fail(`${path}/styles`, "syntax", "styles is an array.");
    value.styles.forEach((rule, index) => {
      const at = `${path}/styles/${index}`;
      if (!isObject(rule)) fail(at, "syntax", "A style is an object: { when, color?, background?, description? }.");
      members(rule, ["when", "color", "background", "description"], at);
      expression(rule.when, `${at}/when`);
      for (const key of ["color", "background", "description"]) {
        if (rule[key] !== undefined && typeof rule[key] !== "string")
          fail(`${at}/${key}`, "syntax", `${key} is a string.`);
      }
    });
  }
  return value as ColumnFormat;
}

/** Checks a total (§5.1) and gives it. */
export function checkTotal(value: unknown, path: string): Total {
  if (!isObject(value)) fail(path, "syntax", "A total is { fn, p? }.");
  members(value, ["fn", "p"], path);
  const fn = oneOf(value.fn, MEASURES, `${path}/fn`);
  if (fn === "quantile") {
    if (typeof value.p !== "number" || !(value.p >= 0 && value.p <= 1))
      fail(`${path}/p`, "syntax", "p is from 0 to 1.");
    return { fn, p: value.p };
  }
  if (value.p !== undefined) fail(`${path}/p`, "syntax", "Only quantile takes p.");
  return { fn };
}

/** Checks a column setting (§5.1) and gives it. */
export function checkColumnSetting(value: unknown, path: string): ColumnSetting {
  if (!isObject(value)) fail(path, "syntax", "A column setting is an object with a name.");
  members(value, ["name", "width", "hidden", "pin", "format", "total"], path);
  const setting: ColumnSetting = { name: name(value.name, `${path}/name`) };
  if (value.width !== undefined) {
    if (typeof value.width !== "number" || !(value.width >= 1 && value.width <= 100_000)) {
      fail(`${path}/width`, "syntax", "width is from 1 to 100,000 pixels.");
    }
    setting.width = value.width;
  }
  if (value.hidden !== undefined) {
    if (typeof value.hidden !== "boolean") fail(`${path}/hidden`, "syntax", "hidden is a boolean.");
    if (value.hidden) setting.hidden = true;
  }
  if (value.pin !== undefined) setting.pin = oneOf<Pin>(value.pin, ["left", "right"], `${path}/pin`);
  if (value.format !== undefined) setting.format = checkColumnFormat(value.format, `${path}/format`);
  if (value.total !== undefined) setting.total = checkTotal(value.total, `${path}/total`);
  return setting;
}

/** Checks the form of a document (§5.1) and gives it. Its plan is checked against the table when it is used. */
export function checkDocument(value: unknown): GridDocument {
  if (!isObject(value)) fail("", "syntax", "A document is an object.");
  if (value.kind !== "vastgrid/document") fail("/kind", "syntax", 'kind is "vastgrid/document".');
  if (value.version !== 2) fail("/version", "version", "This reader knows version 2.");
  members(value, ["kind", "version", "schema", "rowKey", "plan", "columns"], "");
  const document = emptyDocument();
  if (value.schema !== undefined) {
    if (!Array.isArray(value.schema) || !value.schema.every((item) => typeof item === "string")) {
      fail("/schema", "syntax", "schema is a list of names.");
    }
    document.schema = value.schema as string[];
  }
  if (value.rowKey !== undefined) document.rowKey = name(value.rowKey, "/rowKey");
  if (value.plan !== undefined) {
    if (!isObject(value.plan)) fail("/plan", "syntax", "plan is an object (§4.1).");
    document.plan = value.plan as Plan;
  }
  if (value.columns !== undefined) {
    if (!Array.isArray(value.columns)) fail("/columns", "syntax", "columns is an array.");
    if (value.columns.length > COLUMN_SETTINGS) {
      fail("/columns", "limit", "A document has at most 100,000 column settings.");
    }
    const seen = new Set<string>();
    document.columns = value.columns.map((item, index) => {
      const setting = checkColumnSetting(item, `/columns/${index}`);
      if (seen.has(setting.name))
        fail(`/columns/${index}/name`, "duplicate_name", `"${setting.name}" has two settings.`);
      seen.add(setting.name);
      return setting;
    });
  }
  return document;
}

/** Checks a value as JSON writes it (§2.2): null, a boolean, a finite number or a string. */
export function checkValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail(path, "syntax", "A value is null, a boolean, a number or a string (§2.2).");
}

function checkCell(value: unknown, path: string, keyed: boolean): ActiveCell {
  if (!isObject(value)) fail(path, "syntax", "A cell is { row, column }.");
  members(value, keyed ? ["row", "column", "key"] : ["row", "column"], path);
  const cell: ActiveCell = { row: position(value.row, `${path}/row`), column: name(value.column, `${path}/column`) };
  if (keyed && value.key !== undefined) cell.key = checkRowKey(value.key, `${path}/key`);
  return cell;
}

function checkRange(value: unknown, path: string): CellRange {
  if (!isObject(value)) fail(path, "syntax", "A range is { rows, columns }.");
  members(value, ["rows", "columns"], path);
  let rows: CellRange["rows"];
  if (value.rows === "all") rows = "all";
  else {
    if (!Array.isArray(value.rows) || value.rows.length !== 2)
      fail(`${path}/rows`, "syntax", 'rows is [start, end) or "all".');
    const start = position(value.rows[0], `${path}/rows/0`);
    const end = position(value.rows[1], `${path}/rows/1`);
    if (end <= start) fail(`${path}/rows`, "syntax", "A range has at least one row.");
    rows = [start, end];
  }
  let columns: CellRange["columns"];
  if (value.columns === "all") columns = "all";
  else {
    if (!Array.isArray(value.columns) || value.columns.length === 0) {
      fail(`${path}/columns`, "syntax", 'columns is a list of names or "all".');
    }
    columns = value.columns.map((item, index) => name(item, `${path}/columns/${index}`));
  }
  return { rows, columns };
}

function checkStep(value: unknown, path: string): HistoryStep {
  if (!isObject(value)) fail(path, "syntax", "A step is { updates }.");
  members(value, ["updates"], path);
  if (!Array.isArray(value.updates)) fail(`${path}/updates`, "syntax", "updates is an array.");
  return {
    updates: value.updates.map((update, index) => {
      const at = `${path}/updates/${index}`;
      if (!isObject(update)) fail(at, "syntax", "An update is { key, column, before, after }.");
      members(update, ["key", "column", "before", "after"], at);
      return {
        key: checkRowKey(update.key, `${at}/key`),
        column: name(update.column, `${at}/column`),
        before: checkValue(update.before, `${at}/before`),
        after: checkValue(update.after, `${at}/after`),
      };
    }),
  };
}

/** Checks the form of a session (§5.2) and gives it. */
export function checkSession(value: unknown): GridSession {
  if (!isObject(value)) fail("", "syntax", "A session is an object.");
  if (value.kind !== "vastgrid/session") fail("/kind", "syntax", 'kind is "vastgrid/session".');
  if (value.version !== 2) fail("/version", "version", "This reader knows version 2.");
  members(
    value,
    [
      "kind",
      "version",
      "view",
      "revision",
      "active",
      "anchor",
      "focus",
      "selection",
      "scroll",
      "checked",
      "detail",
      "editor",
      "history",
    ],
    "",
  );
  const session = emptySession();
  if (value.view !== undefined) {
    if (typeof value.view !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.view)) {
      fail("/view", "syntax", "view is a plan hash (§4.8).");
    }
    session.view = value.view;
  }
  if (value.revision !== undefined) {
    if (value.revision !== null && typeof value.revision !== "string")
      fail("/revision", "syntax", "revision is a string or null.");
    session.revision = value.revision;
  }
  if (value.active !== undefined) session.active = checkCell(value.active, "/active", true);
  if (value.anchor !== undefined) session.anchor = checkCell(value.anchor, "/anchor", false);
  if (value.focus !== undefined) session.focus = checkCell(value.focus, "/focus", false);
  if (value.selection !== undefined) {
    if (!Array.isArray(value.selection) || value.selection.length === 0) {
      fail("/selection", "syntax", "selection is a list of ranges.");
    }
    if (value.selection.length > SELECTION_RANGES) fail("/selection", "limit", "A selection has at most 1,000 ranges.");
    session.selection = value.selection.map((item, index) => checkRange(item, `/selection/${index}`));
  }
  if (value.scroll !== undefined) {
    const scroll = value.scroll;
    if (!isObject(scroll)) fail("/scroll", "syntax", "scroll is { row, column? }.");
    members(scroll, ["row", "column"], "/scroll");
    session.scroll = { row: position(scroll.row, "/scroll/row") };
    if (scroll.column !== undefined) session.scroll.column = name(scroll.column, "/scroll/column");
  }
  if (value.checked !== undefined) {
    const checked = value.checked;
    if (!isObject(checked)) fail("/checked", "syntax", "checked is { mode, keys, where? }.");
    members(checked, ["mode", "keys", "where"], "/checked");
    if (!Array.isArray(checked.keys)) fail("/checked/keys", "syntax", "keys is a list of row keys.");
    session.checked = {
      mode: oneOf(checked.mode, ["include", "exclude"], "/checked/mode"),
      keys: checked.keys.map((key, index) => checkRowKey(key, `/checked/keys/${index}`)),
    };
    if (checked.where !== undefined) {
      if (session.checked.mode !== "exclude") fail("/checked/where", "syntax", "where goes with the exclude mode.");
      session.checked.where = expression(checked.where, "/checked/where");
    }
  }
  if (value.detail !== undefined) {
    const detail = value.detail;
    if (!isObject(detail) || typeof detail.open !== "boolean") fail("/detail", "syntax", "detail is { open }.");
    members(detail, ["open"], "/detail");
    session.detail = { open: detail.open };
  }
  if (value.editor !== undefined) {
    const editor = value.editor;
    if (!isObject(editor)) fail("/editor", "syntax", "editor is { row, column, key, text, value }.");
    members(editor, ["row", "column", "key", "text", "value"], "/editor");
    if (typeof editor.text !== "string") fail("/editor/text", "syntax", "text is a string.");
    session.editor = {
      row: position(editor.row, "/editor/row"),
      column: name(editor.column, "/editor/column"),
      key: checkRowKey(editor.key, "/editor/key"),
      text: editor.text,
      value: checkValue(editor.value, "/editor/value"),
    };
  }
  if (value.history !== undefined) {
    const history = value.history;
    if (!isObject(history) || !Array.isArray(history.undo) || !Array.isArray(history.redo)) {
      fail("/history", "syntax", "history is { undo, redo }.");
    }
    members(history, ["undo", "redo"], "/history");
    const undo = history.undo.map((step, index) => checkStep(step, `/history/undo/${index}`));
    const redo = history.redo.map((step, index) => checkStep(step, `/history/redo/${index}`));
    if (undo.length + redo.length > HISTORY_LIMITS.steps)
      fail("/history", "limit", "The history has at most 100 steps.");
    const updates = [...undo, ...redo].reduce((count, step) => count + step.updates.length, 0);
    if (updates > HISTORY_LIMITS.updates) fail("/history", "limit", "The history has at most 1,000,000 updates.");
    session.history = { undo, redo };
  }
  return session;
}

/** A column of the view with its setting, as the grid displays it (§5.1.1). */
export interface DisplayedColumn {
  column: Column;
  setting: ColumnSetting;
}

/** The displayed columns of a document for the view's columns, in display order (§5.1.1). */
export function displayedColumns(document: GridDocument, view: readonly Column[]): DisplayedColumn[] {
  const settings = document.columns ?? [];
  const bySetting = new Map(settings.map((setting) => [setting.name, setting]));
  const byName = new Map(view.map((column) => [column.name, column]));
  const entry = (setting: ColumnSetting): DisplayedColumn | null => {
    const column = byName.get(setting.name);
    return column ? { column, setting } : null;
  };
  const listed = settings.flatMap((setting) => entry(setting) ?? []).filter((item) => !item.setting.hidden);
  const left = listed.filter((item) => item.setting.pin === "left");
  const right = listed.filter((item) => item.setting.pin === "right");
  const middle = [
    ...listed.filter((item) => item.setting.pin === undefined),
    ...view
      .filter((column) => !bySetting.has(column.name))
      .map((column) => ({ column, setting: { name: column.name } })),
  ];
  const displayed = [...left, ...middle, ...right];
  if (displayed.length === 0 && view.length > 0) {
    const first = view[0];
    displayed.push({ column: first, setting: bySetting.get(first.name) ?? { name: first.name } });
  }
  return displayed;
}

/** A key written so that keys that are the same (§5.3) have the same text. */
export function keyText(key: RowKey): string {
  if ("rowId" in key) return canonicalJson({ rowId: key.rowId });
  const value = key.value;
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))) {
    return canonicalJson({ value: Number(value) });
  }
  return canonicalJson({ value });
}

export function sameKey(a: RowKey, b: RowKey): boolean {
  return keyText(a) === keyText(b);
}

/** The columns an expression uses, by name. */
export function columnsOf(expr: Expr, names: Set<string> = new Set()): Set<string> {
  if ("col" in expr) names.add(expr.col);
  else if ("fn" in expr) for (const arg of expr.args) columnsOf(arg, names);
  return names;
}

function validates(plan: Plan, table: readonly Column[], options: CheckOptions) {
  try {
    checkPlan(plan, table, options);
    return true;
  } catch (error) {
    if (error instanceof PlanError) return false;
    throw error;
  }
}

/** The parts of a condition (§6.2.1): the arguments of an `and`, or the condition itself. */
export function partsOf(condition: Expr | undefined): Expr[] {
  if (condition === undefined) return [];
  return "fn" in condition && condition.fn === "and" ? [...condition.args] : [condition];
}

/** The condition made of parts (§6.2.1): none, the only part, or an `and` of the parts. */
export function joinParts(parts: readonly Expr[]): Expr | undefined {
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { fn: "and", args: [...parts] };
}

/** Whether a measure takes values of a type (§4.5). */
export function measureTakes(fn: MeasureName, type: ValueType): boolean {
  switch (fn) {
    case "count":
      return true;
    case "count_distinct":
    case "min":
    case "max":
      return type.type !== "interval" && type.type !== "binary";
    default:
      return type.type === "integer" || type.type === "bigint" || type.type === "decimal" || type.type === "float";
  }
}

/**
 * Repairs a document for a table (§5.5): removes the parts of its plan, and the totals, that do not validate
 * against the table's columns (or that the engine does not evaluate, with `options`). Gives the repaired
 * document and the JSON Pointers of what it removed.
 */
export function repairDocument(
  document: GridDocument,
  table: readonly Column[],
  options: CheckOptions = {},
): { document: GridDocument; removed: string[] } {
  const plan = document.plan ?? {};
  const removed: string[] = [];
  const valid = (candidate: Plan) => validates(candidate, table, options);
  const next: Plan = {};
  const derive: Derived[] = [];
  (plan.derive ?? []).forEach((item, index) => {
    if (valid({ derive: [...derive, item] })) derive.push(item);
    else removed.push(`/plan/derive/${index}`);
  });
  if (derive.length > 0) next.derive = derive;
  const repairCondition = (member: "where" | "having") => {
    const condition = plan[member];
    if (condition === undefined) return;
    if (valid({ ...next, [member]: condition })) {
      next[member] = condition;
      return;
    }
    if (!("fn" in condition) || condition.fn !== "and") {
      removed.push(`/plan/${member}`);
      return;
    }
    const kept: Expr[] = [];
    condition.args.forEach((arg, index) => {
      if (valid({ ...next, [member]: joinParts([...kept, arg]) })) kept.push(arg);
      else removed.push(`/plan/${member}/args/${index}`);
    });
    const joined = joinParts(kept);
    if (joined) next[member] = joined;
  };
  repairCondition("where");
  if (plan.aggregate) {
    const keys: string[] = [];
    plan.aggregate.keys.forEach((key, index) => {
      if (valid({ ...next, aggregate: { keys: [...keys, key], measures: [] } })) keys.push(key);
      else removed.push(`/plan/aggregate/keys/${index}`);
    });
    const measures: Measure[] = [];
    plan.aggregate.measures.forEach((measure, index) => {
      if (valid({ ...next, aggregate: { keys, measures: [...measures, measure] } })) measures.push(measure);
      else removed.push(`/plan/aggregate/measures/${index}`);
    });
    if (keys.length === 0 && measures.length === 0) {
      removed.push("/plan/aggregate");
      if (plan.having !== undefined) removed.push("/plan/having");
    } else {
      next.aggregate = { keys, measures };
      if (plan.aggregate.pivot) {
        const withPivot = { keys, measures, pivot: plan.aggregate.pivot };
        if (valid({ ...next, aggregate: withPivot })) next.aggregate = withPivot;
        else removed.push("/plan/aggregate/pivot");
      }
      repairCondition("having");
    }
  } else if (plan.having !== undefined) {
    removed.push("/plan/having");
  }
  if (plan.sort) {
    const sort: SortKey[] = [];
    plan.sort.forEach((key, index) => {
      if (valid({ ...next, sort: [...sort, key] })) sort.push(key);
      else removed.push(`/plan/sort/${index}`);
    });
    if (sort.length > 0) next.sort = sort;
  }
  const repaired: GridDocument = { ...document, plan: next };
  if (document.columns) {
    const view = new Map(checkPlan(next, table, options).columns.map((column) => [column.name, column]));
    repaired.columns = document.columns.map((setting, index) => {
      const column = view.get(setting.name);
      if (!setting.total || !column || measureTakes(setting.total.fn, column)) return setting;
      removed.push(`/columns/${index}/total`);
      const { total: _total, ...rest } = setting;
      return rest;
    });
  }
  return { document: repaired, removed };
}
