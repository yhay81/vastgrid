/**
 * The conformance corpus (docs/v2-spec.md §10): reading its files and comparing an engine's answers with
 * them. Uses Node.js.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCommand,
  type Command,
  type CommandContext,
  type CommandRequest,
  type CommandResult,
} from "./commands.js";
import { canonicalJson } from "./hash.js";
import { checkEvent, checkRequest, checkResponse, type Operation, ProtocolError } from "./messages.js";
import type { GridDocument, GridSession, GridState } from "./state.js";
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

/** The folder of the corpus in this package, and its three parts (§10). */
export const corpusDirectory = fileURLToPath(new URL("../conformance/", import.meta.url));
export const planDirectory = path.join(corpusDirectory, "plans");
export const commandDirectory = path.join(corpusDirectory, "commands");
export const messageDirectory = path.join(corpusDirectory, "messages");

function readFiles<T>(directory: string): (T & { file: string })[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => {
      const { $schema: _schema, ...content } = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      return { file, ...(content as T) };
    });
}

/** The files of the plan corpus, in the order of their names. */
export function readCorpus(directory: string = planDirectory): CorpusFile[] {
  return readFiles<Omit<CorpusFile, "file">>(directory);
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

// ----- command cases -----

/** A state of a command case: a document and a session, empty when absent. */
export interface CommandCaseState {
  extends?: string;
  document?: GridDocument;
  session?: GridSession;
}

/** A context of a command case (§6.1); `extends` names a context of the file whose other members it takes. */
export interface CommandCaseContext extends Partial<CommandContext> {
  extends?: string;
}

export interface CommandExpect {
  document?: GridDocument;
  session?: GridSession;
  requests?: CommandRequest[];
  output?: unknown;
}

export interface CommandFailure {
  error: { code: "invalid_command"; reason: string; path: string; details?: Record<string, unknown> };
}

export interface CommandCase {
  id: string;
  section: string;
  description?: string;
  state: string | CommandCaseState;
  context: string | CommandCaseContext;
  /** Commands, and items `{ context }` that change the context of the commands after them. */
  commands: (Command | { context: string | CommandCaseContext })[];
  expect: CommandExpect | CommandFailure;
}

export interface CommandFile {
  file: string;
  description?: string;
  states?: Record<string, CommandCaseState>;
  contexts?: Record<string, CommandCaseContext>;
  cases: CommandCase[];
}

/** The files of the command corpus, in the order of their names. */
export function readCommandCorpus(directory: string = commandDirectory): CommandFile[] {
  return readFiles<Omit<CommandFile, "file">>(directory);
}

function named<T extends { extends?: string }>(
  file: CommandFile,
  value: string | T,
  table: Record<string, T> | undefined,
  what: string,
  seen: string[] = [],
): Omit<T, "extends"> {
  if (typeof value === "string") {
    const found = table?.[value];
    if (!found) throw new Error(`${file.file}: there is no ${what} "${value}".`);
    if (seen.includes(value)) throw new Error(`${file.file}: the ${what} "${value}" extends itself.`);
    return named(file, found, table, what, [...seen, value]);
  }
  const { extends: base, ...own } = value;
  return base === undefined ? own : { ...named(file, base, table, what, seen), ...own };
}

/** The state of a case, with the file's named states. */
export function caseState(file: CommandFile, state: string | CommandCaseState): GridState {
  const resolved = named(file, state, file.states, "state");
  return {
    document: resolved.document ?? { kind: "vastgrid/document", version: 2 },
    session: resolved.session ?? { kind: "vastgrid/session", version: 2 },
  };
}

/** A context of a case, with the file's named contexts. */
export function caseContext(file: CommandFile, context: string | CommandCaseContext): CommandContext {
  const resolved = named(file, context, file.contexts, "context");
  const table = resolved.table ?? [];
  return {
    table,
    revision: resolved.revision ?? null,
    view: resolved.view ?? { columns: table, rowCount: 0, rowIds: true },
    page: resolved.page ?? 10,
    ...(resolved.rows ? { rows: resolved.rows } : {}),
    ...(resolved.capabilities ? { capabilities: resolved.capabilities } : {}),
    ...(resolved.clipboard ? { clipboard: resolved.clipboard } : {}),
  };
}

export function isCommandFailure(expect: CommandExpect | CommandFailure): expect is CommandFailure {
  return "error" in expect;
}

function sameJson(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Runs a command case with an implementation of `applyCommand` (§6.1). Gives the differences from what the
 * case expects; empty when the implementation conforms.
 */
export function runCommandCase(
  file: CommandFile,
  item: CommandCase,
  apply: (state: GridState, command: unknown, context: CommandContext) => CommandResult = applyCommand,
): string[] {
  let state = caseState(file, item.state);
  let context = caseContext(file, item.context);
  const steps = item.commands.filter((step): step is Command => "command" in step);
  if (steps.length === 0) return ["the case has no command"];
  const last = steps[steps.length - 1];
  for (const step of item.commands) {
    if (!("command" in step)) {
      context = caseContext(file, step.context);
      continue;
    }
    let result: CommandResult;
    try {
      result = apply(state, step, context);
    } catch (error) {
      if (step !== last) return [`${step.command} failed before the last command: ${String(error)}`];
      if (!isCommandFailure(item.expect)) return [`${step.command} failed: ${String(error)}`];
      const expected = item.expect.error;
      const actual = error as { code?: string; reason?: string; path?: string; details?: unknown };
      const problems: string[] = [];
      for (const member of ["code", "reason", "path"] as const) {
        if (actual[member] !== expected[member]) {
          problems.push(
            `error ${member} ${JSON.stringify(actual[member])}, expected ${JSON.stringify(expected[member])}`,
          );
        }
      }
      if (expected.details !== undefined && !sameJson(actual.details, expected.details)) {
        problems.push(`error details ${JSON.stringify(actual.details)}, expected ${JSON.stringify(expected.details)}`);
      }
      return problems;
    }
    if (step === last) {
      if (isCommandFailure(item.expect)) return [`${step.command} succeeded, expected ${item.expect.error.reason}`];
      const problems: string[] = [];
      // Only the members that the case gives are compared; an output of null expects none.
      for (const member of ["document", "session", "requests", "output"] as const) {
        if (!(member in item.expect)) continue;
        const actual = result[member] ?? null;
        const expected = item.expect[member] ?? null;
        if (!sameJson(actual, expected)) {
          problems.push(`${member} ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        }
      }
      return problems;
    }
    state = { document: result.document, session: result.session };
  }
  return [];
}

// ----- message cases -----

export interface MessageCase {
  id: string;
  section: string;
  description?: string;
  kind: "request" | "response" | "event";
  /** The operation of the request that a response answers. */
  op?: Operation;
  message: unknown;
  expect: { valid: true } | { error: { code: string; reason: string; path: string } };
}

export interface MessageFile {
  file: string;
  description?: string;
  cases: MessageCase[];
}

/** The files of the message corpus, in the order of their names. */
export function readMessageCorpus(directory: string = messageDirectory): MessageFile[] {
  return readFiles<Omit<MessageFile, "file">>(directory);
}

/** Runs a message case with the checks of §8. Gives the differences from what it expects; empty when they agree. */
export function runMessageCase(item: MessageCase): string[] {
  try {
    if (item.kind === "request") checkRequest(item.message);
    else if (item.kind === "event") checkEvent(item.message);
    else checkResponse(item.message, item.op as Operation);
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    if ("valid" in item.expect)
      return [`${error.code} at ${JSON.stringify(error.path)} (${error.reason}): ${error.message}`];
    const expected = item.expect.error;
    const problems: string[] = [];
    for (const member of ["code", "reason", "path"] as const) {
      if (error[member] !== expected[member]) {
        problems.push(`${member} ${JSON.stringify(error[member])}, expected ${JSON.stringify(expected[member])}`);
      }
    }
    return problems;
  }
  return "valid" in item.expect ? [] : [`the message is valid, expected ${item.expect.error.reason}`];
}
