import assert from "node:assert/strict";
import { test } from "node:test";
import { caseState, isCommandFailure, readCommandCorpus, runCommandCase } from "../src/conformance.ts";
import { applyCommand, COMMANDS, CommandError, checkDocument, checkSession } from "../src/index.ts";
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
