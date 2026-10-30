---
title: Languages and texts
description: Choose the grid's language and its number and date formats, and replace its texts.
---

The grid shows English texts. The texts of another language are each their own import, given to `messages`, so
that a page bundles only the languages it shows; `locale` chooses the locale of number and date formats:

```tsx
import { ja } from "vastgrid/locales/ja";

<DataGrid transport={transport} table="orders" locale="ja" messages={ja} />;
```

| Import | Language |
| --- | --- |
| `import { ja } from "vastgrid/locales/ja"` | Japanese |
| `import { zhHans } from "vastgrid/locales/zh-Hans"` | Chinese, simplified characters |
| `import { zhHant } from "vastgrid/locales/zh-Hant"` | Chinese, traditional characters |
| `import { ko } from "vastgrid/locales/ko"` | Korean |
| `import { es } from "vastgrid/locales/es"` | Spanish |
| `import { ptBR } from "vastgrid/locales/pt-BR"` | Brazilian Portuguese |
| `import { fr } from "vastgrid/locales/fr"` | French |
| `import { de } from "vastgrid/locales/de"` | German |
| `import { en } from "vastgrid/locales/en"` | English, the default |

- To follow the user's language, `vastgrid/locales` gives every set and `messagesFor(locale)`, which chooses one by
  a tag's language: `messages={messagesFor(navigator.language)}`. Traditional characters are for `zh-Hant`,
  `zh-TW`, `zh-HK` and `zh-MO`, simplified ones for any other `zh`, and English for a language without a set. The
  page then bundles all nine sets, about 50 KB minified.
- Without `locale`, numbers and dates use the browser's language (`navigator.language`). On a server it has none:
  when you render the grid on the server, pass the `locale` of the request, and the same `messages`, so that
  nothing changes when the page hydrates.
- The counts, sums and averages of the status bar follow the locale's rules: `locale="de"` shows `1.234.567,5`.

Cells show values in their text form (`1234567.5`, `2024-01-31 12:00:00`) until a column has a format. A
number format (number, percent or currency, with decimal places and digit grouping) and a date pattern such as
`yyyy/MM/dd` are set from Format… in the column menu, or in the document's column settings, and they are drawn
with `Intl` in the grid's locale.

## Replacing texts

`messages` replaces some of the built-in texts of the grid's language. Texts with a count or a name are
functions, which receive them already formatted:

```tsx
<DataGrid
  transport={transport}
  table="orders"
  messages={{
    grid: "Orders",
    loading: "Loading orders…",
    rows: (count) => `${count} orders`,
  }}
/>
```

`messages` is merged over the built-in set member by member. The groups `exportFormats`, `operators`,
`statisticNames`, `measureNames`, `pinned`, `alignments` and `numberStyles` are replaced as a whole, so to change
one text in a group, start from the group of a set:

```tsx
import { DataGrid } from "vastgrid";
import { en } from "vastgrid/locales/en";

<DataGrid
  transport={transport}
  table="orders"
  messages={{ measureNames: { ...en.measureNames, avg: "Mean" } }}
/>;
```

## Another language

For a language that vastgrid does not have, start from the English set and translate every text, then pass the
result with the locale of the language for its formats:

```tsx
import { DataGrid, type GridMessages } from "vastgrid";
import { en } from "vastgrid/locales/en";

const it: GridMessages = {
  ...en,
  grid: "Tabella dei dati",
  loading: "Caricamento…",
  rows: (count) => `${count} righe`,
  // …every other text
};

<DataGrid transport={transport} table="orders" locale="it" messages={it} />;
```

`GridMessages` is the type of the whole set. The sets are in
[`locales/`](https://github.com/yhay81/vastgrid/tree/main/packages/grid/src/locales). Make `it` once, outside the
component. Translations into more languages, and corrections of these, are welcome as pull requests.

## Names for screen readers

The grid is an ARIA grid. Its name is `messages.grid` ("Data table"), or the `aria-label` prop:

```tsx
<DataGrid transport={transport} table="orders" aria-label="Orders of 2024" />
```

The messages of errors come from the engine or the commands, in English. The grid shows them inside its own
texts, `failed` and `writeFailed`, which receive them as their argument; `onError` and the outcome of `dispatch`
give the error's `code` for texts of your own.
