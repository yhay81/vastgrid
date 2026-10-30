/**
 * The requests of the memory engine that read a view (docs/spec.md §8.2): `rows`, `summarize`, `find`, `export` and
 * `locate`. Every one but `rows` reads a table that has loaded (§9).
 */
import {
  checkPlan,
  encodeBlock,
  type JsonValue,
  MESSAGE_LIMITS,
  normalizePlan,
  type RowKey,
  textOf,
} from "vastgrid-spec";
import { EXPORT_FORMATS, PLAN_OPTIONS } from "./capabilities.js";
import { cellsOf, loadFailed, ranksOf, readColumns, type Table, valuesOf } from "./open-table.js";
import { type ColumnRanks, rankColumn } from "./order.js";
import { Failure, type Json, pause, type Running } from "./running.js";
import { Summary } from "./summary.js";
import { shown, TableProblem, vectorOf } from "./table.js";
import { columnsOf, firstsOf, positionOf, viewOf } from "./view.js";

/**
 * The string cut to `limit` code points, or null when it has no more than that (§8.4). A string of no more
 * UTF-16 units than the limit has no more code points either.
 */
function cut(text: string, limit: number): string | null {
  if (text.length <= limit) return null;
  let units = 0;
  for (let points = 0; points < limit && units < text.length; points++) {
    units += (text.codePointAt(units) as number) > 0xffff ? 2 : 1;
  }
  return units < text.length ? text.slice(0, units) : null;
}

/** `[start, end)` spans within `[0, count)`, sorted, with those that overlap or touch merged. */
function mergeRanges(ranges: readonly (readonly [number, number])[], count: number): [number, number][] {
  const spans = ranges
    .map(([start, end]): [number, number] => [Math.min(start, count), Math.min(end, count)])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

export async function rows(table: Table, request: Json, running: Running) {
  if (table.error) throw table.error;
  // A table that is loading answers the plan `{}` for the rows read so far, and other plans once it has loaded (§9).
  const loading = table.status === "loading";
  const revision = table.revision;
  if (loading && Object.keys(normalizePlan(checkPlan(request.plan, table.columns, PLAN_OPTIONS).plan)).length > 0) {
    throw new Failure("not_ready", "The table is still loading: until it has, only its rows are read (§9).");
  }
  const view = await viewOf(table, request.plan, running);
  const names = request.columns as string[];
  const sources = columnsOf(table, view, names);
  const start = request.start as number;
  const end = Math.max(start, Math.min(request.end as number, view.rowCount));
  const limit = (request.textLimit as number | undefined) ?? MESSAGE_LIMITS.textLimitDefault;
  const columns = sources.map((source) => source.column);
  const rowIds: number[] = [];
  for (let position = start; position < end; position++) rowIds.push(view.order ? view.order[position] : position);
  if (table.reader) {
    try {
      await table.reader.prepare(
        sources.flatMap((source) => (source.values ? [] : [source.index])),
        rowIds,
        () => pause(running),
      );
    } catch (error) {
      if (error instanceof TableProblem) loadFailed(table, error);
      throw error;
    }
  }
  // The values read are checked, of the table's columns not checked whole (§2.2).
  const cells = await Promise.all(
    sources.map((source) => (source.values ? null : cellsOf(table, source.index, rowIds))),
  );
  const values: JsonValue[][] = [];
  // By name in a Map: a column may be named "__proto__".
  const truncated = new Map<string, number[]>();
  for (let offset = 0; offset < rowIds.length; offset++) {
    const row = rowIds[offset];
    values.push(
      sources.map(({ values }, at) => {
        const value = values ? values.at(row) : (cells[at] as JsonValue[])[offset];
        if (typeof value !== "string" || columns[at].type !== "string") return value;
        const shorter = cut(value, limit);
        if (shorter === null) return value;
        const offsets = truncated.get(names[at]);
        if (!offsets) truncated.set(names[at], [offset]);
        else if (offsets[offsets.length - 1] !== offset) offsets.push(offset);
        return shorter;
      }),
    );
  }
  // The rows of a table that loaded meanwhile are those read, unless their columns changed.
  if (table.revision !== revision) {
    throw new Failure("revision_changed", `The table's revision is ${table.revision}; read info again.`);
  }
  return {
    view: {
      hash: view.hash,
      status: loading ? "building" : "ready",
      rowCount: view.rowCount,
      rowCountExact: !loading,
      readableRows: view.rowCount,
      columns: view.columns.map((column) => ({ ...column })),
      edits: { ...table.edits },
    },
    start,
    end,
    rowIds: view.grouped ? null : rowIds,
    block: { bytes: encodeBlock(columns, values) },
    ...(truncated.size > 0 ? { truncated: Object.fromEntries(truncated) } : {}),
  };
}

export async function summarize(table: Table, request: Json, running: Running) {
  const view = await viewOf(table, request.plan, running);
  // The cells of ranges × columns: each cell once, however the ranges overlap or a column repeats.
  const sources = new Map(columnsOf(table, view, request.columns as string[]).map((item) => [item.name, item]));
  const spans = mergeRanges(request.ranges as [number, number][], view.rowCount);
  const rows = new Uint32Array(spans.reduce((total, [start, end]) => total + end - start, 0));
  let at = 0;
  for (const [start, end] of spans) {
    for (let position = start; position < end; position++) rows[at++] = view.order ? view.order[position] : position;
  }
  await readColumns(
    table,
    [...sources.values()].filter((source) => !source.values).map((source) => source.index),
    running,
  );
  const summary = new Summary();
  for (const { column, index, values } of sources.values()) {
    summary.add(column, values ?? valuesOf(table, index), rows);
  }
  return summary.result();
}

/**
 * The next cell of the view whose text form contains `text` (§8.2): row by row, in a row in the order of
 * `columns`, from the cell after `from` (before it, with −1), wrapping around and ending with `from` itself.
 */
export async function find(table: Table, request: Json, running: Running) {
  const view = await viewOf(table, request.plan, running);
  const sources = columnsOf(table, view, request.columns as string[]);
  const text = request.text as string;
  if (text === "" || view.rowCount === 0 || sources.length === 0) return null;
  const sensitive = request.caseSensitive === true;
  const { mapCase } = await import("./evaluate.js");
  const needle = sensitive ? text : mapCase(text, false);
  await readColumns(
    table,
    sources.filter((source) => !source.values).map((source) => source.index),
    running,
  );
  const values = sources.map((source) => source.values ?? valuesOf(table, source.index));
  const matches = (position: number, at: number) => {
    const value = values[at].at(view.order ? view.order[position] : position);
    if (value === null) return false;
    const column = sources[at].column;
    const form = column.type === "string" ? (value as string) : (textOf(value, column) as string);
    return (sensitive ? form : mapCase(form, false)).includes(needle);
  };
  const count = view.rowCount;
  const width = sources.length;
  const forward = request.direction === 1;
  const from = request.from as { row: number; column: number };
  const row = Math.min(from.row, count - 1);
  const column = Math.min(from.column, width);
  // The cells of the row of `from` after it (before it, with −1).
  if (forward) {
    for (let at = column + 1; at < width; at++) if (matches(row, at)) return { row, column: at };
  } else {
    for (let at = column - 1; at >= 0; at--) if (matches(row, at)) return { row, column: at };
  }
  // Then the other rows, in order, wrapping around at the end.
  for (let step = 1; step < count; step++) {
    if (step % 1_024 === 0) await pause(running);
    const position = forward ? (row + step) % count : (row - step + count) % count;
    if (forward) {
      for (let at = 0; at < width; at++) if (matches(position, at)) return { row: position, column: at };
    } else {
      for (let at = width - 1; at >= 0; at--) if (matches(position, at)) return { row: position, column: at };
    }
  }
  // Last, the cells of the row of `from` up to `from` itself.
  if (forward) {
    for (let at = 0; at <= Math.min(column, width - 1); at++) if (matches(row, at)) return { row, column: at };
  } else {
    for (let at = width - 1; at >= column; at--) if (matches(row, at)) return { row, column: at };
  }
  return null;
}

/**
 * The view's rows as a file (§8.2), answered as its bytes (`delivery` `data`): CSV, TSV and JSON as the DuckDB
 * engine writes them, and xlsx. The engine has no files, so a `target` is not allowed.
 */
export async function exportRows(table: Table, request: Json, running: Running) {
  const format = request.format as string;
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Failure("invalid_request", `This engine does not export ${format} (§4.10).`, {
      path: "/format",
      reason: "syntax",
    });
  }
  if (request.target !== undefined) {
    throw new Failure("not_allowed", "This engine answers exports as data and writes no files: leave out target.");
  }
  const view = await viewOf(table, request.plan, running);
  const names = (request.columns as string[] | undefined) ?? view.columns.map((column) => column.name);
  const sources = columnsOf(table, view, names);
  await readColumns(
    table,
    sources.filter((source) => !source.values).map((source) => source.index),
    running,
  );
  const values = sources.map((source) => source.values ?? valuesOf(table, source.index));
  const { writeExport } = await import("./export.js");
  const bytes = await writeExport({
    format: format as "csv" | "tsv" | "json" | "xlsx",
    columns: sources.map((source) => source.column),
    headers: (request.headers as string[] | undefined) ?? names,
    numberFormats: (request.numberFormats as (string | null)[] | undefined) ?? null,
    rowCount: view.rowCount,
    row: (position) => {
      const row = view.order ? view.order[position] : position;
      return values.map((vector) => vector.at(row));
    },
    pause: () => pause(running),
  });
  return { target: null, rows: view.rowCount, data: { bytes } };
}

export async function locate(table: Table, request: Json, running: Running) {
  const view = await viewOf(table, request.plan, running);
  const keys = request.keys as RowKey[];
  let column: number | undefined;
  if (request.rowKey !== undefined) {
    column = table.index.get(request.rowKey as string);
    if (column === undefined) {
      throw new Failure("invalid_request", `The table has no column ${shown(request.rowKey)}.`, {
        path: "/rowKey",
        reason: "syntax",
      });
    }
  } else if (keys.some((key) => "value" in key)) {
    throw new Failure("invalid_request", "Keys by value need rowKey, the column of their values (§5.3).", {
      path: "/rowKey",
      reason: "syntax",
    });
  }
  const name = request.rowKey as string;
  // In a view of groups, values are looked up among the groups' keys; groups have no row IDs.
  const group = view.grouped ? view.derived.get(name) : undefined;
  if (column !== undefined && !group && keys.some((key) => "value" in key)) {
    await readColumns(table, [column], running);
  }
  let ranks: ColumnRanks | undefined;
  return {
    rows: keys.map((key) => {
      if ("rowId" in key) return view.grouped ? null : positionOf(view, key.rowId);
      if (view.grouped && !group) return null;
      // The first position in the view of a row whose value equals the key's (§3.1).
      ranks ??= group ? rankColumn(group.column, vectorOf(group.values)) : ranksOf(table, column as number);
      const rank = ranks.rankOf(key.value);
      if (rank < 0) return null;
      const first = firstsOf(view, name, ranks)[rank];
      return first < 0 ? null : first;
    }),
  };
}
