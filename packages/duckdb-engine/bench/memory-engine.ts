/**
 * Measures the memory engine of `vastgrid-js` (issue #43) on the files of the benches, of eight columns: opening the
 * CSV file and the Parquet file, views that sort, filter and group, `find`, `summarize`, `export`, a `write`, a
 * `cancel` of a long request, and `close`; with the memory that the engine takes against the size of the file.
 * Prints a Markdown report.
 *
 *   node --expose-gc --conditions=vastgrid-source --import tsx packages/duckdb-engine/bench/memory-engine.ts
 *     [--rows=1000000] [--max-bytes=268435456]
 *
 * The files are those of `npm run bench`, generated here when missing. They are given to the engine as files on
 * disk (`openAsBlob`), as a page gives it a `File`, so that the memory measured is the engine's: the JavaScript
 * heap and the buffers of typed arrays, after a garbage collection.
 */
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { memoryEngine } from "vastgrid-js";
import { benchDirectory, benchFiles } from "./files.ts";

declare const gc: () => void;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? ""];
  }),
);
const ROWS = Number(args.get("rows") ?? 1_000_000);
/** The tables' `maxBytes`; by default the engine's, 1 GiB. */
const MAX_BYTES = args.has("max-bytes") ? Number(args.get("max-bytes")) : undefined;
const COLUMNS = ["id", "name", "city", "price", "quantity", "sold_at", "member", "note"];
const MB = 2 ** 20;
const CANCEL_AFTER = 200;

if (typeof gc !== "function") throw new Error("Run with node --expose-gc.");

/**
 * The memory that JavaScript holds: the heap and the buffers of typed arrays, after collecting garbage. A task
 * goes first, so that what requests that just ended hold until their last continuation runs is let go, and the
 * collection is repeated after 100 ms, by when V8 has swept the buffers that the first one found unused.
 */
async function memory(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  await new Promise((resolve) => setTimeout(resolve, 100));
  gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

const megabytes = (bytes: number) => `${Math.round(bytes / MB) || 0} MB`;
const milliseconds = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0));

type Json = Record<string, unknown>;

async function measure(name: string, file: string, table: Json) {
  const size = (await stat(file)).size;
  const lines = new Map<string, string>();
  const base = await memory();
  const engine = memoryEngine({ tables: { t: table as never } });
  let id = 0;
  const send = async (op: string, members: Json) => {
    const started = performance.now();
    const response = (await engine.handle({ v: 2, id: ++id, op, ...members })) as Json;
    const ms = performance.now() - started;
    return { ms, result: response.result as Json, error: response.error as { code: string } | undefined };
  };
  // A request that fails, as one that would read more than `maxBytes` does, is shown with its error's code.
  const timed = async (what: string, op: string, members: Json) => {
    const { ms, result, error } = await send(op, { ...at, ...members });
    lines.set(what, error ? `${milliseconds(ms)} (${error.code})` : milliseconds(ms));
    return result;
  };
  const opened = await send("open", { ref: "t" });
  lines.set("open", opened.error ? `${milliseconds(opened.ms)} (${opened.error.code})` : milliseconds(opened.ms));
  const afterOpen = (await memory()) - base;
  if (opened.error)
    return { name, size, lines, afterOpen, afterViews: 0, written: 0, closed: afterOpen, exportSize: 0 };
  const at = { table: opened.result.table, revision: opened.result.revision };
  const block = { start: 0, end: 256, columns: COLUMNS };
  await timed("first 256 rows", "rows", { plan: {}, ...block });
  await timed("256 rows at the middle", "rows", { plan: {}, ...block, start: ROWS / 2, end: ROWS / 2 + 256 });
  const sort = { sort: [{ column: "price", direction: "desc" }] };
  await timed("sort by price (a float)", "rows", { plan: sort, ...block });
  await timed("the same view at the middle", "rows", { plan: sort, ...block, start: ROWS / 2, end: ROWS / 2 + 256 });
  await timed("sort by name (a string)", "rows", { plan: { sort: [{ column: "name", direction: "asc" }] }, ...block });
  const filter = {
    where: { fn: "eq", args: [{ col: "city" }, { lit: "Tokyo" }] },
    sort: [{ column: "sold_at", direction: "asc" }],
  };
  await timed("filter by city and sort by a timestamp", "rows", { plan: filter, ...block });
  const group = {
    aggregate: {
      keys: ["city"],
      measures: [
        { name: "total", fn: "sum", column: "price" },
        { name: "average", fn: "avg", column: "quantity" },
        { name: "count", fn: "count", column: "id" },
      ],
    },
    sort: [{ column: "total", direction: "desc" }],
  };
  await timed("group by city: sum, avg, count", "rows", { plan: group, start: 0, end: 8, columns: ["city", "total"] });
  await timed("summarize every column", "summarize", { plan: {}, ranges: [[0, ROWS]], columns: COLUMNS });
  await timed("find text in the last row", "find", {
    plan: {},
    text: `item-${(ROWS - 1) % 50_000}`,
    columns: ["name"],
    from: { row: 0, column: 0 },
    direction: 1,
  });
  const exportSize = await timed("export CSV of every row", "export", { plan: {}, format: "csv" }).then((result) =>
    result ? (result.data as { bytes: Uint8Array }).bytes.length : 0,
  );
  const afterViews = (await memory()) - base;
  // A cancel of a find that goes through every cell of a sorted view: the time from when the cancel is due to the
  // answer, which includes the wait of a cancel that comes while the engine runs without pauses.
  const findId = ++id;
  const findDue = performance.now() + CANCEL_AFTER;
  const finding = engine.handle({
    v: 2,
    id: findId,
    op: "find",
    ...at,
    plan: { sort: [{ column: "member", direction: "asc" }] },
    text: "not anywhere",
    columns: COLUMNS,
    from: { row: 0, column: 0 },
    direction: 1,
  }) as Promise<Json>;
  await new Promise((resolve) => setTimeout(resolve, CANCEL_AFTER));
  await engine.handle({ v: 2, id: ++id, op: "cancel", request: findId });
  const answer = await finding;
  const cancelled = (answer.error as { code?: string } | undefined)?.code;
  lines.set(
    `cancel a find ${CANCEL_AFTER} ms after it starts (from then to the answer)`,
    `${milliseconds(performance.now() - findDue)} (${cancelled ?? "answered"})`,
  );
  // A table that no ID names and that holds no written values is forgotten when it is closed.
  await send("close", { table: at.table });
  const closed = (await memory()) - base;
  // A cancel of the first view sorted by a column: a Parquet file's row groups are read with pauses between them,
  // where the sort of columns in memory runs to its end.
  const canceller = memoryEngine({ tables: { t: table as never } });
  const again = (await canceller.handle({ v: 2, id: 1, op: "open", ref: "t" })) as { result: Json };
  const sortDue = performance.now() + 50;
  const sorting = canceller.handle({
    v: 2,
    id: 2,
    op: "rows",
    table: again.result.table,
    revision: again.result.revision,
    plan: { sort: [{ column: "note", direction: "desc" }] },
    ...block,
  }) as Promise<Json>;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await canceller.handle({ v: 2, id: 3, op: "cancel", request: 2 });
  const sortAnswer = await sorting;
  lines.set(
    "cancel the first sorted view 50 ms after it starts (from then to the answer)",
    `${milliseconds(performance.now() - sortDue)} (${(sortAnswer.error as { code?: string } | undefined)?.code ?? "answered"})`,
  );
  await canceller.handle({ v: 2, id: 4, op: "close", table: again.result.table });
  // A write is kept by itself, over the column that the view has read: an engine of its own, since a table that
  // holds written values keeps them when it is closed.
  const writer = memoryEngine({ tables: { t: table as never } });
  const reopened = (await writer.handle({ v: 2, id: 1, op: "open", ref: "t" })) as { result: Json };
  const on = { table: reopened.result.table, revision: reopened.result.revision };
  const byCity = { plan: { sort: [{ column: "city", direction: "asc" }] }, ...block };
  await writer.handle({ v: 2, id: 2, op: "rows", ...on, ...byCity });
  const beforeWrite = await memory();
  let ms = performance.now();
  const wrote = (await writer.handle({
    v: 2,
    id: 3,
    op: "write",
    ...on,
    updates: [{ key: { rowId: 1 }, column: "city", value: "Kyoto" }],
  })) as Json;
  if (wrote.error) throw new Error(`write: ${JSON.stringify(wrote.error)}`);
  lines.set("write a cell", milliseconds(performance.now() - ms));
  ms = performance.now();
  const sorted = (await writer.handle({ v: 2, id: 4, op: "rows", ...on, ...byCity })) as Json;
  if (sorted.error) throw new Error(`rows: ${JSON.stringify(sorted.error)}`);
  lines.set("sort by the written column", milliseconds(performance.now() - ms));
  const written = (await memory()) - beforeWrite;
  return { name, size, lines, afterOpen, afterViews, written, closed, exportSize };
}

const { csv, parquet } = await benchFiles(benchDirectory, ROWS, ROWS);
const results = [
  await measure("CSV", csv, { file: await openAsBlob(csv), format: "csv", maxBytes: MAX_BYTES, editable: true }),
  await measure("Parquet", parquet, { parquet: await openAsBlob(parquet), maxBytes: MAX_BYTES, editable: true }),
];

const report: string[] = [];
report.push(
  `# The memory engine on ${ROWS.toLocaleString("en")} rows`,
  "",
  `maxBytes: ${MAX_BYTES === undefined ? "1 GiB (the default)" : megabytes(MAX_BYTES)}.`,
  "",
);
report.push(
  `Node.js ${process.version}, ${process.platform} ${process.arch}. Times are wall-clock milliseconds of`,
  "`engine.handle`, without a worker or a page; memory is the heap and the buffers of typed arrays after a garbage",
  "collection, less what was held before the table was opened.",
  "",
);
report.push(`| Request | ${results.map((result) => result.name).join(" | ")} |`);
report.push(`| --- | ${results.map(() => "---:").join(" | ")} |`);
for (const label of new Set(results.flatMap((result) => [...result.lines.keys()]))) {
  report.push(`| ${label} | ${results.map((result) => result.lines.get(label) ?? "—").join(" | ")} |`);
}
report.push("");
report.push(`| Memory | ${results.map((result) => result.name).join(" | ")} |`);
report.push(`| --- | ${results.map(() => "---:").join(" | ")} |`);
const row = (label: string, value: (result: (typeof results)[number]) => string) =>
  report.push(`| ${label} | ${results.map(value).join(" | ")} |`);
row("file", (result) => megabytes(result.size));
row("after open", (result) => megabytes(result.afterOpen));
row("after the views, the find and the export (every column read)", (result) => megabytes(result.afterViews));
row("the write and the view sorted by it", (result) => megabytes(result.written));
row("after close", (result) => megabytes(result.closed));
row("the exported CSV", (result) => megabytes(result.exportSize));
console.log(report.join("\n"));
