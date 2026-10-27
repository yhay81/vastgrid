/**
 * vastgrid's MCP server (docs/mcp-app.md) through an MCP client: the agent's tools, and an App's grid that reads
 * rows through `vastgrid_message` and follows the grid with `grid_sync`, as the page in a host does.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import type { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { GridStore } from "vastgrid/core";
import { DuckDBEngine } from "vastgrid-duckdb";
import type { GridDocument, GridSession } from "vastgrid-spec";
import { callTool, mcpTransport, sync } from "../app/transport.ts";
import { APP_URI, type Grids, registerVastgrid } from "../src/index.ts";

type Json = Record<string, unknown>;

let folder: string;
let outside: string;
let engine: DuckDBEngine;
let grids: Grids;
let client: Client;
/** The host's side for an App: tool calls of the server, as `App.callServerTool` makes them. */
let app: App;

before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "vastgrid-mcp-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "vastgrid-mcp-outside-"));
  await writeFile(path.join(folder, "orders.csv"), "id,region,price\n1,EU,10.5\n2,US,30\n3,EU,20\n4,JP,5\n");
  await writeFile(path.join(outside, "secret.csv"), "a\n1\n");
  engine = await DuckDBEngine.create({
    allowedDirectories: [folder],
    tempDirectory: path.join(folder, ".tmp"),
    saveFiles: true,
  });
  const server = new McpServer({ name: "vastgrid", version: "0.0.0" });
  grids = registerVastgrid(server, {
    engine,
    folders: [folder],
    html: async () => "<!doctype html><title>vastgrid</title>",
    wait: 300,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  app = { callServerTool: (params, options) => client.callTool(params, options) } as App;
});

after(async () => {
  await client.close();
  grids.dispose();
  await engine.dispose();
  await rm(folder, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function call(name: string, args: Json) {
  const answer = await client.callTool({ name, arguments: args });
  return { error: answer.isError === true, content: (answer.structuredContent ?? {}) as Json };
}

async function open(document?: Json) {
  const opened = await call("open_grid", { file: "orders.csv", ...(document ? { document } : {}) });
  assert.equal(opened.error, false, JSON.stringify(opened.content));
  return opened.content as Json & { grid: string; document: GridDocument; session: GridSession; version: number };
}

/** An App's grid: a store that reads through the host's tool calls and takes what `grid_sync` gives. */
async function appGrid(grid: string, document: GridDocument) {
  const link = { grid, client: crypto.randomUUID() };
  const transport = mcpTransport(app, link);
  const store = new GridStore({ transport, table: "orders.csv", document });
  const stop = store.connect();
  let version = -1;
  const take = async (state: { document?: GridDocument; session?: GridSession } = {}) => {
    const answer = await sync(app, link, { version, ...state });
    transport.deliver(answer.events);
    version = Math.max(version, answer.version);
    if (answer.document) store.setDocument(answer.document);
    if (answer.session) store.setSession(answer.session);
    return answer;
  };
  // Until the view is read, as the App's loop of `grid_sync` does, the store gets the engine's events: a table that
  // was still loading when it opened, or a view still being made, is read once their events come. A version that no
  // change is newer than leaves the document and the session to `take`.
  const ready = async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const snapshot = store.getSnapshot();
      if (snapshot.status === "error") throw snapshot.error ?? new Error("The App's grid failed.");
      const read = snapshot.table?.status === "ready" && snapshot.view?.status === "ready";
      if (snapshot.status === "ready" && read && !snapshot.pending) return;
      if (Date.now() > deadline) {
        const { status, table, view, pending } = snapshot;
        const state = { status, table: table?.status, view: view?.status, pending: pending?.plan };
        throw new Error(`The App's grid is not ready: ${JSON.stringify(state)}`);
      }
      const answer = await sync(app, link, { version: Number.MAX_SAFE_INTEGER });
      transport.deliver(answer.events);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await ready();
  return { store, take, ready, stop };
}

test("the server lists the agent's tools and the App's, and serves the App's page", async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ["list_files", "open_grid", "grid_state", "grid_rows", "grid_command"])
    assert.ok(byName.has(name));
  const ui = (name: string) =>
    (byName.get(name)?._meta as { ui?: { resourceUri?: string; visibility?: string[] } })?.ui;
  assert.equal(ui("open_grid")?.resourceUri, APP_URI);
  assert.deepEqual(ui("vastgrid_message")?.visibility, ["app"]);
  assert.deepEqual(ui("grid_sync")?.visibility, ["app"]);
  // The core's own commands (§6.7) are not offered to the agent.
  assert.doesNotMatch(String(byName.get("grid_command")?.description), /history\.push|view\.update/);
  const page = await client.readResource({ uri: APP_URI });
  const content = page.contents[0] as { mimeType?: string; text?: string };
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert.match(String(content.text), /<title>vastgrid<\/title>/);
  const files = await call("list_files", {});
  assert.deepEqual(files.content.files, [path.join(folder, "orders.csv")]);
});

test("open_grid opens files of the allowed folders only, and grid tools need a grid that exists", async () => {
  const outsideFile = await call("open_grid", { file: path.join(outside, "secret.csv") });
  assert.deepEqual([outsideFile.error, (outsideFile.content.error as Json).code], [true, "not_allowed"]);
  const missing = await call("grid_state", { grid: "g0-none" });
  assert.deepEqual([missing.error, (missing.content.error as Json).code], [true, "grid_not_found"]);
  const opened = await open();
  assert.deepEqual(
    (opened.columns as Json[]).map((column) => column.name),
    ["id", "region", "price"],
  );
  assert.equal((opened.view as Json).rowCount, 4);
});

test("the agent's commands reach the App, and the person's changes reach the agent", async () => {
  const opened = await open();
  const grid = await appGrid(opened.grid, opened.document);
  try {
    // The agent sorts: the App's grid follows, and reads the sorted rows through the engine.
    const sorted = await call("grid_command", {
      grid: opened.grid,
      command: { command: "sort.set", keys: [{ column: "price", direction: "desc" }] },
    });
    assert.equal(sorted.error, false, JSON.stringify(sorted.content));
    const answer = await grid.take();
    assert.deepEqual(answer.document?.plan?.sort, [{ column: "price", direction: "desc" }]);
    await grid.ready();
    grid.store.ensure(0, 4, ["id"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      [0, 1, 2, 3].map((row) => grid.store.cell(row, "id")),
      [2, 3, 1, 4],
    );
    const rows = await call("grid_rows", { grid: opened.grid, columns: ["id", "price"] });
    assert.deepEqual((rows.content as { rows: unknown[] }).rows, [
      [2, 30],
      [3, 20],
      [1, 10.5],
      [4, 5],
    ]);
    // The person selects a cell and filters: the agent reads both.
    await grid.store.dispatch({ command: "select", row: 1, column: "region" });
    await grid.store.dispatch({
      command: "filter.column",
      column: "region",
      where: { fn: "eq", args: [{ col: "region" }, { lit: "EU" }] },
    });
    const snapshot = grid.store.getSnapshot();
    await grid.take({ document: snapshot.document, session: snapshot.session });
    const state = (await call("grid_state", { grid: opened.grid })).content as Json & {
      document: GridDocument;
      session: GridSession;
    };
    assert.deepEqual(state.session.active?.column, "region");
    assert.ok(state.document.plan?.where);
    const filtered = await call("grid_rows", { grid: opened.grid, columns: ["id"] });
    assert.deepEqual((filtered.content as { rows: unknown[] }).rows, [[3], [1]]);
  } finally {
    grid.stop();
  }
});

test("columns, the search and the sort go both ways, and an App that starts again gets them all", async () => {
  const opened = await open();
  const grid = await appGrid(opened.grid, opened.document);
  try {
    // The agent sets how columns show: the App takes the document's columns.
    for (const command of [
      { command: "column.resize", name: "price", width: 180 },
      { command: "column.pin", name: "id", side: "left" },
      { command: "column.format", name: "price", format: { label: "Price" } },
    ]) {
      const done = await call("grid_command", { grid: opened.grid, command });
      assert.equal(done.error, false, JSON.stringify(done.content));
    }
    const answer = await grid.take();
    assert.deepEqual(answer.document?.columns, grid.store.getSnapshot().document.columns);
    const shown = new Map((grid.store.getSnapshot().document.columns ?? []).map((item) => [item.name, item]));
    assert.deepEqual(
      [shown.get("price")?.width, shown.get("id")?.pin, shown.get("price")?.format?.label],
      [180, "left", "Price"],
    );

    // The person searches, sorts by a header and hides a column: the agent reads the same view.
    await grid.store.dispatch({ command: "search.set", text: "EU" });
    await grid.store.dispatch({ command: "sort.toggle", column: "id" });
    await grid.store.dispatch({ command: "sort.toggle", column: "id" });
    await grid.store.dispatch({ command: "column.hide", names: ["region"] });
    await grid.take({ document: grid.store.getSnapshot().document });
    const state = (await call("grid_state", { grid: opened.grid })).content as Json & {
      document: GridDocument;
      columns: { name: string; label?: string }[];
    };
    assert.deepEqual(state.document.plan?.sort, [{ column: "id", direction: "desc" }]);
    assert.deepEqual(
      state.columns.map((column) => column.name),
      ["id", "price"],
    );
    assert.equal(state.columns[1].label, "Price");
    const rows = await call("grid_rows", { grid: opened.grid });
    assert.deepEqual((rows.content as { rows: unknown[] }).rows, [
      [3, 20],
      [1, 10.5],
    ]);

    // The agent selects two rows: the App shows the same selection.
    const selected = await call("grid_command", {
      grid: opened.grid,
      command: { command: "select.rows", from: 0, to: 1 },
    });
    assert.equal(selected.error, false, JSON.stringify(selected.content));
    const selection = await grid.take();
    const agents = (await call("grid_state", { grid: opened.grid })).content as Json & { session: GridSession };
    assert.deepEqual(agents.session.selection, [{ rows: [0, 2], columns: "all" }]);
    assert.deepEqual(selection.session?.selection, agents.session.selection);

    // An App that loads again starts from version −1 and gets the whole state.
    const again = await appGrid(opened.grid, opened.document);
    try {
      const whole = await again.take();
      const now = (await call("grid_state", { grid: opened.grid })).content as Json & { session: GridSession };
      assert.deepEqual(whole.document, state.document);
      assert.deepEqual(whole.session, now.session);
    } finally {
      again.stop();
    }
  } finally {
    grid.stop();
  }
});

test("the agent writes cells with the commands of the grid, and the App reads what it wrote", async () => {
  const opened = await open();
  const grid = await appGrid(opened.grid, opened.document);
  try {
    for (const command of [
      { command: "select", row: 0, column: "price" },
      { command: "edit.begin", text: "99.5" },
      { command: "edit.commit" },
    ]) {
      const done = await call("grid_command", { grid: opened.grid, command });
      assert.equal(done.error, false, JSON.stringify(done.content));
    }
    const state = (await call("grid_state", { grid: opened.grid })).content as { table: { edits: number } };
    assert.equal(state.table.edits, 1);
    const rows = await call("grid_rows", { grid: opened.grid, columns: ["id", "price"], count: 1 });
    assert.deepEqual((rows.content as { rows: unknown[] }).rows, [[1, 99.5]]);
    // The engine's event of the write comes to the App with the state, and its grid reads the new value.
    const answer = await grid.take();
    assert.ok(answer.events.some((event) => (event as Json).event === "changed"));
    assert.ok(answer.session?.history?.undo.length);
    await new Promise((resolve) => setTimeout(resolve, 100));
    grid.store.ensure(0, 1, ["price"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(grid.store.cell(0, "price"), 99.5);
    // Undo goes through the same path.
    assert.equal(
      (await call("grid_command", { grid: opened.grid, command: { command: "history.undo" } })).error,
      false,
    );
    const undone = await call("grid_rows", { grid: opened.grid, columns: ["price"], count: 1 });
    assert.deepEqual((undone.content as { rows: unknown[] }).rows, [[10.5]]);
  } finally {
    grid.stop();
  }
});

test("commands that fail tell why and change nothing; the core's own commands are refused", async () => {
  const opened = await open();
  const before = ((await call("grid_state", { grid: opened.grid })).content as { version: number }).version;
  const unknown = await call("grid_command", {
    grid: opened.grid,
    command: { command: "sort.toggle", column: "nope" },
  });
  assert.equal(unknown.error, true);
  assert.deepEqual(
    [(unknown.content.error as Json).code, (unknown.content.error as Json).reason],
    ["invalid_command", "unknown_column"],
  );
  const core = await call("grid_command", { grid: opened.grid, command: { command: "history.push", updates: [] } });
  assert.deepEqual(
    [(core.content.error as Json).code, (core.content.error as Json).reason],
    ["invalid_command", "unknown_command"],
  );
  const state = (await call("grid_state", { grid: opened.grid })).content as { version: number };
  assert.equal(state.version, before);
});

test("a change of the agent wins over the App's change of the same part made from an older version", async () => {
  const opened = await open();
  const link = { grid: opened.grid, client: "a" };
  // An App that starts (or starts again) gets the whole state.
  const first = await sync(app, link, { version: -1 });
  assert.ok(first.document && first.session);
  await call("grid_command", {
    grid: opened.grid,
    command: { command: "sort.set", keys: [{ column: "id", direction: "desc" }] },
  });
  // The App changed the document from the version it had: the agent's is newer, so it stays and comes back.
  const stale = await sync(app, link, {
    version: first.version,
    document: { ...opened.document, plan: { sort: [{ column: "price", direction: "asc" }] } },
  });
  assert.deepEqual(stale.document?.plan?.sort, [{ column: "id", direction: "desc" }]);
  // From the newer version, the App's change is taken and is not sent back to it, but to another App.
  const taken = await sync(app, link, {
    version: stale.version,
    document: { ...opened.document, plan: { sort: [{ column: "price", direction: "asc" }] } },
  });
  assert.equal(taken.document, undefined);
  const other = await sync(app, { grid: opened.grid, client: "b" }, { version: stale.version });
  assert.deepEqual(other.document?.plan?.sort, [{ column: "price", direction: "asc" }]);
  // With nothing new, sync waits, then answers with the version it has.
  const started = Date.now();
  const idle = await sync(app, link, { version: taken.version });
  assert.ok(Date.now() - started >= 250);
  assert.deepEqual([idle.version, idle.document, idle.events], [taken.version, undefined, []]);
  // A state that does not follow §5 is refused.
  await assert.rejects(
    callTool(app, "grid_sync", { grid: opened.grid, client: "a", version: 0, document: { kind: "x" } }),
  );
});

test("App requests keep their ids apart from the grid's, and invalid messages are answered by §8", async () => {
  const opened = await open();
  const answer = (await callTool(app, "vastgrid_message", {
    grid: opened.grid,
    client: "a",
    message: { v: 2, id: 1, op: "open", ref: "orders.csv" },
  })) as Json & { result: { table: string } };
  assert.equal(answer.id, 1);
  const invalid = await callTool(app, "vastgrid_message", {
    grid: opened.grid,
    client: "a",
    message: { v: 2, id: 2, op: "rows", table: answer.result.table },
  });
  assert.deepEqual([invalid.id, (invalid.error as Json).code], [2, "invalid_request"]);
  const rows = (await callTool(app, "vastgrid_message", {
    grid: opened.grid,
    client: "a",
    message: {
      v: 2,
      id: 3,
      op: "rows",
      table: answer.result.table,
      revision: null,
      plan: {},
      start: 0,
      end: 1,
      columns: ["id"],
    },
  })) as Json;
  // The revision is the table's, so the request fails; the answer still carries the App's id.
  assert.deepEqual([rows.id, (rows.error as Json | undefined)?.code ?? "ok"], [3, "revision_changed"]);
});

test("the agent saves written cells into the CSV file, with the grid's `save` command (§7.5)", async () => {
  const file = path.join(folder, "save.csv");
  await writeFile(file, "id,name\n1,Ann\n2,Bob\n");
  const opened = await call("open_grid", { file: "save.csv" });
  assert.equal(opened.error, false, JSON.stringify(opened.content));
  const grid = (opened.content as { grid: string }).grid;
  for (const command of [
    { command: "select", row: 1, column: "name" },
    { command: "edit.begin", text: "Bea" },
    { command: "edit.commit" },
    { command: "save" },
  ]) {
    const done = await call("grid_command", { grid, command });
    assert.equal(done.error, false, JSON.stringify(done.content));
  }
  assert.equal(await readFile(file, "utf8"), "id,name\n1,Ann\n2,Bea\n");
  const state = (await call("grid_state", { grid })).content as { table: { edits: number } };
  assert.equal(state.table.edits, 0);
});
