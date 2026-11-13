# Proposals for the open questions

The questions that [§12 of the specification](spec.md#12-open-questions) leaves open, each with what holds
today, what the sources give, the choices, and the one proposed. Each part becomes spec text, conformance cases and
engine code only once it is chosen. Checked against DuckDB 2.0.0, Node.js 26 and Python's DuckDB 2.0.0.

Width and kana folding (`fold` in §3.4, §3.5 and §4.4) and extended dates and infinities (`-290308-12-22` to
`+294247-01-10`, `infinity` and `-infinity` in §2.2, §2.4, §3.6, §3.8 and §7.3) shipped in 0.4.0.

## 1. Nested types: lists, structs and maps

### Today

§2.1 maps lists, structs, maps, unions and JSON to `string`, with DuckDB's text, `sourceType` and `readOnly`.
That text loses what the value is. DuckDB writes `['a', 'b c', NULL]` as `[a, b c, NULL]`, so a null and the
string `NULL` look the same, and `{'a': 1, 'b': 'x'}` as `{'a': 1, 'b': x}`. Sorting the text sorts `[10]` before
`[9]`. `vastgrid-js` reads JSON Lines objects and lists as their JSON text, and fails Arrow tables with nested
columns (`load_failed`). A `histogram` measure would give a list, so it waits for these types.

### Proposal

Add three types and keep the others as they are:

| Type | Schema members | JSON | Arrow | From DuckDB |
| --- | --- | --- | --- | --- |
| `list` | `items`: a column type without a name | an array | List, LargeList | `T[]`, `T[n]` |
| `struct` | `fields`: columns | an object by field name | Struct | `STRUCT(...)` |
| `map` | `keys`, `values`: column types | an array of `[key, value]` pairs | Map | `MAP(K, V)` |

- **Values.** A map is pairs, not an object, because its keys may be numbers or dates. Items, fields and values
  follow §2.2 for their own types, nulls included. Unions and JSON stay `string`.
- **Text form (§2.4).** Use DuckDB's text only to show a cell, never as data: `[1, 2]`, `{'a': 1, 'b': x}`,
  `{k=1}`. Search (§3.5) reads that text.
- **Comparison and order (§3.1, §3.3).** Use DuckDB's rules. Lists compare item by item, and a list that is the
  start of another comes first (`[1] < [1, 0]`). Structs compare field by field. A null inside a list is greater
  than every value, so it sorts last (`[NULL] < [1]` is false). Maps compare as lists of pairs. An empty list is not blank.
- **Functions (§4.4).** `len(list)`, `get(list, index)` (1-based, as DuckDB counts), `get(struct, 'field')`,
  `get(map, key)` and `has(list, value)`. A `get` with a literal index has a static type, so the plan checker
  can type it as it types other functions.
- **Measures (§4.5).** `list` (the values of a group, in row ID order). `histogram`, the bins of a column of
  numbers by `width`, as a `map` from the bin's lower bound (the `bin` of §4.4) to its count.
- **Editing (§7).** Nested columns stay `readOnly`. Writing a nested value can come later, through JSON in the
  cell editor.
- **The grid.** A cell shows the text form, and the cell's detail shows the JSON as a tree. Filters on a nested
  column offer `len` and `has`.

### Compatibility

A column that was a `string` becomes a `list`, so plans that used string functions on it become invalid. Engines
therefore keep today's mapping unless the client asks for nested types: a capability `nestedTypes: true`, and
`open`'s `read.nested: true` to use it. A document saved with the text form keeps working: the meaning of a column
changes only for clients that opt in.

### Work

1. Spec §2.1–2.4, §3.1, §3.3, the blocks (§2.3), and `decodeColumns`/`encodeBlock` in `vastgrid-spec` for List,
   Struct and Map.
2. DuckDB: the SQL of `vastgrid-sql` gives nested columns as they are, and the Python package does the same.
3. `vastgrid-js`: Arrow's nested columns, and JSON Lines arrays and objects as lists and structs. The type of a
   list's items, or of a struct's fields, is the first type that every value fits, as for a column. Parquet's
   nested columns come later, since they need repetition levels.
4. Functions, then measures with `histogram`, then the grid's tree view.

Each step adds conformance cases on every engine.

### To decide

- Whether opting in is per table (`read.nested`) or per engine.
- Whether `histogram` gives a `map` or a `list` of `{ bin, count }` structs. A map keeps the bins in order and
  shows as `{0=2, 5=1}`.

## 2. Locale collations

### Today

Strings compare by code point (§3.1), and the order is the same in every engine (§3.3). Letter case is folded with
`lower` (§3.4), and width and kana with `fold` (§3.4, §3.5, §4.4). Locale collations remain open (§12).

### What the sources give

- **DuckDB 2.0.** `COLLATE nocase` and `noaccent`; `strip_accents`, `nfc_normalize`; and the ICU collations
  (`COLLATE ja`), which order `["a","B","ア","あ","か","カ","ｶ","が","漢"]`.
- **Node.js 26.** `Intl.Collator("ja")` gives the same order for that list. ICU versions still differ between
  DuckDB, browsers and Node.js, so two engines can disagree on some strings.
- **Kanji.** ICU's `ja` orders kanji as JIS X 0208 does, which follows one reading of each common kanji. A
  name's own reading is not in the text, so "reading order of Japanese" for names in kanji needs a column of
  readings (furigana); a sort cannot compute it.

### Proposal

Keep locale collations as an opt-in capability once a user needs them:

- A sort key would take `collation: "ja"`, which engines list as `collations: ["ja", …]`.
- Such a view's order is the engine's, not §3.3's; the corpus would check only orders that ICU versions agree on.
- Because this weakens "the same in every engine", wait until a user needs it beyond `lower` and `fold`.

### To decide

- Whether `fold` also covers accents (`é` → `e`, as `strip_accents` does). The table would be long, and DuckDB's
  version of it differs from Unicode's decomposition for some letters.
- Whether the grid's filter and find get a "match width and kana" switch that uses `fold` on both sides.
