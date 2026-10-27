import assert from "node:assert/strict";
import { test } from "node:test";
import { caseState, isCommandFailure, readCommandCorpus, runCommandCase } from "../src/conformance.ts";
import {
  applyCommand,
  type Capabilities,
  COMMANDS,
  type CommandContext,
  CommandError,
  checkDocument,
  checkSession,
  type GridState,
} from "../src/index.ts";
import { bigState, COLUMNS, rowsContext } from "./command-fixture.ts";
import { schemaProblems } from "./schemas.ts";

const files = readCommandCorpus();

for (const file of files) {
  test(`commands: ${file.file}`, async (t) => {
    for (const item of file.cases) {
      await t.test(item.id, () => {
        assert.deepEqual(runCommandCase(file, item), []);
      });
    }
  });
}

test("the command corpus has a case for every command", () => {
  const used = new Set(
    files.flatMap((file) =>
      file.cases.flatMap((item) => item.commands.flatMap((step) => ("command" in step ? [step.command] : []))),
    ),
  );
  assert.deepEqual(
    COMMANDS.filter((name) => !used.has(name)),
    [],
  );
});

test("case ids are unique across the command corpus", () => {
  const seen = new Set<string>();
  for (const file of files) {
    for (const item of file.cases) {
      assert.ok(!seen.has(item.id), `${item.id} appears twice`);
      seen.add(item.id);
    }
  }
});

test("command corpus files follow commands.schema.json", () => {
  for (const file of files) {
    const { file: name, ...content } = file;
    assert.deepEqual(schemaProblems("commands.schema.json", content), [], name);
  }
});

test("states and expected results are documents and sessions (§5)", () => {
  for (const file of files) {
    for (const item of file.cases) {
      const state = caseState(file, item.state);
      assert.doesNotThrow(() => checkDocument(state.document), item.id);
      assert.doesNotThrow(() => checkSession(state.session), item.id);
      if (isCommandFailure(item.expect)) continue;
      if (item.expect.document) {
        assert.doesNotThrow(() => checkDocument(item.expect.document), `${item.id}: document`);
        assert.deepEqual(schemaProblems("state.schema.json#/$defs/document", item.expect.document), [], item.id);
      }
      if (item.expect.session) {
        assert.doesNotThrow(() => checkSession(item.expect.session), `${item.id}: session`);
        assert.deepEqual(schemaProblems("state.schema.json#/$defs/session", item.expect.session), [], item.id);
      }
    }
  }
});

test("commands that cases apply without an error follow $defs/command", () => {
  for (const file of files) {
    for (const item of file.cases) {
      const steps = item.commands.filter((step) => "command" in step);
      const applied = isCommandFailure(item.expect) ? steps.slice(0, -1) : steps;
      for (const step of applied) {
        assert.deepEqual(
          schemaProblems("commands.schema.json#/$defs/command", step),
          [],
          `${item.id}: ${step.command}`,
        );
      }
    }
  }
});

test("requests that commands give follow messages.schema.json once the core adds v, id and table", () => {
  for (const file of files) {
    for (const item of file.cases) {
      if (isCommandFailure(item.expect)) continue;
      for (const request of item.expect.requests ?? []) {
        const message = { v: 2, id: 1, table: "t1", ...request };
        assert.deepEqual(schemaProblems("messages.schema.json#/$defs/request", message), [], item.id);
      }
    }
  }
});

test("applyCommand changes nothing it is given", () => {
  const state = {
    document: { kind: "vastgrid/document" as const, version: 2 as const, columns: [{ name: "a", hidden: true }] },
    session: { kind: "vastgrid/session" as const, version: 2 as const, active: { row: 0, column: "b" } },
  };
  const before = JSON.stringify(state);
  const context = {
    table: [
      { name: "a", type: "string" as const },
      { name: "b", type: "string" as const },
    ],
    revision: null,
    view: {
      columns: [
        { name: "a", type: "string" as const },
        { name: "b", type: "string" as const },
      ],
      rowCount: 3,
      rowIds: true,
    },
    page: 10,
  };
  applyCommand(state, { command: "column.show", all: true }, context);
  applyCommand(state, { command: "select", row: 2, column: "b" }, context);
  assert.throws(() => applyCommand(state, { command: "column.hide", names: ["b"] }, context), CommandError);
  assert.equal(JSON.stringify(state), before);
});

test("a failed command throws a CommandError with code invalid_command", () => {
  const context = { table: [], revision: null, view: { columns: [], rowCount: 0, rowIds: true }, page: 1 };
  const state = {
    document: { kind: "vastgrid/document" as const, version: 2 as const },
    session: { kind: "vastgrid/session" as const, version: 2 as const },
  };
  assert.throws(
    () => applyCommand(state, { command: "nope" }, context),
    (error: unknown) =>
      error instanceof CommandError && error.code === "invalid_command" && error.reason === "unknown_command",
  );
  assert.throws(
    () => applyCommand(state, "select", context),
    (error: unknown) => error instanceof CommandError && error.reason === "syntax" && error.path === "/command",
  );
});

/** Freezes a value and everything in it, so that changing any of it throws (modules run in strict mode). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

for (const file of files) {
  test(`commands change nothing they are given: ${file.file}`, async (t) => {
    // Results share what a command does not change with the state it was given (§4.1 of react.md), so a
    // command must copy before it changes: every case runs again on frozen states, commands and contexts.
    const frozen = (state: GridState, command: unknown, context: CommandContext) =>
      applyCommand(
        deepFreeze(structuredClone(state)),
        deepFreeze(structuredClone(command)),
        deepFreeze(structuredClone(context)),
      );
    for (const item of file.cases) {
      await t.test(item.id, () => {
        assert.deepEqual(runCommandCase(file, item, frozen), []);
      });
    }
  });
}

test("a command keeps the objects of what it does not change", () => {
  const state = bigState(3);
  const context = rowsContext(1);
  const moved = applyCommand(state, { command: "move", direction: "down" }, context);
  assert.equal(moved.document, state.document);
  assert.notEqual(moved.session, state.session);
  assert.deepEqual(moved.session.active, { row: 6, column: "name", key: { rowId: 6 } });
  for (const member of ["checked", "detail", "history"] as const)
    assert.equal(moved.session[member], state.session[member]);
  // Moving up from the first row changes nothing: the session itself is kept.
  const top = applyCommand(moved, { command: "move", direction: "up", jump: true }, context);
  assert.equal(applyCommand(top, { command: "move", direction: "up" }, context).session, top.session);
  // A column command keeps the session's members and changes the settings.
  const resized = applyCommand(moved, { command: "column.resize", name: "name", width: 200 }, context);
  assert.equal(resized.session, moved.session);
  assert.notEqual(resized.document.columns, moved.document.columns);
  assert.equal(resized.document.plan, moved.document.plan);
});

test("commands read rows through lookup when the core gives it", () => {
  const state = bigState(0);
  const context: CommandContext = {
    table: COLUMNS,
    revision: "r1",
    view: { columns: COLUMNS, rowCount: 10, rowIds: true },
    page: 5,
    lookup: (row) =>
      row === 5
        ? {
            key: { rowId: 50 },
            has: (column) => column === "name",
            get: (column) => (column === "name" ? "five" : null),
          }
        : undefined,
  };
  const result = applyCommand(
    state,
    { command: "edit.begin" },
    { ...context, capabilities: { write: true } as Capabilities },
  );
  assert.deepEqual(result.session.editor, { row: 5, column: "name", key: { rowId: 50 }, text: "five", value: "five" });
  assert.throws(
    () =>
      applyCommand(
        { ...state, session: { ...state.session, active: { row: 6, column: "name" } } },
        { command: "edit.begin" },
        context,
      ),
    (error: unknown) => error instanceof CommandError && error.reason === "not_loaded",
  );
});
