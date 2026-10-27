---
title: メモリ上のデータ
description: すでに JavaScript にある行や Arrow の表を、vastgrid-js のメモリエンジンで表示します。
---

`vastgrid-js` はメモリエンジンです。メモリ上にある表について、グリッドのメッセージに答えます。並べ替え、絞り込み、グループ化、ピボット、合計行、検索、書き出しはすべて JavaScript で、ページの中か Web Worker の中で行います。サーバーには何も送りません。

```bash
npm install vastgrid vastgrid-js
```

```tsx
import { DataGrid, localTransport } from "vastgrid";
import { memoryEngine } from "vastgrid-js";
import "vastgrid/styles.css";

const engine = memoryEngine({
  tables: {
    orders: {
      columns: [
        { name: "id", type: "bigint" },
        { name: "customer", type: "string" },
        { name: "ordered_at", type: "timestamp" },
        { name: "total", type: "decimal", precision: 12, scale: 2 },
        { name: "paid", type: "boolean" },
      ],
      rows: [
        [1, "Ada Lovelace", "2026-01-31 09:30:00", "120.50", true],
        [2, "Alan Turing", "2026-02-01 14:05:00", "8.00", false],
      ],
      editable: true,
    },
  },
});
const transport = localTransport(engine);

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

`memoryEngine({ tables })` は、グリッドの `table` プロパティが指す名前ごとに表を受け取ります。`localTransport` は、同じスレッドにあるエンジンへ、グリッドのメッセージを関数呼び出しとして届けます。

## 列と値

列は `{ name, type }` に、その型のメンバーを加えたものです（[§2.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#21-logical-types)）。表示用の型名 `sourceType`（`DECIMAL(12,2)` など）と `readOnly` も付けられます。行は列ごとに 1 つの値を持つ配列で、値は型付きの JSON で書きます（[§2.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#22-values-in-json)）。値がないときは `null` です。

| 型 | メンバー | `rows` での値 |
| --- | --- | --- |
| `boolean` | | `true` |
| `integer` | | `42`（32 ビット） |
| `bigint` | | `42`。2^53 − 1 を超えるときは `"9223372036854775807"` |
| `decimal` | `precision`、`scale` | `"12.50"`：小数点以下がちょうど `scale` 桁の文字列 |
| `float` | `bits`（32 か 64） | `0.1`、または `"NaN"`、`"Infinity"`、`"-Infinity"` |
| `string` | | `"Tokyo"` |
| `date` | | `"2026-01-31"` |
| `time` | | `"12:30:00"`、`"01:02:03.25"` |
| `timestamp` | `unit`（`s`、`ms`、`us`、`ns`） | `"2026-01-31 12:30:00.5"` |
| `timestamptz` | | `"2026-01-31 03:00:00+00"`（UTC） |
| `interval` | | `"01:30:00"`、`"1 year 2 months"` |
| `uuid` | | 小文字の 16 進数で `8-4-4-4-12` |
| `binary` | | base64 |

- **行はコピーされません。** エンジンは渡された配列をそのまま読むので、あとから変更しないでください。100 万行の表を開くのにかかるのは 4 ms ほどで、値は要求が初めて読むときに確かめます。
- §2 に従わない表は開けません。`load_failed` と、問題の値を指す JSON Pointer が返ります。
- `bits: 32` の `float` は、32 ビットの数にしておく必要があります（`0.1` ではなく `Math.fround(0.1)`）。

## Arrow の表

表には、Arrow の IPC ストリームかファイルのバイト列も使えます。Flechette や Apache Arrow の `tableToIPC` が書き出すもので、レコードバッチはいくつあってもかまいません。

```ts
const response = await fetch("/orders.arrow");
const engine = memoryEngine({
  tables: { orders: { arrow: new Uint8Array(await response.arrayBuffer()) } },
});
```

列の型は、Arrow の型に対応する論理型になります。エンジンは列を Arrow のまま、コピーせずに持ちます。数・日付・時刻は型付き配列で持ち、並べ替えはそれを直接読みます。整数・浮動小数点数・日付・十進数・タイムスタンプ・文字列の 100 万行は、行で渡すと 494 MB のところ Arrow では 258 MB です。日付・十進数・タイムスタンプでの並べ替えも、170〜250 ms が 50〜70 ms になります（[エンジンの README](https://github.com/yhay81/vastgrid/blob/main/packages/js/README.md) の数値です）。論理型のない Arrow の型（リストや構造体）や、同じ名前の列が 2 つある表は `load_failed` になります。

## 編集

`editable: true` にすると、グリッドが表のセルに書き込めます（[セルの編集](/ja/guides/editing/)）。書き込んだ値は渡された行とは別に持つので、元の行は変わりません。以後の並べ替え・絞り込み・書き出しには、書き込んだ値が反映されます。メモリエンジンは保存をしません。書き込んだセルはエンジンがある間だけ残るので、残したいときは書き出してください。

## エンジンができること

エンジンは、自分が評価できるものをケイパビリティとして伝えます（[§4.10](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#410-capabilities)）。グリッドが出す機能はその範囲に限られます。メモリエンジンのケイパビリティは、`vastgrid-js` の `MEMORY_CAPABILITIES` にあります。

| ケイパビリティ | メモリエンジン |
| --- | --- |
| `plan` | すべてのメンバー：`derive`、`where`、`aggregate`、`pivot`、`having`、`sort`、`search` |
| `functions`、`measures` | 仕様にあるすべての関数と集計 |
| `summarize`、`find`、`locate` | あり |
| `write` | `editable: true` の表だけ |
| `save` | なし |
| `export` | CSV・TSV・JSON・xlsx を `data` で：バイト列が返り、グリッドがダウンロードさせます |
| `preview`、`partialViews` | なし |
| `changes` | `"poll"`：エンジンはイベントを送りません |

## どれくらいの大きさまで

2026-10-24 に Apple M2 Pro の Chromium 156 で、100 万行 × 8 列の表を使って計測しました（[react.md の付録 A.2](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#a2-in-the-browser)）。

| | エンジンをページで | エンジンを Web Worker で |
| --- | ---: | ---: |
| マウントから最初の行が出るまで | 43〜49 ms | 36〜49 ms |
| 浮動小数点数の列で並べ替え、結果が出るまで | 85〜98 ms | 112〜113 ms |
| その間のページの最長タスク | 81〜93 ms | なし |
| ページの JavaScript ヒープ | 202 MB | 10 MB |

ページの中でも 100 万行は扱えますが、並べ替えのたびにページが 0.1 秒ほど止まり、表はページのヒープに載ります。もっと大きな表や、並べ替えの間もページを止めたくないときは、エンジンを Web Worker で動かしてください（[ブラウザーで開く大きなファイル](/ja/guides/browser/)）。タブに収まらないデータはサーバーに置きます（[サーバーのファイル](/ja/guides/server/)）。

## データが変わるとき

エンジンは、渡された行のその後の変更を知りません。新しいデータを表示するには、新しいエンジンとそのトランスポートを作ります。トランスポートか `table` が変わると、グリッドは新しいストアを作り、表を開き直します。

トランスポートはレンダーのたびではなく、データごとに 1 回作ってください。コンポーネントの外で作るか、`useMemo` を使います。ドキュメント（並べ替え・絞り込み・グループ・列の幅や書式）はストアが持っているので、引き継ぐには外に置いておきます。

```tsx
import { useMemo, useState } from "react";
import { DataGrid, type GridDocument, localTransport } from "vastgrid";
import { type MemoryTable, memoryEngine } from "vastgrid-js";

export function Orders({ orders }: { orders: MemoryTable }) {
  const transport = useMemo(() => localTransport(memoryEngine({ tables: { orders } })), [orders]);
  const [doc, setDoc] = useState<GridDocument>();
  return (
    <DataGrid
      transport={transport}
      table="orders"
      defaultDocument={doc}
      onDocumentChange={setDoc}
      style={{ height: 480 }}
    />
  );
}
```

新しいストアは、直前のドキュメントから始まります。ドキュメントは列を名前で指し、新しい表に合わせて直されます（[§5.5](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#55-repairing-a-document-for-a-table)）。なくなった列での並べ替えや絞り込みは外れます。ドキュメントを常に自分の状態として持ちたいとき（URL に入れるなど）は、代わりに `document` と `onDocumentChange` で制御してください（[状態](/ja/guides/state/)）。

## デモの表

[デモ](/ja/demo/)の表もこの方法で作っています。[site/src/data/orders.ts](https://github.com/yhay81/vastgrid/blob/main/site/src/data/orders.ts) が 13 列（整数・タイムスタンプ・文字列・十進数・真偽値）の型付き JSON の行を作り、`memoryEngine` に渡しています。
