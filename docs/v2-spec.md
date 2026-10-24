# vastgrid v2 specification

Status: **2.0-draft.1** (2026-10-24). This document is normative for the engines, the grid core and the
surfaces of vastgrid v2. Why v2 is built this way is in
[the reconsideration of the rebuild](rebuild-decision.ja.md) (Japanese); v1's protocol is
[protocol.md](protocol.md). The conformance corpus in [`packages/spec/conformance`](../packages/spec/conformance)
turns the rules of sections 2–4 into cases that every engine runs.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Contents

1. [Scope and terms](#1-scope-and-terms)
2. [Types and values](#2-types-and-values)
3. [Meaning](#3-meaning)
4. [Plans and expressions](#4-plans-and-expressions)
5. [State](#5-state)
6. [Commands](#6-commands)
7. [Editing](#7-editing)
8. [Messages](#8-messages)
9. [Progressive views](#9-progressive-views)
10. [Conformance](#10-conformance)
11. [Versions and changes](#11-versions-and-changes)
12. [Open questions](#12-open-questions)
- [Appendix A. From v1](#appendix-a-from-v1)
- [Appendix B. DuckDB behavior this draft was checked against](#appendix-b-duckdb-behavior-this-draft-was-checked-against)

## 1. Scope and terms

- **Table**: rows with a schema (named, typed columns), opened from a `ref` that the host resolves (a file,
  a database table). A table has a **revision**, which changes when its data changes other than by writes
  through this protocol, and an **edits version**, which changes with every write.
- **Row ID**: a non-negative integer that names a row of a table for one revision: its position in the
  table, from 0, in the order the table is read (for a file, its order in the file).
- **Plan**: a JSON description of a view of a table (§4): derived columns, a condition, grouping, a
  condition on groups and an order. A plan holds no table and no range.
- **View**: the rows a plan makes of a table, in order. Positions in a view count from 0.
- **Engine**: computes views. The reference engine is DuckDB 1.5 through the SQL that
  [`vastgrid-sql`](../packages/sql) makes; the JS engine computes the same results in JavaScript.
- **Core**: the grid without a screen: state (§5), commands (§6), the cache of blocks, the selection.
- **Surface**: a place the grid runs: a React app, a VS Code editor, a notebook, an MCP App, a browser
  app, a CLI.
- **Transport**: what carries messages (§8) between the core and an engine: a function call, a Web
  Worker, HTTP, an MCP tool call, a VS Code webview, a notebook comm.

The meaning of plans (§3) follows DuckDB 1.5 unless this document says otherwise. Where it does, the SQL
that `vastgrid-sql` makes implements this document, not DuckDB's default. Appendix B lists the DuckDB
results this draft was checked against.

## 2. Types and values

### 2.1 Logical types

| Type | Values | Schema members | Arrow | From DuckDB |
| --- | --- | --- | --- | --- |
| `boolean` | true, false | | Bool | `BOOLEAN` |
| `integer` | 32-bit signed integers | | Int32 | `TINYINT`, `SMALLINT`, `INTEGER`, `UTINYINT`, `USMALLINT` |
| `bigint` | 64-bit signed integers | | Int64 | `BIGINT`, `UINTEGER` |
| `decimal` | exact decimal numbers of up to 38 digits | `precision` (1–38), `scale` (0 to `precision`) | Decimal128 | `DECIMAL`; `UBIGINT`, `HUGEINT` and `UHUGEINT` as decimal(38, 0) (a value of more than 38 digits reads as null) |
| `float` | IEEE 754 binary floating-point numbers, with NaN and ±Infinity | `bits` (32 or 64) | Float32, Float64 | `FLOAT`, `DOUBLE` |
| `string` | Unicode text | | Utf8, LargeUtf8, Utf8View | `VARCHAR`, and the types of the next paragraph |
| `date` | calendar days | | Date32 | `DATE` |
| `time` | times of day without a time zone, in microseconds | | Time64 (µs) | `TIME` |
| `timestamp` | dates and times without a time zone | `unit` (`s`, `ms`, `us`, `ns`; default `us`) | Timestamp(unit) | `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS` |
| `timestamptz` | instants | | Timestamp(µs, "UTC") | `TIMESTAMPTZ` |
| `interval` | months, days and nanoseconds | | Interval (MonthDayNano) | `INTERVAL` |
| `uuid` | 128-bit identifiers | | FixedSizeBinary(16), extension `arrow.uuid` | `UUID` |
| `binary` | bytes | | Binary | `BLOB` |

A column is `{ "name", "type" }` with the schema members of its type, and optionally `sourceType` (the
engine's own type name, such as `DECIMAL(10,2)`) and `readOnly` (the engine does not write it, §7).

Engines map other source types (lists, structs, maps, JSON, unions, bit strings) to `string`, holding the
text DuckDB gives them (`CAST(x AS VARCHAR)`), with `sourceType` naming the source type and
`readOnly: true`. A later version may carry them natively.

### 2.2 Values in JSON

Plans, states, messages other than blocks, and the conformance corpus write values as JSON, read with the
type of their column or literal:

| Type | JSON | Examples |
| --- | --- | --- |
| `boolean` | `true`, `false` | |
| `integer` | a number | `42` |
| `bigint` | a number when \|v\| ≤ 2^53 − 1, otherwise a string of digits; readers accept both | `42`, `"9223372036854775807"` |
| `decimal` | a string with exactly `scale` fraction digits (no point when the scale is 0), without an exponent, a `+` or leading zeros | `"12.50"`, `"-0.10"`, `"7"` |
| `float` | a number, or one of the strings `"NaN"`, `"Infinity"`, `"-Infinity"` | `0.1`, `"NaN"` |
| `string` | a string | |
| `date` | `"YYYY-MM-DD"` | `"2024-01-31"` |
| `time` | `"HH:MM:SS"`, with a fraction of 1–6 digits without trailing zeros when it is not 0 | `"01:02:03.25"` |
| `timestamp` | `"YYYY-MM-DD HH:MM:SS"`, with a fraction of 1–9 digits as for `time` | `"2024-01-31 12:00:00.5"` |
| `timestamptz` | the instant in UTC as a timestamp, then `+00` | `"2024-01-31 03:00:00+00"` |
| `interval` | DuckDB's text form | `"01:30:00"`, `"1 year 2 months"` |
| `uuid` | lowercase hex, `8-4-4-4-12` | |
| `binary` | base64 (RFC 4648, with padding) | |
| null | `null` | |

### 2.3 Values in blocks

Rows travel as Apache Arrow IPC streams (§8.4) with the Arrow types of §2.1. Timestamps keep their unit;
`timestamptz` is UTC microseconds. Strings may use Utf8, LargeUtf8 or Utf8View, and readers MUST accept all
three. Decimals use Decimal128 with the column's precision and scale.

### 2.4 Text form

Every value has one text form, the same as DuckDB's `CAST(value AS VARCHAR)` with the time zone set to
UTC:

| Type | Text form |
| --- | --- |
| `boolean` | `true`, `false` |
| `integer`, `bigint` | decimal digits, with `-` before negative numbers |
| `decimal` | the digits with exactly `scale` fraction digits: `1.50`, `-0.10` |
| `float` | §2.4.1 |
| `string` | the string itself |
| `date` | `YYYY-MM-DD` |
| `time` | `HH:MM:SS`, then `.` and the fraction without trailing zeros when it is not 0 |
| `timestamp` | the date, a space and the time, as above |
| `timestamptz` | the timestamp in UTC, then `+00` |
| `uuid` | lowercase hex, `8-4-4-4-12` |
| `interval`, `binary` | DuckDB's text form |

#### 2.4.1 Floats

Take the shortest digits d₁d₂…dₙ and the exponent e such that d₁.d₂…dₙ × 10^e reads back as the same float
of the column's `bits` (for 32-bit floats, as the same 32-bit float):

- NaN is `nan`, the infinities are `inf` and `-inf`, and zero is `0.0` or `-0.0`.
- When −4 ≤ e < 16, the number is written in fixed notation with at least one digit after the point:
  `1.0`, `100.0`, `0.0001`, `123456789.125`, `9999999999999998.0`.
- Otherwise it is written as d₁, then `.` and the other digits if there are any, then `e`, the sign (`+` or
  `-`) and at least two digits of the exponent: `1e+16`, `1e-05`, `1.2345678901234567e+19`, `5e-324`.

This is Python's `repr` of a float. In JavaScript, `x.toExponential()` gives the digits and the exponent of a
64-bit float; for a 32-bit float, use the shortest digits that `Math.fround` reads back as the same value.

### 2.5 Literals

Expressions (§4.3) write literals as `{ "lit": value }`, with `type` when the JSON alone does not give it:

- `true` and `false` are booleans, and a string is a string. A JSON number that is an integer with
  |v| ≤ 2^53 − 1 is a bigint; any other JSON number is a 64-bit float.
- With `type`, the value is read as in §2.2. `{ "lit": "12.50", "type": "decimal" }` is a decimal(4, 2): its
  precision is its number of digits (at least 1, and at least its scale) and its scale its number of
  fraction digits. Other examples: `{ "lit": "2024-01-31", "type": "date" }`,
  `{ "lit": "NaN", "type": "float" }`, `{ "lit": "9007199254740993", "type": "bigint" }`.
- `{ "lit": null, "type": T }` is a null of type T. `{ "lit": null }` without `type` takes the type that
  its place needs (another argument of `coalesce`, `if` or a comparison); a plan where no type can be
  decided is invalid.

Grids SHOULD write decimal literals for numbers that people type (`"1.005"` rather than `1.005`), so that
comparisons with exact columns stay exact (§3.1).

## 3. Meaning

### 3.1 Comparison

- **Numbers.** Two exact numbers (integer, bigint, decimal) compare exactly, whatever their scales: the
  decimal(4, 3) `1.005` is greater than the decimal(3, 2) `1.00`. When either side is a float, both are
  compared as 64-bit floats (the exact side rounded to the nearest float), so the decimal `0.1` equals the
  float `0.1`. NaN equals NaN and is greater than every other number, Infinity included. −0.0 equals 0.0.
- **Strings** compare code point by code point, a string that is the start of another coming first (this
  is the order of their UTF-8 bytes). Letter case and accents count: `"B" < "a"`, `"10" < "9"`, `"" < "a"`,
  and `"｡"` (U+FF61) `< "😀"` (U+1F600). JavaScript's `<` compares UTF-16 code units and answers the last
  one the other way; JS engines MUST compare code points.
- **Booleans**: false < true.
- **Dates and times** compare in time; a date compared with a timestamp is the timestamp at midnight.
  `timestamptz` compares instants and is not comparable with `date` or `timestamp` (the plan is invalid).
- **UUIDs and binary values** compare by their bytes.
- Values of different kinds (a number and a string, a string and a date) are not comparable: the plan is
  invalid. A comparison with null is null.

### 3.2 Blank

A value is **blank** when it is null, or when it is the empty string in a string column. NaN, `0`,
`false` and strings of spaces are not blank.

### 3.3 Order

A sort key names a column and a direction (`asc` or `desc`):

1. Values that are not blank are ordered by §3.1, ascending or descending.
2. Blank values come after all the values that are not blank, in both directions, and are equal to each
   other for that key.
3. Rows that are equal for a key are ordered by the next key.
4. Rows that are equal for every key are ordered by row ID, ascending (views without `aggregate`), or by
   their group keys as in §3.9 (views with `aggregate`).

NaN is the greatest number: it is the last number ascending and the first descending. A view without
`sort` is in row ID order (groups: the order of §3.9). The order of a view is therefore total and the same
in every engine.

### 3.4 Text matching and letter case

- `contains`, `starts_with`, `ends_with` and `eq` on strings compare code points and respect letter case.
  An empty needle matches every string that is not null.
- `lower` and `upper` map each code point by itself, with the simple case mappings that DuckDB 1.5 uses
  (from utf8proc): `lower("İ")` is `"i"`, `lower("ΣΑΣ")` is `"σασ"` (no final sigma) and `upper("ß")` is
  `"ẞ"` (U+1E9E). No context is used, and every code point stays one code point. JavaScript's
  `toLowerCase` gives `"i̇"` and `"σας"`, and `toUpperCase` gives `"SS"`; JS engines MUST map code points
  one by one, with the conformance corpus as the reference.
- Matching that ignores letter case is written with `lower` on both sides:
  `contains(lower(x), lower("Tokyo"))`. Nothing else is folded in v2.0 (full-width and half-width forms,
  kana, accents); it may come later as a capability.

### 3.5 Search

`{ "search": text }` (§4.3) is true for a row when, for at least one of the table's own columns (not the
derived ones), `contains(lower(the text form of the value), lower(text))` is true. Null values match
nothing. `text` MUST NOT be empty or only spaces (as `trim` removes them, §4.4); grids leave such a search
out instead.

### 3.6 Evaluation, nulls and errors

- Logic has three values: `and`, `or` and `not` follow SQL, and `where` and `having` keep the rows for
  which the condition is true (not false, not null).
- A function gives null when an argument is null, except `and`, `or`, `is_null`, `is_blank`,
  `coalesce`, `concat` (null counts as the empty string), `if` (a null condition takes the second value),
  `least` and `greatest` (nulls are left out; the result is null only when every argument is null), and
  `in` (§4.4).
- **Errors give null.** Evaluating an expression for a row never makes a plan fail: overflow, a value out
  of a function's domain (`sqrt(-1)`, `ln(0)`) and a conversion that does not succeed give null.
- **Numbers that are not finite give null.** An arithmetic function or a function of numbers (§4.4, the
  table "Arithmetic and numbers") gives null when an argument is NaN or infinite, and when its result would
  be. Division by zero therefore gives null. Values of float columns that are NaN or infinite are read as
  they are (`{ "col": "x" }` reads NaN) and compare as in §3.1; only computations make them null.

### 3.7 Types of numeric results

When an integer or a bigint meets a decimal, the integer counts as decimal(10, 0) and the bigint as
decimal(19, 0). For operands of precision p₁, p₂ and scale s₁, s₂:

| Function | Integers and bigints | A decimal involved | A float involved |
| --- | --- | --- | --- |
| `add`, `sub` | bigint | decimal(min(38, max(p₁ − s₁, p₂ − s₂) + max(s₁, s₂) + 1), max(s₁, s₂)) | float |
| `mul` | bigint | decimal(min(38, p₁ + p₂), s₁ + s₂), or a float when s₁ + s₂ > 38 | float |
| `div` | float | float | float |
| `mod` | bigint | decimal(min(38, max(p₁ − s₁, p₂ − s₂) + max(s₁, s₂)), max(s₁, s₂)) | float |
| `neg`, `abs` | the operand's type | the operand's type | float |

`mod` takes the sign of the dividend: `mod(-7, 3)` is −1. A result that does not fit its type gives null
(§3.6). Floats in results are 64-bit, also when an operand is a 32-bit float column.

### 3.8 Aggregates

Measures (§4.5) leave out null values. For float columns, `sum`, `avg`, `min`, `max`, `stddev` and
`quantile` also leave out NaN and the infinities (DuckDB does not: there, the sum of NaN and 1 is NaN);
`count` and `count_distinct` count them. Over no values, `count` and `count_distinct` are 0 and the other
measures are null.

- `sum` of integers and bigints is exact, a decimal(38, 0); `sum` of a decimal(p, s) is an exact
  decimal(38, s); `sum` of floats is a float.
- `avg` is a float; for exact inputs it is computed from the exact sum.
- `count_distinct` counts values that differ by §3.1: all NaNs are one value, and −0.0 and 0.0 are one
  value.
- `stddev` is the sample standard deviation, null with fewer than two values.
- `quantile`, with `p` from 0 to 1, interpolates linearly between the two closest ranks (DuckDB's
  `quantile_cont`) and is a float.

Sums and averages of floats depend on the order of the additions. Engines MAY add in any order, and
conformance compares them with a relative tolerance. Measures with `"approx": true` (`count_distinct`,
`quantile`) MAY be approximated; conformance does not test them.

### 3.9 Groups

`aggregate` makes one group for each distinct combination of key values, by §3.1 equality, except that
null and the empty string are each a group of their own, different from each other. All NaNs form one
group, and so do −0.0 and 0.0 (which of the two its key reads as is not specified).

Without `sort`, and to break the ties of `sort`, groups are ordered by their keys, each ascending as in
§3.3, with the empty string before null among blank keys.

## 4. Plans and expressions

### 4.1 Plan

```json
{
  "derive": [{ "name": "total", "expr": { "fn": "mul", "args": [{ "col": "qty" }, { "col": "price" }] } }],
  "where": { "fn": "gt", "args": [{ "col": "total" }, { "lit": "1000", "type": "decimal" }] },
  "aggregate": {
    "keys": ["region"],
    "measures": [
      { "name": "orders", "fn": "count" },
      { "name": "sales", "fn": "sum", "column": "total" }
    ]
  },
  "having": { "fn": "ge", "args": [{ "col": "orders" }, { "lit": 10 }] },
  "sort": [{ "column": "sales", "direction": "desc" }]
}
```

Every member is optional, and `{}` is the table as it is. The members apply in this order, whatever their
order in the JSON:

1. `derive`: add columns computed for each row. Each may use the table's columns and the derived columns
   before it.
2. `where`: keep the rows for which the condition is true.
3. `aggregate`: make one row per group, with the keys and the measures as its columns.
4. `having` (only with `aggregate`): keep the groups for which the condition is true.
5. `sort`: order the rows (§3.3).

A plan names no table and holds no range: requests (§8) give the table, its revision and the positions to
read.

### 4.2 Columns of a view

- Without `aggregate`: the table's columns in schema order, then the derived columns in order. Rows have
  row IDs.
- With `aggregate`: the keys (with the types of their columns), then the measures in order, or the
  generated columns of `pivot` (§4.6). Groups have no row IDs.

Names are unique in a view: a derived column or a measure MUST NOT have the name of another column of its
view. Columns are named, not numbered, everywhere: keys, measures, sort keys, requests. Engines report
unique names for the table's own columns; how they make them from source names that repeat is theirs to
decide, but it is stable for a revision.

### 4.3 Expressions

| Form | Meaning |
| --- | --- |
| `{ "col": name }` | the value of a column of the row (in `having`, of the group's row) |
| `{ "lit": value }`, `{ "lit": value, "type": T }` | a literal (§2.5) |
| `{ "fn": name, "args": [ … ] }` | a function (§4.4) |
| `{ "search": text }` | the search of §3.5; only in `where`, at most once |

Every expression has a type, decided from the types of its columns and the rules of §4.4. `where` and
`having` MUST be boolean.

### 4.4 Functions

Kinds of arguments: **number** (integer, bigint, decimal, float), **exact** (integer, bigint, decimal),
**temporal** (date, time, timestamp, timestamptz), **orderable** (number, string, boolean, temporal,
uuid) and **any**. A common type of several values is their type when they all have the same one; for
numbers, the type that `add` gives them (§3.7); a typed or untyped null takes the type of the others. Other
mixtures are invalid.

Logic and comparison:

| Function | Arguments | Result |
| --- | --- | --- |
| `and`, `or` | 2 or more booleans | boolean |
| `not` | a boolean | boolean |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge` | 2 comparable values (§3.1) | boolean |
| `in` | a value, then 1 or more literals comparable with it, none of them null | boolean: true when the value equals one of the literals, null when it is null, otherwise false |
| `is_null` | any value | boolean, never null |
| `is_blank` | any value | boolean (§3.2), never null |
| `if` | a boolean, then 2 values of a common type | the common type; a null condition takes the second value |
| `coalesce` | 1 or more values of a common type | the common type: the first value that is not null |
| `least`, `greatest` | 2 or more orderable values of a common type | the common type, by the order of §3.1 (NaN is the greatest number) |

Arithmetic and numbers (§3.6, §3.7):

| Function | Arguments | Result |
| --- | --- | --- |
| `add`, `sub`, `mul`, `div`, `mod` | 2 numbers | §3.7 |
| `neg`, `abs` | a number | §3.7 |
| `round` | a number, and optionally `digits`, an integer literal from −18 to 18 (default 0) | integers and bigints keep their type; a decimal(p, s) becomes a decimal(p, min(s, max(digits, 0))); floats stay floats. Halves round away from zero: `round(2.5)` is 3 and `round(-2.5)` is −3 |
| `floor`, `ceil` | a number | integers and bigints keep their type; a decimal(p, s) becomes a decimal(p, 0); floats stay floats |
| `sqrt`, `exp`, `ln`, `log10` | a number | float |
| `power` | 2 numbers | float |
| `sign` | a number | integer: −1, 0 or 1 |
| `to_number` | a string | float: null unless the string, without its leading and trailing spaces (as `trim`), matches `[+-]?([0-9]+(\.[0-9]*)?\|\.[0-9]+)([eE][+-]?[0-9]+)?` and its value is finite |

Text:

| Function | Arguments | Result |
| --- | --- | --- |
| `concat` | 1 or more values of any type | string: their text forms (§2.4) joined, null counting as the empty string |
| `length` | a string | bigint: the number of code points |
| `lower`, `upper` | a string | string (§3.4) |
| `trim` | a string | string without its leading and trailing space separators (Unicode category Zs, such as U+0020, U+00A0 and U+3000); tabs and line breaks stay |
| `left`, `right` | a string and an integer n | string: the first or the last n code points; n below 0 counts as 0 |
| `substr` | a string, a start from 1, and optionally a length (integers) | string: the code points from the start; a start below 1 counts as 1, a length below 0 as 0 |
| `replace` | 3 strings | string: every occurrence of the second (respecting letter case) replaced by the third; an empty second string replaces nothing |
| `contains`, `starts_with`, `ends_with` | 2 strings | boolean (§3.4) |
| `text` | any value | string: the text form (§2.4) |

Dates and times:

| Function | Arguments | Result |
| --- | --- | --- |
| `to_date` | a string | date: null unless the string is `YYYY-MM-DD` and names a real day |
| `to_timestamp` | a string | timestamp: null unless the string is `YYYY-MM-DD`, a space or `T`, then `HH:MM`, optionally `:SS` and a fraction of 1–9 digits, and names a real moment |
| `year`, `month`, `day` | a date or a timestamp | bigint |
| `hour`, `minute`, `second` | a time or a timestamp | bigint (`second` without its fraction) |
| `isodow` | a date or a timestamp | bigint: Monday 1 to Sunday 7 |
| `date_diff_days` | 2 dates or timestamps (start, end) | bigint: the number of day boundaries from start to end, negative when end is before start (DuckDB's `date_diff('day', start, end)`) |
| `add_days` | a date or a timestamp, and an integer | the first argument's type |

### 4.5 Measures

A measure is `{ "name", "fn", "column"?, "p"?, "approx"? }`:

| `fn` | `column` | Result |
| --- | --- | --- |
| `count` | none | bigint: the number of rows |
| `count` | a column | bigint: the number of values that are not null |
| `count_distinct` | an orderable column | bigint |
| `sum` | a number column | §3.8 |
| `avg`, `stddev` | a number column | float |
| `min`, `max` | an orderable column | the column's type |
| `quantile` | a number column, with `p` from 0 to 1 | float |

`column` names a column of the rows before grouping: a table column or a derived column.

### 4.6 Pivot

`aggregate.pivot`, `{ "columns": [names], "maxColumns"?: n }`, makes a cross tabulation. After the keys come
one column for each combination of the values of `columns` among the rows that `where` keeps, in the order
of §3.9, and for each combination one column per measure. A generated column is named by the text forms of
the combination's values (`(null)` for null and `(empty)` for the empty string), then the measure's name,
joined with ` / `: `Tokyo / 2024 / sales`. A name that an earlier column of the view already has gets
` (2)`, ` (3)` and so on. Cells without rows are 0 for `count` and `count_distinct`, and null otherwise.
`maxColumns` is 200 by default and at most 1,000; a plan that would make more columns fails with
`too_many_columns` (§8.7) rather than being cut. The schema of a generated column carries
`pivot: { "values", "measure" }`, with the combination's values as typed JSON. A pivot needs at least one
measure, and its `having` and `sort` may use only the keys, since the generated columns are known only from
the data.

### 4.7 Validation

Engines validate a plan against the table's columns before they run it, and answer `invalid_plan` (§8.7)
with `path`, a JSON Pointer to the member at fault, and `reason`:

| `reason` | When |
| --- | --- |
| `syntax` | the plan does not have the form of §4.1 and §4.3 ([`plan.schema.json`](../packages/spec/schema/plan.schema.json)) |
| `unknown_column` | a name that the view does not have at that point |
| `duplicate_name` | a derived column or a measure with a name its view already has |
| `type` | an argument or a condition of the wrong type, or values that are not comparable |
| `arity` | the wrong number of arguments |
| `unknown_function` | a function or a measure that this document does not define |
| `unsupported` | a function, a measure or a member that the engine does not offer (§4.10) |
| `misplaced` | `having` without `aggregate`, `search` outside `where` or more than once, or a pivot without measures |
| `literal` | a literal whose value is not of its type, or a search text that is empty (§3.5) |
| `limit` | a limit of §4.9 is exceeded |

### 4.8 Normal form and hash

The **normal form** of a plan leaves out `derive` and `sort` when they are empty and keeps everything else
as it is. It is written as JSON with the members of every object sorted by name (in code point order),
without white space, and with strings and numbers as `JSON.stringify` writes them. The **hash** of a plan is
`sha256:` followed by the lowercase hex SHA-256 of its normal form in UTF-8. Plans with the same normal form
are the same view; engines MAY keep views by table, revision, edits version and hash (§8.3).

### 4.9 Limits

| Limit | Value |
| --- | --- |
| derived columns | 32 |
| names of columns and measures | 1 to 256 code points |
| nodes of one expression | 1,000 |
| depth of one expression | 64 |
| literals of `in` in one plan | 100,000 |
| sort keys | 32 |
| keys of `aggregate` | 16 |
| columns of `pivot` | 16 |
| measures | 64 |
| generated columns of `pivot` | 1,000 (`maxColumns`, 200 by default) |

### 4.10 Capabilities

Engines report what they evaluate (in `TableInfo`, §8.2):

```json
{
  "plan": { "derive": true, "where": true, "aggregate": true, "pivot": true, "having": true, "sort": true, "search": true },
  "functions": ["and", "or", "not", "eq", "…"],
  "measures": ["count", "sum", "…"],
  "summarize": true,
  "find": true,
  "write": true,
  "save": true,
  "export": { "formats": ["csv", "tsv", "parquet", "json", "xlsx"], "delivery": "file" },
  "preview": true,
  "partialViews": false,
  "changes": "push"
}
```

The core offers only what the engine reports, and a plan that uses anything else fails with
`invalid_plan` (`unsupported`).

## 5. State

The state is JSON in two parts with their own versions: the **document** (what a person saves, shares or
gives an agent: the view and its columns) and the **session** (where the person is: the selection, the
scroll position, the checked rows, an editor being typed in). Both are plain data. Commands (§6) change
them, and the core reads the data they need.

### 5.1 Document

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "schema": ["id", "region", "qty", "price"],
  "plan": {},
  "columns": [
    {
      "name": "price",
      "width": 120,
      "pin": "left",
      "format": {
        "label": "Price",
        "number": { "style": "currency", "currency": "JPY" },
        "styles": [
          {
            "when": { "fn": "lt", "args": [{ "col": "price" }, { "lit": 0 }] },
            "color": "#b42318",
            "description": "Negative"
          }
        ]
      },
      "total": { "fn": "sum" }
    },
    { "name": "qty", "hidden": true }
  ]
}
```

- `schema`: the table's column names when the document was saved, so that the core can tell what changed.
- `plan`: §4.
- `columns`: settings of the view's columns, by name, in display order. Columns of the view that are not
  listed come after the listed ones, in view order, with default settings. Listed names that the view does
  not have are kept, for when they come back, but not shown. `pin` is `left`, `right` or absent. `total`
  is a measure (`fn`, and `p` for `quantile`) of the column over the whole view, shown in the totals row.
- `format`: `label`; `number` and `date` (v1's `NumberFormat` and `DateFormat`); `align`; `wrap`; `copy`
  (`raw` or `formatted`); and `styles`, rules tried in order, the first whose `when` (an expression over
  the row, §4.3, without `search`) is true giving `color`, `background` and `description`. Functions (v1's
  `format` and `style` callbacks) are not state: they stay props of the React component, and they win
  over `styles`.

### 5.2 Session

```json
{
  "kind": "vastgrid/session",
  "version": 2,
  "view": "sha256:…",
  "active": { "row": 120, "key": { "rowId": 5012 }, "column": "price" },
  "selection": [{ "rows": [100, 140], "columns": ["region", "price"] }],
  "scroll": { "row": 95, "column": "id" },
  "checked": { "mode": "include", "keys": [{ "rowId": 3 }, { "rowId": 9 }] },
  "detail": { "open": true },
  "editor": { "row": 120, "column": "price", "text": "12" }
}
```

- `view`: the hash of the plan that the positions refer to. When the plan changes, the core keeps `active`
  by its `key` when it can, and clears `selection`.
- `active`: the active cell, by view position, row key (§5.3) and column name.
- `selection`: ranges of view positions (`[start, end)`) and the columns they span, in display order.
- `scroll`: the view position and the column at the top left; the core restores the same place, not the
  same pixels.
- `checked`: rows checked with the checkboxes, by key. `mode: "exclude"` checks every row except `keys`, and
  may carry `where`, the condition of the view whose rows it checks (v1's `{ type: "exclude", query }`).
- `detail` and `editor`: the detail panel, and a cell editor being typed in.

### 5.3 Row keys

A row key is `{ "rowId": n }` (the row ID, valid for one revision) or, when the grid names a key column
(`rowKey`), `{ "value": v }` with the typed JSON value of that column. Selection, checked rows, edits and
the detail panel use the same keys.

### 5.4 Versions

Readers MUST accept the versions they know and refuse the others. The core migrates v1's `GridState`
(version 1) into a v2 document: `query` becomes `plan` (Appendix A), `columns[]` keep `name`, `width`,
`hidden` and `total`, `frozenColumns` and `frozenRightColumns` become `pin`, `formulas` become
`plan.derive` (compiled from the formula language), and `group` becomes `plan.aggregate`.

## 6. Commands

Commands are named operations with JSON arguments that change the state. They are the same for keys, menus,
panels, the host app (through the component's handle) and agents (for example as MCP tools). A command
returns the new state; the core then reads what the new state needs. Commands do not wait for data, except
that `copy` and `export` produce output.

| Command | Arguments | Effect |
| --- | --- | --- |
| `sort.set` | `keys` | sets the plan's `sort` |
| `sort.toggle` | `column`, `add` | ascending, descending, none for that column; `add` keeps the other keys |
| `filter.set` | `where` | sets the plan's `where` |
| `filter.column` | `column`, `where` | replaces the conditions of one column |
| `filter.clear` | | removes `where` |
| `search.set` | `text` | sets the search of `where` |
| `derive.add`, `derive.update` | `name`, and `expr` or `formula` | adds or changes a derived column |
| `derive.remove` | `name` | |
| `group.set` | `aggregate` | |
| `group.clear` | | removes `aggregate` and `having` |
| `having.set` | `having` | |
| `column.resize` | `name`, `width` | |
| `column.move` | `names`, `before` | |
| `column.hide`, `column.show` | `names` | |
| `column.pin` | `name`, `side` (`left`, `right` or null) | |
| `column.format` | `name`, `format` | |
| `column.total` | `name`, a measure or null | |
| `select` | `ranges`, `active` | |
| `select.all`, `select.row`, `select.column` | | |
| `move` | `direction`, `extend`, `jump` | moves the active cell (arrow keys, Home, End, Page Up, Page Down, with Shift and ⌘/Ctrl) |
| `scroll.to` | `row`, `column` | |
| `check`, `uncheck` | `keys` | |
| `check.all`, `check.clear` | | |
| `detail.open`, `detail.close` | | |
| `edit.begin`, `edit.change`, `edit.commit`, `edit.cancel` | | the cell editor; `edit.commit` writes (§7) |
| `edit.clear`, `edit.paste`, `edit.fill` | | deletes, pastes (TSV and HTML tables) and fills down or right |
| `history.undo`, `history.redo` | | |
| `copy` | `headers`, `values` (`raw` or `formatted`) | produces TSV, HTML and Markdown |
| `export` | `format`, `columns`, `target` | produces a file (§8.2) |

Key bindings and menus are data that map input to commands, and hosts can replace them.

## 7. Editing

- **Writes** name cells by row key and column name, with typed values (§2.2). A write is atomic: every
  update is applied, or none is and the request fails. An update may carry `previous`, the value it was
  made from; when the cell holds another value now, the write fails with `edit_conflict`. A write carries
  the revision its rows were read at; when the table has another revision, it fails with
  `revision_changed`. A write holds at most 100,000 updates.
- Values are checked as their column's type without losing digits, and a value that does not fit fails the
  write with `invalid_value`. Derived columns, aggregated views and columns with `readOnly` are not written
  (`read_only`).
- Engines keep written values apart from the source until they are saved, and every later request of every
  client (rows, plans, summaries, find, export) sees them. Writes keep row IDs and the revision, and
  increment the edits version.
- **Save** writes the written cells into the file the table was read from. For CSV and TSV files,
  `vastgrid-duckdb` writes anew only the edited fields of the edited records and keeps every other byte
  (byte order mark, header, other records and fields, quoting, delimiters, line breaks, encoding), in a
  temporary file next to the original that it then renames over it. It refuses files that someone else
  changed since they were read (`file_changed`) and files it cannot write back (`save_unsupported`); the
  file is then as it was.
- **Undo and redo** belong to the core. Each write (a typed value, a paste, a fill, a deletion) is one
  step, and undoing writes the previous values, with their types and digits, as a new write.

## 8. Messages

### 8.1 Envelope

Requests are JSON objects `{ "v": 2, "id": n, "op": name, …arguments }`, and responses are
`{ "v": 2, "id": n, "result": … }` or `{ "v": 2, "id": n, "error": { "code", "message", "path"?, "reason"? } }`.
The client chooses `id`, unique among its requests in flight. Engines MAY send events
`{ "v": 2, "event": name, … }` on transports that can carry them (§8.8). Messages hold no SQL, no server
paths and no code.

### 8.2 Operations

| `op` | Arguments | Result |
| --- | --- | --- |
| `open` | `ref` (the host's name for what to open), optionally `read` (v1's `ReadOptions`, such as `sheet` and `headerRow`) | `TableInfo` |
| `info` | `table` | `TableInfo`, to follow a table that is loading |
| `rows` | `table`, `revision`, `plan`, `start`, `end`, `columns` (names), optionally `textLimit` and `preview` | `{ view, start, end, rowIds?, block, truncated? }` |
| `summarize` | `table`, `revision`, `plan`, `ranges` (`[start, end)` pairs), `columns` | `{ count, numericCount, sum, min, max, average }` over those cells |
| `find` | `table`, `revision`, `plan`, `text`, `columns` (in display order), `from` (`{ row, column }`), `direction` (1 or −1), optionally `caseSensitive` | `{ row, column }`, where `column` is an index into `columns`, or null |
| `write` | `table`, `revision`, `updates` (`{ key, column, value, previous? }`) | `{ updated, edits }` |
| `save` | `table` | `{ records, edits }` |
| `export` | `table`, `revision`, `plan`, `format`, optionally `columns`, `headers` and `numberFormats`, and `target` | `{ target, rows, data? }` |
| `changes` | `table` | `{ revision, edits }`, for polling |
| `cancel` | `request` (an `id`) | no response; the request it names fails with `cancelled` |
| `close` | `table` | null |

`TableInfo` is `{ table, revision, edits, status, progress, rowCount, readableRows, columns, format,
byteSize, notes, sheets, sheet, capabilities, error? }`: `table` is an opaque id for the later requests,
`status` is `loading`, `ready` or `error`, and `rowCount` is null while the table loads.

The `view` of `rows` is `{ hash, status, rowCount, rowCountExact, readableRows, columns, edits }`: `status`
is `building` or `ready` (§9), `columns` is the view's schema (§4.2), and `edits` is the edits version the
rows were read at.

### 8.3 Identity

Views have no handles. A request names the table, its revision and the plan. Engines MAY keep the views they
made, by table, revision, edits version and plan hash, and forget them at any time: a forgotten view is
made again from the same request. When the table's revision is not the request's, the request fails with
`revision_changed`, and the client reads `info` again.

### 8.4 Blocks

`block` is an Arrow IPC stream with one record batch holding the requested `columns` in order (§2.3), for the
positions `start` to `end`. `end` is smaller than requested at the end of the view, and while a preview can
read only `readableRows` (§9). `rowIds` lists the row IDs of the rows of views without `aggregate`. Strings
longer than `textLimit` code points (2,000 by default, at most 1,000,000) are cut to that length, and
`truncated` maps a column's name to the offsets, from `start`, of its cut values; the core shows that they
go on. A request reads at most 1,000,000 rows and 1,000,000 cells.

### 8.5 Progress and changes

`info` reports a table that is loading (`status`, `progress`, `readableRows`). Engines that can push send
`{ "event": "changed", "table", "revision", "edits" }` when the table's data changes, and
`{ "event": "progress", "table", … }` while it loads; otherwise clients poll `info` and `changes`.

### 8.6 Cancellation

A client cancels a request in flight with `cancel`, or by the transport's own means (aborting an HTTP
request). An engine that stops the work answers `cancelled`; it MAY also finish the work and answer it.

### 8.7 Errors

| `code` | When |
| --- | --- |
| `invalid_request` | a message that does not follow §8 |
| `invalid_plan` | §4.7, with `path` and `reason` |
| `table_not_found` | the table is closed or unknown |
| `not_ready` | the table is still loading and the request needs all of it |
| `revision_changed` | §7, §8.3 |
| `cancelled` | §8.6 |
| `too_many_columns` | §4.6 |
| `read_only`, `invalid_value`, `edit_conflict` | §7 |
| `file_changed`, `save_unsupported` | §7 |
| `not_allowed` | a `ref` or `target` outside what the host allows |
| `export_too_large` | a result that does not fit the export format (xlsx: 1,048,575 rows and 16,384 columns) |
| `load_failed` | the table could not be read |
| `internal` | anything else |

### 8.8 Transports

| Transport | Requests and responses | Blocks | Events |
| --- | --- | --- | --- |
| Function call (same thread) | objects | Arrow record batches | callbacks |
| Web Worker | `postMessage` | the IPC bytes, transferred (`ArrayBuffer`) | messages |
| HTTP | `POST` of the request as JSON | a `rows` response is `application/vnd.vastgrid.v2+arrow`: the length n of the JSON response in 4 bytes (little-endian), the n bytes of the JSON response, then the IPC stream. Other responses are `application/json` | Server-Sent Events |
| MCP App | a tool call with the request as its arguments; the result's `structuredContent` is the response | base64 in `block` | polling |
| VS Code webview, notebook comm | messages | binary buffers where the channel carries them, otherwise base64 | messages |

## 9. Progressive views

A `rows` request with `preview: true` MAY be answered before the whole view is made:

- `view.status` is `building`. `readableRows` positions from the start of the view can be read, in their
  final order. `rowCount` is the number of rows when `rowCountExact` is true, and otherwise the number known
  so far (a lower bound).
- The answer holds positions up to `readableRows`. The client asks again, or follows `progress` events, for
  the rest, and reads its cached blocks again when the view becomes `ready`.
- Engines choose how to get there: the first rows of a sort by a top-N query, then the full order, then
  (for large views) a sorted copy for faster reads. Clients see only `status`, `readableRows`, `rowCount`
  and the speed.

A table that is loading (`status: "loading"`) answers `rows` with the plan `{}` for its readable rows.
Engines that report `partialViews` MAY also answer other plans over the readable rows, with
`view.partial: true`.

## 10. Conformance

The corpus in [`packages/spec/conformance`](../packages/spec/conformance) holds cases written as JSON, following
[`packages/spec/schema/conformance.schema.json`](../packages/spec/schema/conformance.schema.json):

```json
{
  "tables": {
    "letters": { "columns": [{ "name": "s", "type": "string" }], "rows": [["b"], [""], [null], ["a"]] }
  },
  "cases": [
    {
      "id": "order.blank-last-asc",
      "section": "3.3",
      "table": "letters",
      "plan": { "sort": [{ "column": "s", "direction": "asc" }] },
      "expect": { "rowCount": 4, "rowIds": [3, 0, 1, 2], "rows": [["a"], ["b"], [""], [null]] }
    }
  ]
}
```

- A case runs one plan on one table and reads `read` (`start`, `end` and `columns`; by default the whole view
  and all its columns). `expect` gives `rowCount` and `rows` (typed JSON, §2.2), and optionally `columns`
  (names and types) and `rowIds`; or an `error` (`code`, and `reason` for `invalid_plan`). `tolerance`
  allows a relative difference for floats (§3.8).
- The row IDs of a case table are its row positions.
- Expected results are written from this document and checked against DuckDB 1.5 through `vastgrid-sql`. A
  case on which DuckDB and this document disagree is a mistake in one of them, settled before the case is
  added.
- Every engine runs the whole corpus. Beyond it, engines are compared with each other on generated tables
  and plans.

## 11. Versions and changes

This document is `2.0-draft.1`. Until 2.0, drafts may change anything. After 2.0, minor versions add
functions, measures, members and capabilities without changing the meaning of plans that were valid before,
and changes of meaning need a major version. A change to sections 2–4 comes with conformance cases checked
against DuckDB, and the JS engine follows in the same change.

## 12. Open questions

- Native nested types (lists, structs, maps) instead of their text.
- Collations and folding (reading order of Japanese, full-width and half-width forms) as capabilities.
- `quantile` and `count_distinct` over dates and times; a `histogram` measure instead of `derive` then
  `aggregate`.
- The table that maps v1's formula language (`ROUND`, `MID`, `WEEKDAY`, `DAYS`, …) onto §4.4.
- Plans over a table that is still loading (`partialViews`): what `rowCount` and `where` mean there.
- Whether the key of the group of −0.0 and 0.0 reads as 0.0.

## Appendix A. From v1

| v1 | v2 |
| --- | --- |
| `TableSource.info` | `open`, `info` |
| `ViewQuery.sort` (column indexes) | `plan.sort` (names) |
| `filters`, `where` (`FilterNode`), `search` | `plan.where` (expressions, `search`) |
| `{ type: "values", values, exclude }` | `in`, with `coalesce` and `not`; blanks with `is_blank` |
| `{ type: "compare" }`, `between`, `text`, `blank` | comparisons; `contains`, `starts_with`, `ends_with` (with `lower` when letter case does not matter); `is_blank` |
| `formulas` (the formula language) | `plan.derive` (the formula language compiles to expressions) |
| `group`, `pivot`, the totals row | `plan.aggregate` and `pivot`; totals are `aggregate` without keys |
| `GroupedSource` (sorting and filtering groups) | `having` and `sort` of an aggregated plan |
| `columnStats` | plans with `count`, `count_distinct`, `min`, `max`, `avg`, `stddev` and `quantile`; the histogram is a bin made with `derive`, then `aggregate` |
| `distinctValues` | `aggregate` by the column with `count`, `sort`, then `rows` of the first n |
| `aggregate` (the selection summary) | `summarize` |
| `find` | `find` |
| `exportView` | `export` |
| `updateCells`, `saveEdits` | `write`, `save` |
| `subscribe`, `revision` | `changes`, events |
| view handles, `viewInfo` | the plan hash (§8.3), `view` in `rows` |
| `CellValue` (JSON, exact numbers as strings) | typed values: Arrow blocks and typed JSON |
| `RowBlock.rowIds` (positions) | `rowIds`, and row keys `{ rowId }` |
| `GridState` (version 1) | the document (version 2) and the session |

## Appendix B. DuckDB behavior this draft was checked against

DuckDB 1.5 through `@duckdb/node-api` 1.5.6-r.1, on 2026-10-24:

| Query | Result |
| --- | --- |
| `'NaN'::DOUBLE = 'NaN'::DOUBLE`, `'NaN'::DOUBLE > 'Infinity'::DOUBLE`, `-0.0::DOUBLE = 0.0::DOUBLE` | true, true, true |
| −Infinity, −1, 1, Infinity, NaN and NULL, ordered ascending and descending with `NULLS LAST` | −Infinity, −1, 1, Infinity, NaN, NULL; and NaN, Infinity, 1, −1, −Infinity, NULL |
| `1/0`, `0::DOUBLE/0`, `1 % 0` | Infinity, NaN, NULL |
| `9223372036854775807::BIGINT + 1`, and the same in `TRY()` | an error, NULL |
| `sqrt(-1)`, `ln(0)`, `ln(-1)` | errors |
| `exp(1000)`, `power(-8, 1/3)`, `power(0, -1)` | Infinity, NaN, Infinity |
| the types of `DECIMAL(10,2) + DECIMAL(5,3)`, of `*` and `/` on them, of `BIGINT + DECIMAL(3,1)`, `DECIMAL(3,1) % INTEGER` and `INTEGER / INTEGER` | DECIMAL(12,3), DECIMAL(15,5), DOUBLE, DECIMAL(21,1), DECIMAL(11,1), DOUBLE |
| the types of `sum(BIGINT)`, `sum(DECIMAL(10,2))` and `avg(DECIMAL(10,2))` | HUGEINT, DECIMAL(38,2), DOUBLE |
| `sum`, `min`, `max` and `avg` of NaN, 1 and Infinity | NaN, 1, NaN, NaN (v2 leaves the values that are not finite out, §3.8) |
| `count(DISTINCT x)` of NaN, NaN, 0.0, −0.0 and NULL | 2 |
| groups of NaN, NaN, 0.0, −0.0, NULL and NULL | 3 groups of 2 rows |
| `round(2.5)`, `round(-2.5)`, `round(1.005::DECIMAL(4,3), 2)` | 3, −3, 1.01 (DECIMAL(4,2)) |
| `CAST(x::DOUBLE AS VARCHAR)` for 1.0, 1e20, 0.1, 1e15, 1e16, 1e-7, 0.0001, 1e-5, −0.0, NaN and Infinity | `1.0`, `1e+20`, `0.1`, `1000000000000000.0`, `1e+16`, `1e-07`, `0.0001`, `1e-05`, `-0.0`, `nan`, `inf` |
| `CAST(0.1::FLOAT AS VARCHAR)`, `CAST(16777217::FLOAT AS VARCHAR)` | `0.1`, `16777216.0` |
| `CAST(TIMESTAMPTZ '2024-01-31 12:00:00+09' AS VARCHAR)` with `SET TimeZone = 'UTC'` | `2024-01-31 03:00:00+00` |
| `'｡' < '😀'`, `'B' < 'a'` | true, true (JavaScript's `<` answers false for the first) |
| `lower('İ')`, `lower('ΣΑΣ')`, `upper('ß')` | `i`, `σασ`, `ẞ` (JavaScript: `i̇`, `σας`, `SS`) |
| `length` of `e` followed by U+0301, and of a family emoji (a ZWJ sequence) | 2, 5 |
| `trim` of `' \t a \n '`, of U+3000 `a` U+3000, of U+00A0 `a` U+00A0, and of U+FEFF `a` U+FEFF | `\t a \n`, `a`, `a`, unchanged |
| `TRY_CAST('0x10' AS INTEGER)`, `TRY_CAST('1_000' AS INTEGER)`, `TRY_CAST('1.5' AS INTEGER)` | 16, 1000, 2 (`to_number` refuses these forms, §4.4) |
| `NULL IN ('a')`, `'b' IN ('a', NULL)` | NULL, NULL |
| `contains('', '')`, `contains(NULL, 'a')` | true, NULL |
| `isodow(DATE '2024-01-07')` (a Sunday), `date_diff('day', TIMESTAMP '2024-01-01 23:00', TIMESTAMP '2024-01-02 01:00')` | 7, 1 |
| `round(9223372036854775807::BIGINT, -1)`, `round(2147483647::INTEGER, -1)` | `-9223372036854775800`, `-2147483646`: the result wraps around instead of failing, so `vastgrid-sql` rounds integers through `DECIMAL(19,0)`, where overflow fails (and gives null, §3.6) |
| `TRY(sum(x))` | refused (`aggregates are not allowed inside the TRY expression`), so measures use `TRY_CAST` |

Two behaviors of `@duckdb/node-api` 1.5.6-r.1 matter to engines built on it:

- It reads text with a `TextDecoder` that drops a U+FEFF at the start of a value: `SELECT chr(65279) || 'a'` reads
  as `"a"` in JavaScript, while its `length` is 2. Engines read such strings another way (the conformance tests
  of `vastgrid-sql` read strings with a character in front).
- It binds JavaScript numbers without a fraction as `BIGINT`, so binding `1e20` fails with
  `bigint out of int64 range`. `vastgrid-sql` binds floats as text (`floatParam`) and casts them.
