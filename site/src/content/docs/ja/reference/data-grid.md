---
title: DataGrid
description: DataGrid のすべての props、制御・非制御の状態、ハンドル、GridProvider、フック、セルのフック。
---

```tsx
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders } }));

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

`DataGrid` は表を canvas に描き、スクロールに合わせてトランスポートから行を読み、仕様の[コマンド](/ja/reference/commands/)ですべてを行います。サーバーでもレンダリングできます（canvas はブラウザーでだけ描きます）。このページのもとは [React の仕様の §5](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#5-components-and-hooks) です。

## props

### データ

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `transport` | `Transport` | | エンジンのある場所（[トランスポート](/ja/reference/core/#トランスポート)）。`table` と一緒に渡します。 |
| `table` | `string` | | 開く表の `ref`。メモリエンジンの `tables` の名前か、DuckDB エンジンのファイル。 |
| `open` | `OpenOptions` | | `open` の `read` オプション。`sheet`、`headerRow`、`keepEmptyRows`、`keepEmptyColumns`。 |
| `store` | `GridStore` | | 外で作ったストア。`transport` と `table` の代わりに渡します。 |

グリッドは `transport`、`table`、`open` から自分のストアを一度だけ作り、マウントしている間だけ接続します。transport か table が変わると新しいストアを作ります。`store` も、`transport` と `table` もないときは例外を投げます。渡された `store` をグリッドは接続しません。接続まで行う `useCreateGridStore` で作るか、エフェクトの中で `connect()` を呼んでください。

### 状態

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `document` | `GridDocument` | | ビューとその列（[§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#51-document)）。制御されます。 |
| `defaultDocument` | `GridDocument` | 空のドキュメント | 最初のドキュメント。非制御です。 |
| `onDocumentChange` | `(document: GridDocument) => void` | | コマンドが作ったドキュメントを受け取ります。 |
| `session` | `GridSession` | | 人が今いる場所（[§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#52-session)）。制御されます。 |
| `defaultSession` | `GridSession` | 空のセッション | 最初のセッション。非制御です。 |
| `onSessionChange` | `(session: GridSession) => void` | | コマンドが作ったセッションを受け取ります。アクティブセルが動くたびに呼ばれます。 |
| `initial` | `InitialView \| Promise<InitialView>` | | サーバーで読んだ行（[`readInitialView`](/ja/reference/core/#vastgridserver)）。最初のフレームで描きます。Promise を渡すと、解決するまでグリッドはサスペンドし、グリッドと同じ大きさの読み込み中の要素を出します。 |

### UI

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `toolbar` | `boolean` | `true` | ツールバー。検索、条件、列、グループ、数式、詳細、書き出し、保存を、エンジンのケーパビリティに応じて出します。 |
| `statusBar` | `boolean` | `true` | ステータスバー。行数、読み込みの状況、選択範囲の個数・合計・平均、チェックした行、未保存や失敗した書き込み。 |
| `checkboxes` | `boolean` | `false` | 行ごとのチェックボックスを左端に、すべての行のチェックボックスを左上の角に出します。Space でアクティブな行をチェックします。 |
| `columnGroups` | `readonly ColumnGroup[]` | | 列名の上のヘッダー行に名前を出す列のグループ。入れ子にすると行が増えます。 |
| `groupHeaderHeight` | `number` | `--vg-group-header-height`（24） | グループの各行の高さ（CSS ピクセル）。 |
| `wrapLines` | `number` | `2` | 表示している列がテキストを折り返すとき（`format.wrap`）の行の行数。 |
| `detailPanel` | `ComponentType<DetailPanelProps>` | 行の列の一覧 | アクティブな行を表示する詳細パネルの中身。 |

### セル

これらは状態ではなく関数です。ドキュメントの書式やスタイルより優先され、画面にある読み込み済みのセルごとに、描くフレームのたびに呼ばれます。軽く、安定した関数（モジュールの関数か `useCallback`）にしてください。

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `cellText` | `(cell: GridCell) => string \| null \| undefined` | | グリッドの代わりにセルのテキストを返します。null か undefined ならグリッドのテキストのまま。 |
| `cellStyle` | `(cell: GridCell) => CellStyle \| null \| undefined` | | 列のスタイルルールの代わりにセルの色を返します。null か undefined ならルールのまま。 |
| `drawCell` | `(args: DrawCellArgs) => void` | | セルを canvas に描きます。`drawDefault()` も使えます。canvas の状態は後で元に戻ります。 |
| `cellAction` | `(cell: GridCell) => CellAction \| null \| undefined` | | セルをリンクやボタンにします。 |
| `onCellAction` | `(event: CellActionEvent) => void` | | `cellAction` がリンクやボタンにしたセルをクリックするか、Space を押したときに呼ばれます。 |

### 大きさ

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `rowHeight` | `number` | `--vg-row-height`（24） | 行の高さ（CSS ピクセル）。 |
| `headerHeight` | `number` | `--vg-header-height`（32） | ヘッダー行の高さ（CSS ピクセル）。 |

色、フォント、大きさは `vastgrid/styles.css` の CSS 変数で決まります（[テーマ](/ja/guides/theming/)）。

### 言語

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `locale` | `string` | ブラウザーの言語 | UI のテキストと数値の BCP 47 タグ。英語と日本語を内蔵しています。 |
| `messages` | `Partial<GridMessages>` | | `locale` のメッセージのうち置き換えるテキスト。 |

[ローカライズ](/ja/guides/localization/)を見てください。

### イベント

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `onError` | `(error: GridError) => void` | | どのコマンドにも属さない失敗。読み込みの失敗、読めない表など（[エラー](/ja/reference/core/#エラー)）。コマンド自身の失敗はその `CommandOutcome` に入ります。 |

### ルート要素

| props | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `ref` | `Ref<DataGridHandle>` | | ハンドル。 |
| `className` | `string` | | `vg-root` に加えるクラス。 |
| `style` | `CSSProperties` | | ルートのスタイル。ルートは `height: 100%` なので、ルートか親に高さを与えてください。 |
| `aria-label` | `string` | `messages.grid`（「データの表」） | グリッドのアクセシブルな名前。 |

## 制御と非制御の状態

[React の仕様の §5.2](https://github.com/yhay81/vastgrid/blob/main/docs/react.md#52-controlled-and-uncontrolled-state)。

- `defaultDocument` と `defaultSession` は最初の状態を与え、その後はグリッドが状態を持ちます。
- `document`（または `session`）を渡すと、グリッドは props を表示します。コマンドはグリッドがなるはずの状態を `onDocumentChange`（`onSessionChange`）で知らせ、親がそれを渡し返したときに表示します。親が別のものを渡したり、何も渡さなかったりすれば、親が優先されます。
- 親が再レンダリングする前にディスパッチしたコマンドは、最後に知らせた状態に適用されます。一つのイベントで二つのコマンドを送っても、どちらも効きます。
- 新しい props は、それを運ぶコミットのレイアウトエフェクトでストアに届きます。canvas が前のレンダリングの状態を見せることはありません。
- `onSessionChange` はアクティブセルが動くたびに呼ばれます。セッションを state に持つ親は、それを使って描くものを小さくするか、`useDeferredValue` を通して読んでください。

```tsx
const [document, setDocument] = useState<GridDocument>(saved);

<DataGrid transport={transport} table="orders" document={document} onDocumentChange={setDocument} />;
```

[状態](/ja/guides/state/)を見てください。

## ハンドル

```ts
interface DataGridHandle {
  store: GridStore;
  dispatch: GridStore["dispatch"];
  focus(): void; // グリッドにフォーカスを移す
}
```

`ref` でハンドルが得られます。それ以外はすべてストア（[vastgrid/core](/ja/reference/core/)）とコマンドを通します。

## フックと `GridProvider`

`GridProvider` は中のコンポーネントにストアを渡します。グリッドの横にホスト独自の操作部品を作るときに使います。`DataGrid` も自分の子に同じようにストアを渡しています。

```tsx
import { DataGrid, GridProvider, useCreateGridStore, useGridDispatch, useGridSelector } from "vastgrid";

function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <ClearSort />
      <DataGrid store={store} toolbar={false} />
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

| フック | 返すもの |
| --- | --- |
| `useGridStore()` | 最も近い `DataGrid` か `GridProvider` のストア。なければ例外を投げます。 |
| `useGridSelector(selector, isEqual?)` | `selector(snapshot)`。`isEqual`（既定は `Object.is`）で変わったときだけ再レンダリングします。 |
| `useGridDispatch()` | ストアの `dispatch`。毎回同じ関数です。 |
| `useGridRows({ start, end, columns })` | 画面のビューの行 `[start, end)` の値。一行ごとの配列で、まだ読んでいない値は `undefined`。足りなければ読み、届くと再レンダリングします。 |
| `useCreateGridStore(options)` | コンポーネントの間ずっと使うストア。最初の `GridStoreOptions` から一度だけ作り、マウントしている間だけ接続します。 |

- セレクターはストアが変わるたびに走るので、軽く、新しいオブジェクトを作らないようにします（`isEqual` で比べる場合を除きます）。`shallowEqual(a, b)` は二つのオブジェクトや配列のメンバーを `Object.is` で比べます：`useGridSelector((snapshot) => [snapshot.status, snapshot.view?.rowCount], shallowEqual)`。
- 行はスナップショットに入らず、ストアのキャッシュの中で変わります。`useGridRows` はそれを追いかけます。レンダリング中に行を読む関数は、行のバージョンを引数に取ります。`readRows(store, version, start, end, columns)` の `version` は `store.getRowsVersion()` から得ます。こうするとメモ化（React Compiler のものも）がバージョンの変化で読み直します。

## セルの型

```ts
interface GridCell {
  row: number; // 行のビューでの位置
  column: Column; // { name, type, … }
  value: JsonValue;
  text: string; // 列の書式に従ってグリッドが表示するテキスト
}

interface CellStyle {
  color?: string;
  background?: string;
  description?: string; // 色の意味（スクリーンリーダー向け）
}

interface CellAction {
  kind: "link" | "button";
  label?: string; // スクリーンリーダー向けの名前。セルのテキストの代わり
  cursor?: string; // セルの上の CSS カーソル。既定は "pointer"
}

interface DrawCellArgs extends GridCell {
  ctx: CanvasRenderingContext2D; // CSS ピクセル単位。セルのフォント、textBaseline "middle"、列の配置を設定済み
  rect: { x: number; y: number; width: number; height: number };
  style: CellStyle | null;
  theme: GridTheme; // グリッドの色とフォント
  drawDefault(): void; // グリッドと同じようにセルを描く
}

interface CellActionEvent extends GridCell {
  action: CellAction;
  key: RowKey | undefined; // セルの行のキー（読んでいれば）
}

interface ColumnGroup {
  name: string;
  children: (string | ColumnGroup)[]; // ビューの列名とグループ
}

interface DetailPanelProps {
  row: number; // アクティブな行の位置
  columns: readonly Column[]; // ビューの列
  values: readonly JsonValue[]; // `columns` の順の値
  rowKey: RowKey | undefined;
}
```

`CellHooks` は `cellText`、`cellStyle`、`drawCell`、`cellAction` をこれらの型でまとめたものです。

## 例

### 列のグループ

```tsx
import type { ColumnGroup } from "vastgrid";

const groups: ColumnGroup[] = [
  { name: "顧客", children: ["name", "email"] },
  { name: "注文", children: ["date", { name: "金額", children: ["net", "tax", "total"] }] },
];

<DataGrid transport={transport} table="orders" columnGroups={groups} />;
```

グループが変えるのはヘッダーだけです。グループは隣り合う列のまとまりの上に描くので、列を離して動かしたり、隠したり、別々に固定したりすると分かれ、それぞれに名前が出ます。グループのヘッダーをクリックすると、その列を選択します。

### セルのスタイルとアクション

```tsx
import type { CellAction, CellActionEvent, CellStyle, GridCell } from "vastgrid";

function cellStyle({ column, value }: GridCell): CellStyle | null {
  if (column.name === "balance" && typeof value === "number" && value < 0) {
    return { color: "#b42318", description: "マイナス" };
  }
  return null;
}

function cellAction({ column }: GridCell): CellAction | null {
  return column.name === "url" ? { kind: "link" } : null;
}

function onCellAction({ value }: CellActionEvent) {
  if (typeof value === "string") window.open(value, "_blank", "noopener");
}

<DataGrid transport={transport} table="accounts" cellStyle={cellStyle} cellAction={cellAction} onCellAction={onCellAction} />;
```

リンクはリンクの色で下線付きで描きます。スクリーンリーダーには、リンクやボタンとして `label` で伝わります。ほかのセルでの Space は、これまでどおり行をチェックします。

### 独自の詳細パネル

```tsx
import { Fragment } from "react";
import type { DetailPanelProps } from "vastgrid";

function OrderDetail({ columns, values }: DetailPanelProps) {
  return (
    <dl>
      {columns.map((column, index) => (
        <Fragment key={column.name}>
          <dt>{column.name}</dt>
          <dd>{String(values[index])}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

<DataGrid transport={transport} table="orders" detailPanel={OrderDetail} />;
```

パネルはツールバーの「詳細」ボタン、Alt+Enter、`detail.open` で開き、本体の横（幅が 640 ピクセルより狭いグリッドでは下）に出ます。アクティブな行を追いかけ、行の値をすべて読んでからコンポーネントを描きます。

### チェックした行

```tsx
function Orders() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <DataGrid store={store} checkboxes />
      <CheckedCount />
    </GridProvider>
  );
}

function CheckedCount() {
  const checked = useGridSelector((snapshot) => snapshot.session.checked);
  if (!checked) return <p>チェックした行はありません</p>;
  return <p>{checked.mode === "include" ? `${checked.keys.length} 行をチェック` : `${checked.keys.length} 行以外をチェック`}</p>;
}
```

行はキー（`{ rowId }`、またはドキュメントの `rowKey` の `{ value }`）でチェックするので、ビューを並べ替えたりフィルターしたりしても同じレコードがチェックされたままです。角のチェックボックスはビューのすべての行をチェックし（`check.all`）、すべてチェック済みなら外します（`check.clear`）。状態がわからない行にはダッシュが出ます。

## メッセージとキー

- `messagesFor(locale)` はロケールの内蔵テキストを返します。`ja` で始まるタグなら日本語、それ以外は英語です。`GridMessages` はその型で、テキストごとの文字列（`grid`、`loading`、`search`、`save` など）、数を含むテキストの関数（`rows(count)`）、一覧のレコード（`operators`、`exportFormats`、`measureNames`、`statisticNames`、`numberStyles`、`alignments`、`pinned`）からなります。`messages` はメンバーを丸ごと置き換えます。
- `keyCommand(event, apple)` はキー操作がグリッドで意味するコマンドか null を返し、`isApple()` はプラットフォームの主な修飾キーが ⌘ かどうかを返します。
