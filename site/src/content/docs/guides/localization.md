---
title: Languages and texts
description: Choose the grid's language and number formats, and replace its texts.
---

The grid has its texts in English and Japanese. The `locale` prop chooses them, and the number formats:

```tsx
<DataGrid source={source} locale="ja" />
```

- A locale that starts with `ja` shows the Japanese texts; any other shows the English ones.
- Numbers are grouped by the locale's rules: `locale="de"` shows `1.234.567,5` with English texts.
- Without `locale`, the grid uses the browser's language (`navigator.language`).

## Replacing texts

`messages` replaces some of the built-in texts. Texts with a count or a name are functions:

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

The groups `operators`, `stats`, `summary`, `types` and `notes` are replaced as a whole. To change one
text in a group, start from the built-in group:

```tsx
import { DataGrid, en } from "vastgrid";

<DataGrid source={source} messages={{ summary: { ...en.summary, sum: "Total" } }} />;
```

## Another language

For a language the grid does not have, start from `en` and translate every text, then pass the result
with the locale of the language for its number formats:

```tsx
import { DataGrid, en, type Messages } from "vastgrid";

const fr: Messages = {
  ...en,
  gridLabel: "Tableau de données",
  loading: "Chargement…",
  rows: (count) => `${count} lignes`,
  // …every other text
};

<DataGrid source={source} locale="fr" messages={fr} />;
```

`Messages` is the type of the whole set; [`messages.ts`](https://github.com/yhay81/vastgrid/blob/main/packages/react/src/messages.ts)
has both built-in sets. Translations of the built-in texts into more languages are welcome as pull
requests.

## Names for screen readers

The grid is an ARIA grid. Its name is `messages.gridLabel` ("Data table"), or the `aria-label` prop:

```tsx
<DataGrid source={source} aria-label="Orders of 2024" />
```
