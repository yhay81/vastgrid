# vastgrid

[![npm](https://img.shields.io/npm/v/vastgrid)](https://www.npmjs.com/package/vastgrid)
[![CI](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/yhay81/vastgrid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/yhay81/vastgrid)](LICENSE)

数 GB・数億行の CSV・TSV・Parquet・JSON Lines と Excel のブックを開けて、表計算ソフトのように扱える React のデータグリッドです。

**[デモを試す](https://vastgrid.yhay81.com/ja/demo/)** · [ドキュメント](https://vastgrid.yhay81.com/ja/) · [English](README.md)

[![1 億行の Parquet を絞り込み・並べ替えし、列の統計と選択範囲の集計を表示した画面](docs/images/playground.jpg)](https://vastgrid.yhay81.com/ja/demo/)

- **どんな大きさでも開ける。** 行はスクロールに合わせて、まとまりごとに読みます。1.4 GB・1 億行の Parquet は 20 ms で開き、
  735 MB の CSV は読み込みの途中でも 0.15 秒で最初の行を表示します。
- **速い。** セルはキャンバスに描きます。1,000 セル以上を表示しても 1 フレーム約 2 ms です。ブラウザーの要素の高さの上限を越えて、
  数十億行までスクロールできます。
- **表計算ソフトの操作。** マウスと Excel のキー操作での範囲の選択、コピー（TSV・HTML・Markdown）、複数の列での並べ替え、
  値の一覧（検索・件数つき）と条件での絞り込み、列をまたぐ AND・OR と入れ子の条件、すべての列からの絞り込み、検索（⌘F）、列の統計、選択範囲のデータの個数・合計・平均・最小・最大、エンジンが計算する計算列（`qty * price`）、列での行のグループ化（件数・合計・平均・最小・最大）と集計行（計算はエンジン側）、現在のビューの CSV・TSV・Parquet・JSON・Excel への書き出し。
- **エンジンを選べる。** グリッドは `TableSource` とだけやり取りします。ディスク上のファイルは DuckDB のサーバー（`vastgrid-duckdb`）、
  ブラウザーで開くファイルと URL の Parquet は `vastgrid-browser`、メモリ上のデータは `ArraySource`、ほかのエンジンは自作の `TableSource` で扱えます。
- **安全。** DuckDB のエンジンは、リンクをたどった実際の場所が許可したフォルダーの中にあるファイルだけを読み、実行中は変えられません。SQL はすべて組み立てたもので、値は必ずパラメーターで渡します。
- **日本語と英語**の表示、CSS 変数によるライトとダーク、ARIA のグリッドの役割とキーボードだけでの操作。

## パッケージ

| パッケージ | 内容 |
| --- | --- |
| [`vastgrid`](packages/react) | React の `DataGrid`（キャンバスの描画・操作・メニュー・絞り込み・統計） |
| [`vastgrid-core`](packages/core) | 表のプロトコル、行のキャッシュ、選択とスクロールの写像、書式、`ArraySource`・`RemoteSource`。フレームワークに依存しない |
| [`vastgrid-duckdb`](packages/duckdb) | DuckDB を使う Node.js の表のサーバーと、Fetch API の受け口 |
| [`vastgrid-browser`](packages/browser) | ローカルの Parquet・CSV・TSV・JSON Lines と、URL の Parquet（HTTP Range）を Web Worker で読む。サーバー不要 |

## 動作環境

- **`vastgrid`**: React 18 以降と、CSS の `light-dark()` に対応したブラウザー（Chrome・Edge 123、Firefox 120、Safari 17.5 以降）。
- **`vastgrid-duckdb`**: Node.js 20 以降。DuckDB のバイナリがある Linux（x64・arm64、glibc・musl）、macOS（x64・arm64）、
  Windows（x64・arm64）で動きます。
- **`vastgrid-browser`**: モジュールの Worker に対応したブラウザー（Chrome・Edge 80、Firefox 114、Safari 15 以降）と、
  `new Worker(new URL(…, import.meta.url))` を扱えるバンドラー。特別なヘッダー（COOP/COEP）は要りません。
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

### ブラウザーで開くファイル（サーバーなし）

```sh
npm install vastgrid vastgrid-browser
```

```tsx
import { DataGrid } from "vastgrid";
import { BrowserSource } from "vastgrid-browser";
import { useEffect, useState } from "react";

// 利用者が選んだファイル（<input type="file">）か、URL の Parquet
export function Table({ file }: { file: File }) {
  const [source, setSource] = useState<BrowserSource | null>(null);
  useEffect(() => {
    const next = new BrowserSource({ file }); // URL なら { url: "https://example.com/data.parquet" }
    setSource(next);
    return () => next.close(); // Worker を終える
  }, [file]);
  return <div style={{ height: 600 }}>{source && <DataGrid source={source} locale="ja" />}</div>;
}
```

ファイルはブラウザーの外に出ません。Web Worker がグリッドの表示する部分を読み、ローカルのファイルなら並べ替え・
絞り込み・集計も行います。URL の Parquet は HTTP Range で読み、表全体を読む操作は `fullScan: true` のときだけ使えます。
詳しくは[ブラウザーで開くファイル](https://vastgrid.yhay81.com/ja/guides/browser/)を参照してください。

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
| `headerHeight` | `number` | `--vg-header-height` か 32 | 列名の段の高さ（px）。`columnGroups` の段は、この上に加わります。 |
| `columnGroups` | `ColumnGroup[]` | | 列名の上の段に名前を出す列のグループ。入れ子にすると段が増えます。 |
| `groupHeaderHeight` | `number` | `--vg-group-header-height` か 24 | グループの段 1 段の高さ（px）。 |
| `maxLines` | `number` | `3` | 折り返す列（`columnFormats` の `wrap`）のセルに表示する最大の行数（1〜20）。 |
| `nullText` | `string` | `""` | null のセルに表示する文字。 |
| `frozenColumns` | `number` | `0` | 表を開いたときに左に固定する列の数。 |
| `frozenRightColumns` | `number` | `0` | 表を開いたときに右に固定する列の数。最後の列から数え、グリッドの右端に表示します。 |
| `toolbar` | `boolean` | `true` | 検索欄、適用中の絞り込み、行数を表示します。 |
| `statusBar` | `boolean` | `true` | アクティブなセルと選択範囲の集計を表示します。 |
| `reloadKey` | `unknown` | | 値を変えると表を読み直します。ディスク上のファイルが変わったときなどに使います。変更を通知する source は自動で読み直されます。 |
| `followTail` | `boolean` | `false` | 表が変わったとき、最後の行を表示していれば新しい末尾を表示します（`tail -f` のように追記された行を追います）。 |
| `copyLimit` | `number` | `1000000` | 一度にコピーできるセルの数（選択したすべての範囲の合計）。 |
| `columnFormats` | `Record<string, ColumnFormat>` | | スキーマの列名ごとの表示設定。表示名、数値と日時の書式、配置、整形関数、折り返し。 |
| `copyValues` | `"raw" \| "formatted"` | `"raw"` | コピーするのを、値とスキーマの列名にするか、表示している文字と表示名にするか。 |
| `exportOptions` | `GridExportOptions \| false` | `{}` | 書き出しパネル。ファイルの行き先（`target`、`onExported`）と出す形式を決めます。`false` で隠します。 |
| `drawCell` | `(args: DrawCellArgs) => void` | | 表示中の読み込み済みのセルを、グリッドの代わりに描きます。`args.drawDefault()` で標準の描画を呼べます。 |
| `cellAction` | `(cell: GridCellContent) => CellAction \| null` | | セルをリンクやボタンにします。ポインター、下線、スクリーンリーダー向けの役割を付け、クリックと Space で `onCellClick` を呼びます。 |
| `onQueryChange` | `(query: ViewQuery) => void` | | 並べ替え・絞り込み・検索が変わったときに呼ばれます。 |
| `onSelectionChange` | `(event: GridSelectionEvent) => void` | | 選択範囲かアクティブなセルが変わったときに呼ばれます。 |
| `onColumnsChange` | `(event: GridColumnsEvent) => void` | | 列の幅・順序・表示・固定が変わったときに呼ばれます。 |
| `onCellClick`、`onCellDoubleClick` | `(event: GridCellEvent) => void` | | セルのクリック（または Space）とダブルクリック（または F2）で呼ばれます。ダブルクリックで `preventDefault()` を呼ぶと、セルの詳細（またはセルのエディター）を開きません。 |
| `readOnly` | `boolean` | `false` | source がセルを書き込める場合も、編集を提供しません。 |
| `validateCell` | `(cell: GridCellValidation) => string \| null \| undefined \| Promise<…>` | | 書き込む前に値を検証します。拒否するときはメッセージを返します。 |
| `onCellsChange` | `(event: GridCellsChangeEvent) => void` | | 編集したセルの保存が済んだとき、または失敗したときに呼ばれます。 |
| `onHistoryChange` | `(state: GridHistoryState) => void` | | 元に戻せる・やり直せる操作が変わったときに呼ばれます。 |
| `formulas` | `FormulaColumn[]` | | 計算列（`{ name, expression }`）。最初と、違う値を渡したときに適用します。 |
| `onFormulasChange` | `(formulas: FormulaColumn[]) => void` | | 計算列が追加・編集・削除されたときに呼ばれます。 |
| `initialState` | `GridState` | | グリッドを作るときに、表の列がわかった時点で適用する設定。 |
| `onStateChange` | `(state: GridState) => void` | | クエリーか列の設定が変わったときに、その設定を渡して呼ばれます。 |
| `checkboxSelection` | `boolean` | `false` | 行ごとのチェックボックスと、左上にすべての行のチェックボックスを表示します。 |
| `rowKey` | `string` | 行の位置 | 行を識別する値（主キー）の列名。データが新しくなっても行の選択が残ります。 |
| `rowSelection` | `RowSelection` | | 選択する行。最初と、違う値を渡したときに適用します。 |
| `onRowSelectionChange` | `(event: GridRowSelectionEvent) => void` | | ユーザー・アプリ・グリッドが行の選択を変えたときに呼ばれます。 |
| `detailOpen`、`defaultDetailOpen` | `boolean` | `false` | アクティブな行のすべての列を表示する詳細パネルを開きます（制御する値、または最初の状態）。 |
| `onDetailOpenChange` | `(open: boolean) => void` | | 利用者か handle が詳細パネルを開閉したときに呼ばれます。 |
| `detailPanel` | `ComponentType<DetailPanelProps>` | `DetailFields` | 詳細パネルの中身を差し替えます。 |
| `className`、`style` | | | ルートの要素（`.vg-root`）に付けます。 |
| `aria-label` | `string` | `messages.gridLabel` | スクリーンリーダー向けのグリッドの名前。 |

ref からは `DataGridHandle` を使えます。`focus()`、`reload()`、`getQuery()`、`setQuery(query)`、`getState()`、
`applyState(state)`、`goToRow(row)`、`undo()`、`redo()`、`history`、`save()`、`openDetail({ focus })`、`closeDetail()`、`detailOpen`、`openExport()`、`getFormulas()`、`setFormulas(formulas)`、`getRowSelection()`、`setRowSelection(selection)`、グリッドの状態を持つ `controller`、キャンバスの `renderer`（`renderer.timings()`
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

// (1 列目が東京 または 2 列目が 10 万超) かつ 3 列目が「取消」以外。
grid.current?.setQuery({
  filters: [{ type: "values", column: 2, values: ["取消"], exclude: true }],
  where: {
    type: "or",
    filters: [
      { type: "values", column: 0, values: ["東京"] },
      { type: "compare", column: 1, op: "gt", value: 100_000 },
    ],
  },
});
```

`filters` はすべてに合う行を残し、`where` は `and`・`or` のグループ（8 段まで入れ子にできます）でできた条件木で、これにも合う行を残します。
画面では、ツールバーの「条件…」と、列の絞り込みパネルの「条件を追加（AND / OR）」で組み立て、ツールバーに表示された条件から確認・変更・解除できます。
条件木は `capabilities.conditions` を報告する source（DuckDB のエンジン、`vastgrid-browser`、`ArraySource`）でだけ使い、それ以外では使いません。

### 列の固定

`frozenColumns` は表示中の最初の列を左に、`frozenRightColumns` は最後の列（合計や操作の列など）を右に固定し、その間の列をスクロールします。
列のメニューとツールバーの「列」パネルで左右どちらにも固定でき、アプリからは `controller.setColumnPin(column, "left" | "right" | null)` で固定できます。
固定列はグリッドの幅の 4 分の 3 までを使い、超えるときは右、次に左の固定列を、グリッドが広がるまでスクロールする列として表示します。
`GridState` と `onColumnsChange` は両側を含み（`frozenRightColumns`、`GridColumn.pin`）、`frozenColumns` だけで保存した状態もそのまま適用できます。
詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#列の固定)を参照してください。

```tsx
<DataGrid source={source} frozenColumns={1} frozenRightColumns={2} />
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

コピーには値とスキーマの列名が入ります。表示している文字と表示名をコピーするには、`copyValues="formatted"`（列ごとには `copy`）を指定します。

`wrap: true` を指定した列は、文字を `maxLines`（既定は 3）行まで折り返して表示します。空白と、日本語・中国語・韓国語の文字の間、値の中の改行で行を改め、収まらない分は「…」で示します。行の高さは全行で同じ（表示中の列が折り返す間は `rowHeight` に 2 行目以降の 1 行ごとに `--vg-line-height` を足した高さ）なので、行数にかかわらずスクロールは正確です。詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#列の表示設定)を参照してください。

### 列のグループ

`columnGroups` で、列名の上の段に列のグループの名前を出します（複数段の見出し）。メンバーはスキーマの列名か入れ子のグループで、入れ子 1 段ごとに見出しの段が 1 つ増えます。変わるのは見出しだけで、並べ替え・絞り込み・列のメニュー・選択・イベント（`col` と `column`）・`GridState` は、これまでどおり列に対して動きます。

```tsx
const groups: ColumnGroup[] = [
  { name: "売上", children: [
    { name: "第1四半期", children: ["jan", "feb", "mar"] },
    { name: "第2四半期", children: ["apr", "may", "jun"] },
  ] },
];

<DataGrid source={source} columnGroups={groups} groupHeaderHeight={24} />;
```

グループは列に付いて動きます。列の移動・非表示・固定で、グループの表示中の列が離れたり、固定する列とスクロールする列に分かれたりすると、見出しを分けて、それぞれに名前を出します。グループの見出しをクリックするとその列を選び（Shift で広げ、⌘/Ctrl で追加）、選んだグループの見出しをドラッグすると列をまとめて動かします。コピーと書き出しの見出しは 1 段（列名）のままです。詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#列のグループ)を参照してください。

### 詳細パネル

詳細パネルは、アクティブな行のすべての列を、列の表示名と書式付きの値で表示します。グリッドの横に、グリッドの幅が 640px より狭いときは下に表示し、行の高さは変えません。アクティブなセル（`onSelectionChange` の `active`）に追従し、表の中で途中まで表示している文字列は、その行について少し待ってから全体を読み込みます。別の行へ移ると読み込みを取り消します。並べ替え・絞り込みのあとは、新しいアクティブな行（先頭の行）を表示します。変更された表を読み直したときは、アクティブな行をそのままにして、そのレコードを読み込み直します。Alt ＋ Enter かセルのメニューで開き、もう一度 Alt ＋ Enter でパネルへフォーカスを移し、Esc で閉じます。中身はコンポーネントで差し替えられます。

```tsx
function Customer({ values, schema, status, rowId }: DetailPanelProps) {
  if (status === "loading") return <p>読み込んでいます…</p>;
  const field = (name: string) => values[schema.findIndex((column) => column.name === name)];
  return <CustomerCard id={rowId} name={String(field("name"))} notes={String(field("notes"))} />;
}

<DataGrid source={source} defaultDetailOpen detailPanel={Customer} />;
```

大きさは `--vg-detail-width` と `--vg-detail-height` で変えられます。詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#詳細パネル)を参照してください。

### 変わるファイル

source が「表が変わった」と通知すると、グリッドは表を読み直します。クエリー・列の設定・スクロール位置・アクティブなセルはそのままです。`RemoteSource` はグリッドが表を表示している間、2 秒ごとにサーバーに問い合わせます。`vastgrid-duckdb` は、ファイルのサイズ・更新日時・先頭のハッシュで、行の追記や書き換えを検出します。続けて届いた通知は 1 回の読み直しにまとめます。

```tsx
const source = useMemo(
  () => new RemoteSource({ endpoint: "/api/table", ref: "logs/app.csv", changes: pollChanges({ interval: 1000 }) }),
  [],
);

<DataGrid source={source} followTail />; // 行が追記される間、末尾を表示し続ける
```

通知されるのは表全体の変更だけで、行ごとの差分は通知しません。グリッドは表全体を読み直し、DuckDB ではファイルを読み込み直します。`changes: false` で監視をやめられ、別の `ChangeTransport`（たとえば Server-Sent Events を受け取るもの）でポーリングを置き換えられます。`BrowserSource` は URL のファイルを `ETag`・`Last-Modified`・サイズで監視します（`changeInterval`、既定 5 秒）。ローカルのファイルは監視できません。ディスク上で変わった `File` をブラウザーが読めなくなるためです。

### セルの色と独自の描画

列の `style` で、標準の描画のまま値に応じて文字色と背景色を変えられます。`drawCell` はセルの矩形・値・型・表示の文字・選択の状態・テーマを受け取ってキャンバスに直接描き、先に標準の描画を呼ぶこともできます。`cellAction` はセルをリンクやボタンにします。上ではポインターが変わり、リンクには下線を引き、アクティブなセルにはスクリーンリーダー向けに `link` か `button` の役割を付け、クリックと Space で `onCellClick` を呼びます（Enter と矢印キーは表計算と同じくセルを移動します）。どのフックも、画面に表示している読み込み済みのセルにだけ呼ばれます。

```tsx
const formats: Record<string, ColumnFormat> = {
  balance: { style: (value) => (Number(value) < 0 ? { color: "#b42318", background: "#fdecea", description: "残高不足" } : null) },
};
const drawCell: DrawCell = (args) => {
  args.drawDefault();
  if (args.schema.name === "status" && args.value === "new") {
    args.ctx.fillStyle = args.theme.accent;
    args.ctx.fillRect(args.rect.x + 2, args.rect.y + 6, 3, args.rect.height - 12);
  }
};
const cellAction: CellActionHook = (cell) => (cell.schema.name === "url" ? { kind: "link", label: `${cell.text} を開く` } : null);

<DataGrid
  source={source}
  columnFormats={formats}
  drawCell={drawCell}
  cellAction={cellAction}
  onCellClick={(event) => event.column === urlColumn && window.open(String(event.value))}
/>;
```

詳しくは [DataGrid のリファレンス](https://vastgrid.yhay81.com/ja/reference/data-grid/#セルの色と独自の描画)を参照してください。

### 行の選択（チェックボックス）

`checkboxSelection` を指定すると、セルの選択とは別に、行ごとのチェックボックスで行を選べます。選んだ行はキーで記録するので、並べ替えや絞り込みをしても同じレコードが選ばれたままで、絞り込みで隠れた行の選択も残ります。キーは標準ではファイルでの行の位置（`rowId`）で、`TableInfo.revision` が同じあいだだけ有効です。revision が変わると選択をすべて外します。`rowKey` で列を指定すると、その列の値がキーになり、データが新しくなっても選択が残ります。なくなった行のキーは、アプリかユーザーが外すまで残ります。

左上のチェックボックスは、キーを並べずにすべての行を選びます。`{ type: "exclude", keys: [] }` は表の `keys` 以外のすべての行で、絞り込みか検索をしているときは、その条件に合うすべての行（`query: { filters, search }`）です。その条件（にさらに条件を足したもの）で絞り込んだビューでは行ごとの状態を表示し、そうでないビューでは、条件に合う行が 10 万行までならキーを並べた選択に変えます（理由は `query`）。それより多いときは選択をそのまま残し、その行は状態が不明として表示します。行の選択は `GridState` に含みません。

```tsx
const [checked, setChecked] = useState<RowSelection>({ type: "include", keys: [] });

<DataGrid
  source={source}
  checkboxSelection
  rowKey="order_id"
  rowSelection={checked}
  onRowSelectionChange={({ selection, count }) => {
    setChecked(selection);
    showCount(count); // 絞り込み条件に合う行を数えていないあいだは null
  }}
/>;
```

### 書き出し

ツールバーの「書き出し」で、現在のビュー（表示中の絞り込み・検索・並べ替えのとおり）か表全体を、表示中の列（表示順）かすべての列で、source が対応する形式（`info().exports`）に書き出すパネルが開きます。DuckDB のサーバーは CSV・TSV・Parquet・JSON・Excel のファイルを許可したフォルダーに書くので（`resolveTarget` があるときだけ）、大きな結果がブラウザーを通りません。`ArraySource` は CSV・TSV・JSON・Excel のファイルを返し、ブラウザーでダウンロードします。Excel ファイルは依存なしでストリームとして書き、`columnFormats` の表示名を見出しに、数値・日時の書式を表示形式にします。文字を数式として書くことはなく、1,048,575 行を超えると断ります。

```tsx
<DataGrid
  source={source}
  exportOptions={{
    // サーバーが resolveTarget で解決する。そのあとファイルをダウンロードできるようにする。
    target: ({ request }) => `exports/${request.target}`,
    onExported: (result) => window.location.assign(`/downloads/${encodeURIComponent(result.target)}`),
  }}
/>
```

詳しくは[書き出し](https://vastgrid.yhay81.com/ja/guides/export/)を参照してください。

### セルの編集

グリッドは、セルを書き込める source（`capabilities.edit`）を編集できます。`editable: true` の `ArraySource` と、エンジンを `editable: true` で作った DuckDB サーバーが対応し、それ以外の source は読み取り専用のままです。文字を入力するとアクティブセルの値を置き換え（エディターはセルに重なるテキスト欄なので IME も使えます）、F2 かダブルクリックで編集し、Enter か Tab で確定して移動、Esc で取り消し、Delete で選択したセルを消去し、⌘/Ctrl + V で Excel や Google スプレッドシートからコピーした範囲（タブ区切りか HTML の表）をすべての値を検証してから貼り付けます。⌘/Ctrl + D と ⌘/Ctrl + R は選択範囲の先頭の行・列で下・右を埋め、⌘/Ctrl + Z と ⌘/Ctrl + Shift + Z は、書き込み単位（貼り付けや埋める操作は 1 回）で型と桁を保ったまま元に戻し、やり直します。値は桁を失わずに列の型で検証し（64 ビット整数と decimal は文字列のまま）、`validateCell`（非同期も可）でも検証します。保存中の書き込みは画面に表示し、失敗や他の利用者の変更との競合では［再試行］［上書き］［破棄］を選べます。DuckDB サーバーは `saveFiles` を指定すると、編集したセルを CSV・TSV ファイルに書き戻せます（⌘/Ctrl + S）。編集したフィールドだけを書き直し、ほかのバイト（引用符の中の改行、Shift_JIS などの文字コード、末尾の改行）はそのまま保ちます。一時ファイルを経由し、その間に他の人が変えたファイルには保存しません。書き込み後は行を読み直し、並べ替えや絞り込みが書き込んだ列を使うときは並べ替え・絞り込みもやり直します。統計・集計・書き出しも新しい値を読みます。DuckDB エンジンは、書き込んだ値を保存するまでファイルとは別に保持します。

```tsx
<DataGrid source={new ArraySource({ columns, rows, editable: true })} onCellsChange={(event) => save(event)} />
```

[セルの編集](https://vastgrid.yhay81.com/ja/guides/editing/)を参照してください。

### 計算列

列メニューの「計算列を追加…」で、`qty * price` や `IF(due < '2024-07-01', '遅れ', '')` のような式で行ごとに計算する列を追加できます。計算は source が行い（DuckDB のエンジンは SQL で計算し、表をブラウザーに移しません）、ファイルの列と同じように並べ替え・絞り込み・統計・選択範囲の集計・書き出しができます。編集画面は入力中の式を確かめ、間違いを示します。式は独自の小さな言語（列名、四則演算、文字列をつなぐ `&`、比較、`AND`・`OR`・`NOT`、数値・文字列・日時・空白の関数）で、JavaScript や SQL として実行することはありません。エンジンは引用した列名・パラメーター・決まった関数の一覧だけで SQL を作ります。

```tsx
<DataGrid
  source={source}
  formulas={[
    { name: "total", expression: "qty * price" },
    { name: "税込", expression: "ROUND(total * 1.1, 2)" },
  ]}
  onFormulasChange={(formulas) => save(formulas)}
/>
```

計算列は表の列の後ろに並び（式 `i` は列 `info.columns.length + i`）、`GridState` に保存され、列名で付け直されます。DuckDB のエンジンと `ArraySource` が計算します（`capabilities.formulas`）。`vastgrid-browser` はまだ対応していません。詳しくは[計算列](https://vastgrid.yhay81.com/ja/guides/formulas/)を参照してください。
### グループ化と集計

ツールバーの「グループ化」で、絞り込みで残る行を 1 つ以上の列でまとめ、グループを表として表示します。キーの列のあとに件数・合計・平均・最小・最大が並びます。列のメニューの「下端の集計行に表示…」で、列の集計値を行の下に固定した行に表示します。どちらも source が計算します（`group`、`capabilities.group`）。対応するのは `ArraySource`、DuckDB のサーバー（組み立てた 1 つの SQL）、`fullScan` の `vastgrid-browser` です。結果は `limit` グループまで（既定 1,000）で、整数と decimal の合計は正確です。クロス集計では選んだ列の値を列にし（`東京 / sum(amount)`）、200 列を超えるときは通知して拒否します。どれも `GridState` に保存します。

```ts
const result = await source.group({ view: null, keys: [0], aggregates: [{ fn: "count" }, { fn: "sum", column: 2 }] });
// { columns: [region, count(*), sum(amount)], rows: [["東京", 120, "53210.50"], …], groups: 47, truncated: false }
```

詳しくは[グループ化と集計](https://vastgrid.yhay81.com/ja/guides/grouping/)を参照してください。同じ上限付きの結果を、好きなライブラリで描くグラフに渡し、グリッドの絞り込みと並べ替えに追従させられます。vastgrid 自体はグラフライブラリに依存しません。[グラフ](https://vastgrid.yhay81.com/ja/guides/charts/)と、playground の「Chart」パネルを参照してください。

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

2280 × 1371 px（56 行 × 20 列）の描画は、フレームごとにキャンバスを確定させて測り、中央値 2.0 ms・99 パーセンタイル 3.0 ms でした。列の `style`、`cellAction`、標準の描画に印を足す `drawCell` を使っても、1,349 セルの 1 フレームは測定のばらつきの範囲に収まりました（使わないときの 2.7〜2.8 ms に対して 2.5〜2.8 ms）。

## 仕組み

- **スクロール。** キャンバスの上に透明のスクロール用の要素を重ね、ホイール・トラックパッド・スクロールバーはブラウザーの動きのままにします。
  要素の高さの上限（Chromium で約 1,677 万 px）を越えるため、`ScrollAxis` が小さな移動はそのまま、大きな移動と両端は比例で写します。
- **読み込み。** グリッドは毎フレーム、見えている行と列を伝えます。`RowCache` は足りないまとまり（256 行 × 48 列）を、見えている所から、
  1 画面先と前まで読み、遠ざかった要求は取り消し、古いまとまりから捨てます。
- **エンジン。** 区切りのテキストと JSON は、セッションの DuckDB のファイルに表として読み込みます。読み込み中も先頭の 1,000 行を表示します。
  Parquet はファイルのまま、行の位置で読みます。Shift_JIS・EUC-JP・BOM 付き UTF-16（両方のバイト順）は先に UTF-8 に変換します。
  並べ替え・絞り込みの結果は、2,000 万行までは並べ替えた表を（取り出し 2 ms）、それを超えると行の順番だけを作ります（数分かかる処理が数秒に、一時領域も数分の 1 に）。
  100 万行以上の表の並べ替えでは、完成したビューと同じ順番の先頭 1,000 行を先に取り出して 1 秒ほどで表示し、残りを背景で作ります。
- **プロトコル。** `RemoteSource` は小さな JSON のプロトコル（[docs/protocol.md](docs/protocol.md)）を話し、サーバーが表やビューを忘れた場合（再起動など）は開き直します。

## キー操作

| キー | 操作 |
| --- | --- |
| 矢印・Page Up/Down・Home/End | アクティブなセルを動かす |
| ⌘/Ctrl ＋ 矢印・⌘/Ctrl ＋ Home/End | 最初・最後の行や列へ移る |
| Shift ＋ 上のキー・Shift ＋ クリック | 選択を広げる |
| ⌘/Ctrl ＋ クリック | 範囲を足す（行または列が同じ範囲はまとめてコピーできる） |
| Tab・Enter（Shift で逆向き） | 選択の中を動く |
| Shift ＋ Space・Ctrl ＋ Space・⌘/Ctrl ＋ A | 行・列・すべてを選ぶ |
| Space・⌘/Ctrl ＋ Shift ＋ Space（`checkboxSelection` のとき） | アクティブな行・すべての行のチェックを切り替える（Shift ＋ クリックで範囲） |
| ⌘/Ctrl ＋ C・⌘/Ctrl ＋ Shift ＋ C | コピー・見出しを含めてコピー |
| ⌘/Ctrl ＋ F | 検索 |
| Alt ＋ ↓ | 列のメニュー（並べ替え・絞り込み・統計・左右の固定・非表示） |
| F2・ダブルクリック | セルの値の全体を表示（編集できるグリッドでは編集） |
| 文字の入力・Delete・⌘/Ctrl + V（編集できるグリッド） | アクティブセルの値を置き換える・選択したセルを消去・貼り付け |
| ⌘/Ctrl + D・⌘/Ctrl + R（編集できるグリッド） | 選択範囲の先頭の行・列で下方向・右方向へコピー |
| ⌘/Ctrl + Z・⌘/Ctrl + Shift + Z か Ctrl + Y（編集できるグリッド） | 最後の書き込みを元に戻す・やり直す |
| ⌘/Ctrl + S（`saveFiles` の DuckDB サーバーなど、保存できる source） | 編集したセルをファイルに保存 |
| Alt ＋ Enter（もう一度でパネルへ）・Esc | アクティブな行の詳細パネルを開く・閉じる |
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

未公開のv2の作り直しは [#33](https://github.com/yhay81/vastgrid/issues/33) で管理しています。v2ではArrowで保てない値を拒否し、float32への文字入力は書き込み前に丸め、桁あふれはエラーにします。詳しくは [v2仕様](docs/v2-spec.md#22-values-in-json) を参照してください。v2のDuckDBエンジンは、CSV・TSV・Parquet・JSON・Excelのセルを書き込みます。書き込んだ値は保存するまでファイルと分けて持ち、競合を検出し、グリッドで取り消せます（§7.2）。CSV・TSVへの保存では、編集していないバイトをそのまま保ちます（§7.5）。

これまでの予定（バイト単位で保つ CSV への書き戻しを含むセルの編集、式の列）は実装済みです。今後の予定は GitHub の issue で管理しています。

既存のビューワーとグリッドの調査は [docs/research.ja.md](docs/research.ja.md) にあります。

## ライセンス

MIT
