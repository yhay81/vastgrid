---
title: v1 からの移行
description: vastgrid 0.x（v1）から vastgrid 2 で何が変わったかと、移行ガイドの全文のありか。
---

vastgrid 2 は、書かれた仕様の上にグリッドを作り直したものです。v1 の機能のほとんどがありますが、API は別のものです。このページは変わったことを並べます。GitHub の[移行ガイドの全文](https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md)（英語）は、v1 の機能のそれぞれを v2 に対応させ、互換性のない変更を詳しく書いています。

## パッケージ

| v1 | vastgrid 2 |
| --- | --- |
| `vastgrid`（React 18 以降） | `vastgrid`。React 19.3 以降が必要。`vastgrid/core` に React を使わないストアとトランスポートがある |
| `vastgrid-core` | なくなった。その部品は `vastgrid/core` と `vastgrid-spec` にある |
| v1 のメモリー上のソース | [`vastgrid-js`](/ja/guides/in-memory/) の `memoryEngine` |
| `vastgrid-browser` | なくなった。`vastgrid-js` が[Web Worker の中で](/ja/guides/browser/)ファイルと Parquet の URL を読む |
| `vastgrid-duckdb`：`TableEngine`、`createTableHandler` | `vastgrid-duckdb`：`DuckDBEngine`、`createHttpHandler`（[サーバーのファイル](/ja/guides/server/)を参照） |

## グリッドはトランスポートを受け取る

v1 のグリッドは `source` プロパティでソースのオブジェクトを受け取りました。v2 のグリッドは、エンジンへのトランスポートとテーブルの名前か、`useCreateGridStore` で作ったストアを受け取ります。

```tsx
import { DataGrid, localTransport } from "vastgrid";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders: { columns, rows } } }));

<DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
```

列は仕様の論理型を持ち、値は型の付いた JSON です。小数と大きな整数は、桁を失わないよう文字列です。v1 のリモートのソースとそのテーブルサーバーは、`httpTransport` と DuckDB エンジンの HTTP ハンドラーになり、v2 の電文で話します。

## 状態はドキュメント・セッション・コマンド

v1 がコントローラーに持ち、ref のメソッドとイベントで渡していたものは、いまは素の JSON です。**ドキュメント**（ビューとその列：並べ替え・絞り込み・グループ・数式・幅・固定・書式）と、**セッション**（選択・スクロールの位置・チェックした行・元に戻す履歴）です。どちらも `document` と `onDocumentChange`、`session` と `onSessionChange` で制御できます。変更はすべて型の付いたコマンドで、グリッドのメニューと同じようにコードからディスパッチします。ref が渡すのは `{ store, dispatch, focus }` だけです。[ドキュメント・セッション・コマンド](/ja/guides/state/)を参照してください。

v1 で保存した `GridState` は、`vastgrid-spec` の `migrateGridState` に表の列を渡すと、ドキュメントに移せます。

```ts
import { migrateGridState } from "vastgrid-spec";

// columns: the table's columns, as the engine reports them (snapshot.table.columns once it is open)
const { document, dropped, reasons } = migrateGridState(savedState, columns);
// <DataGrid … defaultDocument={document} />
```

`dropped` は移せなかったものを v1 の状態の中の JSON Pointer で並べ、`reasons` はその理由を示します。左右に固定した列は `pin: "left"` と `pin: "right"` に、グループはプランの `aggregate` になります（[仕様の §5.6](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#56-versions-and-migration)）。

## 数式

v1 の数式の言語は v2 でもコンパイルでき、v1 の関数はすべてあります。数式はプランの派生列になります。v1 はすべての数値を 64 ビットの浮動小数点数で計算しましたが、v2 は小数を正確に保ち、値を DuckDB の文字列の形で書くので、いくつかの数式は別の結果になります（`ROUND(0.285, 2)` は `0.28` ではなく `0.29`）。[数式の列](/ja/guides/formulas/)と [§4.11](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#411-formulas) にその一覧があります。

## v2 にないもの

- 行のツリー。v1 にもありませんでした。列に階層を持つデータは、いくつかのキーでグループ化します。
- いくつかの列の幅を一度に変えること。列ごとに幅を変えるか、列のメニューから値に合わせます。

[移行ガイドの全文](https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md)（英語）には、すべての機能と互換性のない変更、それぞれにすることが書いてあります。
