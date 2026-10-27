---
title: セルの編集
description: セルを書き込める条件、エディター、入力した文字の読み方、貼り付け、埋める操作、元に戻す、書き込みの失敗、ファイルへの保存。
---

グリッドは表計算ソフトと同じように編集できます。セルに入力し、範囲を貼り付け、消し、埋め、元に戻せます。書き込んだ値はエンジンがファイルとは別に保持し、その後の読み込み（並べ替え・絞り込み・グループ化・検索・書き出し）はすべてその値を使います。DuckDB エンジンは、書き込んだ値を元の CSV・TSV ファイルに保存することもできます。

## セルを書き込める条件

セルを書き込めるのは、エンジンが書き込みに対応していて（`capabilities.write`）、列が表の列（[計算列](/ja/guides/formulas/)ではない）で、`readOnly` でも `interval`・`binary` 型でもなく、ビューが[グループ化](/ja/guides/grouping/)されていないときです。それ以外のセルに入力すると「このセルは書き込めません。」と伝えます。

| エンジン | 書き込み | ファイルへの保存 |
| --- | --- | --- |
| メモリーエンジン（`vastgrid-js`） | `editable: true` を付けた表 | しません。書き込んだ値はメモリー上にあり、渡した `rows` とは別に保持します |
| DuckDB エンジン（`vastgrid-duckdb`） | すべての表 | `saveFiles: true` のとき、圧縮していない CSV・TSV ファイルに保存します |

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({ tables: { orders: { columns, rows, editable: true } } });
```

```ts
import { DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
  saveFiles: true,
});
```

DuckDB エンジンで書き込んだ値は表に属します。同じエンジンで同じファイルを開いているグリッドはすべてその値を読み、保存しないまま最後のグリッドが閉じると値は消えます。

## エディター

- 文字を入力すると、その文字が入った状態でエディターが開きます。IME の変換もエディターの中で始まるので、日本語・中国語・韓国語の入力もそのまま入ります。
- F2 かダブルクリックで、セルの値をテキストにした状態（`2024-01-31`、`1234.50`）で開きます。
- Enter で書き込んで下へ（Shift ＋ Enter で上へ）、Tab で書き込んで右へ（Shift ＋ Tab で左へ）移ります。複数のセルを選んでいるときは、その中を順に動きます。
- Alt ＋ Enter（Mac では ⌃ ＋ Return）で改行します。Esc で取り消します。ページのほかの場所をクリックすると書き込みます。
- 列の値として読めない文字のときは、エディターを開いたままにして理由を伝えます（「price の値として読めません。」）。

書き込んだ値は、エンジンの応答を待たずにすぐ表示します。書き込みに失敗したときは元の値に戻し、ステータスバーに理由を表示します（[書き込みに失敗したとき](#書き込みに失敗したとき)を参照）。

## 入力した文字の読み方

| 型 | 受け付ける文字 |
| --- | --- |
| `string` | 入力したとおりの文字。空白だけの文字は null |
| `integer`・`bigint` | 符号を付けられる数字。型の範囲内 |
| `decimal` | `12.5`、`.5`。小数部の桁は列の scale まで、指数は不可 |
| `float` | `1.5`、`1.5e3`、`inf`、`-infinity`、`nan` |
| `boolean` | `true`・`false`・`1`・`0`（大文字・小文字を問わない） |
| `date` | `2024-01-31`、`2024/1/31`、`2024.1.31`。実在する日 |
| `time` | `9:05`、`09:05:30`、`09:05:30.25`（小数部は 6 桁まで） |
| `timestamp` | 日付、続けて空白か `T` と時刻 |
| `timestamptz` | timestamp、続けて `Z` か `+09:00` のようなオフセット。なければ UTC |
| `uuid` | 16 進数 32 桁。ハイフンはあってもなくてもよい |
| `interval`・`binary` | 入力できない |

文字の前後の空白は、文字列以外では取り除きます。空の文字はどの型でも null です。貼り付ける数値は、カンマの桁区切り（`1,234.5`）があっても読めます。規則の全体は仕様の [§7.3](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#73-reading-typed-text) にあります。

## 貼り付け・消去・埋める

- **貼り付け**（⌘/Ctrl ＋ V）は、クリップボードのタブ区切りのテキスト、なければ HTML の最初の表を、各範囲の左上のセルから書き込みます。範囲の行数と列数が値の行数と列数のちょうど倍数なら、値を繰り返します。値が 1 つなら、範囲がいくつあっても選んだすべてのセルに入ります。複数の値を複数の範囲に貼り付けることはできません。ビューからはみ出す行や列は書き込まず、行を足すこともしません。
- **消去**（Delete か Backspace）は、選んだセルのうち書き込めて空白でないものに null を書き込みます。
- **下へコピー**（⌘/Ctrl ＋ D）と **右へコピー**（⌘/Ctrl ＋ R）は、各範囲の最初の行（列）を残りにコピーします。1 行だけの範囲は上の行を、1 列だけの範囲は左の列をコピーします。2 つの列の型が同じなら値をそのまま、違えばテキストから読み直して書き込みます。

書き込みはどれも、すべてのセルに書き込むか、どれにも書き込まないかのどちらかです。一度に書き込めるのは 100,000 セルまでです（`too_many_cells`）。

## 元に戻す・やり直す

⌘/Ctrl ＋ Z で最後の書き込み（入力・貼り付け・消去・埋める操作）を元に戻し、⌘/Ctrl ＋ Shift ＋ Z（Apple 以外では Ctrl ＋ Y も）でやり直します。書き込みはセルを行のキーで指すので、並べ替えや絞り込みの後でも元のセルに戻せます。履歴はセッションのもので（`session.history`）、100 ステップ・1,000,000 セルまで持ち、表を別のリビジョンとして読み直すと空になります。元に戻す操作は、その前に送った書き込みを待ってから行います。

## 書き込みに失敗したとき

書き込みは、セルがそれまで持っていた値（`previous`）を一緒に送ります。その間にほかのタブ、同じサーバーを使うほかの人、エージェントなどがセルを変えていると、エンジンは `edit_conflict` で書き込みを断ります。セルはいまの値を表示し、ステータスバーに「書き込めませんでした: その間にセルが変更されています。いまの値を表示しています。」とボタンが出ます。

| ボタン | 出るとき | 動作 |
| --- | --- | --- |
| 再試行 | 接続が切れたとき、エンジンが失敗したとき（`internal`・`cancelled`・`not_ready`・`table_not_found`） | 同じ書き込みをもう一度送る（`store.retryWrite()`） |
| 上書き | `edit_conflict` の後 | セルに上書きする。元に戻すと上書きされた値に戻る |
| 破棄 | いつでも | 書き込みを捨てる（`store.discardWrite()`） |

値やセルが原因で断られた書き込み（`invalid_value`・`read_only`）や、表を読み直したために断られた書き込み（`revision_changed`）は、破棄するしかありません。それまでの間、書き込みはスナップショットの `failedWrite` にあり、コマンド・セル・エラー・`retry`（`"retry"`・`"overwrite"`・null）を持つので、アプリが独自に表示することもできます。

## ファイルへの保存

`saveFiles: true` の DuckDB エンジンは、書き込んだセルを元の CSV・TSV ファイルに保存します。

- 保存していないセルがある間、ツールバーに **保存** ボタンが出ます。⌘/Ctrl ＋ S でも保存でき、エディターからも使えます（入力中の文字を先に書き込みます）。ステータスバーは「未保存 3」、「保存しています…」、「2 行を保存しました」と表示します。
- 書き込むのは、編集したレコードの編集したフィールドだけです。BOM、ヘッダー、ほかのレコードやフィールド、引用符、区切り文字、改行、文字コードなど、それ以外のバイトはそのまま残します。値はファイルを読み直したときに同じ値になる形（日付はファイルの形式）で、必要なら引用符で囲んで書きます。新しいファイルを書き終えてから元のファイルと置き換えます。
- 読み込んだ後にほかの人が変更したファイルには上書きしません。ステータスバーに「保存しませんでした: ファイルがほかで変更されています。…」と表示し、編集は残します。
- Parquet・JSON Lines・Excel や圧縮したファイルには書き込みません。これらのセルも編集でき、編集した値ごと[書き出せます](/ja/guides/export/)。

メモリーエンジンは保存しません。書き込んだ値を残すには、表全体を[書き出して](/ja/guides/export/)ください。書き出しには書き込んだ値が入ります。

## ディスク上のファイルが変わったとき

DuckDB エンジンは、開いている表のファイルを見張っています（[§7.6](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#76-files-that-change-on-disk)）。

- 書き込んだセルのない表は読み直し、グリッドはいまのファイルを表示します。履歴の行のキーは古いリビジョンのものなので、履歴は空になります。
- 書き込んだセルのある表は、編集を失わないよう読み込んだときのまま残します。ステータスバーに「ディスク上のファイルが変更されました。未保存の編集は残っています。」と表示し、保存はできなくなります。ツールバーの **編集を破棄して再読み込み** で、編集を捨てていまのファイルを読み込みます（`store.reload()`）。

## コードから書き込む

コードからの書き込みは、人のキー操作と同じコマンドなので、同じ検証・履歴・失敗の扱いを受けます。

```tsx
import { useRef } from "react";
import { DataGrid, type DataGridHandle, type Transport } from "vastgrid";

export function Orders({ transport }: { transport: Transport }) {
  const grid = useRef<DataGridHandle>(null);

  async function setPrice(row: number, text: string) {
    const dispatch = grid.current!.dispatch;
    await dispatch({ command: "select", row, column: "price" });
    await dispatch({ command: "edit.begin", text });
    const outcome = await dispatch({ command: "edit.commit", move: null });
    if (!outcome.ok) console.error(outcome.error.code, outcome.error.message);
  }

  return <DataGrid ref={grid} transport={transport} table="orders" />;
}
```

`row` はビューでの位置で、文字は人が入力したときと同じように読みます。ほかの書き込みは次のとおりです。

| コマンド | 書き込むもの |
| --- | --- |
| `{ command: "edit.clear" }` | 選んだセルに null |
| `dispatch({ command: "edit.paste" }, { clipboard: { text: "1\t2\n3\t4" } })` | テキストを選択範囲に。出力は `{ cutRows, cutColumns }` |
| `{ command: "edit.fill", direction: "down" }` | 各範囲の最初の行を残りに（`"right"` なら最初の列） |
| `{ command: "history.undo" }`・`{ command: "history.redo" }` | 最後のステップの前・後の値 |
| `{ command: "save" }` | 書き込んだセルをファイルに。エンジンが保存しないときは `unsupported` |

コマンドが必要とする行は、ストアが先に読み込みます。コードからの書き込みも `previous` を送るので、その間に変わったセルへの書き込みは、ほかの変更を消さずに `edit_conflict` で失敗します。コマンドの一覧は[コマンド](/ja/reference/commands/)にあります。
