/** The commands of editing (docs/spec.md §6.5): the editor, the writes of cells, and undo and redo. */
import { parseHtmlTable, parseTsv } from "../clipboard.js";
import { editText, readCellText } from "../input.js";
import type { HistoryUpdate } from "../state.js";
import { isBlank, sameType, textOf } from "../values.js";
import { type CommandRequest, choice, fail, optionalString, stringArgument, takes } from "./command.js";
import { type Handlers, type Run, span, type Target } from "./run.js";
import { DIRECTIONS } from "./selection.js";

/** Cells that one command writes at most (§7.2). */
export const WRITE_LIMIT = 100_000;

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

export const EDITING_HANDLERS = {
  "edit.begin"(run, command) {
    takes(command, ["text"]);
    const given = optionalString(command, "text");
    const grid = run.grid();
    if (grid.columns.length === 0 || run.rowCount === 0) return;
    const cell = { row: grid.active.row, column: grid.columns[grid.active.col] };
    run.writable([cell.column]);
    run.need([{ cells: [cell], keyed: true }]);
    const value = run.valueAt(cell);
    const text = given ?? editText(value, run.typeOf(cell.column), { timeZone: run.timeZoneOf(cell.column) });
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
    const read = readCellText(editor.text, run.typeOf(editor.column), { timeZone: run.timeZoneOf(editor.column) });
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
      const read = readCellText(cell.text, run.typeOf(cell.column), {
        grouping: true,
        timeZone: run.timeZoneOf(cell.column),
      });
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
} satisfies Handlers;
