---
title: 計算列
description: 行ごとに式で計算する列。ほかの列と同じように並べ替え・絞り込み・集計・書き出しができます。
---

計算列は、同じ行のほかの列から行ごとに計算する列です（例：`qty * price`）。計算はデータのそばにある source が行うので、表の大きさにかかわらず使えます。ファイルの列と同じように並べ替え、絞り込み（条件木を含む）、統計、選択範囲の集計、書き出しができます。対象は行ごとの計算だけで、ほかの行やセルは参照できません。

| source | 計算列 |
| --- | --- |
| `RemoteSource` ＋ `vastgrid-duckdb` | 対応。SQL に変換して DuckDB が計算します。 |
| `ArraySource` | 対応。JavaScript で計算し、結果は DuckDB と同じです。 |
| `BrowserSource`（`vastgrid-browser`） | 未対応（`capabilities.formulas` が false）。 |

source は `capabilities.formulas` で対応を知らせます。対応していない source では、メニューの項目を出さず、式も送りません。状態に保存された式は、対応する source で使うまで（表示せずに）残ります。

## グリッドでの操作

列メニューに **計算列を追加…** があり、計算列では **式を編集…** と **計算列を削除** も出ます。編集画面は列名と式を入力のたびに確かめ、間違い（ない列、文字列と数値の掛け算、かっこの閉じ忘れなど）を入力欄の下に示します。正しいときは結果の型を表示します。列と関数を選んで挿入することもできます。新しい列は、メニューを開いた列のすぐ後ろに入ります。式を変えても、並べ替え・絞り込み・列の設定は列名で付いてきます。ほかの式が使っている列は、その式を変えるまで削除や名前の変更ができません。

計算できない式（使っている列がファイルからなくなった場合など）は、列として表示しません。式はグリッドの formulas（と状態）に残り、**列** パネルの「エラーのある計算列」から開いて直せます。

## アプリからの指定

```tsx
const [formulas, setFormulas] = useState<FormulaColumn[]>([
  { name: "total", expression: "qty * price" },
  { name: "税込", expression: "ROUND(total * 1.1, 2)" },
]);

<DataGrid source={source} formulas={formulas} onFormulasChange={setFormulas} />;
```

- `formulas` は開始時と、異なる値を渡したときに適用します。利用者の変更は `onFormulasChange` で受け取れます。ハンドルには `getFormulas()` と `setFormulas()` があります。
- 式 `i` はスキーマの列 `info.columns.length + i`（表の列の後ろ）です（それより前の式がすべて計算できる間）。`controller.schema` はグリッドが表示する列の一覧で、計算列には `expression` が付きます。
- `getState()` は式を `formulas` に（エラーのある式も含めて）保存し、`schema` に列名を入れるので、計算列の並べ替えや絞り込みも列名で復元できます。
- グリッドのクエリ（`onQueryChange`、`getQuery()`）は、source に送る式を `formulas` として持ちます。`setQuery()` はこれを無視します。式は `formulas` で指定します。

## 式の書き方

### 列と値

- 列は名前で書きます：`price`、`単価`。空白や記号を含む名前は角かっこで囲みます：`[unit price]`（名前の中の `]` は `]]`）。式の語と同じ名前（`and`、`not`、`null` など）も角かっこで囲みます。
- 数値：`12`、`1.5`、`.5`、`2e3`。文字列は一重または二重の引用符で囲みます：`'it''s'`、`"a"`（引用符は二つ重ねて書きます）。`TRUE`、`FALSE`、`NULL`（空白）。
- ほかの計算列も名前で使えます。自分自身は（ほかの式を経由しても）使えません。

### 演算子

優先順位の低いものから順に並べます。

| 演算子 | 意味 |
| --- | --- |
| `OR` | どちらかが真。 |
| `AND` | 両方が真。 |
| `NOT` | 真でない。 |
| `=`（`==`）、`<>`（`!=`）、`<`、`<=`、`>`、`>=` | 数値・文字列（文字コード順）・真偽値・日付・日時の比較。 |
| `&` | 文字列をつなぐ。ほかの値は文字列にし、空白は空の文字列として扱います。 |
| `+`、`-` | 足し算、引き算。 |
| `*`、`/`、`%` | 掛け算、割り算、余り（割られる数の符号）。 |
| `-` | 負の符号。 |

かっこでまとめられます。日付・日時を式に書いた文字列と比べると、文字列を日付・日時として読みます：`day >= '2024-01-01'`、`seen < '2024-06-30 12:00'`。

### 型と空白

値は数値（64 ビット浮動小数点）、文字列、真偽値（`TRUE`/`FALSE`）、日付、日時（タイムゾーンのない日付と時刻。タイムゾーン付きの日時は UTC として扱います）のどれかです。整数・小数の列は数値として読むので、計算では 15 桁程度より細かい桁が丸められます。`TEXT(列)` は元の桁のまま文字列にします。そのほかの型の列（UUID、リスト、時刻など）は文字列として読みます。

型は計算の前に確かめます。`price * name`（数値×文字列）や `IF(ok, 1, 'a')` はエラーです。型の変換には `TEXT`・`VALUE`・`DATE`・`DATETIME` を使います。

空白に対する演算はたいてい空白になります。`AND` と `OR` は SQL と同じ（`FALSE AND NULL` は偽）、`&` と `CONCAT` は空白を空の文字列として扱い、`IF` は条件が空白のとき 2 つ目の値を返し、空白との比較は空白です（その行は絞り込みに一致しません）。0 での割り算、有限の数にならない結果（範囲外）、負の数の平方根や 0 以下の対数、`VALUE`・`DATE`・`DATETIME` が読めない文字列は、エラーではなく空白になります。

### 関数

関数名の大文字・小文字は区別しません。

| 関数 | 結果 |
| --- | --- |
| `ABS(x)`、`SIGN(x)` | 絶対値。-1・0・1 のどれか。 |
| `ROUND(x)`、`ROUND(x, 桁)` | 四捨五入（0 から遠い方へ）。桁は負でもよい（`ROUND(1234, -2)` は 1200）。 |
| `FLOOR(x)`、`CEILING(x)`（`CEIL`） | 切り捨て、切り上げ。 |
| `SQRT(x)`、`POWER(x, y)`、`EXP(x)`、`LN(x)`、`LOG10(x)` | 平方根、べき乗、指数、対数。 |
| `MOD(x, y)` | 余り（`%` と同じ）。 |
| `MIN(a, b, …)`、`MAX(a, b, …)` | 空白でない値の最小・最大（数値・文字列・日付・日時）。 |
| `LEN(t)`（`LENGTH`） | 文字数。 |
| `LOWER(t)`、`UPPER(t)`、`TRIM(t)` | 小文字・大文字にする。両端の空白を除く。 |
| `LEFT(t, n)`、`RIGHT(t, n)` | 先頭・末尾の `n` 文字。 |
| `MID(t, 開始, n)` | `開始` 文字目から `n` 文字（1 が先頭。1 未満は 1 とみなす）。 |
| `REPLACE(t, 検索, 置換)` | `検索` をすべて `置換` にする。 |
| `CONTAINS(t, s)`、`STARTSWITH(t, s)`、`ENDSWITH(t, s)` | `t` が `s` を含む・`s` で始まる・`s` で終わるか（大文字・小文字を区別）。 |
| `CONCAT(a, b, …)` | 値を文字列としてつなぐ。 |
| `TEXT(x)` | 値を文字列にする。数値は最短の形（`1.5`、`3`、`1e-05`）、真偽値は `TRUE`/`FALSE`、日付は `2024-01-31`。 |
| `VALUE(t)` | 文字列の中の数値（`" 1_000.5 "` は 1000.5）。読めなければ空白。 |
| `DATE(x)`、`DATETIME(x)` | 文字列（`YYYY-MM-DD`、続けて ` HH:MM`・`:SS`・小数秒も可）、日付、日時から日付・日時を作る。 |
| `YEAR(d)`、`MONTH(d)`、`DAY(d)`、`WEEKDAY(d)` | 日付・日時の年・月・日・曜日（1 が月曜、7 が日曜）。 |
| `HOUR(ts)`、`MINUTE(ts)`、`SECOND(ts)` | 日時の時・分・秒。 |
| `DAYS(終了, 開始)` | `開始` から `終了` までの日数（日付、または日時の日付）。 |
| `ADDDAYS(d, n)` | `n` 日後の日付・日時。 |
| `IF(条件, 真のとき, 偽のとき)` | 条件が真なら `真のとき`、そうでなければ `偽のとき`（省略すると空白）。 |
| `COALESCE(a, b, …)` | 空白でない最初の値。 |
| `ISBLANK(x)` | 空白（または空の文字列）か。 |

例：

```text
qty * price
ROUND(total * 1.1, 2)
IF(status = 'open' AND due < '2024-07-01', '遅れ', '')
UPPER(LEFT(region, 3)) & '-' & TEXT(id)
DAYS(shipped, ordered)
COALESCE(phone, email, '(なし)')
```

### 上限

計算列は 1 つのグリッドに 32 列まで（`MAX_FORMULAS`）。式は 2,000 文字まで（`MAX_FORMULA_LENGTH`）、入れ子は 64 段まで（`MAX_FORMULA_DEPTH`）、使っている計算列を展開した演算の数は 1,000 まで（`MAX_FORMULA_NODES`）です。列名は 256 文字までです。

## 安全性

式は JavaScript でも SQL でもない独自の言語です。`vastgrid-core` が解析・検査し、式の文字列をコードとして実行することはありません。DuckDB のエンジンは検査済みの式を SQL に変換します。列は引用した識別子に、値はすべてパラメーターになり、使う関数は一覧にあるものだけで、それぞれ決まった SQL の式に対応します。`1); DROP TABLE x` は構文エラー、`read_csv('…')` はない関数として拒否します。サーバーは受け取った式を上の上限とともに必ず検査し直します。

## どの source でも同じ結果

`ArraySource` と DuckDB のエンジンは、同じデータに対して同じ値を返します。テストですべての関数の結果を比べています。例外は 2 つです。`LOWER` と `UPPER` は特殊な大文字・小文字の規則を持つ一部の文字（`ß` など）で結果が異なることがあり、`EXP`・`LN`・`LOG10`・`POWER` は実行環境の数学ライブラリによって最後の桁が異なることがあります。選択範囲の集計や統計の合計は、浮動小数点の列と同じく最後の桁が異なることがあります。

## 独自の source

式に対応する source は `capabilities.formulas` を報告し、`ViewQuery.formulas` を扱います。

```ts
import { formulaEvaluator, formulaSchema, queryFormulas } from "vastgrid-core";

const compiled = queryFormulas(info.columns, query); // 正しくない式は invalid_request を投げる
const columns = formulaSchema(info.columns, compiled); // ビューの列
const evaluate = compiled.map((formula) => formulaEvaluator(formula.tree!));
// 行の式 i の値：evaluate[i]((column) => valueOf(row, column))
```

SQL のエンジンは、`vastgrid-duckdb` の `formula.ts` のように `CompiledFormula.tree`（`FormulaExpression`）を節ごとに変換できます。
