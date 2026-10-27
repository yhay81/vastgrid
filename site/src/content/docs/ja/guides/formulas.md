---
title: 計算列
description: 行ごとに式で計算する列、式の書き方と関数、コードからの計算列。
---

計算列は、同じ行のほかの列から行ごとに計算する列です（例：`qty * price`）。グリッドは式をプランの `derive` の式に変換し、エンジンがデータのそばで表全体について計算します。そのため計算列は、表の大きさにかかわらず、ほかの列と同じように並べ替え・絞り込み・グループ化・集計行・書き出しができます。計算は行ごとで、ほかの行やセルは参照できません。

計算列に対応するエンジンは `capabilities.plan.derive` を返します。メモリーエンジンと DuckDB エンジンはどちらも対応していて、結果も同じです。

## 計算列メニュー

ツールバーの **計算列** メニューは、計算列ごとに列名と式を並べ、最後に新しい列の行（「列名」「式」と追加ボタン）を出します。行を書き換えて適用を押すと式や列名が変わり、削除を押すとその列を削除します。その列を使う計算列・並べ替え・絞り込み・グループ化も一緒に外れます。

式で使えるのは、表の列と、それより前の計算列です。変換できない式は適用せず、理由を示して、問題のある文字を選択します。計算列には書き込めません。読んでいるセルに書き込むと、計算列の値も変わります。

## 式の書き方

- **列名**：`price` のように書きます。空白やほかの文字を含む名前、式の言葉と同じ名前は角かっこで囲みます（`[unit price]`、`[and]`）。角かっこの中の `]]` は `]` です。
- **数値**は正確なまま扱います。`12` は整数、`1.50` は小数点以下 2 桁の decimal で、指数付きの数（`1.5e3`）だけが浮動小数点数です。`0.1 + 0.2` はちょうど `0.3` になります。割り算の結果は浮動小数点数です。
- **文字列**は一重か二重の引用符で囲み、中の引用符は 2 つ重ねます（`'it''s'`）。`TRUE`・`FALSE`・`NULL` も使えます。
- **型付きの値**：`DATE '2024-01-31'`、`TIMESTAMP '2024-01-31 12:00:00'`、`FLOAT 'nan'`、`DATE NULL`。
- **関数**は大文字・小文字を問いません（`ROUND(price * 1.1, 0)`、`if(qty > 10, 'bulk', 'single')`）。

演算子（優先順位の低い順）：

| 演算子 | 意味 |
| --- | --- |
| `OR` | どちらかが真 |
| `AND` | どちらも真 |
| `NOT` | 否定 |
| `=`（`==`）・`<>`（`!=`）・`<`・`<=`・`>`・`>=` | 比較 |
| `&` | 文字列としてつなぐ（`first & ' ' & last`） |
| `+`・`-` | 足し算・引き算 |
| `*`・`/`・`%` | 掛け算・割り算・余り |
| 値の前の `-` | 符号の反転 |

引数に null があると、関数の結果は null です。ただし論理演算、`COALESCE`、`IS_NULL`、`IS_BLANK`、`IF`（条件が null なら 3 つ目の引数）、`LEAST`、`GREATEST`、`&`（null を空の文字列として扱う）は別です。0 での割り算や `SQRT(-1)` のように行の計算が失敗したときは、エラーにせずその行を null にします。

`CONTAINS`・`STARTS_WITH`・`ENDS_WITH`・`=` は大文字と小文字を区別します。区別しないときは両辺を小文字にします（`CONTAINS(LOWER(name), 'tokyo')`）。

## 関数

| 種類 | 関数 |
| --- | --- |
| 論理 | `IF(条件, a, b)`、`COALESCE`、`IN(x, 'a', 'b', …)`、`IS_NULL`、`IS_BLANK`、`LEAST`、`GREATEST`、`NOT` |
| 数値 | `ABS`、`ROUND(x, 桁)`（桁は −18〜18、0.5 は 0 から遠い方へ）、`FLOOR`、`CEIL`、`SQRT`、`EXP`、`LN`、`LOG10`、`POWER`、`SIGN`、`TO_NUMBER(文字列)` |
| 文字列 | `LENGTH`、`LOWER`、`UPPER`、`TRIM`、`LEFT`、`RIGHT`、`SUBSTR(s, 開始, 長さ)`（1 から数える）、`REPLACE`、`CONTAINS`、`STARTS_WITH`、`ENDS_WITH`、`TEXT(x)`、`CONCAT` |
| 日付 | `TO_DATE(文字列)`、`TO_TIMESTAMP(文字列)`、`YEAR`、`MONTH`、`DAY`、`HOUR`、`MINUTE`、`SECOND`、`ISODOW`（月曜が 1）、`DATE_DIFF_DAYS(開始, 終了)`、`ADD_DAYS(d, n)` |

関数が受け取る型は仕様の [§4.4](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#44-functions) のとおりで、それ以外の組み合わせは型のエラーとしてメニューに表示します。日付を受け取るところでは、日付として読める引用符付きの文字列は日付になります（`YEAR('2024-03-01')`、`day > '2024-01-01'`）。timestamp を受け取るところの日付は、その日の 0 時です。

v1 の関数名も使えます。`CEILING`、`LEN`、`MID`、`STARTSWITH`、`ENDSWITH`、`ADDDAYS`、`ISBLANK`、`WEEKDAY`、`DAYS(終了, 開始)`、値の `MIN` と `MAX`、引数 2 つの `IF`、`VALUE`、`DATE`、`DATETIME` です。グリッドはこれらを上の表の名前で表示します。

## コードから使う

計算列は `derive.add`・`derive.update`・`derive.remove` のコマンドです。コマンドに渡す式の構造（`expr`）は、`vastgrid-spec` の `compileFormula` で式の文字から作れます（`npm install vastgrid-spec`）。

```ts
import { compileFormula, FormulaError, formulaText } from "vastgrid-spec";

const columns = store.getSnapshot().table?.columns ?? [];
try {
  const { expr } = compileFormula("qty * [unit price]", columns);
  await store.dispatch({ command: "derive.add", name: "amount", expr });
} catch (error) {
  // reason: syntax, unknown_column, unknown_function, arity, type, literal, limit, unsupported
  if (error instanceof FormulaError) console.log(error.reason, error.start, error.end);
}

formulaText({ fn: "mul", args: [{ col: "qty" }, { col: "unit price" }] }); // "qty * [unit price]"
```

| コマンド | 引数 |
| --- | --- |
| `derive.add` | `name`、`expr`、`before`（この計算列の前に入れる） |
| `derive.update` | `name`、新しい `expr`、`rename` |
| `derive.remove` | `name`。その列を使うものも外す |

`compileFormula(text, columns, options)` は、式で使える列を受け取ります。options はプランの検査のオプションで、エンジンに合わせたものは `planOptions(capabilities)` で作れます。`formulaText` はどの式の構造も式の文字に戻します。ドキュメントが保存するのは式の文字ではなく式の構造なので（[状態](/ja/guides/state/)）、ドキュメントに直接書くこともできます。

```ts
import type { GridDocument } from "vastgrid";

const document: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: { derive: [{ name: "amount", expr: { fn: "mul", args: [{ col: "qty" }, { col: "price" }] } }] },
};
```

## 上限と v1 との違い

- 式は 100,000 文字、入れ子は 64 段までです。1 つのプランの計算列は 32 個までです。
- v1 はすべての数値を 64 ビットの浮動小数点数で計算していました。v2 は正確な数値を正確なまま扱うので、`ROUND(0.285, 2)` は `0.28` ではなく `0.29`、decimal の `1.50` の 2 倍は `3.00` です。
- 文字列にしたときの形は仕様に従います。`TEXT(TRUE)` は `true`、浮動小数点数の 5 は `5.0`、`TEXT(0.00001)` は `0.00001` です。
- `LEFT('abc', NULL)` は空の文字列ではなく null です。`VALUE('1_000')` や、文字列 `2024-1-5` の `DATE` も null です。
- `ROUND(x, 400)` と `NULL = NULL` は型のエラーになります。

違いの一覧は [§4.11](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#411-formulas) にあります。
