# vastgrid 0.2 でファイルを開ける場所

[English](entries.md)

vastgrid 0.2 は巨大な CSV・Parquet・Excel ファイルや DataFrame を六つの場所で開きます。どこでも同じグリッド
（`vastgrid` の `DataGrid`、docs/react.md）が、同じドキュメント・セッション・コマンド（docs/spec.md §5、§6）で
表を示し、同じ電文（§8）でエンジンと話します。違うのはエンジンと電文の運び方、そして書き込んだセルをホストがどう
扱うかです。エンジンはそれぞれホストの能力に合わせた capabilities を返し（§8.2）、保存の方式をほかの入口に揃えることは
しません。

## 入口

| 入口 | データを読む場所 | エンジン | 電文の運び方 | 詳細 |
| --- | --- | --- | --- | --- |
| ブラウザーのページ | ブラウザーの Web Worker | `vastgrid-js` | `workerTransport` | サイトの `/ja/open/` |
| React コンポーネント | アプリがエンジンを置く場所 | `vastgrid-js`、`vastgrid-duckdb`、独自のもの | §4.4 のトランスポート | [vastgrid](../packages/grid/README.md) |
| コマンドライン | コマンドの中の DuckDB（Node.js） | `vastgrid-duckdb` | `httpTransport` | [cli.md](cli.md) |
| VS Code | 拡張機能の中の DuckDB（Node.js） | `vastgrid-duckdb` | Webview のメッセージの上の `workerTransport` | [vscode.md](vscode.md) |
| MCP App | MCP サーバーの中の DuckDB（Node.js） | `vastgrid-duckdb` | App のツール呼び出し | [mcp-app.md](mcp-app.md) |
| ノートブック | カーネルの中の DuckDB（Python） | `vastgrid`（Python） | ウィジェットのメッセージの上の `workerTransport` | [notebook.md](notebook.md) |

## 形式

| 入口 | CSV、TSV | JSON Lines | JSON | Parquet | Excel | DataFrame |
| --- | --- | --- | --- | --- | --- | --- |
| ブラウザーのページ | 可 | 可 | | 可 | `.xlsx`、`.xlsm` | |
| React コンポーネント | エンジンが読むもの | | | | | |
| コマンドライン | 可（圧縮も） | 可 | 可 | 可 | `.xlsx`、`.xlsm` | |
| VS Code | 可（圧縮も） | 可 | | 可 | `.xlsx`、`.xlsm` | |
| MCP App | 可（圧縮も） | 可 | 可 | 可 | `.xlsx`、`.xlsm` | |
| ノートブック | 可（圧縮も） | 可 | 可 | 可 | `.xlsx` | pandas、Polars、PyArrow、DuckDB のリレーション |

どの入口もブックのシートを（隠しシートには印を付けて）開き、大きさを問わずファイルを開きます。Parquet はその場で
行の範囲ごとに読み、ほかの形式は DuckDB に、またはメモリーエンジンの上限の内で読み込みます。

## 編集・保存・書き出し

| 入口 | セルの編集 | ファイルへの保存 | 書き出し |
| --- | --- | --- | --- |
| ブラウザーのページ | 可 | 不可（ファイルはブラウザーの中にとどまる） | CSV、TSV、JSON、Excel をダウンロード |
| React コンポーネント | エンジンが書き込めるとき | エンジンが保存できるとき（`capabilities.save`） | エンジンの形式 |
| コマンドライン | 可 | CSV と TSV を `--save` で（⌘S または Ctrl+S） | CSV、TSV、Parquet、JSON、Excel をダウンロード |
| VS Code | 可（元に戻す・やり直しは VS Code のスタックで） | CSV と TSV を VS Code の保存で。名前を付けて保存はどの形式でも | CSV、TSV、Parquet、JSON、Excel を保存ダイアログの場所へ |
| MCP App | 可（人もエージェントも） | CSV と TSV を `--save` で | CSV、TSV、Parquet、JSON、Excel をサーバーに書く |
| ノートブック | 可 | 不可（書き込んだセルはノートブックが読む。`grid.to_pandas()`） | CSV、TSV、Parquet、JSON、Excel をダウンロード、または `grid.export` で |

保存は CSV や TSV の編集したフィールドだけを書き、ほかのバイトはそのまま残します（§7.5）。読んだ後にディスク上で
変わったファイルには上書きしません（§7.6）。保存しない書き込みは、エンジンが止まるまでエンジンにとどまります。

## 導入

| 入口 | 方法 |
| --- | --- |
| ブラウザーのページ | https://vastgrid.yhay81.com/ja/open/ を開く（英語は `/open/`）。入れるものはありません |
| React コンポーネント | `npm install vastgrid vastgrid-js`。サーバーのエンジンには `vastgrid-duckdb`（React 19.3 以降） |
| コマンドライン | `npx vastgrid-cli <ファイルまたはフォルダー>…`（CSV と TSV を保存するには `--save`） |
| VS Code | Marketplace の拡張機能 `yhay81.vastgrid-vscode`、または GitHub のリリースの `.vsix`（VS Code 1.100 以降） |
| MCP App | `npx -y vastgrid-mcp <フォルダー>` をホストの MCP サーバーに加える |
| ノートブック | `pip install vastgrid`（Python 3.11 以降。JupyterLab 4 または Notebook 7） |

0.2.0 を出すまでは、プレリリースを `vastgrid@next`（ほかの npm パッケージも `@next`）、`pip install --pre
vastgrid`、GitHub のリリースの `.vsix` で入れます。リポジトリーを複製したときは、`npm install` と `npm run build` の
あと、ページは `npm run dev -w vastgrid-site`、コマンドは `node packages/cli/dist/cli.js` と
`node packages/mcp/dist/cli.js`、VS Code は `code --extensionDevelopmentPath="$PWD/packages/vscode" <フォルダー>`
または `npm run package -w vastgrid-vscode` が作るパッケージ、ノートブックは `pip install ./packages/notebook/python`
です。

## どの入口も同じグリッド

どの入口も、トランスポートの上に `createGridStore`（`vastgrid/core`）でストアを作り、`<DataGrid store={store}>` で
示します。グリッドは自分がどの入口にいるかを知りません。入口が React の API に求めたこと、確かめたこと：

- **トランスポート**　`workerTransport` は Web Worker に限らず、`postMessage` とメッセージのイベントを持つもの
  （`WorkerLike`）なら何でも受け取ります。VS Code の Webview とノートブックのウィジェットは、それぞれの経路で電文を
  運びます（react.md §4.4）。コマンドラインは `httpTransport` を使い、MCP App はツールの上に `Transport` を実装します。
- **capabilities**　グリッドはエンジンができると答えたことだけを示します。保存のボタンと ⌘S は `capabilities.save` の
  ときだけ（コマンドラインでは `--save` のとき）、書き出しは `capabilities.export` の形式で、その `delivery` のとおりに
  書きます。VS Code は自分で保存するので Webview には `save` を false と答え、未保存の状態をファイルに合わせます。
- **ドキュメント**　`onDocumentChange` はビュー（§5.1）をホストに渡します。MCP App はエージェントの側のグリッドを
  それに合わせ、ノートブックはそれを `grid.plan` として読んでビューを書き出します。
- **キー**　グリッドのキーは、ホストが任せた範囲で働きます。VS Code は保存・元に戻す・やり直しのキーを自分で受けて
  グリッドにコマンドとして渡し、ノートブックはグリッドにフォーカスがある間は自分のキーを使いません
  （[notebook.md](notebook.md#keys)）。グリッドはホストのテーマ（ライトかダーク）に従います。

どの入口も、ファイルを開いてから編集し、書き出すか保存するまでを試験しています。`e2e/open.spec.ts`（ブラウザーの
ページ）、`e2e/cli.spec.ts`（コマンドライン）、`npm run test:vscode -w vastgrid-vscode`（VS Code）、`e2e/mcp.spec.ts` と
`packages/mcp/test`（MCP App）、`packages/notebook` と JupyterLab・Notebook 7 での手作業（ノートブック、
[notebook.md](notebook.md#testing)）。React コンポーネントそのものは `packages/grid/test` と `e2e` のほかのファイルで
試験しています。
