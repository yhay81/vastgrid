/**
 * One command being applied (docs/v2-spec.md §6.1): the document and the session it changes, the selection in
 * display positions, and the rows that the core has read.
 */
import { checkPlan, planOptions } from "../check.js";
import { type Expr, type Plan, PlanError, type SortKey } from "../plan.js";
import {
  type ActiveCell,
  type CellRange,
  type CellRef,
  type Checked,
  type ColumnSetting,
  displayedColumns,
  type GridDocument,
  type GridSession,
  type GridState,
  joinParts,
  partsOf,
  type RowKey,
  SELECTION_RANGES,
} from "../state.js";
import type { Column, JsonValue, ValueType } from "../types.js";
import { sameCellValue } from "../values.js";
import {
  type Command,
  type CommandContext,
  type CommandName,
  type CommandRequest,
  fail,
  type LoadedRow,
  type LoadedRows,
  stringArgument,
} from "./command.js";

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
export interface Grid {
  columns: string[];
  index: Map<string, number>;
  active: Point;
  anchor: Point;
  focus: Point;
  ranges: Rect[];
}

/** A cell that a command reads or writes. */
export interface Target {
  row: number;
  column: string;
}

export function cellRect(point: Point): Rect {
  return { rows: [point.row, point.row + 1], cols: [point.col] };
}

export function span(a: number, b: number): number[] {
  const [low, high] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

/** What the last range selects as a whole, which extending it keeps. */
export function kindOf(rect: Rect): Kind {
  if (rect.rows === "all") return rect.cols === "all" ? "all" : "columns";
  return rect.cols === "all" ? "rows" : "cells";
}

export function rectFor(anchor: Point, focus: Point, kind: Kind): Rect {
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

/**
 * One command being applied. The document and the session start as shallow copies of the state's; a command
 * replaces their members, or copies a member with `own` before it changes it, so that what it does not change
 * stays the state's own and costs nothing to keep (an undo history of a million updates is not copied for a
 * move of the active cell).
 */
export class Run {
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

/** Applies a command of one name to the run: checks its arguments and changes what the run gives. */
export type Handler = (run: Run, command: Command) => void;

/** The handlers of the commands of a section of §6, by name. */
export type Handlers = Partial<Record<CommandName, Handler>>;
