# vastgrid

数 GB・数億行の CSV・TSV・Parquet・JSON Lines を開けて、表計算ソフトのように扱える React のデータグリッドです。

[English](README.md)

![1 億行の Parquet を絞り込み・並べ替えし、列の統計と選択範囲の集計を表示した画面](docs/images/playground.jpg)

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
  Parquet はファイルのまま、行の位置で読みます。DuckDB が読めない文字コード（Shift_JIS・EUC-JP）は先に変換します。
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
