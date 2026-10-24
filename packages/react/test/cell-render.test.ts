import assert from "node:assert/strict";
import { test } from "node:test";
import { ArraySource, type CellValue, type ColumnFormat, type TableSource } from "vastgrid-core";
import type { DrawCellArgs } from "../src/cell-render.ts";
import { GridController } from "../src/controller.ts";
import { CanvasRenderer } from "../src/renderer.ts";
import type { GridTheme } from "../src/theme.ts";

const options = {
  rowHeight: 24,
  headerHeight: 32,
  nullText: "",
  frozenColumns: 0,
  minColumnWidth: 36,
  maxAutoWidth: 360,
  copyLimit: 1_000_000,
};

// The renderer draws in animation frames; the tests call `draw()` themselves.
const globals = globalThis as Record<string, unknown>;
globals.window ??= { devicePixelRatio: 1 };
globals.requestAnimationFrame ??= () => 1;
globals.cancelAnimationFrame ??= () => undefined;

const theme = Object.fromEntries(
  [
    "background",
    "text",
    "muted",
    "headerBackground",
    "headerText",
    "headerActive",
    "gutterBackground",
    "gutterText",
    "gutterViewText",
    "line",
    "lineStrong",
    "selection",
    "selectionBorder",
    "activeBorder",
    "accent",
    "nullText",
    "placeholder",
    "match",
    "error",
    "link",
  ].map((key) => [key, `theme-${key}`]),
) as Record<string, unknown> as GridTheme;
Object.assign(theme, { font: "13px sans", headerFont: "600 13px sans", smallFont: "11px sans", fontSize: 13 });

interface Call {
  name: string;
  args: unknown[];
  fillStyle: unknown;
}

/** A canvas whose 2D context records the drawing calls. Text is 7 pixels per character wide. */
function fakeCanvas() {
  const calls: Call[] = [];
  const state: Record<string | symbol, unknown> = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
  };
  const context = new Proxy(state, {
    get(target, key) {
      if (key === "measureText") return (text: string) => ({ width: text.length * 7 });
      if (key in target) return target[key];
      return (...args: unknown[]) => calls.push({ name: String(key), args, fillStyle: target.fillStyle });
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls };
}

/** 1,000 rows of 40 columns: `c0` holds the row number, the others text. */
function wideSource() {
  const columns = Array.from({ length: 40 }, (_, index) => `c${index}`);
  const rows = Array.from({ length: 1000 }, (_, row) =>
    columns.map((_, col): CellValue => (col === 0 ? row - 2 : `r${row}c${col}`)),
  );
  return new ArraySource({ columns, rows });
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out");
}

/** A grid of 400 × 152 pixels (5 rows) drawn on a fake canvas, with its visible rows loaded. */
async function drawnGrid(source: TableSource, extra: Partial<GridController["options"]> = {}) {
  const grid = new GridController(source, { ...options, ...extra });
  const { canvas, calls } = fakeCanvas();
  const renderer = new CanvasRenderer(canvas, grid, theme);
  grid.setViewport(400, 152);
  grid.start();
  await until(() => grid.info?.status === "ready");
  renderer.draw();
  await until(
    () => grid.cache.value(4, 0) !== undefined && grid.cache.value(4, grid.visibleScrollColumns()[1]) !== undefined,
  );
  calls.length = 0;
  return { grid, renderer, calls };
}

test("drawCell runs for the visible loaded cells only, with their rectangle, value and state", async () => {
  const seen: DrawCellArgs[] = [];
  const { grid, renderer } = await drawnGrid(wideSource(), {
    drawCell: (args) => {
      seen.push({ ...args });
    },
  });
  grid.selection.select({ row: 1, col: 1 });
  renderer.draw();
  const [firstRow, lastRow] = grid.visibleRows();
  const [firstCol, lastCol] = grid.visibleScrollColumns();
  assert.deepEqual([firstRow, lastRow, firstCol], [0, 5, 0]);
  assert.ok(lastCol < 10, "only a few of the 40 columns are visible");
  assert.equal(seen.length, (lastRow - firstRow) * (lastCol - firstCol + 1));
  assert.ok(seen.every((cell) => cell.row < lastRow && cell.col <= lastCol));
  const cell = seen.find((args) => args.row === 1 && args.col === 1);
  assert.ok(cell);
  assert.equal(cell.value, "r1c1");
  assert.equal(cell.text, "r1c1");
  assert.equal(cell.type, "string");
  assert.equal(cell.schema.name, "c1");
  assert.equal(cell.column, 1);
  assert.equal(cell.rowId, 1);
  assert.deepEqual(cell.rect, { x: grid.columnX(1), y: 32 + 24, width: grid.layout.width(1), height: 24 });
  assert.equal(cell.selected, true);
  assert.equal(cell.active, true);
  assert.equal(cell.hovered, false);
  assert.equal(cell.theme, theme);
  assert.equal(seen.find((args) => args.row === 2 && args.col === 1)?.selected, false);
  const number = seen.find((args) => args.row === 0 && args.col === 0);
  assert.equal(number?.value, -2);
  assert.equal(number?.align, "right");
  grid.dispose();
});

test("drawCell replaces the standard drawing, which drawDefault draws with changes", async () => {
  const { grid, renderer, calls } = await drawnGrid(wideSource(), {
    drawCell: (args) => {
      if (args.col === 1) args.drawDefault({ text: `<${args.text}>`, color: "purple" });
      else if (args.col === 2) args.ctx.fillRect(args.rect.x, args.rect.y, 4, 4);
      else args.drawDefault();
    },
  });
  renderer.draw();
  const texts = calls.filter((call) => call.name === "fillText").map((call) => [call.args[0], call.fillStyle]);
  assert.ok(texts.some(([text, color]) => text === "<r0c1>" && color === "purple"));
  assert.ok(texts.some(([text, color]) => text === "r0c3" && color === "theme-text"));
  assert.ok(!texts.some(([text]) => text === "r0c2"), "the hook drew column 2 itself");
  // The canvas state is restored after each hook.
  const saves = calls.filter((call) => call.name === "save").length;
  assert.equal(saves, calls.filter((call) => call.name === "restore").length);
  grid.dispose();
});

test("a column's style colors the text and the background, once per loaded cell", async () => {
  let styled = 0;
  const formats: Record<string, ColumnFormat> = {
    c0: {
      style: (value) => {
        styled++;
        return typeof value === "number" && value < 0 ? { color: "red", background: "pink" } : null;
      },
    },
  };
  const { grid, renderer, calls } = await drawnGrid(wideSource(), { columnFormats: formats });
  renderer.draw();
  const backgrounds = calls.filter((call) => call.name === "fillRect" && call.fillStyle === "pink");
  assert.equal(backgrounds.length, 2, "rows 0 and 1 hold -2 and -1");
  const red = calls.filter((call) => call.name === "fillText" && call.fillStyle === "red").map((call) => call.args[0]);
  assert.deepEqual(red, ["-2", "-1"]);
  assert.ok(calls.some((call) => call.name === "fillText" && call.args[0] === "0" && call.fillStyle === "theme-text"));
  // The styles are kept with the rows, like their text.
  const counted = styled;
  renderer.draw();
  assert.equal(styled, counted);
  assert.equal(grid.cellStyleAt(0, 0)?.color, "red");
  assert.equal(grid.cellStyleAt(3, 0), null);
  // A new style function draws the column again.
  const version = grid.formatVersion;
  grid.setColumnFormats({ c0: { style: () => ({ color: "blue" }) } });
  assert.ok(grid.formatVersion > version);
  calls.length = 0;
  renderer.draw();
  assert.ok(calls.some((call) => call.name === "fillText" && call.args[0] === "-2" && call.fillStyle === "blue"));
  grid.dispose();
});

test("cellAction makes links: drawn in the link color and underlined, with their content for the events", async () => {
  const { grid, renderer, calls } = await drawnGrid(wideSource(), {
    cellAction: (cell) =>
      cell.column === 1 ? { kind: "link", label: `Open ${cell.text}` } : cell.column === 2 ? { kind: "button" } : null,
  });
  renderer.draw();
  const link = calls.findIndex((call) => call.name === "fillText" && call.args[0] === "r0c1");
  assert.ok(link >= 0);
  assert.equal(calls[link].fillStyle, "theme-link");
  const underline = calls[link + 1];
  assert.equal(underline.name, "fillRect");
  assert.equal(underline.args[2], "r0c1".length * 7);
  const button = calls.findIndex((call) => call.name === "fillText" && call.args[0] === "r0c2");
  assert.equal(calls[button].fillStyle, "theme-text");
  assert.notEqual(calls[button + 1]?.name, "fillRect");
  assert.deepEqual(grid.cellActionAt(0, 1), { kind: "link", label: "Open r0c1" });
  assert.deepEqual(grid.cellActionAt(0, 2), { kind: "button" });
  assert.equal(grid.cellActionAt(0, 3), null);
  // Cells that are not loaded have no content and no action.
  assert.equal(grid.cellContent(900, 1), null);
  assert.equal(grid.cellActionAt(900, 1), null);
  assert.deepEqual(grid.cellContent(0, 1), {
    row: 0,
    rowId: 0,
    col: 1,
    column: 1,
    value: "r0c1",
    schema: grid.schema[1],
    type: "string",
    text: "r0c1",
  });
  grid.dispose();
});

test("without hooks, cells are drawn as before", async () => {
  const { grid, renderer, calls } = await drawnGrid(wideSource());
  renderer.draw();
  const texts = calls.filter((call) => call.name === "fillText" && call.fillStyle === "theme-text");
  assert.ok(texts.some((call) => call.args[0] === "r4c1"));
  assert.equal(calls.filter((call) => call.fillStyle === "theme-link").length, 0);
  assert.deepEqual(renderer.timings().frames > 0, true);
  grid.dispose();
});
