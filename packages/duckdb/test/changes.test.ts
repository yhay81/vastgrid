import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pollChanges, RemoteSource, type TableChange } from "vastgrid-core";
import { TableEngine } from "../src/engine.ts";
import { createTableHandler, handleTableRequest } from "../src/handler.ts";

let root: string;
let workspace: string;
let engine: TableEngine;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-changes-"));
  workspace = path.join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

const options = { engine: () => engine, resolve: (ref: string) => path.join(workspace, ref) };

async function request(body: Record<string, unknown>) {
  return (await handleTableRequest(body, options)) as Record<string, unknown>;
}

async function until(condition: () => boolean | Promise<boolean>) {
  for (let wait = 0; wait < 400 && !(await condition()); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await condition(), "timed out");
}

test("the revision request tells appended rows, a rewrite in the same tick and a deleted file", async () => {
  const file = path.join(workspace, "log.csv");
  await writeFile(file, "n,text\n1,a\n2,b\n");
  const info = await request({ op: "info", ref: "log.csv" });
  const table = info.table as string;
  await engine.get(table).whenReady();
  assert.deepEqual(await request({ op: "revision", table }), { revision: info.revision });

  await appendFile(file, "3,c\n");
  const appended = (await request({ op: "revision", table })).revision;
  assert.notEqual(appended, info.revision);
  // `info` opens the changed file as a new table.
  const reopened = await request({ op: "info", ref: "log.csv", table });
  assert.notEqual(reopened.table, table);
  assert.equal(reopened.revision, appended);
  await engine.get(reopened.table as string).whenReady();
  assert.equal((await request({ op: "info", ref: "log.csv" })).rowCount, 3);

  // Same size and modification time, other content: the hash of the beginning tells.
  const before = await stat(file);
  await writeFile(file, "n,text\n1,x\n2,y\n3,z\n");
  await utimes(file, before.atime, before.mtime);
  const rewritten = (await request({ op: "revision", table: reopened.table })).revision;
  assert.notEqual(rewritten, appended);

  await rm(file);
  assert.deepEqual(await request({ op: "revision", table: reopened.table }), { revision: null });
});

test("a remote source over the DuckDB handler reports a file that grew", async () => {
  const file = path.join(workspace, "events.csv");
  await writeFile(file, "n\n1\n2\n");
  const handler = createTableHandler(options);
  const fetch = (async (_url: string, init: RequestInit) =>
    handler(new Request("http://localhost/api", init as RequestInit))) as typeof globalThis.fetch;
  const source = new RemoteSource({
    endpoint: "http://localhost/api",
    ref: "events.csv",
    fetch,
    changes: pollChanges({ interval: 100 }),
  });
  await until(async () => (await source.info()).status === "ready");
  const changes: TableChange[] = [];
  source.subscribe((change) => changes.push(change));
  await appendFile(file, "3\n4\n");
  await until(() => changes.length > 0);
  assert.equal(changes.length, 1);
  await until(async () => (await source.info()).rowCount === 4);
  await source.close();
});
