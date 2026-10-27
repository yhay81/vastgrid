---
title: 自作のエンジン
description: 自分のデータの置き場所からグリッドのメッセージに答えます。仕様のうちできる部分だけを提供し、適合性のコーパスで確かめます。
---

グリッドは自分ではデータを読みません。エンジンにメッセージを送り、返ってきたものを描きます。`vastgrid-js` と `vastgrid-duckdb` はそのエンジンの 2 つです。データがほかの場所（別のデータベース、検索インデックス、API など）にあるなら、エンジンを自作してください。

## エンジンとは

エンジンとは、仕様のメッセージに答える `handle(message)` メソッドを持つオブジェクトのことで、イベントを送るなら `subscribe(listener)` も持ちます。`vastgrid/core` の `Engine` インターフェースです。

```ts
interface Engine {
  handle(message: unknown): Promise<unknown>;
  subscribe?(listener: (event: unknown) => void): () => void;
}
```

メッセージはトランスポートが運びます。同じスレッドなら `localTransport(engine)`、Web Worker を挟むなら `serveEngine` と `workerTransport`、ネットワーク越しなら HTTP のハンドラーと `httpTransport` です。エンジンはどれでも同じです。

## メッセージ

メッセージは[仕様の §8](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#8-messages) で定めています。

| 項目 | 内容 |
| --- | --- |
| [エンベロープ（§8.1）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#81-envelope) | 要求は `{ v: 2, id, op, … }`、応答は `{ v: 2, id, result }`、エラーは `{ v: 2, id, error: { code, message, path?, reason? } }`、イベントは `{ v: 2, event, … }` |
| [操作（§8.2）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#82-operations) | `open`、`info`、`rows`、`summarize`、`find`、`locate`、`write`、`save`、`export`、`changes`、`reload`、`cancel`、`close` |
| `TableInfo`（§8.2） | `open` の答え：表の ID、`revision`、`edits`、`status`、`progress`、`rowCount`、`readableRows`、`columns`、`capabilities` |
| [ブロック（§8.4）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#84-blocks) | `rows` の値：レコードバッチ 1 つの Arrow IPC ストリームで、列ごとに 1 つのフィールド |
| [イベント（§8.5）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#85-events) | `changed`、`progress`、`view` |
| [取り消し（§8.6）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#86-cancellation) | `cancel` か要求の中断。エンジンは `cancelled` で答えるか、最後まで処理します |
| [エラー（§8.7）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#87-errors) | エラーコードと、それぞれの HTTP ステータス |
| [エンコーディング（§8.8）](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#88-transports) | ブロックは、関数呼び出しと Worker では `{ bytes }`、テキストでは `{ base64 }`、HTTP では添付 |

ビューにはハンドルがありません。要求のたびに表とそのリビジョン、プランを指定し、エンジンは作ったビューを保持しても捨ててもかまいません。

## 一部だけを提供する

`TableInfo` には、エンジンのケイパビリティが入ります（[§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#410-capabilities)）。グリッドが出す機能はその範囲に限られ、ほかのものを使うプランは `invalid_plan`（`unsupported`）になります。そのため、エンジンは小さく始められます。最小のエンジンは `open`、プラン `{}` の `rows`、`close` に答えるだけです。グリッドは表を表示してスクロールでき、並べ替え・絞り込み・編集・書き出しは出しません。

| ケイパビリティ | グリッドが出す機能 |
| --- | --- |
| `plan.sort` | 列メニューからの並べ替え |
| `plan.where`、`functions` | 絞り込みと条件 |
| `plan.search` | 検索ボックス |
| `plan.aggregate`、`plan.having`、`plan.pivot`、`measures` | グループ化、合計行、ピボット |
| `plan.derive` | 計算列 |
| `summarize`、`find`、`locate` | 選択範囲の集計、検索バー、新しいビューでも選択中の行を保つこと |
| `write`、`save` | 編集と保存ボタン |
| `export` | 書き出しメニュー（`formats` と、`file` か `data` の `delivery`） |
| `preview`、`partialViews`、`changes` | 終わる前の並べ替えの行（§9）と、変更の伝わり方 |

## 最小のエンジン

1 つの表を、元の順序のまま返すだけのスケッチです。名前はすべて `vastgrid-spec` のものです。

```ts
import {
  answerId,
  type Capabilities,
  checkRequest,
  type Column,
  encodeBlock,
  errorResponse,
  type JsonValue,
  planHash,
  ProtocolError,
} from "vastgrid-spec";

// Rows in their own order only: no derived columns, filters, groups, sorts or search.
const capabilities: Capabilities = {
  plan: { derive: false, where: false, aggregate: false, pivot: false, having: false, sort: false, search: false },
};

export function rowsEngine(name: string, columns: Column[], rows: JsonValue[][]) {
  const edits = { version: 0, cells: 0 };
  const info = {
    table: name,
    revision: "1",
    edits,
    status: "ready",
    progress: 1,
    rowCount: rows.length,
    readableRows: rows.length,
    columns,
    capabilities,
  };

  return {
    async handle(message: unknown) {
      let request: ReturnType<typeof checkRequest>;
      try {
        request = checkRequest(message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        const { path, reason } = error;
        return errorResponse(answerId(message), "invalid_request", error.message, { path, reason });
      }
      const { id, op } = request;
      if (op === "cancel") return undefined;
      if (op === "open") {
        if (request.ref !== name) return errorResponse(id, "not_allowed", "There is no such table.");
        return { v: 2, id, result: info };
      }
      if (request.table !== name) return errorResponse(id, "table_not_found", "The table is not open.");
      if (op === "info") return { v: 2, id, result: info };
      if (op === "close") return { v: 2, id, result: null };
      if (op !== "rows") return errorResponse(id, "internal", `This engine does not answer ${op}.`);

      const [member] = Object.keys(request.plan as object);
      if (member !== undefined) {
        const reason = "unsupported";
        return errorResponse(id, "invalid_plan", `This engine has no ${member}.`, { path: `/plan/${member}`, reason });
      }
      if (request.revision !== info.revision) return errorResponse(id, "revision_changed", "The table changed.");
      const picked = (request.columns as string[]).map((column) => columns.findIndex((c) => c.name === column));
      const missing = picked.indexOf(-1);
      if (missing >= 0) {
        const path = `/columns/${missing}`;
        return errorResponse(id, "invalid_request", "No such column.", { path, reason: "syntax" });
      }
      const start = request.start as number;
      const end = Math.max(start, Math.min(request.end as number, rows.length));
      const view = {
        hash: await planHash({}),
        status: "ready",
        rowCount: rows.length,
        rowCountExact: true,
        readableRows: rows.length,
        columns,
        edits,
      };
      const values = rows.slice(start, end).map((row) => picked.map((index) => row[index]));
      const block = { bytes: encodeBlock(picked.map((index) => columns[index]), values) };
      const rowIds = values.map((_, offset) => start + offset);
      return { v: 2, id, result: { view, start, end, rowIds, block } };
    },
  };
}
```

```tsx
import { DataGrid, localTransport } from "vastgrid";

const transport = localTransport(rowsEngine("people", columns, rows));

export function People() {
  return <DataGrid transport={transport} table="people" style={{ height: 480 }} />;
}
```

実際のエンジンは、もっと多くのことをします。要求された行だけをデータの置き場所から読み、`textLimit` より長い文字列を切って `truncated` で知らせ（§8.4）、型に収まらない値には `invalid_value` で答え、データが変わったら `changed` イベントを送ります。

## 道具

`vastgrid-spec` には、どのエンジンにも必要な検査とエンコーディングがあります。

| 名前 | 用途 |
| --- | --- |
| `checkRequest`、`checkResponse`、`checkEvent` | §8 の検査。グリッドもすべての答えをこれで確かめます |
| `errorResponse`、`answerId`、`ERROR_STATUS` | §8.7 に従うエラーと、その HTTP ステータス |
| `checkPlan` | プランを表の列に照らして検証します（§4.7） |
| `planHash` | ビューのプランのハッシュ |
| `encodeBlock`、`decodeBlock` | 型付き JSON の行からブロックへ、またその逆 |
| `toTextEncoding`、`toStructuredEncoding`、`frameAttached`、`readAttached` | §8.8 のエンコーディング |

SQL を使うエンジンには、`vastgrid-sql` があります。検証したプランを、仕様どおりの意味（空の値は最後、同順位は行 ID 順）を持つ DuckDB の SQL にします。`compileView(checkPlan(plan, columns), { relation, rowId })` の後、`rowsQuery(view, { start, end, columns })` と `countQuery(view)` を使います。値は常にパラメーター、名前は常に引用符付きで、セッションのタイムゾーンは UTC にしておく必要があります。

## コーパスで確かめる

適合性のコーパス（[§10](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#10-conformance)）は `vastgrid-spec` に含まれています。プランのケースは、表とプラン、期待する行かエラーを示します。`vastgrid-spec/conformance` の `readCorpus()` で読み込み、ケースごとにエンジンで `open` と `rows` を実行し、ブロックを `decodeBlock` で読んで、`compareResult(expect, got)` で違いを一覧にします。提供していないメンバーを使うプランのケースは、理由 `unsupported` の `invalid_plan` になるはずです。[メモリエンジンのテスト](https://github.com/yhay81/vastgrid/blob/main/packages/js/test/conformance.test.ts)がまさにこれを行っています。メッセージは `readMessageCorpus` と `runMessageCase` で同じように確かめられます。

## 自作のトランスポート

ホストに独自の通信路（Webview の `postMessage` やノートブックの comm など）があるとき、`postMessage` と `addEventListener` を持つものなら `workerTransport` が使え、反対側では `serveEngine` が答えます。そうでなければ `Transport` を実装します。`send(request, { signal })` はブロックをバイト列にしたエンジンの答えを返し、`cancel` には何も返しません。`subscribe`、`cancels`（signal の中断で要求が取り消されるなら `"signal"`）、`exportUrl` は省略できます。

```ts
import type { Transport } from "vastgrid";
import { toStructuredEncoding } from "vastgrid-spec";

// `call` carries text to the engine and gives its answer in the text encoding (§8.8).
export function textTransport(call: (message: string) => Promise<string>): Transport {
  return {
    async send(request) {
      const answer = await call(JSON.stringify(request));
      return request.op === "cancel" ? undefined : toStructuredEncoding(JSON.parse(answer));
    },
  };
}
```

エンジンの側では、`cancel` 以外の答えを `toTextEncoding(answer)` でその形にします。グリッドはすべての答えを `checkResponse` で確かめるので、間違いがあれば誤った行ではなくエラーとして現れます。
