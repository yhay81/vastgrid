---
title: 状態と自作の操作部品
description: 表示の設定を JSON のドキュメントとして保存・復元し、React から制御し、自作のボタンからコマンドでグリッドを動かします。
---

グリッドが表示するものはすべて 2 つのただの JSON から決まり、それを変えるのはすべてコマンドです。アプリは JSON を好きな場所に持ち、グリッドのメニューやキーと同じコマンドを送れます。

- **ドキュメント**は表示の設定です。プラン（計算列、条件、グループ、並べ替え）と列の設定（幅、非表示、固定、書式、合計）、それに `rowKey` を持ちます。利用者が保存したり、共有したり、エージェントに渡したりするものです。
- **セッション**は利用者がいる場所です。アクティブなセル、選択範囲、スクロールの位置、チェックした行、詳細パネル、開いている編集欄、元に戻す履歴を持ちます。

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "plan": {
    "where": { "fn": "eq", "args": [{ "col": "region" }, { "lit": "EU" }] },
    "sort": [{ "column": "total", "direction": "desc" }]
  },
  "columns": [{ "name": "id", "pin": "left" }, { "name": "total", "width": 120, "total": { "fn": "sum" } }]
}
```

すべてのメンバーは[仕様の §5](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#5-state) にあります。型は `GridDocument` と `GridSession` で、`vastgrid` からエクスポートしています。

## 表示の設定を残す

グリッドに最初のドキュメントを渡し、グリッドが知らせるドキュメントを保存します。

```tsx
import { DataGrid, type GridDocument } from "vastgrid";

function load(): GridDocument | undefined {
  const text = localStorage.getItem("orders-view");
  return text ? (JSON.parse(text) as GridDocument) : undefined;
}

export function Orders() {
  return (
    <DataGrid
      transport={transport}
      table="orders"
      defaultDocument={load()}
      onDocumentChange={(document) => localStorage.setItem("orders-view", JSON.stringify(document))}
    />
  );
}
```

`defaultDocument` を読むのは、グリッドがストアを作るときです。その後はグリッドがドキュメントを持ち、変わるたびに `onDocumentChange` を呼びます。保存した後に列が変わった表でドキュメントを開くと、ドキュメントは直されます。表に合わなくなった条件、グループ、並べ替えのキー、計算列を外し、残りはそのまま使います（[§5.5](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#55-repairing-a-document-for-a-table)）。

ドキュメントはバージョン 2 です。vastgrid 0.1 で保存した状態はそのままでは読めません。`vastgrid-spec` の `migrateGridState` でドキュメントにします（[v1 からの移行](/ja/migrating-from-v1/)）。

## 表示の設定を制御する

`document` を渡すと、グリッドはその prop を表示します。コマンドは作ったドキュメントを `onDocumentChange` に知らせ、それを渡し返すとグリッドが表示します。

```tsx
const [document, setDocument] = useState<GridDocument>(initial);

<DataGrid transport={transport} table="orders" document={document} onDocumentChange={setDocument} />;
```

- 別のものを渡し返せば、外から表示を変えられます。保存した表示、リンクの表示、エージェントが作った表示などです。何も渡し返さなければ、コマンドは効きません。
- 1 つのイベントの中の 2 つのコマンドは両方効きます。2 つ目は、1 つ目が知らせたドキュメントに対して働きます。
- `session`、`defaultSession`、`onSessionChange` も同じです。`onSessionChange` はアクティブなセルが動くたびに呼ばれるので、セッションを状態に持つ親は、それで描き直す部分を小さくするか、`useDeferredValue` を通して読んでください。

## 自作の操作部品

`useCreateGridStore` は、コンポーネントが生きている間のストアを作ります。グリッドには `store` で、自作のコンポーネントには `GridProvider` で渡します。その中では、`useGridSelector` で状態を読み、`useGridDispatch` で変えます。

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

コマンドは、名前と引数を持つオブジェクトです。TypeScript が確かめます。

```ts
dispatch({ command: "sort.set", keys: [{ column: "total", direction: "desc" }] });
dispatch({ command: "filter.column", column: "region", where: { fn: "eq", args: [{ col: "region" }, { lit: "EU" }] } });
dispatch({ command: "column.pin", name: "id", side: "left" });
dispatch({ command: "select", row: 0, column: "total" });
```

`dispatch` はすぐに状態を変え、コマンドに必要なものをエンジンに送り、`{ ok: true, output }` か `{ ok: false, error }` で解決します。reject はせず、失敗したコマンドは何も変えません。すべてのコマンドは[コマンド](/ja/reference/commands/)にあります。

グリッド自身のコンポーネントと、`DataGrid` の中に描くコンポーネント（詳細パネル）は、プロバイダーなしで同じストアを読みます。外からは、`ref` でハンドル `{ store, dispatch, focus }` を受け取れます。

### スナップショットの中身

`useGridSelector(selector)` は、ストアのスナップショットに `selector` を適用します。スナップショットが書き換わることはありません。

| メンバー | 中身 |
| --- | --- |
| `document`、`session` | 上の状態 |
| `table` | 開いている表。ID、列、行数、リビジョン、読み込み中かどうか、エンジンの機能。開くまでは null |
| `view` | 画面のビュー。行数、それが確定しているか、列、`status`（`"building"` か `"ready"`） |
| `displayed` | 表示している列と設定を、表示の順で |
| `pending` | 読んでいる途中のプラン。その間、前のビューは画面に残ります |
| `status` | `"idle"`、`"opening"`、`"ready"`、`"error"` |
| `error`、`failedWrite` | どのコマンドにも属さない最後の失敗と、最後に失敗した書き込み |
| `totals` | 合計行の値。なければ null |

セレクターは軽くして、新しいオブジェクトを作らないでください。作るときは、それを比べる `isEqual` を渡します。`useGridSelector((snapshot) => [snapshot.status, snapshot.view?.rowCount], shallowEqual)` です。行はスナップショットに入っていません。`useGridRows` で読みます（[グラフ](/ja/guides/charts/)で使っています）。

## React なしで

`vastgrid/core` には React を使わないストアがあります。ほかのフレームワークのホスト、テスト、サーバーで使えます。

```ts
import { createGridStore } from "vastgrid/core";

const store = createGridStore({ transport, table: "orders" });
const disconnect = store.connect(); // 表を開いてビューを読む
const stop = store.subscribe(() => console.log(store.getSnapshot().view?.rowCount));

const outcome = await store.dispatch({ command: "search.set", text: "Tokyo" });

stop();
disconnect(); // 表を閉じる
```

ストアを作るだけでは何も開きません。開くのは `connect` で、返す関数でまた表を閉じます。`setDocument` と `setSession` は外から渡した状態を表示します。ストアのほかのメソッドは [vastgrid/core と vastgrid/server](/ja/reference/core/) にあります。
