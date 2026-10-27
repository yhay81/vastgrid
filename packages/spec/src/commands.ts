/**
 * Commands (docs/v2-spec.md §6): a command applied to a state with a context gives a new state, the requests
 * that the core then sends (§8.2, without `v`, `id` and `table`) and, for some commands, an output. The same
 * state, command and context give the same result, and a command that fails changes nothing. The commands of
 * each section of §6 are in `commands/`, and the command being applied in `commands/run.ts`.
 */
import { COLUMN_HANDLERS } from "./commands/columns.js";
import {
  type Command,
  type CommandContext,
  type CommandName,
  type CommandResult,
  fail,
  isObject,
} from "./commands/command.js";
import { COPYING_HANDLERS } from "./commands/copying.js";
import { CORE_HANDLERS } from "./commands/core.js";
import { EDITING_HANDLERS } from "./commands/editing.js";
import { PLAN_HANDLERS } from "./commands/plan.js";
import { type Handler, Run } from "./commands/run.js";
import { SELECTION_HANDLERS } from "./commands/selection.js";
import type { GridState } from "./state.js";

export {
  COMMAND_ERRORS,
  type Command,
  type CommandContext,
  CommandError,
  type CommandErrorReason,
  type CommandName,
  type CommandOutputs,
  type CommandRequest,
  type CommandResult,
  type GridCommand,
  type LoadedRow,
  type LoadedRows,
} from "./commands/command.js";
export { COPY_LIMIT } from "./commands/copying.js";
export { WRITE_LIMIT } from "./commands/editing.js";
export { orderColumns } from "./commands/run.js";

/** Whether two JSON values are the same: the same members with the same values, arrays in the same order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameJson(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * The members of `next` that are the same as those of `previous` take their objects from `previous`, and
 * `next` as a whole is `previous` when every member is. Members of `byIdentity` are compared as objects only,
 * since they may be large and commands replace them rather than change them.
 */
function share<T extends object>(previous: T, next: T, byIdentity: readonly string[]): T {
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  let same = Object.keys(before).length === Object.keys(after).length;
  for (const key of Object.keys(after)) {
    const value = after[key];
    if (!Object.hasOwn(before, key)) {
      same = false;
      continue;
    }
    const old = before[key];
    if (value !== old && !byIdentity.includes(key) && sameJson(value, old)) after[key] = old;
    if (after[key] !== old) same = false;
  }
  return same ? previous : next;
}

const HANDLERS: Record<CommandName, Handler> = {
  ...PLAN_HANDLERS,
  ...COLUMN_HANDLERS,
  ...SELECTION_HANDLERS,
  ...EDITING_HANDLERS,
  ...COPYING_HANDLERS,
  ...CORE_HANDLERS,
};

/** The commands of §6, by name. */
export const COMMANDS = Object.keys(HANDLERS);

/**
 * Applies a command to a state with a context (§6.1). Throws a `CommandError` when the command cannot be
 * applied; the state given is not changed either way.
 */
export function applyCommand(state: GridState, command: unknown, context: CommandContext): CommandResult {
  if (!isObject(command) || typeof command.command !== "string") {
    fail("/command", "syntax", "A command is { command, …arguments }.");
  }
  const handler = Object.hasOwn(HANDLERS, command.command) ? HANDLERS[command.command as CommandName] : undefined;
  if (!handler) fail("/command", "unknown_command", `There is no command "${command.command}".`);
  const run = new Run(state, context);
  handler(run, command as Command);
  run.tidy();
  const result: CommandResult = {
    // Members are compared by value, so that a command that gives one again unchanged keeps its object; the
    // history only by identity, since it may hold a million updates and only history commands replace it.
    document: share(state.document, run.document, []),
    session: share(state.session, run.session, ["history"]),
    requests: run.requests,
  };
  if (run.output !== undefined) result.output = run.output;
  return result;
}
