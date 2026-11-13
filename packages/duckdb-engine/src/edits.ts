/**
 * The written cells of a table (docs/spec.md §7.2): kept apart from the source, in a table of the session for
 * each written column, and read through a view that puts them over the source's values, so that every request
 * (rows, plans, summaries, find) sees them.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { type Column, type JsonValue, keyText, quoted, type RowKey, sameCellValue } from "vastgrid-spec";
import { duckdbType, quoteIdentifier } from "vastgrid-sql";
import { acceptKeyValue, holdsDuckValue, readExpression, readValue, valueExpression } from "./columns.js";
import { cancelled, EngineError } from "./errors.js";
import { Gate, type Session } from "./session.js";
import { type LoadedTable, type Relation, relationColumn } from "./table.js";

type Json = Record<string, unknown>;

export interface Update {
  key: RowKey;
  column: string;
  value: JsonValue;
  previous?: JsonValue;
}

/** The longest text that a message holds (§8.1): `previous` is compared with the whole value up to it. */
const MESSAGE_TEXT = 1_000_000;

function waitReady(table: LoadedTable, signal?: AbortSignal): Promise<void> {
  if (!signal) return table.whenReady();
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    table
      .whenReady()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Whether a column's cells are written (§7.1). */
function isWritable(column: Column) {
  return !column.readOnly && column.type !== "interval" && column.type !== "binary";
}

/** The cells written into one loaded table, and the view that reads the table with them. */
export class Edits {
  /** The edits version (§8.2): incremented by every write that changed cells. */
  version = 0;
  /** The row IDs written in each column, by its index. */
  private readonly written = new Map<number, Set<number>>();
  /** The quoted name of the table that holds each written column's values, by its index. */
  private readonly stores = new Map<number, string>();
  /** The relation of the source, which the view of the written cells reads. */
  private source: Relation | null = null;
  /** Writes one at a time, so that what a write checked is what it changes. */
  private readonly gate = new Gate(1);

  constructor(
    private readonly session: Session,
    private readonly table: LoadedTable,
  ) {}

  /** The edits of `TableInfo` (§8.2). */
  get state(): { version: number; cells: number } {
    let cells = 0;
    for (const rows of this.written.values()) cells += rows.size;
    return { version: this.version, cells };
  }

  /** Writes cells (§7.2): every update or none. */
  write(request: Json, signal?: AbortSignal): Promise<{ updated: number; edits: { version: number; cells: number } }> {
    return this.gate.run(() => this.apply(request, signal));
  }

  private async apply(request: Json, signal?: AbortSignal) {
    const table = this.table;
    if (table.replaced) {
      // The handles left the table while the write waited (§7.6).
      throw new EngineError("revision_changed", "The table has another revision: read its TableInfo again.");
    }
    if (table.status === "loading") {
      // The rows read so far may have other types than those of the whole file (§9): the write waits for it.
      const revision = table.revision;
      await waitReady(table, signal);
      if (table.revision !== revision) {
        throw new EngineError("revision_changed", "The table has another revision: read its TableInfo again.");
      }
    }
    const relation = table.requireRelation();
    const updates = request.updates as Update[];
    const columns = table.columns;
    let keyColumn: Column | undefined;
    if (request.rowKey !== undefined) {
      keyColumn = columns.find((column) => column.name === request.rowKey);
      if (!keyColumn) {
        throw new EngineError("invalid_request", `The table has no column ${quoted(request.rowKey)}.`, {
          path: "/rowKey",
          reason: "syntax",
        });
      }
    } else if (updates.some((update) => "value" in update.key)) {
      throw new EngineError("invalid_request", "Keys by value need rowKey, the column of their values (§5.3).", {
        path: "/rowKey",
        reason: "syntax",
      });
    }
    const keyColumnIndex = keyColumn ? columns.indexOf(keyColumn) : -1;
    const indexes = updates.map((update) => columns.findIndex((column) => column.name === update.column));
    if (updates.length === 0) return { updated: 0, edits: this.state };
    return this.session.withConnection(signal, async (connection) => {
      const rows = await this.rowsOf(connection, relation, updates, keyColumn);
      const previous = await this.readPrevious(connection, relation, updates, indexes, rows);
      const byColumn = new Map<number, Map<number, JsonValue>>();
      const stagedKeys = new Map<number, string | null>();
      for (let at = 0; at < updates.length; at++) {
        const update = updates[at];
        const index = indexes[at];
        if (index < 0 || !isWritable(columns[index])) {
          throw new EngineError("read_only", `The cells of ${quoted(update.column)} are not written (§7.1).`, {
            details: { column: update.column },
          });
        }
        let row = rows[at];
        if (stagedKeys.size > 0 && keyColumn && "value" in update.key) {
          row = await this.rowOfWithStaged(connection, relation, update.key.value, keyColumn, stagedKeys);
        }
        if (row === null) {
          throw new EngineError("edit_conflict", "No row has this key now.", { details: { update: at } });
        }
        const column = columns[index];
        if (!holdsDuckValue(update.value, column)) {
          throw new EngineError(
            "invalid_value",
            `${quoted(update.value)} is not a value of ${quoted(update.column)}.`,
            {
              path: `/updates/${at}/value`,
              reason: "type",
              details: { update: at },
            },
          );
        }
        if (update.previous !== undefined) {
          const stagedCells = byColumn.get(index);
          let now: JsonValue;
          if (stagedCells?.has(row)) {
            now = stagedCells.get(row) as JsonValue;
          } else if (previous.get(index)?.has(row)) {
            now = previous.get(index)?.get(row) ?? null;
          } else {
            now = await this.readCell(connection, relation, index, row);
          }
          if (!sameCellValue(now, update.previous, column)) {
            throw new EngineError("edit_conflict", "The cell holds another value now.", { details: { update: at } });
          }
        }
        const cells = byColumn.get(index) ?? new Map<number, JsonValue>();
        cells.set(row, update.value);
        byColumn.set(index, cells);
        if (index === keyColumnIndex && keyColumn) {
          const normalized = acceptKeyValue(update.value, keyColumn);
          stagedKeys.set(row, normalized === null ? null : keyText({ value: normalized }));
        }
      }
      if (signal?.aborted) throw cancelled();
      await this.store(connection, relation, byColumn);
      for (const [index, cells] of byColumn) {
        const written = this.written.get(index) ?? new Set<number>();
        for (const row of cells.keys()) written.add(row);
        this.written.set(index, written);
      }
      this.version++;
      return { updated: updates.length, edits: this.state };
    });
  }

  /** Runs a task between writes, so that the written cells it reads stay as they are (a save, §7.5). */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.gate.run(task);
  }

  /**
   * The written cells that hold another value than the source, by row ID and then column index: the text of each
   * value (null for null) and whether that text reads back as the value. `expression` gives the SQL of both for a
   * column, from the SQL of the written value.
   */
  async changedCells(
    connection: DuckDBConnection,
    expression: (column: Column, value: string) => { text: string; same?: string },
  ): Promise<{ cells: Map<number, Map<number, string | null>>; lost: Column[] }> {
    const cells = new Map<number, Map<number, string | null>>();
    const lost: Column[] = [];
    const source = this.source;
    if (!source) return { cells, lost };
    for (const [index, store] of this.stores) {
      const column = this.table.columns[index];
      const { text, same = "TRUE" } = expression(column, "e.v");
      const read = await connection.runAndReadAll(
        `SELECT e.id, '.' || (${text}), ${same} FROM ${store} e JOIN ${source.sql} s ON s.${source.rowId} = e.id WHERE e.v IS DISTINCT FROM s.${relationColumn(source, column.name)}`,
      );
      for (const [row, value, kept] of read.getRowsJS()) {
        if (kept !== true && !lost.includes(column)) lost.push(column);
        const fields = cells.get(Number(row)) ?? new Map<number, string | null>();
        fields.set(index, value === null ? null : String(value).slice(1));
        cells.set(Number(row), fields);
      }
    }
    return { cells, lost };
  }

  /**
   * Makes the written values the source's own once the file holds them (§7.5): they go into `base`, the table
   * that the source reads, and the written cells are none. Row IDs stay; the edits version is incremented.
   */
  async saved(connection: DuckDBConnection, base: string): Promise<void> {
    await connection.run("BEGIN TRANSACTION");
    try {
      for (const [index, store] of this.stores) {
        await connection.run(`UPDATE ${base} SET "c${index}" = e.v FROM ${store} e WHERE ${base}.rowid = e.id`);
        await connection.run(`DELETE FROM ${store}`);
      }
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK").catch(() => undefined);
      throw error;
    }
    this.written.clear();
    this.version++;
  }

  /** The row ID of each update's key (§5.3), or null when no row has it now. */
  private async rowsOf(
    connection: DuckDBConnection,
    relation: Relation,
    updates: readonly Update[],
    keyColumn: Column | undefined,
  ): Promise<(number | null)[]> {
    const rowCount = this.table.rowCount ?? relation.rows;
    const rows = updates.map(({ key }) =>
      "rowId" in key ? (Number.isSafeInteger(key.rowId) && key.rowId < rowCount ? key.rowId : null) : null,
    );
    if (!keyColumn) return rows;
    // Values are looked up once each; the first row with a value is the one its key names.
    const distinct = new Map<string, { value: JsonValue; at: number[] }>();
    updates.forEach(({ key }, at) => {
      if (!("value" in key)) return;
      const normalized = acceptKeyValue(key.value, keyColumn);
      if (normalized === null) return;
      const text = keyText({ value: normalized });
      const entry = distinct.get(text) ?? { value: normalized, at: [] };
      entry.at.push(at);
      distinct.set(text, entry);
    });
    if (distinct.size === 0) return rows;
    const entries = [...distinct.values()];
    const params: unknown[] = [];
    const values = entries.map(({ value }, index) => `(${index}, ${valueExpression(value, keyColumn, params)})`);
    const read = await connection.runAndReadAll(
      `WITH vg_keys(i, v) AS (VALUES ${values.join(", ")}) SELECT vg_keys.i, min(r.${relation.rowId}) FROM vg_keys JOIN ${relation.sql} r ON r.${relationColumn(relation, keyColumn.name)} = vg_keys.v GROUP BY vg_keys.i`,
      params as never,
    );
    for (const [index, row] of read.getRowsJS()) {
      if (row === null) continue;
      for (const at of entries[Number(index)].at) rows[at] = Number(row);
    }
    return rows;
  }

  /** Resolves `{ value }` when an earlier update in the same batch wrote to `keyColumn`. */
  private async rowOfWithStaged(
    connection: DuckDBConnection,
    relation: Relation,
    value: JsonValue,
    keyColumn: Column,
    stagedKeys: Map<number, string | null>,
  ): Promise<number | null> {
    const normalized = acceptKeyValue(value, keyColumn);
    if (normalized === null) return null;
    const target = keyText({ value: normalized });
    let best = Number.POSITIVE_INFINITY;
    for (const [row, staged] of stagedKeys) {
      if (staged === target && row < best) best = row;
    }
    const params: unknown[] = [];
    const expr = valueExpression(normalized, keyColumn, params);
    const excluded = [...stagedKeys.keys()].join(", ");
    const bound = Number.isFinite(best) ? ` AND r.${relation.rowId} < ${best}` : "";
    const read = await connection.runAndReadAll(
      `SELECT min(r.${relation.rowId}) FROM ${relation.sql} r WHERE r.${relationColumn(relation, keyColumn.name)} = ${expr} AND r.${relation.rowId} NOT IN (${excluded})${bound}`,
      params as never,
    );
    const found = read.getRowsJS()[0]?.[0];
    if (found !== null && found !== undefined && Number(found) < best) best = Number(found);
    return Number.isFinite(best) ? best : null;
  }

  private async readCell(
    connection: DuckDBConnection,
    relation: Relation,
    index: number,
    row: number,
  ): Promise<JsonValue> {
    const column = this.table.columns[index];
    const expr = readExpression(column, relationColumn(relation, column.name), MESSAGE_TEXT);
    const read = await connection.runAndReadAll(`SELECT ${expr} FROM ${relation.sql} WHERE ${relation.rowId} = ${row}`);
    const values = read.getRowsJS()[0];
    return values ? readValue(column, values[0]).value : null;
  }

  /** Reads the current cell values needed to check `previous` (§7.2) together when columns need the same rows. */
  private async readPrevious(
    connection: DuckDBConnection,
    relation: Relation,
    updates: readonly Update[],
    indexes: readonly number[],
    rows: readonly (number | null)[],
  ): Promise<Map<number, Map<number, JsonValue>>> {
    const rowsByColumn = new Map<number, Set<number>>();
    for (let at = 0; at < updates.length; at++) {
      const index = indexes[at];
      const row = rows[at];
      if (updates[at].previous === undefined || index < 0 || !isWritable(this.table.columns[index]) || row === null) {
        continue;
      }
      const ids = rowsByColumn.get(index) ?? new Set<number>();
      ids.add(row);
      rowsByColumn.set(index, ids);
    }
    const byColumn = new Map<number, Map<number, JsonValue>>();
    const groups = new Map<string, number[]>();
    for (const [index, rows] of rowsByColumn) {
      const ids = [...rows].sort((a, b) => a - b).join(", ");
      const group = groups.get(ids) ?? [];
      group.push(index);
      groups.set(ids, group);
      byColumn.set(index, new Map());
    }
    for (const [ids, selected] of groups) {
      const expressions = selected.map((index) => {
        const column = this.table.columns[index];
        return readExpression(column, relationColumn(relation, column.name), MESSAGE_TEXT);
      });
      const read = await connection.runAndReadAll(
        `SELECT ${relation.rowId}, ${expressions.join(", ")} FROM ${relation.sql} WHERE ${relation.rowId} IN (${ids})`,
      );
      for (const values of read.getRowsJS()) {
        selected.forEach((index, offset) => {
          const column = this.table.columns[index];
          byColumn.get(index)?.set(Number(values[0]), readValue(column, values[offset + 1]).value);
        });
      }
    }
    return byColumn;
  }

  /**
   * Stores the values in the tables of their columns, in one transaction, and makes the table read them: through a
   * view of the source with the written values over its own, made again when a column is written the first time.
   */
  private async store(connection: DuckDBConnection, relation: Relation, byColumn: Map<number, Map<number, JsonValue>>) {
    const fresh = [...byColumn.keys()].filter((index) => !this.stores.has(index));
    const names = new Map(fresh.map((index) => [index, quoteIdentifier(this.session.createName("vg_e"))]));
    const view = fresh.length > 0 ? quoteIdentifier(this.session.createName("vg_w")) : null;
    this.source ??= relation;
    await connection.run("BEGIN TRANSACTION");
    try {
      for (const [index, name] of names) {
        await connection.run(
          `CREATE TABLE ${name} (id BIGINT PRIMARY KEY, v ${duckdbType(this.table.columns[index])})`,
        );
      }
      for (const [index, cells] of byColumn) {
        const column = this.table.columns[index];
        const params: unknown[] = [];
        const values = [...cells].map(([row, value]) => `(${row}, ${valueExpression(value, column, params)})`);
        await connection.run(
          `INSERT OR REPLACE INTO ${this.stores.get(index) ?? names.get(index)} VALUES ${values.join(", ")}`,
          params as never,
        );
      }
      if (view) {
        const stores = new Map([...this.stores, ...names]);
        await connection.run(`CREATE VIEW ${view} AS ${this.select(stores)}`);
      }
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK").catch(() => undefined);
      throw error;
    }
    for (const [index, name] of names) {
      this.stores.set(index, name);
      this.table.keep(`TABLE ${name}`);
    }
    if (view) {
      this.table.keep(`VIEW ${view}`);
      this.table.relation = { ...relation, sql: view };
    }
  }

  /** The query of the source's rows with the written values over its own. */
  private select(stores: Map<number, string>): string {
    const source = this.source as Relation;
    const joins: string[] = [];
    const outputs = this.table.columns.map((column, index) => {
      const name = relationColumn(source, column.name);
      const store = stores.get(index);
      if (!store) return `s.${name}`;
      const alias = `e${index}`;
      joins.push(`LEFT JOIN ${store} ${alias} ON ${alias}.id = s.${source.rowId}`);
      return `CASE WHEN ${alias}.id IS NULL THEN s.${name} ELSE ${alias}.v END AS ${name}`;
    });
    return `SELECT ${[...outputs, `s.${source.rowId}`].join(", ")} FROM ${source.sql} s ${joins.join(" ")}`;
  }
}
