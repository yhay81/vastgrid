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
- **一つの状態と型の付いたコマンド。** グリッドが示すものは、ドキュメント（ビューと列）とセッション（利用者のいる場所）で、
  制御することもグリッドに任せることもできます。変更はすべてコマンドで、ツールバーもホストも AI エージェントも同じコマンドを送れます。
- **エンジンを選べる。** メモリーの `vastgrid-js`（ページの中でも Web Worker でも）、Node.js の `vastgrid-duckdb`、
  または少数の電文を話す独自のエンジン。
- **日本語と英語**の表示、CSS 変数によるライトとダーク、ARIA のグリッドの役割とキーボードだけでの操作。

## 使える場所

| 場所 | 使い方 | エンジン |
| --- | --- | --- |
| React のアプリ | `npm install vastgrid vastgrid-js`（[はじめかた](#はじめかた)） | メモリー、Worker、サーバー |
| ブラウザー | [vastgrid.yhay81.com/ja/open/](https://vastgrid.yhay81.com/ja/open/) にファイルを落とす。ファイルはブラウザーから出ません | Web Worker の `vastgrid-js` |
| コマンドライン | `npx vastgrid-cli sales.parquet` | このコンピューターの DuckDB |
| VS Code | 拡張機能 [vastgrid](packages/vscode)（`yhay81.vastgrid-vscode`） | 拡張機能の中の DuckDB |
| AI のチャット | MCP サーバー `vastgrid-mcp` とその MCP App | MCP サーバーの中の DuckDB |
| Jupyter のノートブック | `pip install vastgrid` のあと `vastgrid.show(df)` | カーネルの中の DuckDB |

形式・編集・保存・書き出しの違いは [docs/entries.ja.md](docs/entries.ja.md) で比べています。

**コマンドライン。** ファイルやフォルダーを、127.0.0.1 だけで答えるサーバーからブラウザーのグリッドで開きます。`--save` を付けると、
編集した CSV・TSV を ⌘S か Ctrl+S で保存できます（[docs/cli.md](docs/cli.md)）。

```sh
npx vastgrid-cli sales.parquet
npx vastgrid-cli --save data/
```

**VS Code。** Parquet と Excel は vastgrid で開き、CSV・TSV・JSON Lines は「Open in vastgrid」で開きます。CSV・TSV のセルは
VS Code の保存で保存し、VS Code の元に戻すで戻せます（[docs/vscode.md](docs/vscode.md)）。

**MCP App。** エージェントがファイルを開くと、利用者はチャットの中でそのグリッドを見て、両者が同じグリッドで作業します。
エージェントはグリッドの状態と行を読み、利用者のキー操作やメニューと同じコマンドを送ります（[docs/mcp-app.md](docs/mcp-app.md)）。

```json
{ "mcpServers": { "vastgrid": { "command": "npx", "args": ["-y", "vastgrid-mcp", "/path/to/data"] } } }
```

**ノートブック。** DataFrame・Arrow の表・DuckDB のリレーション・ファイルを JupyterLab 4 か Notebook 7 で開き、編集した表を
ノートブックで読み戻します（[docs/notebook.md](docs/notebook.md)）。

```python
import vastgrid

grid = vastgrid.show("sales.parquet")  # pandas や Polars の DataFrame も
grid.to_pandas(view=True)              # グリッドのビュー（編集したセルを含む）
```

## はじめかた

```sh
npm install vastgrid vastgrid-js
```

2.0.0 を公開するまでは、パッケージは npm の `next` タグのプレリリースで、`npm install vastgrid` では v1（0.1.x）が入ります。
この版は `npm install vastgrid@next vastgrid-js@next` で試せます（ほかのパッケージも `@next` を付けます）。

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

行は型の付いた JSON で、decimal は桁をそのまま保つ文字列、日付は `YYYY-MM-DD` で書きます
（[v2-spec.md §2.2](docs/v2-spec.md#22-values-in-json)）。メモリーエンジンは Apache Arrow と、CSV・TSV・JSON Lines・Excel・
Parquet のファイルも受け取ります（[vastgrid-js](packages/js)）。`editable: true` ならセルを書き込めます。書き込んだ値は `rows`
とは別に持ち、どのビュー・集計・書き出しもそれを読みます。

グリッドは状態を自分で持つことも、`document` と `onDocumentChange`（ビュー: プラン・列の幅・書式・固定）、`session` と
`onSessionChange`（選択・スクロール・元に戻す履歴）で制御することもでき、ホストはそれを保存して戻せます。すべては型の付いた
コマンドで、独自の部品も同じコマンドを送ります。

```tsx
import { DataGrid, GridProvider, useCreateGridStore, useGridDispatch, useGridSelector } from "vastgrid";

function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <ClearSort />
      <DataGrid store={store} style={{ height: 480 }} />
    </GridProvider>
  );
}

function ClearSort() {
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const dispatch = useGridDispatch();
  return (
    <button type="button" disabled={!sort} onClick={() => dispatch({ command: "sort.clear" })}>
      並べ替えを解除
    </button>
  );
}
```

props・フック・コマンドは [docs/v2-react.md](docs/v2-react.md) と [docs/v2-spec.md](docs/v2-spec.md) の §5〜§6 にあります。

## 大きなファイル

**Web Worker で。** メモリーエンジンはページの中と同じように Worker でも動くので、100 万行を並べ替えてもページは止まりません。
Parquet は、`File` からも HTTP の Range 要求に答える URL からも、グリッドが必要とする行グループごとに読みます。

```ts
// engine.worker.ts
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({ tables: { trips: { parquet: "https://example.com/trips.parquet" } } });
serveEngine(engine, self as unknown as WorkerLike);
```

```tsx
import { DataGrid, workerTransport } from "vastgrid";

const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
const transport = workerTransport(worker);

export function Trips() {
  return <DataGrid transport={transport} table="trips" style={{ height: 600 }} />;
}
```

利用者が落とした・選んだファイルは Worker に送り、`{ file }`（CSV・TSV・JSON Lines・Excel）か `{ parquet: file }` として渡します。
[ファイルを開くページ](site/src/components/open/engine-worker.ts)がその例です。まるごと読む列は `maxBytes`（既定は 1 GiB）に
収め、それを超えるテキストのファイルはまとまりごとに読みます。

**サーバーの DuckDB で。** `vastgrid-duckdb` は Node.js でどんな大きさのファイルも開きます。Parquet はファイルのまま読み、CSV・TSV・
JSON Lines・Excel は DuckDB に読み込みながら、最初の行をすぐに読めるようにします。許可したフォルダーの中にあるファイルだけを、
リンクをたどった実際の場所で確かめて読み、DuckDB の拡張は読み込まず、SQL には値をすべてパラメーターで渡します。

```ts
// server.ts
import { createServer } from "node:http";
import { createHttpHandler, DuckDBEngine } from "vastgrid-duckdb";

const engine = await DuckDBEngine.create({
  allowedDirectories: ["/srv/data"],
  tempDirectory: "/tmp/vastgrid",
  saveFiles: true, // 編集した CSV・TSV をグリッドから保存できるようにする
});
createServer(createHttpHandler(engine, { path: "/api" })).listen(8080);
```

```tsx
import { DataGrid, httpTransport } from "vastgrid";

const transport = httpTransport("/api", { events: "/api/events" });

export function Sales() {
  return <DataGrid transport={transport} table="sales.csv" style={{ height: 600 }} />;
}
```

この受け口は Express・Connect・Vite のミドルウェアとしても使えます。`serverFunctionTransport` なら React の Server Function を通して
電文を運び、`vastgrid/server` の `readInitialView` はサーバーで最初の行を読みます。グリッドはそれを HTML で送り、ブラウザーで
キャンバスに引き継ぎます（v2-react.md §7）。

## 編集と保存

エンジンが守ること（[v2-spec.md §7](docs/v2-spec.md#7-editing)）:

- **型での検証。** 入力や貼り付けの文字は、桁を失わずに列の型で読みます（数値の列に貼り付けた `1,234.5` は 1234.5）。型に合わない
  値ではエディターを開いたままにし、理由を示します。
- **不可分の書き込みと競合の確認。** 一つの書き込みは、すべてのセルを変えるか一つも変えないかです。各セルは編集前の値を持ち、
  その間にほかの人が変えていれば書き込みは失敗し、グリッドは［再試行］［上書き］［破棄］を示します。
- **元に戻す・やり直す。** 入力・消去・貼り付け・埋める操作を 100 手まで。MCP App ではエージェントの書き込みも戻せます。
- **保存までは別に持つ。** 書き込んだセルは保存するまでファイルに入らず、どのビュー・絞り込み・集計・検索・書き出しもそれを読みます。
- **ほかのバイトを保つ保存。** `save` は CSV・TSV の編集したフィールドだけを書き直し、BOM・引用符・区切り・改行・文字コード
  （Shift_JIS や UTF-16 も）を保ちます。一時ファイルに書いてから元のファイルに置き換えるので、失敗した保存はファイルを元のまま残し、
  読んだあとにほかの人が変えたファイルには保存しません。
- **ディスク上で変わったファイル**は読み直します。未保存の編集がある表は読んだときのまま残し、ファイルが変わったことを示し、
  ［編集を破棄して再読み込み］で読み直します。

ほかの形式には保存しません。編集を含めて CSV・TSV・Parquet・JSON・Excel に書き出します。

## 機能

- **読む。** 複数の列での並べ替え（見出しのクリック、Shift で列を足す）、値の一覧（件数つき）や条件による列の絞り込み、
  「条件」メニューでの列をまたぐ AND・OR の入れ子の条件、すべての列の検索ボックス、検索（⌘F）、列の統計。
- **形を変える。** 列でのグループ化と、件数・異なる値の数・合計・平均・標準偏差・最小・最大・分位数の集計、値を列にするピボット、
  集計行、「計算列」メニューで追加する計算式の列（`qty * price`）。
- **列。** 見出しごとのメニュー（矢印・右クリック・Alt+↓）で並べ替え・絞り込み・統計・集計・グループ化・幅の調整・左右への固定・
  非表示。見出しのドラッグで移動、端のドラッグで幅を変え、「列」メニューで表示・非表示と移動、`columnGroups` で見出しにグループの段。
- **書式。** 列の「書式…」で、表示名・配置・折り返し・数値・パーセント・通貨の書式、日付のパターン（`yyyy/MM/dd`）、条件付きの色。
- **選択と編集。** マウスと Excel のキー操作での範囲の選択（複数の範囲も）、TSV と HTML でのコピー、表計算ソフトからの貼り付け、
  下・右へ埋める操作、選択範囲の件数・合計・平均。
- **行。** 並べ替えや絞り込みのあとも同じレコードのチェックを保つチェックボックス（`checkboxes`）と、アクティブな行の詳細パネル
  （Alt+Enter、または独自の `detailPanel`）。
- **書き出し。** ビューか表全体を CSV・TSV・JSON・Excel（列の数値と日付の書式つき）に、DuckDB のエンジンなら Parquet にも。
  DuckDB のエンジンはファイルをサーバーに書きます。
- **独自のセル。** `cellText`・`cellStyle`・`drawCell`（グリッドの描画を使いながらキャンバスに描く）・`cellAction`（リンクやボタン、
  `onCellAction` で受ける）。
- **言語。** `locale` で英語と日本語、`messages` でどの文言も置き換えられます。
- **見た目。** 色・文字・大きさはすべて `.vg-root` の CSS 変数で、キャンバスもそれを読みます。色は `light-dark()` の組で、ページの
  ライト・ダークに従います。

  ```css
  .my-app .vg-root {
    --vg-font-family: "Hiragino Sans", sans-serif;
    --vg-accent: var(--brand);
    --vg-selection-bg: color-mix(in srgb, var(--brand) 15%, transparent);
  }
  ```

- **アクセシビリティ。** ARIA のグリッドのパターンに沿い、画面の行をキャンバスの下にアクセシブルな行として置き、アクティブな
  セルを `aria-activedescendant` で示し、結果をライブリージョンで読み上げます。
- **サーバーでの描画。** 最初の行を HTML の表にし、Server Component から流して送ります。Strict Mode と並行レンダリングに対応し、
  すべてのコンポーネントを React Compiler でコンパイルしています。

### キー操作

| キー | 操作 |
| --- | --- |
| 矢印・Page Up/Down・Home/End | アクティブなセルを動かす。⌘/Ctrl と一緒なら最初・最後の行や列へ |
| Shift ＋ 上のキー・Shift ＋ クリック・⌘/Ctrl ＋ クリック | 選択を広げる・範囲を足す |
| Tab・Enter（Shift で逆向き） | 選択の中を動く |
| ⌘/Ctrl ＋ A | すべてを選ぶ |
| ⌘/Ctrl ＋ C・⌘/Ctrl ＋ V | コピー・貼り付け |
| 文字の入力・F2・ダブルクリック | アクティブなセルを編集する（Enter で確定、Esc で取り消し） |
| Delete・⌘/Ctrl ＋ D・⌘/Ctrl ＋ R | 選択したセルを消去・下へ埋める・右へ埋める |
| ⌘/Ctrl ＋ Z・⌘/Ctrl ＋ Shift ＋ Z か Ctrl ＋ Y | 元に戻す・やり直す |
| ⌘/Ctrl ＋ S | 保存（エンジンがファイルに保存できるとき） |
| ⌘/Ctrl ＋ F | 検索 |
| Alt ＋ ↓・Shift ＋ F10 | 列のメニュー・セルのメニュー |
| Space・Alt ＋ Enter | アクティブな行をチェック（`checkboxes` のとき）・詳細パネル |

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
| [`vastgrid-vscode`](packages/vscode) | VS Code の拡張機能（Marketplace） |
| [`vastgrid`（Python）](packages/notebook/python) | Jupyter のウィジェット（PyPI） |

npm のパッケージは同じ版でそろえて公開します。`vastgrid` には React 19.3 以降（省略できる peer 依存で、サーバーは React なしで
`vastgrid/core` を使えます）と、CSS の `light-dark()` に対応したブラウザー（Chrome・Edge 123、Firefox 120、Safari 17.5 以降）が
要ります。エンジンには Node.js 20 以降が要り、DuckDB は Linux（x64・arm64、glibc・musl）、macOS（x64・arm64）、Windows（x64・arm64）
で動きます。

## 性能

Apple M2 Pro で測りました。Chromium で、メモリーエンジンの 100 万行 × 8 列の表を示したグリッドの結果です
（[v2-react.md 付録 A](docs/v2-react.md#a2-in-the-browser)。`e2e/budgets.spec.ts` が予算と照らして確かめます）。

| 項目 | 時間 |
| --- | ---: |
| マウントから最初の行の表示まで | 36〜49 ms |
| キーを押してから次のフレームまで（95 パーセンタイル） | 13.4〜14.1 ms |
| スクロール中のフレームの間隔（95 パーセンタイル） | 16.7〜16.8 ms（60 Hz でフレームを落とさない） |
| 100 フレームのスクロール中の React のコミット | 0 |
| float の列で並べ替えて行を表示するまで: エンジンがページの中・Web Worker | 85〜98 ms・112〜113 ms |
| その間のページの最長のタスク: エンジンがページの中・Web Worker | 81〜93 ms・なし |

Node.js 24・DuckDB 2.0・8 スレッド・メモリー 2 GB の DuckDB エンジンで、HTTP を含めず、8 列の 256 行ずつ読んだ 3 回の中央値です
（[v2-views-benchmark.md](docs/v2-views-benchmark.md)）。

| ファイルとビュー | 最初の行 | ビューの任意の位置の 256 行（中央値） |
| --- | ---: | ---: |
| Parquet 1.38 GB・1 億行、float の列で並べ替え | 834 ms | 957 ms |
| Parquet 1 億行、絞り込み | 207 ms | 31 ms |
| CSV 735 MB・1,000 万行、並べ替え | 63 ms | 6.3 ms |
| CSV 1,000 万行、絞り込み | 144 ms | 4.9 ms |

編集した 2 セルの保存は、6 MB の CSV で約 60 ms、65 MB で 0.3 秒です。並べ替えた 100 万行のビューの書き出しは CSV で 0.3 秒、
Parquet で 0.1 秒です。メモリーエンジンは 100 万行の Parquet を 26 ms、CSV を約 1 秒で開きます
（[v2-memory-engine-benchmark.md](docs/v2-memory-engine-benchmark.md)）。ページが最初に読み込む `DataGrid` とメモリーエンジンは
gzip で約 100 KB で、メニューとパネルは開いたときに読み込みます。

## v1 からの移行

vastgrid 2.0 は 0.1.x を置き換えます。グリッドは v1 の source ではなくエンジンとトランスポートから読み、状態はドキュメントと
セッションになり、別々だった core と browser のパッケージはなくなりました（その中身は `vastgrid/core` と `vastgrid-js` にあります）。
`vastgrid-duckdb` はこの版の DuckDB エンジン（`DuckDBEngine`、`createHttpHandler`）になりました。`vastgrid-spec` の
`migrateGridState` は v1 で保存したグリッドの状態を読み、計算式は v1 の書き方のまま使えます。v1 の機能がどこに移ったかは
[docs/v2-from-v1.md](docs/v2-from-v1.md) にまとめています。

## ドキュメント

- [vastgrid.yhay81.com](https://vastgrid.yhay81.com/ja/): ガイド、デモ、ファイルを開くページ。
- [docs/entries.ja.md](docs/entries.ja.md): React コンポーネント・ブラウザーのページ・コマンドライン・VS Code・MCP App・
  ノートブックの比較。それぞれの詳細は [cli.md](docs/cli.md)・[vscode.md](docs/vscode.md)・[mcp-app.md](docs/mcp-app.md)・
  [notebook.md](docs/notebook.md)（英語）。
- [docs/v2-react.md](docs/v2-react.md): React の API（ストア、トランスポート、`DataGrid`、フック、描画、サーバーでの描画）。
- [docs/v2-spec.md](docs/v2-spec.md): 値と型、プラン、ドキュメントとセッション、コマンド、編集と保存、グリッドとエンジンの間の電文。
- [CHANGELOG.md](CHANGELOG.md)。今後の予定は [GitHub の issue](https://github.com/yhay81/vastgrid/issues) で管理しています。

## 開発

```sh
npm install
npm run build      # すべてのパッケージ、CLI のページ、MCP App、拡張機能
npm test           # 単体テスト（ソースのまま）
npm run e2e        # ビルドに対する Playwright
npm run dev        # examples/files: DuckDB エンジンの上のグリッド http://127.0.0.1:5182
npm run dev -w vastgrid-site   # サイト、デモ、/ja/open/ http://localhost:4321
```

確認と計測には `npm run typecheck`・`npm run lint`・`npm run bench` も使います。変更の前に [CONTRIBUTING.md](CONTRIBUTING.md) を
読んでください。

## ライセンス

MIT
