---
title: 言語と文言
description: グリッドの言語と数値の書式を選び、文言を置き換えます。
---

グリッドの文言には、英語と日本語があります。`locale` の props で、文言と数値の書式を選びます。

```tsx
<DataGrid source={source} locale="ja" />
```

- `ja` で始まるロケールでは日本語の文言を、それ以外では英語の文言を表示します。
- 数値はロケールの規則で桁を区切ります。`locale="de"` では、文言は英語のまま、数値を `1.234.567,5` のように表示します。
- `locale` がなければ、ブラウザーの言語（`navigator.language`）を使います。

## 文言の置き換え

`messages` で、組み込みの文言の一部を置き換えられます。件数や名前が入る文言は関数です。

```tsx
import { DataGrid } from "vastgrid";

<DataGrid
  source={source}
  messages={{
    gridLabel: "Orders",
    noRows: "No orders match",
    rows: (count) => `${count} orders`,
  }}
/>;
```

`operators`・`stats`・`summary`・`types`・`notes` のまとまりは、まとめて置き換わります。まとまりの中の 1 つだけを変えるには、組み込みのまとまりをもとにします。

```tsx
import { DataGrid, en } from "vastgrid";

<DataGrid source={source} messages={{ summary: { ...en.summary, sum: "Total" } }} />;
```

## ほかの言語

グリッドにない言語では、`en` をもとにすべての文言を訳し、その結果を、数値の書式に使うその言語のロケールと一緒に渡します。

```tsx
import { DataGrid, en, type Messages } from "vastgrid";

const fr: Messages = {
  ...en,
  gridLabel: "Tableau de données",
  loading: "Chargement…",
  rows: (count) => `${count} lignes`,
  // …ほかのすべての文言
};

<DataGrid source={source} locale="fr" messages={fr} />;
```

`Messages` は文言の全体の型です。組み込みの 2 つの組は [`messages.ts`](https://github.com/yhay81/vastgrid/blob/main/packages/react/src/messages.ts) にあります。組み込みの文言をほかの言語に訳したプルリクエストを歓迎します。

## スクリーンリーダー向けの名前

グリッドは ARIA のグリッドです。その名前は `messages.gridLabel`（日本語では「データの表」、英語では "Data table"）か、props の `aria-label` です。

```tsx
<DataGrid source={source} aria-label="Orders of 2024" />
```
