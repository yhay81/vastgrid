import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type OpenTable, TableEngine } from "../src/engine.ts";
import { handleTableRequest } from "../src/handler.ts";

let root: string;
let workspace: string;
let outside: string;
let engine: TableEngine;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-save-"));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  const fs = await import("node:fs/promises");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  engine = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp"),
    memoryLimit: "1GB",
    threads: 2,
    editable: true,
    saveFiles: true,
  });
});

after(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

async function open(name: string, content: string | Buffer, target = engine) {
  await writeFile(path.join(workspace, name), content);
  const table = await target.open(path.join(workspace, name));
  await table.whenReady();
  assert.equal(table.info().status, "ready", table.info().error);
  return table;
}

async function values(table: OpenTable, columns: number[]) {
  return (await table.readRows({ view: null, start: 0, end: table.info().rowCount ?? 0, columns })).columns;
}

const bytes = (name: string) => readFile(path.join(workspace, name));

test("only the edited fields are written; every other byte stays", async () => {
  const content = [
    "﻿id,name,price,note\r\n",
    '1,Apple,1.50,"line one\r\nline two"\r\n',
    '2,"Banana, ripe",0.250,plain\r\n',
    '3,Cherry,12.00,"say ""hi"""\r\n',
    "4,Durian,,\r\n",
    "5,Elderberry,3.75,last",
  ].join("");
  const table = await open("fruit.csv", content);
  assert.equal(table.info().capabilities.save, true);
  const revision = table.info().revision;
  await table.updateCells({
    updates: [
      { row: 1, column: 1, value: "Blue, berry" },
      { row: 3, column: 3, value: 'quote " and\nline' },
      { row: 4, column: 2, value: "4.5" },
    ],
  });
  const result = await table.saveEdits();
  assert.equal(result.records, 3);
  assert.deepEqual(result.edits, { version: 2, cells: 0 });
  const expected = [
    "﻿id,name,price,note\r\n",
    '1,Apple,1.50,"line one\r\nline two"\r\n',
    '2,"Blue, berry",0.250,plain\r\n',
    '3,Cherry,12.00,"say ""hi"""\r\n',
    '4,Durian,,"quote "" and\nline"\r\n',
    "5,Elderberry,4.5,last",
  ].join("");
  assert.equal((await bytes("fruit.csv")).toString("utf8"), expected);
  // The table keeps its revision and positions, and the saved file reads back the same values.
  assert.equal(table.info().revision, revision);
  assert.equal(await table.currentRevision(), revision);
  assert.equal(table.info().edits?.cells, 0);
  const [names, prices] = await values(table, [1, 2]);
  assert.deepEqual(names, ["Apple", "Blue, berry", "Cherry", "Durian", "Elderberry"]);
  assert.deepEqual(prices, [1.5, 0.25, 12, null, 4.5]);
  // Saving again writes only cells written since.
  await table.updateCells({ updates: [{ row: 0, column: 1, value: "Apricot" }] });
  assert.equal((await table.saveEdits()).records, 1);
  assert.equal((await bytes("fruit.csv")).toString("utf8"), expected.replace("1,Apple,", "1,Apricot,"));
  assert.equal((await table.saveEdits()).records, 0, "nothing to save");
  const copy = path.join(workspace, "reread.csv");
  await writeFile(copy, await bytes("fruit.csv"));
  const reread = await engine.open(copy);
  await reread.whenReady();
  assert.deepEqual((await values(reread, [1, 3]))[1], [
    "line one\r\nline two",
    "plain",
    'say "hi"',
    'quote " and\nline',
    "last",
  ]);
  // No temporary file is left next to it.
  assert.deepEqual(
    (await readdir(workspace)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("TSV, a final line break, blank lines and short records", async () => {
  const content = "a\tb\tc\n1\tx\t\n\n2\n3\tz\tw\n";
  const table = await open("short.tsv", content);
  assert.equal(table.info().rowCount, 3);
  await table.updateCells({
    updates: [
      { row: 1, column: 2, value: "new\tvalue" },
      { row: 2, column: 0, value: null },
    ],
  });
  await table.saveEdits();
  assert.equal((await bytes("short.tsv")).toString("utf8"), 'a\tb\tc\n1\tx\t\n\n2\t\t"new\tvalue"\n\tz\tw\n');
  // A table of one column reads blank lines as rows.
  const single = await open("single.csv", "v\n1\n\n3\n");
  assert.equal(single.info().rowCount, 3);
  await single.updateCells({ updates: [{ row: 1, column: 0, value: 2 }] });
  await single.saveEdits();
  assert.equal((await bytes("single.csv")).toString("utf8"), "v\n1\n2\n3\n");
});

test("Shift_JIS and UTF-16 files are written in their encoding", async () => {
  // id,city / 1,東京 / 2,大阪 in Shift_JIS, with CRLF.
  const sjis = Buffer.from([
    ...Buffer.from("id,city\r\n1,"),
    0x93,
    0x8c,
    0x8b,
    0x9e,
    ...Buffer.from("\r\n2,"),
    0x91,
    0xe5,
    0x8d,
    0xe3,
    ...Buffer.from("\r\n"),
  ]);
  const table = await open("cities.csv", sjis);
  assert.deepEqual(table.info().notes, ["encoding:shift_jis"]);
  await table.updateCells({ updates: [{ row: 1, column: 1, value: "名古屋" }] });
  await table.saveEdits();
  const saved = await bytes("cities.csv");
  assert.deepEqual(
    saved,
    Buffer.concat([
      sjis.subarray(0, sjis.length - 6),
      Buffer.from([0x96, 0xbc, 0x8c, 0xc3, 0x89, 0xae]),
      Buffer.from("\r\n"),
    ]),
  );
  assert.equal(new TextDecoder("shift_jis").decode(saved), "id,city\r\n1,東京\r\n2,名古屋\r\n");
  // A character Shift_JIS cannot hold refuses the save, and the file stays.
  await table.updateCells({ updates: [{ row: 0, column: 1, value: "東京🗼" }] });
  await assert.rejects(table.saveEdits(), { code: "invalid_value" });
  assert.deepEqual(await bytes("cities.csv"), saved);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,x\n2,y\n", "utf16le")]);
  const wide = await open("wide.csv", utf16);
  await wide.updateCells({ updates: [{ row: 1, column: 1, value: "ÿ€" }] });
  await wide.saveEdits();
  assert.deepEqual(
    await bytes("wide.csv"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,x\n2,ÿ€\n", "utf16le")]),
  );
});

test("a file changed by someone else, a cancelled save and a link are refused; the file stays", async () => {
  const content = "a,b\n1,x\n2,y\n";
  const table = await open("guarded.csv", content);
  await table.updateCells({ updates: [{ row: 0, column: 1, value: "changed" }] });
  await appendFile(path.join(workspace, "guarded.csv"), "3,z\n");
  await assert.rejects(table.saveEdits(), { code: "file_changed" });
  assert.equal((await bytes("guarded.csv")).toString(), `${content}3,z\n`);
  assert.equal(table.info().edits?.cells, 1, "the cells are kept");

  const other = await open("cancelled.csv", content);
  await other.updateCells({ updates: [{ row: 0, column: 1, value: "changed" }] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(other.saveEdits(controller.signal), { code: "cancelled" });
  assert.equal((await bytes("cancelled.csv")).toString(), content);
  assert.deepEqual(
    (await readdir(workspace)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const linked = await open("linked.csv", content);
  await linked.updateCells({ updates: [{ row: 0, column: 1, value: "changed" }] });
  const real = path.join(workspace, "linked.csv");
  await writeFile(path.join(outside, "elsewhere.csv"), content);
  await rm(real);
  await symlink(path.join(outside, "elsewhere.csv"), real);
  await assert.rejects(linked.saveEdits(), { code: "not_allowed" });
  assert.equal(await readFile(path.join(outside, "elsewhere.csv"), "utf8"), content);
});

test("only delimited files of engines that save can be saved", async () => {
  const readOnly = await TableEngine.create({
    allowedDirectories: [workspace],
    tempDirectory: path.join(root, "temp-nosave"),
    memoryLimit: "1GB",
    threads: 2,
    editable: true,
  });
  try {
    const table = await open("nosave.csv", "a\n1\n", readOnly);
    assert.equal(table.info().capabilities.save, undefined);
    await table.updateCells({ updates: [{ row: 0, column: 0, value: 2 }] });
    await assert.rejects(table.saveEdits(), { code: "read_only" });
  } finally {
    await readOnly.dispose();
  }
  const json = await open("rows.jsonl", '{"a":1}\n');
  assert.equal(json.info().capabilities.save, false);
  await assert.rejects(json.saveEdits(), { code: "save_unsupported" });
  // Through the protocol.
  const options = { engine: () => engine, resolve: (ref: string) => path.join(workspace, ref) };
  const info = (await handleTableRequest({ op: "info", ref: "proto.csv" }, options).catch(async () => {
    await writeFile(path.join(workspace, "proto.csv"), "a,b\n1,2\n");
    for (;;) {
      const answer = (await handleTableRequest({ op: "info", ref: "proto.csv" }, options)) as { status: string };
      if (answer.status === "ready") return answer;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })) as { table: string };
  await handleTableRequest({ op: "update", table: info.table, updates: [{ row: 0, column: 1, value: 3 }] }, options);
  const saved = (await handleTableRequest({ op: "save", table: info.table }, options)) as { records: number };
  assert.equal(saved.records, 1);
  assert.equal(await readFile(path.join(workspace, "proto.csv"), "utf8"), "a,b\n1,3\n");
});

test("formula columns follow written cells and are never saved into the file", async () => {
  const content = "item,qty,price\napple,3,120\npear,1,300\nfig,5,80\n";
  const table = await open("formulas.csv", content);
  const formulas = [{ name: "total", expression: "qty * price" }];
  const sorted = await table.createView({ formulas, sort: [{ column: 3, direction: "desc" }] });
  assert.deepEqual((await table.readRows({ view: sorted.id, start: 0, end: 3, columns: [0] })).columns[0], [
    "fig",
    "apple",
    "pear",
  ]);
  // Formula columns are not columns of the table: a write to one is refused.
  await assert.rejects(table.updateCells({ updates: [{ row: 0, column: 3, value: 1 }] }), { code: "invalid_request" });
  await table.updateCells({ updates: [{ row: 1, column: 1, value: 10 }] });
  const again = await table.createView({ formulas, sort: [{ column: 3, direction: "desc" }] });
  const rows = await table.readRows({ view: again.id, start: 0, end: 3, columns: [0, 3] });
  assert.deepEqual(rows.columns, [
    ["pear", "fig", "apple"],
    [3000, 400, 360],
  ]);
  const filtered = await table.createView({
    formulas,
    filters: [{ type: "compare", column: 3, op: "gt", value: 1000 }],
  });
  assert.equal(filtered.rowCount, 1);
  assert.equal((await table.columnStats(again.id, 3)).max, 3000);
  await table.saveEdits();
  assert.equal((await bytes("formulas.csv")).toString(), "item,qty,price\napple,3,120\npear,10,300\nfig,5,80\n");
});
