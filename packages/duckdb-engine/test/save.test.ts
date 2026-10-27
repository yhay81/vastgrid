import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createGridStore, localTransport } from "vastgrid/core";
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

async function opened(name: string, content: string | Buffer, target = client): Promise<TableInfo> {
  await writeFile(path.join(workspace, name), content);
  const info = await target.open(name);
  assert.equal(info.status, "ready", info.error);
  return info;
}

/** Writes cells by row ID: `[row, column, value]`. */
function write(info: TableInfo, cells: [number, string, unknown][], target = client) {
  return target.result("write", {
    table: info.table,
    revision: info.revision,
    updates: cells.map(([rowId, column, value]) => ({ key: { rowId }, column, value })),
  });
}

function save(info: TableInfo, target = client) {
  return target.result<{ records: number; edits: { version: number; cells: number } }>("save", { table: info.table });
}

async function column(info: TableInfo, name: string) {
  return (await client.rows(info, { columns: [name] })).rows.map((row) => row[0]);
}

const bytes = (name: string) => readFile(path.join(workspace, name));
const temporaries = async () => (await readdir(workspace)).filter((name) => name.endsWith(".tmp"));

for (const [extension, separator] of [
  ["csv", ","],
  ["tsv", "\t"],
] as const) {
  test(`${extension} refuses an empty string without changing the file or clearing any edits`, async () => {
    const name = `empty-string.${extension}`;
    const content = `id${separator}name\r\n1${separator}Alice\r\n2${separator}Bob\r\n3${separator}Carol\r\n`;
    const info = await opened(name, content);
    await write(info, [
      [0, "name", "Ann"],
      [1, "name", ""],
    ]);
    const before = await client.result<{ edits: Json }>("info", { table: info.table });
    const error = await client.error("save", { table: info.table });
    assert.equal(error.code, "save_unsupported");
    assert.match(error.message, /empty string/i);
    assert.equal((await bytes(name)).toString(), content, "even the earlier edited record is not replaced");
    assert.deepEqual(await column(info, "name"), ["Ann", "", "Carol"]);
    const after = await client.result<{ edits: Json }>("info", { table: info.table });
    assert.deepEqual(after.edits, before.edits, "the failed save keeps all pending edits");
    assert.deepEqual(await temporaries(), []);

    // Null is representable: correcting the unsupported value allows the whole save to succeed.
    await write(info, [[1, "name", null]]);
    await save(info);
    const reopened = await opened(`reopened-${name}`, await bytes(name));
    assert.deepEqual(await column(reopened, "name"), ["Ann", null, "Carol"]);
  });
}

test("only the edited fields are written; every other byte stays (§7.5)", async () => {
  const content = [
    "﻿id,name,price,note\r\n",
    '1,Apple,1.50,"line one\r\nline two"\r\n',
    '2,"Banana, ripe",0.250,plain\r\n',
    '3,Cherry,12.00,"say ""hi"""\r\n',
    "4,Durian,,\r\n",
    "5,Elderberry,3.75,last",
  ].join("");
  const info = await opened("fruit.csv", content);
  assert.equal(info.capabilities.save, true);
  await write(info, [
    [1, "name", "Blue, berry"],
    [3, "note", 'quote " and\nline'],
    [4, "price", 4.5],
  ]);
  events.length = 0;
  const result = await save(info);
  assert.deepEqual(result, { records: 3, edits: { version: 2, cells: 0 } });
  assert.deepEqual(
    events.filter((event) => event.table === info.table),
    [{ v: 2, event: "changed", table: info.table, revision: info.revision, edits: { version: 2, cells: 0 } }],
  );
  const expected = [
    "﻿id,name,price,note\r\n",
    '1,Apple,1.50,"line one\r\nline two"\r\n',
    '2,"Blue, berry",0.250,plain\r\n',
    '3,Cherry,12.00,"say ""hi"""\r\n',
    '4,Durian,,"quote "" and\nline"\r\n',
    "5,Elderberry,4.5,last",
  ].join("");
  assert.equal((await bytes("fruit.csv")).toString("utf8"), expected);
  // The table keeps its revision and row IDs, and reads the saved values as the file's own.
  const now = await client.result<TableInfo & { edits: Json }>("info", { table: info.table });
  assert.equal(now.revision, info.revision);
  assert.deepEqual(now.edits, { version: 2, cells: 0 });
  assert.deepEqual(await column(info, "name"), ["Apple", "Blue, berry", "Cherry", "Durian", "Elderberry"]);
  assert.deepEqual(await column(info, "price"), [1.5, 0.25, 12, null, 4.5]);
  // Saving again writes only the cells written since.
  await write(info, [[0, "name", "Apricot"]]);
  assert.equal((await save(info)).records, 1);
  assert.equal((await bytes("fruit.csv")).toString("utf8"), expected.replace("1,Apple,", "1,Apricot,"));
  assert.deepEqual(await save(info), { records: 0, edits: { version: 4, cells: 0 } }, "nothing to save");
  // The saved file reads back the same values, and no temporary file is left next to it.
  await writeFile(path.join(workspace, "reread.csv"), await bytes("fruit.csv"));
  const reread = await opened("reread.csv", await bytes("fruit.csv"));
  assert.deepEqual(await column(reread, "note"), [
    "line one\r\nline two",
    "plain",
    'say "hi"',
    'quote " and\nline',
    "last",
  ]);
  assert.deepEqual(await temporaries(), []);
});

test("TSV, a final line break, blank lines and short records", async () => {
  const info = await opened("short.tsv", "a\tb\tc\n1\tx\t\n\n2\n3\tz\tw\n");
  assert.equal(info.rowCount, 3);
  await write(info, [
    [1, "c", "new\tvalue"],
    [2, "a", null],
  ]);
  await save(info);
  assert.equal((await bytes("short.tsv")).toString("utf8"), 'a\tb\tc\n1\tx\t\n\n2\t\t"new\tvalue"\n\tz\tw\n');
  // A table of one column reads blank lines as rows.
  const single = await opened("single.csv", "v\n1\n\n3\n");
  assert.equal(single.rowCount, 3);
  await write(single, [[1, "v", 2]]);
  await save(single);
  assert.equal((await bytes("single.csv")).toString("utf8"), "v\n1\n2\n3\n");
});

test("Shift_JIS and UTF-16 files are written in their encoding", async () => {
  // id,city / 1,東京 / 2,大阪 in Shift_JIS, with CRLF.
  const sjis = Buffer.concat([
    Buffer.from("id,city\r\n1,"),
    Buffer.from([0x93, 0x8c, 0x8b, 0x9e]),
    Buffer.from("\r\n2,"),
    Buffer.from([0x91, 0xe5, 0x8d, 0xe3]),
    Buffer.from("\r\n"),
  ]);
  const info = await opened("cities.csv", sjis);
  assert.deepEqual(info.notes, ["encoding:shift_jis"]);
  await write(info, [[1, "city", "名古屋"]]);
  await save(info);
  const saved = await bytes("cities.csv");
  assert.deepEqual(
    saved,
    Buffer.concat([sjis.subarray(0, sjis.length - 6), Buffer.from([0x96, 0xbc, 0x8c, 0xc3, 0x89, 0xae, 13, 10])]),
  );
  assert.equal(new TextDecoder("shift_jis").decode(saved), "id,city\r\n1,東京\r\n2,名古屋\r\n");
  // A character that Shift_JIS cannot hold refuses the save, and the file and the cell stay.
  await write(info, [[0, "city", "東京🗼"]]);
  const error = await client.error("save", { table: info.table });
  assert.equal(error.code, "invalid_value");
  assert.deepEqual(await bytes("cities.csv"), saved);
  assert.deepEqual(await column(info, "city"), ["東京🗼", "名古屋"]);
  assert.deepEqual(await temporaries(), []);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,x\n2,y\n", "utf16le")]);
  const wide = await opened("wide.csv", utf16);
  await write(wide, [[1, "b", "ÿ€"]]);
  await save(wide);
  assert.deepEqual(
    await bytes("wide.csv"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,x\n2,ÿ€\n", "utf16le")]),
  );
});

test("a file changed by someone else, a cancelled save and a link are refused; the file stays (§7.5)", async () => {
  const content = "a,b\n1,x\n2,y\n";
  const info = await opened("guarded.csv", content);
  await write(info, [[0, "b", "changed"]]);
  await appendFile(path.join(workspace, "guarded.csv"), "3,z\n");
  assert.equal((await client.error("save", { table: info.table })).code, "file_changed");
  assert.equal((await bytes("guarded.csv")).toString(), `${content}3,z\n`);
  const kept = await client.result<{ edits: Json }>("info", { table: info.table });
  assert.deepEqual(kept.edits, { version: 1, cells: 1 }, "the written cells are kept");
  // The file opens again as it is now, as a new revision.
  const again = await client.open("guarded.csv");
  assert.notEqual(again.revision, info.revision);
  assert.equal(again.rowCount, 3);

  const other = await opened("cancelled.csv", content);
  await write(other, [[0, "b", "changed"]]);
  const controller = new AbortController();
  controller.abort();
  const answer = await context.engine.handle(
    { v: 2, id: 9_000, op: "save", table: other.table },
    { signal: controller.signal },
  );
  assert.equal((answer as { error: Json }).error.code, "cancelled");
  assert.equal((await bytes("cancelled.csv")).toString(), content);
  assert.deepEqual(await temporaries(), []);

  const outside = path.join(context.root, "outside");
  await mkdir(outside, { recursive: true });
  const linked = await opened("linked.csv", content);
  await write(linked, [[0, "b", "changed"]]);
  await writeFile(path.join(outside, "elsewhere.csv"), content);
  await rm(path.join(workspace, "linked.csv"));
  await symlink(path.join(outside, "elsewhere.csv"), path.join(workspace, "linked.csv"));
  assert.equal((await client.error("save", { table: linked.table })).code, "not_allowed");
  assert.equal(await readFile(path.join(outside, "elsewhere.csv"), "utf8"), content);
});

test("the saved file keeps its mode", async () => {
  const info = await opened("mode.csv", "a,b\n1,x\n");
  await chmod(path.join(workspace, "mode.csv"), 0o640);
  // A change of mode alone is not a change of the file's revision.
  await write(info, [[0, "b", "y"]]);
  await save(info);
  // Windows has no POSIX modes: chmod sets only the read-only flag, and stat reports 0o666 or 0o444.
  if (process.platform !== "win32") assert.equal((await stat(path.join(workspace, "mode.csv"))).mode & 0o777, 0o640);
  assert.equal((await bytes("mode.csv")).toString(), "a,b\n1,y\n");
});

test("only CSV and TSV files of engines that save are saved", async () => {
  const readOnly = await setUp();
  try {
    await writeFile(path.join(readOnly.workspace, "nosave.csv"), "a\n1\n");
    const info = await readOnly.client.open("nosave.csv");
    assert.equal(info.capabilities.save, false);
    await write(info, [[0, "a", 2]], readOnly.client);
    assert.equal((await readOnly.client.error("save", { table: info.table })).code, "save_unsupported");
    assert.equal(await readFile(path.join(readOnly.workspace, "nosave.csv"), "utf8"), "a\n1\n");
  } finally {
    await readOnly.tearDown();
  }
  const json = await opened("rows.jsonl", '{"a":1}\n');
  assert.equal(json.capabilities.save, false);
  await write(json, [[0, "a", 2]]);
  assert.equal((await client.error("save", { table: json.table })).code, "save_unsupported");
  assert.equal(await readFile(path.join(workspace, "rows.jsonl"), "utf8"), '{"a":1}\n');
});

test("a file read loosely is not saved, since its records may not be its rows", async () => {
  const content = "id,name\r\n1,Apple\r\n2,Banana\n";
  const info = await opened("mixed-lines.csv", content);
  assert.deepEqual(await column(info, "name"), ["Apple", "Banana"]);
  await write(info, [[0, "name", "Apricot"]]);
  assert.equal((await client.error("save", { table: info.table })).code, "save_unsupported");
  assert.equal((await bytes("mixed-lines.csv")).toString(), content);
});

test("dates and timestamps are saved in the format the file uses", async () => {
  const dates = await opened("dates.csv", "id,d\n1,25/12/2024\n2,13/01/2023\n");
  assert.equal(dates.columns[1].type, "date");
  await write(dates, [[0, "d", "2024-12-26"]]);
  await save(dates);
  assert.equal((await bytes("dates.csv")).toString(), "id,d\n1,26/12/2024\n2,13/01/2023\n");
  const stamps = await opened("stamps.csv", "id,t\n1,25/12/2024 10:30:00\n2,13/01/2023 08:00:05\n");
  assert.equal(stamps.columns[1].type, "timestamp");
  await write(stamps, [[1, "t", "2023-01-14 09:15:00"]]);
  await save(stamps);
  assert.equal((await bytes("stamps.csv")).toString(), "id,t\n1,25/12/2024 10:30:00\n2,14/01/2023 09:15:00\n");
  // The saved files read back with the same types.
  for (const [name, type] of [
    ["dates.csv", "date"],
    ["stamps.csv", "timestamp"],
  ] as const) {
    const copy = await opened(`reread-${name}`, await bytes(name));
    assert.equal(copy.columns[1].type, type);
  }
});

test("a cell written back to the file's value is not written; a saved value is the file's own", async () => {
  const content = "id,p\n1,1.50\n2,2.25\n";
  const info = await opened("revert.csv", content);
  await write(info, [[0, "p", 9]]);
  await write(info, [[0, "p", 1.5]]);
  assert.deepEqual(await save(info), { records: 0, edits: { version: 3, cells: 0 } });
  assert.equal((await bytes("revert.csv")).toString(), content, "1.50 stays as it is written");
  // After a save, writing the old value back is a change again.
  await write(info, [[1, "p", 3]]);
  await save(info);
  // DuckDB's text of the float, which it reads back as the same value.
  assert.equal((await bytes("revert.csv")).toString(), "id,p\n1,1.50\n2,3.0\n");
  await write(info, [[1, "p", 2.25]]);
  await save(info);
  assert.equal((await bytes("revert.csv")).toString(), "id,p\n1,1.50\n2,2.25\n");
  assert.deepEqual(await column(info, "p"), [1.5, 2.25]);
});

test("handles of a file share its saves, and one opened after a save reads the saved file", async () => {
  const info = await opened("shared.csv", "a,b\n1,x\n2,y\n");
  const second = await client.open("shared.csv");
  await write(info, [[1, "b", "z"]]);
  await save(second);
  assert.equal((await bytes("shared.csv")).toString(), "a,b\n1,x\n2,z\n");
  const after = await client.open("shared.csv");
  assert.deepEqual((await client.rows(after)).rows, [
    [1, "x"],
    [2, "z"],
  ]);
  // Undoing through `previous` after a save compares with the saved value.
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId: 1 }, column: "b", value: "y", previous: "z" }],
  });
  await save(info);
  assert.equal((await bytes("shared.csv")).toString(), "a,b\n1,x\n2,y\n");
});

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 500 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done());
}

test("the grid's store saves, then undoes over the saved file, and is told of a file changed by someone else", async () => {
  await writeFile(path.join(workspace, "grid.csv"), "id,name\n1,Ann\n2,Bob\n");
  const store = createGridStore({ transport: localTransport(context.engine), table: "grid.csv" });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 10, columns: ["id", "name"] });
  await until(() => store.getSnapshot().view !== null && store.cell(1, "name") === "Bob");
  assert.equal(store.getSnapshot().table?.capabilities.save, true);

  await store.dispatch({ command: "select", row: 1, column: "name" });
  store.dispatchSync({ command: "edit.begin", text: "" });
  store.dispatchSync({ command: "edit.change", text: "Bea" });
  assert.deepEqual(await store.dispatch({ command: "edit.commit", move: null }), { ok: true });
  await until(() => store.getSnapshot().table?.edits.cells === 1);
  assert.deepEqual(await store.dispatch({ command: "save" }), {
    ok: true,
    output: { records: 1, edits: { version: 2, cells: 0 } },
  });
  await until(() => store.getSnapshot().table?.edits.cells === 0);
  assert.equal((await bytes("grid.csv")).toString(), "id,name\n1,Ann\n2,Bea\n");
  // The history stays: undoing writes the value before, over the saved one.
  assert.deepEqual(await store.dispatch({ command: "history.undo" }), { ok: true });
  await until(() => store.getSnapshot().pending === null && store.cell(1, "name") === "Bob");
  assert.equal(store.getSnapshot().table?.edits.cells, 1);

  await appendFile(path.join(workspace, "grid.csv"), "3,Cy\n");
  const refused = await store.dispatch({ command: "save" });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, "file_changed");
  assert.equal(store.getSnapshot().table?.edits.cells, 1, "the written cell is kept");
  disconnect();
});
