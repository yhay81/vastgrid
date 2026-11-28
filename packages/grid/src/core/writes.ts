import {
  type CommandRequest,
  canonicalJson,
  type ErrorCode,
  type GridCommand,
  type GridSession,
  type JsonValue,
  keyText,
  type LoadedRow,
  type Operation,
  type RowKey,
} from "vastgrid-spec";
import type { GridClient } from "./client.js";
import {
  asGridError,
  type CommandOutcome,
  type Edits,
  type FailedWrite,
  GridError,
  type TableInfo,
  type WriteUpdate,
} from "./types.js";

/** The state and notifications that command writes need from their store. */
export interface WriteHost {
  client(): GridClient | null;
  table(): TableInfo | null;
  session(): GridSession;
  /** The edits version of the rows on screen, if any. */
  visibleEdits(): number | null;
  history(command: GridCommand, table: TableInfo): void;
  changed(edits: Edits): void;
  showRows(): void;
  failed(failure: FailedWrite | null): void;
}

/** Failures that the same write may not meet when it is sent again. */
const RETRIED = new Set<ErrorCode>(["internal", "cancelled", "not_ready", "table_not_found"]);

/**
 * Sends command requests (§6) and owns cell writes (§7.2): their optimistic values, pending answers,
 * failures, retries and history acknowledgements. The store coordinates these with the view on screen.
 */
export class CommandWriter {
  /**
   * Values of writes (§7.2) that the rows read do not hold yet, by the key text of their row and by column, with
   * the write that gave them: the grid shows them at once, and drops them when the write fails or once the view
   * of its edits version is on screen.
   */
  private readonly written = new Map<string, Map<string, { value: JsonValue; write: number }>>();
  private writes = 0;
  /** The edits version that each write that succeeded made. */
  private readonly writeVersions = new Map<number, number>();
  /** Settles once the writes sent so far are answered and their steps are in the history. */
  private writing: Promise<void> = Promise.resolve();
  private failure: FailedWrite | null = null;

  constructor(private readonly host: WriteHost) {}

  /** Whether any written values have yet to reach the rows on screen. */
  get pending() {
    return this.written.size > 0;
  }

  /** Settles when the writes sent so far are answered and recorded in the history. */
  settled(): Promise<void> {
    return this.writing;
  }

  /** Pending writes can address a row by its key value or its stable source ID. */
  private entry(row: LoadedRow | undefined, column: string) {
    if (!row) return undefined;
    const byKey = row.key && this.written.get(keyText(row.key))?.get(column);
    if (row.rowId === undefined || (row.key && "rowId" in row.key)) return byKey;
    const byId = this.written.get(keyText({ rowId: row.rowId }))?.get(column);
    return byId && (!byKey || byId.write > byKey.write) ? byId : byKey;
  }

  /** Whether an unanswered write covers a cell. */
  has(row: LoadedRow | undefined, column: string): boolean {
    return this.entry(row, column) !== undefined;
  }

  /** A cell's written value, or its cached value when no write covers it. */
  value(row: LoadedRow | undefined, column: string, cached: JsonValue | undefined): JsonValue | undefined {
    const entry = this.entry(row, column);
    return entry === undefined ? cached : entry.value;
  }

  /** Drops written values once rows of their edits version are on screen. */
  visible(edits: number) {
    this.dropWritten((write) => (this.writeVersions.get(write) ?? Number.POSITIVE_INFINITY) <= edits);
    for (const [write, version] of this.writeVersions) {
      if (version <= edits) this.writeVersions.delete(write);
    }
  }

  /** Clears written values from an earlier revision of the table. */
  reset() {
    this.writeVersions.clear();
    this.dropWritten(() => true);
    if (this.failure) this.setFailure(null);
  }

  /** A row as commands read it, with the values of writes that its rows do not hold yet. */
  overlay(row: LoadedRow | undefined, rowKey: string | undefined): LoadedRow | undefined {
    if (!row || this.written.size === 0) return row;
    // While its key is changing, later edits of this row must still name the same record.
    const key =
      rowKey !== undefined && row.rowId !== undefined && this.has(row, rowKey) ? { rowId: row.rowId } : row.key;
    return {
      key,
      rowId: row.rowId,
      has: (column) => row.has(column) || this.has(row, column),
      get: (column) => this.value(row, column, row.get(column)) ?? null,
    };
  }

  /** Shows the values of a write until it is answered (§7.2). */
  private markWritten(write: number, updates: readonly { key: RowKey; column: string; value: JsonValue }[]) {
    for (const update of updates) {
      const text = keyText(update.key);
      let values = this.written.get(text);
      if (!values) {
        values = new Map();
        this.written.set(text, values);
      }
      values.set(update.column, { value: update.value, write });
    }
    this.host.showRows();
  }

  /** Forgets the values of writes: one that failed, or those that the rows on screen now hold. */
  private dropWritten(done: (write: number) => boolean) {
    let dropped = false;
    for (const [text, values] of this.written) {
      for (const [column, entry] of values) {
        if (!done(entry.write)) continue;
        values.delete(column);
        dropped = true;
      }
      if (values.size === 0) this.written.delete(text);
    }
    if (dropped) this.host.showRows();
  }

  /**
   * Sends the failed write again (§6.6 of react.md): the same updates, or after an `edit_conflict` without their
   * `previous`, so that they write over what the cells hold now. It succeeds as its command would have: the history
   * gets its step, or an undo or a redo whose step is still the last moves it. Resolves as `dispatch` does.
   */
  readonly retryWrite = async (): Promise<CommandOutcome> => {
    const failed = this.failure;
    const table = this.host.table();
    if (!failed) return { ok: false, error: new GridError("invalid_request", "No write failed.") };
    if (failed.retry === null || !table || table.revision !== failed.revision) {
      return { ok: false, error: new GridError("revision_changed", "The write cannot be sent again.") };
    }
    this.setFailure(null);
    const request: CommandRequest = { op: "write", revision: failed.revision, updates: failed.updates };
    if (failed.rowKey !== undefined) request.rowKey = failed.rowKey;
    const command = this.stillLast(failed) ? failed.command : "write";
    try {
      await this.send(command, [request], table, failed.retry === "overwrite");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asGridError(error) };
    }
  };

  /** Forgets the failed write: its cells show what the engine holds. */
  discardWrite() {
    if (this.failure) this.setFailure(null);
  }

  private setFailure(failure: FailedWrite | null) {
    this.failure = failure;
    this.host.failed(failure);
  }

  /** Keeps a write that failed, for `retryWrite` and `discardWrite`. */
  private failWrite(command: string, request: CommandRequest, error: GridError) {
    const failed: FailedWrite = {
      command,
      updates: request.updates as WriteUpdate[],
      revision: (request.revision as string | null | undefined) ?? null,
      ...(request.rowKey === undefined ? {} : { rowKey: request.rowKey as string }),
      error,
      retry: error.code === "edit_conflict" ? "overwrite" : RETRIED.has(error.code) ? "retry" : null,
    };
    this.setFailure(failed);
  }

  /** Whether a failed undo or redo has its step still last in its list, where its write then moves it from. */
  private stillLast(failed: FailedWrite) {
    const list = failed.command === "history.undo" ? "undo" : failed.command === "history.redo" ? "redo" : null;
    if (!list) return true;
    const step = this.host.session().history?.[list].at(-1);
    if (!step) return false;
    const written = step.updates.map((update) => ({
      key: update.key,
      column: update.column,
      value: list === "undo" ? update.before : update.after,
      previous: list === "undo" ? update.after : update.before,
    }));
    const sent = failed.updates.map(({ key, column, value, previous }) => ({ key, column, value, previous }));
    return canonicalJson(written) === canonicalJson(sent);
  }

  /** Sends the requests of a command and applies the commands of §6.7 that their answers call for. */
  async send(name: string, requests: CommandRequest[], table: TableInfo, overwrite = false): Promise<unknown> {
    if (!requests.some((request) => request.op === "write")) return this.sendNow(name, requests, table, overwrite);
    let done = () => {};
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.writing = this.writing.then(() => finished);
    try {
      return await this.sendNow(name, requests, table, overwrite);
    } finally {
      done();
    }
  }

  private async sendNow(name: string, requests: CommandRequest[], table: TableInfo, overwrite: boolean) {
    const client = this.host.client();
    let output: unknown;
    for (const request of requests) {
      if (!client) throw new GridError("not_ready", "The grid is not connected.");
      const { op, ...members } = request;
      const updates = (op === "write" ? members.updates : []) as WriteUpdate[];
      const write = op === "write" ? ++this.writes : 0;
      if (write) this.markWritten(write, updates);
      // An overwrite checks no `previous`; the history keeps them all the same, as the values the person wrote over.
      const sent = overwrite
        ? {
            ...members,
            updates: updates.map((update) => {
              const value = { ...update };
              delete value.previous;
              return value;
            }),
          }
        : members;
      let result: Record<string, unknown>;
      try {
        result = await client.request<Record<string, unknown>>(op as Operation, { table: table.table, ...sent });
      } catch (error) {
        if (write) {
          this.dropWritten((other) => other === write);
          if (client === this.host.client()) this.failWrite(name, request, asGridError(error));
        }
        throw error;
      }
      if (op === "write") {
        const currentTable = this.host.table();
        if (
          client !== this.host.client() ||
          !currentTable ||
          currentTable.table !== table.table ||
          currentTable.revision !== table.revision
        ) {
          this.dropWritten((other) => other === write);
          continue;
        }
        const core =
          name === "history.undo"
            ? { command: "history.undone" as const }
            : name === "history.redo"
              ? { command: "history.redone" as const }
              : {
                  command: "history.push" as const,
                  updates: updates.map((update) => ({
                    key: update.key,
                    column: update.column,
                    before: update.previous ?? null,
                    after: update.value,
                  })),
                };
        this.host.history(core, table);
        const edits = result.edits as TableInfo["edits"];
        this.writeVersions.set(write, edits.version);
        // The engine's event may have brought the view of this version on screen before the answer came.
        if ((this.host.visibleEdits() ?? -1) >= edits.version) this.dropWritten((other) => other === write);
        this.host.changed(edits);
      } else {
        output = result;
      }
    }
    return output;
  }
}
