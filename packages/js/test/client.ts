/**
 * A client of the engine for the tests: it sends requests and checks every response as a client does
 * (docs/v2-spec.md §8).
 */
import assert from "node:assert/strict";
import { type Column, checkResponse, decodeBlock, type JsonValue, type Operation } from "vastgrid-spec";
import { type MemoryEngine, type MemoryTable, memoryEngine } from "../src/index.ts";

export type Json = Record<string, unknown>;

/** An error of a response (§8.1). */
export interface ErrorBody {
  code: string;
  message: string;
  path?: string;
  reason?: string;
}

export interface TableInfo {
  table: string;
  revision: string;
  rowCount: number;
  columns: Column[];
  capabilities: Json;
}

export interface Rows {
  rowIds: number[] | null;
  rows: JsonValue[][];
  columns: Column[];
  view: { hash: string; rowCount: number; columns: Column[] };
  start: number;
  end: number;
  truncated?: Record<string, number[]>;
}

export class Client {
  readonly engine: MemoryEngine;
  private id = 0;

  constructor(tables: Record<string, MemoryTable>) {
    this.engine = memoryEngine({ tables });
  }

  /** Sends a request; the response, an error included, follows §8. */
  async send(op: Operation, members: Json = {}): Promise<Json> {
    const id = ++this.id;
    const response = (await this.engine.handle({ v: 2, id, op, ...members })) as Json;
    checkResponse(response, op);
    assert.equal(response.id, id);
    return response;
  }

  /** Sends a request that succeeds, and gives its result. */
  async result(op: Operation, members: Json = {}): Promise<unknown> {
    const response = await this.send(op, members);
    assert.ok("result" in response, `${op} failed: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  /** Sends a request that fails, and gives its error. */
  async error(op: Operation, members: Json = {}): Promise<ErrorBody> {
    const response = await this.send(op, members);
    assert.ok("error" in response, `${op} succeeded`);
    return response.error as ErrorBody;
  }

  async open(ref: string): Promise<TableInfo> {
    return (await this.result("open", { ref })) as TableInfo;
  }

  /** Reads rows of a plan's view, all of them and all the table's columns by default. */
  async rows(
    info: TableInfo,
    plan: unknown,
    read: { start?: number; end?: number; columns?: string[]; textLimit?: number } = {},
  ): Promise<Rows> {
    const columns = read.columns ?? info.columns.map((column) => column.name);
    const result = (await this.result("rows", {
      table: info.table,
      revision: info.revision,
      plan,
      start: read.start ?? 0,
      end: read.end ?? info.rowCount,
      columns,
      ...(read.textLimit === undefined ? {} : { textLimit: read.textLimit }),
    })) as Omit<Rows, "rows" | "columns"> & { block: { bytes: Uint8Array } };
    const block = decodeBlock(result.block.bytes);
    return { ...result, rows: block.rows, columns: block.columns };
  }

  /** The row IDs of a table sorted by keys, one table of one or more columns. */
  async sorted(info: TableInfo, sort: { column: string; direction: "asc" | "desc" }[]): Promise<number[]> {
    return (await this.rows(info, { sort }, { columns: [info.columns[0].name] })).rowIds as number[];
  }
}

/** A table of one column. */
export function single(column: Omit<Column, "name">, values: JsonValue[]): MemoryTable {
  return { columns: [{ name: "x", ...column } as Column], rows: values.map((value) => [value]) };
}

/** A pseudo-random generator with a seed, so that generated tables are the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
