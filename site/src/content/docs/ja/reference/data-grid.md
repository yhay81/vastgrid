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
| `columnFormats` | `Record<string, ColumnFormat>` | | スキーマの列名ごとの表示設定。表示名、数値と日時の書式、配置、整形関数。 |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | コピーするのを、値とスキーマの列名にするか、表示している文字と表示名にするか。 |
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

## 列の表示設定

`columnFormats` で、スキーマの列名（`ColumnSchema.name`）ごとに列の見え方を設定します。設定のない列の見え方は変わりません。

```tsx
import { type ColumnFormat, DataGrid } from "vastgrid";

// コンポーネントの外に置くか、メモ化してください。新しいオブジェクトは比べ直し、新しい関数は列を描き直します。
const formats: Record<string, ColumnFormat> = {
  price: { label: "価格", number: { style: "currency", currency: "JPY" } },
  cost: { label: "原価", number: { style: "currency", currency: "USD", fractionDigits: 0 } },
  share: { number: { style: "percent", fractionDigits: 1 } },
  weight: { number: { maximumFractionDigits: 2, suffix: " kg" } },
  ordered_at: { label: "注文日時", date: { pattern: "yyyy年M月d日(EEE) HH:mm" } },
  shipped_at: { date: { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" } },
  status: { align: "center", format: (value, { text }) => (value === "ok" ? "✓" : text) },
};

<DataGrid source={source} columnFormats={formats} />;
```

| 設定 | 説明 |
| --- | --- |
| `label` | 見出し・メニュー・パネル・ステータスバーで、スキーマの列名の代わりに表示する名前。 |
| `number` | 数値と数値の文字列の書式。`style`（`decimal`、`percent`、`currency` と `currency`）、`currencyDisplay`、`fractionDigits`（または `minimumFractionDigits` と `maximumFractionDigits`）、`grouping`、`notation`、`signDisplay`、`prefix` と `suffix`。数値でない文字列はそのまま表示します。 |
| `date` | 日付と時刻の書式。`pattern`、または `Intl.DateTimeFormat` のオプション（`dateStyle`、`timeStyle`、`year`、`month`、`day`、`hour` など）。`timeZone` は、オフセットのある値（`timestamptz`）を表示するタイムゾーンです。オフセットのない値はそのまま表示します。日時でない文字列はそのまま表示します。 |
| `align` | `left`、`center`、`right`。既定では数値の列が `right`。 |
| `format(value, { column, text })` | 値の表示の文字を返す関数。`text` はほかの設定で作った文字です。結果は 1 行で表示します。 |
| `copy` | `raw` か `formatted`。この列のセルについて `copyValues` を上書きします。 |

パターンでは `yyyy` `yy`（年）、`M` `MM` `MMM` `MMMM`（月）、`d` `dd`（日）、`EEE` `EEEE`（曜日）、`H` `HH`（0〜23 時）、`h` `hh` と `a`（1〜12 時と午前・午後）、`m` `mm`（分）、`s` `ss`（秒）、`S` `SS` `SSS`…（秒の小数の桁）を使います。一重引用符で囲んだ文字はそのまま残ります（`yyyy-MM-dd 'at' HH:mm`）。月と曜日の名前は `locale` に従います。

**値と表示。** 設定が変えるのは表示だけです。並べ替え、絞り込み（条件に入力する値も）、検索、表の中の検索、列の統計、選択範囲の集計、書き出しは値そのものに対して動きます。たとえばパーセントの列を「> 0.5」で絞り込むと、50% を超える値が残ります。文字列で届く 64 bit 整数や decimal は、JavaScript の数値を介さずにその桁から整形するので、`"9007199254740993"` も正確に表示されます。セルの値の表示（インスペクター）には、値と、その下に表示上の文字が出ます。

**コピー。** 既定では、コピー（TSV・HTML・Markdown）には `plainText` が書く形の値と、見出しにはスキーマの列名が入り、表計算ソフトが数値や日付として読めます。`copyValues="formatted"` にすると、表示している文字の全体（切らず、改行も残す）と表示名をコピーします。列の `copy` を指定すると、その列のセルはそちらに従います。書き出し（`exportView`）はソースが書くので、常に値とスキーマの列名が入ります。

正しくない設定（`currency` のない通貨の書式や、存在しないタイムゾーンなど）は、グリッドに渡した時点で `RangeError` を投げます。`ColumnFormatter`（`ValueFormatter.column(schema, format)` で作り、グリッドでは `controller.formatterOf(index)`）を使うと、グリッドの外でも同じ設定で値を整形でき、設定は `settings` で読めます。

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
