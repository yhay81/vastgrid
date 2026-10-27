---
title: ファイルを開ける場所
description: vastgrid が CSV・TSV・Parquet・JSON Lines・Excel のファイルと DataFrame を開ける 6 つの場所と、それぞれの読み込み・編集・保存・書き出し。
---

vastgrid は巨大な CSV・TSV・Parquet・JSON Lines・Excel のファイルや DataFrame を、6 つの場所で開きます。どこでも同じグリッド（`vastgrid` の `DataGrid`）が、同じドキュメント・セッション・コマンドで表を示し、同じ電文でエンジンと話します。違うのは、エンジンと電文の運び方、そして書き込んだセルをホストがどう扱うかです。

- いますぐファイルを見るなら、[コマンドライン](/ja/apps/cli/)か、何も入れずに使えるこのサイトの[ファイルを開く](/ja/open/)。
- エディターの中で作業するなら [VS Code](/ja/apps/vscode/)。
- エージェントと一緒に表を扱うなら [MCP App](/ja/apps/mcp/)。
- DataFrame を扱うなら[ノートブック](/ja/apps/notebook/)。
- 自分のアプリに組み込むなら React コンポーネント（[使い始める](/ja/getting-started/)から）。

## 入口

| 入口 | 入手 | データを読む場所 | エンジン | 電文の運び方 |
| --- | --- | --- | --- | --- |
| ブラウザーのページ | このサイトの [/ja/open/](/ja/open/) | ブラウザーの Web Worker | `vastgrid-js` | `workerTransport` |
| React コンポーネント | `npm install vastgrid` とエンジン | アプリがエンジンを置く場所 | `vastgrid-js`、`vastgrid-duckdb`、[独自のもの](/ja/guides/custom-engine/) | `localTransport`、`workerTransport`、`httpTransport`、`serverFunctionTransport` |
| [コマンドライン](/ja/apps/cli/) | `npx vastgrid-cli <ファイル>` | コマンドの中の DuckDB（Node.js） | `vastgrid-duckdb` | `httpTransport` |
| [VS Code](/ja/apps/vscode/) | 拡張機能 `vastgrid-vscode` | 拡張機能の中の DuckDB（Node.js） | `vastgrid-duckdb` | Webview のメッセージの上の `workerTransport` |
| [MCP App](/ja/apps/mcp/) | `npx vastgrid-mcp <フォルダー>` | MCP サーバーの中の DuckDB（Node.js） | `vastgrid-duckdb` | App のツール呼び出し |
| [ノートブック](/ja/apps/notebook/) | `pip install vastgrid` | カーネルの中の DuckDB（Python） | `vastgrid`（Python） | ウィジェットのメッセージの上の `workerTransport` |

## 形式

| 入口 | CSV、TSV | JSON Lines | JSON | Parquet | Excel | DataFrame |
| --- | --- | --- | --- | --- | --- | --- |
| ブラウザーのページ | 可 | 可 | | 可 | `.xlsx`、`.xlsm` | |
| React コンポーネント | エンジンが読むもの | | | | | |
| コマンドライン | 可（圧縮も） | 可 | 可 | 可 | `.xlsx`、`.xlsm` | |
| VS Code | 可（圧縮も） | 可 | | 可 | `.xlsx`、`.xlsm` | |
| MCP App | 可（圧縮も） | 可 | 可 | 可 | `.xlsx`、`.xlsm` | |
| ノートブック | 可（圧縮も） | 可 | 可 | 可 | `.xlsx` | pandas、Polars、PyArrow、DuckDB のリレーション |

どの入口もブックのシートを（隠しシートには印を付けて）開き、ファイルの大きさを問いません。Parquet はその場で行の範囲ごとに読み、ほかの形式は DuckDB に読み込むか、メモリーエンジンの上限（`maxBytes`。[ブラウザーで開く大きなファイル](/ja/guides/browser/)を参照）の内で読み込みます。

## 編集・保存・書き出し

| 入口 | セルの編集 | ファイルへの保存 | 書き出し |
| --- | --- | --- | --- |
| ブラウザーのページ | 可 | 不可（ファイルはブラウザーの中にとどまる） | CSV、TSV、JSON、Excel をダウンロード |
| React コンポーネント | エンジンが書き込めるとき | エンジンが保存できるとき（`capabilities.save`） | エンジンの形式 |
| コマンドライン | 可 | CSV と TSV を `--save` で（⌘S または Ctrl+S） | CSV、TSV、Parquet、JSON、Excel をダウンロード |
| VS Code | 可（元に戻す・やり直しは VS Code のスタックで） | CSV と TSV を VS Code の保存で。名前を付けて保存はどの形式でも | CSV、TSV、Parquet、JSON、Excel を保存ダイアログの場所へ |
| MCP App | 可（人もエージェントも） | CSV と TSV を `--save` で | CSV、TSV、Parquet、JSON、Excel をサーバーに書く |
| ノートブック | 可 | 不可（書き込んだセルはノートブックが読む。`grid.to_pandas()`） | CSV、TSV、Parquet、JSON、Excel をダウンロード、または `grid.export` で |

保存は CSV や TSV の編集したフィールドだけを書き、ほかのバイト（BOM、引用符、区切り文字、改行、文字コード）はそのまま残します。読んだ後にディスク上で変わったファイルには上書きしません。保存しない書き込みは、エンジンが止まるまでエンジンにとどまります。どちらも[セルの編集](/ja/guides/editing/)で説明しています。

## どの入口も同じグリッド

どの入口も、トランスポートの上に `createGridStore`（`vastgrid/core`）でストアを作り、`<DataGrid store={store}>` で示します。グリッドは自分がどの入口にいるかを知りません。

- **トランスポート**　`workerTransport` は Web Worker に限らず、`postMessage` とメッセージのイベントを持つものなら何でも受け取ります。VS Code の Webview とノートブックのウィジェットは、それぞれの経路でこれを使って電文を運びます。コマンドラインは `httpTransport` を使い、MCP App はツールの上に `Transport` を実装します。[ストアとトランスポート](/ja/reference/core/)を参照してください。
- **capabilities**　グリッドは、エンジンができると答えたことだけを示します。保存のボタンと ⌘S は `capabilities.save` のときだけ、書き出しは `capabilities.export` の形式だけです。VS Code は自分で保存するので、Webview のエンジンは `save` を false と答え、エディターの未保存の状態がファイルに合います。
- **ドキュメント**　`onDocumentChange` はビューをホストに渡します。MCP App はエージェントの側のグリッドをそれに合わせ、ノートブックはそれを `grid.plan` として読みます。
- **キーとテーマ**　グリッドのキーは、ホストが任せた範囲で働きます。VS Code は保存・元に戻す・やり直しのキーを自分で受けてグリッドにコマンドとして渡し、ノートブックはグリッドにフォーカスがある間は自分のキーを使いません。グリッドはホストのテーマ（ライトかダーク）に従います。
