/**
 * The notebook's engine, the Python package in `python/`, against the memory engine of `vastgrid-js` (docs/v2-spec.md
 * §10), as `vastgrid-duckdb` is compared with it: the generated table and plans of its tests
 * (`../../duckdb-engine/test/generated.ts`), whose views, rows, row IDs and errors must be the same; and finds,
 * summaries, locates, writes and exports of every format on them. `VASTGRID_PLANS` sets how many plans (150 by
 * default) and `VASTGRID_SEED` the seed; a difference names the plan's seed and shows the plan.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { memoryEngine } from "vastgrid-js";
import { type Column, encodeBlock, type JsonValue } from "vastgrid-spec";
import {
  answer,
  COLUMNS,
  differences,
  fieldValue,
  generateTable,
  generateValue,
  generator,
  type Json,
  jsonRows,
  jsonValue,
  NEEDLES,
  Plans,
  type Random,
  records,
  type Send,
  same,
  sender,
  tablePool,
  unzip,
} from "../../duckdb-engine/test/generated.ts";
import { Kernel, skip } from "./kernel.ts";

const PLANS = Number(process.env.VASTGRID_PLANS ?? 150);
const SEED = Number(process.env.VASTGRID_SEED ?? 2026);

type Opened = { table: string; revision: string; columns: Column[] };
type Bytes = { bytes: Uint8Array };

const table = generateTable(generator(SEED));
let kernel: Kernel;
let python: Send;
let memory: Send;
const opened: Record<string, { python: Opened; memory: Opened }> = {};

/** Opens a table in both engines. */
async function open(ref: string) {
  const ours = await python("open", { ref });
  const theirs = await memory("open", { ref });
  assert.ok(ours.result, JSON.stringify(ours.error));
  opened[ref] = { python: ours.result as Opened, memory: theirs.result as Opened };
}

/** The table and revision of a table in each engine. */
const at = (ref: string, engine: "python" | "memory") => ({
  table: opened[ref][engine].table,
  revision: opened[ref][engine].revision,
});

before(async () => {
  if (skip) return;
  kernel = new Kernel();
  const block = encodeBlock(table.columns, table.rows);
  // Tables of data are written in the notebook; "edited" is the one that the tests write.
  await kernel.add({ generated: block, edited: block });
  python = (op, members) => kernel.send(op, members);
  memory = sender(memoryEngine({ tables: { generated: table, edited: { ...table, editable: true } } }));
  await open("generated");
  await open("edited");
});

after(() => kernel?.close());

test("the generated table reads with the same columns and values in both engines", { skip }, async () => {
  const strip = ({ sourceType: _sourceType, ...column }: Column) => column;
  assert.deepEqual(opened.generated.python.columns.map(strip), COLUMNS);
  const theirs = await answer(memory, at("generated", "memory"), {});
  assert.deepEqual(differences(theirs, await answer(python, at("generated", "python"), {})), []);
});

test(`${PLANS} generated plans give the same answers in both engines (seed ${SEED})`, { skip }, async (t) => {
  const failures: string[] = [];
  const outcomes = { rows: 0, errors: 0, known: 0 };
  for (let index = 0; index < PLANS; index++) {
    const seed = SEED * 1_000 + index;
    const plan = new Plans(generator(seed), tablePool()).plan();
    const theirs = await answer(memory, at("generated", "memory"), plan);
    const problems = differences(theirs, await answer(python, at("generated", "python"), plan));
    if (theirs.error) outcomes.errors++;
    else outcomes.rows++;
    if (problems[0] === "known") outcomes.known++;
    else if (problems.length > 0) failures.push(`plan ${seed}: ${JSON.stringify(plan)}\n  ${problems.join("\n  ")}`);
  }
  t.diagnostic(
    `${outcomes.rows} plans answered with rows, ${outcomes.errors} with errors; ${outcomes.known} differ as KNOWN says`,
  );
  assert.equal(failures.length, 0, `${failures.length} plans differ:\n${failures.slice(0, 10).join("\n")}`);
  assert.ok(outcomes.rows > PLANS * 0.8, `${outcomes.rows} of ${PLANS} plans ran`);
});

/**
 * A summary's counts exactly, its least and greatest within the tolerance, and its sum and average within the error
 * that additions of floats in another order may make: the tolerance of the largest number, once for each number.
 */
function sameSummary(a: Json, b: Json): boolean {
  const float: Column = { name: "", type: "float" };
  const count = a.numericCount as number;
  const largest = Math.max(Math.abs(Number(a.min)), Math.abs(Number(a.max)));
  const near = (x: JsonValue, y: JsonValue, error: number) =>
    same(x, y, float) || Math.abs(Number(x) - Number(y)) <= error * 1e-9;
  return (
    a.count === b.count &&
    count === b.numericCount &&
    same(a.min as JsonValue, b.min as JsonValue, float) &&
    same(a.max as JsonValue, b.max as JsonValue, float) &&
    near(a.sum as JsonValue, b.sum as JsonValue, largest * count) &&
    near(a.average as JsonValue, b.average as JsonValue, largest)
  );
}

/** An export's bytes, or the error that it failed with. */
async function exported(send: Send, members: Json): Promise<Uint8Array> {
  const response = await send("export", members);
  assert.ok(response.result, JSON.stringify(response.error));
  const result = response.result as { target: null; data: Bytes };
  assert.equal(result.target, null);
  return result.data.bytes;
}

test("generated plans find, summarize, locate and export alike in both engines", { skip }, async () => {
  const ours = at("generated", "python");
  const theirs = at("generated", "memory");
  const names = new Set(COLUMNS.map((column) => column.name));
  const failures: string[] = [];
  const fail = (problem: string) => {
    if (failures.length < 8) failures.push(problem);
  };
  let compared = 0;
  for (let index = 0; index < 50 && failures.length < 5; index++) {
    const seed = SEED * 1_000 + index;
    const random = generator(seed);
    const plan = new Plans(generator(seed), tablePool()).plan();
    const view = await answer(memory, theirs, plan);
    if (view.error || differences(view, await answer(python, ours, plan)).length > 0) continue;
    compared++;
    const columns = view.columns as Column[];
    const count = view.rowCount as number;
    // The table's own columns, whose text forms are the same in both engines; derived floats may differ in their
    // last digits.
    const own = columns.filter((column) => names.has(column.name)).map((column) => column.name);
    for (let find = 0; find < 5 && own.length > 0 && count > 0; find++) {
      const members = {
        plan,
        text: random.pick(NEEDLES),
        columns: Array.from({ length: random.int(1, 4) }, () => random.pick(own)),
        from: { row: random.int(0, count - 1), column: 0 },
        direction: random.chance(0.5) ? 1 : -1,
        ...(random.chance(0.3) ? { caseSensitive: true } : {}),
      };
      const a = await memory("find", { ...theirs, ...members });
      const b = await python("find", { ...ours, ...members });
      if (JSON.stringify(a.result ?? a.error) !== JSON.stringify(b.result ?? b.error)) {
        fail(
          `plan ${seed}: find ${JSON.stringify(members)}: ${JSON.stringify([a.result ?? a.error, b.result ?? b.error])}`,
        );
      }
    }
    if (count > 0 && columns.length > 0) {
      const ranges = Array.from({ length: random.int(1, 3) }, () => {
        const start = random.int(0, count - 1);
        return [start, random.int(start + 1, count)];
      });
      const members = { plan, ranges, columns: columns.slice(0, random.int(1, columns.length)).map((c) => c.name) };
      const a = await memory("summarize", { ...theirs, ...members });
      const b = await python("summarize", { ...ours, ...members });
      if (a.error || b.error ? a.error?.code !== b.error?.code : !sameSummary(a.result as Json, b.result as Json)) {
        fail(
          `plan ${seed}: summarize ${JSON.stringify(members)}: ${JSON.stringify([a.result ?? a.error, b.result ?? b.error])}`,
        );
      }
    }
    if (view.rowIds) {
      // Row IDs, some of them not in the view, and values of the table's `id` column as keys.
      const byId = { keys: Array.from({ length: 6 }, () => ({ rowId: random.int(0, table.rows.length + 5) })) };
      const byKey = {
        keys: Array.from({ length: 6 }, () => ({ value: random.pick(table.rows)[12] })),
        rowKey: "id",
      };
      for (const members of [byId, byKey]) {
        const a = await memory("locate", { ...theirs, plan, ...members });
        const b = await python("locate", { ...ours, plan, ...members });
        if (JSON.stringify(a.result ?? a.error) !== JSON.stringify(b.result ?? b.error)) {
          fail(
            `plan ${seed}: locate ${JSON.stringify(members)}: ${JSON.stringify([a.result ?? a.error, b.result ?? b.error])}`,
          );
        }
      }
    }
    // Exports of every column of the view: CSV and TSV field by field, JSON value by value, and Parquet as the
    // memory engine reads either file.
    for (const format of ["csv", "tsv", "json"] as const) {
      const mine = await exported(python, { ...ours, plan, format });
      const other = await exported(memory, { ...theirs, plan, format });
      if (format === "json") {
        const a = jsonRows(other);
        const b = jsonRows(mine);
        assert.equal(b.length, a.length);
        a.forEach((row, line) => {
          for (const column of columns) {
            const x = jsonValue(row[column.name], column);
            const y = jsonValue(b[line][column.name], column);
            if (x !== y && !same(x, y, column))
              fail(`plan ${seed}: json row ${line}, ${column.name}: ${x}; python ${y}`);
          }
        });
        continue;
      }
      const delimiter = format === "tsv" ? "\t" : ",";
      const a = records(new TextDecoder().decode(other), delimiter);
      const b = records(new TextDecoder().decode(mine), delimiter);
      assert.equal(b.length, count + 1);
      assert.deepEqual(b[0], a[0]);
      for (let line = 1; line < a.length; line++) {
        a[line].forEach((text, field) => {
          const column = columns[field];
          const y = b[line]?.[field] ?? "";
          if (text !== y && !same(fieldValue(text, column), fieldValue(y, column), column)) {
            fail(
              `plan ${seed}: ${format} line ${line}, ${column.name}: ${JSON.stringify(text)}; python ${JSON.stringify(y)}`,
            );
          }
        });
      }
    }
    if (compared <= 8) {
      // The memory engine, which does not write Parquet, reads the file with the view's columns and rows.
      const bytes = await exported(python, { ...ours, plan, format: "parquet" });
      const send = sender(memoryEngine({ tables: { file: { parquet: new Blob([bytes as BlobPart]) } } }));
      const info = (await send("open", { ref: "file" })).result as Opened;
      const read = await answer(send, info, {});
      // A file has no pivots: the columns of a pivot are plain columns in it.
      const plain = (columns: Column[] | undefined) => columns?.map(({ pivot: _pivot, ...column }) => column);
      const expected = { ...view, columns: plain(view.columns), rowIds: null };
      for (const problem of differences(expected, { ...read, rowIds: null })) {
        fail(`plan ${seed}: parquet: ${problem}`);
      }
    }
  }
  // Workbooks of the table: the same sheet, compressed by either engine's deflate.
  const a = unzip(await exported(memory, { ...theirs, plan: {}, format: "xlsx" }));
  const b = unzip(await exported(python, { ...ours, plan: {}, format: "xlsx" }));
  assert.deepEqual([...b.keys()], [...a.keys()]);
  for (const [name, text] of a) assert.equal(b.get(name), text, name);
  // Columns, headers and number formats of a workbook.
  const chosen = { columns: ["word", "d", "day", "d"], headers: ["Word", "Amount", "Day", "Again"] };
  const formats = { numberFormats: [null, "#,##0.00", "yyyy/mm/dd", null] };
  const c = unzip(await exported(memory, { ...theirs, plan: {}, format: "xlsx", ...chosen, ...formats }));
  const d = unzip(await exported(python, { ...ours, plan: {}, format: "xlsx", ...chosen, ...formats }));
  for (const [name, text] of c) assert.equal(d.get(name), text, name);
  for (const format of ["csv", "tsv"] as const) {
    const other = await exported(memory, { ...theirs, plan: {}, format, ...chosen });
    assert.equal(
      new TextDecoder().decode(await exported(python, { ...ours, plan: {}, format, ...chosen })),
      new TextDecoder().decode(other),
    );
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(compared > 30, `${compared} plans compared`);
});

/** A value of a column that its type does not hold, which a write refuses with `invalid_value`. */
function invalid(column: Column): JsonValue {
  return column.type === "string" ? 12 : column.type === "boolean" ? "yes" : "not a value";
}

/**
 * An update of a cell: a generated value, sometimes with the cell's value as `previous`. Unless `valid`, it may also
 * fail: a value that the column does not hold, or another `previous`. Engines may report either failure of a write
 * that has several (§7.2), so a write has at most one.
 */
function update(random: Random, rows: JsonValue[][], valid: boolean): Json {
  const writable = COLUMNS.filter((column) => column.type !== "interval");
  const column = random.pick(writable);
  const index = COLUMNS.indexOf(column);
  const rowId = random.int(0, rows.length - 1);
  const kind = valid ? "valid" : random.pick(["valid", "value", "previous"]);
  const value = kind === "value" ? invalid(column) : random.chance(0.1) ? null : generateValue(column, random);
  const previous =
    kind === "previous"
      ? { previous: generateValue(column, random) }
      : random.chance(0.3)
        ? { previous: rows[rowId][index] }
        : {};
  return { key: { rowId }, column: column.name, value, ...previous };
}

test("generated writes give the same answers, edits and errors in both engines", { skip }, async () => {
  const ours = at("edited", "python");
  const theirs = at("edited", "memory");
  const random = generator(SEED + 1);
  const failures: string[] = [];
  const codes = new Map<string, number>();
  for (let round = 0; round < 60 && failures.length < 5; round++) {
    const rows = (await answer(memory, theirs, {})).rows as JsonValue[][];
    const bad = random.int(-1, 3);
    let updates = Array.from({ length: random.int(1, 4) }, (_, at) => update(random, rows, at !== bad));
    if (round % 10 === 9) updates = [{ ...updates[0], column: "span", value: "1 day" }];
    const a = await memory("write", { ...theirs, updates });
    const b = await python("write", { ...ours, updates });
    const outcome = (response: Json) => response.result ?? (response.error as { code: string }).code;
    const code = typeof outcome(a) === "string" ? (outcome(a) as string) : "written";
    codes.set(code, (codes.get(code) ?? 0) + 1);
    if (JSON.stringify(outcome(a)) !== JSON.stringify(outcome(b))) {
      failures.push(
        `round ${round}: ${JSON.stringify(updates)}: ${JSON.stringify([a.result ?? a.error, b.result ?? b.error])}`,
      );
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  for (const code of ["written", "edit_conflict", "invalid_value", "read_only"]) {
    assert.ok(codes.has(code), `some writes end as ${code}: ${JSON.stringify([...codes])}`);
  }
  // Every later request sees the written values.
  assert.deepEqual(differences(await answer(memory, theirs, {}), await answer(python, ours, {})), []);
  for (let index = 0; index < 30; index++) {
    const plan = new Plans(generator(SEED * 2_000 + index), tablePool()).plan();
    const problems = differences(await answer(memory, theirs, plan), await answer(python, ours, plan));
    if (problems.length > 0 && problems[0] !== "known")
      failures.push(`plan ${JSON.stringify(plan)}: ${problems.join("; ")}`);
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  const a = await exported(memory, { ...theirs, plan: {}, format: "csv" });
  const b = await exported(python, { ...ours, plan: {}, format: "csv" });
  assert.equal(new TextDecoder().decode(b), new TextDecoder().decode(a));
  // A write at another revision fails.
  const stale = await python("write", { ...ours, revision: "other", updates: [] });
  assert.equal((stale.error as { code: string }).code, "revision_changed");
});
