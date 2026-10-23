# vastgrid

[![npm](https://img.shields.io/npm/v/vastgrid)](https://www.npmjs.com/package/vastgrid)
[![CI](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/yhay81/vastgrid)](LICENSE)

数 GB・数億行の CSV・TSV・Parquet・JSON Lines を開けて、表計算ソフトのように扱える React のデータグリッドです。

**[デモを試す](https://vastgrid.yhay81.com/ja/demo/)** · [ドキュメント](https://vastgrid.yhay81.com/ja/) · [English](README.md)

[![1 億行の Parquet を絞り込み・並べ替えし、列の統計と選択範囲の集計を表示した画面](docs/images/playground.jpg)](https://vastgrid.yhay81.com/ja/demo/)

- **どんな大きさでも開ける。** 行はスクロールに合わせて、まとまりごとに読みます。1.4 GB・1 億行の Parquet は 20 ms で開き、
  735 MB の CSV は読み込みの途中でも 0.15 秒で最初の行を表示します。
- **速い。** セルはキャンバスに描きます。1,000 セル以上を表示しても 1 フレーム約 2 ms です。ブラウザーの要素の高さの上限を越えて、
  数十億行までスクロールできます。
- **表計算ソフトの操作。** マウスと Excel のキー操作での範囲の選択、コピー（TSV・HTML・Markdown）、複数の列での並べ替え、
  値の一覧（検索・件数つき）と条件での絞り込み、すべての列からの絞り込み、検索（⌘F）、列の統計、選択範囲のデータの個数・合計・平均・最小・最大。
- **エンジンを選べる。** グリッドは `TableSource` とだけやり取りします。ディスク上のファイルは DuckDB のサーバー（`vastgrid-duckdb`）、
  メモリ上のデータは `ArraySource`、ほかのエンジンは自作の `TableSource` で扱えます。
- **安全。** DuckDB のエンジンは、リンクをたどった実際の場所が許可したフォルダーの中にあるファイルだけを読み、実行中は変えられません。SQL はすべて組み立てたもので、値は必ずパラメーターで渡します。
- **日本語と英語**の表示、CSS 変数によるライトとダーク、ARIA のグリッドの役割とキーボードだけでの操作。

## パッケージ

| パッケージ | 内容 |
| --- | --- |
| [`vastgrid`](packages/react) | React の `DataGrid`（キャンバスの描画・操作・メニュー・絞り込み・統計） |
| [`vastgrid-core`](packages/core) | 表のプロトコル、行のキャッシュ、選択とスクロールの写像、書式、`ArraySource`・`RemoteSource`。フレームワークに依存しない |
| [`vastgrid-duckdb`](packages/duckdb) | DuckDB を使う Node.js の表のサーバーと、Fetch API の受け口 |

## 動作環境

- **`vastgrid`**: React 18 以降と、CSS の `light-dark()` に対応したブラウザー（Chrome・Edge 123、Firefox 120、Safari 17.5 以降）。
- **`vastgrid-duckdb`**: Node.js 20 以降。DuckDB のバイナリがある Linux（x64・arm64、glibc・musl）、macOS（x64・arm64）、
  Windows（x64・arm64）で動きます。
- **`vastgrid-core`** は依存がなく、同じブラウザーと Node.js 20 以降で動きます。

## 使い方

### サーバーのファイル（Node.js ＋ DuckDB）

```sh
npm install vastgrid vastgrid-duckdb
```

```ts
// app/api/table/route.ts（Next.js）。Fetch API の要求を受けるほかのフレームワークでも同じ
import path from "node:path";
import { createTableHandler, TableEngine } from "vastgrid-duckdb";

const root = "/srv/data";
const engine = TableEngine.create({ allowedDirectories: [root], tempDirectory: "/tmp/vastgrid" });

export const POST = createTableHandler({
  engine: () => engine,
  // 画面から受け取った ref をファイルに対応させる。フォルダーの外は拒否する。
  resolve: (ref) => {
    const file = path.resolve(root, ref);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Not allowed");
    return file;
  },
});
```

```tsx
"use client";
import { DataGrid, RemoteSource } from "vastgrid";
import "vastgrid/styles.css";
import { useMemo } from "react";

export function Table({ file }: { file: string }) {
  const source = useMemo(() => new RemoteSource({ endpoint: "/api/table", ref: file }), [file]);
  return (
    <div style={{ height: 600 }}>
      <DataGrid source={source} locale="ja" />
    </div>
  );
}
```

`vastgrid-duckdb` が使う `@duckdb/node-api` はネイティブの拡張です。サーバーのバンドルに含めず（Next.js では
`serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"]`）、OS ごとのパッケージ
（`@duckdb/node-bindings-<platform>`。macOS で約 120 MB）をサーバーと一緒に配布してください。

### メモリ上のデータ

```tsx
import { ArraySource, DataGrid } from "vastgrid";

const source = new ArraySource({
  columns: ["名前", "生年", "分野"],
  rows: [
    ["Ada Lovelace", 1815, "数学"],
    ["Grace Hopper", 1906, "計算機科学"],
  ],
});

<DataGrid source={source} />;
```

`ArraySource` は並べ替え・絞り込み・集計を画面のスレッドで行います。数十万行までが目安です。

## `DataGrid` の props

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
| `onSelectionChange` | `(event: GridSelectionEvent) => void` | | 選択範囲かアクティブなセルが変わったときに呼ばれます。 |
| `onColumnsChange` | `(event: GridColumnsEvent) => void` | | 列の幅・順序・表示・固定が変わったときに呼ばれます。 |
| `onCellClick`、`onCellDoubleClick` | `(event: GridCellEvent) => void` | | セルのクリック（または Space）とダブルクリック（または F2）で呼ばれます。ダブルクリックで `preventDefault()` を呼ぶと、セルの詳細を開きません。 |
| `initialState` | `GridState` | | グリッドを作るときに、表の列がわかった時点で適用する設定。 |
| `onStateChange` | `(state: GridState) => void` | | クエリーか列の設定が変わったときに、その設定を渡して呼ばれます。 |
| `className`、`style` | | | ルートの要素（`.vg-root`）に付けます。 |
| `aria-label` | `string` | `messages.gridLabel` | スクリーンリーダー向けのグリッドの名前。 |

ref からは `DataGridHandle` を使えます。`focus()`、`reload()`、`getQuery()`、`setQuery(query)`、`getState()`、
`applyState(state)`、`goToRow(row)`、グリッドの状態を持つ `controller`、キャンバスの `renderer`（`renderer.timings()`
などの診断用）があります。

イベントは、セルのビューでの行 `row`、元の表での行 `rowId`、表示中の列の位置 `col`、表の列の番号 `column` を渡し、
変更があったときだけ呼ばれます（スクロールや描画では呼ばれません）。`GridState` は、クエリーと列の順序・決めた幅・
表示・固定を列名で記録した、バージョン付きの JSON で、保存先はアプリが選べます。詳しくは
[DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#イベント)を参照してください。

```tsx
<DataGrid
  source={source}
  initialState={saved}
  onStateChange={(state) => localStorage.setItem("grid", JSON.stringify(state))}
  onSelectionChange={({ active }) => showDetail(active.rowId)}
/>
```

```tsx
const grid = useRef<DataGridHandle>(null);

<DataGrid ref={grid} source={source} onQueryChange={(query) => saveQuery(query)} />;

// 3 列目の大きい順に並べ、「東京」を含む行だけを表示する。
grid.current?.setQuery({ sort: [{ column: 2, direction: "desc" }], search: "東京" });
```

### 列の表示設定

`columnFormats` で、スキーマの列名ごとに列の見え方を設定します。変わるのは表示だけで、並べ替え・絞り込み・検索・統計・書き出しは値そのものに対して動きます。64 bit 整数や decimal の桁も失われません。

```tsx
const formats: Record<string, ColumnFormat> = {
  price: { label: "価格", number: { style: "currency", currency: "JPY" } },
  share: { number: { style: "percent", fractionDigits: 1 } },
  ordered_at: { label: "注文日時", date: { pattern: "yyyy/MM/dd HH:mm" } },
  status: { align: "center", format: (value, { text }) => (value === "ok" ? "✓" : text) },
};

<DataGrid source={source} columnFormats={formats} />;
```

コピーには値とスキーマの列名が入ります。表示している文字と表示名をコピーするには、`copyValues="formatted"`（列ごとには `copy`）を指定します。詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#列の表示設定)を参照してください。

## 性能

Apple M2 Pro（12 スレッド・32 GB）、Node.js 24、DuckDB 1.5 で `npm run bench -- --csv-rows=10000000 --parquet-rows=100000000` を実行した結果です。
DuckDB の処理を含み、HTTP は含みません。

| 処理 | 時間 |
| --- | ---: |
| CSV 735 MB・1,000 万行: 最初の行を表示できるまで | 143 ms |
| CSV: 読み込みの完了（並べ替え・絞り込み・統計が使える） | 5.3 秒 |
| CSV: 任意の位置の 256 行 × 8 列（中央値） | 1.8 ms |
| CSV: 数値の列・文字列の列での並べ替え | 1.2 秒・1.1 秒 |
| CSV: 値での絞り込み（250 万行）・すべての列からの絞り込み | 293 ms・544 ms |
| CSV: 列の統計（分布・四分位） | 117 ms |
| CSV: 100 万行 × 2 列の合計・平均・最小・最大 | 7.8 ms |
| Parquet 1.38 GB・1 億行: 開く（ファイルのまま読む） | 20 ms |
| Parquet: 任意の位置の 256 行 × 8 列（中央値） | 24 ms |
| Parquet: 数値の列での並べ替え | 1.9 秒 |
| Parquet（並べ替え後）: 任意の位置の 256 行（中央値・95 パーセンタイル） | 147 ms・208 ms |

2280 × 1371 px（56 行 × 20 列）の描画は、フレームごとにキャンバスを確定させて測り、中央値 2.0 ms・99 パーセンタイル 3.0 ms でした。

## 仕組み

- **スクロール。** キャンバスの上に透明のスクロール用の要素を重ね、ホイール・トラックパッド・スクロールバーはブラウザーの動きのままにします。
  要素の高さの上限（Chromium で約 1,677 万 px）を越えるため、`ScrollAxis` が小さな移動はそのまま、大きな移動と両端は比例で写します。
- **読み込み。** グリッドは毎フレーム、見えている行と列を伝えます。`RowCache` は足りないまとまり（256 行 × 48 列）を、見えている所から、
  1 画面先と前まで読み、遠ざかった要求は取り消し、古いまとまりから捨てます。
- **エンジン。** 区切りのテキストと JSON は、セッションの DuckDB のファイルに表として読み込みます。読み込み中も先頭の 1,000 行を表示します。
  Parquet はファイルのまま、行の位置で読みます。Shift_JIS・EUC-JP・BOM 付き UTF-16（両方のバイト順）は先に UTF-8 に変換します。
  並べ替え・絞り込みの結果は、2,000 万行までは並べ替えた表を（取り出し 2 ms）、それを超えると行の順番だけを作ります（数分かかる処理が数秒に、一時領域も数分の 1 に）。
- **プロトコル。** `RemoteSource` は小さな JSON のプロトコル（[docs/protocol.md](docs/protocol.md)）を話し、サーバーが表やビューを忘れた場合（再起動など）は開き直します。

## キー操作

| キー | 操作 |
| --- | --- |
| 矢印・Page Up/Down・Home/End | アクティブなセルを動かす |
| ⌘/Ctrl ＋ 矢印・⌘/Ctrl ＋ Home/End | 最初・最後の行や列へ移る |
| Shift ＋ 上のキー・Shift ＋ クリック | 選択を広げる |
| ⌘/Ctrl ＋ クリック | 範囲を足す |
| Tab・Enter（Shift で逆向き） | 選択の中を動く |
| Shift ＋ Space・Ctrl ＋ Space・⌘/Ctrl ＋ A | 行・列・すべてを選ぶ |
| ⌘/Ctrl ＋ C・⌘/Ctrl ＋ Shift ＋ C | コピー・見出しを含めてコピー |
| ⌘/Ctrl ＋ F | 検索 |
| Alt ＋ ↓ | 列のメニュー（並べ替え・絞り込み・統計・固定・非表示） |
| F2・ダブルクリック | セルの値の全体を表示 |
| Shift ＋ F10・コンテキストメニューのキー・右クリック | セルのメニュー（コピー・この値で絞り込む・並べ替え） |

## 見た目の変更

色・文字・大きさは `.vg-root` の CSS 変数で、キャンバスもそれを読みます。

```css
.my-app .vg-root {
  --vg-font-family: "Hiragino Sans", sans-serif;
  --vg-bg: var(--surface);
  --vg-fg: var(--text);
  --vg-accent: var(--brand);
  --vg-selection-bg: color-mix(in srgb, var(--brand) 15%, transparent);
}
```

一覧は [`packages/react/src/styles.css`](packages/react/src/styles.css) にあります。色は `light-dark()` で `color-scheme` に従い、強制カラーモードにも対応します。

## 開発

```sh
npm install
npm run dev        # お試し画面 http://127.0.0.1:5174（examples/playground/.data のファイル）
npm run dev -w vastgrid-site   # ドキュメントとデモ http://localhost:4321
npm run generate -w vastgrid-playground   # 見本のファイル。--large で 1 億行も作る
npm test
npm run lint
npm run bench
```

## 今後

- サーバーのないアプリ向けの、ブラウザーだけで動くエンジン（Web Worker の DuckDB-WASM か hyparquet）
- セルの編集と、変えていない行を 1 バイトも変えない CSV への書き戻し
- 式の列
- 1 億行を超える並べ替えで、並べ終わる前に先頭を表示する
- Excel（`.xlsx`）の読み込み

既存のビューワーとグリッドの調査は [docs/research.ja.md](docs/research.ja.md) にあります。

## ライセンス

MIT
