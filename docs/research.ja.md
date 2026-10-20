# 既存の表ビューワー・データグリッドの調査

調査日: **2026-10-20**。版は npm の最新（同日）。性能の数値は、出典の記載（多くは開発元の自己申告）と、この調査で実測した値（Apple M2 Pro・12 スレッド・メモリ 32 GB）を分けて示します。

## 目的と観点

CSV・Parquet のビューワーを React のアプリに組み込むにあたり、次の観点で既存のものを比べました。

| 観点 | 求めること |
| --- | --- |
| 規模 | 数 GB・数億行のファイルを、メモリに載せきらずに開ける |
| 性能 | 開いてすぐ見える。どの位置へもすぐ移れる。並べ替え・絞り込みが待たせない |
| 表計算の機能 | 範囲の選択とキーボード操作、コピー、並べ替え、Excel のような絞り込み、集計、検索 |
| 組み込み | React の部品として使える。データの置き場所（サーバー・ブラウザー）を選べる |
| ライセンス | 商用の製品にも組み込める OSS |

## 対象と要点

### キャンバスに描くグリッド

| 製品 | 版・ライセンス | 要点 |
| --- | --- | --- |
| [Glide Data Grid](https://github.com/glideapps/glide-data-grid) | 6.0.3・MIT | キャンバスに描き、表示中のセルだけを `getCellContent` で求める。数百万行をうたう。ブラウザーの要素の高さの上限を超える表は、大きな移動だけ比例で写し、小さな移動は 1 対 1 で動かす（ソースの `infinite-scroller` で確認）。並べ替え・絞り込みはアプリ側で実装する。`lodash`・`marked`・`react-responsive-carousel` が必要。読み上げへの対応は「気付いていない不備があるかもしれない」と開発元が記載 |
| [canvas-datagrid](https://www.npmjs.com/package/canvas-datagrid) | 0.26.0・BSD-3-Clause | Web Components のキャンバスのグリッド。データはメモリに持つ |

### DOM の仮想化グリッド

| 製品 | 版・ライセンス | 要点 |
| --- | --- | --- |
| [AG Grid](https://www.npmjs.com/package/ag-grid-community) | 36.2.0・Community は MIT、Enterprise は有償 | 機能が最も多い。範囲の選択・Excel への書き出し・サーバー側の行モデル（大量の行の取得）は Enterprise |
| [react-data-grid](https://www.npmjs.com/package/react-data-grid) | 7.0.0-beta.62・MIT | 軽い（約 15 kB）。データはメモリに持つ |
| [TanStack Table](https://www.npmjs.com/package/@tanstack/react-table) ＋ Virtual | 9.3.1・MIT | 画面を持たない（headless）。仮想化は自分で組む |
| [MUI X Data Grid](https://www.npmjs.com/package/@mui/x-data-grid) | MIT（Community）・有償（Pro / Premium） | 列の固定・行のまとまりなどは有償版 |
| [RevoGrid](https://rv-grid.com/) | 4.29.0・MIT（Pro は有償） | 行と列の仮想化。表計算の機能の多くは Pro |
| [LyteNyte Grid](https://www.1771technologies.com/) | Core 2.2.1・Apache-2.0（PRO は有償） | 開発元の比較では 100 万行でも 60 FPS（自己申告）。サーバーからの段階的な読み込みは PRO |

開発元（1771 Technologies）の比較（[出典](https://www.1771technologies.com/blog/performance-benchmarks)）では、100 万行の縦スクロールで AG Grid が約 27 FPS、MUI が約 33 FPS に下がり、Handsontable は約 15 万行を超えるとメモリが足りなくなっています。DOM の要素を作るグリッドは、表示するセルの数と行数が増えるほど遅くなります。

### 表計算のエンジン・ワークブック

| 製品 | 版・ライセンス | 要点 |
| --- | --- | --- |
| [Handsontable](https://www.npmjs.com/package/handsontable) | 18.1.2・商用ライセンス | Excel に最も近い操作感。データはメモリに持つ |
| [HyperFormula](https://hyperformula.handsontable.com/) | 3.5.0・GPLv3 または有償 | 画面を持たない数式エンジン。GPL のため組み込みに制約 |
| [Univer](https://www.npmjs.com/package/@univerjs/presets) | 1.1.0・Apache-2.0 | キャンバスに描くオフィスの SDK（表計算・文書・スライド）。1,000 万セルを 0.5 秒で読むとの記載（自己申告） |
| [IronCalc](https://github.com/ironcalc/IronCalc) | 0.9.0・MIT / Apache-2.0 | Rust の表計算エンジン（WebAssembly）。開発中 |
| [Formula.js](https://www.npmjs.com/package/@formulajs/formulajs) | 4.6.1・MIT | Excel の関数だけ |

ワークブック（セルごとの値と数式を持つ）の作りは、数億行のファイルを開く用途には合いません。

### 計算のエンジンを持つデータビューアー

| 製品 | 版・ライセンス | 要点 |
| --- | --- | --- |
| [Perspective](https://www.npmjs.com/package/@finos/perspective)（FINOS） | 3.8.0・Apache-2.0 | C++ のエンジンを WebAssembly で動かし、ピボット・集計・ストリーミングに強い。グリッドは [regular-table](https://www.npmjs.com/package/regular-table)（DOM の仮想化） |
| [HighTable](https://github.com/hyparam/hightable) ＋ [hyparquet](https://github.com/hyparam/hyparquet) | 0.26.4・1.31.5・MIT | Hyperparam のもの。hyparquet は依存のない Parquet の読み込みで、HTTP の範囲指定で必要な部分だけを読む。HighTable は DOM の仮想化の表で、行の取得を非同期で受け、要素の高さの上限を超える表も写して表示する（ソースで確認）。並べ替えは昇順だけ |
| [quak](https://pypi.org/project/quak/) ＋ [Mosaic](https://github.com/uwdata/mosaic) | 試作 | DuckDB の SQL で表を作る Jupyter の部品。本番向けではないと明記 |
| [DuckDB UI](https://motherduck.com/blog/local-duckdb-ui-visual-data-analysis/) | DuckDB 1.2.1 以降・拡張はソース非公開 | DuckDB のノートブックの画面。結果の並べ替え・絞り込み・列の要約 |
| [Tad](https://www.tadviewer.com/) | 0.14.0（2024-06）・MIT | DuckDB を使うデスクトップアプリ。ピボット・絞り込み・集計。React の部品ではない |
| VS Code Data Wrangler | Microsoft | pandas を使う。数千万行で止まるとの報告（個人の記事） |

### デスクトップの CSV エディター・ブラウザーのビューアー

| 製品 | 要点 |
| --- | --- |
| [Modern CSV](https://www.moderncsv.com/)（有償） | 大きいファイル向けの読み取り専用のモード |
| [Tablecruncher](https://blog.brightcoding.dev/2026/04/26/tablecruncher-the-revolutionary-csv-editor-developers-crave)（GPLv3） | C++・FLTK。2 GB を約 32 秒で開くとの記事 |
| SmoothCSV（Tauri ＋ React） | ブラウザーの高さの上限を、自作のスクロールバーで越える（[作者の記事](https://dev.to/kohii/how-to-implement-virtual-scrolling-beyond-the-browsers-limit-16ol)） |
| [hugecsv.com](https://hugecsv.com/) | C の解析を WebAssembly にし、Web Worker で並列に読む。21 GB・1 億行をうたう。SQL は SQLite の WebAssembly で約 1 GB まで |

## 調べて分かったこと

### 1. ブラウザーには要素の高さの上限がある

Chromium は約 1,677 万 px、Safari は約 3,355 万 px（[出典](https://dev.to/kohii/how-to-implement-virtual-scrolling-beyond-the-browsers-limit-16ol)）。行の高さが 24 px なら、Chromium で約 70 万行を超えるとスクロールバーが最後まで届きません。
Glide Data Grid と HighTable は、小さな移動はそのまま、大きな移動（つまみのドラッグ）と端は比例で写す方式で越えています。行を数える表示（何行目か）とスクロールの位置を、ブラウザーの値から切り離す必要があります。

### 2. 描き方は、キャンバスが一定の速さを保ちやすい

DOM の要素でセルを作る方式は、見えるセルの数（広い画面・多い列）と行数で遅くなります。キャンバスは 1 フレームに見えている分を描くだけで、行数に左右されません。
キャンバスの弱点（読み上げ・日本語の入力・文字の選択）は、選択中のセルを ARIA で伝える要素や、入力用の DOM を重ねて補えます。

### 3. 巨大なファイルは「見えている分だけを取りに行く」データの持ち方が要る

JavaScript の配列に全行を持つグリッドは、数百万セルを超えるとメモリと初期化の時間が問題になります。
数 GB のファイルでは、計算のエンジン（DuckDB など）に表を任せ、グリッドは表示する範囲だけを、少し先まで読み込みながら受け取る形にする必要があります。

### 4. エンジンの選び方（この調査での実測）

DuckDB 1.5（`@duckdb/node-api` 1.5.6）で、生成したデータを使って測りました（[計測スクリプト](../packages/duckdb/bench/run.ts)）。

| 処理 | 実測 |
| --- | --- |
| CSV 755 MB・1,000 万行を DuckDB の表にする（メモリ上） | 0.8〜1.4 秒 |
| 同じ（一時フォルダーの DuckDB ファイル。圧縮して保存） | 2.3〜5.3 秒 |
| CSV のまま 900 万行目から 100 行を読む（索引なし） | 2.9 秒 |
| Parquet 1.38 GB・1 億行の任意の位置の 100 行（`file_row_number` で絞る） | 10〜20 ms |
| 1,000 万行の表を並べ替えた結果を表として作る | 0.2〜1.2 秒 |
| 1 億行の Parquet を全列ごと並べ替えて表にする | 16〜25 秒、一時ファイル 6〜13 GB |
| 1 億行の Parquet の「並べ替えた順の行番号」だけを作る | 1.5〜2.1 秒 |

- ネイティブの DuckDB（Node.js）は複数のスレッドで動き、メモリを超える分はディスクへ逃がせます。デスクトップアプリのローカルサーバーに向きます。拡張の大きさは macOS（arm64・x86_64 の共通バイナリ）で約 117 MB です。
- DuckDB-WASM はブラウザーだけで動きますが、メモリは 4 GB まで（wasm32）、CSP に `'wasm-unsafe-eval'` が要り、並列には COOP・COEP の設定が要ります。
- hyparquet は軽く、Parquet をブラウザーで部分的に読むのに向きます。SQL のエンジンは持ちません。

### 5. DuckDB は、許可したフォルダーの外へ届かないように閉じられる

`SET allowed_directories = [...]` の後に `SET enable_external_access = false` とすると、実行中は元に戻せず、許可するフォルダーも変えられないことを確かめました（`Cannot enable external access while database is running`）。拡張の取得・読み込みも止まります。生成した SQL に誤りがあっても、ほかのファイルを読めません。

### 6. CSV の落とし穴

- 列の数が行によって違う CSV では、DuckDB の自動判定が最後の整った部分だけを読み、ほかの行を黙って捨てることがありました。`null_padding=true` で全行を読めます（速度は変わらないことを実測）。
- 日本の Excel から書き出した CSV に多い Shift_JIS は、DuckDB では拡張（ネットワークから取得）が要るため、Node.js の `TextDecoder` で UTF-8 に変えてから読みます。
- 型の自動判定は先頭の行から決まるため、後ろで型が崩れるファイルは、全行を調べ直し、それでも読めなければ文字列として読みます。

### 7. 1 億行の並べ替えは「順番だけ」を作る

全列を並べ替えた表を作ると、1 億行では 16〜25 秒と 6〜13 GB の一時ファイルが要りました。
並べ替えた順の行番号だけを作り、表示する 256 行ごとに元の表から取り出す方式なら、作るのは約 2 秒、取り出しは 1 ブロック 150〜200 ms です。2,000 万行までは全列の表（取り出し 2 ms）を、それを超える表では順番だけを作るのが釣り合いの取れた選び方でした。

## 結論: 作るもの（vastgrid）の設計

既存のものは、「キャンバスで速いがデータの取り方はアプリ任せ」（Glide）、「エンジンは強いが重く、表計算の操作は弱い」（Perspective）、「表計算の操作は強いがメモリに載る量まで」（Handsontable・AG Grid Enterprise）、「巨大ファイルに強いが React の部品ではない」（Tad・DuckDB UI）に分かれ、全部を満たすものはありませんでした。そこで次の形で作りました。

| 調べて分かったこと | 設計 |
| --- | --- |
| DOM の仮想化は大量のセルで遅い | キャンバスに描く。1 フレーム 2 ms（2280×1371 px・1,120 セル、実測） |
| 要素の高さに上限がある | 小さな移動は 1 対 1、大きな移動と端は比例で写す（`ScrollAxis`）。数十億行まで |
| 巨大なファイルはメモリに載らない | 見えている範囲を 256 行 × 48 列のまとまりで取りに行き、1 画面先まで読み込み、遠ざかった要求は取り消す（`RowCache`） |
| エンジンは置き場所で選びたい | グリッドとエンジンを `TableSource` で分ける。サーバーの DuckDB（`vastgrid-duckdb`）、メモリ上の配列（`ArraySource`）、自作のエンジン |
| CSV はそのままでは任意の位置を読めない | DuckDB の表にしてから読む。読み込み中も先頭の 1,000 行はすぐ表示する |
| 大きな並べ替えは重い | 2,000 万行までは全列の表、それを超えると順番だけ |
| DuckDB を閉じられる | 許可したフォルダーだけを読めるようにして起動し、実行中は変えられない |
| 表計算の操作感が要る | Excel と同じ選択・キーボード（Shift・⌘・Tab・Enter・Alt+↓）、TSV と HTML でのコピー、値の一覧と条件の絞り込み、集計、列の統計、検索 |

## 出典

- Glide Data Grid: https://github.com/glideapps/glide-data-grid ・ https://grid.glideapps.com
- HighTable: https://github.com/hyparam/hightable ・ hyparquet: https://github.com/hyparam/hyparquet
- Perspective: https://www.npmjs.com/package/@finos/perspective ・ regular-table: https://www.npmjs.com/package/regular-table
- 1771 Technologies の比較: https://www.1771technologies.com/blog/performance-benchmarks
- React のグリッドの比較（2026）: https://svar.dev/blog/top-react-alternatives-to-ag-grid/ ・ https://rv-grid.com/blog/top-5-react-datagrid-libraries-2026
- Univer: https://www.npmjs.com/package/@univerjs/presets ・ IronCalc: https://github.com/ironcalc/IronCalc ・ HyperFormula のライセンス: https://hyperformula.handsontable.com/docs/
- Tad: https://www.tadviewer.com/ ・ https://raw.githubusercontent.com/antonycourtney/tad/master/README.md
- quak: https://pypi.org/project/quak/ ・ Mosaic: https://github.com/uwdata/mosaic
- DuckDB UI: https://motherduck.com/blog/local-duckdb-ui-visual-data-analysis/ ・ ソース非公開の報道: https://devclass.com/2025/03/19/duckdb-project-releases-local-web-ui-but-not-as-open-source
- DuckDB Node.js（Neo）: https://duckdb.org/docs/current/clients/node_neo/overview.html
- ブラウザーの高さの上限: https://dev.to/kohii/how-to-implement-virtual-scrolling-beyond-the-browsers-limit-16ol ・ https://bugs.webkit.org/show_bug.cgi?id=195158
- uDSV（CSV の解析の速さの比較）: https://github.com/leeoniya/uDSV
- 巨大 CSV のブラウザーのビューアー: https://hugecsv.com/
- Tablecruncher: https://blog.brightcoding.dev/2026/04/26/tablecruncher-the-revolutionary-csv-editor-developers-crave
