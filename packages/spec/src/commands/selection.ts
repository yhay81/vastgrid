/** The commands of the selection, scrolling and checked rows (docs/v2-spec.md §6.4). */
import { canonicalJson } from "../hash.js";
import type { Plan } from "../plan.js";
import { type Checked, checkRowKey, partsOf, sameKey } from "../state.js";
import {
  booleanArgument,
  type Command,
  checked,
  choice,
  fail,
  optionalString,
  positionArgument,
  stringArgument,
  takes,
} from "./command.js";
import { isSearch } from "./plan.js";
import { cellRect, type Handlers, kindOf, type Run, rectFor } from "./run.js";

export const DIRECTIONS = ["up", "down", "left", "right"] as const;

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

export const SELECTION_HANDLERS = {
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
} satisfies Handlers;
