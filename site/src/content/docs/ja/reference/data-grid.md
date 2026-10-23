---
title: DataGrid
description: DataGrid の props と、ref のメソッド。
---

```tsx
import { DataGrid } from "vastgrid";
import "vastgrid/styles.css";
```

`DataGrid` は親の要素いっぱいに広がるので、親に高さが必要です。`vastgrid/styles.css` は、アプリで 1 回だけ読み込んでください。

## props

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `source` | `TableSource` | （必須） | 表示する表。別のソースを渡すと、グリッドを最初から作り直します。 |
| `locale` | `string` | ブラウザーの言語 | 数値と組み込みの文言のロケール。`ja` なら日本語、それ以外は英語です。 |
| `messages` | `Partial<Messages>` | | 組み込みの文言の一部を置き換えます（`en` と `ja` を参照）。 |
| `rowHeight` | `number` | `--vg-row-height` か 24 | 行の高さ（px）。 |
| `headerHeight` | `number` | `--vg-header-height` か 32 | 見出しの高さ（px）。 |
| `nullText` | `string` | `""` | null のセルに表示する文字。 |
| `frozenColumns` | `number` | `0` | 表を開いたときに左に固定する列の数。 |
| `toolbar` | `boolean` | `true` | 検索欄、適用中の絞り込み、行数を表示します。 |
| `statusBar` | `boolean` | `true` | アクティブなセルと選択範囲の集計を表示します。 |
| `reloadKey` | `unknown` | | 値を変えると表を読み直します。ディスク上のファイルが変わったときなどに使います。 |
| `copyLimit` | `number` | `1000000` | 一度にコピーできるセルの数。 |
| `onQueryChange` | `(query: ViewQuery) => void` | | 並べ替え・絞り込み・検索が変わったときに呼ばれます。 |
| `className`、`style` | | | ルートの要素（`.vg-root`）に付けます。 |
| `aria-label` | `string` | `messages.gridLabel` | スクリーンリーダー向けのグリッドの名前。 |

## ref

ref からは `DataGridHandle` を使えます。

| メンバー | 説明 |
| --- | --- |
| `focus()` | キーボードのフォーカスをグリッドに移します。 |
| `reload()` | `reloadKey` を変えたときと同じように、表を読み直します。 |
| `getQuery()` | 現在の `ViewQuery`（並べ替え・絞り込み・検索）。 |
| `setQuery(query)` | `ViewQuery` を適用し、現在のものを置き換えます。表の準備ができる前に呼ぶと、準備ができたときに適用します。 |
| `goToRow(row)` | 現在のビューのその行までスクロールし、アクティブにします。 |
| `controller` | グリッドの状態（選択範囲、列の配置、ビュー）を持つ `GridController`。 |
| `renderer` | `CanvasRenderer`。`renderer.timings()` などの診断に使います。グリッドがマウントされるまでは `null`。 |

```tsx
import { DataGrid, type DataGridHandle } from "vastgrid";
import { useRef } from "react";

const grid = useRef<DataGridHandle>(null);

<DataGrid ref={grid} source={source} onQueryChange={(query) => saveQuery(query)} />;

// 3 列目の大きい順に並べ、"Tokyo" を含む行だけを表示する。
grid.current?.setQuery({ sort: [{ column: 2, direction: "desc" }], search: "Tokyo" });
```

クエリーの列は、表示の位置ではなく表の列（`TableInfo.columns`）の番号なので、保存したクエリーは、列を動かしたり隠したりしたあとも同じ意味を持ちます。絞り込みの書き方は [`ViewQuery`](/ja/reference/table-source/#viewquery) を参照してください。

`renderer.timings()` は、直近に描いた 120 フレームについて `{ frames, average, slowest }`（時間はミリ秒）を返します。[デモ](/ja/demo/)では、これをツールバーに表示しています。

## エクスポート

`vastgrid` は `vastgrid-core` のもの（`ArraySource`、`RemoteSource`、型、補助の関数）をすべて再エクスポートするので、ほとんどのアプリは `vastgrid` だけをインストールすれば済みます。ほかに次のものもエクスポートします。

| エクスポート | 説明 |
| --- | --- |
| `DataGrid`、`DataGridProps`、`DataGridHandle` | コンポーネントと、その props と ref の型。 |
| `en`、`ja`、`Messages`、`messagesFor(locale)` | 組み込みの文言と、ロケールに合わせてグリッドが選ぶ組。 |
| `GridController`、`CanvasRenderer` | グリッドの状態とキャンバスの描画。ref から使います。 |
| `GridOptions`、`ColumnState`、`Hit`、`HitZone` | コントローラーの設定、列の状態、当たり判定の型。 |
| `resolveTheme(element)`、`GridTheme` | キャンバスが要素の CSS 変数から読む、色と文字の設定。 |
| `CopyTooLargeError` | `copyLimit` を超えるセルをコピーしようとしたときに投げられます。 |
