/** The commands of copying and exporting (docs/spec.md §6.6): copy, export and save. */
import { toHtmlTable, toMarkdownTable, toTsv } from "../clipboard.js";
import { excelNumberFormat } from "../excel.js";
import type { LogicalType } from "../types.js";
import { textOf } from "../values.js";
import {
  booleanArgument,
  type CommandRequest,
  choice,
  fail,
  optionalString,
  stringArgument,
  takes,
} from "./command.js";
import { type Grid, type Handlers, type Run, span } from "./run.js";

/** Cells that one copy holds at most (§6.6). */
export const COPY_LIMIT = 1_000_000;

function sameList(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
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

export const COPYING_HANDLERS = {
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
} satisfies Handlers;
