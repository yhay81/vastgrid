---
title: エンジン
description: vastgrid-js のメモリエンジンと vastgrid-duckdb の DuckDB エンジン、それぞれのオプションとできること。
---

エンジンは表を開き、グリッドのメッセージ（[仕様の §8](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#8-messages)）に答えます。プランのビューを作り、行のブロックを読み、セルを書き込み、ファイルを書き出します。グリッドはトランスポート（[`vastgrid/core`](/ja/reference/core/#トランスポート)）を通してエンジンに届きます。vastgrid には二つのエンジンがあります。

| | `vastgrid-js` | `vastgrid-duckdb` |
| --- | --- | --- |
| 動く場所 | ページ、Web Worker、Node.js | Node.js |
| 表 | 型付き JSON の行、Arrow、CSV、TSV、JSON Lines、Excel、Parquet のファイル | CSV、TSV、JSON、JSON Lines、Parquet のファイル（圧縮も）と Excel ブック |
| 大きさ | ページのメモリに収まる範囲（`maxBytes`）。Parquet は行グループごとに読む | 制限なし。DuckDB がディスクに退避し、Parquet はその場で読む |
| セルの書き込み | `editable: true` を付けた表 | どのファイルも。書き込んだ値はファイルとは別に持つ |
| ファイルへの保存 | なし | CSV と TSV（`saveFiles: true` のとき） |
| 書き出し | CSV、TSV、JSON、Excel をファイルのバイト列で返す | CSV、TSV、Parquet、JSON、Excel をサーバーに書く |

`handle`（イベントを送るなら `subscribe` も）を持つオブジェクトはどれもエンジンです。[独自のエンジン](/ja/guides/custom-engine/)を見てください。

```ts
interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}
```

## ケーパビリティ

`open` は表の `capabilities` を含む `TableInfo` を返します（[§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#410-capabilities)）。グリッドはそこにあるものだけを出します。`save` がなければ保存ボタンはなく、`plan.aggregate` がなければグループのメニューはなく、書き出しの形式は `export.formats` のものだけです。

| メンバー | 値 | 意味 |
| --- | --- | --- |
| `plan` | `{ derive, where, aggregate, pivot, having, sort, search }` の真偽値 | エンジンが評価するプランのメンバー。ないものは true |
| `functions`、`measures` | 名前 | 評価する関数（§4.4）と集計（§4.5）。ないときはすべて |
| `summarize`、`find`、`locate` | 真偽値 | 選択範囲の合計、検索バー、ビューが変わったときのアクティブ行の維持 |
| `write` | 真偽値 | セルを書き込める（§7.2） |
| `save` | 真偽値 | 書き込んだセルを表のファイルに保存できる（§7.5） |
| `export` | `{ formats, delivery }` | `export` の形式と、ファイルをサーバーに書く（`file`）かバイト列で返す（`data`）か |
| `preview` | 真偽値 | 大きな並べ替えが終わる前に先頭の行を見せられる（§9） |
| `partialViews` | 真偽値 | 表の読み込み中に `{}` 以外のプランを読める |
| `changes` | `"push"` または `"poll"` | エンジンがイベントを送る（§8.5）か、クライアントが `changes` で尋ねるか |

| ケーパビリティ | メモリエンジン | DuckDB エンジン |
| --- | --- | --- |
| `plan` | すべてのメンバー | すべてのメンバー |
| `functions`、`measures` | §4.4 と §4.5 のすべて | §4.4 と §4.5 のすべて |
| `summarize`、`find`、`locate` | あり | あり |
| `write` | `editable: true` の表 | あり |
| `save` | なし | `saveFiles` のとき、圧縮していない CSV と TSV |
| `export` | `csv`、`tsv`、`json`、`xlsx`。`data` | `csv`、`tsv`、`parquet`、`json`、`xlsx`。`file` |
| `preview` | なし | 1,000,000 行以上の並べ替え |
| `partialViews` | なし | なし |
| `changes` | `poll`（書き込みの後に `changed` も送る） | `push` |

## メモリエンジン：`vastgrid-js`

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({
  tables: {
    people: {
      columns: [
        { name: "name", type: "string" },
        { name: "born", type: "integer" },
      ],
      rows: [
        ["Ada Lovelace", 1815],
        ["Grace Hopper", 1906],
      ],
      editable: true,
    },
    sales: { parquet: "https://example.com/sales.parquet" },
  },
});
```

`memoryEngine(options)` は `MemoryEngine` を返します。`handle(message)` はリクエストにレスポンスかエラーで答え、例外は投げません（`cancel` には答えません）。`subscribe(listener)` でイベントを受け取れます。ブロックは構造化エンコーディング（`{ bytes }`）で、`localTransport` と `workerTransport` はそのまま運びます。

| オプション | 型 | 説明 |
| --- | --- | --- |
| `tables` | `Record<string, table>` | `open` が開く表を、表を指す `ref` ごとに。それぞれ下のどれかの種類です。 |

### 行：`MemoryTable`

| メンバー | 型 | 説明 |
| --- | --- | --- |
| `columns` | `Column[]` | `{ name, type }` と型ごとのメンバー（[§2.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#21-logical-types)）。`decimal` の `precision` と `scale`、`float` の `bits`、`timestamp` の `unit`。任意で `sourceType` と `readOnly`。 |
| `rows` | `JsonValue[][]` | 行 ID の順に一行ずつ、型付き JSON の値の配列（[§2.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json)）。decimal は桁を含む文字列（`"12.50"`）、2^53 を超える bigint は文字列、日付は `"2024-01-31"`、タイムスタンプは `"2024-01-31 12:00:00"`。 |
| `editable` | `boolean` | `write` で表のセルを書き込めます。書き込んだ値は `rows` とは別に持ちます。 |

行はコピーせずそのまま使うので、後から変えてはいけません。形は表を初めて開くときに、値は読むときに確かめます。§2 に従わない表には、問題の場所の JSON Pointer を付けた `load_failed` を返します。

### Apache Arrow：`ArrowTable`

| メンバー | 型 | 説明 |
| --- | --- | --- |
| `arrow` | `Uint8Array` | Arrow IPC のストリームかファイルのバイト列。レコードバッチはいくつでも。 |
| `editable` | `boolean` | 行と同じです。 |

列は Arrow の型に対応する論理型になり、Arrow が持つ形のまま保持されます。数値・日付・時刻は型付き配列で、それ以外は求められたときにバッファから読みます。リスト、構造体など論理型のない型は `/arrow` の `load_failed` になります。

### テキストファイルとブック：`FileTable`

| メンバー | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `file` | `TextFile`（`Blob` か `File`） | （必須） | ファイル。全体をコピーせず、切り出して読みます。 |
| `format` | `"csv" \| "tsv" \| "jsonl" \| "xlsx"` | 名前から | `.csv`、`.tsv` か `.tab`、`.jsonl` か `.ndjson`、`.xlsx` か `.xlsm`。 |
| `delimiter` | `string` | `,`、タブ、`;`、`\|` のうち一行目を最も多く分けるもの | CSV ファイルの区切り文字（一文字）。 |
| `header` | `boolean` | `true` | CSV・TSV ファイルの一行目が列名かどうか。 |
| `maxBytes` | `number` | 1 GiB | 表の列が使ってよいメモリの上限。これより大きなファイルは保持せず、行は 1,024 行のブロックで、列はリクエストが必要とするときにこの範囲で丸ごと読みます。 |
| `editable` | `boolean` | `false` | 行と同じです。 |

ファイルは初めて開くときに型付きの列へ読み込みます。各列は `boolean`、`integer`、`bigint`、`float`、`time`、`date`、`timestamp`、`timestamptz` のうち、すべての値が収まる最初の型になり、どれにも収まらなければ `string` になります。ブックのシートは `open` の `read`（`sheet`、`headerRow`、`keepEmptyRows`、`keepEmptyColumns`）で選び、`TableInfo` の `sheets` に一覧が入ります。列の型は DuckDB エンジンと同じです。UTF-8 でないテキスト、UTF-16 のファイル、暗号化されたブックと `.xls` は `load_failed` になります。

### Parquet ファイル

| メンバー | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `parquet` | `TextFile \| string` | （必須） | `Blob` か `File`、または HTTP の Range リクエストに答えるサーバー上のファイルの URL。 |
| `headers` | `Record<string, string>` | | URL へのすべてのリクエストに付けるヘッダー（`Authorization` など）。 |
| `fetch` | `(url, init) => Promise<response>` | グローバルの `fetch` | `fetch` と同じように取得する関数。 |
| `maxBytes` | `number` | 1 GiB | 丸ごと読んだ列が使ってよいメモリのおおよその上限。 |
| `editable` | `boolean` | `false` | 行と同じです。 |

開くときに読むのはフッターだけです。行はそれを含む行グループごとに読み、並べ替え・フィルター・グループ・集計は名指しした列を丸ごと読みます。列の型は DuckDB が読む型と同じで、DuckDB での型名が `sourceType` に入ります。リスト・構造体・マップは JSON テキストの文字列として読み取り専用になります。別オリジンのサーバーは CORS で `Content-Length`、`Content-Range`、`ETag` を公開する必要があり、`ETag` か `Last-Modified` が変わったファイルは `file_changed` になります。[ブラウザーで大きなファイル](/ja/guides/browser/)も見てください。

### エクスポートする名前

`vastgrid-js` は `memoryEngine`、`MEMORY_CAPABILITIES` と、型 `MemoryEngine`、`MemoryEngineOptions`、`MemoryTable`、`ArrowTable`、`FileTable`、`TextFile`、`TextFormat` をエクスポートします。

- `save` は `save_unsupported` で失敗します。このエンジンはファイルを書かず、表の元になった `File` もそのままです。
- `export` はファイルのバイト列を返し（`delivery` が `data`）、`target` は受け取りません。グリッドがダウンロードします。Parquet の書き出しは `/format` の `invalid_request` になります。
- 多くの行を通るリクエストは 40 ms ほどごとに他のメッセージを受け付けるので、`cancel` で `cancelled` として止められます。

## DuckDB エンジン：`vastgrid-duckdb`

```ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });

createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

Node.js 20 以降と、DuckDB（`@duckdb/node-api`）のバイナリがあるプラットフォームが必要です。Linux（x64・arm64、glibc・musl）、macOS（x64・arm64）、Windows（x64・arm64）です。[サーバー上のファイル](/ja/guides/server/)も見てください。

### `DuckDBEngine.create(options)`

エンジンの Promise を返します。

| オプション | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `allowedDirectories` | `string[]` | （必須） | 開いてよいファイルのフォルダー。DuckDB は実際の場所がこれ以外のファイルを読まず、動いている間は変えられません。 |
| `tempDirectory` | `string` | （必須） | エンジンのデータベース、メモリから退避したデータ、変換したファイルを置く場所。専用のフォルダーを作り、`dispose` で消します。これを呼ばずに終わったプロセスのフォルダーは次の起動で消します。 |
| `resolve` | `(ref) => string \| Promise<string>` | パス。相対パスは最初の許可フォルダーの中 | `open` の `ref` が指すファイル。投げると拒否します（`not_allowed`）。 |
| `resolveTarget` | `(target) => string \| Promise<string>` | | `export` の `target` が指すファイル。許可フォルダーの中で、表が読むファイル以外。ないときは書き出しに target を付けず、エンジンが保持します（`exportFile`）。 |
| `saveFiles` | `boolean` | `false` | `save` で書き込んだセルを元の CSV・TSV ファイルに保存できるようにします。編集したフィールドを含まないバイトはそのまま残します。オフならエンジンはファイルを一切変えません。 |
| `watchFiles` | `boolean` | `true` | 開いている表のファイルを監視します。ディスク上で変わったファイルは読み直し、書き込んだセルがある表では `fileChanged` で知らせます。 |
| `memoryLimit` | `string` | システムのメモリの 5 分の 1（1〜4 GB） | DuckDB のメモリ上限（`"4GB"` など）。 |
| `maxTempDirectorySize` | `string` | `"8GB"` | DuckDB の退避ファイルの上限（データベースと変換したファイルは含みません）。 |
| `threads` | `number` | CPU の数から 1 を引いた数 | DuckDB のスレッド数。 |
| `maxTables` | `number` | `4` | どのハンドルも使わなくなった後、開き直すために読み込んだまま残す表の数。 |
| `previewRows` | `number` | `1000` | 区切りテキストや JSON のファイルを読み込み中に読める行数。 |
| `textLimit` | `number` | `2000` | `textLimit` を指定しない `rows` が返す文字列の最大の長さ。 |
| `maxViews` | `number` | `8` | エンジンごとに残すビューの数。ビューを読んでいるリクエストは終わるまでそれを残します。 |
| `materializeRows` | `number` | `20000000` | これを超える入力行のビューは、並べ替えたコピーではなく順序どおりの行 ID だけを持ちます。 |
| `viewPreviewMinRows` | `number` | `1000000` | 並べ替えが終わる前に先頭の行を返す入力行数の下限。 |
| `viewPreviewRows` | `number` | `1000` | そのプレビューの行数。 |
| `log` | `(message, error?) => void` | | どのリクエストにもよらない問題を受け取ります（ログ用）。 |

### メソッド

| メソッド | 説明 |
| --- | --- |
| `handle(message, { signal }?)` | リクエスト（§8.1）にレスポンスかエラーレスポンスで答えます。`cancel` には何も返しません。不正なメッセージでも例外は投げません。`signal` は `cancel` と同じようにリクエストを取り消します。ブロックは構造化エンコーディングです。 |
| `subscribe(listener)` | エンジンの表のイベント（§8.5）、`changed`、`progress`、`view` を受け取ります。止める関数を返します。 |
| `exportFile(name)` | target なしの書き出しのファイルを、その応答の名前で返します。`{ path, fileName, mediaType, size }`（`KeptExport`）か、消えた後は null。最大 16 個を 1 時間保持します。 |
| `whenLoaded(id)` | ハンドル（`TableInfo` の `table`）の表が読み込み終わるか、失敗するまで待ちます。 |
| `dispose()` | すべての表とデータベースを閉じ、エンジンのファイルを消します。 |

同じプロセスでは、`vastgrid/core` の `localTransport(engine)` がグリッドのメッセージを運びます。

### `createHttpHandler(engine, options?)`

Node.js の `http` リクエストのハンドラー `(request, response, next?)` を返します。Connect や Express のミドルウェアとしても使えます。ほかのパスへのリクエストは `next` に渡し、`next` がなければ 404 を返します。

| オプション | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `path` | `string` | `"/"` | リクエストを POST するパス。 |
| `events` | `string` | `path` + `events` | Server-Sent Events のパス。 |
| `exports` | `string` | `path` + `exports/` | target なしの書き出しをダウンロードするパスの接頭辞。 |
| `maxBody` | `number` | 64 MiB | リクエスト本文の上限。超えると 413。 |
| `keepAlive` | `number` | 15,000 | イベントのストリームを保つコメントを送る間隔（ミリ秒）。 |

| ルート | 応答 |
| --- | --- |
| `POST <path>` | 本文の JSON リクエストへのレスポンス。JSON で返し、`rows` と `export` でリクエストが `application/vnd.vastgrid.v2+arrow` を受け付けるときはブロックを添付した JSON（§8.8）で返します。エラーは [§8.7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#87-errors) の HTTP ステータスを付けた JSON、`cancel` は 204 です。クライアントが去るとリクエストを取り消します。 |
| `GET <events>` | エンジンのイベントを Server-Sent Events で。 |
| `GET <exports><name>` | 書き出したファイルを、表にちなんだ名前のダウンロードで返します。なければ 404。 |

グリッド側は `httpTransport("/api", { events: "/api/events" })` です。

### 形式

| 形式 | ファイル | 読み方 |
| --- | --- | --- |
| CSV | `.csv`、`.csv.gz`、`.csv.zst` | DuckDB に読み込みます。残りを読み込む間も先頭の行はすぐ読めます |
| TSV | `.tsv`、`.tab`、`.tsv.gz`、`.tsv.zst` | CSV と同じ |
| JSON Lines | `.jsonl`、`.ndjson`、`.jsonl.gz`、`.ndjson.gz` | DuckDB に読み込みます |
| JSON | `.json`、`.json.gz` | DuckDB に読み込みます |
| Parquet | `.parquet`、`.pq` | その場で、行番号で読みます |
| Excel | `.xlsx`、`.xlsm` | シートを DuckDB に読み込みます。`open` の `read` で `sheet`、`headerRow`、`keepEmptyRows`、`keepEmptyColumns` を選びます |

テキストのエンコーディング（UTF-16、Shift_JIS、EUC-JP など）は判定して変換し、途中で型が変わるファイルはより広い型に切り替えます。書き出しは CSV、TSV、Parquet、JSON、Excel です。Excel の書き出しは最大 1,048,575 行、16,384 列です（`export_too_large`）。

### そのほかのエクスポート

| 名前 | 説明 |
| --- | --- |
| `CAPABILITIES` | エンジンのケーパビリティ。`save` は `saveFiles` で保存できるファイルのときだけ true。 |
| `findTableFiles(folders, limit)` | フォルダーの中の表のファイルをフルパスで返します。2 階層まで、隠しファイルと隠しフォルダーを除き、最大 `limit` 個。 |
| `tableFormatOf(file)` | 名前から決まるファイルの形式（`TableFormat`：`csv`、`tsv`、`parquet`、`json`、`ndjson`、`xlsx`）か null。 |
| `fileRevision(file)` | ファイルのリビジョン。大きさ、更新時刻、先頭 64 KiB のハッシュ。 |
| `EXPORT_MEDIA_TYPES` | 書き出しの形式（`ExportFormat`）ごとのメディアタイプ。 |
| `EngineError` | 失敗したリクエストのエラー。`code`（§8.7）を持ちます。 |
| `readExpression`、`readValue`、`sourceExpression`、`tableColumn` | エンジンが DuckDB の列を論理型として読む方法。DuckDB を自分で読むホスト向け。 |

型 `DuckDBEngineOptions`、`HttpHandlerOptions`、`KeptExport`、`ReadOptions`、`SheetInfo` もエクスポートしています。

### 上限と後片付け

| 上限 | 既定値 | 制限するもの |
| --- | ---: | --- |
| `maxViews` | 8 | 残すビュー。ビューを読んでいるリクエストは終わるまでそれを残します。 |
| `materializeRows` | 20,000,000 | これを超える入力行のビューは行 ID だけを持ちます。 |
| `memoryLimit` | 1〜4 GB | DuckDB のバッファのメモリ。 |
| `maxTempDirectorySize` | 8 GB | DuckDB の退避ファイル。データベースと変換したファイルは含みません。 |

ビューは一度に一つずつ作ります。取り消しや作成の失敗は、そこで作った表を消します。エンジンを閉じるとセッションのフォルダーを丸ごと消し、次の起動では異常終了したプロセスが残したフォルダーを消します。これらの上限はセッションのフォルダーの容量制限ではありません。それが必要なホストは、容量制限のあるファイルシステムを `tempDirectory` に用意してください。

## コードとしての仕様

- **`vastgrid-spec`** は型、プランとメッセージの検査（`checkPlan`、`checkRequest`、`checkResponse`、`checkEvent`）、コマンド（`applyCommand`）、数式（`compileFormula`、`formulaText`）、`migrateGridState`、ブロックのエンコーディング（`encodeBlock`、`decodeBlock`、`toStructuredEncoding`、`toTextEncoding`、`frameAttached`、`readAttached`）、JSON スキーマ（`vastgrid-spec/schema/*.schema.json`）、すべてのエンジンが通す適合性コーパス（`vastgrid-spec/conformance`）を持ちます。
- **`vastgrid-sql`** はプランを、値をすべてパラメーターにした DuckDB の SQL にコンパイルします（`compileView`、`rowsQuery`、`countQuery`、`pivotQuery`）。仕様の意味を SQL で表したもので、DuckDB エンジンはこれの上に作られています。

[独自のエンジン](/ja/guides/custom-engine/)で、メッセージへの答え方とコーパスの走らせ方を説明しています。
