/**
 * A client of the engine for the tests: it sends request messages (docs/spec.md §8) and checks every answer as
 * a core does (`checkResponse`), so that the tests also check that the engine follows §8.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { type Column, checkResponse, decodeBlock, type JsonValue, type Operation } from "vastgrid-spec";
import { duckdbType, quoteIdentifier } from "vastgrid-sql";
import { DuckDBEngine, type DuckDBEngineOptions } from "../src/index.ts";

export type Json = Record<string, unknown>;

export interface TableInfo {
  table: string;
  revision: string | null;
  status: "loading" | "ready" | "error";
  progress: number | null;
  rowCount: number | null;
  readableRows: number;
  columns: Column[];
  format?: string;
  byteSize?: number;
  notes?: string[];
  sheets?: { name: string; hidden?: boolean }[];
  sheet?: string;
  error?: string;
  capabilities: Json;
}

export interface Rows {
  view: {
    hash: string;
    status: string;
    rowCount: number;
    rowCountExact: boolean;
    readableRows: number;
    columns: Column[];
  };
  start: number;
  end: number;
  rowIds: number[] | null;
  columns: Column[];
  rows: JsonValue[][];
  truncated?: Record<string, number[]>;
}

export class Client {
  private id = 0;

  constructor(readonly engine: DuckDBEngine) {}

  /** Sends a request and gives its checked answer: a response or an error response. */
  async send(op: Operation, members: Json = {}): Promise<Json> {
    const id = ++this.id;
    const answer = await this.engine.handle({ v: 2, id, op, ...members });
    assert.ok(answer, `${op} was not answered`);
    checkResponse(answer, op);
    assert.equal(answer.id, id);
    return answer;
  }

  /** Sends a request and gives its result; fails when the answer is an error. */
  async result<T = Json>(op: Operation, members: Json = {}): Promise<T> {
    const answer = await this.send(op, members);
    if (answer.error) assert.fail(`${op} failed: ${JSON.stringify(answer.error)}`);
    return answer.result as T;
  }

  /** Sends a request that fails, and gives its error. */
  async error(
    op: Operation,
    members: Json = {},
  ): Promise<{ code: string; message: string; path?: string; reason?: string }> {
    const answer = await this.send(op, members);
    assert.ok(answer.error, `${op} did not fail: ${JSON.stringify(answer.result)}`);
    return answer.error as { code: string; message: string; path?: string; reason?: string };
  }

  /** Opens a file and waits until it has loaded (or failed to): its TableInfo then. */
  async open(ref: string, read?: Json): Promise<TableInfo> {
    const opened = await this.result<TableInfo>("open", read === undefined ? { ref } : { ref, read });
    await this.engine.whenLoaded(opened.table);
    return this.result<TableInfo>("info", { table: opened.table });
  }

  /** Reads rows of a plan's view, with the values of its block. */
  async rows(
    info: TableInfo,
    request: {
      start?: number;
      end?: number;
      columns?: string[];
      plan?: Json;
      textLimit?: number;
      preview?: boolean;
    } = {},
  ): Promise<Rows> {
    const columns = request.columns ?? info.columns.map((column) => column.name);
    const result = await this.result<Json & { block: { bytes: Uint8Array } }>("rows", {
      table: info.table,
      revision: info.revision,
      plan: request.plan ?? {},
      start: request.start ?? 0,
      end: request.end ?? (request.start ?? 0) + 10_000,
      columns,
      ...(request.preview === undefined ? {} : { preview: request.preview }),
      ...(request.textLimit === undefined ? {} : { textLimit: request.textLimit }),
    });
    const block = decodeBlock(result.block.bytes);
    assert.deepEqual(
      block.columns.map((column) => column.name),
      columns,
    );
    const count = (result.end as number) - (result.start as number);
    // A block without columns has no rows of its own: the answer's positions give them (§8.4).
    const rows = columns.length > 0 ? block.rows : Array.from({ length: count }, () => []);
    assert.equal(rows.length, count);
    return { ...(result as unknown as Rows), columns: block.columns, rows };
  }
}

/** A folder with a workspace (the allowed folder) and an engine over it, with a client. */
export async function setUp(options: Partial<DuckDBEngineOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-duckdb-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const engine = await DuckDBEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
    ...options,
  });
  return {
    root,
    workspace,
    engine,
    client: new Client(engine),
    async tearDown() {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A typed JSON value (§2.2) as SQL: numbers and text as parameters read as text, which DuckDB reads exactly. */
function input(value: JsonValue, column: Column, params: string[]): string {
  const type = duckdbType(column);
  if (value === null) return `CAST(NULL AS ${type})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  params.push(Object.is(value, -0) ? "-0.0" : String(value));
  return `CAST(CAST($${params.length} AS VARCHAR) AS ${type})`;
}

/** Writes a table of typed JSON values (§2) as a Parquet file, whose row numbers are the table's row IDs. */
export async function writeParquet(file: string, table: { columns: Column[]; rows: JsonValue[][] }) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const columns = table.columns.map((column) => `${quoteIdentifier(column.name)} ${duckdbType(column)}`);
    await connection.run(`CREATE TABLE t (${columns.join(", ")}, vg_order BIGINT)`);
    for (const [index, row] of table.rows.entries()) {
      const params: string[] = [];
      const values = row.map((value, column) => input(value, table.columns[column], params));
      await connection.run(`INSERT INTO t VALUES (${[...values, String(index)].join(", ")})`, params);
    }
    const names = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    // Without dictionaries: DuckDB's dictionaries keep one of the intervals that compare equal, so that a
    // column of "1 month" and "30 days" would read back as one of them.
    await connection.run(
      `COPY (SELECT ${names} FROM t ORDER BY vg_order) TO '${file.replaceAll("'", "''")}' (FORMAT parquet, DICTIONARY_SIZE_LIMIT 1)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
