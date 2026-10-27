/**
 * Tables given as text files (CSV, TSV and JSON Lines): the types their columns are read as (docs/v2-spec.md
 * §2.1, §2.2), quoting, line breaks, byte order marks, empty fields, text that is not UTF-8, slices of any size, and
 * a large generated file that answers as the same table given as rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Column,
  dateText,
  daysFromCivil,
  floatJson,
  type JsonValue,
  timestampText,
  timeText,
} from "vastgrid-spec";
import type { FileTable, MemoryTable, TextFile } from "../src/index.ts";
import { readFile } from "../src/text.ts";
import { Client, random } from "./client.ts";

type Options = Omit<FileTable, "file">;

/** The columns and rows of a file as the engine reads it. */
async function read(text: string | Uint8Array, options: Options = { format: "csv" }) {
  const client = new Client({ t: { file: new Blob([text]), ...options } });
  const info = await client.open("t");
  const { rows } = await client.rows(info, {});
  return { columns: info.columns, rows };
}

/** The error that opening a file fails with. */
async function failure(text: string | Uint8Array, options: Options = { format: "csv" }) {
  const client = new Client({ t: { file: new Blob([text]), ...options } });
  return client.error("open", { ref: "t" });
}

/** Text as bytes, with `\xNN` for bytes that are not UTF-8. */
function bytes(text: string): Uint8Array {
  const parts = text.split(/\\x([0-9a-f]{2})/);
  const encoded = parts.map((part, index) =>
    index % 2 === 1 ? Uint8Array.of(Number.parseInt(part, 16)) : new TextEncoder().encode(part),
  );
  const joined = new Uint8Array(encoded.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of encoded) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** The values of a table that `readFile` read, by row. */
function valuesOf(table: Awaited<ReturnType<typeof readFile>>): JsonValue[][] {
  const vectors = table.vectors ?? [];
  return Array.from({ length: table.rowCount }, (_, row) => vectors.map((vector) => vector.at(row)));
}

test("a column has the first type that every value fits: boolean, integer, bigint, float, time, date, timestamp, timestamptz, otherwise string", async () => {
  const csv = [
    "flag,small,large,huge,real,day,clock,moment,instant,label,mixed,days,notday,none",
    "true,1,2147483648,9223372036854775808,1.5,2024-01-31,12:00:00.25,2024-01-31 12:00:00,2024-01-31T12:00:00Z,Kobe,1,2024-01-01,2024-01-01,",
    "FALSE,-2147483648,-9007199254740993,1,-.5e3,2024-02-29,23:59:59.000001,2024-01-31T00:00:00.5,2024-01-31 09:00:00+09:00,Osaka,x,2024-01-01 10:00:00,2023-02-29,",
    "True,+007,0,2,inf,0001-01-01,00:00:00,9999-12-31 23:59:59.999999,2024-01-01 00:30:00-0530,-1,2.5,2024-01-02,2024-01-02,",
  ].join("\n");
  const { columns, rows } = await read(csv);
  assert.deepEqual(
    columns.map((column) => [column.name, column.type]),
    [
      ["flag", "boolean"],
      ["small", "integer"],
      ["large", "bigint"],
      ["huge", "float"],
      ["real", "float"],
      ["day", "date"],
      ["clock", "time"],
      ["moment", "timestamp"],
      ["instant", "timestamptz"],
      ["label", "string"],
      ["mixed", "string"],
      ["days", "timestamp"],
      ["notday", "string"],
      ["none", "string"],
    ],
  );
  assert.deepEqual(rows, [
    [
      true,
      1,
      2147483648,
      2 ** 63,
      1.5,
      "2024-01-31",
      "12:00:00.25",
      "2024-01-31 12:00:00",
      "2024-01-31 12:00:00+00",
      "Kobe",
      "1",
      "2024-01-01 00:00:00",
      "2024-01-01",
      null,
    ],
    [
      false,
      -2147483648,
      "-9007199254740993",
      1,
      -500,
      "2024-02-29",
      "23:59:59.000001",
      "2024-01-31 00:00:00.5",
      "2024-01-31 00:00:00+00",
      "Osaka",
      "x",
      "2024-01-01 10:00:00",
      "2023-02-29",
      null,
    ],
    [
      true,
      7,
      0,
      2,
      "Infinity",
      "0001-01-01",
      "00:00:00",
      "9999-12-31 23:59:59.999999",
      "2024-01-01 06:00:00+00",
      "-1",
      "2.5",
      "2024-01-02 00:00:00",
      "2024-01-02",
      null,
    ],
  ]);
});

test("text that is almost a value of a type is a string: times past a day, fractions past microseconds, spaces", async () => {
  for (const values of [
    ["24:00:00", "12:00:00"],
    ["12:00:00.1234567", "12:00:00"],
    ["2024-13-01", "2024-01-01"],
    ["0000-12-31", "2024-01-01"],
    ["0001-01-01 00:00:00+01:00", "2024-01-01 00:00:00Z"],
    [" 1", "2"],
    ["1_000", "2"],
    ["0x10", "2"],
    ["1e", "2"],
    ["yes", "no"],
  ]) {
    const { columns, rows } = await read(`x\n${values.join("\n")}\n`);
    assert.equal(columns[0].type, "string", values[0]);
    assert.deepEqual(
      rows,
      values.map((value) => [value]),
    );
  }
});

test("floats are what Number reads of their text", async () => {
  const next = random(7);
  const texts = [
    "0.1",
    "0.3",
    "-0.0",
    "123456789012345.6",
    "9007199254740993.0",
    "1e23",
    "1.7976931348623157e308",
    "5e-324",
  ];
  while (texts.length < 2000) {
    const digits = String(Math.floor(next() * 10 ** (1 + Math.floor(next() * 15))));
    const point = Math.floor(next() * (digits.length + 1));
    texts.push(`${next() < 0.3 ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`);
  }
  const { columns, rows } = await read(`x\n${texts.join("\n")}\n`);
  assert.equal(columns[0].type, "float");
  assert.deepEqual(
    rows,
    texts.map((text) => [floatJson(Number(text))]),
  );
});

test("quotes hold separators, line breaks and doubled quotes, and switch quoting wherever they are", async () => {
  const csv = 'name,note,n\n"Kobe, Hyogo","He said ""hi""",1\n"two\nlines","",2\nplain,,"3"\n"a""b",x"y,"z,4\n';
  const { columns, rows } = await read(csv);
  assert.deepEqual(
    columns.map((column) => column.type),
    ["string", "string", "integer"],
  );
  assert.deepEqual(rows, [
    ["Kobe, Hyogo", 'He said "hi"', 1],
    ["two\nlines", "", 2],
    ["plain", null, 3],
    ['a"b', "xy,z", 4],
  ]);
});

test("lines end with LF or CRLF, the last without one; empty lines are no rows; a UTF-8 byte order mark is left out", async () => {
  const csv = '\ufeffa,b\r\n1,x\r\n\r\n2,"y\r\nz"\r\n\n3,w';
  const { columns, rows } = await read(csv);
  assert.deepEqual(
    columns.map((column) => column.name),
    ["a", "b"],
  );
  assert.deepEqual(rows, [
    [1, "x"],
    [2, "y\r\nz"],
    [3, "w"],
  ]);
  // A byte order mark within the text is text.
  assert.deepEqual((await read("a\n\ufeffb\n")).rows, [["\ufeffb"]]);
  for (const bom of [Uint8Array.of(0xff, 0xfe, 0x61, 0x00), Uint8Array.of(0xfe, 0xff, 0x00, 0x61)]) {
    const error = await failure(bom);
    assert.equal(error.code, "load_failed");
    assert.match(error.message, /UTF-16/);
  }
});

test("empty fields and missing fields are null; a quoted empty field is an empty string, and null in a column of another type", async () => {
  const { columns, rows } = await read('a,b,c\n1,,x\n,2,\n3\n"",5,""\n');
  assert.deepEqual(
    columns.map((column) => column.type),
    ["integer", "integer", "string"],
  );
  assert.deepEqual(rows, [
    [1, null, "x"],
    [null, 2, null],
    [3, null, null],
    [null, 5, ""],
  ]);
  // A column whose only values are empty strings is a column of strings.
  assert.deepEqual((await read('a,b\n"",1\n,2\n')).rows, [
    ["", 1],
    [null, 2],
  ]);
});

test("text that is not UTF-8 fails to load, at its row and column (§2.2)", async () => {
  for (const [text, path] of [
    ["a,b\n1,ok\n2,\\xff\n", "/rows/1/1"],
    ['a,b\n1,"x\\xc0\\xafy"\n', "/rows/0/1"],
    ["a,b\n\\xed\\xa0\\x80,1\n", "/rows/0/0"],
    ["a,b\n1,\\xf4\\x90\\x80\\x80\n", "/rows/0/1"],
    ["a,b\n1,2\n3,\\xe3\\x81", "/rows/1/1"],
    ["a,\\xff\n1,2\n", "/file"],
  ]) {
    const error = await failure(bytes(text));
    assert.equal(error.code, "load_failed", text);
    assert.match(error.message, new RegExp(`at ${path}, .*UTF-8`), text);
  }
  for (const [text, path] of [
    ['{"a":1}\n{"a":"\\xff"}\n', "/rows/1"],
    ['{"a":"\\ud800"}\n', "/rows/0/0"],
  ]) {
    const error = await failure(bytes(text), { format: "jsonl" });
    assert.equal(error.code, "load_failed", text);
    assert.match(error.message, new RegExp(`at ${path}, `), text);
  }
  // Every character of UTF-8, of one to four bytes, is text.
  assert.deepEqual((await read("a\nAé港🎉\n")).rows, [["Aé港🎉"]]);
});

test("files are read the same in slices of any size: rows, quotes and characters across slices", async () => {
  const csv =
    '\ufeffid,name,at\r\n1,"Kōbe, ""港""",2024-01-01 00:00:00\r\n2,"two\nlines 🎉",\r\n\r\n3,é,2024-01-02T03:04:05\n4,,';
  const jsonl = '{"id":1,"name":"Kōbe 港","tags":[1]}\r\n\n{"id":2,"name":"🎉","tags":{"a":"é"}}\n{"id":3}';
  for (const [text, format] of [
    [csv, "csv"],
    [jsonl, "jsonl"],
  ] as const) {
    const table: FileTable = { file: new Blob([text]), format };
    const whole = await readFile(table);
    assert.equal(whole.rowCount, format === "csv" ? 4 : 3);
    for (let chunkBytes = 1; chunkBytes <= 24; chunkBytes++) {
      const sliced = await readFile(table, chunkBytes);
      assert.deepEqual(sliced.columns, whole.columns, `${format} in slices of ${chunkBytes}`);
      assert.deepEqual(valuesOf(sliced), valuesOf(whole), `${format} in slices of ${chunkBytes}`);
    }
  }
});

test("CSV's separator is detected from the first line; TSV, a header, names and formats", async () => {
  assert.deepEqual(await read("a\tb\n1\tx, y\n", { format: "tsv" }), {
    columns: [
      { name: "a", type: "integer" },
      { name: "b", type: "string" },
    ],
    rows: [[1, "x, y"]],
  });
  const semicolons = await read('a;"b,c";d\n1;2,5;x\n');
  assert.deepEqual(
    semicolons.columns.map((column) => column.name),
    ["a", "b,c", "d"],
  );
  assert.deepEqual(semicolons.rows, [[1, "2,5", "x"]]);
  assert.deepEqual((await read("a|b\n1|2\n", { format: "csv", delimiter: "|" })).rows, [[1, 2]]);
  // Without a header, columns are named by their place; rows longer than the others add columns.
  const plain = await read("1,2\n3,4,5\n", { format: "csv", header: false });
  assert.deepEqual(
    plain.columns.map((column) => column.name),
    ["column0", "column1", "column2"],
  );
  assert.deepEqual(plain.rows, [
    [1, 2, null],
    [3, 4, 5],
  ]);
  // Empty names and names that two columns share.
  const names = await read(",a,a,a_1\n1,2,3,4\n");
  assert.deepEqual(
    names.columns.map((column) => column.name),
    ["column0", "a", "a_1", "a_1_1"],
  );
  // The format comes from the name of a File.
  const client = new Client({
    tsv: { file: new File(["a\tb\n1\t2\n"], "data.TSV") },
    lines: { file: new File(['{"a":1}\n'], "data.ndjson") },
    text: { file: new File(["a\n"], "data.txt") },
    blob: { file: new Blob(["a\n"]) },
    wrong: { file: new Blob(["a\n"]), format: "xlsx" as "csv" },
    separator: { file: new Blob(["a\n"]), format: "csv", delimiter: "ab" },
    tsvSeparator: { file: new Blob(["a\n"]), format: "tsv", delimiter: ";" },
    notFile: { file: "a,b\n" as unknown as TextFile, format: "csv" },
  });
  assert.equal((await client.open("tsv")).columns.length, 2);
  assert.equal((await client.open("lines")).rowCount, 1);
  for (const [ref, path] of [
    ["text", "/format"],
    ["blob", "/format"],
    ["wrong", "/format"],
    ["separator", "/delimiter"],
    ["tsvSeparator", "/delimiter"],
    ["notFile", "/file"],
  ]) {
    const error = await client.error("open", { ref });
    assert.equal(error.code, "load_failed", ref);
    assert.match(error.message, new RegExp(`at ${path}, `), ref);
  }
});

test("JSON Lines: a column per key in the order they come, with the type of its values; objects and lists are JSON text", async () => {
  const jsonl = [
    '{"id":1,"name":"Kobe","tags":["a"],"at":"2024-01-01T00:00:00Z","n":1.5,"ok":true,"v":1}',
    "",
    '{"id":3000000000,"name":null,"tags":{"x":"é"},"extra":"late","n":2,"v":"a"}',
    "   ",
    '{"id":9007199254740991,"n":-0,"ok":false,"v":[1]}',
  ].join("\n");
  const { columns, rows } = await read(jsonl, { format: "jsonl" });
  assert.deepEqual(columns, [
    { name: "id", type: "bigint" },
    { name: "name", type: "string" },
    { name: "tags", type: "string", sourceType: "JSON", readOnly: true },
    { name: "at", type: "timestamptz" },
    { name: "n", type: "float" },
    { name: "ok", type: "boolean" },
    { name: "v", type: "string" },
    { name: "extra", type: "string" },
  ]);
  assert.deepEqual(rows, [
    [1, "Kobe", '["a"]', "2024-01-01 00:00:00+00", 1.5, true, "1", null],
    [3000000000, null, '{"x":"é"}', null, 2, null, "a", "late"],
    [9007199254740991, null, null, null, -0, false, "[1]", null],
  ]);
  for (const [text, path, message] of [
    ['{"a":1}\n{"a":\n', "/rows/1", /not JSON/],
    ['{"a":1}\n[1,2]\n', "/rows/1", /object/],
    ['{"a":1}\n"a"\n', "/rows/1", /object/],
  ] as const) {
    const error = await failure(text, { format: "jsonl" });
    assert.equal(error.code, "load_failed", text);
    assert.match(error.message, new RegExp(`at ${path}, `), text);
    assert.match(error.message, message, text);
  }
});

test("a file whose columns would take more memory than maxBytes fails before any is kept", async () => {
  const csv = `n\n${Array.from({ length: 1000 }, (_, index) => index).join("\n")}\n`;
  const error = await failure(csv, { format: "csv", maxBytes: 3999 });
  assert.equal(error.code, "load_failed");
  assert.match(error.message, /at \/maxBytes, .*1000 rows.*maxBytes/);
  assert.equal((await read(csv, { format: "csv", maxBytes: 4000 })).rows.length, 1000);
  assert.match((await failure(csv, { format: "csv", maxBytes: 0 })).message, /at \/maxBytes, /);
});

test("opens of a file share one reading, and an editable file is written like any table (§7.2)", async () => {
  const blob = new Blob(["id,city\n1,Kobe\n2,Osaka\n"]);
  let slices = 0;
  const file: TextFile = {
    size: blob.size,
    slice(start, end) {
      slices++;
      return blob.slice(start, end);
    },
  };
  const client = new Client({ t: { file, format: "csv", editable: true } });
  const [first, second] = await Promise.all([client.open("t"), client.open("t")]);
  // The first three bytes, for a byte order mark, and the file, for each of the two readings.
  assert.equal(slices, 4);
  assert.equal(first.revision, second.revision);
  assert.equal((first.capabilities as { write?: boolean }).write, true);
  await client.result("write", {
    table: first.table,
    revision: first.revision,
    updates: [{ key: { rowId: 1 }, column: "city", value: "Nara", previous: "Osaka" }],
  });
  const rows = await client.rows(second, { sort: [{ column: "city", direction: "asc" }] });
  assert.deepEqual(rows.rows, [
    [1, "Kobe"],
    [2, "Nara"],
  ]);
  // A file that cannot be read fails to load.
  const broken: TextFile = {
    size: 10,
    slice: () => ({ arrayBuffer: () => Promise.reject(new Error("NotReadableError")) }),
  };
  const error = await new Client({ t: { file: broken, format: "csv" } }).error("open", { ref: "t" });
  assert.equal(error.code, "load_failed");
  assert.match(error.message, /at \/file, .*NotReadableError/);
});

/** A field of CSV: quoted when it holds a separator, a quote or a line break, or is an empty string. */
function field(text: string | null): string {
  if (text === null) return "";
  return text === "" || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const COLUMNS: Column[] = [
  { name: "id", type: "integer" },
  { name: "big", type: "bigint" },
  { name: "price", type: "float" },
  { name: "day", type: "date" },
  { name: "at", type: "timestamp" },
  { name: "clock", type: "time" },
  { name: "zone", type: "timestamptz" },
  { name: "flag", type: "boolean" },
  { name: "city", type: "string" },
  { name: "note", type: "string" },
];
const CITIES = ["Kobe", "Osaka", "東京", "a,b", 'say "hi"', "two\nlines", "", "é", "🎉 party", "Kyoto"];

/** A CSV file of generated rows, with the same rows as typed JSON (§2.2). */
function generated(count: number): { csv: string; rows: JsonValue[][] } {
  const next = random(43);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  const lines = [COLUMNS.map((column) => column.name).join(",")];
  const rows: JsonValue[][] = [];
  const firstDay = daysFromCivil(1900, 1, 1);
  const days = daysFromCivil(2100, 1, 1) - firstDay;
  for (let row = 0; row < count; row++) {
    const texts: (string | null)[] = [];
    const values: JsonValue[] = [];
    const add = (text: string | null, value: JsonValue) => {
      const empty = row > 0 && next() < 0.05;
      texts.push(empty ? null : text);
      values.push(empty ? null : value);
    };
    add(String(Math.floor(next() * 2 ** 32) - 2 ** 31), 0);
    values[0] = texts[0] === null ? null : Number(texts[0]);
    const big = BigInt(Math.floor(next() * 2_000_000) - 1_000_000) * BigInt(pick([1, 1000, 10_000_000_000]));
    add(big.toString(), Number.isSafeInteger(Number(big)) ? Number(big) : big.toString());
    const special = pick([
      null,
      null,
      null,
      null,
      null,
      null,
      ["nan", Number.NaN],
      ["-inf", -Infinity],
      ["-0.0", -0],
    ] as const);
    const price = special ? special[1] : Math.round(next() * 2e6 - 1e6) / 100;
    add(special ? special[0] : String(price), floatJson(price));
    const day = firstDay + Math.floor(next() * days);
    add(dateText(day), dateText(day));
    const at = BigInt(day) * 86_400_000_000n + BigInt(Math.floor(next() * 86_400_000_000));
    add(next() < 0.5 ? timestampText(at) : timestampText(at).replace(" ", "T"), timestampText(at));
    const clock = BigInt(Math.floor(next() * 86_400) * 1_000_000 + pick([0, 0, 500_000, 123_456]));
    add(timeText(clock), timeText(clock));
    const offset = (Math.floor(next() * 53) - 24) * 30;
    const sign = offset < 0 ? "-" : "+";
    const zone = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    const local = timestampText(at + BigInt(offset) * 60_000_000n).replace(" ", "T");
    add(`${local}${offset === 0 ? "Z" : zone}`, `${timestampText(at)}+00`);
    const flag = next() < 0.5;
    add(next() < 0.5 ? String(flag) : String(flag).toUpperCase(), flag);
    const city = pick(CITIES);
    add(city, city);
    const note = next() < 0.8 ? null : `note ${row}`;
    add(note, note);
    lines.push(texts.map(field).join(","));
    rows.push(values);
  }
  return { csv: `${lines.join("\r\n")}\r\n`, rows };
}

test("a large generated file answers sorts, filters, groups and summaries as the same rows given as typed JSON", async () => {
  const { csv, rows } = generated(10_000);
  const file = new Blob([csv]);
  // Read in slices smaller than the file, every value is what the rows hold.
  const sliced = await readFile({ file, format: "csv" }, 64 * 1024);
  assert.deepEqual(sliced.columns, COLUMNS);
  assert.deepEqual(valuesOf(sliced), rows);
  const plans = [
    {},
    ...COLUMNS.flatMap((column) =>
      (["asc", "desc"] as const).map((direction) => ({
        sort: [
          { column: column.name, direction },
          { column: "id", direction: "asc" },
        ],
      })),
    ),
    {
      where: { fn: "gt", args: [{ col: "price" }, { lit: 0, type: "float" }] },
      sort: [{ column: "day", direction: "desc" }],
    },
    { where: { fn: "eq", args: [{ col: "flag" }, { lit: true }] }, sort: [{ column: "zone", direction: "asc" }] },
    { where: { search: "osaka" }, sort: [{ column: "at", direction: "asc" }] },
    {
      derive: [{ name: "more", expr: { fn: "add", args: [{ col: "big" }, { lit: 1 }] } }],
      where: { fn: "lt", args: [{ col: "more" }, { lit: 0 }] },
      sort: [{ column: "more", direction: "asc" }],
    },
    {
      aggregate: {
        keys: ["city"],
        measures: [
          { name: "n", fn: "count" },
          { name: "total", fn: "sum", column: "big" },
          { name: "last", fn: "max", column: "at" },
          { name: "first", fn: "min", column: "day" },
        ],
      },
      sort: [{ column: "n", direction: "desc" }],
    },
  ];
  const answers: unknown[][] = [];
  for (const table of [{ columns: COLUMNS, rows } satisfies MemoryTable, { file, format: "csv" } satisfies FileTable]) {
    const client = new Client({ t: table });
    const info = await client.open("t");
    const answer: unknown[] = [info.rowCount, info.columns];
    for (const plan of plans) {
      const { view } = await client.rows(info, plan, { columns: [], end: 0 });
      const names = view.columns.map((column) => column.name);
      const head = await client.rows(info, plan, { columns: names, end: 200 });
      const order = await client.rows(info, plan, { columns: [names[0]], end: view.rowCount });
      answer.push([view.rowCount, head.rows, order.rowIds, order.rows]);
    }
    answer.push(
      await client.result("summarize", {
        table: info.table,
        revision: info.revision,
        plan: {},
        ranges: [[0, rows.length]],
        columns: COLUMNS.map((column) => column.name),
      }),
    );
    answers.push(answer);
  }
  assert.deepEqual(answers[1], answers[0]);
});
