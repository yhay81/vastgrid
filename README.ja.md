# vastgrid

[![npm](https://img.shields.io/npm/v/vastgrid)](https://www.npmjs.com/package/vastgrid)
[![CI](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/yhay81/vastgrid)](LICENSE)

vastgrid は、巨大な CSV・TSV・Parquet・JSON Lines・Excel のファイルを表計算ソフトのように開き、直し、安全に保存できるようにします。
React のキャンバスのデータグリッドに、ブラウザーと Node.js のエンジンが付き、同じグリッドをコマンド・VS Code の拡張機能・MCP App・
Jupyter のウィジェットとしても使えます。

**[デモを試す](https://vastgrid.yhay81.com/ja/demo/)** · [ブラウザーでファイルを開く](https://vastgrid.yhay81.com/ja/open/) · [ドキュメント](https://vastgrid.yhay81.com/ja/) · [English](README.md)

[![1 億行の Parquet ファイルを価格で並べ替え、選んだセルの合計をステータスバーに出した vastgrid-cli](docs/images/grid.jpg)](https://vastgrid.yhay81.com/ja/demo/)

- **どんな大きさでも開ける。** 行はスクロールに合わせて、まとまりごとに読みます。Parquet はファイルのまま読み、HTTP の Range
  要求でも読めます。1 億行の Parquet を DuckDB で並べ替えると、1 秒かからずに最初の行がそろいます。セルはキャンバスに描き、
  スクロールで React は描画しません。
- **表計算ソフトの操作。** Excel のキー操作と範囲の選択、並べ替え、絞り込み、条件、検索、グループ、ピボット、集計行、計算式、
  書式、コピー・貼り付け・埋める操作。
- **信頼できる編集。** 入力した値は列の型で検証し、書き込みは競合を確かめ、元に戻せます。CSV・TSV への保存は編集したフィールド
  だけを書き直し、ほかのバイトはすべて保ちます。ディスク上で変わったファイルは追いかけ、上書きはしません。
  CSV・TSV の空文字など、保存後に同じ値を読み戻せない場合は保存を拒否し、編集を保持します。
- **一つの状態と型の付いたコマンド。** グリッドが示すものは、ドキュメント（ビューと列）とセッション（利用者のいる場所）で、
  制御することもグリッドに任せることもできます。変更はすべてコマンドで、ツールバーもホストも AI エージェントも同じコマンドを送れます。
- **エンジンを選べる。** メモリーの `vastgrid-js`（ページの中でも Web Worker でも）、Node.js の `vastgrid-duckdb`、
  または少数の電文を話す独自のエンジン。
- **9 つの言語**の表示（英語・日本語・中国語の簡体字と繁体字・韓国語・スペイン語・ブラジルのポルトガル語・フランス語・
  ドイツ語）。言語ごとに別の import（`vastgrid/locales/ja`）です。CSS 変数によるライトとダーク、ARIA のグリッドの役割と
  キーボードだけでの操作。

## 使える場所

| 場所 | 使い方 | エンジン |
| --- | --- | --- |
| React のアプリ | `npm install vastgrid vastgrid-js`（[はじめかた](#はじめかた)） | メモリー、Worker、サーバー |
| ブラウザー | [vastgrid.yhay81.com/ja/open/](https://vastgrid.yhay81.com/ja/open/) にファイルを落とす。ファイルはブラウザーから出ません | Web Worker の `vastgrid-js` |
| コマンドライン | [`npx vastgrid-cli sales.parquet`](https://vastgrid.yhay81.com/ja/apps/cli/) | このコンピューターの DuckDB |
| VS Code | 拡張機能 [vastgrid](https://vastgrid.yhay81.com/ja/apps/vscode/)（`yhay81.vastgrid-vscode`） | 拡張機能の中の DuckDB |
| AI のチャット | MCP サーバー [`vastgrid-mcp`](https://vastgrid.yhay81.com/ja/apps/mcp/) とその MCP App | MCP サーバーの中の DuckDB |
| Jupyter のノートブック | [`pip install vastgrid`](https://vastgrid.yhay81.com/ja/apps/notebook/) のあと `vastgrid.show(df)` | カーネルの中の DuckDB |

形式・編集・保存・書き出しの違いは [ファイルを開ける場所](https://vastgrid.yhay81.com/ja/apps/overview/) で比べています。

## はじめかた

```sh
npm install vastgrid vastgrid-js
```

```tsx
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(
  memoryEngine({
    tables: {
      orders: {
        columns: [
          { name: "id", type: "integer" },
          { name: "customer", type: "string" },
          { name: "price", type: "decimal", precision: 10, scale: 2 },
          { name: "ordered", type: "date" },
        ],
        rows: [
          [1, "Acme", "12.50", "2026-01-31"],
          [2, "Globex", "8.00", "2026-02-01"],
        ],
        editable: true,
      },
    },
  }),
);

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

ページに収まらない大きなファイルは、メモリーエンジンを [Web Worker で](https://vastgrid.yhay81.com/ja/guides/browser/)、
または DuckDB エンジンを [サーバーで](https://vastgrid.yhay81.com/ja/guides/server/) 動かします。状態、編集と保存、計算式、
グループ、書き出し、テーマ、独自のエンジンは [ガイド](https://vastgrid.yhay81.com/ja/getting-started/) にあります。

DuckDB エンジンは CSV をカンマ区切り・二重引用符で読みます。区切り文字や見出しを指定する場合は、グリッドに
`open={{ read: { delimiter: ";", headerRow: 1 } }}` を渡します。`headerRow: 0` は見出しなしです。
詳しくは [エンジンの読み込み設定](packages/duckdb-engine#what-it-does) を参照してください。

## パッケージ

| パッケージ | 内容 |
| --- | --- |
| [`vastgrid`](packages/grid) | React のグリッド: `DataGrid`、`GridProvider` とフック。`vastgrid/core`（ストアとトランスポート、React なし）、`vastgrid/server`、`vastgrid/styles.css` |
| [`vastgrid-js`](packages/js) | ブラウザーと Node.js のメモリーエンジン: 型の付いた JSON の行、Arrow、CSV・TSV・JSON Lines・Excel・Parquet（HTTP 越しも） |
| [`vastgrid-duckdb`](packages/duckdb-engine) | Node.js の DuckDB エンジン: どんな大きさのファイルも開き、セルの書き込み、CSV・TSV への保存、ファイルの追跡、書き出し。HTTP の受け口つき |
| [`vastgrid-spec`](packages/spec) | コードにした仕様: 型、プランの検証、コマンド、電文のスキーマ、適合性のコーパス |
| [`vastgrid-sql`](packages/sql) | プランを DuckDB の SQL に |
| [`vastgrid-cli`](packages/cli) | `npx vastgrid-cli <ファイル>`: このコンピューターの DuckDB で読んだファイルをブラウザーのグリッドで |
| [`vastgrid-mcp`](packages/mcp) | MCP App つきの MCP サーバー |
| [`vastgrid-vscode`](packages/vscode) | VS Code の拡張機能。0.2.1 は [GitHub Release](https://github.com/yhay81/vastgrid/releases/tag/v0.2.1) の VSIX から導入 |
| [`vastgrid`（Python）](packages/notebook/python) | Jupyter のウィジェット（PyPI） |

npm のパッケージは同じ版でそろえて公開します。`vastgrid` には React 19.3 以降（省略できる peer 依存で、サーバーは React なしで
`vastgrid/core` を使えます）と、CSS の `light-dark()` に対応したブラウザー（Chrome・Edge 123、Firefox 120、Safari 17.5 以降）が
要ります。エンジンには Node.js 20 以降が要り、DuckDB は Linux（x64・arm64、glibc・musl）、macOS（x64・arm64）、Windows（x64・arm64）
で動きます。

## 性能

Apple M2 Pro で測りました。メモリーエンジンの 100 万行を示したグリッドは、マウントから 36〜49 ms で最初の行を表示し、
スクロール中は React のコミットなしに 60 Hz でフレームを落としません。DuckDB エンジンは 1 億行の Parquet（1.38 GB）を並べ替えて
953 ms で最初の行をそろえ、並べ替えた 1,000 万行の CSV を 256 行ずつ 4 ms で読みます。すべての項目と計測の方法は
[性能](https://vastgrid.yhay81.com/ja/about/performance/) にあります。

## ドキュメント

- [vastgrid.yhay81.com](https://vastgrid.yhay81.com/ja/): ガイド、API リファレンス、デモ、ファイルを開くページ。
- [docs/](docs)（英語）: 仕様（エンジンと電文の [spec.md](docs/spec.md)、React パッケージの [react.md](docs/react.md)）、
  それぞれのアプリの作り、計測、[0.1 からの移行](docs/migrating-from-0.1.md)。
- [CHANGELOG.md](CHANGELOG.md)。今後の予定は [GitHub の issue](https://github.com/yhay81/vastgrid/issues) で管理しています。

## 開発に参加する

```sh
npm install
npm run build      # すべてのパッケージ、CLI のページ、MCP App、拡張機能
npm test           # 単体テスト（ソースのまま）
npm run dev        # examples/files: DuckDB エンジンの上のグリッド http://127.0.0.1:5182
```

確認の方法と変更の決まりは [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の報告は [SECURITY.md](SECURITY.md) にあります。

## ライセンス

MIT
