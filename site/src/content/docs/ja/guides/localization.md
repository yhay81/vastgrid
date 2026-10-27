---
title: 言語と文言
description: グリッドの言語と数や日付の書式を選び、文言を差し替えます。
---

グリッドの文言には英語と日本語があります。`locale` の prop がそれと、数や日付の書式のロケールを決めます。

```tsx
<DataGrid transport={transport} table="orders" locale="ja" />
```

- `ja` で始まるロケールなら日本語、それ以外なら英語の文言です。
- `locale` がなければ、ブラウザーの言語（`navigator.language`）を使います。サーバーには言語がないので英語で描きます。サーバーでグリッドを描くときは、ハイドレーションで文言が変わらないように、要求の `locale` を渡してください。
- ステータスバーの個数・合計・平均はロケールの決まりに従います。`locale="de"` なら、英語の文言のまま `1.234.567,5` と出ます。

列に書式がない間、セルは値をテキストの形（`1234567.5`、`2024-01-31 12:00:00`）で表示します。数の書式（数・パーセント・通貨、小数の桁、桁区切り）と `yyyy/MM/dd` のような日付の形は、列のメニューの「書式…」かドキュメントの列の設定で決め、グリッドのロケールで `Intl` が描きます。

## 文言を差し替える

`messages` は、グリッドの言語の組み込みの文言の一部を差し替えます。数や名前が入る文言は関数で、それらは書式を付けた形で渡されます。

```tsx
<DataGrid
  transport={transport}
  table="orders"
  messages={{
    grid: "注文",
    loading: "注文を読み込み中…",
    rows: (count) => `${count} 件の注文`,
  }}
/>
```

`messages` は組み込みの文言にメンバーごとに重ねます。`exportFormats`、`operators`、`statisticNames`、`measureNames`、`pinned`、`alignments`、`numberStyles` のまとまりは丸ごと置き換わるので、まとまりの中の 1 つだけを変えるには、`messagesFor` で組み込みのまとまりから始めます。

```tsx
import { DataGrid, messagesFor } from "vastgrid";

const built = messagesFor("ja");

<DataGrid
  transport={transport}
  table="orders"
  messages={{ measureNames: { ...built.measureNames, avg: "平均値" } }}
/>;
```

## ほかの言語

グリッドにない言語では、英語の組から始めてすべての文言を訳し、その言語のロケールと一緒に渡します。ロケールは書式に使います。

```tsx
import { DataGrid, type GridMessages, messagesFor } from "vastgrid";

const fr: GridMessages = {
  ...messagesFor("en"),
  grid: "Tableau de données",
  loading: "Chargement…",
  rows: (count) => `${count} lignes`,
  // …ほかのすべての文言
};

<DataGrid transport={transport} table="orders" locale="fr" messages={fr} />;
```

`GridMessages` は文言の組全体の型で、`messagesFor(locale)` は組み込みの組を返します。両方の組は [`messages.ts`](https://github.com/yhay81/vastgrid/blob/main/packages/grid/src/react/messages.ts) にあります。`fr` はコンポーネントの外で一度だけ作ってください。ほかの言語への翻訳のプルリクエストも歓迎します。

## スクリーンリーダーの名前

グリッドは ARIA のグリッドです。名前は `messages.grid`（「データの表」）か、`aria-label` の prop です。

```tsx
<DataGrid transport={transport} table="orders" aria-label="2024 年の注文" />
```

エラーの文言は、エンジンかコマンドから英語で届きます。グリッドはそれを自分の文言 `failed` と `writeFailed` に引数として渡して表示します。自分の文言を出すには、`onError` と `dispatch` の結果が渡すエラーの `code` を使ってください。
