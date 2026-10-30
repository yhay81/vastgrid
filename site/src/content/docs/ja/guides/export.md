---
title: 書き出し
description: 書き出しメニュー、形式ごとに書く内容、ファイルの行き先、コードからの書き出し。
---

ツールバーの **書き出し** メニューは、グリッドの行をファイルに書き出します。エンジンが書き出しに対応しているとき（`capabilities.export`）に表示し、エンジンが書ける形式（`capabilities.export.formats`）ごとにボタンを出します。

| エンジン | 形式 | ファイルの行き先（`capabilities.export.delivery`） |
| --- | --- | --- |
| メモリーエンジン（`vastgrid-js`） | CSV・TSV・JSON・Excel | `data`：エンジンがファイルのバイト列を返し、ブラウザーが保存します |
| DuckDB エンジン（`vastgrid-duckdb`） | CSV・TSV・Parquet・JSON・Excel | `file`：エンジンがサーバーにファイルを書き、ブラウザーがダウンロードします |

## 書き出す内容

- **行**：「ビューの行」（既定）は、絞り込み・検索・並べ替え・計算列・グループ化を含め、グリッドが表示しているとおりのビューを書きます。「表全体」は、それらを使わずに表のすべての行を元の順で書きます。
- **列**：表示している列を表示の順で書きます。「非表示の列も含める」をオンにすると、残りの列をその後に足します。
- **見出し**：CSV・TSV・Excel の見出しには列の表示名（書式…で設定したもの、なければ列名）を使います。Parquet と JSON は列名のままです。
- **値**：画面に表示した文字ではなく値を書きます。グリッドで書き込んだセル（[セルの編集](/ja/guides/editing/)）の値も入ります。Excel のセルには、列の数値と日付の書式を付けます。
- **ファイル名**：表の名前に形式の拡張子を付けます。`orders.csv` を Excel で書き出すと `orders.xlsx` になります。

書き出している間、ボタンは「書き出しています…」になり、終わると「12,345 行を書き出しました」と伝えます。ファイルは完全にできるか、まったくできないかのどちらかで、失敗した書き出しは何も残しません。読み込み中の表は、読み込みが終わってから書き出します。

## 形式

| 形式 | 書き方 | 上限 |
| --- | --- | --- |
| CSV・TSV | 見出しの行、続けて値をテキストで書く。必要なら引用符で囲む | なし |
| Parquet | 列を列名と型のまま書く | なし |
| JSON | 列名をキーにしたオブジェクトの配列。数値はすべての桁を持つ数値（`"nan"`・`"inf"` は文字列）、真偽値はそのまま、ほかの値は文字列 | なし |
| Excel（`.xlsx`） | シート 1 枚。太字で固定した見出しの行。数値・真偽値・日付はその種類のセルにし、列の書式を付ける。文字列は常に文字列で、数式にはしない。double で正確に表せない数値は文字列 | 1,048,575 行・16,384 列（`export_too_large`）。1 セル 32,767 文字（超える分は切る）。4 GB |

Excel ファイルでは、書式…で設定した列の数値の書式（小数点以下の桁数・桁区切り・パーセント・通貨）と日付の形式をセルの表示形式にするので、ブックでもグリッドと同じように数値を表示します。規則は仕様の [§8.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#82-operations) にあります。

## ファイルの行き先

### メモリーエンジン：ページの中

エンジンはファイルのバイト列を返し（`delivery: "data"`）、グリッドはそれをページの中でファイルにして保存します。エンジンを Web Worker で動かしていても、データはブラウザーの外に出ません。

### DuckDB エンジン：サーバー

エンジンは一時フォルダーにファイルを書き（`delivery: "file"`）、その名前を `target` として返します。書き出したファイルは新しいものから 16 個まで、1 時間保持します。`createHttpHandler` がそれを `GET <path>/exports/<名前>` でファイル名を付けて返し、`httpTransport` がその URL（`exportUrl`）をグリッドに渡して、ブラウザーがダウンロードします。

```ts
import http from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });
http.createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

```tsx
import { DataGrid, httpTransport } from "vastgrid";

const transport = httpTransport("/api"); // /api/exports/<名前> からダウンロード

export const Orders = () => <DataGrid transport={transport} table="orders.parquet" />;
```

ファイルを別の場所から配るときは、`httpTransport(url, { exports })` とハンドラーの `exports` オプションでダウンロードのパスを変えます。

ホストが決めた場所に書き出すには、エンジンに `resolveTarget` を渡します。書き出しの `target` を、許可したフォルダーの中のパスに変える関数です（断るときは例外を投げます。`not_allowed`）。エンジンはそこに一時的な名前で書き、書き終えてから名前を変えます。このときエンジンはファイルを保持しません。書き出しメニューは `target` を指定しないので、指定するのはコードからです（後述）。`resolveTarget` がなければ、`target` を指定した書き出しは断ります。

[アプリ](/ja/apps/overview/)の書き出しはそれぞれ異なります。コマンドラインではブラウザーがダウンロードし、VS Code では保存のダイアログで選んだ場所に書き、ノートブックのグリッドはブラウザーでバイト列を保存します。MCP App はホストにダウンロードを頼みます（64 MB まで）。

## コードから書き出す

書き出しメニューは `export` コマンドを送ります。アプリからも同じコマンドを送れます。

```ts
const store = grid.current!.store; // DataGrid のハンドル。GridProvider の中なら useGridStore()
const outcome = await store.dispatch({ command: "export", format: "csv", rows: "view", columns: "displayed" });
if (outcome.ok) {
  const { target, rows, data } = outcome.output as { target: string | null; rows: number; data?: { bytes: Uint8Array } };
  if (data) {
    // メモリーエンジン：ファイルのバイト列。名前はメニューと同じ付け方
    const file = new File([data.bytes], store.exportName("csv"));
  } else if (target !== null) {
    // DuckDB エンジン：ダウンロードできる URL。トランスポートが知らなければ null
    const url = store.exportUrl(target);
  }
}
```

| 引数 | 値 |
| --- | --- |
| `format` | `capabilities.export.formats` のどれか。それ以外は `unsupported` で失敗 |
| `rows` | `"view"`（既定）か `"table"` |
| `columns` | `"displayed"`（既定）か `"all"` |
| `target` | DuckDB エンジンが `resolveTarget` を通してファイルを書く場所 |

出力の `rows` は書いた行の数です。見出しと Excel の書式は、メニューと同じくドキュメントの列の設定から作ります。
