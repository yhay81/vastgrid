/**
 * An engine over tables in memory (docs/spec.md §8): it answers the requests of §8.2 about tables that
 * its host gives it as arrays of typed JSON values (§2.2), as Arrow, as text files or as Parquet files, with views in
 * the order of §3.3. This module opens, reads and closes the tables and sends the events of §8.5; open-table.ts
 * holds their values, view.ts their views, reads.ts and edits.ts the requests that read and write them.
 */
import {
  answerId,
  checkPlan,
  checkRequest,
  type ErrorCode,
  errorResponse,
  type Operation,
  PlanError,
  ProtocolError,
  planHash,
  SpecError,
} from "vastgrid-spec";
import { capabilities, PLAN_OPTIONS } from "./capabilities.js";
import { write } from "./edits.js";
import { contentsOf, forgets, type Table } from "./open-table.js";
import { exportRows, find, locate, rows, summarize } from "./reads.js";
import { Failure, type Json, type Running, started } from "./running.js";
import {
  type ArrowTable,
  type CheckedTable,
  checkTable,
  type FileTable,
  isArrowTable,
  isFileTable,
  isObject,
  isParquetTable,
  isWorkbook,
  type MemoryTable,
  type ParquetTable,
  shown,
  TableProblem,
} from "./table.js";

/** A table that a host gives the engine: rows of typed JSON, Arrow, a text file or a Parquet file. */
type HostTable = MemoryTable | ArrowTable | FileTable | ParquetTable;

export interface MemoryEngineOptions {
  /**
   * The tables that `open` opens, by the `ref` that names them: rows of typed JSON, Arrow, text files or Parquet
   * files.
   */
  tables: Record<string, HostTable>;
  /**
   * A text file larger than this many bytes (default 4 MiB) opens once the rows that end in its first `previewBytes`
   * are read, with `status: "loading"`, and these are its readable rows until the whole file is (§9); `0` opens files
   * when they are read whole.
   */
  previewBytes?: number;
}

export interface MemoryEngine {
  /**
   * Answers a request (§8.1) with its response or error, with blocks in the structured encoding (§8.8);
   * `cancel` has no answer. Never throws: a message that does not follow §8 is answered with
   * `invalid_request`.
   */
  handle(message: unknown): Promise<Record<string, unknown> | undefined>;
  /**
   * Listens to the events of §8.5, until the function it gives is called: `changed` after writes, and `progress`
   * and `view` while a text file loads (§9).
   */
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
}

type Request = Json & { v: 2; id: number; op: Operation };

/** A text file being read: its first rows, null when it opens once read whole, and then all of it. */
interface TextReading {
  first: Promise<CheckedTable | null>;
  whole: Promise<CheckedTable>;
}

/** The bytes of a text file read before it opens, by default (`MemoryEngineOptions.previewBytes`). */
const PREVIEW_BYTES = 4 * 1024 * 1024;

// The revision of each table that hosts give: its data never changes, so neither does its revision.
const revisions = new WeakMap<object, string>();
let revisionCount = 0;

function revisionOf(table: HostTable): string {
  let revision = revisions.get(table);
  if (revision === undefined) {
    revision = `memory-${++revisionCount}`;
    revisions.set(table, revision);
  }
  return revision;
}

class Engine implements MemoryEngine {
  private readonly sources: Map<string, HostTable>;
  /** Tables by ref, while a table ID is open on them. */
  private readonly prepared = new Map<string, Table>();
  /** Files being read by ref, which every open of the file waits for. */
  private readonly reading = new Map<string, Promise<CheckedTable>>();
  /** Text files being read by ref: their first rows, then all of them. */
  private readonly texts = new Map<string, TextReading>();
  /** Tables by table ID. */
  private readonly tables = new Map<string, Table>();
  private readonly running = new Map<number, Running>();
  private readonly listeners = new Set<(event: Json) => void>();
  private readonly previewBytes: number;
  private nextTable = 1;

  constructor(options: MemoryEngineOptions) {
    if (!isObject(options) || !isObject(options.tables)) {
      throw new TypeError("memoryEngine takes { tables }, the tables that open opens by ref.");
    }
    const { previewBytes = PREVIEW_BYTES } = options;
    if (typeof previewBytes !== "number" || !(previewBytes >= 0)) {
      throw new TypeError("memoryEngine's previewBytes is a number of bytes.");
    }
    this.sources = new Map(Object.entries(options.tables));
    this.previewBytes = previewBytes;
  }

  subscribe(listener: (event: Json) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async handle(message: unknown): Promise<Json | undefined> {
    let request: Request;
    try {
      request = checkRequest(message);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return errorResponse(answerId(message), "invalid_request", error.message, {
          path: error.path,
          reason: error.reason,
        });
      }
      return errorResponse(answerId(message), "internal", String(error));
    }
    if (request.op === "cancel") {
      const running = this.running.get(request.request as number);
      if (running) running.cancelled = true;
      return undefined;
    }
    const running = started();
    this.running.set(request.id, running);
    try {
      return { v: 2, id: request.id, result: await this.answer(request, running) };
    } catch (error) {
      if (error instanceof Failure) return errorResponse(request.id, error.code, error.message, error.extra);
      if (error instanceof PlanError) {
        return errorResponse(request.id, "invalid_plan", error.message, { path: error.path, reason: error.reason });
      }
      if (error instanceof ProtocolError) {
        return errorResponse(request.id, "invalid_request", error.message, { path: error.path, reason: error.reason });
      }
      if (error instanceof SpecError) return errorResponse(request.id, error.code as ErrorCode, error.message);
      return errorResponse(request.id, "internal", error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running.get(request.id) === running) this.running.delete(request.id);
      for (const release of running.releases) release();
    }
  }

  private async answer(request: Request, running: Running): Promise<unknown> {
    switch (request.op) {
      case "open":
        return this.open(request.ref as string, request.read);
      case "info": {
        const id = request.table as string;
        return this.info(id, this.table(request));
      }
      case "changes":
        return { revision: this.table(request).revision, edits: { ...this.table(request).edits } };
      case "reload": {
        // Tables in memory have no file that changes (§7.6): the table is as it is.
        const id = request.table as string;
        return this.info(id, this.table(request));
      }
      case "close": {
        const table = this.table(request);
        this.tables.delete(request.table as string);
        // A table that no ID names any more forgets its ranks and views, unless it holds written values, which
        // every later request sees (§7.2); opening it again checks it again.
        if (--table.open === 0 && table.written.size === 0) {
          this.prepared.delete(table.key);
          table.reader?.close();
        }
        return null;
      }
      case "rows":
        return rows(this.table(request), request, running);
      case "summarize":
        return summarize(await this.whole(request, running), request, running);
      case "find":
        return find(await this.whole(request, running), request, running);
      case "locate":
        return locate(await this.whole(request, running), request, running);
      case "export":
        return exportRows(await this.whole(request, running), request, running);
      case "write": {
        const table = await this.whole(request, running);
        const written = await write(table, request, running);
        if (written.updated > 0) {
          for (const id of this.idsOf(table)) {
            this.emit({ v: 2, event: "changed", table: id, revision: table.revision, edits: { ...table.edits } });
          }
        }
        return written;
      }
      case "save":
        // A table in memory has no file to write back (§7.5).
        this.table(request);
        throw new Failure(
          "save_unsupported",
          "This engine keeps tables in memory and does not save them (capabilities.save is false).",
        );
      default:
        throw new Failure("invalid_request", `This engine does not offer ${request.op} (§4.10).`, {
          path: "/op",
          reason: "unknown_op",
        });
    }
  }

  private async open(ref: string, read: unknown) {
    if (!this.sources.has(ref)) throw new Failure("not_allowed", `The host does not open ${shown(ref)}.`);
    const source = this.sources.get(ref) as HostTable;
    // Arrow tables and files are read by modules of their own, loaded before the table is looked up so that two
    // opens of one table do not both make it.
    const arrow = isArrowTable(source) ? await import("./arrow.js") : null;
    const file = isFileTable(source);
    const parquet = isParquetTable(source);
    const typed = arrow || file || parquet ? await import("./numbers.js") : null;
    // A workbook is read once for each set of options of `read`; other tables ignore them.
    const workbook = file && isWorkbook(source as FileTable) ? await import("./workbook.js") : null;
    const options = workbook ? workbook.readOptionsOf(read) : null;
    const key = options ? `${ref}\u0000${JSON.stringify(options)}` : ref;
    let table = this.prepared.get(key);
    if (table?.error) throw table.error;
    const text = !table && file && !workbook ? this.readText(key, source as FileTable) : null;
    if (text) table = (await this.preview(ref, key, source as FileTable, typed, text)) ?? undefined;
    if (!table) {
      let checked: CheckedTable;
      try {
        checked = arrow
          ? arrow.checkArrow((source as ArrowTable).arrow)
          : workbook && options
            ? await this.reads(key, () => workbook.readSheet(source as FileTable, options))
            : file
              ? await (text ?? this.readText(key, source as FileTable)).whole
              : parquet
                ? await this.reads(key, async () =>
                    (await import("./parquet.js")).ParquetFile.open(source as ParquetTable).then((file) =>
                      file.checked(),
                    ),
                  )
                : checkTable(source);
      } catch (error) {
        if (!(error instanceof TableProblem)) throw error;
        const at = error.path === "" ? "" : `at ${error.path}, `;
        throw new Failure(error.code, `The table ${shown(ref)} cannot be read: ${at}${error.message}`);
      }
      // Another open of the file may have made the table while the file was read.
      table = this.prepared.get(key) ?? this.prepare(ref, key, source, checked, typed);
    }
    const id = `t${this.nextTable++}`;
    this.tables.set(id, table);
    table.open++;
    return this.info(id, table);
  }

  /**
   * Reads a table given as a file other than text, once for every open that waits for it: a sheet of a workbook
   * (workbook.ts), or the footer of a Parquet file (parquet.ts).
   */
  private reads(key: string, read: () => Promise<CheckedTable>): Promise<CheckedTable> {
    let reading = this.reading.get(key);
    if (!reading) {
      reading = read().finally(() => this.reading.delete(key));
      this.reading.set(key, reading);
    }
    return reading;
  }

  /**
   * Reads a text file (text.ts), once for every open that waits for it: its first rows when it is larger than
   * `previewBytes`, then all of it, telling the table that holds the first rows meanwhile how much has been read
   * (each byte twice, unless the columns are not kept). The first rows are read alone, so that they come at once.
   */
  private readText(key: string, source: FileTable): TextReading {
    let reading = this.texts.get(key);
    if (reading) return reading;
    const text = import("./text.js");
    const { file } = source;
    const sized = isObject(file) && typeof file.size === "number" && typeof file.slice === "function";
    const first =
      sized && this.previewBytes > 0 && file.size > this.previewBytes
        ? text.then(({ readPreview }) => readPreview(source, this.previewBytes))
        : Promise.resolve(null);
    const whole = first.then(async () => {
      const { readFile } = await text;
      if (!sized) return readFile(source);
      let read = 0;
      const counted: FileTable["file"] = {
        size: file.size,
        name: file.name,
        slice: (start = 0, end = file.size) => {
          read += Math.max(0, Math.min(end, file.size) - start);
          this.progressed(key, Math.min(0.99, read / (2 * file.size)));
          return file.slice(start, end);
        },
      };
      return readFile({ ...source, file: counted });
    });
    reading = { first, whole: whole.finally(() => this.texts.delete(key)) };
    this.texts.set(key, reading);
    return reading;
  }

  /**
   * Opens a text file larger than `previewBytes` with its first rows (§9), as a table that is loading until the file
   * is read whole; null when there are no first rows to open it with.
   */
  private async preview(
    ref: string,
    key: string,
    source: FileTable,
    typed: Table["typed"],
    reading: TextReading,
  ): Promise<Table | null> {
    const first = await reading.first;
    // Another open of the file may have made the table meanwhile.
    const made = this.prepared.get(key);
    if (made || !first) return made ?? null;
    const table = this.prepare(ref, key, source, first, typed);
    table.status = "loading";
    table.progress = 0;
    table.loaded = reading.whole.then(
      (checked) => this.loadedWhole(table, checked),
      (error) => this.failedWhole(table, error),
    );
    return table;
  }

  /** A table that is opened from its host's table, checked or read. */
  private prepare(ref: string, key: string, source: HostTable, checked: CheckedTable, typed: Table["typed"]): Table {
    const table: Table = {
      ref,
      key,
      ...contentsOf(checked),
      typed,
      revision: revisionOf(source),
      editable: source.editable === true,
      edits: { version: 0, cells: 0 },
      written: new Set(),
      open: 0,
      workbook: checked.workbook ?? null,
      status: "ready",
      progress: 1,
      error: null,
      loaded: null,
    };
    forgets(table);
    this.prepared.set(key, table);
    return table;
  }

  /** The IDs open on a table. */
  private idsOf(table: Table): string[] {
    return [...this.tables].flatMap(([id, item]) => (item === table ? [id] : []));
  }

  /** The `progress` event of a table that is loading, or has loaded or failed to (§8.5). */
  private tellProgress(table: Table) {
    for (const id of this.idsOf(table)) {
      this.emit({
        v: 2,
        event: "progress",
        table: id,
        status: table.status,
        progress: table.status === "error" ? null : table.progress,
        readableRows: table.status === "error" ? 0 : table.rowCount,
        rowCount: table.status === "ready" ? table.rowCount : null,
      });
    }
  }

  /** How much of a file the table that holds its first rows has read (`readText`). */
  private progressed(key: string, progress: number) {
    const table = this.prepared.get(key);
    // Events tell every hundredth of the file.
    if (table?.status !== "loading" || Math.floor(progress * 100) <= Math.floor(table.progress * 100)) return;
    table.progress = progress;
    this.tellProgress(table);
  }

  /**
   * The file of a table that held its first rows is read whole: the table holds all of them, with another revision
   * when their columns are not those of the first rows (§9).
   */
  private async loadedWhole(table: Table, checked: CheckedTable) {
    if (table.status !== "loading") return;
    const hash = await planHash(checkPlan({}, table.columns, PLAN_OPTIONS).plan);
    const same = JSON.stringify(checked.columns) === JSON.stringify(table.columns);
    Object.assign(table, contentsOf(checked), { status: "ready", progress: 1, loaded: null });
    forgets(table);
    if (!same) table.revision = `${table.revision}:read`;
    if (table.open === 0 && this.prepared.get(table.key) !== table) {
      table.reader?.close();
      return;
    }
    for (const id of this.idsOf(table)) {
      if (!same) this.emit({ v: 2, event: "changed", table: id, revision: table.revision, edits: { ...table.edits } });
      this.emit({
        v: 2,
        event: "view",
        table: id,
        hash,
        status: "ready",
        readableRows: table.rowCount,
        rowCount: table.rowCount,
        rowCountExact: true,
      });
    }
    this.tellProgress(table);
  }

  /** The file of a table that held its first rows cannot be read whole: requests about the table fail as its open would. */
  private failedWhole(table: Table, error: unknown) {
    if (table.status !== "loading") return;
    table.error =
      error instanceof TableProblem
        ? new Failure(
            error.code,
            `The table ${shown(table.ref)} cannot be read: ${error.path === "" ? "" : `at ${error.path}, `}${error.message}`,
          )
        : new Failure("load_failed", `The table ${shown(table.ref)} cannot be read: ${String(error)}`);
    table.status = "error";
    table.loaded = null;
    this.tellProgress(table);
  }

  /**
   * The table of a request that reads every row of it (`summarize`, `find`, `export`, `locate`) or writes: one that
   * is loading once it has loaded (§9), and a failure when its revision changed meanwhile or it could not be read.
   */
  private async whole(request: Json, running: Running): Promise<Table> {
    const table = this.table(request);
    if (table.loaded) {
      const revision = table.revision;
      await table.loaded;
      if (running.cancelled) throw new Failure("cancelled", "The request was cancelled (§8.6).");
      if (table.revision !== revision) {
        throw new Failure("revision_changed", `The table's revision is ${table.revision}; read info again.`);
      }
    }
    if (table.error) throw table.error;
    return table;
  }

  /** TableInfo (§8.2). */
  private info(id: string, table: Table) {
    const info: Json = {
      table: id,
      revision: table.revision,
      edits: { ...table.edits },
      status: table.status,
      progress: table.status === "error" ? null : table.progress,
      rowCount: table.status === "ready" ? table.rowCount : null,
      readableRows: table.status === "error" ? 0 : table.rowCount,
      columns: table.columns.map((column) => ({ ...column })),
      capabilities: capabilities(table.editable),
    };
    if (table.error) info.error = table.error.message;
    const { workbook } = table;
    if (workbook) {
      if (workbook.notes.length > 0) info.notes = [...workbook.notes];
      info.sheets = workbook.sheets.map((sheet) => ({ ...sheet }));
      info.sheet = workbook.sheet;
    }
    return info;
  }

  /** The table a request names, at the revision it names when it names one (§8.3). */
  private table(request: Json): Table {
    const table = this.tables.get(request.table as string);
    if (!table) throw new Failure("table_not_found", `There is no open table ${shown(request.table)}.`);
    if ("revision" in request && request.revision !== table.revision) {
      throw new Failure("revision_changed", `The table's revision is ${table.revision}; read info again.`);
    }
    return table;
  }

  private emit(event: Json) {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * An engine over tables in memory. The host gives the tables by the `ref` that `open` takes; the engine checks
 * the form of a table against §2 when it is first opened, and its values as it reads them (a column whole before
 * it sorts or sums it), answering `load_failed` with the JSON Pointer of a value that does not follow §2.2. It
 * reads the rows as they are, without copying them, so they must not change afterwards.
 */
export function memoryEngine(options: MemoryEngineOptions): MemoryEngine {
  return new Engine(options);
}
