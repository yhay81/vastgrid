import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { type Json, setUp, type TableInfo } from "./client.ts";

let context: Awaited<ReturnType<typeof setUp>>;

before(async () => {
  context = await setUp({ previewRows: 2, saveFiles: true, watchFiles: false });
});

after(async () => context.tearDown());

async function opened(name: string, content: string | Buffer, read?: Json): Promise<TableInfo> {
  const file = path.join(context.workspace, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const info = await context.client.open(name, read);
  assert.equal(info.status, "ready", info.error);
  return info;
}

test("standard CSV keeps single quotes, semicolons and pipes as data", async () => {
  const cases: [string, string, unknown[][]][] = [
    [
      "single-quotes",
      "id,note\r\n1,'alpha'\r\n2,'beta'\r\n",
      [
        [1, "'alpha'"],
        [2, "'beta'"],
      ],
    ],
    [
      "single-comma",
      "a,b,c\r\nx,'a,b'\r\ny,'c,d'\r\n",
      [
        ["x", "'a", "b'"],
        ["y", "'c", "d'"],
      ],
    ],
    ["semicolons", "name\r\nalpha;beta\r\ngamma;delta\r\n", [["alpha;beta"], ["gamma;delta"]]],
    ["pipes", "name\r\nalpha|beta\r\ngamma|delta\r\n", [["alpha|beta"], ["gamma|delta"]]],
  ];
  for (const [name, text, rows] of cases) {
    const info = await opened(`${name}.csv`, text);
    assert.deepEqual((await context.client.rows(info)).rows, rows, name);
  }
});

test("CSV header and delimiter options survive saving and distinguish open handles", async () => {
  const text = "2025;2026\r\n10;20\r\n30;40\r\n";
  const info = await opened("options.csv", text, { delimiter: ";", headerRow: 1 });
  assert.deepEqual(
    info.columns.map((column) => column.name),
    ["2025", "2026"],
  );
  assert.deepEqual((await context.client.rows(info)).rows, [
    [10, 20],
    [30, 40],
  ]);
  const noHeader = await context.client.open("options.csv", { delimiter: ";", headerRow: 0 });
  assert.notEqual(info.table, noHeader.table);
  assert.deepEqual((await context.client.rows(noHeader)).rows, [
    [2025, 2026],
    [10, 20],
    [30, 40],
  ]);
  await edit(info, 0, "2025", 11);
  assert.equal(await readFile(path.join(context.workspace, "options.csv"), "utf8"), text.replace("10;20", "11;20"));
  const reread = await opened("reread-options.csv", text.replace("10;20", "11;20"), { delimiter: ";", headerRow: 1 });
  assert.deepEqual((await context.client.rows(reread)).rows, [
    [11, 20],
    [30, 40],
  ]);
  await writeFile(path.join(context.workspace, "options.csv"), text.replace("30;40", "31;41"));
  await context.client.result("reload", { table: info.table });
  await context.engine.whenLoaded(info.table);
  const reloaded = await context.client.result<TableInfo>("info", { table: info.table });
  assert.deepEqual(
    reloaded.columns.map((column) => column.name),
    ["2025", "2026"],
  );
  assert.deepEqual((await context.client.rows(reloaded)).rows, [
    [10, 20],
    [31, 41],
  ]);

  const strings = await opened("headerless.csv", "alice,tokyo\r\nbob,osaka\r\n", { headerRow: 0 });
  assert.deepEqual((await context.client.rows(strings)).rows, [
    ["alice", "tokyo"],
    ["bob", "osaka"],
  ]);
  const empty = await opened("empty-header.csv", ",note\r\n1,alpha\r\n2,beta\r\n", { headerRow: 1 });
  assert.deepEqual((await context.client.rows(empty)).rows, [
    [1, "alpha"],
    [2, "beta"],
  ]);
  const preamble = await opened("header-row.csv", "Report\r\nid,note\r\n1,alpha\r\n", { headerRow: 2 });
  assert.deepEqual((await context.client.rows(preamble)).rows, [[1, "alpha"]]);
  await edit(preamble, 0, "note", "beta");
  assert.equal(
    await readFile(path.join(context.workspace, "header-row.csv"), "utf8"),
    "Report\r\nid,note\r\n1,beta\r\n",
  );
  const apostrophe = await opened("apostrophe-delimiter.csv", "id'note\r\n1'alpha\r\n", {
    delimiter: "'",
    headerRow: 1,
  });
  assert.deepEqual((await context.client.rows(apostrophe)).rows, [[1, "alpha"]]);
});

test("gzip CSV detects the decompressed encoding and keeps every value", async () => {
  const utf16 = Buffer.from("\ufeffid,note\r\n1,東京\r\n2,大阪\r\n", "utf16le");
  const sjis = Buffer.concat([
    Buffer.from("id,note\r\n1,"),
    Buffer.from([0x93, 0x8c, 0x8b, 0x9e]),
    Buffer.from("\r\n2,"),
    Buffer.from([0x91, 0xe5, 0x8d, 0xe3]),
    Buffer.from("\r\n"),
  ]);
  for (const [encoding, bytes] of [
    ["utf8", Buffer.from("id,note\r\n1,東京\r\n2,大阪\r\n")],
    ["utf16le", utf16],
    ["utf16be", Buffer.from(utf16).swap16()],
    ["shift_jis", sjis],
  ] as const) {
    const info = await opened(`${encoding}.csv.gz`, gzipSync(bytes));
    assert.deepEqual(
      (await context.client.rows(info)).rows,
      [
        [1, "東京"],
        [2, "大阪"],
      ],
      encoding,
    );
    assert.equal(info.capabilities.save, false);
    assert.deepEqual(
      info.notes ?? [],
      encoding === "utf8" ? [] : [`encoding:${encoding.startsWith("utf16") ? "utf-16" : encoding}`],
    );
  }
});

test("compressed sampling stops after its prefix and late invalid UTF-8 converts decompressed bytes", async () => {
  const head = `id,note\n${Array.from({ length: 45_000 }, (_, i) => `${i},${"x".repeat(100)}\n`).join("")}`;
  const text = Buffer.concat([Buffer.from(head), Buffer.from("45000,"), Buffer.from([0xff]), Buffer.from("\n")]);
  const info = await opened("late-invalid.csv.gz", gzipSync(text));
  assert.equal(info.rowCount, 45_001);
  assert.deepEqual(info.notes, ["invalid_utf8_replaced"]);
  assert.deepEqual((await context.client.rows(info, { start: 45_000, end: 45_001 })).rows, [[45_000, "�"]]);

  for (const extension of ["gz", "zst"]) {
    await writeFile(path.join(context.workspace, `broken.csv.${extension}`), Buffer.from("not compressed"));
    const broken = await context.client.open(`broken.csv.${extension}`);
    assert.equal(broken.status, "error");
  }
});

test("zstd CSV detects UTF-8, UTF-16 in both byte orders and Shift_JIS", async () => {
  // Fixed frames also exercise the Node 20 decoder, where zstdCompressSync is unavailable.
  const frames = [
    "KLUv/SAd6QAAaWQsbm90ZQ0KMSzmnbHkuqwNCjIs5aSn6ZiqDQo=",
    "KLUv/SAsYQEA//5pAGQALABuAG8AdABlAA0ACgAxACwAcWesTg0ACgAyACwAJ1kqlg0ACgA=",
    "KLUv/SAsYQEA/v8AaQBkACwAbgBvAHQAZQANAAoAMQAsZ3FOrAANAAoAMgAsWSeWKgANAAo=",
    "KLUv/SAZyQAAaWQsbm90ZQ0KMSyTjIueDQoyLJHljeMNCg==",
  ];
  for (const [index, frame] of frames.entries()) {
    const info = await opened(`compressed-${index}.csv.zst`, Buffer.from(frame, "base64"));
    assert.deepEqual((await context.client.rows(info)).rows, [
      [1, "東京"],
      [2, "大阪"],
    ]);
    assert.equal(info.capabilities.save, false);
  }
  // A UTF-16 frame with compressed blocks, as opposed to the raw blocks of the short frames above.
  const compressed = Buffer.from(
    "KLUv/aDUJwkAJAEA4P/+aQBkACwAbgBvAHQAZQANAAoAMQAsAHFnrE4BAIT/Py9OTAAACDEBAPz/ORACTAAACA0BAPz/ORACTAAACHEBAPz/ORACTQAACDEBANAnORAC",
    "base64",
  );
  const many = await opened("compressed-blocks.csv.zst", compressed);
  assert.equal(many.rowCount, 50_000);
  assert.deepEqual((await context.client.rows(many, { start: 49_999, end: 50_000 })).rows, [[1, "東京"]]);
});

test("a valid CSV record larger than 64 MiB loads without losing its types", async () => {
  const text = `id,note\r\n1,"${"x".repeat(64 * 1024 * 1024 + 1)}"\r\n2,end\r\n`;
  const info = await opened("long-record.csv", text);
  assert.equal(info.rowCount, 2);
  assert.equal(info.columns[0].type, "bigint");
  assert.deepEqual(info.notes ?? [], []);
  assert.deepEqual((await context.client.rows(info, { end: 2, textLimit: 8 })).rows, [
    [1, "xxxxxxxx"],
    [2, "end"],
  ]);
});

async function edit(info: TableInfo, rowId: number, column: string, value: unknown) {
  await context.client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [{ key: { rowId }, column, value }],
  });
  await context.client.result("save", { table: info.table });
}

for (const [extension, separator] of [
  ["csv", ","],
  ["tsv", "\t"],
] as const) {
  test(`${extension} reads only file columns, even inside key=value folders, and saves them`, async () => {
    const name = `id=9/extra=42/input.${extension}`;
    const text = `id${separator}note\r\n1${separator}alpha\r\n2${separator}beta\r\n`;
    const info = await opened(name, text);
    assert.deepEqual(
      info.columns.map((column) => column.name),
      ["id", "note"],
    );
    assert.deepEqual((await context.client.rows(info)).rows, [
      [1, "alpha"],
      [2, "beta"],
    ]);
    await edit(info, 1, "id", 3);
    const saved = await readFile(path.join(context.workspace, name), "utf8");
    assert.equal(saved, text.replace(`2${separator}beta`, `3${separator}beta`));
    const reread = await opened(`reread-folders.${extension}`, saved);
    assert.deepEqual((await context.client.rows(reread)).rows, [
      [1, "alpha"],
      [3, "beta"],
    ]);
  });

  test(`${extension} decodes quotes appearing after the sniff sample and keeps them on save`, async () => {
    const name = `late-quotes.${extension}`;
    const head = `id${separator}note\r\n${Array.from({ length: 30_000 }, (_, i) => `${i}${separator}plain\r\n`).join("")}`;
    const text = `${head}30000${separator}"a""b"\r\n30001${separator}"quoted"\r\n`;
    const info = await opened(name, text);
    assert.equal(info.rowCount, 30_002);
    assert.deepEqual((await context.client.rows(info, { start: 30_000, end: 30_002 })).rows, [
      [30_000, 'a"b'],
      [30_001, "quoted"],
    ]);
    await edit(info, 30_000, "note", 'c"d');
    const saved = await readFile(path.join(context.workspace, name), "utf8");
    assert.equal(saved, text.replace('"a""b"', '"c""d"'));
    const reread = await opened(`reread-late.${extension}`, saved);
    assert.deepEqual((await context.client.rows(reread, { start: 30_000, end: 30_002 })).rows, [
      [30_000, 'c"d'],
      [30_001, "quoted"],
    ]);
  });
}
