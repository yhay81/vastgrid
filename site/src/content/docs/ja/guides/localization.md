---
title: 言語と文言
description: グリッドの言語と数や日付の書式を選び、文言を差し替えます。
---

グリッドの文言は英語です。ほかの言語の文言は言語ごとに別の import で、`messages` に渡します。ページには表示する言語だけが入ります。`locale` は数や日付の書式のロケールを決めます。

```tsx
import { ja } from "vastgrid/locales/ja";

<DataGrid transport={transport} table="orders" locale="ja" messages={ja} />;
```

| import | 言語 |
| --- | --- |
| `import { ja } from "vastgrid/locales/ja"` | 日本語 |
| `import { zhHans } from "vastgrid/locales/zh-Hans"` | 中国語（簡体字） |
| `import { zhHant } from "vastgrid/locales/zh-Hant"` | 中国語（繁体字） |
| `import { ko } from "vastgrid/locales/ko"` | 韓国語 |
| `import { es } from "vastgrid/locales/es"` | スペイン語 |
| `import { ptBR } from "vastgrid/locales/pt-BR"` | ブラジルのポルトガル語 |
| `import { fr } from "vastgrid/locales/fr"` | フランス語 |
| `import { de } from "vastgrid/locales/de"` | ドイツ語 |
| `import { en } from "vastgrid/locales/en"` | 英語（既定） |

- 利用者の言語に合わせるには、`vastgrid/locales` がすべての組と、タグの言語で組を選ぶ `messagesFor(locale)` を返します。`messages={messagesFor(navigator.language)}` のように使います。`zh-Hant`・`zh-TW`・`zh-HK`・`zh-MO` は繁体字、それ以外の `zh` は簡体字、組のない言語は英語です。このときページには 9 つの組すべて、minify して約 50 KB が入ります。
- `locale` がなければ、数や日付はブラウザーの言語（`navigator.language`）に従います。サーバーには言語がありません。サーバーでグリッドを描くときは、ハイドレーションで何も変わらないように、要求の `locale` と同じ `messages` を渡してください。
- ステータスバーの個数・合計・平均はロケールの決まりに従います。`locale="de"` なら `1.234.567,5` と出ます。

列に書式がない間、セルは値をテキストの形（`1234567.5`、`2024-01-31 12:00:00`）で表示します。数の書式（数・パーセント・通貨、小数の桁、桁区切り）と `yyyy/MM/dd` のような日付の形は、列のメニューの「書式…」かドキュメントの列の設定で決め、グリッドのロケールで `Intl` が描きます。

## 文言を差し替える

`messages` は英語の文言に重なり、その一部を差し替えます。日本語の文言の一部を変えるには、`ja` に重ねます。数や名前が入る文言は関数で、それらは書式を付けた形で渡されます。

```tsx
<DataGrid
  transport={transport}
  table="orders"
  messages={{
    ...ja,
    grid: "注文",
    loading: "注文を読み込み中…",
    rows: (count) => `${count} 件の注文`,
  }}
/>
```

`messages` は英語の文言にメンバーごとに重なります。`exportFormats`、`operators`、`statisticNames`、`measureNames`、`pinned`、`alignments`、`numberStyles` のまとまりは丸ごと置き換わるので、まとまりの中の 1 つだけを変えるには、組のまとまりから始めます。

```tsx
import { DataGrid } from "vastgrid";
import { ja } from "vastgrid/locales/ja";

<DataGrid
  transport={transport}
  table="orders"
  messages={{ ...ja, measureNames: { ...ja.measureNames, avg: "平均値" } }}
/>;
```

## ほかの言語

vastgrid にない言語では、英語の組から始めてすべての文言を訳し、その言語のロケールと一緒に渡します。ロケールは書式に使います。

```tsx
import { DataGrid, type GridMessages } from "vastgrid";
import { en } from "vastgrid/locales/en";

const it: GridMessages = {
  ...en,
  grid: "Tabella dei dati",
  loading: "Caricamento…",
  rows: (count) => `${count} righe`,
  // …ほかのすべての文言
};

<DataGrid transport={transport} table="orders" locale="it" messages={it} />;
```

`GridMessages` は文言の組全体の型です。組は [`locales/`](https://github.com/yhay81/vastgrid/tree/main/packages/grid/src/locales) にあります。`it` はコンポーネントの外で一度だけ作ってください。ほかの言語への翻訳と、いまある訳の直しのプルリクエストも歓迎します。

## スクリーンリーダーの名前

グリッドは ARIA のグリッドです。名前は `messages.grid`（英語なら「Data table」、`ja` なら「データの表」）か、`aria-label` の prop です。

```tsx
<DataGrid transport={transport} table="orders" aria-label="2024 年の注文" />
```

エラーの文言は、エンジンかコマンドから英語で届きます。グリッドはそれを自分の文言 `failed` と `writeFailed` に引数として渡して表示します。自分の文言を出すには、`onError` と `dispatch` の結果が渡すエラーの `code` を使ってください。
