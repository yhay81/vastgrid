/**
 * The extension's side of vastgrid's VS Code editor (docs/vscode.md) without VS Code: a `TableFile` with webviews
 * whose grids talk to it by messages as the page does, and VS Code's save, save as, revert, undo and backups.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type GridSnapshot, GridStore, type WorkerLike, workerTransport } from "vastgrid-grid/core";
import { newSteps } from "../src/history.ts";
import type { HostMessage } from "../src/messages.ts";
import { type FileKey, type FileView, type KeptFile, TableFile, type TableFileOptions } from "../src/table-file.ts";

let folder: string;
let temp: string;
const CSV = 'id,region,price\r\n1,EU,10.5\r\n2,"US, east",30\r\n3,EU,20\r\n';

before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "vastgrid-vscode-"));
  temp = path.join(folder, ".tmp");
});

after(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function csvFile(name: string, text = CSV) {
  const file = path.join(folder, name);
  await writeFile(file, text);
  return file;
}

function tableFile(file: string, options: Partial<TableFileOptions> = {}) {
  return new TableFile(file, { tempDirectory: temp, editable: true, ...options });
}

/**
 * A webview of the file: a grid whose transport carries messages as the page's does, which answers the extension's
 * commands and tells it of the grid's new steps of history, as the page does; and what the host posts.
 */
function webview(file: TableFile) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const own: HostMessage[] = [];
  const view = file.connect((message) => {
    // Messages arrive later, as a webview's do.
    setTimeout(() => {
      if ((message as { vastgrid?: unknown }).vastgrid !== undefined) own.push(message as HostMessage);
      for (const listener of listeners) listener({ data: message } as MessageEvent);
    });
  });
  const port: WorkerLike = {
    postMessage: (message) => view.receive(structuredClone(message)),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const open = () => {
    const store = new GridStore({ transport: workerTransport(port), table: file.ref });
    let history = store.getSnapshot().session.history;
    const stopHistory = store.on("session", (session) => {
      const added = newSteps(history, session.history);
      history = session.history;
      for (let step = 0; step < added; step++) view.receive({ vastgrid: "edit" });
    });
    const disconnect = store.connect();
    return {
      store,
      disconnect: () => {
        stopHistory();
        disconnect();
      },
    };
  };
  let grid = open();
  listeners.add((event) => {
    const message = event.data as HostMessage;
    if (message.vastgrid !== "dispatch") return;
    void grid.store
      .dispatch(message.command as never)
      .then((outcome) =>
        view.receive(
          outcome.ok
            ? { vastgrid: "answer", call: message.call, ok: true, output: outcome.output }
            : { vastgrid: "answer", call: message.call, ok: false, error: { code: outcome.error.code, message: "" } },
        ),
      );
  });
  // The grid takes the extension's commands, as the page's does once it shows.
  view.receive({ vastgrid: "listening", on: true });
  return {
    view,
    own,
    get store() {
      return grid.store;
    },
    /** Opens the file anew, as the page does on `restart`. */
    reopen() {
      grid.disconnect();
      grid = open();
    },
    close() {
      grid.disconnect();
      view.dispose();
    },
  };
}

/** Waits until the grid shows the view of its document. */
function settled(store: GridStore): Promise<GridSnapshot> {
  const ready = (snapshot: GridSnapshot) =>
    (snapshot.status === "ready" && snapshot.view && !snapshot.pending) || snapshot.status === "error";
  if (ready(store.getSnapshot())) return Promise.resolve(store.getSnapshot());
  return new Promise((resolve) => {
    const stop = store.subscribe(() => {
      if (!ready(store.getSnapshot())) return;
      stop();
      resolve(store.getSnapshot());
    });
  });
}

/** Reads a cell of the view, once its rows are on screen. */
async function cell(store: GridStore, row: number, column: string) {
  for (let tries = 0; tries < 50; tries++) {
    store.ensure(0, row + 1, [column]);
    const value = store.cell(row, column);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Row ${row} of ${column} was not read.`);
}

async function write(store: GridStore, row: number, column: string, text: string) {
  for (const command of [
    { command: "select", row, column },
    { command: "edit.begin", text },
    { command: "edit.commit" },
  ] as const) {
    const outcome = await store.dispatch(command);
    if (!outcome.ok) return outcome;
  }
  return { ok: true as const };
}

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("The condition never held.");
}

test("webviews read the file through the extension, write its cells, and VS Code saves them", async () => {
  const file = tableFile(await csvFile("orders.csv"));
  const edits: FileView[] = [];
  file.onEdit((view) => edits.push(view));
  const left = webview(file);
  const right = webview(file);
  try {
    const snapshot = await settled(left.store);
    assert.equal(snapshot.status, "ready");
    // The grid writes cells, and saves through VS Code, not by itself.
    assert.equal(snapshot.table?.capabilities.write, true);
    assert.equal(snapshot.table?.capabilities.save, false);
    await settled(right.store);
    assert.equal(await cell(left.store, 1, "region"), "US, east");

    assert.deepEqual(await write(left.store, 0, "price", "99.5"), { ok: true });
    // The write is an edit of the file, of the editor whose grid made it.
    await eventually(() => edits.length === 1);
    assert.equal(edits[0], left.view);
    // The other editor of the file reads what this one wrote, through the engine's event.
    await eventually(async () => right.store.getSnapshot().table?.edits.cells === 1);
    await eventually(async () => (await cell(right.store, 0, "price")) === 99.5);
    // VS Code undoes and redoes the edit in that grid; neither is an edit of its own.
    await left.view.dispatch({ command: "history.undo" });
    await eventually(async () => (await cell(right.store, 0, "price")) === 10.5);
    await left.view.dispatch({ command: "history.redo" });
    await eventually(async () => (await cell(right.store, 0, "price")) === 99.5);
    assert.equal(edits.length, 1);

    assert.equal(await file.save(), 1);
    assert.equal(
      await readFile(file.file, "utf8"),
      'id,region,price\r\n1,EU,99.5\r\n2,"US, east",30\r\n3,EU,20\r\n',
      "only the edited field is written anew",
    );
    await eventually(() => left.store.getSnapshot().table?.edits.cells === 0);
    // Nothing more to save.
    assert.equal(await file.save(), 0);
    // A write after the save is undone back to the saved value.
    assert.deepEqual(await write(left.store, 0, "price", "77"), { ok: true });
    await eventually(() => edits.length === 2);
    await edits[1]?.dispatch({ command: "history.undo" });
    await eventually(async () => (await cell(left.store, 0, "price")) === 99.5);
  } finally {
    left.close();
    right.close();
    await file.dispose();
  }
});

test("a file that is not saved as it was read, or of a workspace not trusted, opens read-only", async () => {
  const csv = await csvFile("plain.csv");
  const untrusted = tableFile(csv, { editable: false });
  const compressed = tableFile(await csvFile("packed.csv.gz", ""), {});
  try {
    assert.equal(untrusted.editable, false);
    assert.equal(compressed.editable, false);
    const grid = webview(untrusted);
    const snapshot = await settled(grid.store);
    assert.equal(snapshot.table?.capabilities.write, false);
    const outcome = await write(grid.store, 0, "price", "1");
    assert.equal(outcome.ok, false);
    await assert.rejects(untrusted.save(), { code: "save_unsupported" });
    grid.close();
  } finally {
    await untrusted.dispose();
    await compressed.dispose();
  }
});

test("a file opened read-only opens anew, editable, once VS Code trusts the workspace", async () => {
  const file = tableFile(await csvFile("trusted.csv"), { editable: false });
  const grid = webview(file);
  try {
    assert.equal((await settled(grid.store)).table?.capabilities.write, false);
    await file.trust();
    assert.equal(file.editable, true);
    await eventually(() => grid.own.some((message) => message.vastgrid === "restart"));
    grid.reopen();
    assert.equal((await settled(grid.store)).table?.capabilities.write, true);
    assert.deepEqual(await write(grid.store, 0, "price", "2"), { ok: true });
    assert.equal(await file.save(), 1);
  } finally {
    grid.close();
    await file.dispose();
  }
});

test("save as writes the table with its written cells in the format of the new name", async () => {
  const file = tableFile(await csvFile("source.csv"));
  const grid = webview(file);
  try {
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 2, "region", "JP"), { ok: true });
    const parquet = path.join(folder, "copy.parquet");
    assert.equal(await file.saveAs(parquet), 3);
    await assert.rejects(file.saveAs(path.join(folder, "copy.txt")), { code: "invalid_request" });
    // The copy opens read-only, with the written cell.
    const copy = tableFile(parquet);
    const reader = webview(copy);
    try {
      const snapshot = await settled(reader.store);
      assert.equal(snapshot.table?.capabilities.write, false);
      assert.equal(snapshot.table?.rowCount, 3);
      assert.equal(await cell(reader.store, 2, "region"), "JP");
    } finally {
      reader.close();
      await copy.dispose();
    }
    // The source keeps its bytes until it is saved.
    assert.equal(await readFile(file.file, "utf8"), CSV);
  } finally {
    grid.close();
    await file.dispose();
  }
});

test("a file changed on disk since it was read is not saved over, and save as keeps the written cells", async () => {
  const file = tableFile(await csvFile("theirs.csv"));
  const grid = webview(file);
  try {
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 2, "region", "JP"), { ok: true });
    const theirs = CSV.replace("3,EU,20", "3,EU,25");
    await writeFile(file.file, theirs);
    await assert.rejects(file.save(), { code: "file_changed" });
    assert.equal(await readFile(file.file, "utf8"), theirs);
    const copy = path.join(folder, "mine.csv");
    assert.equal(await file.saveAs(copy), 3);
    assert.equal(await readFile(copy, "utf8"), 'id,region,price\n1,EU,10.5\n2,"US, east",30.0\n3,JP,20.0\n');
  } finally {
    grid.close();
    await file.dispose();
  }
});

test("revert drops the written cells: the engine starts again and the webviews open the file anew", async () => {
  const file = tableFile(await csvFile("revert.csv"));
  const grid = webview(file);
  try {
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 0, "region", "XX"), { ok: true });
    await file.revert();
    await eventually(() => grid.own.some((message) => message.vastgrid === "restart"));
    grid.reopen();
    const snapshot = await settled(grid.store);
    assert.equal(snapshot.table?.edits.cells, 0);
    assert.equal(await cell(grid.store, 0, "region"), "EU");
    assert.equal(await file.save(), 0);
    assert.equal(await readFile(file.file, "utf8"), CSV);
  } finally {
    grid.close();
    await file.dispose();
  }
});

test("exports go where the person chooses, and a cancelled choice fails the export", async () => {
  const chosen: KeptFile[] = [];
  let answer = true;
  const file = tableFile(await csvFile("export.csv"), {
    exportTo: async (kept) => {
      chosen.push(kept);
      return answer;
    },
  });
  const grid = webview(file);
  try {
    const snapshot = await settled(grid.store);
    assert.ok(snapshot.table?.capabilities.export);
    const done = await grid.store.dispatch({ command: "export", format: "csv", rows: "view", columns: "all" });
    assert.equal(done.ok, true);
    assert.equal((done.ok && (done.output as { target: unknown }).target) || null, null);
    assert.equal(chosen.length, 1);
    assert.match(chosen[0]?.fileName ?? "", /\.csv$/);
    assert.equal(
      await readFile(chosen[0]?.path ?? "", "utf8"),
      'id,region,price\n1,EU,10.5\n2,"US, east",30.0\n3,EU,20.0\n',
    );
    answer = false;
    const cancelled = await grid.store.dispatch({ command: "export", format: "csv", rows: "view", columns: "all" });
    assert.equal(cancelled.ok, false);
    assert.equal(!cancelled.ok && cancelled.error.code, "cancelled");
  } finally {
    grid.close();
    await file.dispose();
  }
  // Without a place to choose, the grid offers no export.
  const plain = tableFile(file.file);
  const reader = webview(plain);
  try {
    assert.equal((await settled(reader.store)).table?.capabilities.export, undefined);
  } finally {
    reader.close();
    await plain.dispose();
  }
});

test("the extension's commands reach a webview's grid, and the keys that save, undo and redo reach VS Code", async () => {
  const file = tableFile(await csvFile("commands.csv"));
  const grid = webview(file);
  const keys: FileKey[] = [];
  file.onKey((key) => keys.push(key));
  try {
    await settled(grid.store);
    await grid.view.dispatch({ command: "sort.toggle", column: "price" });
    assert.deepEqual(grid.store.getSnapshot().document.plan?.sort, [{ column: "price", direction: "asc" }]);
    await assert.rejects(grid.view.dispatch({ command: "sort.toggle", column: "nope" }), { code: "invalid_command" });
    for (const key of ["save", "undo", "redo"] as const) grid.view.receive({ vastgrid: key });
    assert.deepEqual(keys, ["save", "undo", "redo"]);
  } finally {
    grid.close();
    await file.dispose();
  }
  // An editor that was closed takes no command: VS Code's undo of its edit fails at once.
  await assert.rejects(grid.view.dispatch({ command: "history.undo" }), { code: "cancelled" });
});

test("a backup holds the cells written since the file was saved, and the file written from it gets them again", async () => {
  const csv = await csvFile("backup.csv");
  const file = tableFile(csv);
  const grid = webview(file);
  let backup: ReturnType<TableFile["backup"]>;
  let cells: number | undefined;
  try {
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 0, "region", "JP"), { ok: true });
    const version = grid.store.getSnapshot().table?.edits.version;
    assert.equal(await file.save(), 1);
    assert.deepEqual(file.backup().writes, [], "the file holds what was saved");
    // The grid follows the save's `changed` event before it writes again.
    await eventually(() => grid.store.getSnapshot().table?.edits.version !== version);
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 1, "price", "31"), { ok: true });
    assert.deepEqual(await write(grid.store, 2, "region", "UK"), { ok: true });
    assert.equal((await grid.store.dispatch({ command: "history.undo" })).ok, true);
    backup = structuredClone(file.backup());
    assert.equal(backup.writes.length, 3);
    cells = grid.store.getSnapshot().table?.edits.cells;
  } finally {
    grid.close();
    await file.dispose();
  }

  // VS Code opens the file from the backup (hot exit): the cells are written again, in order.
  const restored = tableFile(csv, { restore: backup });
  const again = webview(restored);
  try {
    const snapshot = await settled(again.store);
    assert.equal(snapshot.table?.edits.cells, cells);
    assert.equal(await cell(again.store, 1, "price"), 31);
    assert.equal(await cell(again.store, 2, "region"), "EU");
    assert.equal(await cell(again.store, 0, "region"), "JP");
    assert.equal(restored.backup().writes.length, 3);
  } finally {
    again.close();
    await restored.dispose();
  }

  // A file that changed since the backup gets none of its cells, and the person is told.
  await writeFile(csv, `${CSV}4,EU,1\r\n`);
  let missed = 0;
  const changed = tableFile(csv, { restore: backup, notRestored: (writes) => (missed = writes) });
  const reader = webview(changed);
  try {
    const snapshot = await settled(reader.store);
    assert.equal(snapshot.table?.edits.cells, 0);
    assert.equal(missed, 3);
  } finally {
    reader.close();
    await changed.dispose();
  }
});

test("written cells outlive the handles of a page that loads again", async () => {
  const file = tableFile(await csvFile("reload.csv"));
  const grid = webview(file);
  try {
    await settled(grid.store);
    assert.deepEqual(await write(grid.store, 0, "price", "1"), { ok: true });
    // The page loads again (Developer: Reload Webviews): its handles close before it opens the file anew.
    grid.view.receive({ vastgrid: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    grid.reopen();
    const snapshot = await settled(grid.store);
    assert.equal(snapshot.table?.edits.cells, 1);
    assert.equal(await cell(grid.store, 0, "price"), 1);
  } finally {
    grid.close();
    await file.dispose();
  }
});

test("the engine opens the editor's file only, and closes with its files when the file is closed", async () => {
  await writeFile(path.join(folder, "other.csv"), "a\n1\n");
  const file = tableFile(await csvFile("only.csv"));
  const answers: unknown[] = [];
  // Responses only: the engine's events come too.
  const view = file.connect((message) => (message as { id?: unknown }).id !== undefined && answers.push(message));
  try {
    view.receive({ v: 2, id: 1, op: "open", ref: "other.csv" });
    view.receive({ v: 2, id: 2, op: "open", ref: "only.csv" });
    await eventually(() => answers.length === 2);
    const byId = (id: number) =>
      answers.find((answer) => (answer as { id: number }).id === id) as {
        error?: { code: string };
        result?: { table: string };
      };
    assert.equal(byId(1).error?.code, "not_allowed");
    const table = byId(2).result?.table;
    assert.ok(table);
    // A page that loads again leaves its handles: they are closed.
    view.receive({ vastgrid: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.receive({ v: 2, id: 3, op: "info", table });
    await eventually(() => answers.length === 3);
    assert.equal(byId(3).error?.code, "table_not_found");
    assert.ok((await readdir(temp)).length > 0);
  } finally {
    view.dispose();
    await file.dispose();
  }
  assert.deepEqual(await readdir(temp), []);
});
