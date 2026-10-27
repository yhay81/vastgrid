---
title: ブラウザーで開く大きなファイル
description: CSV・TSV・JSON Lines・Excel・Parquet のファイルと HTTP 越しの Parquet を、Web Worker の中のメモリエンジンで開きます。サーバーもアップロードも要りません。
---

`vastgrid-js` のメモリエンジンは、行だけでなくファイルも読めます。エンジンは Web Worker で動かしてください。ファイルの読み込み・並べ替え・グループ化・書き出しを Worker が行う間も、ページは描画とスクロールを続けられます。ファイルはブラウザーの外へ出ません。

```bash
npm install vastgrid vastgrid-js
```

## Worker とページ

Worker の中でエンジンを作り、`serveEngine` でページに答えます。Worker では、React を含まない `vastgrid/core` から import します。

```ts
// engine-worker.ts
/// <reference lib="webworker" />
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

// The page posts the file first; the engine answers every message after it.
self.addEventListener("message", function start(event: MessageEvent<{ file: File }>) {
  self.removeEventListener("message", start);
  const { file } = event.data;
  const table = /\.(parquet|pq)$/i.test(file.name) ? { parquet: file } : { file, editable: true };
  serveEngine(memoryEngine({ tables: { [file.name]: table } }), self as unknown as WorkerLike);
});
```

ページでは、ファイルごとに Worker を起動し、`workerTransport` でやり取りします。

```tsx
import { useState } from "react";
import { DataGrid, type Transport, workerTransport } from "vastgrid";
import "vastgrid/styles.css";

interface Opened {
  name: string;
  worker: Worker;
  transport: Transport;
}

export function FileGrid() {
  const [opened, setOpened] = useState<Opened>();

  function open(file: File) {
    opened?.worker.terminate();
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ file });
    setOpened({ name: file.name, worker, transport: workerTransport(worker) });
  }

  return (
    <>
      <input type="file" onChange={(event) => event.target.files?.[0] && open(event.target.files[0])} />
      {opened && <DataGrid transport={opened.transport} table={opened.name} style={{ height: 600 }} />}
    </>
  );
}
```

- グリッドの `table` は、Worker が表に付けた名前です。ここではファイル名です。
- Worker はエフェクトではなく、イベントハンドラーで起動します。Worker を終了すると、そのファイルのメモリはすべて解放されます。別のファイルを開くときと、コンポーネントがアンマウントされるときに、古い Worker を終了してください。
- `File` を postMessage しても、ファイルは読まれません。エンジンが Worker の中で少しずつ読みます。
- 行のブロックはバイト列で返り、そのバッファーはコピーされずにページへ移されます。

## ファイル

`{ file }` には、CSV・TSV・JSON Lines・Excel のブックの `File` か `Blob` を渡します。形式はファイル名か `format` で決まります。

| 形式 | 名前 | `format` |
| --- | --- | --- |
| CSV | `.csv` | `"csv"` |
| TSV | `.tsv`、`.tab` | `"tsv"` |
| JSON Lines | `.jsonl`、`.ndjson` | `"jsonl"` |
| Excel | `.xlsx`、`.xlsm` | `"xlsx"` |

| オプション | 既定 | |
| --- | --- | --- |
| `delimiter` | `,`・タブ・`;`・`\|` のうち、1 行目を最も多くの欄に分けるもの | CSV の区切り文字（1 文字） |
| `header` | `true` | CSV・TSV の 1 行目が列名かどうか |
| `maxBytes` | 1 GiB | 表の列が使ってよいメモリの上限（後述） |
| `editable` | `false` | グリッドからセルに書き込めるようにする |

各列の型は、すべての値が収まる最初の型になります。順に `boolean`・`integer`・`bigint`・`float`・`time`・`date`・`timestamp`・`timestamptz` を試し、どれにも収まらなければ `string` です。値になりかけの文字列（`24:00:00`、` 1`、`2023-02-29`）があると、その列は文字列になり、すべての値を書かれたとおりに保ちます。空の欄は null、引用符で囲んだ空の欄（`""`）は空文字列です。JSON Lines ではキーごとに列ができます。オブジェクトやリストの列は、その JSON の文字列になり、読み取り専用です。

ファイルは UTF-8 にしてください。UTF-16 のファイル、UTF-8 でない文字列、オブジェクトでない JSON Lines の行は `load_failed` になります。圧縮したファイル（`.csv.gz`）はブラウザーでは読めません。

### Excel のシート

ブックは、最初の表示されているシートで開きます。表の情報には、ブックの `sheets` と読んだ `sheet` が入っています。別のシートはグリッドの `open` プロパティで選びます。`open` はグリッドがストアを作るときに読まれるので、`key` も一緒に渡してください。

```tsx
<DataGrid key={sheet} transport={transport} table={name} open={{ sheet }} />
```

`open` には、列名の行 `headerRow`（1 から数えます。`0` なら列名なし）と、`keepEmptyRows`・`keepEmptyColumns` も指定できます。暗号化されたブックと、古い `.xls` 形式は `load_failed` になります。

## Parquet

`{ parquet }` には、`File` か `Blob`、または HTTP の範囲リクエストに答えるサーバー上のファイルの URL を渡します。

```ts
memoryEngine({ tables: { sales: { parquet: "https://data.example.com/sales.parquet" } } });
```

| オプション | 既定 | |
| --- | --- | --- |
| `headers` | なし | URL へのすべてのリクエストに付けるヘッダー（`Authorization` など） |
| `fetch` | グローバルの `fetch` | 代わりに使う関数 |
| `maxBytes` | 1 GiB | まるごと読んだ列が使うメモリのおおよその上限 |
| `editable` | `false` | グリッドからセルに書き込めるようにする |

開くときに読むのは、ファイルのフッターだけです。画面に出る行は、その行を含む行グループを読みます。並べ替え・絞り込み・グループ化・集計は、使う列をまるごと型付き配列に読みます。列の型は DuckDB が読む型と同じで、リスト・構造体・マップは JSON の文字列（読み取り専用）になります。

別のオリジンの URL では、サーバーが CORS で許可し、`Content-Length`・`Content-Range`・`ETag` を公開する（`Access-Control-Expose-Headers`）必要があります。最初の応答でファイルの大きさと `ETag` か `Last-Modified` を受け取り、以後の応答はそれと一致しなければなりません。ファイルが変わっていれば `file_changed` になります。読んだ範囲は 32 MiB のキャッシュに残ります。`Range` を無視するサーバーはファイル全体を送ってきますが、16 MiB までなら保持し、それより大きいと `load_failed` になります。

## メモリと `maxBytes`

`maxBytes`（既定は 1 GiB）は、エンジンがまるごと保持する列の上限です。列がこれを超えるテキストファイルは保持されません。エンジンは 1,024 行ごとの開始位置を記録し、そのブロック単位で行を読みます。並べ替え・絞り込み・グループ化・集計・検索・書き出しは、必要な列が上限に収まる間はまるごと読み、場所が足りなくなると、最も長く使われていない列から手放します。一度に上限を超える要求は `/maxBytes` を指す `load_failed` になりますが、表は開いたままです。

要求は `maxBytes` とは別にもメモリを使います。並べ替えた列とビューごとに 1 行あたり約 4 バイト、グループ化のグループ、それに 32 MiB のブロックのキャッシュです。表が収まらないときは、`maxBytes` を大きくするか、ファイルをサーバーで開いてください（[サーバーのファイル](/ja/guides/server/)）。サーバーの DuckDB はディスクに書き出しながら処理します。

## 書き出しと編集

メモリエンジンは CSV・TSV・JSON・xlsx をデータとして書き出します。ファイルをメモリ上で作ってそのバイト列を返し、グリッドがダウンロードとして保存させます（[書き出し](/ja/guides/export/)）。エンジンがファイルを書くことはなく、表を読んだ元の `File` も変わりません。`editable: true` ならグリッドからセルに書き込めます。書き込んだセルは Worker がある間だけ残るので、残したいときは書き出してください。

## 速さ

2026-10-27 に Apple M2 Pro と Node.js 24 で、Worker やページを通さずエンジンのメッセージで計測しました（[計測の記録](https://github.com/yhay81/vastgrid/blob/main/docs/memory-engine-benchmark.md)）。ファイルは 8 列で、時間は 1 回の計測です。

| | 100 万行の CSV（69 MB） | 100 万行の Parquet（13 MB） | 1,000 万行の CSV（701 MB） | 1,000 万行の Parquet（132 MB） |
| --- | ---: | ---: | ---: | ---: |
| 開く | 1.06 秒 | 26 ms | 10.5 秒 | 38 ms |
| 最初の 256 行 | 9 ms | 201 ms | 7 ms | 206 ms |
| 浮動小数点数で並べ替え | 91 ms | 1.08 秒 | 0.88 秒 | 8.7 秒 |
| 文字列で並べ替え | 0.48 秒 | 0.25 秒 | 5.0 秒 | 2.9 秒 |
| 絞り込んでタイムスタンプで並べ替え | 0.19 秒 | 0.10 秒 | 2.5 秒 | 1.8 秒 |
| 合計・平均・件数でグループ化 | 0.41 秒 | 0.32 秒 | 5.0 秒 | 3.5 秒 |
| 全行を CSV に書き出し | 1.45 秒 | 1.32 秒 | 14.8 秒 | 13.7 秒 |
| 開いた後のメモリ | 58 MB | 1 MB | 590 MB | 2 MB |
| 上記をすべて行った後のメモリ | 107 MB | 129 MB | 1,020 MB | 1,264 MB |

Parquet はすぐに開き、要求が初めて列をまるごと読むときに時間がかかります。テキストファイルは開くときに時間がかかります。`maxBytes` を 256 MiB にすると、1,000 万行の CSV は 4.7 秒で開き、メモリはほとんど使いませんが、全列の集計や書き出しは `load_failed` になります。Chromium でエンジンを Worker に置くと、100 万行の並べ替え中もページに長いタスクは生じず、ページのヒープには表がまったく載りません（10 MB）。

## /open/ のページ

[ファイルを開く](/ja/open/)は、このガイドの内容を動かしているページです。ドロップまたは選んだファイルごとに Worker でメモリエンジンを起動し、表を編集できるようにし、`.txt` のファイルは CSV として読み、ブックにはシートの選択を付けています。Worker のコードは [site/src/components/open/engine-worker.ts](https://github.com/yhay81/vastgrid/blob/main/site/src/components/open/engine-worker.ts) です。

## 制限

- 最初の行が出るのは、ファイル全体を読んだ後です。上の 1,000 万行の CSV では 10 秒かかります。読み込み中に行を見せるのは、今後の課題です。
- 取り消しは 40 ms ごとくらいに確認されます。ビューの一部の処理（数値の順位付けや、順位での並べ替え）は、終わるまで止まりません。
- エンジンはファイルに保存しません。編集を残すには書き出してください。
- タブのメモリが上限です。それを超えるなら、サーバーで DuckDB エンジンを使ってください。

## バンドラー

`new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" })` は、Vite や webpack 5 が見つけてバンドルする書き方です。Vite ではプラグインも設定も要りません。特別なヘッダーも不要です。エンジンは `SharedArrayBuffer` を使わないので、ページをクロスオリジン分離（COOP/COEP）にする必要はありません。モジュール Worker には、Chrome と Edge 80、Firefox 114、Safari 15 以降が必要です。
