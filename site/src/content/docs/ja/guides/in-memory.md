---
title: メモリ上のデータ
description: すでにブラウザーにある行を ArraySource で表示します。
---

`ArraySource` は JavaScript の配列を扱う `TableSource` です。並べ替え、絞り込み、すべての列からの絞り込み、検索、列の統計、値の一覧、選択範囲の集計と、グリッドが求めることをすべて行います。CSV・TSV・JSON・Excel ファイルへの書き出しもでき、グリッドの書き出しパネルからダウンロードできます（[書き出し](/ja/guides/export/)を参照）。

```tsx
import { ArraySource, DataGrid } from "vastgrid";
import "vastgrid/styles.css";

const source = new ArraySource({
  columns: ["name", "born", "field"],
  rows: [
    ["Ada Lovelace", 1815, "Mathematics"],
    ["Grace Hopper", 1906, "Computer science"],
  ],
});

<div style={{ height: 400 }}>
  <DataGrid source={source} />
</div>;
```

## 行ごとか列ごとか

データは `rows` に行ごとに渡すか、`columnData` に列ごとに（1 列に 1 つの配列で）渡します。

```ts
const source = new ArraySource({
  columns: ["name", "born", "field"],
  columnData: [
    ["Ada Lovelace", "Grace Hopper"],
    [1815, 1906],
    ["Mathematics", "Computer science"],
  ],
});
```

`columnData` は複製せずにそのまま使うので、大きな表ではこちらのほうが軽く済みます。短い行や列の末尾で足りない値は、空白になります。

## 値と型

値は `CellValue`（`string | number | boolean | null`）です。`null` は空白のセルです。

列名だけを渡すと、`ArraySource` は各列の型を最初の 10,000 個の値から推測します。`integer`、`float`、`boolean` のどれかで、それ以外はすべて `string` です。型を自分で決めるには `ColumnSchema` を渡します。

```ts
const source = new ArraySource({
  columns: [
    { name: "order_id", type: "integer" },
    { name: "ordered_at", type: "timestamp" },
    { name: "total", type: "decimal", sourceType: "DECIMAL(12,2)" },
    { name: "paid", type: "boolean" },
  ],
  rows: [[100001, "2024-01-01 09:12:44", "19800.00", true]],
});
```

型によって、値の寄せ方、書式、並べ替え、集計が決まります。

- **数値**（`integer`、`bigint`、`float`、`decimal`）は右に寄せ、ロケールに合わせて桁を区切り、選択範囲で合計します。JavaScript の数値では正確に表せない値、たとえば 2^53 を超える 64 ビットの整数や、桁を保つ必要がある小数は、`"9007199254740993"`、`"19800.00"` のように文字列で渡してください。並べ替えと絞り込みは正確な値で行います。
- **日付と時刻**（`date`、`time`、`timestamp`、`timestamptz`）は ISO 形式の文字列（`2024-01-31`、`2024-01-31 12:34:56`）です。文字列のままで正しい順に並びます。
- **真偽値**は `TRUE` と `FALSE` で表示します。
- `sourceType` は、エンジンでの型の名前として列の統計に表示します。

デモの[注文の表](https://github.com/yhay81/vastgrid/blob/main/site/src/data/orders.ts)は、これらをすべて使っています。

## 扱える大きさ

`ArraySource` は並べ替え・絞り込み・統計の計算を画面のスレッドで行い、その間はページが反応しません。数十万行までが目安です。30 万行・13 列の表を、Apple M2 Pro の Node.js 24 で測った結果です。

| 処理 | 時間 |
| --- | ---: |
| 小数の列での並べ替え | 0.55 秒 |
| 文字列の列での並べ替え | 0.15 秒 |
| すべての列からの絞り込み | 0.13 秒 |
| 列の統計 | 0.15 秒 |

スクロールと選択の重さは、表の大きさによりません。グリッドは画面に見えている行だけを読むためです。もっと多くの行を扱うなら、[`vastgrid-duckdb`](/ja/guides/server/) でファイルを配信するか、[自作の `TableSource`](/ja/guides/custom-source/) で処理を Web Worker に移してください。

## データが変わったとき

ソースは、ある時点のデータのスナップショットです。データが変わったら、新しい `ArraySource` を作ってください。グリッドはそれで最初から作り直すので、選択範囲・並べ替え・絞り込みは元に戻ります。並べ替えと絞り込みを保つには、クエリーを保存して新しいグリッドに適用します。

```tsx
const grid = useRef<DataGridHandle>(null);
const query = useRef<ViewQuery>({});
const source = useMemo(() => new ArraySource({ columns, rows }), [rows]);

useEffect(() => {
  grid.current?.setQuery(query.current);
}, [source]);

<DataGrid ref={grid} source={source} onQueryChange={(next) => (query.current = next)} />;
```
