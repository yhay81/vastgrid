/**
 * One file that the engine opened (docs/v2-spec.md §8.2): loading it, and the relation that its views read.
 *
 * Parquet files are read in place, by their row numbers. Delimited and JSON files and the sheets of workbooks are
 * loaded into tables of the session's database; their first rows are readable as soon as a preview of them is
 * loaded, while the rest loads (§9).
 */
import { createHash } from "node:crypto";
import { open as openFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Column } from "vastgrid-spec";
import { quoteIdentifier } from "vastgrid-sql";
import { type SourceColumn, sourceExpression, tableColumn } from "./columns.js";
import { Edits } from "./edits.js";
import { convertToUtf8, detectEncoding, type TextEncoding } from "./encoding.js";
import { EngineError, errorMessage } from "./errors.js";
import { quoteLiteral, type Session } from "./session.js";
import { convertSheet, type ReadOptions, readWorkbook, type SheetInfo, sheetList, WorkbookError } from "./xlsx.js";

export type TableFormat = "csv" | "tsv" | "parquet" | "json" | "ndjson" | "xlsx";

const EXTENSIONS: [RegExp, TableFormat][] = [
  [/\.(csv|csv\.gz|csv\.zst)$/i, "csv"],
  [/\.(tsv|tab|tsv\.gz|tsv\.zst)$/i, "tsv"],
  [/\.(parquet|pq)$/i, "parquet"],
  [/\.(jsonl|ndjson|jsonl\.gz|ndjson\.gz)$/i, "ndjson"],
  [/\.(json|json\.gz)$/i, "json"],
  [/\.(xlsx|xlsm)$/i, "xlsx"],
];

/** The format of a file judged by its name, or null when it is not a table file. */
export function tableFormatOf(file: string): TableFormat | null {
  return EXTENSIONS.find(([pattern]) => pattern.test(file))?.[1] ?? null;
}

/**
 * The table files of folders, as full paths, up to two folders deep and at most `limit`: each folder's in the order
 * of their names, without hidden files and folders.
 */
export async function findTableFiles(folders: readonly string[], limit: number): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, depth: number) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit || entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) await visit(full, depth + 1);
      else if (entry.isFile() && tableFormatOf(entry.name)) found.push(full);
    }
  };
  for (const folder of folders) await visit(folder, 0);
  return found;
}

/** Bytes at the start of a file that its revision covers. */
const REVISION_HEAD_BYTES = 64 * 1024;

/**
 * A file's revision: its size, its modification time and a hash of its first 64 KiB, so that a file rewritten with
 * the same size within the resolution of its modification time still counts as changed.
 */
export async function fileRevision(file: string): Promise<string> {
  const handle = await openFile(file, "r");
  try {
    const info = await handle.stat();
    const head = Buffer.alloc(Math.min(info.size, REVISION_HEAD_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const hash = createHash("sha1").update(head.subarray(0, bytesRead)).digest("hex").slice(0, 16);
    return `${info.size}:${Math.round(info.mtimeMs)}:${hash}`;
  } finally {
    await handle.close();
  }
}

/** What the views of a table read: a view of the session with the table's columns, and the row IDs. */
export interface Relation {
  /** The quoted name of the view, whose columns have the table's names and types (§2.1). */
  sql: string;
  /** The quoted name of its column of row IDs: the rows' positions in the file, from 0 (§1). */
  rowId: string;
  /** The rows that can be read now. */
  rows: number;
}

export interface TableOptions {
  previewRows: number;
  /** Called when the state that `TableInfo` reports changes: while loading, and once the load ends. */
  onChange: (table: LoadedTable, change: "progress" | "revision") => void;
  log?: (message: string, error?: unknown) => void;
}

/** A name for the column of row IDs that no column of the table has (DuckDB compares names without case). */
function rowIdName(columns: readonly Column[]) {
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  let name = "vg_rowid";
  while (names.has(name)) name = `${name}_`;
  return name;
}

function sameColumns(a: readonly Column[], b: readonly Column[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One file opened with some read options, shared by the handles that `open` gives (§8.2). */
export class LoadedTable {
  status: "loading" | "ready" | "error" = "loading";
  progress: number | null = null;
  error: string | undefined;
  readonly notes: string[] = [];
  sheets: SheetInfo[] | undefined;
  sheet: string | undefined;
  columns: Column[] = [];
  rowCount: number | null = null;
  relation: Relation | null = null;
  /** The table's revision: the file's, and another one when its columns changed from the preview's. */
  revision: string;
  /** Handles that `open` gave and `close` did not take back. */
  handles = 0;
  /** Whether the file changed on disk since it was read, while the table kept its written cells (§7.6). */
  fileChanged = false;
  /** Whether its handles left it for the file as it is now (§7.6): writes to it fail then. */
  replaced = false;
  lastUsed = Date.now();
  /** The cells written into the table (§7.2), which its relation reads over the file's values. */
  readonly edits: Edits;
  /** Delimited files: the encoding the file was read in. */
  encoding: TextEncoding = "utf-8";
  /** The file that DuckDB loaded: the file, or a copy of it converted to UTF-8. */
  loadedSource: string;
  /** The reader that loaded the table (`readerFunction`): 2 for delimited files read as text. */
  attempt = 0;
  /** The quoted name of the session's table that holds the loaded rows; null for a Parquet file read in place. */
  base: string | null = null;
  private readonly objects: string[] = [];
  private readonly tempFiles: string[] = [];
  private preview: string[] = [];
  private loadConnection: DuckDBConnection | null = null;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();
  private previewed: () => void = () => undefined;
  private readonly firstRows = new Promise<void>((resolve) => {
    this.previewed = resolve;
  });
  private listed: () => void = () => undefined;
  private readonly sheetsKnown = new Promise<void>((resolve) => {
    this.listed = resolve;
  });

  constructor(
    private readonly session: Session,
    readonly path: string,
    readonly format: TableFormat,
    /** The file's revision when it was opened, or saved (§7.5) (`fileRevision`). */
    public fileState: string,
    readonly byteSize: number,
    readonly read: ReadOptions,
    private readonly options: TableOptions,
  ) {
    this.revision = fileState;
    this.loadedSource = path;
    this.edits = new Edits(session, this);
  }

  /** Keeps an object of the session (`TABLE name` or `VIEW name`) to drop with the table. */
  keep(object: string) {
    this.objects.unshift(object);
  }

  start() {
    this.ready = this.load()
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.status = "error";
        this.relation = null;
        // Clients see the file's name only; converted copies of the file stand for the file itself.
        let message = errorMessage(error);
        for (const file of [...this.tempFiles, this.path]) message = message.replaceAll(file, path.basename(this.path));
        this.error = this.session.clientMessage(message);
        this.options.log?.(`Could not open ${this.path}`, error);
        this.options.onChange(this, "progress");
      })
      .finally(() => this.previewed());
  }

  /** Waits until the table has loaded, or failed to. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Waits until rows of the table can be read: those of its preview, or all of them; or until the load failed. */
  whenReadable(): Promise<void> {
    return this.firstRows;
  }

  /** Workbooks: waits until the sheets are known, or the load failed. */
  whenListed(): Promise<void> {
    return Promise.race([this.sheetsKnown, this.ready]);
  }

  /** The relation to read, or why there is none. */
  requireRelation(): Relation {
    if (this.status === "error") throw new EngineError("load_failed", this.error ?? "The file could not be read.");
    if (!this.relation) throw new EngineError("not_ready", "The first rows of the table are still loading.");
    return this.relation;
  }

  private async describe(connection: DuckDBConnection, sql: string, values: string[] = []): Promise<SourceColumn[]> {
    const reader = await connection.runAndReadAll(`DESCRIBE ${sql}`, values);
    return reader.getRowsJS().map((row) => ({ name: String(row[0]), sqlType: String(row[1]) }));
  }

  /**
   * Creates a table of the session from a reader with the columns cast to their logical types (under names of its
   * own, so that a column of the file named like DuckDB's `rowid` stays a column), and the view of it that the
   * engine reads.
   */
  private async createTable(
    connection: DuckDBConnection,
    reader: string,
    source: string,
    limit?: number,
  ): Promise<{ objects: string[]; table: string; columns: Column[]; relation: Relation }> {
    const sources = await this.describe(connection, `SELECT * FROM ${reader}`, [source]);
    const columns = sources.map(tableColumn);
    const table = this.session.createName("vg_t");
    const values = sources.map((item, index) => `${sourceExpression(item, columns[index])} AS "c${index}"`);
    const objects = [`TABLE ${quoteIdentifier(table)}`];
    await connection.run(
      `CREATE TABLE ${quoteIdentifier(table)} AS SELECT ${values.join(", ")} FROM ${reader}${limit === undefined ? "" : ` LIMIT ${limit}`}`,
      [source],
    );
    try {
      const view = this.session.createName("vg_v");
      const rowId = quoteIdentifier(rowIdName(columns));
      const named = columns.map((column, index) => `"c${index}" AS ${quoteIdentifier(column.name)}`);
      await connection.run(
        `CREATE VIEW ${quoteIdentifier(view)} AS SELECT ${[...named, `rowid AS ${rowId}`].join(", ")} FROM ${quoteIdentifier(table)}`,
      );
      objects.unshift(`VIEW ${quoteIdentifier(view)}`);
      const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(table)}`);
      return {
        objects,
        table: quoteIdentifier(table),
        columns,
        relation: { sql: quoteIdentifier(view), rowId, rows: Number(count.getRowsJS()[0][0]) },
      };
    } catch (error) {
      await this.drop(connection, objects);
      throw error;
    }
  }

  private async drop(connection: DuckDBConnection, objects: string[]) {
    for (const object of objects) {
      const [kind, ...name] = object.split(" ");
      await connection.run(`DROP ${kind} IF EXISTS ${name.join(" ")}`).catch(() => undefined);
    }
  }

  private readerFunction(attempt: number, workbook: string) {
    switch (this.format) {
      case "xlsx":
        return workbook;
      case "parquet":
        return "read_parquet($1)";
      case "json":
        return attempt === 0 ? "read_json_auto($1)" : "read_json_auto($1, sample_size=-1)";
      case "ndjson":
        return attempt === 0
          ? "read_json_auto($1, format='newline_delimited')"
          : "read_json_auto($1, format='newline_delimited', sample_size=-1)";
      default:
        return `read_csv($1${this.delimitedOptions(attempt)})`;
    }
  }

  /** The options of `read_csv` for an attempt, which `sniff_csv` also takes to tell how the file was read. */
  delimitedOptions(attempt = this.attempt): string {
    // Without null_padding, DuckDB's sniffer may settle on the last consistent part of a file whose rows have
    // different numbers of fields and silently skip the rest.
    const options = `${this.format === "tsv" ? ", delim='\\t'" : ""}, null_padding=true`;
    if (attempt === 0) return options;
    // Types sniffed from the beginning did not hold for the whole file: sniff all rows.
    if (attempt === 1) return `${options}, sample_size=-1`;
    // Irregular files: read every column as text and tolerate quotes and long lines.
    return `${options}, all_varchar=true, strict_mode=false, max_line_size=67108864`;
  }

  private async load() {
    if (this.format === "parquet" && (await this.readParquetInPlace())) return;
    let source = this.path;
    let workbook = "";
    if (this.format === "csv" || this.format === "tsv") {
      const encoding = await detectEncoding(this.path);
      this.encoding = encoding;
      if (encoding !== "utf-8") source = await this.convert(encoding);
    }
    if (this.format === "xlsx") ({ source, reader: workbook } = await this.convertWorkbook());
    if (this.disposed) return;
    await this.loadPreview(source, workbook);
    await this.session.loads.run(async () => {
      if (this.disposed) return;
      let lastError: unknown = null;
      // A converted sheet and a Parquet file have one type per column already: nothing to retry.
      const attempts =
        this.format === "csv" || this.format === "tsv" ? 3 : this.format === "json" || this.format === "ndjson" ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await this.loadTable(source, attempt, workbook);
          if (attempt === 2) this.notes.push("all_varchar");
          return;
        } catch (error) {
          if (this.disposed) return;
          lastError = error;
          this.options.log?.(`Loading ${this.path} failed (attempt ${attempt + 1})`, error);
          if (/unicode|utf-?8/i.test(errorMessage(error)) && source === this.path) {
            // The sample was valid UTF-8 but a later part is not: convert with replacement characters.
            source = await this.convert("utf-8");
            this.notes.push("invalid_utf8_replaced");
          }
        }
      }
      throw lastError;
    });
  }

  /**
   * Reads a Parquet file in place, by its row numbers. Gives false for a file with a column named like those row
   * numbers (`file_row_number`), which is loaded as a table instead.
   */
  private async readParquetInPlace(): Promise<boolean> {
    return this.session.withConnection(undefined, async (connection) => {
      const file = quoteLiteral(this.path);
      const sources = await this.describe(connection, `SELECT * FROM read_parquet(${file})`);
      if (sources.some((column) => column.name.toLowerCase() === "file_row_number")) return false;
      const columns = sources.map(tableColumn);
      const view = this.session.createName("vg_p");
      const rowId = quoteIdentifier(rowIdName(columns));
      const values = sources.map(
        (item, index) => `${sourceExpression(item, columns[index])} AS ${quoteIdentifier(item.name)}`,
      );
      await connection.run(
        `CREATE VIEW ${quoteIdentifier(view)} AS SELECT ${[...values, `file_row_number AS ${rowId}`].join(", ")} FROM read_parquet(${file}, file_row_number=true)`,
      );
      this.objects.push(`VIEW ${quoteIdentifier(view)}`);
      const count = await connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(view)}`);
      if (this.disposed) return true;
      const rows = Number(count.getRowsJS()[0][0]);
      this.columns = columns;
      this.relation = { sql: quoteIdentifier(view), rowId, rows };
      this.rowCount = rows;
      this.status = "ready";
      this.progress = 1;
      this.previewed();
      this.options.onChange(this, "progress");
      return true;
    });
  }

  private async convert(encoding: string) {
    const target = this.session.file(`${this.session.createName("convert")}.csv`);
    this.tempFiles.push(target);
    await convertToUtf8(this.path, target, encoding);
    if (encoding !== "utf-8") this.notes.push(`encoding:${encoding.startsWith("utf-16") ? "utf-16" : encoding}`);
    return target;
  }

  /** Converts the chosen sheet to a CSV file with a type per column (`xlsx.ts`), which is then loaded. */
  private async convertWorkbook(): Promise<{ source: string; reader: string }> {
    const target = this.session.file(`${this.session.createName("sheet")}.csv`);
    this.tempFiles.push(target);
    try {
      const workbook = await readWorkbook(this.path);
      this.sheets = sheetList(workbook);
      this.listed();
      const sheet = await this.session.loads.run(() =>
        convertSheet(this.path, target, {
          ...this.read,
          workbook,
          // Reading the sheet takes most of the time; DuckDB loading the converted file takes the rest.
          onProgress: (share) => {
            this.progress = share * 0.9;
            this.options.onChange(this, "progress");
          },
          cancelled: () => this.disposed,
        }),
      );
      this.sheet = sheet.sheet;
      this.notes.push(...sheet.notes);
      return { source: target, reader: sheet.reader };
    } catch (error) {
      if (error instanceof WorkbookError) throw new EngineError("load_failed", error.message);
      throw error;
    }
  }

  private async loadPreview(source: string, workbook: string) {
    try {
      await this.session.withConnection(undefined, async (connection) => {
        const preview = await this.createTable(
          connection,
          this.readerFunction(0, workbook),
          source,
          this.options.previewRows,
        );
        if (this.status !== "loading" || this.disposed) {
          await this.drop(connection, preview.objects);
          return;
        }
        this.preview = preview.objects;
        this.columns = preview.columns;
        this.relation = preview.relation;
        this.previewed();
        this.options.onChange(this, "progress");
      });
    } catch (error) {
      // The full load reports the error; the preview is only a head start.
      this.options.log?.(`The preview of ${this.path} failed`, error);
    }
  }

  private async loadTable(source: string, attempt: number, workbook: string) {
    const connection = await this.session.connect();
    this.loadConnection = connection;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await connection.run("SET enable_progress_bar = true; SET enable_progress_bar_print = false");
      timer = setInterval(() => {
        const percentage = connection.progress.percentage;
        if (percentage < 0) return;
        const progress = Math.max(this.progress ?? 0, Math.min(0.99, percentage / 100));
        if (progress === this.progress) return;
        this.progress = progress;
        this.options.onChange(this, "progress");
      }, 200);
      const loaded = await this.createTable(connection, this.readerFunction(attempt, workbook), source);
      if (this.disposed) {
        await this.drop(connection, loaded.objects);
        return;
      }
      const changed = this.relation !== null && !sameColumns(this.columns, loaded.columns);
      // The preview stays until the table is disposed: reads that began on it may still be running.
      this.objects.push(...loaded.objects);
      this.columns = loaded.columns;
      this.relation = loaded.relation;
      this.base = loaded.table;
      this.loadedSource = source;
      this.attempt = attempt;
      this.rowCount = loaded.relation.rows;
      this.status = "ready";
      this.progress = 1;
      if (changed) {
        // The rows read from the preview have other types: requests made with its revision fail (§8.3).
        this.revision = `${this.fileState}:${attempt}`;
        this.options.onChange(this, "revision");
      }
      this.options.onChange(this, "progress");
    } finally {
      if (timer) clearInterval(timer);
      this.loadConnection = null;
      connection.closeSync();
    }
  }

  /** Stops the load and deletes what the table made: its tables and views, and converted files. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadConnection?.interrupt();
    await this.ready.catch(() => undefined);
    await this.session
      .withConnection(undefined, (connection) => this.drop(connection, [...this.preview, ...this.objects]))
      .catch(() => undefined);
    for (const file of this.tempFiles) await rm(file, { force: true });
  }
}
