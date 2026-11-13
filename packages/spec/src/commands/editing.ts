/** The commands of editing (docs/spec.md §6.5): the editor, the writes of cells, and undo and redo. */
import { parseHtmlTable, parseTsv } from "../clipboard.js";
import { editText, readCellText } from "../input.js";
import type { Editor, HistoryUpdate } from "../state.js";
import { isBlank, sameCellValue, sameType, textOf } from "../values.js";
import { type CommandRequest, choice, fail, optionalString, stringArgument, takes } from "./command.js";
import { type Handlers, type Run, span, type Target } from "./run.js";
import { DIRECTIONS } from "./selection.js";

/** Cells that one command writes at most (§7.2). */
export const WRITE_LIMIT = 100_000;

/** The write of a step's values before (undo) or after (redo), each with the other as `previous` (§7.4). */
function historyWrite(run: Run, updates: readonly HistoryUpdate[], values: "before" | "after"): CommandRequest {
  // Older sessions can contain key-column writes addressed only by value. After a key changes, neither
  // value identifies the original row unambiguously (another row may already have that value).
  if (updates.some((update) => update.column === run.document.rowKey && "value" in update.key)) {
    fail("", "unsupported", "This history step did not keep the source row ID of the changed row key.");
  }
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

/** The editor's text read as a cell's column type (§7.3), failing with `invalid_value` at that cell. */
function readTyped(run: Run, text: string, cell: Target) {
  const read = readCellText(text, run.typeOf(cell.column), { timeZone: run.timeZoneOf(cell.column) });
  if (!read.ok) {
    fail("", "invalid_value", `The text is not a value of "${cell.column}".`, {
      row: cell.row,
      column: cell.column,
      error: read.error,
    });
  }
  return read.value;
}

/** The write of the editor's cell, by its key and with its value as `previous` (§6.5). */
function editorUpdate(run: Run, editor: Editor) {
  return {
    row: editor.row,
    key: editor.key,
    column: editor.column,
    value: readTyped(run, editor.text, editor),
    previous: editor.value,
  };
}

/**
 * The writes of the editor's text into every selected cell (§6.5.2): the editor's cell, when no range holds it,
 * then the cells of the ranges, each read as its column's type.
 */
function selectionUpdates(run: Run, editor: Editor) {
  const grid = run.grid();
  const isEditor = (cell: Target) => cell.row === editor.row && cell.column === editor.column;
  const editorCol = grid.index.get(editor.column);
  let editorInSelection = false;
  const selectedColumns = new Set<string>();
  for (const rect of grid.ranges) {
    const [start, end] = run.cellRows(rect);
    if (end <= start) continue;
    const cols = run.colsOf(rect, grid);
    if (editorCol !== undefined && editor.row >= start && editor.row < end && cols.includes(editorCol)) {
      editorInSelection = true;
    }
    for (const col of cols) selectedColumns.add(grid.columns[col]);
  }
  const columns = new Set<string>();
  if (!editorInSelection) columns.add(editor.column);
  for (const column of selectedColumns) columns.add(column);
  run.writable(columns);
  const selected = run.cellsOf(grid, grid.ranges, editorInSelection ? WRITE_LIMIT : WRITE_LIMIT - 1);
  const targets = editorInSelection ? selected : [{ row: editor.row, column: editor.column }, ...selected];
  run.need([{ cells: targets.filter((cell) => !isEditor(cell)), keyed: true }]);
  const rowKey = run.document.rowKey;
  let changesKey = false;
  let firstError: (() => never) | undefined;
  const parsed = new Map<string, ReturnType<typeof readCellText>>();
  const updates = targets.map((cell) => {
    let read = parsed.get(cell.column);
    if (!read) {
      read = readCellText(editor.text, run.typeOf(cell.column), { timeZone: run.timeZoneOf(cell.column) });
      parsed.set(cell.column, read);
    }
    const previous = isEditor(cell) ? editor.value : run.valueAt(cell);
    if (!read.ok) {
      if (cell.column === rowKey) changesKey = true;
      const err = read.error;
      firstError ??= () =>
        fail("", "invalid_value", `The text is not a value of "${cell.column}".`, {
          row: cell.row,
          column: cell.column,
          error: err,
        });
    } else if (cell.column === rowKey && !sameCellValue(read.value, previous, run.typeOf(cell.column))) {
      changesKey = true;
    }
    const key = isEditor(cell) ? editor.key : run.keyAt(cell.row);
    return { row: cell.row, key, column: cell.column, value: read.ok ? read.value : null, previous };
  });
  if (changesKey && targets.length > 1) {
    run.need([
      { cells: targets.filter((cell) => !isEditor(cell) || "value" in editor.key), keyed: false, rowId: true },
    ]);
  }
  firstError?.();
  return updates;
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
    run.session.editor = {
      row: cell.row,
      column: cell.column,
      key: run.keyAt(cell.row, cell.column === run.document.rowKey),
      text,
      value,
    };
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
    takes(command, ["move", "cells"]);
    const move = command.move === undefined || command.move === null ? null : choice(command, "move", DIRECTIONS);
    const cells = choice(command, "cells", ["editor", "selection"] as const, "editor");
    const editor = run.session.editor;
    if (!editor) fail("", "no_editor", "No cell is being edited.");
    run.writable([editor.column]);
    run.write(cells === "selection" ? selectionUpdates(run, editor) : [editorUpdate(run, editor)]);
    delete run.session.editor;
    if (move === "down" || move === "up") run.advance("row", move === "up");
    else if (move) run.advance("column", move === "left");
  },

  "edit.clear"(run, command) {
    takes(command, []);
    const grid = run.grid();
    if (grid.columns.length === 0) return;
    let firstColumn: string | undefined;
    const writableRects = grid.ranges.flatMap((rect) => {
      const [start, end] = run.cellRows(rect);
      const cols = run.colsOf(rect, grid);
      if (end <= start || cols.length === 0) return [];
      firstColumn ??= grid.columns[cols[0]];
      const writableCols = cols.filter((col) => run.writableCell(grid.columns[col]));
      return writableCols.length === 0 ? [] : [{ rows: [start, end] as [number, number], cols: writableCols }];
    });
    if (firstColumn === undefined) return;
    if (writableRects.length === 0) fail("", "read_only", "No selected cell is written.", { column: firstColumn });
    const targets = run.cellsOf(grid, writableRects, WRITE_LIMIT);
    run.need([{ cells: targets, keyed: true }]);
    run.write(
      targets.flatMap((cell) => {
        const value = run.valueAt(cell);
        if (isBlank(value, run.typeOf(cell.column))) return [];
        return [{ row: cell.row, key: run.keyAt(cell.row), column: cell.column, value: null, previous: value }];
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
      const repeat = grid.ranges.length > 1 || (rows > 0 && rows % height === 0 && cols.length % width === 0);
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
    const stride = BigInt(grid.columns.length);
    const targets: (Target & { text: string })[] = [];
    const seen = areas.length > 1 ? new Set<bigint>() : null;
    for (const area of areas) {
      if (!seen && Math.max(0, area.end - area.top) * area.cols.length > WRITE_LIMIT) {
        fail("", "too_many_cells", "A write holds at most 100,000 cells.");
      }
      for (let row = area.top; row < area.end; row++) {
        const rowOffset = seen ? BigInt(row) * stride : 0n;
        area.cols.forEach((col, index) => {
          if (seen) {
            const id = rowOffset + BigInt(col);
            if (seen.has(id)) return;
            seen.add(id);
          }
          if (targets.length >= WRITE_LIMIT) fail("", "too_many_cells", "A write holds at most 100,000 cells.");
          const text = values[(row - area.top) % height]?.[index % width] ?? "";
          targets.push({ row, column: grid.columns[col], text });
        });
      }
    }
    run.need([{ cells: targets, keyed: true }]);
    const rowKey = run.document.rowKey;
    let changesKey = false;
    let firstError: (() => never) | undefined;
    const updates = targets.map((cell) => {
      const type = run.typeOf(cell.column);
      const read = readCellText(cell.text, type, {
        grouping: true,
        timeZone: run.timeZoneOf(cell.column),
      });
      const previous = run.valueAt(cell);
      if (!read.ok) {
        if (cell.column === rowKey) changesKey = true;
        const err = read.error;
        firstError ??= () =>
          fail("", "invalid_value", `"${cell.text}" is not a value of "${cell.column}".`, {
            row: cell.row,
            column: cell.column,
            error: err,
          });
      } else if (cell.column === rowKey && !sameCellValue(read.value, previous, type)) {
        changesKey = true;
      }
      return {
        row: cell.row,
        key: run.keyAt(cell.row),
        column: cell.column,
        value: read.ok ? read.value : null,
        previous,
      };
    });
    if (changesKey && targets.length > 1) run.need([{ cells: targets, keyed: false, rowId: true }]);
    firstError?.();
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
        return from < 0 || first >= end ? [] : [{ from, rowStart: first, rowEnd: end, cols }];
      }
      const from = cols.length === 1 ? cols[0] - 1 : cols[0];
      const fillCols = cols.length === 1 ? cols : cols.slice(1);
      return from < 0 ? [] : [{ from, rowStart: start, rowEnd: end, cols: fillCols }];
    });
    run.writable(new Set(areas.flatMap((area) => area.cols.map((col) => grid.columns[col]))));
    const stride = BigInt(grid.columns.length);
    const targets: { target: Target; source: Target }[] = [];
    const seen = areas.length > 1 ? new Set<bigint>() : null;
    for (const area of areas) {
      if (!seen && (area.rowEnd - area.rowStart) * area.cols.length > WRITE_LIMIT) {
        fail("", "too_many_cells", "A write holds at most 100,000 cells.");
      }
      // Row by row, and in a row column by column, as every write lists its cells.
      for (let row = area.rowStart; row < area.rowEnd; row++) {
        const rowOffset = seen ? BigInt(row) * stride : 0n;
        for (const col of area.cols) {
          if (seen) {
            const id = rowOffset + BigInt(col);
            if (seen.has(id)) continue;
            seen.add(id);
          }
          if (targets.length >= WRITE_LIMIT) fail("", "too_many_cells", "A write holds at most 100,000 cells.");
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
    const rowKey = run.document.rowKey;
    let changesKey = false;
    let firstError: (() => never) | undefined;
    const updates = targets.map(({ target, source }) => {
      const value = run.valueAt(source);
      const from = run.typeOf(source.column);
      const to = run.typeOf(target.column);
      const previous = run.valueAt(target);
      let next = value;
      if (value !== null && !sameType(from, to)) {
        const read = readCellText(textOf(value, from) ?? "", to, { timeZone: run.timeZoneOf(target.column) });
        if (!read.ok) {
          if (target.column === rowKey) changesKey = true;
          const err = read.error;
          firstError ??= () =>
            fail("", "invalid_value", `A value of "${source.column}" is not a value of "${target.column}".`, {
              row: target.row,
              column: target.column,
              error: err,
            });
        } else {
          next = read.value;
          if (target.column === rowKey && !sameCellValue(next, previous, to)) changesKey = true;
        }
      } else if (target.column === rowKey && !sameCellValue(next, previous, to)) {
        changesKey = true;
      }
      return {
        row: target.row,
        key: run.keyAt(target.row),
        column: target.column,
        value: next,
        previous,
      };
    });
    if (changesKey && targets.length > 1) {
      run.need([{ cells: targets.map((item) => item.target), keyed: false, rowId: true }]);
    }
    firstError?.();
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
