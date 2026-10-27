---
title: Languages and texts
description: Choose the grid's language and its number and date formats, and replace its texts.
---

The grid has its texts in English and Japanese. The `locale` prop chooses them, and the locale of number and
date formats:

```tsx
<DataGrid transport={transport} table="orders" locale="ja" />
```

- A locale that starts with `ja` shows the Japanese texts; any other shows the English ones.
- Without `locale`, the grid uses the browser's language (`navigator.language`). On a server it has none, and
  renders English: when you render the grid on the server, pass the `locale` of the request, so that the texts do
  not change when the page hydrates.
- The counts, sums and averages of the status bar follow the locale's rules: `locale="de"` shows `1.234.567,5`
  with English texts.

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
one text in a group, start from the built-in group with `messagesFor`:

```tsx
import { DataGrid, messagesFor } from "vastgrid";

const built = messagesFor("en");

<DataGrid
  transport={transport}
  table="orders"
  messages={{ measureNames: { ...built.measureNames, avg: "Mean" } }}
/>;
```

## Another language

For a language the grid does not have, start from the English set and translate every text, then pass the
result with the locale of the language for its formats:

```tsx
import { DataGrid, type GridMessages, messagesFor } from "vastgrid";

const fr: GridMessages = {
  ...messagesFor("en"),
  grid: "Tableau de données",
  loading: "Chargement…",
  rows: (count) => `${count} lignes`,
  // …every other text
};

<DataGrid transport={transport} table="orders" locale="fr" messages={fr} />;
```

`GridMessages` is the type of the whole set, and `messagesFor(locale)` gives a built-in one;
[`messages.ts`](https://github.com/yhay81/vastgrid/blob/main/packages/grid/src/react/messages.ts) has both. Make
`fr` once, outside the component. Translations into more languages are welcome as pull requests.

## Names for screen readers

The grid is an ARIA grid. Its name is `messages.grid` ("Data table"), or the `aria-label` prop:

```tsx
<DataGrid transport={transport} table="orders" aria-label="Orders of 2024" />
```

The messages of errors come from the engine or the commands, in English. The grid shows them inside its own
texts, `failed` and `writeFailed`, which receive them as their argument; `onError` and the outcome of `dispatch`
give the error's `code` for texts of your own.
