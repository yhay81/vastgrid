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
| `reloadKey` | `unknown` | | 値を変えると表を読み直します。ディスク上のファイルが変わったときなどに使います。変更を通知する source（`subscribe`）は自動で読み直されます。どちらの場合も、クエリー・列の設定・スクロール位置・アクティブなセルはそのままです。 |
| `followTail` | `boolean` | `false` | 表が変わったとき、それまで最後の行を表示していれば新しい末尾を表示します（`tail -f` のように追記された行を追います）。 |
| `copyLimit` | `number` | `1000000` | 一度にコピーできるセルの数（選択したすべての範囲の合計）。 |
| `columnFormats` | `Record<string, ColumnFormat>` | | スキーマの列名ごとの表示設定。表示名、数値と日時の書式、配置、整形関数。 |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | コピーするのを、値とスキーマの列名にするか、表示している文字と表示名にするか。 |
| `onQueryChange` | `(query: ViewQuery) => void` | | 並べ替え・絞り込み・検索が変わったときに呼ばれます。 |
| `onSelectionChange` | `(event: GridSelectionEvent) => void` | | 選択範囲かアクティブなセルが変わったときに呼ばれます。[イベント](#イベント)を参照してください。 |
| `onColumnsChange` | `(event: GridColumnsEvent) => void` | | 列の幅・順序・表示・固定が変わったときに呼ばれます。 |
| `onCellClick` | `(event: GridCellEvent) => void` | | セルをクリックしたとき、またはアクティブなセルで Space を押したときに呼ばれます。 |
| `onCellDoubleClick` | `(event: GridCellEvent) => void` | | セルをダブルクリックしたとき、または F2 を押したときに呼ばれます。`event.preventDefault()` でセルの詳細を開かないようにできます。 |
| `initialState` | `GridState` | | グリッドを作るときに、表の列がわかった時点で適用する設定。[設定の保存](#設定の保存)を参照してください。 |
| `onStateChange` | `(state: GridState) => void` | | クエリーか列の設定が変わったときに、その設定を渡して呼ばれます。 |
| `detailOpen` | `boolean` | | [詳細パネル](#詳細パネル)を開きます（制御する値）。指定しなければグリッドが状態を持ちます。 |
| `defaultDetailOpen` | `boolean` | `false` | `detailOpen` を指定しないときに、マウントした時点で詳細パネルを開くかどうか。 |
| `onDetailOpenChange` | `(open: boolean) => void` | | 利用者か handle が詳細パネルを開閉したときに呼ばれます。 |
| `detailPanel` | `ComponentType<DetailPanelProps>` | `DetailFields` | 詳細パネルの中身を差し替えます。 |
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
| `getState()` | クエリーと列の設定。保存用の `GridState` です。 |
| `applyState(state)` | 保存した `GridState` を適用します。このバージョンで読めない値なら `false` を返します。 |
| `goToRow(row)` | 現在のビューのその行までスクロールし、アクティブにします。 |
| `openDetail({ focus })` | 詳細パネルを開きます。`focus: true` ならフォーカスをパネルに移します。 |
| `closeDetail()` | 詳細パネルを閉じます。 |
| `detailOpen` | 詳細パネルが開いているかどうか。 |
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

## イベント

イベントの props は、利用者による変更とアプリによる変更（`setQuery`、`applyState`）を、1 回の変更につき 1 回知らせます。スクロール・マウスの移動・描画では呼ばれません。React を使わない場合は、`controller.onSelectionChange`、`onColumnsChange`、`onStateChange` で同じイベントを受け取れます。いずれも登録を解除する関数を返します。

セルの位置は、次の 3 種類で表します。

| 項目 | 意味 |
| --- | --- |
| `row` | 現在のビューでの位置（0 から）。並べ替えと絞り込みのあとの、表示されている行です。 |
| `rowId` | 元の表での位置（0 から）。並べ替えも絞り込みもなければ `row` と同じです。ビューでは行と一緒に届くので、その行を読み込むまでは `null` で、届いたときに `onSelectionChange` がもう一度呼ばれます。 |
| `col` | 表示されている列の中での位置（表示順）。列を動かしたり隠したりすると変わります。 |
| `column` | 表の列（`TableInfo.columns`）の番号で、`ViewQuery` と同じものです。列を動かしたり隠したりしても変わりません。 |

- `GridSelectionEvent`：`active` はアクティブなセル（`row`、`rowId`、`col`、`column`）、`ranges` は選択範囲の一覧です。範囲ごとに `top`、`bottom`、`left`、`right`（両端を含む、ビューの行と表示中の列の位置）、`columns`（その列の表の番号）、列全体・行全体の選択を表す `allRows`・`allCols` があります。表の列が初めて届いたとき（アクティブなセルに列ができたとき）、新しいビューでアクティブなセルが先頭の行に移ったとき、列を動かしたり隠したりしてアクティブなセルの列が変わったときにも呼ばれます。
- `GridColumnsEvent`：`reason`（`"resize"`、`"move"`、`"visibility"`、`"freeze"`、状態を適用したときの `"state"`、表を読み直して列が変わったときの `"schema"`）、`columns`（全列を表示順に。`column`、`name`、`col`（隠した列は -1）、`width`、`hidden`、`sized`、`frozen`）、`frozenColumns` です。列の端をドラッグしたときは、ドラッグを終えたときに 1 回だけ知らせます。グリッドが自動で合わせた幅は知らせません。
- `GridCellEvent`：セルの位置、読み込み済みの値 `value`（読み込む前は `undefined`）、`trigger`（`"pointer"` か `"keyboard"`）、修飾キー、`preventDefault()` です。クリックは、同じセルで押して離したときです。DOM と同じく、ダブルクリックの前にはクリックが 2 回届きます。アクティブなセルでの Space は、`onCellClick` があるときだけクリックとして扱います（ないときはこれまでどおりブラウザーに任せます）。F2 はダブルクリックとして扱います。

```tsx
<DataGrid
  source={source}
  onSelectionChange={({ active }) => setDetail(active.rowId)}
  onCellDoubleClick={(event) => {
    event.preventDefault(); // セルの詳細の代わりに
    openRecord(event.rowId);
  }}
/>
```

## 設定の保存

`getState()` は、グリッドの設定を JSON で返します。クエリーと、列の順序・利用者が決めた幅・表示・固定です。選択範囲とスクロール位置は含みません（残すときは `onSelectionChange` と `goToRow` を使ってください）。保存先はアプリが決めます。

```tsx
function read(text: string | null) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

// ファイルごとに localStorage へ:
<DataGrid
  source={source}
  initialState={read(localStorage.getItem(`grid:${file}`))}
  onStateChange={(state) => localStorage.setItem(`grid:${file}`, JSON.stringify(state))}
/>;

// URL に入れて、リンクから同じ表示を開けるようにする:
<DataGrid
  source={source}
  initialState={read(new URLSearchParams(location.search).get("grid"))}
  onStateChange={(state) => {
    const url = new URL(location.href);
    url.searchParams.set("grid", JSON.stringify(state));
    history.replaceState(null, "", url);
  }}
/>;
```

```json
{
  "version": 1,
  "schema": ["id", "name", "price"],
  "query": { "sort": [{ "column": 2, "direction": "desc" }] },
  "columns": [{ "name": "name", "width": 220 }, { "name": "id", "hidden": true }, { "name": "price" }],
  "frozenColumns": 1
}
```

- 列は名前で覚えます。`schema` は保存したときの列名の一覧で、クエリーの列の番号はこれを指します。適用するときは、名前で表の列に対応させます。同じ名前の列が複数あるときは、n 番目どうしを対応させます。
- 状態に載っていない表の列（あとからファイルに足された列など）は、今の設定のまま、載っている列のあとに並びます。表にもうない列・並べ替えのキー・絞り込みは捨てます。固定していた列がなくなっても、ほかの列を代わりに固定しません。少なくとも 1 列は表示したままにします。
- 幅は、利用者が決めた列だけ保存します。それ以外の列は、値に合わせてもう一度幅を決めます。
- `version` 以外の項目はどれも省略できます。状態を適用すると、含まれている項目だけを変えます。`onQueryChange` や `getQuery()` で保存した `ViewQuery` も、そのクエリーを持つ状態として読みます。
- `applyState`（と `initialState`）は表を読み込む前でも使えます。状態は列がわかるまで、クエリーは表の準備ができるまで待ってから適用します。その間に `setQuery` で設定したクエリーは、状態のクエリーより優先します。
- 保存先から読んだ値は検査します。正しくない項目は除き、このパッケージより新しい `version` の状態は受け付けません（`applyState` は `false` を返します）。`vastgrid-core` の `parseGridState(value)` で、検査だけを行えます。今後の版では、設定を省略できる項目として足していき、既存の項目の意味が変わるときだけ `version` を上げて、古い状態を変換します。

`onStateChange` は、`initialState` を含め、状態を適用したときにも呼ばれます。

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

## 詳細パネル

詳細パネルは、アクティブな行のレコード全体を固定の位置に表示します。グリッドの横に、グリッドの幅が 640px より狭いときは下に表示します。行の高さは変わらないので、スクロール、`goToRow`、固定列はパネルがないときと同じく動きます。`detailOpen`（制御する値。`onDetailOpenChange` と組み合わせます）、`defaultDetailOpen`、handle の `openDetail({ focus })` と `closeDetail()`、Alt ＋ Enter、セルのメニューの「行の詳細を表示」で開閉します。

標準の中身（`DetailFields`）は、すべての列を表示の順に並べ、`columnFormats` の表示名と書式付きの値を表示します。隠した列には「非表示」と付けます。表の中で途中まで表示している値は、全体を読み込みます。

**表示する行。** パネルはアクティブなセル（`onSelectionChange` の `active`）に追従します。

- 別の行へ移ると、その行を表示します。同じ行の中で動いたときや、列の移動・非表示・固定・書式の変更では、表示しているレコードを保ちます。
- 値は読み込み済みの行から取ります。読み込んでいない列と、source が途中で切った文字列（末尾が「…」）は、その行だけを 120 ms 待ってから全体を読み込みます。読み込む前や読み込み中に別の行へ移ると取り消すので、素早く行を移ったときに読み込むのは止まった行だけです。
- 新しいビュー（並べ替え・絞り込み・検索）では先頭の行がアクティブになり、パネルはその行を表示します。タイトルには元の表での行も表示します。
- 表を読み直したとき、表が変わっていなければレコードを保ちます。変わっていれば先頭の行からやり直し、パネルはその行を表示します。
- 行がないときは、そのことを表示します。

**キー操作とフォーカス。** グリッドで Alt ＋ Enter を押すとパネルが開き、フォーカスはグリッドに残るので、矢印で行を移り続けられます。もう一度 Alt ＋ Enter を押すと、フォーカスがパネルに移ります。パネルでは Esc で閉じ、Alt ＋ Enter でグリッドに戻ります。どちらもフォーカスをグリッドに戻します。グリッドの Esc も、ほかに閉じるものがなければパネルを閉じます。パネルはタイトルを名前にした補足のランドマーク（`<aside>`）で、値を読み込んでいる間は `aria-busy` になります。

**読み込みの失敗。** 行を読み込めなかったときは、エラーと「再試行」ボタンを表示し（独自の中身では `retry()`）、それまでの値を残します。

**中身の差し替え。** `detailPanel` に、`DetailPanelProps` を受け取るコンポーネントを渡します。

| prop | 型 | 説明 |
| --- | --- | --- |
| `row` | `number` | 現在のビューでの行。 |
| `rowId` | `number \| null` | 元の表での行。ビューの行が読み込まれるまでは `null`。 |
| `values` | `(CellValue \| undefined)[]` | スキーマの列の番号ごとの値（全体）。読み込み中は `undefined`。 |
| `schema` | `ColumnSchema[]` | 表の列。 |
| `status` | `"loading" \| "ready" \| "error"` | 値を読み込み中・読み込み済み・失敗。 |
| `error` | `string \| null` | 読み込みに失敗した理由。 |
| `fields` | `DetailField[]` | 表示の順のすべての列。`column`、`name`、`label`、`hidden`、`value` と表示上の `text`。 |
| `retry()` | | 行を読み込み直します。 |
| `messages` | `Messages` | グリッドの文言。 |

```tsx
import { DataGrid, type DetailPanelProps } from "vastgrid";

function Order({ fields, status, rowId }: DetailPanelProps) {
  return (
    <article aria-busy={status === "loading"}>
      <h3>注文 {rowId === null ? "" : rowId + 1}</h3>
      {fields
        .filter((field) => !field.hidden)
        .map((field) => (
          <p key={field.column}>
            <strong>{field.label}</strong> {field.text}
          </p>
        ))}
    </article>
  );
}

<DataGrid source={source} defaultDetailOpen detailPanel={Order} />;
```

パネルの大きさは `--vg-detail-width`（340px）と `--vg-detail-height`（45%）で変えられます。`DetailTracker` は `GridController` のアクティブな行に追従してレコードを React の外で読み込むので、詳細をほかの場所に表示するアプリで使えます。

## エクスポート

`vastgrid` は `vastgrid-core` のもの（`ArraySource`、`RemoteSource`、型、補助の関数）をすべて再エクスポートするので、ほとんどのアプリは `vastgrid` だけをインストールすれば済みます。ほかに次のものもエクスポートします。

| エクスポート | 説明 |
| --- | --- |
| `DataGrid`、`DataGridProps`、`DataGridHandle` | コンポーネントと、その props と ref の型。 |
| `DetailPanelProps`、`DetailField`、`DetailFields`、`DetailTracker`、`DetailRecord`、`DetailStatus`、`detailKeyAction` | [詳細パネル](#詳細パネル)。独自の中身の props、標準の中身、React の外でのレコード。 |
| `GridCell`、`GridCellEvent`、`GridSelectionEvent`、`GridSelectionRange`、`GridColumnsEvent`、`GridColumn`、`GridColumnsChangeReason` | [イベント](#イベント)の型。 |
| `GridState`、`GridColumnSetting`、`parseGridState(value)`、`resolveGridState(state, names)`、`GRID_STATE_VERSION` | `vastgrid-core` の、[保存する設定](#設定の保存)。 |
| `en`、`ja`、`Messages`、`messagesFor(locale)` | 組み込みの文言と、ロケールに合わせてグリッドが選ぶ組。 |
| `GridController`、`CanvasRenderer` | グリッドの状態とキャンバスの描画。ref から使います。 |
| `GridOptions`、`ColumnState`、`Hit`、`HitZone` | コントローラーの設定、列の状態、当たり判定の型。 |
| `resolveTheme(element)`、`GridTheme` | キャンバスが要素の CSS 変数から読む、色と文字の設定。 |
| `CopyTooLargeError` | `copyLimit` を超えるセルをコピーしようとしたときに投げられます。 |
| `CopyRangesError` | 行も列も同じでない複数の範囲をコピーしようとしたときに投げられます。 |
