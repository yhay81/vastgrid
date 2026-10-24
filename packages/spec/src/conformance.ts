/**
 * The conformance corpus (docs/v2-spec.md §10): reading its files and comparing an engine's answers with
 * them. Uses Node.js.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Column, JsonValue, ValueType } from "./types.js";
import { sameType, typeName } from "./values.js";

export interface CorpusTable {
  columns: Column[];
  rows: JsonValue[][];
}

/** What a case reads: positions and columns of the view, by default all of them. */
export interface CorpusRead {
  start?: number;
  end?: number;
  columns?: string[];
}

export interface CorpusResult {
  columns?: Column[];
  rowCount: number;
  rows: JsonValue[][];
  /** The row IDs of the rows read; null for views without them. */
  rowIds?: number[] | null;
  /** The relative difference allowed between floats (§3.8). */
  tolerance?: number;
}

export interface CorpusFailure {
  error: { code: string; reason?: string; path?: string };
}

export interface CorpusCase {
  id: string;
  section: string;
  description?: string;
  table: string;
  /** Not checked by the corpus schema, so that cases can test plans that do not validate. */
  plan: unknown;
  read?: CorpusRead;
  expect: CorpusResult | CorpusFailure;
}

export interface CorpusFile {
  /** The file's name, such as `order.json`. */
  file: string;
  description?: string;
  tables: Record<string, CorpusTable>;
  cases: CorpusCase[];
}

/** What an engine answered for a case. */
export interface CaseResult {
  /** The columns read, in order. */
  columns: Column[];
  rowCount: number;
  rows: JsonValue[][];
  rowIds: number[] | null;
}

/** The folder of the corpus in this package. */
export const corpusDirectory = fileURLToPath(new URL("../conformance/", import.meta.url));

/** The files of the corpus, in the order of their names. */
export function readCorpus(directory: string = corpusDirectory): CorpusFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => {
      const content = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as Omit<CorpusFile, "file">;
      return { file, description: content.description, tables: content.tables, cases: content.cases };
    });
}

export function isFailure(expect: CorpusResult | CorpusFailure): expect is CorpusFailure {
  return "error" in expect;
}

function floatOf(value: JsonValue): number | null {
  if (typeof value === "number") return value;
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  return null;
}

/**
 * Whether two values of a type are the same for conformance: floats by value (−0.0 equals 0.0, NaN equals
 * NaN, and 32-bit floats are rounded to 32 bits first) within a relative `tolerance`, and other values by
 * their JSON (bigints written as numbers or digits alike).
 */
export function sameValue(expected: JsonValue, actual: JsonValue, type: ValueType, tolerance = 0): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (type.type === "float") {
    let a = floatOf(expected);
    let b = floatOf(actual);
    if (a === null || b === null) return false;
    if (type.bits === 32) {
      a = Math.fround(a);
      b = Math.fround(b);
    }
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (a === b) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
  }
  if (type.type === "integer" || type.type === "bigint") return String(expected) === String(actual);
  return expected === actual;
}

function show(value: JsonValue) {
  return JSON.stringify(value);
}

/** The differences between what a case expects and what an engine answered; empty when the engine conforms. */
export function compareResult(expect: CorpusResult, actual: CaseResult): string[] {
  const problems: string[] = [];
  if (expect.columns) {
    const names = actual.columns.map((column) => column.name);
    const wanted = expect.columns.map((column) => column.name);
    if (names.join("\u0000") !== wanted.join("\u0000")) {
      problems.push(`columns ${show(names.join(", "))}, expected ${show(wanted.join(", "))}`);
    } else {
      expect.columns.forEach((column, index) => {
        if (!sameType(column, actual.columns[index])) {
          problems.push(`column ${column.name} is ${typeName(actual.columns[index])}, expected ${typeName(column)}`);
        }
      });
    }
  }
  if (actual.rowCount !== expect.rowCount) problems.push(`rowCount ${actual.rowCount}, expected ${expect.rowCount}`);
  if (actual.rows.length !== expect.rows.length) {
    problems.push(`${actual.rows.length} rows read, expected ${expect.rows.length}`);
  }
  const types = expect.columns ?? actual.columns;
  expect.rows.forEach((row, index) => {
    const got = actual.rows[index];
    if (!got) return;
    row.forEach((value, column) => {
      const type: Column = types[column] ?? { name: String(column), type: "string" };
      const answer = got[column] ?? null;
      if (!sameValue(value, answer, type, expect.tolerance)) {
        problems.push(`row ${index}, column ${type.name}: ${show(answer)}, expected ${show(value)}`);
      }
    });
  });
  if (expect.rowIds !== undefined && JSON.stringify(expect.rowIds) !== JSON.stringify(actual.rowIds)) {
    problems.push(`rowIds ${JSON.stringify(actual.rowIds)}, expected ${JSON.stringify(expect.rowIds)}`);
  }
  return problems;
}
