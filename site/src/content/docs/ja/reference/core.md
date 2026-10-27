---
title: vastgrid/core と vastgrid/server
description: React なしで動くグリッドのストア、トランスポート、エラーと、サーバーレンダリングのための readInitialView。
---

`vastgrid/core` は React を除いたグリッドです。状態を持つストア、メッセージのクライアント、メッセージをエンジンへ運ぶトランスポートがあります。ブラウザー、Web Worker、サーバーで動きます。`vastgrid/server` はサーバーで表の先頭の行を読み、サーバーレンダリングに使います。React のコードは同じ名前を `vastgrid` から import します（`vastgrid` は `vastgrid/core` を再エクスポートしています）。Worker とサーバーは `vastgrid/core` から import します。このページのもとは [React の仕様の §4](https://github.com/yhay81/vastgrid/blob/main/docs/v2-react.md#4-the-store) です。

## ストア

```ts
import { createGridStore, httpTransport } from "vastgrid/core";

const store = createGridStore({ transport: httpTransport("/api", { events: "/api/events" }), table: "orders.csv" });
const disconnect = store.connect();
```

`createGridStore(options)` は `GridStore` を返します（クラスとしても `new GridStore(options)` でエクスポートしています）。`DataGrid` はストアを渡されなければ自分で作ります。

### `GridStoreOptions`

| オプション | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `transport` | `Transport` | （必須） | エンジンのある場所。 |
| `table` | `string` | （必須） | 開く表の `ref`（§8.2）。 |
| `open` | `OpenOptions` | | `open` の `read` オプション。`sheet`、`headerRow`、`keepEmptyRows`、`keepEmptyColumns`。 |
| `document` | `GridDocument` | 空のドキュメント | 最初のドキュメント（[§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#51-document)）。 |
| `session` | `GridSession` | 空のセッション | 最初のセッション（[§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#52-session)）。 |
| `initial` | `InitialView` | | サーバーで読んだ行（`readInitialView`）。最初の読み込みの前に表示します。 |
| `cacheBytes` | `number` | `CACHE_BYTES`（64 MiB） | 保持する行のバイト数。 |

### ライフサイクル

- ストアを作るだけでは副作用はありません。何も開かず、タイマーも動かさず、何も購読しません。
- `connect()` は表を開き（`open`）、エンジンのイベントを受け取り、ドキュメントのプランのビューを読みます。返す関数はそのすべてを元に戻し、表を閉じます。切断した後にもう一度接続できます。React の Strict Mode は開発時にそうします。
- 切断したストアは最後のスナップショットを保ち、何も読みません。

### メソッド

| メソッド | 説明 |
| --- | --- |
| `getSnapshot()` | 今の状態（`GridSnapshot`）。状態が変わるまで同じオブジェクトです。 |
| `subscribe(listener)` | スナップショットが変わると `listener` を呼びます。止める関数を返します。 |
| `on(event, listener)` | `"document"` と `"session"` の変更（制御されているときも知らせます）と `"error"` を受け取ります。止める関数を返します。 |
| `connect()` | 表を開いて読み始めます。切断する関数を返します。 |
| `dispatch(command, options?)` | コマンドを適用します（[コマンド](/ja/reference/commands/)）。`CommandOutcome` で解決し、reject はしません。ストアの間ずっと同じ関数です。 |
| `dispatchSync(command, options?)` | コマンドをその場で適用します。`copy` イベントのためのものです。読んでいない行が必要なコマンドは `not_loaded` で失敗し、そのリクエストは送られます。 |
| `control(part, controlled)` | `"document"` か `"session"` を制御された状態にします。コマンドはその結果を知らせるだけで、表示するのは `setDocument` か `setSession` だけです。 |
| `setDocument(document)`、`setSession(session)` | ホストが渡すドキュメントやセッションを表示します。制御された props、保存したビュー、エージェントなど。 |
| `cell(row, column)` | 画面のビューのセルの値。読むまでは `undefined`。 |
| `isCut(row, column)` | エンジンがセルのテキストを上限で切ったかどうか（§8.4）。 |
| `fullValue(row, column, signal?)` | セルの値全体（テキストが切られていても）とその列：`{ value, column }`。 |
| `rowKey(row)`、`rowId(row)` | 画面のビューの行のキー（§5.3）と行 ID。 |
| `getRowsVersion()`、`subscribeRows(listener)` | 画面のビューの行が届いたり消えたりすると変わる数と、それを受け取る方法。行はスナップショットに入りません。 |
| `setViewport({ top, rows, columns })` | 画面に見えているものを伝えます。ストアはその行と前後 1 ページを読みます。 |
| `ensure(start, end, columns)` | `columns` の行 `[start, end)` を、読んでいなければ読みます。 |
| `summarize(ranges, columns, signal?)` | 行の範囲のセルを数え、合計します：`{ count, numericCount, sum, min, max, average }`。 |
| `values(column, { search?, limit? }?, signal?)` | 列の値とそれぞれの行数を多い順に、最大 `limit`（1,000）個：`{ values: { value, count }[], truncated }`。 |
| `aggregate(measures, signal?)` | ドキュメントのプランの行に対する集計（§4.5）：`{ values, columns }`。行をグループにするプランでは `invalid_plan` で失敗します。 |
| `find(text, { from, direction?, caseSensitive? }, signal?)` | `from` の後（`direction` が −1 なら前）で、テキストが `text` を含む次のセル。表示している列を対象に、端で折り返します：`{ row, column }` か null。 |
| `retryWrite()` | 最後に失敗した書き込み（`failedWrite`）を送り直します。`edit_conflict` の後は、セルの今の値に上書きします。 |
| `discardWrite()` | 失敗した書き込みを忘れます。セルはエンジンが持つ値に戻ります。 |
| `reload()` | 書き込んだセルがある間にディスク上で変わったファイル（`fileChanged`）を、今の内容で読み直します。 |
| `exportUrl(target)` | target なしの書き出しのファイルをダウンロードする URL（トランスポートが決めます）か null。 |
| `exportName(format)` | データで返る書き出しのファイル名。表の名前に形式の拡張子を付けたもの。 |

## スナップショット

```ts
interface GridSnapshot {
  document: GridDocument; // §5.1
  session: GridSession; // §5.2
  table: TableInfo | null; // 表を開くまでは null
  view: ViewInfo | null; // 画面のビュー
  displayed: DisplayedColumn[]; // 画面の列を順に
  pending: { plan: Plan } | null; // 画面のビューと置き換えるために読んでいるプラン
  status: "idle" | "opening" | "ready" | "error";
  error: GridError | null;
  failedWrite: FailedWrite | null; // 最後に失敗した書き込み
  totals: { values: Record<string, JsonValue>; columns: Record<string, Column> } | null; // 合計行
}
```

- スナップショットは変わりません。コマンドは、ドキュメントとセッションのうち変えないメンバーをそのまま残すので、セレクターは軽いままです。アクティブセルを動かすと新しいセッションができますが、`document`、`checked`、`history` は同じものです。
- `TableInfo` は `open` の応答です。`table`（ハンドル）、`revision`、`status`（`loading`、`ready`、`error`）、`progress`、`rowCount`（わからない間は null）、`readableRows`、`columns`、`capabilities`（[エンジン](/ja/reference/engines/#ケーパビリティ)）、そして該当するときは `format`、`byteSize`、`notes`、`sheets`、`sheet`、`error`、`fileChanged`。
- `ViewInfo` はビューの `hash`、`status`（`building`、`ready`）、`rowCount`、`rowCountExact`、`readableRows`、`columns`、`edits` です。
- `FailedWrite` は `command`、`updates`、`error` と `retry` を持ちます。`retry` は `"retry"`、`"overwrite"`（`edit_conflict` の後）、または null です。

## コマンドの適用

```ts
const outcome = await store.dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
if (!outcome.ok) console.warn(outcome.error.code, outcome.error.message);
```

1. スナップショットはすぐに変わり、購読者に知らせます。キーを押した結果が同じフレームに出ます。
2. コマンドが生んだリクエストを送ります。コアのコマンド（[§6.7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#67-commands-of-the-core)）は応答が届いたときに適用します。
3. プランが変わったときは、古いビューを画面に残したまま（`pending` を設定して）新しいビューを読み、新しい行を一度に表示します。新しいプランは古いプランの読み込みを取り消します。
4. `not_loaded` で失敗したコマンドは、必要な行を読んでからもう一度適用します。

| 型 | 定義 |
| --- | --- |
| `DispatchOptions` | `{ clipboard?: { text?: string; html?: string } }`。`edit.paste` が貼り付けるもの。 |
| `CommandOutcome` | `{ ok: true; output?: unknown }` か `{ ok: false; error: CommandError \| GridError }`。失敗したコマンドは何も変えません。 |

`copy` は出力として `{ tsv, html, markdown }` を、`edit.paste` は `{ cutRows, cutColumns }` を返します（`vastgrid-spec` の `CommandOutputs`）。どのコマンドにも属さない失敗（読み込みの失敗、読めない表）は `snapshot.error` と `on("error")` に届きます。

## エラー

`GridError` は `code` を持つ `Error` で、該当するときは `reason`、`path`（JSON Pointer）、`details`、リクエストの `op` も持ちます。適用できないコマンドは、代わりに `vastgrid-spec` の `CommandError`（`code` は `invalid_command`）で失敗します（[コマンド](/ja/reference/commands/#コマンドが失敗するとき)）。

| `code` | いつ | HTTP |
| --- | --- | ---: |
| `invalid_request` | §8 に従わないメッセージ。`path` と `reason` 付き | 400 |
| `invalid_plan` | 検査を通らないプラン（§4.7）。`path` と `reason` 付き | 400 |
| `table_not_found` | 表が閉じているか、知らない表 | 404 |
| `not_ready` | 表を読み込み中で、リクエストが表全体を必要とする | 409 |
| `revision_changed` | リクエストのリビジョンの後に表が変わった | 409 |
| `edit_conflict` | 書き込みが想定した値をセルがもう持っていない | 409 |
| `file_changed` | 読んだ後にディスク上でファイルが変わった | 409 |
| `read_only` | 書き込めないセルへの書き込み | 403 |
| `not_allowed` | ホストが許さない `ref` や `target` | 403 |
| `invalid_value` | 列に合わない値、またはブロックに入らない値 | 422 |
| `too_many_columns` | 列が多すぎるピボット（§4.6） | 422 |
| `save_unsupported` | エンジンがこの表を保存できない | 422 |
| `load_failed` | 表を読めなかった | 422 |
| `export_too_large` | 形式に収まらない結果（Excel：1,048,575 行、16,384 列） | 413 |
| `cancelled` | リクエストを取り消した | 499 |
| `internal` | それ以外 | 500 |

一覧は [§8.7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#87-errors) にあり、`vastgrid-spec` の `ERROR_STATUS` がコードと HTTP ステータスを対応づけます。

## トランスポート

トランスポートは [§8](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#8-messages) のメッセージをエンジンへ運びます。行のブロックはバイト列（構造化エンコーディング）で、HTTP では JSON の後ろに添付して運びます。

| トランスポート | エンジン |
| --- | --- |
| `localTransport(engine)` | 同じスレッドにあるもの。`vastgrid-js` のメモリエンジンなど。 |
| `workerTransport(worker)` | `serveEngine(engine, self)` が答える Web Worker の中、または Worker と同じようにメッセージを運ぶもの（`WorkerLike`：`MessagePort`、VS Code の webview、ノートブックのウィジェット）の向こう。バッファは転送します。`close()` で受信をやめます。 |
| `httpTransport(url, options?)` | サーバーの上。`vastgrid-duckdb` の `createHttpHandler` など。リクエストはそれぞれ `POST` で、`rows` と `export` の応答はブロックを添付して返ります。リクエストを取り消すと HTTP リクエストも中断します。 |
| `serverFunctionTransport(action)` | 各リクエストをエンジンに渡す `"use server"` 関数の向こう。関数はリクエストを検査する必要があります（`vastgrid-spec` の `checkRequest`）。 |

```ts
// worker.ts
import { serveEngine } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

serveEngine(memoryEngine({ tables: { people: { columns, rows } } }), self);
```

```ts
// main.ts
import { workerTransport } from "vastgrid/core";

const transport = workerTransport(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
```

### `HttpTransportOptions`

| オプション | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `fetch` | `typeof fetch` | グローバルの `fetch` | リクエストを送る関数。 |
| `headers` | `Record<string, string>` | | すべてのリクエストに付けるヘッダー（認可など）。 |
| `events` | `string` | | エンジンのイベントを運ぶ Server-Sent Events の URL。ないと、ほかのクライアントの書き込みはグリッドに届きません。 |
| `exports` | `string` | `<url>/exports/` | target なしの書き出しをダウンロードする URL の接頭辞。 |

### `Transport` と `Engine`

独自の通信路を持つホストは `Transport` を実装します。MCP App はリクエストをそれぞれツールの呼び出しとして送っています。

```ts
interface Transport {
  send(request: RequestMessage, options: { signal?: AbortSignal }): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
  cancels?: "message" | "signal"; // リクエストの取り消し方：`cancel` メッセージ（既定）か signal
  exportUrl?(target: string): string;
}

interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}
```

`RequestMessage` は `{ v: 2, id, op, … }` です（§8.1）。付属の二つのエンジンは[エンジン](/ja/reference/engines/)で、エンジンの書き方は[独自のエンジン](/ja/guides/custom-engine/)で説明しています。

### `GridClient` と `RequestIds`

- `new GridClient(transport)` は独自の id でリクエストを送り、応答とイベントをすべて検査します（`checkResponse`、`checkEvent`）。`request(op, members, signal?)` は結果で解決するか `GridError` で reject し、signal が中断されると `cancel` を送ります。ストアはこれを一つ使います。ホストが直接使うことはあまりありません。
- `new RequestIds(engine).client()` は、一つのエンジンの複数のクライアントそれぞれに、エンジンの中で一意なリクエスト id を使う `Handler` を渡し、応答にはクライアント自身の id を戻します。あるクライアントの `cancel` がほかのクライアントのリクエストを止めることはありません。MCP App と VS Code の拡張機能は、こうして一つのエンジンで複数のグリッドに答えています。

### 定数

| 名前 | 値 | 意味 |
| --- | --- | --- |
| `BLOCK_ROWS` | `256` | ストアが読んで保持するブロックの行数。 |
| `CACHE_BYTES` | `64 * 1024 * 1024` | ストアが既定で保持する行のバイト数（`cacheBytes`）。 |

## `vastgrid/server`

`readInitialView(transport, options)` は表を開き、ドキュメントのプランのビューとその先頭の行を読んで、表を閉じます。結果は `InitialView`、つまり `{ table, plan, rows }` で、行のブロックは `Uint8Array` です。Server Components はこれをクライアントコンポーネントに渡せます。`DataGrid` の `initial` やストアに渡すと、最初のフレームでこの行を描きます。Promise のまま渡すとページはストリーミングされ、グリッドは解決するまでサスペンドします。React は import しません。

| オプション | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `table` | `string` | （必須） | 開く表の `ref`。 |
| `open` | `OpenOptions` | | `open` の `read` オプション。 |
| `document` | `GridDocument` | 空のドキュメント | グリッドの最初のドキュメント。そのプランのビューを読みます。 |
| `rows` | `number` | `100` | 読む行数。 |
| `signal` | `AbortSignal` | | 読み込みを取り消します。 |

```tsx
// app/orders/page.tsx（Server Component）
import { httpTransport } from "vastgrid/core";
import { readInitialView } from "vastgrid/server";
import { OrdersGrid } from "./orders-grid"; // <DataGrid initial={initial} … /> を描くクライアントコンポーネント

export default function Page() {
  const initial = readInitialView(httpTransport("http://localhost:8080/api"), { table: "orders.csv" });
  return <OrdersGrid initial={initial} />;
}
```

[サーバー上のファイル](/ja/guides/server/)と [React の仕様の §7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-react.md#7-server-rendering-and-server-components) も見てください。

## React なしのストア

ストアは画面を除いたグリッドのすべてです。コマンド、選択、元に戻す、書き込み、書き出しがどれも動きます。MCP App はサーバーでグリッドごとにこのストアを持ち、エージェントのコマンドを適用し、状態を読んでエージェントに返しています。

```ts
import { createGridStore, GridError, type GridSnapshot, type GridStore, localTransport } from "vastgrid/core";
import { DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({ allowedDirectories: ["/srv/data"], tempDirectory: "/tmp/vastgrid" });
const store = createGridStore({ transport: localTransport(engine), table: "orders.csv" });
const disconnect = store.connect();

// 表が開き、ドキュメントのビューが画面に出るまで待つ。
function settled(store: GridStore): Promise<GridSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === "error") {
        reject(snapshot.error ?? new GridError("load_failed", snapshot.table?.error ?? "The table could not be read."));
      } else if (snapshot.status === "ready" && snapshot.view && !snapshot.pending) {
        resolve(snapshot);
      } else {
        return;
      }
      stop();
    };
    const stop = store.subscribe(check);
    check();
  });
}

await settled(store);
await store.dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
await settled(store);
store.ensure(0, 20, ["id", "total"]);
```

行は `ensure` の後に届きます。`subscribeRows` で届いたことがわかり、`cell(row, column)` で読めます。`disconnect()` で表を閉じ、`engine.dispose()` でエンジンを閉じます。
