---
title: vastgrid-duckdb
description: vastgrid-duckdb の TableEngine、要求の受け口、補助の関数。
---

```ts
import { createTableHandler, TableEngine } from "vastgrid-duckdb";
```

これらの組み合わせ方は[サーバーのファイル](/ja/guides/server/)にあります。

## `TableEngine`

```ts
const engine = await TableEngine.create(options: TableEngineOptions);
```

表のファイルを DuckDB で開き、それについてのプロトコルの要求に答えます。1 つのエンジンで、いくつのクライアントとファイルでも扱えます。エンジンはプロセスごとに 1 つ作ってください。

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `allowedDirectories` | （必須） | DuckDB が読み込みと書き出しをしてよいフォルダー。ほかのファイルへのアクセスはすべて無効にし、あとから有効にはできません。 |
| `tempDirectory` | （必須） | エンジンがデータベースのファイル、メモリからあふれたデータ、変換したファイルを置く場所。その中に専用のフォルダーを作り、`dispose()` で削除します。 |
| `memoryLimit` | メモリの 5 分の 1（1〜4 GB） | DuckDB のメモリの上限。たとえば `"4GB"`。 |
| `threads` | CPU の数 − 1 | DuckDB の作業スレッドの数。 |
| `maxTables` | `4` | 開いたままにする表の数。これを超えると、最も長く使っていない表から閉じます。 |
| `maxViews` | `2` | 表ごとに残す、並べ替え・絞り込みしたビューの数。 |
| `materializeRows` | `20000000` | これより行が多い表では、ビューは並べ替えた複製ではなく、行の順番を持ちます。 |
| `viewPreviewMinRows` | `1000000` | この行数以上の表の並べ替えでは、ビュー全体を作り終える前に先頭の行を表示します（後述）。 |
| `viewPreviewRows` | `1000` | そうした並べ替えで、ビューの完成前に読める行の数。 |
| `abandonedViewTimeout` | `3000` | 表のほかのビューが順番を待っていて、このビューがこのミリ秒数のあいだ求められなかったとき、背景での作成をやめます。 |
| `previewRows` | `1000` | 区切りのテキストや JSON のファイルの読み込み中に読める行の数。 |
| `textLimit` | `2000` | 既定でセルごとに送る文字列の最大の長さ。 |
| `log` | | `(message, error?) => void`。要求が原因ではない問題を受け取ります。 |

| メソッド | 説明 |
| --- | --- |
| `open(path, format?, read?)` | ファイルを開くか、そのファイルをすでに開いている表を返し、読み込みを始めます。`OpenTable` を返します。パスは、リンクをたどった先が許可したフォルダーの中になければなりません。`read` はブックのシートと読み方を選びます（[Excel のブック](/ja/guides/server/#excel-のブック)）。選び方ごとに別の表になります。 |
| `get(id)` | このハンドルで開いている表。なければ `table_not_found` のエラー。 |
| `close(id)` | 表とそのビューを閉じます。 |
| `allows(path)` | 書かれたままの絶対パスが、許可したフォルダーの中にあるかどうか。`open` では実際の場所も確かめます。 |
| `dispose()` | すべての表とデータベースを閉じ、エンジンの一時ファイルを削除します。 |

`OpenTable` には、`TableSource` のメソッド（`info`、`createView`、`readRows`、`columnStats`、`distinctValues`、`aggregate`、`find`、`exportView(request, target)`）と、`id`、読み込みの終わりを待つ Promise を返す `whenReady()` があります。`currentRevision()` はファイルの今の revision（ファイルがなければ null）を返します。ファイルが変わると `info().revision` と違う値になるので、ポーリング以外の方法でクライアントに変更を伝えるときは両者を比べてください。下の受け口はこれらを呼びます。サーバーで表を扱うときは、直接使うこともできます。

## `createTableHandler(options)`

プロトコルの Fetch API の受け口 `(request: Request) => Promise<Response>` を返します。JSON の本文を持つ `POST` の要求を受け、`{ result }` か `{ error: { code, message } }` を、それに合うステータスで返します。

| オプション | 説明 |
| --- | --- |
| `engine` | `TableEngine \| (() => TableEngine \| Promise<TableEngine>)`。 |
| `resolve(ref)` | 要求が指すファイルの絶対パスか、その Promise を返します。拒否するには例外を投げます。 |
| `resolveTarget(target)` | 書き出し用の新しいファイルの絶対パスを返します。これがないと、書き出しは拒否されます。 |
| `onError(error)` | 要求が原因ではないエラーを受け取ります。ログに使います。 |

## `handleTableRequest(body, options, signal?)`

JSON の本文を解析済みの要求 1 つに、同じオプションで答えます。`result` を返すか、例外を投げます。`errorBody(error, onError?)` は、投げられたものを送るための `{ status, body }` に変えるので、Fetch API の要求を使わないフレームワークでも、`createTableHandler` とまったく同じように答えられます。

## 補助の関数

| エクスポート | 説明 |
| --- | --- |
| `tableFormatOf(path)` | 拡張子から判断したファイルの形式（`csv`、`tsv`、`parquet`、`ndjson`、`json`、`xlsx`）か `null`。ユーザーが開けるファイルの一覧を作るときに使います。 |
| `detectEncoding(path)` | 区切りのテキストのファイルの文字コードを、最初の数 MB から判定します。`utf-8`、`utf-16`、`shift_jis`、`euc-jp`、`latin-1` のどれかです。 |
| `convertToUtf8(source, target, encoding, signal?)` | ファイルを UTF-8 に変換します。正しくないバイトは置き換えます。 |
| `columnTypeOf(sqlType)` | DuckDB の型名に当たる `ColumnType`。 |
| `quoteIdentifier(name)` | DuckDB の SQL で使えるように、名前を引用符で囲みます。 |
| `fileRevision(path)` | エンジンが使うファイルの revision。大きさ・更新日時・先頭 64 KiB のハッシュから作ります。 |
