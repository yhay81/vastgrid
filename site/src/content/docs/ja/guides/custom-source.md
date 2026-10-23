---
title: 自作の TableSource
description: TableSource のインターフェースを実装して、グリッドをどんなエンジンにもつなげます。
---

グリッドは、すべてを `TableSource` を通して読みます。`ArraySource` と `RemoteSource` はその 2 つで、「どんな列があり、何行あり、この行の値は何か」に答えられるものなら、3 つ目にできます。DuckDB-WASM を動かす Web Worker、自前の API の裏にあるデータベース、IndexedDB、あるいは関数でもかまいません。

## いちばん小さいソース

必須のメソッドは `info`、`createView`、`readRows` の 3 つです。デモの 10 億行の表がその例で、何も保存せず、グリッドが読むときに各セルを計算します。

```ts
import type { CellValue, RowBlock, RowRequest, TableInfo, TableSource, ViewInfo } from "vastgrid";

export class ComputedSource implements TableSource {
  readonly rowCount = 1_000_000_000;

  async info(): Promise<TableInfo> {
    return {
      columns: [
        { name: "row", type: "bigint" },
        { name: "square_root", type: "float" },
      ],
      rowCount: this.rowCount,
      readableRows: this.rowCount,
      status: "ready",
      capabilities: {
        sort: false,
        filter: false,
        search: false,
        stats: false,
        distinct: false,
        aggregate: false,
        find: false,
        export: false,
      },
    };
  }

  async createView(): Promise<ViewInfo> {
    // 並べ替えも絞り込みもできないので、グリッドは元の表だけを求める。
    return { id: null, rowCount: this.rowCount, query: {} };
  }

  async readRows({ start, end, columns }: RowRequest): Promise<RowBlock> {
    end = Math.min(end, this.rowCount);
    const values = columns.map((column) => {
      const list: CellValue[] = [];
      for (let row = start; row < end; row++) list.push(column === 0 ? row + 1 : Math.sqrt(row + 1));
      return list;
    });
    return { start, end, columns: values };
  }
}
```

[デモで使っているもの](https://github.com/yhay81/vastgrid/blob/main/site/src/data/computed.ts)には、日時・文字列・数値・空白の 8 列があります。グリッドは画面に見えている所の周りを 256 行 × 48 列のまとまりで読むので、その重さは行の数によりません。

## グリッドが求めること

- **`info(signal?)`** は表を開き、列、大きさ、できることを返します。`status` が `"loading"` の間、グリッドはこれを繰り返し呼び、`readableRows` より前の行だけを読みます。これで、残りを読み込む間に表の先頭を見せられます。`rowCount` は、分かるまで `null` でもかまいません。`"error"` のときは、理由を `error` に入れます。
- **`createView(query, signal?)`** は並べ替え・絞り込み・検索を適用します。空のクエリー（元の順番の表）には `id: null` を、それ以外には好きな ID を返します。グリッドはその ID を、ほかの要求の `view` として渡します。グリッドはクエリーが変わるたびに新しいビューを作り、古いものは使わなくなるので、最近のビューをいくつか残しておけば十分です（`ArraySource` は 4 つ残します）。
- **`readRows(request, signal?)`** は、ビューの `start` 行目から `end` 行目の手前までの値を、要求された列ごとに 1 つの配列で、`request.columns` の順に返します。列はグリッドでの表示の位置ではなく、`info` のスキーマでの番号なので、グリッドで列を隠したり動かしたりしても変わりません。ビューでは、`rowIds` に元の表での行の位置を入れます。行見出しにはこれが表示されます。
- `request.textLimit` より長い文字列は、切って末尾を `…` にしてかまいません。コピーと「値の全体を表示」では、値の全体を読むために `MAX_TEXT_LIMIT` を求めます。

## 任意のメソッド

任意のメソッドは、それぞれ 1 つの機能を有効にします。`info` でも、対応する capability を `true` にしてください。

| メソッド | capability | 機能 |
| --- | --- | --- |
| `createView` の `sort` | `sort` | 1 つ以上の列での並べ替え。 |
| `createView` の `filters` | `filter` | 値と条件での絞り込み。 |
| `createView` の `search` | `search` | 検索欄。すべての列から絞り込みます。 |
| `columnStats(view, column, signal?)` | `stats` | 列の統計。空白の数、値の種類の数、最小、最大、四分位、分布、多い値。 |
| `distinctValues(request, signal?)` | `distinct` | 絞り込みのパネルの、検索できる値の一覧。 |
| `aggregate(request, signal?)` | `aggregate` | ステータスバーに出す、選択範囲のデータの個数・合計・平均・最小・最大。 |
| `find(request, signal?)` | `find` | 検索（⌘/Ctrl ＋ F）。指定した文字列を含む次のセルを探します。 |
| `exportView(request, signal?)` | `export` | ビューをファイルに書き出します。アプリから呼びます。 |
| `close()` | | 表を解放します。アプリがそのソースを使わなくなったときに呼びます。グリッドは呼びません。 |

要求と結果の型は、すべて [`TableSource` のリファレンス](/ja/reference/table-source/)にあります。

## 取り消しとエラー

- どのメソッドも `AbortSignal` を受け取ります。グリッドは、遠くへスクロールした行の要求や、新しいクエリーに置き換わったビューの要求を中止します。中止されたら処理を止め、`AbortError` で reject してください（`abortError()` で作れます）。
- 問題を伝えるには、`SourceError(code, message, status)` で reject します。グリッドはそのメッセージを表示します。`ErrorCodes` には、グリッドと `RemoteSource` が対応するコード（`view_not_found` など）があります。
- 値は `CellValue`（`string | number | boolean | null`）です。JavaScript の数値では正確に表せない数、たとえば 64 ビットの整数や小数は、文字列で送ってください。

## 代わりにプロトコルを実装する

Node.js ではないサーバーから表を配信するには、そのサーバーに[表のプロトコル](/ja/reference/protocol/)を実装し、ブラウザーでは `RemoteSource` を使います。要求は `vastgrid-core` の `parseProtocolRequest` で検証できます。`vastgrid-duckdb` の受け口は、見比べられる完全な実装です。
