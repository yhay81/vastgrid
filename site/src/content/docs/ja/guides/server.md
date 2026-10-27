---
title: サーバーのファイル
description: どんな大きさの CSV・TSV・Parquet・JSON Lines のファイルと Excel のブックも、vastgrid-duckdb の DuckDB エンジンで Node.js から配信します。
---

`vastgrid-duckdb` は、表のファイルを Node.js の DuckDB で開き、グリッドのメッセージに答えます。行、並べ替え・絞り込みしたビュー、グループ化とピボット、集計、検索、書き込み、保存、書き出しです。ページが受け取るのは、表示する行だけです。Node.js 20 以降が必要で、DuckDB の Node.js バインディングが対応するプラットフォームで動きます。

```bash
npm install vastgrid vastgrid-duckdb
```

## エンジンとハンドラー

```ts
// server.ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
});

createServer(createHttpHandler(engine, { path: "/api/table" })).listen(8080);
```

エンジンはプロセスごとに 1 つ作り、共有してください。開いた表とそのビュー、DuckDB のデータベースを要求の間で持ち続けます。プロセスを止めるときは `engine.dispose()` を呼びます。DuckDB を閉じ、エンジンのファイルを削除します。

`createHttpHandler` が返すのは、Node.js のハンドラー `(request, response, next?)` です。`node:http` のリスナーとして使えるほか、Express・Connect・Vite の開発サーバーのミドルウェアにもなり、ほかのパスは `next` に渡します。Fetch API のハンドラーではありません。Fetch API を使うフレームワークについては後述します。

```ts
app.use(authenticate); // your own check comes first
app.use(createHttpHandler(engine, { path: "/api/table" }));
```

答えるのは `POST /api/table`（要求。行は JSON に Arrow を添えて返ります）、`GET /api/table/events`（エンジンのイベントを Server-Sent Events で）、`GET /api/table/exports/<name>`（書き出したファイルのダウンロード）です。ほかのオプションは `events`、`exports`、`maxBody`（64 MiB）、`keepAlive`（15 秒）です。

ページでは、`httpTransport` がグリッドのメッセージを POST します。

```tsx
import { DataGrid, httpTransport } from "vastgrid";
import "vastgrid/styles.css";

const transport = httpTransport("/api/table", { events: "/api/table/events" });

export function Sales() {
  return <DataGrid transport={transport} table="sales/2025.parquet" style={{ height: 600 }} />;
}
```

`table` は、エンジンが開く `ref` です。`httpTransport(url, options)` は、`events`、`headers`（認可など、すべての要求に付けるヘッダー）、`fetch`、`exports`（既定は `<url>/exports/`）を受け取ります。`events` は渡してください。グリッドは、読み込み中のファイル、完了までの並べ替え、変更されたファイルを、イベントで追いかけます。要求を中断するとクエリーも止まります。グリッドは、新しいプランに替わったビューの読み取りを中断します。

### Fetch API のフレームワーク

Next.js のルートハンドラー、Hono、Bun、Deno は `Request` を受け取ります。メッセージは自分で `engine.handle` に渡してください。

```ts
// app/api/table/route.ts
import { ERROR_STATUS, type ErrorCode, toTextEncoding } from "vastgrid-spec";
import { engine } from "@/lib/engine"; // a module that makes one engine for the process

export async function POST(request: Request) {
  const message = await request.json().catch(() => null);
  const answer = await engine.handle(message, { signal: request.signal });
  if (answer === undefined) return new Response(null, { status: 204 });
  const error = answer.error as { code: ErrorCode } | undefined;
  if (error) return Response.json(answer, { status: ERROR_STATUS[error.code] });
  return Response.json(toTextEncoding(answer));
}
```

`vastgrid-spec` は `vastgrid-duckdb` と一緒に入りますが、import するには依存関係に加えてください。ブロックは JSON の中の base64 になり、Node.js のハンドラーの Arrow より 3 分の 1 ほど大きくなります。イベントは、`engine.subscribe(listener)` を `GET` のルートから Server-Sent Events で流します。書き出しは、`engine.exportFile(name)` が指すファイルを返します。

### Server Functions

`serverFunctionTransport` は、`"use server"` の関数を通してメッセージを運びます。

```ts
// app/table-action.ts
"use server";
import type { RequestMessage } from "vastgrid/core";
import { engine } from "@/lib/engine";

export async function tableAction(request: RequestMessage) {
  // Check here that this person may use the grid.
  return engine.handle(request);
}
```

```tsx
"use client";
import { DataGrid, serverFunctionTransport } from "vastgrid";
import { tableAction } from "./table-action";

const transport = serverFunctionTransport(tableAction);

export function Sales() {
  return <DataGrid transport={transport} table="sales/2025.parquet" />;
}
```

この関数は、どのクライアントが送るものも受け取ります。`engine.handle` は各要求を仕様に照らして確かめ（`checkRequest`）、`resolve` が拒むものは拒みます。Server Functions はイベントを運ばず、フレームワークによっては 1 つずつしか実行しないので、スクロールは `httpTransport` のほうが速くなります。書き出しをダウンロードさせるには、トランスポートに `exportUrl` を加え、`engine.exportFile` のファイルを返すルートを用意します。

## オプション

| `DuckDBEngine.create` | 既定 | |
| --- | --- | --- |
| `allowedDirectories` | 必須 | 開いてよいファイルのフォルダー。DuckDB はほかのファイルを読みません |
| `tempDirectory` | 必須 | エンジンのデータベース、ディスクに書き出したデータ、変換したファイルを置く場所（専用のフォルダーを作ります） |
| `resolve` | パス。相対パスは最初の許可フォルダーの中 | `ref` が指すファイル。例外を投げると拒否（`not_allowed`） |
| `resolveTarget` | なし：書き出しはダウンロード用に保持 | 書き出しの `target` が指すファイル |
| `memoryLimit` | メモリの 5 分の 1（1〜4 GB） | DuckDB のメモリ上限（`"4GB"` など） |
| `maxTempDirectorySize` | `"8GB"` | ディスクに書き出すファイルの上限 |
| `threads` | CPU の数 − 1 | DuckDB のスレッド数 |
| `maxTables` | 4 | どのハンドルも使っていない表を、開き直しに備えて残しておく数 |
| `previewRows` | 1,000 | 読み込み中のファイルで、すぐに読める行数 |
| `textLimit` | 2,000 | 要求が指定しないときに、セルが送る文字列の最大長 |
| `saveFiles` | `false` | `save` で CSV・TSV のファイルにセルを書き込めるようにする |
| `watchFiles` | `true` | 開いている表のファイルの変更を追いかける |
| `maxViews`、`materializeRows`、`viewPreviewMinRows`、`viewPreviewRows` | 8、2,000 万、100 万、1,000 | 保持するビューの数と、並べ替えの保持のしかた・先行の答え方（後述） |
| `log` | なし | どの要求にも由来しない問題 |

## セキュリティ

- DuckDB が読むのは `allowedDirectories` の中のファイルだけです。リンクをたどった実際の場所で判定し、拡張機能は読み込みません。要求には SQL もパスも含まれません。SQL はエンジンが組み立て、値はすべてパラメーターです。
- エラーメッセージには、サーバーのフォルダーや SQL は含まれません。
- `resolve` は開かれるすべての `ref` について、どのクライアントにも同じように実行されます。エンジンはすべてのクライアントを信頼し、表の ID（`t1`、`t2`、…）は秘密ではありません。1 つのエンジンは同じファイルを見てよい人たちの間で共有するか、`engine.handle` の前に各 `open` 要求の `ref` を確かめてください。
- 1 回の `rows` 要求で読めるのは、最大 1,000,000 行かつ 1,000,000 セルです。

## ファイルと形式

| 形式 | 名前 |
| --- | --- |
| CSV | `.csv`、`.csv.gz`、`.csv.zst` |
| TSV | `.tsv`、`.tab`、`.tsv.gz`、`.tsv.zst` |
| Parquet | `.parquet`、`.pq` |
| JSON Lines | `.jsonl`、`.ndjson`、それぞれの `.gz` |
| JSON | `.json`、`.json.gz` |
| Excel | `.xlsx`、`.xlsm` |

`tableFormatOf(file)` は、ファイル名から形式を返します（表のファイルでなければ null）。`findTableFiles(folders, limit)` は、フォルダーの中の表のファイルを、2 階層下まで、隠しファイルを除いて列挙します。ファイルの一覧を見せるのに使えます。

- **Parquet** は、その場で行番号から読みます。1 億行のファイルでも、どのブロックも数十ミリ秒で読めます。
- **区切り文字のファイル・JSON・Excel** は、エンジンのデータベースに読み込みます。最初の `previewRows` 行はすぐに読め、読み込みの進み具合は `progress` イベントで伝わります。UTF-16・Shift_JIS・EUC-JP などの文字コードは判別して変換し、表の `notes` にそのことが入ります（`encoding:shift_jis`）。
- **Excel** は、最初の表示されているシートで開きます。別のシートはグリッドの `open` プロパティで選びます（`<DataGrid key={sheet} open={{ sheet }} … />`）。`headerRow`・`keepEmptyRows`・`keepEmptyColumns` も指定できます。`open` はグリッドがストアを作るときに読まれるので、`key` を一緒に渡します。

## 段階的な並べ替え

100 万行以上の並べ替えは、まず最終的な順序での先頭 1,000 行を答え、グリッドは残りを作っている間それを表示します。完成すると `view` イベントで伝わります。2,000 万行までのビューは並べ替えた写しを持ち、それより大きいビューは行の順序だけを持ちます。2026-10-27 に Apple M2 Pro、Node.js 24、DuckDB 2.0、8 スレッド、メモリ上限 2 GB で、8 列の 256 行を読んで 3 回計測した中央値です（[計測の記録](https://github.com/yhay81/vastgrid/blob/main/docs/v2-views-benchmark.md)）。

| ファイルと操作 | 最初の行 | その後のビュー内の読み取り（中央値） |
| --- | ---: | ---: |
| 1 億行の Parquet（1.38 GB）、並べ替え | 834 ms | 957 ms |
| 1 億行の Parquet、絞り込み | 207 ms | 31 ms |
| 1,000 万行の CSV（735 MB）、並べ替え | 63 ms | 6.3 ms |
| 1,000 万行の CSV、絞り込み | 144 ms | 4.9 ms |

並べ替えたビューが完成するまで、さらに Parquet で 3.3 秒、CSV で 1.4 秒かかりました。

## 保存とファイルの追跡

書き込んだセルは、ファイルとは別にエンジンが持ちます。`saveFiles: true` にすると、グリッドの保存ボタン（または ⌘S、Ctrl+S）で、元の CSV・TSV ファイルに書き込みます。変わるのはそのフィールドだけで、引用符・改行・文字コードはそのままです。ファイルは一時的な名前で書いてから元のファイルに置き換えます。読んだ後に他の人が変更したファイルは上書きしません（`file_changed`）。Apple シリコンのノートパソコンで、2 つのセルの保存は 20 万行のファイルで約 60 ms、200 万行のファイルで 0.3 秒でした。

`watchFiles`（既定でオン）では、エンジンが開いているファイルのフォルダーを監視します。変更されたファイルは読み直し、グリッドは並べ替えや絞り込みを保ったまま新しい内容に移ります。書き込んだセルがある表はそのまま残し、ファイルが変わったことをグリッドが知らせます。

書き出し（CSV・TSV・Parquet・JSON・xlsx）はサーバーで行います。`resolveTarget` がなければ、エンジンはファイルを 1 時間保持し、グリッドは `<path>/exports/<name>` からダウンロードします。同じノートパソコンで、100 万行 × 4 列の並べ替えたビューの書き出しは、CSV で 0.3 秒、xlsx で 2.2 秒でした。

## デプロイ

- `@duckdb/node-api` はネイティブモジュールです。サーバーのバンドルには含めず、サーバーと一緒にインストールしてください。Next.js では次のようにします。

  ```ts
  // next.config.ts
  export default {
    serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  };
  ```

- プラットフォームのパッケージ `@duckdb/node-bindings-<platform>` も配置してください。Apple シリコンの macOS で約 110 MB あり、バンドルの上限が小さいサーバーレス環境には収まらないことがあります。
- `tempDirectory` には余裕を持たせてください。読み込んだファイル、並べ替えたビュー、ディスクに書き出したデータが置かれます。`maxTempDirectorySize` が制限するのは、書き出したデータのファイルだけです。
- エンジンは要求の間で表を持ち続けるので、長く動き続けるプロセスで動かしてください。

## サーバーレンダリング

`vastgrid/server` の `readInitialView` は、表とそのビュー、最初の行をサーバーで読み、グリッドの `initial` プロパティに渡せる形にします。Promise のまま渡すと、ページはすぐに送られ、行は読めたところでストリーミングされます。

```tsx
// app/sales/page.tsx (a Server Component)
import { localTransport } from "vastgrid/core";
import { readInitialView } from "vastgrid/server";
import { engine } from "@/lib/engine";
import { SalesGrid } from "./sales-grid";

export default function Page() {
  const initial = readInitialView(localTransport(engine), { table: "sales/2025.parquet", rows: 100 });
  return <SalesGrid initial={initial} />;
}
```

```tsx
// app/sales/sales-grid.tsx
"use client";
import { DataGrid, httpTransport, type InitialView } from "vastgrid";

const transport = httpTransport("/api/table", { events: "/api/table/events" });

export function SalesGrid({ initial }: { initial: Promise<InitialView> }) {
  return <DataGrid transport={transport} table="sales/2025.parquet" initial={initial} style={{ height: 600 }} />;
}
```

サーバーは最初の行を HTML の表として送り、canvas は最初のフレームでその行を描きます。`readInitialView` は `document` と `open` も受け取ります。グリッドにも同じものを渡し、両方が同じビューを読むようにしてください。
