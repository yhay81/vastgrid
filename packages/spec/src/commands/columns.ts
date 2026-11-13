/** The commands of columns (docs/spec.md §6.3): their widths, order, visibility, pins, formats and totals. */
import { type ColumnSetting, checkColumnFormat, checkTotal, measureTakes } from "../state.js";
import type { Column } from "../types.js";
import { checked, choice, fail, namesArgument, stringArgument, takes } from "./command.js";
import type { Handlers } from "./run.js";

/** Inserts columns at a place of the ordered settings: before a displayed column, or at the end. */
function insertBefore(list: ColumnSetting[], moving: ColumnSetting[], before: ColumnSetting | undefined) {
  const at = before ? list.indexOf(before) : list.length;
  list.splice(at, 0, ...moving);
}

export const COLUMN_HANDLERS = {
  "column.resize"(run, command) {
    takes(command, ["name", "width"]);
    const rawName = stringArgument(command, "name");
    const width = command.width;
    if (width !== null && (typeof width !== "number" || !(width >= 1 && width <= 100_000))) {
      fail("/width", "syntax", "width is from 1 to 100,000 pixels, or null.");
    }
    const name = run.viewName(command, "name", "/name", rawName);
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    if (width === null) delete setting.width;
    else setting.width = width;
    run.setColumns(settings);
  },

  "column.move"(run, command) {
    takes(command, ["names", "before"]);
    const names = namesArgument(command, "names");
    const nameSet = new Set(names);
    if (nameSet.size !== names.length) fail("/names", "syntax", "names lists each column once.");
    const rawBefore = command.before === null ? null : stringArgument(command, "before");
    if (rawBefore !== null && nameSet.has(rawBefore)) {
      fail("/before", "syntax", "before is not one of the moved columns.");
    }
    names.forEach((name, index) => {
      run.displayedName(command, "names", `/names/${index}`, name);
    });
    const before = rawBefore === null ? null : run.displayedName(command, "before", "/before", rawBefore);
    const { columns: displayed, index: displayIndex } = run.displayedIndex();
    const displayedSet = new Set(displayed);
    const settings = run.settings();
    const moving = settings
      .filter((setting) => nameSet.has(setting.name))
      .sort((a, b) => (displayIndex.get(a.name) ?? 0) - (displayIndex.get(b.name) ?? 0));
    const rest = settings.filter((setting) => !nameSet.has(setting.name));
    const target = before === null ? undefined : rest.find((setting) => setting.name === before);
    const pin = target?.pin;
    for (const setting of moving) {
      if (pin) setting.pin = pin;
      else delete setting.pin;
    }
    const at =
      target ?? rest.find((setting) => setting.pin === "right" && displayedSet.has(setting.name) && !setting.hidden);
    insertBefore(rest, moving, at);
    run.setColumns(rest);
  },

  "column.hide"(run, command) {
    takes(command, ["names"]);
    const names = namesArgument(command, "names");
    names.forEach((name, index) => {
      run.viewName(command, "names", `/names/${index}`, name);
    });
    const nameSet = new Set(names);
    const settings = run.settings();
    for (const setting of settings) {
      if (!nameSet.has(setting.name)) continue;
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
    if (command.all !== undefined && command.all !== true) fail("/all", "syntax", "all is true.");
    const all = command.all === true;
    if (all === (command.names !== undefined)) fail("", "syntax", "column.show takes names, or all: true.");
    const names = all ? run.context.view.columns.map((column) => column.name) : namesArgument(command, "names");
    if (!all) {
      names.forEach((name, index) => {
        run.viewName(command, "names", `/names/${index}`, name);
      });
    }
    const nameSet = new Set(names);
    const settings = run.settings();
    for (const setting of settings) if (nameSet.has(setting.name)) delete setting.hidden;
    run.setColumns(settings);
  },

  "column.pin"(run, command) {
    takes(command, ["name", "side"]);
    const rawName = stringArgument(command, "name");
    const side = command.side === null ? null : choice(command, "side", ["left", "right"] as const);
    const name = run.displayedName(command, "name", "/name", rawName);
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
    const rawName = stringArgument(command, "name");
    if (command.format === undefined) fail("/format", "syntax", "format is a format or null.");
    const format = command.format === null ? null : checked(() => checkColumnFormat(command.format, "/format"));
    const name = run.viewName(command, "name", "/name", rawName);
    const settings = run.settings();
    const setting = settings.find((item) => item.name === name) as ColumnSetting;
    if (format === null) delete setting.format;
    else setting.format = format;
    run.setColumns(settings);
  },

  "column.total"(run, command) {
    takes(command, ["name", "total"]);
    const rawName = stringArgument(command, "name");
    if (command.total === undefined) fail("/total", "syntax", "total is { fn, p? } or null.");
    const total = command.total === null ? null : checked(() => checkTotal(command.total, "/total"));
    const name = run.viewName(command, "name", "/name", rawName);
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
} satisfies Handlers;
