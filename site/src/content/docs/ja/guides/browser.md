---
title: ブラウザーで開くファイル
description: ローカルの Parquet・CSV・TSV・JSON Lines と URL の Parquet を、vastgrid-browser で Web Worker から読みます。サーバーは要りません。
---

`vastgrid-browser` は表のファイルを Web Worker で読みます。サーバーもアップロードも要りません。利用者が選んだファイル
（`File` や `Blob`）と、URL の Parquet を HTTP の `Range` で部分的に読みます。画面のスレッドは、グリッドの要求を送って
描く行を受け取るだけです。

```bash
npm install vastgrid vastgrid-browser
```

```tsx
import { DataGrid } from "vastgrid";
import { BrowserSource } from "vastgrid-browser";
import { useEffect, useState } from "react";

export function Table({ file }: { file: File }) {
  const [source, setSource] = useState<BrowserSource | null>(null);
  useEffect(() => {
    const next = new BrowserSource({ file });
    setSource(next);
    return () => next.close();
  }, [file]);
  return <div style={{ height: 600 }}>{source && <DataGrid source={source} locale="ja" />}</div>;
}
```

Web サーバー上の Parquet は、`file` の代わりに `url` を渡します。

```ts
const source = new BrowserSource({ url: "https://data.example.com/sales.parquet" });
```

`BrowserSource` は 1 つずつ Worker を持ちます。`close()` で Worker を終え、メモリーを解放します。上のように effect の中で
作ると、ファイルが変わったときやグリッドを外したときに閉じられます。

## できること

| | ローカルのファイル | URL の Parquet |
| --- | --- | --- |
| 形式 | Parquet・CSV・TSV・JSON Lines | Parquet |
| 開くとき | Parquet はフッターを読む。テキストは 4 MiB ずつ 1 回読んで行を数え、数えている間も最初の行を表示する | `HEAD` で大きさを調べ、フッターを読む |
| 行 | グリッドが表示する行グループか、1,024 行ずつのまとまり | グリッドが表示する行グループと列のバイト範囲 |
| 並べ替え・絞り込み・全列検索・統計・値の一覧・検索 | 使える（Worker で計算） | 使えない（ファイル全体を取得することになるため）。`fullScan: true` で使える |
| 選択範囲の集計 | 使える | 使える（選んだ行だけを読む） |
| 書き出し | 使えない | 使えない |

グリッドは `info().capabilities` の示す操作だけを有効にするので、URL では並べ替えと絞り込みのメニューが使えない状態に
なります。テキストのファイルの行を数えている間は、DuckDB のエンジンと同じく、どの操作も無効です。

並べ替えと絞り込みは `ArraySource` と同じ比較で、DuckDB のエンジンと同じ結果になります。数値は値で比べ（2^53 を超える整数や、
文字列で届く小数も正確に）、空白は昇順でも降順でも最後、日付と時刻は ISO の文字列で比べます。値は DuckDB と同じ形で届きます。
`DECIMAL` は正確な文字列（`"2.50"`）、`TIMESTAMP` は `2024-01-03 10:00:00.5`、`TIMESTAMP WITH TIME ZONE` はブラウザーの
時間帯（`2024-01-01 09:00:00+09`）、リストと構造体は `[1, 2]` と `{'a': 1}` です。

## オプション

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `file` / `url` | | 開くもの。`File` か `Blob`、または Parquet の URL。 |
| `name` | `file.name` | ファイル名。`Blob` の形式を判断するのに使います。 |
| `format` | 名前か中身から判断 | `"parquet"`・`"csv"`・`"tsv"`・`"json"`（JSON Lines）。 |
| `delimiter` | 自動 | CSV の区切り文字（`,`・`;`・`\|`・タブ）。 |
| `header` | `true` | CSV・TSV の 1 行目が列名かどうか。 |
| `fullScan` | ファイルは `true`、URL は `false` | 表全体を読む操作を使えるようにします。 |
| `headers` | | HTTP の要求すべてに付けるヘッダー。`Authorization` など。 |
| `credentials` | | `fetch` の credentials。別のオリジンに Cookie を送るときに。 |
| `maxDownloadBytes` | 16 MiB | `Range` に答えないサーバーから、この大きさまではファイル全体を取得します。大きければエラーです。 |
| `cacheBytes` | 32 MiB | 読み直しのために残す HTTP の範囲のバイト数。 |
| `textLimit` | 2000 | グリッドが求めない限り、1 つのセルで送る文字数の上限。 |
| `worker` | 同梱の Worker | Worker を作る関数（次の節）。 |

`transfer()` は、それまでに読んだバイト数と読み込みの回数（HTTP の要求の数）を返します。どれだけ少なく読んだかの表示や確認に使えます。

## Worker とバンドラー

既定では `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` で Worker を作ります。Vite・webpack 5・
Rollup・esbuild を使うツールが、この形を理解します。ほかの形が要るときは `worker` を渡します。Vite なら次のとおりです。

```ts
import BrowserWorker from "vastgrid-browser/worker?worker";

const source = new BrowserSource({ file, worker: () => new BrowserWorker() });
```

Vite は依存パッケージを事前にバンドルします。開発中に既定の Worker の URL が見つからないときは、
`optimizeDeps: { exclude: ["vastgrid-browser"] }` を設定するか、上の `?worker` の import を使ってください。自分の Worker で
表を動かすには、その中で `vastgrid-browser` の `serveTable(self)` を呼びます。`BrowserTable` は Worker を使わない同じエンジン
です（テストや Node.js 向け）。

特別なヘッダーは要りません。エンジンは普通の JavaScript なので、`SharedArrayBuffer` もクロスオリジン分離（COOP/COEP）も
不要です。モジュールの Worker には Chrome・Edge 80、Firefox 114、Safari 15 以降が必要です。

## URL で読む Parquet の配信

サーバーは `Range: bytes=start-end` に `206 Partial Content` で答える必要があります。静的ファイルのサーバー、オブジェクト
ストレージ（S3・R2・GCS）、CDN は答えます。別のオリジンのファイルは CORS で許可します。

```http
Access-Control-Allow-Origin: https://your-app.example
Access-Control-Expose-Headers: Content-Length, Content-Range, ETag
```

1 つのバイト範囲の `Range` は CORS で安全とされるヘッダーなので、普通の読み込みでは事前の要求（preflight）は起きません。
`Authorization` などのヘッダーは起きるので、`Access-Control-Allow-Headers: Authorization, Range` で許可してください。`HEAD` の
応答は圧縮（`Content-Encoding`）しないでください。圧縮すると `Content-Length` がファイルの大きさになりません。

| 状況 | 動作 |
| --- | --- |
| サーバーが `Range` を無視してファイル全体を送る | `maxDownloadBytes` までのファイルは 1 回だけ取得してメモリーから読む。大きければ `range_not_supported` |
| `HEAD` を拒否する | 1 バイトの範囲の `Content-Range` から大きさを知る |
| 大きさが分からない（`Content-Length` がない、`Content-Range` が公開されていない） | `size_unknown` |
| 開いている間にファイルが変わる（`ETag` や `Last-Modified` が変わる、ファイルが短くなる） | 読み込みが `file_changed` で失敗し、次の `info()` で開き直して新しい `revision` を返す。グリッドの再読み込みがこれを行う |
| 401・403・404 | `http_error`（メッセージに状態コード） |
| 要求が失敗する、CORS で応答を読めない | `network_error` |

すべての応答を最初の `ETag`（なければ `Last-Modified`）と照らし合わせるので、開いている間に置き換わったファイルを新旧混ぜて
読むことはありません。別のオリジンのサーバーは、この確認のために `ETag` を公開してください。

## 計測

playground のサンプルファイルを Apple M2 Pro で、`npm run bench -w vastgrid-browser`（Node.js 24。Worker のコードを
Worker なしで実行）と、playground の Chrome（Engine: Browser worker）で計りました。Parquet は 122,880 行の行グループが 82 個、
zstd 圧縮で、ページの索引はありません。

| | 時間 | 読んだ量 |
| --- | ---: | ---: |
| Parquet 132 MB・1,000 万行を HTTP Range で：開く | 40 ms（Chrome 41 ms） | 2 回で 0.1 MB |
| URL の Parquet：最初の 100 行 × 8 列 | 0.3〜0.7 秒 | 1.7 MB |
| URL の Parquet：任意の 5 か所の 100 行 | Chrome で各 150〜270 ms | 各 1.7 MB、合計 10.3 MB（ファイルの 7.8%） |
| ローカルの Parquet：1,000 万行を数値で並べ替え | 13.6 秒 | その列を 1 回 |
| ローカルの Parquet：その並べ替えの最初の画面 | 12 秒 | 表示する行を含む行グループすべて |
| ローカルの CSV 71 MB・100 万行：行を数える | 0.15 秒（Chrome 0.22 秒） | ファイルを 1 回 |
| CSV：任意の位置の行 | 1〜3 ms | 1,024 行のまとまり |
| CSV：100 万行を数値で並べ替え／並べ替えた最初の画面 | 1.1 秒／54 ms（Chrome 1.07 秒／61 ms） | |
| CSV：Chrome で絞り込みと並べ替えの間、画面のスレッドが止まった最長の時間 | 11 ms | |

Worker のメモリーは CSV で約 40 MB（索引は 1,024 行ごとに 8 バイト、ビューは 1 行 4 バイト）、Parquet で約 110〜135 MB
でした。Parquet の多くは、スクロールで戻ったときのために残すデコード済みの行グループと HTTP の範囲です（それぞれ最大 400 万
セルと 32 MiB）。Worker のバンドルは minify 後 210 KB（gzip 107 KB）で、hyparquet と zstd・gzip・brotli・lz4・snappy の
展開を含みます。画面のスレッドの部分は 3 KB です。

## 制限

- テキストのファイルは UTF-8 にしてください（BOM は可）。Shift_JIS や UTF-16 のファイルは先に変換するか、`vastgrid-duckdb` を
  使ってください。
- CSV・TSV の列の型は最初の 2,048 行で決めます。その後の合わない値は文字列のままで、数値の列では空白と一緒に並びます。
- Parquet を並べ替え・絞り込みしたビューは、画面ごとに、表示する行を含む行グループをすべて読みます。ページの索引がない
  ファイルは行グループ単位でデコードするため、数百万行の並べ替えの最初の画面には数秒かかります。その用途では
  `vastgrid-duckdb` で配信してください。
- 並べ替えは Worker で並べ替える列の値を持って行います。数千万行では Worker に数百 MB のメモリーが要ります。

## DuckDB-WASM ではなく hyparquet を選んだ理由

| | hyparquet（採用） | DuckDB-WASM |
| --- | --- | --- |
| 大きさ | Worker 全体で gzip 107 KB | WebAssembly がビルドごとに約 35〜40 MB（圧縮して数 MB）と、その Worker |
| 配信 | どの静的ホストでも可。特別なヘッダーは不要 | シングルスレッドのビルドは COOP/COEP なしで動く。スレッドにはクロスオリジン分離が必要 |
| 形式 | Parquet。CSV・TSV・JSON Lines はこのパッケージの読み込み | Parquet・CSV・JSON ほか。SQL も使える |
| 並べ替え・絞り込み・統計 | JavaScript で、`ArraySource` と同じ比較 | SQL。数千万行でははるかに速い |
| HTTP Range | 必要な範囲だけを要求してキャッシュ。ETag はこのパッケージで確認 | 組み込みの HTTP ファイルシステム |

ブラウザーでのグリッドの典型的な使い方（ファイルを開いて眺め、数百万行までを並べ替え・絞り込む）には、どのホストからでも
すぐに読み込める小さなエンジンが向いています。数億行を扱う処理はサーバーの `vastgrid-duckdb` に任せ、グリッドは同じ
`TableSource` で両方につなげます。
