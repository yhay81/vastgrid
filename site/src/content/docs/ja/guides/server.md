---
title: サーバーのファイル
description: どんな大きさの CSV・TSV・Parquet・JSON Lines のファイルも、vastgrid-duckdb で Node.js から配信します。
---

`vastgrid-duckdb` は表のファイルを DuckDB で開き、グリッドの要求に答えます。指定した範囲の行、並べ替え・絞り込みしたビュー、列の統計、値の一覧、選択範囲の集計、検索、書き出しです。ブラウザーでは、`RemoteSource` がこれらの要求を送ります。

```bash
npm install vastgrid vastgrid-duckdb
```

## エンジンと受け口

```ts
import path from "node:path";
import { createTableHandler, TableEngine, type TableHandlerOptions } from "vastgrid-duckdb";

const root = "/srv/data";
const engine = TableEngine.create({ allowedDirectories: [root], tempDirectory: "/tmp/vastgrid" });

export const options: TableHandlerOptions = {
  engine: () => engine,
  resolve: (ref) => {
    const file = path.resolve(root, ref);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Not allowed");
    return file;
  },
};

export const handler = createTableHandler(options);
```

`TableEngine.create` は Promise を返し、受け口はその完了を待ちます。エンジンはプロセスごとに 1 つ作り、要求の間で共有してください。エンジンは開いた表とそのビュー、DuckDB の接続のプールを持っています。

`createTableHandler` は、Fetch API の `Request` を受けて `Response` を返す関数を返します。Next.js のルートハンドラー、Hono、Bun、Deno など、これらを使うものなら何でも使えます。要求は `signal` ごと渡してください。ブラウザーが取りやめた要求（グリッドが遠くへスクロールした場合）のクエリーが止まります。

```tsx
import { DataGrid, RemoteSource } from "vastgrid";

const source = new RemoteSource({ endpoint: "/api/table", ref: "sales/2024.parquet" });
<DataGrid source={source} />;
```

`ref` は、`resolve` が解釈できるものなら何でもかまいません。フォルダーからの相対パス、データベースの ID、アップロードしたファイルのキーなどです。

### Fetch API の要求を使わないフレームワーク

`handleTableRequest(body, options, signal)` は解析済みの要求 1 つに答え、`errorBody(error)` はエラーを、送るステータスと本文に変えます。Express では次のようにします。

```ts
import express from "express";
import { errorBody, handleTableRequest } from "vastgrid-duckdb";
import { options } from "./table.ts"; // 上の options

const app = express();
app.post("/api/table", express.json({ limit: "1mb" }), async (request, response) => {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    const result = await handleTableRequest(request.body, options, controller.signal);
    response.json({ result });
  } catch (error) {
    const { status, body } = errorBody(error, console.error);
    response.status(status).json(body);
  }
});
```

## オプション

### `TableEngine.create(options)`

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `allowedDirectories` | （必須） | DuckDB が読み込みと書き出しをしてよいフォルダー。ほかのファイルへのアクセスはすべて無効にし、あとから有効にはできません。 |
| `tempDirectory` | （必須） | エンジンがデータベースのファイル、メモリからあふれたデータ、変換したファイルを置く場所。エンジンごとにその中に専用のフォルダーを作り、`dispose()` で削除します。異常終了したプロセスが残したフォルダーは、次の起動時に削除します。 |
| `memoryLimit` | メモリの 5 分の 1（1〜4 GB） | DuckDB のメモリの上限。たとえば `"4GB"`。 |
| `threads` | CPU の数 − 1 | DuckDB の作業スレッドの数。 |
| `maxTables` | `4` | 開いたままにする表の数。これを超えると、最も長く使っていない表から閉じます。 |
| `maxViews` | `2` | 表ごとに残す、並べ替え・絞り込みしたビューの数。 |
| `materializeRows` | `20000000` | これより行の多い表では、ビューは並べ替えた複製ではなく、行の順番だけを持ちます（後述）。 |
| `previewRows` | `1000` | 区切りのテキストや JSON のファイルの読み込み中に読める行の数。 |
| `textLimit` | `2000` | 既定でセルごとに送る文字列の最大の長さ。 |
| `log` | | 要求が原因ではない問題を受け取ります。ログに使います。 |

### `createTableHandler(options)`

| オプション | 説明 |
| --- | --- |
| `engine` | エンジン、またはエンジンかその Promise を返す関数。 |
| `resolve(ref)` | 要求の `ref` をファイルの絶対パスに変えます。拒否するには例外を投げます。クライアントが何を開けるかは、ここで決めます。 |
| `resolveTarget(target)` | 書き出し（アプリから呼ぶ `source.exportView(…)`）の書き出し先を、新しいファイルの絶対パスに変えます。これがないと書き出しは拒否され、`capabilities.export` は `false` になります。 |
| `onError(error)` | 要求が原因ではないエラーを受け取ります。ログに使います。 |

## 安全性

- DuckDB が読めるのは、`allowedDirectories` と DuckDB 自身の一時フォルダーだけです。エンジンは起動時にこれを設定し、そのあとは変更できないようにするので、どの要求も、SQL を通しても、ほかのファイルには届きません。
- ファイルは、リンクをたどった実際の場所で許可します。許可したフォルダーの中のリンクが外のファイルを指している場合は、`not_allowed` で拒否します。
- SQL はエンジンが組み立て、値はすべてパラメーターで渡します。クライアントが送るのは列の番号だけで、列名や SQL は送りません。
- クライアントに送るエラーメッセージでは、ファイル名からサーバーのフォルダーを除き、DuckDB が引用する SQL も省きます。
- `resolve` は表を開くたびに呼ばれます。ダウンロードのときと同じように、そのユーザーがそのファイルを開いてよいかを、ここで確かめてください。
- 1 回の `rows` の要求で読めるのは、最大 1,000,000 行・1,000,000 セルです。フレームワークの側でも、要求の本文の大きさを制限してください。

## ファイル

形式はファイルの拡張子で決まります。

| 形式 | 拡張子 |
| --- | --- |
| CSV | `.csv`、`.csv.gz`、`.csv.zst` |
| TSV | `.tsv`、`.tab`、`.tsv.gz`、`.tsv.zst` |
| Parquet | `.parquet`、`.pq` |
| JSON Lines | `.jsonl`、`.ndjson`、`.jsonl.gz`、`.ndjson.gz` |
| JSON | `.json`、`.json.gz` |

- **区切りのテキストと JSON** は、エンジンのデータベースのファイルの中で DuckDB の表になります。最初の行（`previewRows`）はすぐに読めます。グリッドは残りを読み込む間それを表示し、読み込みが終わると並べ替え・絞り込み・統計を使えるようにします。735 MB・1,000 万行の CSV は 0.15 秒で最初の行を表示し、5.3 秒で読み込みを終えます。
- **Parquet** はファイルのまま、行の位置で読みます。読み込みはなく、1.4 GB・1 億行のファイルが 20 ms で開きます。
- **文字コード**のうち DuckDB が読めない Shift_JIS と EUC-JP は、検出して先に UTF-8 に変換します。そのとき表の `notes` には `encoding:shift_jis` のように記録され、グリッドのステータスバーに表示されます。値が 1 つの型に収まらない列は文字列として読み（`all_varchar`）、UTF-8 として正しくない部分は置き換えます（`invalid_utf8_replaced`）。
- **ディスク上のファイルが変わると**（大きさか更新日時）、次の `info` はそのファイルを開き直し、新しい `revision` を返します。読み直すには、グリッドの `reloadKey` を変えてください。たとえば、アプリがそのファイルを保存したあとです。

## 並べ替え・絞り込みしたビュー

並べ替えや絞り込みをすると、ビューを作ります。`materializeRows` 行（既定で 2,000 万行）までの表では、ビューは表を並べ替えた複製なので、元の表と同じ速さでスクロールできます（行のまとまり 1 つで約 2 ms）。それより大きな表では、ビューは行の順番だけを持ちます。作るのは 1 桁速く、一時領域も数分の 1 で済みますが、1 億行の Parquet では、行のまとまり 1 つを読むのに 0.1〜0.2 秒かかります。[性能](/ja/about/performance/)を参照してください。

## デプロイ

- `@duckdb/node-api` はネイティブの拡張です。サーバーのバンドルに含めず、サーバーと一緒にインストールしてください。Next.js では次のようにします。

  ```ts
  // next.config.ts
  export default {
    serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  };
  ```

- OS ごとのパッケージ `@duckdb/node-bindings-<platform>`（macOS で約 120 MB）を一緒に配布してください。バンドルの大きさの上限が小さいサーバーレスの環境には、収まらないことがあります。
- `tempDirectory` には十分な空きを用意してください。読み込んだファイル、並べ替えたビュー、メモリからあふれたデータを置きます。
- エンジンは要求の間で表を保つので、長く動き続けるプロセスで動かしてください。プロセスを終えるときに `dispose()` を呼ぶと、DuckDB を閉じて一時ファイルを削除します。
