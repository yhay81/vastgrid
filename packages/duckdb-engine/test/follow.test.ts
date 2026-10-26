import assert from "node:assert/strict";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createGridStore, localTransport } from "vastgrid-grid/core";
import { type Client, type Json, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;
let client: Client;
let workspace: string;
const events: Json[] = [];

before(async () => {
  context = await setUp({ saveFiles: true });
  client = context.client;
  workspace = context.workspace;
  context.engine.subscribe((event) => events.push(event));
});

after(async () => {
  await context.tearDown();
});

async function until(done: () => boolean | Promise<boolean>, what = "the condition") {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Waited in vain for ${what}.`);
}

async function opened(name: string, content: string, target = client): Promise<TableInfo> {
  await writeFile(path.join(workspace, name), content);
  const info = await target.open(name);
  assert.equal(info.status, "ready", info.error);
  return info;
}

const info = (table: string, target = client) => target.result<TableInfo & { edits: Json }>("info", { table });

function changedEvents(table: string) {
  return events.filter((event) => event.event === "changed" && event.table === table);
}

/** Replaces a file as editors do: a new file renamed over it. */
async function replace(name: string, content: string) {
  const temporary = path.join(workspace, `.${name}.new`);
  await writeFile(temporary, content);
  // On Windows a rename over a file that another reader has open (DuckDB reading it again, a virus scanner)
  // fails with EPERM until the reader closes it; editors there try again, and so does this.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path.join(workspace, name));
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES") || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("a file without written cells is read again when it changes, and its handles follow it (§7.6)", async () => {
  const first = await opened("follow.csv", "a,b\n1,x\n2,y\n");
  const second = await client.open("follow.csv");
  await replace("follow.csv", "a,b\n1,x\n2,y\n3,z\n");
  await until(async () => (await info(first.table)).revision !== first.revision, "the new revision");
  for (const handle of [first, second]) {
    const now = await info(handle.table);
    assert.equal(now.fileChanged, undefined);
    await context.engine.whenLoaded(handle.table);
    assert.deepEqual((await client.rows(now)).rows, [
      [1, "x"],
      [2, "y"],
      [3, "z"],
    ]);
    await until(() => changedEvents(handle.table).some((event) => event.revision === now.revision), "the event");
  }
  // Reading with the old revision is refused: positions and row IDs belong to a revision (§5.4).
  const stale = await client.error("rows", {
    table: first.table,
    revision: first.revision,
    plan: {},
    start: 0,
    end: 10,
    columns: ["a"],
  });
  assert.equal(stale.code, "revision_changed");
});

test("a table with written cells stays as it was read, tells fileChanged, and reload follows the file (§7.6)", async () => {
  const edited = await opened("kept.csv", "a,b\n1,x\n2,y\n");
  const other = await client.open("kept.csv");
  await client.result("write", {
    table: edited.table,
    revision: edited.revision,
    updates: [{ key: { rowId: 0 }, column: "b", value: "mine" }],
  });
  await replace("kept.csv", "a,b\n1,theirs\n2,y\n3,z\n");
  await until(async () => (await info(edited.table)).fileChanged === true, "fileChanged");
  const kept = await info(edited.table);
  assert.equal(kept.revision, edited.revision);
  assert.deepEqual(kept.edits, { version: 1, cells: 1 });
  await until(() => changedEvents(edited.table).some((event) => event.fileChanged === true), "the event");
  assert.deepEqual(await client.result("changes", { table: edited.table }), {
    revision: edited.revision,
    edits: { version: 1, cells: 1 },
    fileChanged: true,
  });
  // The written cells stay readable and writable, but are not saved over the other change.
  await client.result("write", {
    table: edited.table,
    revision: edited.revision,
    updates: [{ key: { rowId: 1 }, column: "b", value: "more" }],
  });
  assert.equal((await client.error("save", { table: edited.table })).code, "file_changed");

  // `reload` moves one handle to the file as it is; the other keeps the written cells.
  const reloaded = await client.result<TableInfo & { edits: Json }>("reload", { table: edited.table });
  assert.notEqual(reloaded.revision, edited.revision);
  assert.equal(reloaded.fileChanged, undefined);
  assert.deepEqual(reloaded.edits, { version: 0, cells: 0 });
  await context.engine.whenLoaded(edited.table);
  assert.deepEqual((await client.rows(reloaded)).rows, [
    [1, "theirs"],
    [2, "y"],
    [3, "z"],
  ]);
  const still = await info(other.table);
  assert.equal(still.fileChanged, true);
  assert.deepEqual((await client.rows(still)).rows, [
    [1, "mine"],
    [2, "more"],
  ]);
  // Reloading a handle whose file has not changed changes nothing.
  const same = await client.result<TableInfo>("reload", { table: edited.table });
  assert.equal(same.revision, reloaded.revision);
  // The last handle of the old table reloads too: the old table and its written cells are gone.
  const last = await client.result<TableInfo>("reload", { table: other.table });
  assert.equal(last.revision, reloaded.revision);
});

test("the engine's own save is not a change of the file", async () => {
  const table = await opened("own.csv", "a,b\n1,x\n");
  await client.result("write", {
    table: table.table,
    revision: table.revision,
    updates: [{ key: { rowId: 0 }, column: "b", value: "saved" }],
  });
  await client.result("save", { table: table.table });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const now = await info(table.table);
  assert.equal(now.revision, table.revision);
  assert.equal(now.fileChanged, undefined);
  assert.ok(!changedEvents(table.table).some((event) => event.fileChanged === true));
});

test("a removed file keeps its table until it comes back, then is read again", async () => {
  const table = await opened("removed.csv", "a\n1\n");
  await rm(path.join(workspace, "removed.csv"));
  await until(async () => (await info(table.table)).fileChanged === true, "fileChanged");
  assert.equal((await client.error("reload", { table: table.table })).code, "load_failed");
  assert.deepEqual((await client.rows(await info(table.table))).rows, [[1]]);
  await writeFile(path.join(workspace, "removed.csv"), "a\n1\n2\n");
  await until(async () => (await info(table.table)).revision !== table.revision, "the new revision");
  const back = await info(table.table);
  assert.equal(back.fileChanged, undefined);
  await context.engine.whenLoaded(table.table);
  assert.deepEqual((await client.rows(back)).rows, [[1], [2]]);
});

test("without watching, `changes` checks the file (§8.5)", async () => {
  const polling = await setUp({ watchFiles: false });
  try {
    await writeFile(path.join(polling.workspace, "polled.csv"), "a\n1\n");
    const table = await polling.client.open("polled.csv");
    await writeFile(path.join(polling.workspace, "polled.csv"), "a\n1\n2\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await polling.client.result<TableInfo>("info", { table: table.table })).revision, table.revision);
    const changes = await polling.client.result<{ revision: string }>("changes", { table: table.table });
    assert.notEqual(changes.revision, table.revision);
  } finally {
    await polling.tearDown();
  }
});

test("the grid's store follows a file that changes, and reloads one whose written cells it keeps", async () => {
  await writeFile(path.join(workspace, "grid.csv"), "id,name\n1,Ann\n2,Bob\n");
  const store = createGridStore({ transport: localTransport(context.engine), table: "grid.csv" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "name"] });
  await until(() => store.getSnapshot().view !== null && store.cell(1, "name") === "Bob", "the rows");

  await replace("grid.csv", "id,name\n1,Ann\n2,Bob\n3,Cy\n");
  await until(() => store.cell(2, "name") === "Cy", "the new row");
  // The view of the new table is read whole: nothing stays "building".
  await until(() => store.getSnapshot().view?.status === "ready" && store.getSnapshot().pending === null, "the view");

  await store.dispatch({ command: "select", row: 0, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "" });
  store.dispatchSync({ command: "edit.change", text: "Anne" });
  assert.deepEqual(await store.dispatch({ command: "edit.commit", move: null }), { ok: true });
  await until(() => store.getSnapshot().table?.edits.cells === 1, "the write");
  await replace("grid.csv", "id,name\n1,Ann\n2,Bea\n3,Cy\n");
  await until(() => store.getSnapshot().table?.fileChanged === true, "fileChanged");
  assert.equal(store.cell(0, "name"), "Anne");
  assert.equal(store.cell(1, "name"), "Bob");

  await store.reload();
  await until(() => store.cell(1, "name") === "Bea" && store.getSnapshot().pending === null, "the reloaded rows");
  assert.equal(store.cell(0, "name"), "Ann");
  assert.equal(store.getSnapshot().table?.fileChanged, undefined);
  assert.equal(store.getSnapshot().table?.edits.cells, 0);
  await until(() => store.getSnapshot().view?.status === "ready", "the reloaded view");
  disconnect();
});
