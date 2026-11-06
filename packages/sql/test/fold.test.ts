import assert from "node:assert/strict";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { type Column, checkPlan, FOLD_TABLES, type Fold, foldAll } from "vastgrid-spec";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { compileView, quoteIdentifier, rowsQuery } from "../src/index.ts";

// Code points that the folds change or make, letters in both cases, and others that `lower` maps the same in
// JavaScript and DuckDB.
const ALPHABET = [
  ..."ｶｷﾊﾀｳﾜｦｲﾔﾌｪﾞﾟ゙゚カガキギハバパタダウヴイヤフェかがきぎはばぱただうゔいやふぇ",
  ..."aAａＡbBｂＢ　 。｡「｢東京0０-",
];
const FOLD_LISTS: Fold[][] = [["width"], ["kana"], ["width", "kana"]];

function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
}

function text(next: (limit: number) => number, length: number) {
  return Array.from({ length }, () => ALPHABET[next(ALPHABET.length)]).join("");
}

const next = random(17);
// Values with the pairs of the width fold, which a search for one of their code points must not find.
const PAIRS = ["ｶﾞ", "ｶﾞｶ", "ﾊﾟﾊﾞ", "ｳﾞ", "ﾜﾞｦﾞ", "ﾞ", "ﾟ", "ｶ゙", "ガ", "ﾀﾞｲﾔ"];
const values = [...PAIRS, ...Array.from({ length: 400 }, () => text(next, 1 + next(6)))];
const columns: Column[] = [{ name: "s", type: "string" }];
const source = { relation: quoteIdentifier("t"), rowId: "id" };
let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await connection.run("CREATE TABLE t (id BIGINT, s VARCHAR)");
  const appender = await connection.createAppender("t");
  values.forEach((value, index) => {
    appender.appendBigInt(BigInt(index));
    appender.appendVarchar(value);
    appender.endRow();
  });
  appender.closeSync();
});

afterAll(() => {
  connection.closeSync();
  instance.closeSync();
});

async function found(search: string, fold: Fold[]) {
  const view = compileView(checkPlan({ where: { search, fold } }, columns), source);
  const query = rowsQuery(view, { start: 0, end: values.length, columns: [] });
  const rows = (await connection.runAndReadAll(query.sql, query.params as never)).getRowsJS();
  return rows.map((row) => Number(row.at(-1))).sort((a, b) => a - b);
}

test("a search folds the values as the text, finding the rows that folding everything finds (§3.5)", async () => {
  const marks = ["ｶ", "カ", "か", "ハ", "ウ", "ワ", "ｦ", "タ", "゙", "゚", "ﾞ", "ﾟ", "ガ", "パ", "ヴ", "ヷ", "Ａ"];
  // A search needs text other than spaces.
  const needles = [...Array.from({ length: 60 }, () => text(next, 1 + next(3))).filter((n) => n.trim()), ...marks];
  for (const fold of FOLD_LISTS) {
    for (const needle of needles) {
      const folded = foldAll(needle, fold).toLowerCase();
      const expected = values.flatMap((value, index) =>
        foldAll(value, fold).toLowerCase().includes(folded) ? [index] : [],
      );
      assert.deepEqual(await found(needle, fold), expected, `${JSON.stringify(needle)} folded by ${fold.join(", ")}`);
    }
  }
});

test("a search folds values only by what can make its text, and only strings", () => {
  const sql = (search: string, fold: Fold[], table: Column[] = columns) =>
    compileView(checkPlan({ where: { search, fold } }, table), source).with;
  // No fold makes 東 or 京: the values are not folded at all.
  assert.ok(!/replace|translate|regexp_matches/.test(sql("東京", ["width", "kana"])), sql("東京", ["width", "kana"]));
  // Few code points make カ, フ and ェ: `replace`, only for values that hold one of them.
  const kana = sql("かふぇ", ["width", "kana"]);
  assert.ok(kana.includes("regexp_matches") && kana.includes("replace(") && !kana.includes("translate("), kana);
  // The text forms of other types are ASCII: a uuid is not folded.
  const uuid = sql("０ｆ", ["width"], [{ name: "u", type: "uuid" }]);
  assert.ok(!/replace|translate|regexp_matches/.test(uuid), uuid);
});

test("fold in an expression folds every code point of its tables, with or without the guard (§4.4)", async () => {
  for (const fold of Object.keys(FOLD_TABLES) as Fold[]) {
    for (const arg of [{ col: "s" }, { fn: "concat", args: [{ col: "s" }, { lit: "ｶ" }] }]) {
      const plan = checkPlan({ derive: [{ name: "f", expr: { fn: "fold", args: [arg, { lit: fold }] } }] }, columns);
      const view = compileView(plan, source);
      const query = rowsQuery(view, { start: 0, end: values.length, columns: ["f"] });
      const rows = (await connection.runAndReadAll(query.sql, query.params as never)).getRowsJS();
      const suffix = "col" in arg ? "" : "ｶ";
      assert.deepEqual(
        rows.map((row) => row[0]),
        values.map((value) => foldAll(value + suffix, [fold])),
        `fold(${JSON.stringify(arg)}, ${fold})`,
      );
    }
  }
});
