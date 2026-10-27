/**
 * The commands that the core applies when data arrives (docs/v2-spec.md §6.7): a new view, and the history of
 * writes.
 */
import {
  checkRowKey,
  checkValue,
  HISTORY_LIMITS,
  type HistoryStep,
  type HistoryUpdate,
  StateError,
  sameKey,
} from "../state.js";
import { checked, fail, isObject, stringArgument, takes } from "./command.js";
import type { Handlers } from "./run.js";

export const CORE_HANDLERS = {
  "view.update"(run, command) {
    takes(command, ["hash", "located"]);
    const hash = stringArgument(command, "hash");
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) fail("/hash", "syntax", "hash is a plan hash (§4.8).");
    const located = command.located ?? [];
    if (!Array.isArray(located)) fail("/located", "syntax", "located is a list of { key, row }.");
    const positions = checked(() =>
      located.map((item, index) => {
        const at = `/located/${index}`;
        if (!isObject(item)) throw new StateError(at, "syntax", "A located key is { key, row }.");
        const row = item.row;
        if (row !== null && (typeof row !== "number" || !Number.isSafeInteger(row) || row < 0)) {
          throw new StateError(`${at}/row`, "syntax", "row is a view position or null.");
        }
        return { key: checkRowKey(item.key, `${at}/key`), row: row as number | null };
      }),
    );
    const session = run.session;
    const revision = run.context.revision;
    if (session.revision !== undefined && session.revision !== revision) {
      if (session.checked) {
        session.checked = { ...session.checked, keys: session.checked.keys.filter((key) => !("rowId" in key)) };
      }
      if (session.active?.key && "rowId" in session.active.key) delete run.own("active").key;
      delete session.history;
      delete session.editor;
    }
    session.revision = revision;
    if (session.view !== undefined && session.view !== hash) {
      if (session.active) {
        const active = run.own("active");
        const key = active.key;
        const found = key ? positions.find((item) => sameKey(item.key, key)) : undefined;
        const row = found?.row ?? 0;
        if (found?.row === undefined || found.row === null) {
          // The key is not in the new view: the active cell is its first row, whose key the core may have read.
          const loaded = run.loadedKey(row);
          if (loaded === undefined) delete active.key;
          else active.key = loaded;
        }
        if (row !== active.row) session.scroll = { ...session.scroll, row };
        active.row = row;
      }
      delete session.anchor;
      delete session.focus;
      delete session.selection;
      delete session.editor;
    }
    session.view = hash;
    run.fit();
  },

  "history.push"(run, command) {
    takes(command, ["updates"]);
    if (!Array.isArray(command.updates))
      fail("/updates", "syntax", "updates is a list of { key, column, before, after }.");
    const updates = checked(() =>
      (command.updates as unknown[]).map((item, index): HistoryUpdate => {
        const at = `/updates/${index}`;
        if (!isObject(item)) throw new StateError(at, "syntax", "An update is { key, column, before, after }.");
        for (const key of Object.keys(item)) {
          if (!["key", "column", "before", "after"].includes(key)) {
            throw new StateError(`${at}/${key}`, "syntax", `"${key}" is not a member here.`);
          }
        }
        if (typeof item.column !== "string") throw new StateError(`${at}/column`, "syntax", "column is a name.");
        return {
          key: checkRowKey(item.key, `${at}/key`),
          column: item.column,
          before: checkValue(item.before, `${at}/before`),
          after: checkValue(item.after, `${at}/after`),
        };
      }),
    );
    const history = run.session.history ? run.own("history") : { undo: [], redo: [] };
    history.redo = [];
    if (updates.length > HISTORY_LIMITS.updates) {
      delete run.session.history;
      return;
    }
    history.undo.push({ updates });
    let total = history.undo.reduce((count, step) => count + step.updates.length, 0);
    while (history.undo.length > HISTORY_LIMITS.steps || total > HISTORY_LIMITS.updates) {
      total -= (history.undo.shift() as { updates: HistoryUpdate[] }).updates.length;
    }
    run.session.history = history;
  },

  "history.undone"(run, command) {
    takes(command, []);
    if (!run.session.history?.undo.length) fail("", "nothing", "There is nothing to undo.");
    const history = run.own("history");
    history.redo.push(history.undo.pop() as HistoryStep);
  },

  "history.redone"(run, command) {
    takes(command, []);
    if (!run.session.history?.redo.length) fail("", "nothing", "There is nothing to redo.");
    const history = run.own("history");
    history.undo.push(history.redo.pop() as HistoryStep);
  },

  "history.clear"(run, command) {
    takes(command, []);
    delete run.session.history;
  },
} satisfies Handlers;
