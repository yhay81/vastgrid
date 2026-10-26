/**
 * Saving the written cells into the file a table was read from (docs/v2-spec.md §7.5): CSV and TSV files, of which
 * only the edited fields of the edited records are written anew (`rewriteCsv`), into a temporary file next to the
 * file that is then renamed over it.
 */
import { randomBytes } from "node:crypto";
import { chmod, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Column } from "vastgrid-spec";
import { type CsvDialect, type CsvEdits, CsvSaveError, rewriteCsv } from "./csv-save.js";
import { cancelled, EngineError } from "./errors.js";
import { quoteLiteral, type Session } from "./session.js";
import { fileRevision, type LoadedTable } from "./table.js";

/** Whether `save` writes a table's file: a CSV or TSV file that is not compressed. */
export function isSavable(table: LoadedTable): boolean {
  return (table.format === "csv" || table.format === "tsv") && !/\.(gz|zst)$/i.test(table.path);
}

function fileChanged() {
  return new EngineError("file_changed", "The file was changed by someone else since it was read.");
}

/** How DuckDB read the file's records: its delimiter, quote, escape, header, skipped lines and date formats. */
async function dialectOf(connection: DuckDBConnection, table: LoadedTable): Promise<CsvDialect> {
  const read = await connection.runAndReadAll(
    `SELECT Delimiter, Quote, Escape, Comment, SkipRows, HasHeader, DateFormat, TimestampFormat FROM sniff_csv($1${table.delimitedOptions()})`,
    [table.loadedSource],
  );
  const row = read.getRowsJS()[0];
  const text = (value: unknown) => (value === null || value === "(empty)" ? "" : String(value));
  if (text(row[3])) throw new CsvSaveError("unsupported", "Files with comment lines are not saved.");
  const quote = text(row[1]) || '"';
  return {
    delimiter: text(row[0]) || (table.format === "tsv" ? "\t" : ","),
    quote,
    escape: text(row[2]) || quote,
    skipRows: Number(row[4] ?? 0),
    header: row[5] === true,
    dateFormat: text(row[6]),
    timestampFormat: text(row[7]),
  };
}

/**
 * The SQL of the text that DuckDB reads back as a written value: in the file's date or timestamp format when it
 * has one, otherwise DuckDB's own text; and whether a format reads back what it writes (one without the year
 * does not).
 */
function textOf(column: Column, value: string, dialect: CsvDialect): { text: string; same?: string } {
  const format =
    column.type === "date" ? dialect.dateFormat : column.type === "timestamp" ? dialect.timestampFormat : "";
  if (!format) return { text: `CAST(${value} AS VARCHAR)` };
  const literal = quoteLiteral(format);
  const text = `try(strftime(${value}, ${literal}))`;
  const back =
    column.type === "date" ? `CAST(try_strptime(${text}, ${literal}) AS DATE)` : `try_strptime(${text}, ${literal})`;
  return { text, same: `(${value} IS NULL OR coalesce(${back} = ${value}, false))` };
}

/**
 * Writes the file anew with the edited fields, under a temporary name next to it, and renames it over the file
 * once it is complete and the file has not changed meanwhile. Gives the records written anew.
 */
async function replace(table: LoadedTable, dialect: CsvDialect, edits: CsvEdits, signal?: AbortSignal) {
  const temporary = path.join(
    path.dirname(table.path),
    `.${path.basename(table.path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const { records } = await rewriteCsv({
      source: table.path,
      target: temporary,
      encoding: table.encoding,
      dialect,
      columns: table.columns.length,
      rows: table.rowCount ?? 0,
      edits,
      signal,
    });
    if (signal?.aborted) throw cancelled();
    // Changed while it was written: the new file would lose that change.
    if ((await fileRevision(table.path)) !== table.fileState) throw fileChanged();
    await chmod(temporary, (await stat(table.path)).mode);
    await rename(temporary, table.path);
    table.fileState = await fileRevision(table.path);
    return records;
  } catch (error) {
    await rm(temporary, { force: true });
    if (signal?.aborted) throw cancelled();
    if (error instanceof CsvSaveError) {
      throw new EngineError(error.code === "encoding" ? "invalid_value" : "save_unsupported", error.message);
    }
    throw error;
  }
}

/**
 * Saves the written cells of a table into its file (§7.5), between writes. Cells that hold the source's value are
 * not written. Afterwards the table reads the saved values as the file's own: it keeps its revision and row IDs,
 * and has no written cells.
 */
export async function saveTable(
  session: Session,
  table: LoadedTable,
  signal?: AbortSignal,
): Promise<{ records: number; edits: { version: number; cells: number } }> {
  if (!isSavable(table)) {
    throw new EngineError("save_unsupported", "Only CSV and TSV files that are not compressed are saved.");
  }
  return table.edits.exclusive(async () => {
    // Writes wait for the file to load (§7.2): a table with written cells has loaded.
    if (table.edits.state.cells === 0) return { records: 0, edits: table.edits.state };
    if (table.attempt === 2) {
      // Irregular files are read loosely as text: their records may not be the rows.
      throw new EngineError("save_unsupported", "The file was read as text, since its records are irregular.");
    }
    // The file must still be the one the table read, at its real location inside the allowed folders.
    const real = await realpath(table.path).catch(() => null);
    if (real !== table.path || !session.allows(real)) {
      throw new EngineError("not_allowed", "The file is no longer where the engine may write it.");
    }
    if ((await fileRevision(table.path)) !== table.fileState) throw fileChanged();
    const { dialect, cells } = await session.withConnection(signal, async (connection) => {
      try {
        const dialect = await dialectOf(connection, table);
        const changed = await table.edits.changedCells(connection, (column, value) => textOf(column, value, dialect));
        if (changed.lost.length > 0) {
          throw new EngineError(
            "save_unsupported",
            `The values of ${changed.lost[0].name} cannot be written in the file's format.`,
          );
        }
        return { dialect, cells: changed.cells };
      } catch (error) {
        if (error instanceof CsvSaveError) throw new EngineError("save_unsupported", error.message);
        throw error;
      }
    });
    const records = cells.size > 0 ? await replace(table, dialect, cells, signal) : 0;
    const base = table.base;
    if (base === null) throw new EngineError("internal", "The table has no rows of its own.");
    await session.withConnection(undefined, (connection) => table.edits.saved(connection, base));
    return { records, edits: table.edits.state };
  });
}
