# Proposals for the open questions

The three questions that [§12 of the specification](spec.md#12-open-questions) leaves open, each with what holds
today, what the sources give, the choices, and the one proposed. Only the years of §3 are specified so far: each part becomes
spec text, conformance cases and engine code only once it is chosen. Checked against DuckDB 2.0.0, Node.js 24
(ICU 78.3, Unicode 17) and Python's DuckDB 2.0.0.

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
`open`'s `read.nested: true` to use it. A document saved with the text form keeps working. The version is 0.3:
the meaning of a column changes for clients that opt in.

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

## 2. Collations and folding

### Today

Strings compare by code point (§3.1), and the order is the same in every engine (§3.3). Letter case is folded only
with `lower` (§3.4). Nothing folds width (`Ａ` and `A`, `ｶ` and `カ`) or kana (`あ` and `ア`).

### What the sources give

- **DuckDB 2.0.** `COLLATE nocase` and `noaccent`; `strip_accents`, `nfc_normalize`; and the ICU collations
  (`COLLATE ja`), which order `["a","B","ア","あ","か","カ","ｶ","が","漢"]`.
- **Node.js 24.** `Intl.Collator("ja")` gives the same order for that list. ICU versions still differ between
  DuckDB, browsers and Node.js, so two engines can disagree on some strings.
- **Kanji.** ICU's `ja` orders kanji as JIS X 0208 does, which follows one reading of each common kanji. A
  name's own reading is not in the text, so "reading order of Japanese" for names in kanji needs a column of
  readings (furigana); a sort cannot compute it.

### Proposal

Split the question in two, and do the first part only.

1. **Folding as functions (§4.4), the same in every engine.**
   - `fold(x, "width")` maps full-width ASCII (U+FF01–FF5E) to ASCII, the ideographic space to a space, and
     half-width katakana to full-width, with `ｶﾞ` → `ガ`.
   - `fold(x, "kana")` maps hiragana to katakana (U+3041–3096 → U+30A1–30F6).
   - The spec gives the tables themselves, not "NFKC", so that the Unicode version cannot change a result.
     DuckDB compiles them to `translate` and `replace`; JavaScript and Python map code points.
   - Sorting by `fold(lower(name), "width")` is then a derived column (§4.1), with an order that is the same
     everywhere. Search (§3.5) gains `fold: ["width", "kana"]`, so that `ｶﾀｶﾅ` finds `カタカナ`.
2. **Locale collations as a capability, later.**
   - A sort key would take `collation: "ja"`, which engines list as `collations: ["ja", …]`.
   - Such a view's order is the engine's, not §3.3's; the corpus would check only orders that ICU versions agree
     on.
   - This weakens "the same in every engine", so wait until a user needs it.

### To decide

- Whether `fold` also covers accents (`é` → `e`, as `strip_accents` does). The table would be long, and DuckDB's
  version of it differs from Unicode's decomposition for some letters.
- Whether the grid's filter and find get a "match width and kana" switch that uses `fold` on both sides.

## 3. Dates and timestamps outside the years 0001 to 9999

Done, with the bound of DuckDB's timestamps (`-290308-12-22` to `+294247-01-10`) rather than six digits of
year, so that a date always compares with a timestamp in DuckDB (§2.2, §2.4, §7.3), and with the infinities as
proposed below (§2.2, §3.6, §3.8). DuckDB's dates beyond those of its timestamps remain open (§12).

### Before

§2.2 writes dates and timestamps as `YYYY`. `vastgrid-duckdb` reads values outside 0001–9999, and DuckDB's
`infinity` and `-infinity`, as null. The workbook reader keeps such dates as text, and `vastgrid-spec`'s calendar
throws outside those years.

### What the sources hold

| Source | Dates | Timestamps (µs) |
| --- | --- | --- |
| DuckDB 2.0 | 5877642 BC to 5881580 AD, `infinity`, `-infinity` | 290309 BC to 294247 AD, `infinity`, `-infinity` |
| Arrow | Date32: ±5.8 million years | Int64 µs: ±292,000 years |
| JavaScript `Date`, Temporal | ±275,760 years | the same |
| Python `datetime` | 1 to 9999 | 1 to 9999 |

DuckDB writes the text `10000-01-01` and `0001-12-31 (BC)`; it counts year 0 as 1 BC, so `year()` of
`0001-01-01 (BC)` is `0`. Python's DuckDB gives a date outside 1–9999 as its text, not as a `datetime`.

### Proposal

- **JSON (§2.2).** Years 0000 to 9999 keep `YYYY`. Other years are written as a sign and six digits, as
  RFC 9557 and Temporal write them: `+010000-01-01`, `-000001-01-01`. Year 0 is 1 BC, as in DuckDB's `year()`
  and ISO 8601. Years beyond six digits would be out of range, which bounds dates to ±999,999 years.
  - Every date that JavaScript holds fits.
  - DuckDB's dates beyond that (to 5.8 million years) read as null, as all of them do today.
- **Infinities.** `"infinity"` and `"-infinity"` for `date`, `timestamp` and `timestamptz`. They compare as
  greater and smaller than every other value, are not blank, and give null in date arithmetic, as NaN does in
  §3.6.
- **Text form (§2.4).** DuckDB's: `10000-01-01`, `0001-12-31 (BC)`, `infinity`. The grid's date formats
  (`Intl.DateTimeFormat`) write BC years by the locale's era.
- **Typed text (§7.3).** Typed text accepts both forms, and `BC` after a date.
- **Engines.**
  - `vastgrid-spec`'s calendar extends `daysFromCivil` to any year, which its arithmetic already allows.
  - DuckDB stops mapping these values to null.
  - `vastgrid-js` reads them from Arrow, Parquet and text files: `+010000-01-01` and `infinity` in CSV are dates.
  - The Python package keeps them as DuckDB's text and never makes a `datetime` of them.
- **Workbooks.** Unchanged. Excel has no dates before 1900 or after 9999.

### Compatibility

Values that were null become values, so `is_null` finds fewer rows in such columns, but no valid plan changes
meaning. The change is additive, and fits a patch version of 0.2 under §11.

### To decide

- Whether infinities come with it, or later (they touch every date function).
- Whether the bound is six digits of year, or DuckDB's whole range with more digits.

## Order

The proposed order of the work:

1. Dates first: small, additive, and every part is checkable against DuckDB.
2. Then folding as functions (§2 part 1).
3. Then nested types in their four steps. They need the most work and the opt-in.

Locale collations wait for a need.
