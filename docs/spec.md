# vastgrid 0.2 specification

Status: **0.2** (2026-10-28). This document is normative for the engines, the grid core and the
surfaces of vastgrid 0.2. Why 0.2 is built this way is in
[the reconsideration of the rebuild](https://github.com/yhay81/vastgrid/blob/507862d/docs/rebuild-decision.ja.md) (Japanese); 0.1's protocol is
[protocol.md of v0.1.1](https://github.com/yhay81/vastgrid/blob/v0.1.1/docs/protocol.md). The conformance corpus in [`packages/spec/conformance`](../packages/spec/conformance)
turns the rules of sections 2–8 into cases that every engine and every core runs.

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
- [Appendix A. From 0.1](#appendix-a-from-01)
- [Appendix B. DuckDB behavior this specification was checked against](#appendix-b-duckdb-behavior-this-specification-was-checked-against)

## 1. Scope and terms

- **Table**: rows with a schema (named, typed columns), opened from a `ref` that the host resolves (a file,
  a database table). A table has a **revision**, which changes when its data changes other than by writes
  through this protocol, and an **edits version**, which changes with every write.
- **Row ID**: a non-negative integer that names a row of a table for one revision: its position in the
  table, from 0, in the order the table is read (for a file, its order in the file).
- **Plan**: a JSON description of a view of a table (§4): derived columns, a condition, grouping, a
  condition on groups and an order. A plan holds no table and no range.
- **View**: the rows a plan makes of a table, in order. Positions in a view count from 0.
- **Engine**: computes views. The reference engine is DuckDB 2.0 through the SQL that
  [`vastgrid-sql`](../packages/sql) makes; the JS engine computes the same results in JavaScript.
- **Core**: the grid without a screen: state (§5), commands (§6), the cache of blocks, the selection.
- **Surface**: a place the grid runs: a React app, a VS Code editor, a notebook, an MCP App, a browser
  app, a CLI. The React package, which is the screen of every surface, is specified in
  [react.md](react.md).
- **Transport**: what carries messages (§8) between the core and an engine: a function call, a Web
  Worker, HTTP, an MCP tool call, a VS Code webview, a notebook comm.

The meaning of plans (§3) follows DuckDB 2.0 unless this document says otherwise. Where it does, the SQL
that `vastgrid-sql` makes implements this document, not DuckDB's default. Appendix B lists the DuckDB
results this specification was checked against.

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

Dates and timestamps are written for the years 0001 to 9999, which `YYYY` holds; how values outside them are
written is an open question (§12).

Typed JSON is already a value of its declared type, rather than text awaiting conversion:

- A finite `float` with `bits: 32` MUST equal its IEEE 754 binary32 value (for example,
  `0.10000000149011612`, not `0.1`). Other finite numbers, including overflow and underflow, are invalid
  typed JSON for that type. Typed input is rounded before it becomes typed JSON (§7.3).
- A `string` MUST be well-formed Unicode text: paired UTF-16 surrogates are allowed, lone surrogates are
  not. Readers and writers MUST NOT silently replace invalid text with U+FFFD.
- A `timestamp` MUST fit a signed 64-bit count of its unit since the Unix epoch. For `ns`, the inclusive
  bounds are `1677-09-21 00:12:43.145224192` and `2262-04-11 23:47:16.854775807`. Other units remain
  limited by the years above. Engines may have a narrower source range (for example reserved infinity values).
- An `interval` has signed 32-bit months and days (−2^31 through 2^31 − 1) and signed 64-bit nanoseconds
  (−2^63 through 2^63 − 1). Its parsed totals MUST fit these ranges; blocks write the canonical text of
  those same three parts when read back.
- A JSON number for `bigint` MUST be a safe integer. Larger values MUST use the string form; accepting
  both forms does not allow an unsafe number.

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
of the column's `bits` (for 32-bit floats, as the same 32-bit float); of two as short, take the nearer to the
float, and of two as near, the one whose last digit is even (the 32-bit 5525.71875 is `5525.7188`):

- NaN is `nan`, the infinities are `inf` and `-inf`, and zero is `0.0` or `-0.0`.
- When −4 ≤ e < 16, the number is written in fixed notation with at least one digit after the point:
  `1.0`, `100.0`, `0.0001`, `123456789.125`, `9999999999999998.0`.
- Otherwise it is written as d₁, then `.` and the other digits if there are any, then `e`, the sign (`+` or
  `-`) and at least two digits of the exponent: `1e+16`, `1e-05`, `1.2345678901234567e+19`, `5e-324`.

This is Python's `repr` of a float. In JavaScript, `x.toExponential()` gives the digits and the exponent of a
64-bit float; for a 32-bit float, round its exact digits to ever more digits, halves to even, until
`Math.fround` reads them back as the same value.

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
- **Intervals** compare by their length, with months of 30 days and days of 24 hours, as DuckDB 2.0 does:
  `1 month` equals `30 days`, and `1 month -1 day` equals `29 days`.
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
- `lower` and `upper` map each code point by itself, with the simple case mappings that DuckDB 2.0 uses
  (from utf8proc): `lower("İ")` is `"i"`, `lower("ΣΑΣ")` is `"σασ"` (no final sigma) and `upper("ß")` is
  `"ẞ"` (U+1E9E). No context is used, and every code point stays one code point. JavaScript's
  `toLowerCase` gives `"i̇"` and `"σας"`, and `toUpperCase` gives `"SS"`; JS engines MUST map code points
  one by one, with the conformance corpus as the reference.
- Matching that ignores letter case is written with `lower` on both sides:
  `contains(lower(x), lower("Tokyo"))`. Nothing else is folded in 0.2 (full-width and half-width forms,
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
  `quantile_cont`): with `n` values in order and `h = p × (n − 1)`, it is `x[⌊h⌋] × (1 − w) + x[⌈h⌉] × w`
  where `w = h − ⌊h⌋`, computed in 64-bit floats. Over numbers it is a float. Over temporal values it counts
  microseconds (since midnight for a time, since 1970-01-01 00:00:00 for the others, with a fraction for
  nanoseconds) and rounds the result to the nearest microsecond, halves away from zero: it is a timestamp (in
  microseconds) over dates and timestamps of any unit, a time over times, and a timestamptz over timestamptz
  values. The median of `2024-01-01` and `2024-01-02` is `2024-01-01 12:00:00`.

Sums and averages of floats depend on the order of the additions. Engines MAY add in any order, and
conformance compares them with a relative tolerance. Measures with `"approx": true` (`count_distinct`,
`quantile`) MAY be approximated; conformance does not test them.

### 3.9 Groups

`aggregate` makes one group for each distinct combination of key values, by §3.1 equality, except that
null and the empty string are each a group of their own, different from each other. All NaNs form one
group, and so do −0.0 and 0.0, whose key reads as 0.0 whichever comes first, as do the values of a pivot and
the names of its columns (§4.6).

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
| `bin` | a number, and `width`: a positive number literal that the number's type holds (a whole number for integers and bigints, at most s places for a decimal(p, s)) | the number's type, floats stay floats: the greatest multiple of `width` not above the number, so `bin(-0.1, 0.25)` is −0.25. Null when that is outside the type. Exact types bin exactly, without going through floats |
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
| `quantile` | a number or temporal column, with `p` from 0 to 1 | §3.8 |

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
are the same view; engines MAY keep views by table, revision, edits version and hash (§8.3). Browsers give
`crypto.subtle`, and so `planHash` of `vastgrid-spec`, only to secure pages (HTTPS and `localhost`): a client
in another page takes hashes from the engine's answers (`view.hash`), as `vastgrid` does, and an engine there
cannot make them.

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
  "locate": true,
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

### 4.11 Formulas

People write derived columns as **formulas**, which compile to expressions; documents hold only the
expressions (§5.1), and grids write them back as formulas to show and change them. The language is 0.1's,
with every function of §4.4 and literals of every type. `vastgrid-spec` gives `compileFormula` and
`formulaText`.

A formula is made of:

- **Column names**: `price`, or in brackets when the name is not a letter or `_` followed by letters,
  digits, marks and `_`, or when it is a word of the language: `[unit price]`, `[and]` (`]]` is a `]`).
- **Numbers**, kept exact (§2.5): digits are a bigint (beyond 64 bits, a decimal), digits with a point a
  decimal (`1.50` is a decimal(3, 2)), and a number with an exponent a float (`1.5e0`, `2e3`). A minus
  written before a number is part of it.
- **Text** in single or double quotes, with the quote doubled inside (`'it''s'`); `TRUE`, `FALSE` and
  `NULL`.
- **Literals of a type**: the type's name, then its text form (§2.4) in quotes, or `NULL`:
  `DATE '2024-01-31'`, `TIMESTAMP '2024-01-31 12:00:00'`, `FLOAT 'nan'`, `UUID '…'`, `DATE NULL`. Dates and
  timestamps may also be written as 0.1 read them: `2024-1-5`, with `T` or a space before the time, without
  seconds.
- **Operators**, from the lowest precedence; chains of `AND`, `OR` and `&` are one call, and the others
  group from the left:

| Operators | Function |
| --- | --- |
| `OR` | `or` |
| `AND` | `and` |
| `NOT` | `not` |
| `=` (`==`), `<>` (`!=`), `<`, `<=`, `>`, `>=` | `eq`, `ne`, `lt`, `le`, `gt`, `ge` |
| `&` | `concat` |
| `+`, `-` | `add`, `sub` |
| `*`, `/`, `%` | `mul`, `div`, `mod` |
| `-` before a value | `neg` |

- **Calls**, with names in any letter case: every function of §4.4 other than `and`, `or` and `not` by its
  own name (`STARTS_WITH(name, 'A')`, `IN(region, 'east', 'west')`, `DATE_DIFF_DAYS(start, end)`), and 0.1's
  functions. Those of 0.1 that have the name of a function of §4.4 (`ABS`, `ROUND`, `LEFT`, `TEXT`, `IF` with 3
  arguments, …) are that function; the others are:

| 0.1 | Expression |
| --- | --- |
| `CEILING(x)`, `LEN(s)`, `MID(s, start, n)`, `STARTSWITH`, `ENDSWITH`, `ADDDAYS`, `ISBLANK` | `ceil`, `length`, `substr`, `starts_with`, `ends_with`, `add_days`, `is_blank` |
| `WEEKDAY(d)` | `isodow(d)`: Monday is 1 |
| `DAYS(end, start)` | `date_diff_days(start, end)` |
| `MIN(a, …)`, `MAX(a, …)` | `least`, `greatest`; with one argument, that argument |
| `IF(c, a)` | `if(c, a, null)` |
| `VALUE(x)` | `to_number(x)`; a number as it is |
| `DATE(x)` | text in quotes: a date literal; text: `to_date(x)`; a timestamp: `to_date(left(text(x), 10))` |
| `DATETIME(x)` | text in quotes: a timestamp literal; text: `to_timestamp(x)`; a date: `to_timestamp(concat(text(x), ' 00:00'))`; a timestamptz: `to_timestamp(replace(text(x), '+00', ''))` |

Like 0.1, a formula converts some values where its functions take another kind (other mixtures are type errors,
§4.7):

- Text in quotes beside a date, a timestamp or a timestamptz (compared, or in `least`, `greatest`,
  `coalesce`, `if` and `in`), or where a date or a timestamp is taken (`YEAR('2024-03-01')`), is a literal of
  that type when it reads as one.
- Times, intervals, UUIDs and binary values, which 0.1 read as text, are taken through `text` where a string is
  taken or compared with text.
- A date where a time or a timestamp is taken (`HOUR(day)`) is its midnight, and a timestamptz where a date or a
  timestamp is taken is its timestamp in UTC, as with `DATETIME`.
- A whole number written with a point (`3.0`) where an integer is taken (`left`, `right`, `substr`, `add_days`,
  and the digits of `round`) is that integer.

Every expression other than `search` is written as a formula that compiles back to it: functions with an
operator as operators, in parentheses where precedence needs them (`(a & b) & c` stays two calls), the others
by their names in capitals, and literals as above, with a type and quotes when the plain form would read as
another literal (`FLOAT '0.5'`, `BIGINT '5'`; a whole float is `2e0`).

A formula that does not compile has a reason of §4.7 (`syntax`, `unknown_column`, `unknown_function`,
`arity`, `type`, `literal`, `limit` or `unsupported`) and the characters it is about. Formulas have at most
100,000 characters and 64 levels of nesting, and their expressions the limits of §4.9.

0.1 computed every number as a 64-bit float. With the rules of §2–§4, some formulas give other results than in
0.1 (the tests of `vastgrid-duckdb` run 0.1's formula tests through DuckDB):

| Formula | 0.1 | 0.2 | Why |
| --- | --- | --- | --- |
| `ROUND(0.285, 2)`, `[unit price] * 2` (a decimal(10, 2) of 1.50) | 0.28, 3 | `"0.29"`, `"3.00"` | exact numbers stay exact (§3.7) |
| `TRIM(name) & ok`, `TEXT(price * 2)`, `TEXT(0.00001)` | `…TRUE`, `5`, `1e-05` | `…true`, `5.0`, `0.00001` | the text forms of §2.4 |
| `LEFT('abc', NULL)` | `""` | null | a null argument gives null (§3.6) |
| `VALUE('1_000')`, `DATE(text)` of `2024-1-5` | 1000, a date | null, null | `to_number` and `to_date` read the forms of §4.4 |
| `ROUND(x, 400)`, `NULL = NULL` | x, null | refused (`type`) | `round`'s digits go from −18 to 18; two nulls have no type |

## 5. State

The state is JSON in two parts with their own versions: the **document** (what a person saves, shares or
gives an agent: the view and its columns) and the **session** (where the person is: the selection, the
scroll position, the checked rows, an editor, the undo history). Both are plain data. Commands (§6) change
them; the core reads the data that they need and tells the commands what it knows (§6.1).

[`state.schema.json`](../packages/spec/schema/state.schema.json) gives the form of both.

### 5.1 Document

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "schema": ["id", "region", "qty", "price"],
  "rowKey": "id",
  "plan": { "sort": [{ "column": "price", "direction": "desc" }] },
  "columns": [
    { "name": "id", "pin": "left" },
    {
      "name": "price",
      "width": 120,
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

| Member | Value | Absent | Meaning |
| --- | --- | --- | --- |
| `kind` | `"vastgrid/document"` | required | |
| `version` | `2` | required | §5.6 |
| `schema` | the table's column names, in order | unknown | the names when the document was saved, to tell what changed (§5.5) |
| `rowKey` | a column name | rows are keyed by row ID | a table column whose values identify records (§5.3) |
| `plan` | a plan (§4) | `{}` | the view |
| `columns` | column settings, at most 100,000 | none | settings by column name, in display order (§5.1.1) |

A column setting is `{ "name" }` with any of:

| Member | Value | Absent | Meaning |
| --- | --- | --- | --- |
| `width` | a number of CSS pixels, from 1 to 100,000 | the core fits the column to its values | |
| `hidden` | `true` | shown | |
| `pin` | `"left"` or `"right"` | scrolls | the column stays at that side while the others scroll |
| `format` | below | the defaults | how values are shown |
| `total` | `{ "fn", "p"? }`, a measure of §4.5 without `name` and `column` | no total | the column's value in the totals row: the measure of the column over the whole view |

`format` has `label` (shown instead of the name), `number` and `date` (0.1's `NumberFormat` and
`DateFormat`), `align` (`left`, `center` or `right`), `wrap` (`true` to wrap text), `copy` (`raw` or
`formatted`, §6.6), and `styles`: rules tried in order, the first whose `when` is true giving `color`,
`background` and `description` (what the colors mean, read by screen readers). `when` is an expression
over the row (§4.3) without `search`; a rule whose `when` does not validate against the view is skipped.
Functions (0.1's `format` and `style` callbacks) are not state: they stay props of the React component and
win over `styles`.

Two settings MUST NOT have the same name. Settings of names that the view does not have are kept, for when
the names come back, and do nothing meanwhile.

#### 5.1.1 Displayed columns

The **displayed columns** of a document for a view are found as follows.

1. Each column of the view takes its setting, or the default setting when `columns` has none for it.
2. The columns that are not hidden are displayed in this order: those with `pin: "left"` in the order of
   `columns`; then those without `pin`, first the ones in `columns` in their order, then the others in view
   order; then those with `pin: "right"` in the order of `columns`.
3. When every column of the view is hidden, the first column of the view is displayed.

Selections, scroll positions and editors (§5.2) name displayed columns. Display positions count from 0, from
the left.

### 5.2 Session

```json
{
  "kind": "vastgrid/session",
  "version": 2,
  "view": "sha256:…",
  "revision": "1730000000-74512",
  "active": { "row": 120, "column": "price", "key": { "rowId": 5012 } },
  "anchor": { "row": 100, "column": "region" },
  "focus": { "row": 140, "column": "price" },
  "selection": [{ "rows": [100, 141], "columns": ["region", "qty", "price"] }],
  "scroll": { "row": 95, "column": "id" },
  "checked": { "mode": "include", "keys": [{ "rowId": 3 }, { "rowId": 9 }] },
  "detail": { "open": true },
  "editor": { "row": 120, "column": "price", "key": { "rowId": 5012 }, "text": "12", "value": "11.50" },
  "history": { "undo": [], "redo": [] }
}
```

| Member | Value | Absent | Meaning |
| --- | --- | --- | --- |
| `kind`, `version` | `"vastgrid/session"`, `2` | required | |
| `view` | a plan hash (§4.8) | the current view | the view whose positions the session holds |
| `revision` | a table revision | unknown | the revision that row IDs in keys belong to |
| `active` | `{ "row", "column", "key"? }` | the first row and the first displayed column | the active cell: its view position, its column, and its row's key (§5.3) when known |
| `anchor`, `focus` | `{ "row", "column" }` | the active cell | the corners of the last range: Shift moves `focus` and keeps `anchor` |
| `selection` | 1 to 1,000 ranges | the active cell | the selected cells; the last range is the one Shift and the keyboard extend |
| `scroll` | `{ "row", "column"? }` | the start | the view position and the column at the top left; the core restores the place, not the pixels |
| `checked` | `{ "mode", "keys", "where"? }` | no checked rows | §5.2.1 |
| `detail` | `{ "open" }` | closed | the detail panel of the active row |
| `editor` | `{ "row", "column", "key", "text", "value" }` | no editor | a cell being typed in: the text so far, and the value the cell had when the editor opened |
| `history` | `{ "undo": [steps], "redo": [steps] }` | empty | §7.4 |

A **range** is `{ "rows", "columns" }`: `rows` is `[start, end)` of view positions or `"all"` (whole
columns), and `columns` is a list of displayed columns in display order, or `"all"` (whole rows). A range of
one cell is `{ "rows": [5, 6], "columns": ["price"] }`. The columns of a range are those between its corners
when it was selected; columns moved since may leave gaps between them, and the range then holds the listed
columns only.

#### 5.2.1 Checked rows

Checked rows are kept by key, so that the same records stay checked when the view is sorted or filtered.
`mode: "include"` checks the rows of `keys`. `mode: "exclude"` checks every row except those of `keys`:
every row of the table, or, with `where`, every row for which `where` (an expression of §4.3 over the
table's columns and the derived columns) is true.

`where` goes only with `exclude`. A row of a view is checked, not checked, or **unknown**:

- with `include`: checked when its key is in `keys`;
- with `exclude` and no `where`: checked unless its key is in `keys`;
- with `exclude` and `where`: when the view's `where` **implies** it, checked unless its key is in `keys`;
  otherwise unknown, since the view may hold rows for which `where` is not true. The view's `where` implies
  it when every part (§6.2.1) of `where` is a part of the view's `where` (the same canonical JSON, §4.8), or
  is a search whose text is contained in the text of the view's search (a row with a value that contains
  `"abc"` also has one that contains `"ab"`, since `lower` maps code points one by one, §3.4).

`check.all` (§6.4) makes `{ "mode": "exclude", "keys": [] }` with the view's `where` when it has one.

### 5.3 Row keys

A **row key** names a record. Without `rowKey`, it is `{ "rowId": n }`, the row ID (§1), valid for one
revision. With `rowKey`, it is `{ "value": v }`, the typed JSON value (§2.2) of that column, valid across
revisions; a row whose value is null is keyed by `{ "rowId": n }`. Two keys are the same when their JSON is
the same once bigint values are written as numbers when they are safe (§2.2). Selections keep positions;
the active cell, checked rows, editors, writes and history keep keys.

### 5.4 When the view or the revision changes

The core applies `view.update` (§6.7) when it reads a view whose hash or table revision differs from the
session's. Its arguments are the new hash and the positions in the new view of the keys that the session
holds (from `locate`, §8.2); its context (§6.1) is that of the new view, with the table's revision.

1. When the session's `revision` is present and differs from the context's, row-ID keys name other records:
   they are removed from `checked.keys` and from `active`, the history is emptied (§7.4), and the editor is
   closed. `revision` becomes the context's.
2. When the session's `view` is present and differs from the hash, positions name other rows: the active
   row moves to the position of its key in the new view, or to 0 when it has no key or its key is not
   there (the active cell then takes the key of row 0 when `context.rows` holds it, and has no key
   otherwise); `selection`, `anchor` and `focus` are removed, so that they are the active cell; the editor
   is closed; and `scroll.row` becomes the active row when the active row moved. `view` becomes the hash.
3. Then the session is **fitted** to the view: rows of the active cell, `anchor`, `focus`, `scroll` and
   ranges are clamped to the rows (to 0 in a view without rows; a range keeps at least one row); an active
   column that is no longer displayed becomes the first displayed column; `anchor` and `focus` in a column
   that is no longer displayed are removed; ranges lose the columns that are no longer displayed, and a
   range left without columns is removed (`selection` itself, when none is left); `scroll.column` is
   removed when it is no longer displayed; and an editor in a column that is no longer displayed, or in a
   row beyond the rows, is closed.

`checked` and `detail` stay as they are.

### 5.5 Repairing a document for a table

A document saved for a table may meet a table whose columns differ (renamed, removed, retyped). The core
repairs its plan before using it, removing what does not validate (§4.7) against the table, or that the
engine does not evaluate (§4.10). Each item is tried with the plan kept so far and the items kept before it,
in this order:

1. `derive`: each derived column whose expression does not validate is removed.
2. `where`: when it does not validate, the arguments of an `and` that do not validate are removed, or, when
   it is not an `and`, it is removed. An `and` left with one argument becomes that argument, and one left
   with none is removed.
3. `aggregate`: keys, then measures, that do not validate are removed, and so is `pivot` when the aggregate
   does not validate with it. An aggregate left without keys and measures is removed.
4. `having`: as `where`, against the aggregated view; it is removed with `aggregate`.
5. `sort`: keys that do not validate are removed.

Totals of column settings that do not fit their column's type (`sum` of a string column) are removed. The
repair reports the JSON Pointers (into the document) of what it removed, in this order, so that the grid can
tell the person.

### 5.6 Versions and migration

Readers MUST accept the versions they know and refuse the others (`invalid_state`, `reason: "version"`).

0.1's `GridState` (version 1) migrates into a document by these rules; Appendix A gives the expressions:

| 0.1 | 0.2 |
| --- | --- |
| `schema` | `schema` |
| `query.sort` (indexes into `schema`) | `plan.sort` (names) |
| `query.search`, `query.filters`, `query.where` | `plan.where`: an `and` of the search, the filters and the parts of the tree (§6.2.1), in that order |
| `formulas` | `plan.derive`, compiled by §4.11, each after the formulas it uses (in 0.1's order otherwise); a formula that does not compile, that uses itself through others or that has the name of a table column is not migrated, and neither is what uses it |
| `columns[].{name, width, hidden, total}` | `columns[].{name, width, hidden, total: { fn }}` |
| `frozenColumns`, `frozenRightColumns` | `pin: "left"` on the first n shown columns, `pin: "right"` on the last n |
| `group.keys`, `group.aggregates`, `group.pivot` | `plan.aggregate`: measures named as 0.1 named their columns (`count(*)`, `sum(amount)`, then ` (2)`, …) |
| `group.state.query.sort`; its filters and tree | `plan.sort` (`query.sort` is then not migrated); `plan.having` |
| `group.state.query.search` | not migrated (a search applies to the table's rows, not to groups) |
| `group.state.columns` | appended to `columns` for names not listed yet; its frozen columns are not migrated |

A 0.1 query saved without a state (an object of `sort`, `filters`, `where` and `search` only) migrates as a
state with that query. Indexes into `schema` name its columns; without `schema`, they are positions of the
table's columns, then of the formulas. The migration reports the JSON Pointers (into the 0.1 state) of what it
could not migrate, each with why, and the document is then repaired for the table (§5.5).

## 6. Commands

### 6.1 Applying a command

A command is a JSON object `{ "command": name, …arguments }`. Applying it to a state with a context gives a
new state, the requests (§8.2) that the core then sends, and for some commands an output:

```
apply({ document, session }, command, context) → { document, session, requests, output? }
```

[`commands.schema.json`](../packages/spec/schema/commands.schema.json) gives the form of every command in
`$defs/command`, for hosts and agents that send them.

The **context** is what the core knows when it applies the command:

| Member | Value | Meaning |
| --- | --- | --- |
| `table` | columns (§2.1) | the table's columns |
| `revision` | a revision, or null | the table's revision |
| `view` | `{ "columns", "rowCount", "rowIds" }` | the current view of the document's plan: its columns (§4.2, with the generated columns of a pivot), its row count, and whether it has row IDs |
| `rows` | blocks `{ "start", "keys"?, "columns"?, "values" }`, optional | rows of the view that the core has read: from position `start`, their keys (§5.3; absent for views without row IDs) and their values, one array per row with the values of `columns` (all the view's columns, in view order, when absent) |
| `page` | a positive integer | rows on a page, for Page Up and Page Down |
| `capabilities` | §4.10, optional | what the engine offers; everything when absent |
| `clipboard` | `{ "text"?, "html"? }`, optional | what `edit.paste` pastes |
| `locale` | a BCP 47 tag, optional | the locale of formatted values (`copy`, §6.6) |

In `capabilities`, absent `functions` and `measures` are all of them and an absent member of `plan` is
true; the other members are false when they are absent.

A core MAY give `rows` in a form of its own, as long as commands see the same rows: `vastgrid-spec`'s
`applyCommand` also takes `lookup`, a function from a view position to the row the core has read, so that a
core that keeps its rows in typed columns gives them without copying them into blocks. The reference
implementation reads only the rows a command uses, and copies only the parts of the state that it changes.

Commands are deterministic: the same state, command and context give the same result. Requests are given
without `v`, `id` and `table`, which the core adds. A command that fails changes nothing and gives an error
`{ "code": "invalid_command", "path", "reason", "message", "details"? }`, where `path` is a JSON Pointer into
the command (`""` for the command as a whole). When several reasons apply, the command fails with the first of
this table:

| `reason` | When |
| --- | --- |
| `unknown_command` | there is no such command |
| `syntax` | an argument of the wrong form, a missing argument, or a member the command does not take |
| `unknown_column` | a column that the view does not have, or that is not displayed where a displayed one is needed |
| `no_editor` | an editor command without an editor |
| `nothing` | `history.undo`, `history.redo`, `history.undone` or `history.redone` with nothing to undo or redo |
| `unsupported` | the engine does not offer it |
| `unknown_state` | checking or unchecking rows whose state is unknown (§5.2.1) |
| `last_column` | hiding every column of the view |
| `type` | a total that does not fit the column's type |
| `copy_layout` | ranges that cannot be copied together (§6.6) |
| `paste_ranges` | several values pasted into several ranges |
| `read_only` | writing a cell that is not written (§7.1); `details` has the `column` |
| `too_many_cells` | a write of more than 100,000 cells, or a copy of more than 1,000,000 |
| `not_loaded` | rows that the command needs are not in `context.rows`; `details` has `rows`, the spans `[start, end)` to read, and `columns`, the columns whose values are missing (in view order; empty when only keys are) |
| `invalid_value` | text that does not read as its column's type (§7.3); `details` has `row`, `column` and `error`, for the first such cell |
| `invalid_plan` | the plan the command would make does not validate; `details` has the plan error's `path` and `reason` |

Commands give sessions in one form, so that every core gives the same JSON:

- Commands that set the active cell (§6.4, `edit.commit` with `move`) write `active`, `anchor`, `focus` and
  `selection`, with the last 1,000 ranges. The active cell has the key of its row when `context.rows` holds
  it, keeps its key when its row does not change, and has no key otherwise.
- `checked` is left out when it is `include` without keys, `detail` when the panel is closed, and `history`
  when both lists are empty.

Commands that change columns (§6.3) write a setting for every column of the view, in this order: the
columns pinned left, then the other settings (columns without pin, hidden columns and the settings of names
that the view does not have), then the columns pinned right, each group in the order it had, with the columns
that had no setting after the others of the middle group, in view order. This keeps the display order of
§5.1.1, and a hidden column keeps its place for when it is shown again. These commands then fit the session
to the displayed columns (§5.4, step 3).

### 6.2 The plan

| Command | Arguments | Effect |
| --- | --- | --- |
| `sort.set` | `keys`: sort keys | `plan.sort` becomes `keys` (no keys remove it) |
| `sort.toggle` | `column`: a column of the view; `add`: boolean (default false) | Without `add`, by the column's key: none gives `[asc]`, `asc` gives `[desc]`, and `desc` removes `sort`, replacing the other keys. With `add`: an `asc` key becomes `desc` in its place, a `desc` key is removed, and a column without a key is added `asc` at the end |
| `sort.clear` | | removes `plan.sort` |
| `filter.set` | `where`: an expression or null | the conditions (§6.2.1) become the parts of `where`, after the search |
| `filter.column` | `column`: a column of the rows (the table's or a derived one); `where`: an expression or null | the conditions of the column become the parts of `where` |
| `filter.clear` | | removes the conditions, keeping the search |
| `search.set` | `text` | the search becomes `{ "search": text }`, first; a text that `trim` leaves empty (§4.4) removes it |
| `derive.add` | `name`, `expr`; `before`: a derived column | adds a derived column at the end, or before `before` |
| `derive.update` | `name`: a derived column; `expr`; `rename`: a new name | changes the expression, and gives the column a new name (§6.2.2) |
| `derive.remove` | `name`: a derived column | removes the column and what uses it (§6.2.2) |
| `group.set` | `aggregate` | sets `plan.aggregate`, then removes the parts of `having` and the sort keys that do not validate against the groups |
| `group.clear` | | removes `aggregate` and `having`, and the sort keys that do not validate against the rows |
| `having.set` | `having`: an expression or null | sets or removes `plan.having` |

Commands check the columns their arguments name (`unknown_column`); the plan they make is then checked as
a whole against the table, with the engine's capabilities (§4.7, §4.10), and one that does not validate
fails the command with `invalid_plan` and the path `""`. Removing parts of `having` and sort keys, as
`group.set`, `group.clear` and `derive.remove` do, tries each with the plan and the items kept before it.
Plan commands write `plan` even when it becomes `{}`, without empty `derive` and `sort`; they give no
requests (the core reads the new view and applies `view.update`) and do not change the session, except
`derive.update` with `rename`.

#### 6.2.1 Conditions and the search

Commands treat `where` as its **parts**: the arguments of an `and`, or `where` itself; there are none
without `where`. The parts that are `{ "search" }` are the search, and the others are **conditions**. The
**conditions of a column** are those that refer to that column and to no other. Parts become `where` again as
their only part, or as an `and` of them; with no parts, `where` is removed.

- `filter.set` keeps the search parts, then puts the parts of its `where`.
- `filter.column` removes the conditions of its column and puts the parts of its `where` in the place of the
  first one it removed, or at the end. Every part of its `where` refers to the column and to no other
  (`syntax` otherwise).
- The `where` of `filter.set` and `filter.column` holds no search part (`syntax`); `search.set` sets it.

#### 6.2.2 Removing and renaming derived columns

`derive.remove` removes the derived column, the derived columns that use it (and those that use them), and
what uses any of them: the parts of `where` that do, aggregate keys, measures of their columns, and the
pivot when one of its columns is removed (an aggregate left without keys and measures is removed, with
`having`); then the parts of `having` and the sort keys that no longer validate; and the settings of the
removed columns, unless the new view has a column of that name.

`derive.update` with `rename` gives the new name to the derived column and to every `{ "col" }` of the old
name in `derive` and `where`, to aggregate keys, measure columns and pivot columns, and to `checked.where`.
When the column is a column of the view (there is no `aggregate`, or it is one of its keys), it also gives
it to the `{ "col" }` of `having`, to sort keys, to the `when` of every style, to its cells in the session
(`active`, `anchor`, `focus`, `selection`, `scroll`, `editor`), and to its setting, which replaces a setting
of the new name. Otherwise, in `having`, sort keys and styles the old name names a column of the aggregated
view, which keeps it; the setting is renamed when the view has no column of the old name.

### 6.3 Columns

| Command | Arguments | Effect |
| --- | --- | --- |
| `column.resize` | `name`: a column of the view; `width`: a width or null | sets the width, or fits the column to its values again |
| `column.move` | `names`: displayed columns, each once; `before`: a displayed column that is not moved, or null | moves the columns, in display order, before `before` and gives them its pin; with null, after the last displayed column without pin (before the first one pinned right), without pin |
| `column.hide` | `names`: columns of the view | hides the columns and removes their pins; fails with `last_column` when every column of the view would be hidden |
| `column.show` | `names`: columns of the view, or `all: true` | shows the columns, or every column of the view |
| `column.pin` | `name`: a displayed column; `side`: `"left"`, `"right"` or null | pins the column at that side, at the inner end of the columns pinned there (before the first displayed column not pinned left, or before the first one pinned right); with null, the column becomes the first column without pin (from the left side) or the last one (from the right side); a column already at that side does not move |
| `column.format` | `name`: a column of the view; `format`: a format or null | sets or removes the format |
| `column.total` | `name`: a column of the view; `total`: `{ "fn", "p"? }` or null | sets or removes the total; a measure that does not take the column's type (§4.5) fails with `type` |

### 6.4 Selection, scrolling and checked rows

In this section, positions are clamped to the view's rows (0 in a view without rows) and to the displayed
columns, `extend` moves `focus` and keeps the active cell and `anchor`, and a range **from `anchor` to a
cell** spans the rows and the displayed columns between them. Extending keeps what the last range selects as
a whole: whole rows (`columns: "all"`), whole columns (`rows: "all"`) or every cell. Without displayed
columns, these commands change nothing.

| Command | Arguments | Effect |
| --- | --- | --- |
| `select` | `row`, `column`: a displayed column; `mode`: `replace` (default), `extend` or `add` | `replace`: the cell becomes the active cell, `anchor`, `focus` and the only range; `extend`: the cell becomes `focus` and the last range spans from `anchor` to it; `add`: as `replace`, but the range is added after the others |
| `select.rows` | `from`, `to`; `mode` | `replace` and `add`: whole rows from `from` to `to`, with the active cell and `anchor` in row `from` and `focus` in row `to`, in the active column; `extend`: `focus` moves to row `to` and the last range becomes the whole rows from `anchor` to it |
| `select.columns` | `from`, `to`: displayed columns; `mode` | the same with whole columns, in the active row |
| `select.all` | | every cell: one range `{ "rows": "all", "columns": "all" }`, with `anchor` and `focus` at the active cell |
| `move` | `direction`: `up`, `down`, `left` or `right`; `extend`, `jump`, `page`: booleans | moves from the active cell (from `focus` with `extend`) by one, by `context.page` rows with `page` (`up` and `down` only, `syntax` otherwise), or to the first or last row or column with `jump` (which wins over `page`) |
| `move.home`, `move.end` | `extend`, `jump`: booleans | to the first or last displayed column of the row of the active cell (of `focus` with `extend`); with `jump`, also to the first or last row |
| `advance` | `axis`: `row` or `column`; `back`: boolean | Enter (`row`) and Tab (`column`), with Shift as `back`: in a selection of one range of several cells that holds the active cell, the active cell walks through the range along the axis, wrapping to the next column (or row) at the end and to the start at the last cell, and the selection stays; otherwise it moves like `move` down, up, right or left |
| `scroll.to` | `row`; `column`: a displayed column | sets `scroll` |
| `check`, `uncheck` | `keys`: row keys | checks or unchecks rows by key (§5.2.1): with `include`, keys are added at the end (once) or removed; with `exclude`, the other way; fails with `unknown_state` while the rows' state is unknown |
| `check.all` | | checks every row of the view (§5.2.1) |
| `check.clear` | | checks no row |
| `detail.open`, `detail.close` | | opens or closes the detail panel |

Moving without `extend` makes the active cell `anchor`, `focus` and the only range.

### 6.5 Editing

| Command | Arguments | Effect |
| --- | --- | --- |
| `edit.begin` | `text` | opens an editor on the active cell with `text`, or with the cell's value as text (§7.3); `value` is the cell's value |
| `edit.change` | `text` | changes the editor's text |
| `edit.cancel` | | closes the editor |
| `edit.commit` | `move`: `up`, `down`, `left`, `right` or null | reads the text as the column's type (§7.3) and writes it into the editor's cell, with `previous` the editor's `value`; the editor closes, and the active cell moves as `advance` moves it (`down` and `up` along rows, `right` and `left` along columns) |
| `edit.clear` | | writes null into the selected cells that are writable and not blank (§3.2); fails with `read_only` when no selected cell is writable |
| `edit.paste` | | pastes `context.clipboard` into the selection (§6.5.1); `output` is `{ "cutRows", "cutColumns" }` |
| `edit.fill` | `direction`: `down` or `right` | copies the first row (or column) of each range into its other rows (or columns); a range of one row (or column) takes the row above it (or the displayed column left of it), and a range without one is left as it is |
| `history.undo`, `history.redo` | | writes the values before (or after) the last step (§7.4) |

A command that writes gives one `write` request (§8.2) with the context's revision and, when the document
has one, its `rowKey`. Its updates are the cells in the order of the ranges, row by row and column by
column, each cell once, with `previous`, the value the cell had (§7.2); cells whose value would not change
are left out, and a command left without updates gives no request. The cells a command writes MUST be
writable (§7.1, `read_only`), and their keys and values, and those of the cells it copies from, MUST be in
`context.rows` (`not_loaded`). `edit.commit` writes by the editor's key and value, and `history.undo` and
`history.redo` by the step's keys, without `context.rows`; they only need writable columns. Filled values
keep their value when the two columns have the same type, and are otherwise read from their text form
(§2.4) as the target column's type (§7.3).

#### 6.5.1 Pasting

`edit.paste` reads `context.clipboard.text` as TSV (§6.6), or, when it has no text, the first table of
`context.clipboard.html`; with no values, it does nothing. The values go from the top-left cell of each
range:

- They are repeated over a range whose rows and columns are whole multiples of theirs, and pasted once
  otherwise, into as many rows and displayed columns from that cell as they have.
- A single value goes into every selected cell, also of several ranges; several values cannot go into
  several ranges (`paste_ranges`).
- Rows and columns beyond the view are left out, and `output` counts them; rows are never added.
- Values are read as their column's type with digit grouping allowed (§7.3).

### 6.6 Copying and exporting

| Command | Arguments | Effect |
| --- | --- | --- |
| `copy` | `headers`: boolean; `values`: `raw` or `formatted`, each column's `format.copy` (`raw` by default) when absent | `output` is `{ "tsv", "html", "markdown" }` of the selected cells |
| `export` | `format`; `columns`: `displayed` (default) or `all`; `rows`: `view` (default) or `table`; `target` | an `export` request (§8.2) of the view: the displayed columns in display order (with `all`, then the other columns of the view in view order) and their labels (`format.label`, or the name) as `headers`; for `xlsx`, the Excel codes of the columns' `format.number` and `format.date` as `numberFormats`, when one has a code. With `rows: table`, the request is of the plan `{}` (every row of the table, with the written values) and its columns are the table's: the displayed ones in display order, all of them when none is displayed. `unsupported` when the engine does not export the format |
| `save` | | a `save` request; `unsupported` when the engine does not save |

`copy` places the ranges as spreadsheets do: ranges with the same rows side by side, ranges with the same
columns one below the other (their rows merged where they overlap or touch), in display order and without
the cells between them; other combinations fail with `copy_layout`. The values of the cells MUST be in
`context.rows`. `raw` copies text forms (§2.4) and column names. `formatted` copies the text that the column's
`format.number` or `format.date` gives and its `format.label`: Intl's `NumberFormat` and `DateFormat` in the
context's `locale` (Intl's default without it), with decimals formatted from their exact digits, date patterns
such as `yyyy/MM/dd`, and `timestamptz` values moved to `format.date.timeZone`; a value that the format does not
cover, or a format that Intl refuses, gives the text form. The text depends on the Unicode CLDR data of the
core's Intl, so cores with the same data copy the same text. Null is the empty string.

- **TSV**: fields joined by tabs and rows by line feeds; a field with a tab, a line break or a quote is quoted
  with `"`, and its quotes are doubled. A last row of one empty field is followed by a line feed, as pasting
  reads the line break after the last row as the end of the text: an empty cell alone is `\n`.
- **HTML**: `<meta charset="utf-8"><table>`, one `<tr>` per row, `<th>` cells for the header and `<td>`
  cells otherwise; `&`, `<`, `>` and `"` are escaped and line breaks become `<br>`.
- **Markdown**: a header row (the column names, or empty cells without `headers`), a row of `---`, then the
  rows; `|` is escaped as `\|` and line breaks become `<br>`.

Pasting reads TSV the same way, with rows ending at `\r\n`, `\n` or `\r`, a field that starts with a quote
read as quoted until a quote followed by a tab, a line break or the end, and the line break after the last row
ending the text. It reads the first table of HTML: one row per `<tr>`, one cell per `<td>` or `<th>`, with
`colspan` and `rowspan` filled with empty cells, tags removed, `<br>` as a line break, entities decoded
(`&nbsp;` as a space) and runs of white space collapsed.

### 6.7 Commands of the core

The core applies these commands when data arrives; hosts and agents do not need them.

| Command | Arguments | Effect |
| --- | --- | --- |
| `view.update` | `hash`; `located`: `[{ "key", "row" }]`, with `row` null for keys not in the view | §5.4 |
| `history.push` | `updates`: `[{ "key", "column", "before", "after" }]` | records a write that succeeded (§7.4) |
| `history.undone`, `history.redone` | | moves the last step of `undo` onto `redo` (or back) after its write succeeded |
| `history.clear` | | empties the history |

## 7. Editing

### 7.1 Writable cells

A column is **writable** when the engine reports `write` and the column is a column of the table (not a
derived one) without `readOnly`, whose type is not `interval` or `binary`. A cell of a view is writable when
its column is and the view has no `aggregate`. Writes name cells by key (§7.2), so `history.undo` and
`history.redo` need writable columns only.

### 7.2 Writes

A `write` request (§8.2) names cells by row key and column name, with typed values (§2.2):

- A write is atomic: every update is applied, or none is and the request fails.
- An update may carry `previous`, the value it was made from; when the cell holds another value now, the
  write fails with `edit_conflict`.
- A write carries the revision its rows were read at; when the table has another revision, it fails with
  `revision_changed`.
- A write holds at most 100,000 updates.
- Values are checked as their column's type without losing digits; one that does not fit fails the write
  with `invalid_value`. Cells that are not writable fail it with `read_only`.

Engines keep written values apart from the source until they are saved, and every later request of every
client (rows, plans, summaries, find, export) sees them. Writes keep row IDs and the revision, and increment
the edits version.

Written values belong to the table that the handles share: every handle open on the same file (with the same read
options) sees them, and `vastgrid-duckdb` drops them when the last of those handles closes, so that the file opens
again as it is. A file that changes on disk opens as a new table with a new revision and no written values;
handles opened before follow it when the table has no written values, and otherwise keep reading, and writing, the
table as it was read, whose saving is then refused (`file_changed`, §7.6). A write to a table that is still
loading waits until it has loaded, and fails with `revision_changed` when its types changed meanwhile (§9). An
engine whose source holds a narrower range than §2.2 (DuckDB keeps the ends of the 64-bit range of nanosecond
timestamps for its infinities) fails the write with `invalid_value` for a value beyond it.

### 7.3 Reading typed text

Typed text becomes a value of the column's type by these rules. White space (Unicode `White_Space`) around
the text is removed first, except for strings. An empty text is null for every type.

| Type | Accepted | Value | Errors |
| --- | --- | --- | --- |
| `string` | well-formed Unicode text | the text as typed; a text of only white space is null | `unicode` |
| `integer`, `bigint` | `[+-]?[0-9]+` | the number, within the type's range | `integer` (a number with a fraction or an exponent), `range`, `number` |
| `decimal` | `[+-]?([0-9]+(\.[0-9]*)?\|\.[0-9]+)` | the value with exactly `scale` fraction digits | `scale` (more fraction digits than the scale, not counting trailing zeros), `precision` (more whole digits than `precision − scale`), `decimal` (an exponent), `number` |
| `float` | a number as above with an optional exponent; `inf` or `infinity` with an optional sign, or `nan`, in any letter case | the float rounded to its declared bits, with −0 read as 0 | `range` (rounding overflows to infinity), `number` |
| `boolean` | `true`, `false`, `1`, `0`, in any letter case | | `boolean` |
| `date` | year, month and day separated by `-`, `/` or `.`, naming a real day | `YYYY-MM-DD` | `date` |
| `time` | `H:MM`, `H:MM:SS` or `H:MM:SS.f` with 1 to 6 fraction digits | `HH:MM:SS`, with the fraction without trailing zeros | `time` |
| `timestamp` | a date, then optionally a space or `T` and a time with as many fraction digits as the unit keeps | §2.2; midnight without a time | `timestamp`, `range` (outside the signed 64-bit count) |
| `timestamptz` | a timestamp, then optionally `Z` or an offset `±HH`, `±HHMM` or `±HH:MM` | the instant in UTC (§2.2); without an offset, the time of day in the column's time zone (below), or UTC | `timestamp` |
| `uuid` | 32 hex digits, with or without the dashes of `8-4-4-4-12`, in any letter case | lowercase with dashes | `uuid` |
| `interval`, `binary` | nothing | | `type` |

With **digit grouping** (pasting), numbers whose whole digits are grouped by commas in threes (`1,234.5`) are
also read, without the commas. The text that an editor starts with for a value is its text form (§2.4), and
the empty string for null.

A `timestamptz` column whose `format.date` has a `timeZone` (an IANA name that Intl knows) reads text without an
offset as the time of day in that zone, as the grid shows it. A time of day that the zone's clocks skip is read
with the offset before the change (`2024-03-10 02:30` in `America/New_York` is `07:30` UTC), and one that they
repeat is the earlier instant, as Temporal's `compatible` disambiguation does. Its editor starts with the time of
day there and its offset (`2024-01-31 12:00:00+09` for `2024-01-31 03:00:00+00` in `Asia/Tokyo`, `+05:30` when
the offset has minutes), which reads back as the same instant; an offset with seconds (local mean time before
time zones) keeps the text form. Filters typed in the column menu read text in UTC.

For `float(32)`, rounding is IEEE 754 round-to-nearest, ties-to-even (JavaScript `Math.fround`): typed
`0.1` becomes `0.10000000149011612`. Subnormal values and underflow to zero follow that rule. Numeric
overflow is an error; explicit `inf`/`infinity` remains allowed. Engines and block writers validate the
resulting typed JSON instead of rounding it again. Row keys and writes use this same typed JSON contract.

### 7.4 Undo and redo

The history is the session's (§5.2). A **step** is one write that succeeded (a typed value, a clear, a paste
or a fill): `{ "updates": [{ "key", "column", "before", "after" }] }`.

- After the write of `edit.commit`, `edit.clear`, `edit.paste` or `edit.fill` succeeds, the core applies
  `history.push` with its updates (`before` is `previous`, `after` is `value`): the step goes onto `undo`,
  and `redo` is emptied.
- `history.undo` writes the `before` values of the last step of `undo`, each with `previous` set to `after`;
  after the write succeeds, the core applies `history.undone`, which moves the step onto `redo`.
  `history.redo` and `history.redone` do the same the other way.
- The history keeps at most 100 steps and 1,000,000 updates over both lists; the oldest steps of `undo` go
  first. A step larger than that on its own empties the history.
- Row-ID keys belong to one revision: when the revision changes, the history is emptied (§5.4).

### 7.5 Saving

`save` (§8.2) writes the written cells into the file the table was read from. For CSV and TSV files,
`vastgrid-duckdb` writes anew only the edited fields of the edited records and keeps every other byte (byte
order mark, header, other records and fields, quoting, delimiters, line breaks, encoding), in a temporary
file next to the original that it then renames over it. It refuses files that someone else changed since
they were read (`file_changed`) and files it cannot write back (`save_unsupported`); the file is then as it
was.

- Only cells whose written value differs from the file's are written: a cell written back to the file's value
  keeps its bytes. A value is written as text that the file is read back as: in the file's date and timestamp
  formats, otherwise as DuckDB writes it (`3.0` for a float), quoted when it holds a delimiter, a quote or a line
  break. An empty string fails the save with `save_unsupported`: the CSV reader treats even quoted empty fields
  as null, so the value would not survive a read. Null can be saved as an empty field. A failed save keeps both
  the original file and all pending edits. A value that the file's encoding cannot hold fails the save with `invalid_value`.
- `records` counts the records written anew. After a save, the file holds the written values: the table keeps
  its revision, row IDs and the session's history, its written cells are none, and the edits version is
  incremented (a `changed` event, §8.5), so that a later write compares `previous` with the saved value.
- The file is saved only where it was read, inside the folders the engine may read: a file that is now a link
  elsewhere fails with `not_allowed`. The new file keeps the file's mode, and no temporary file is left behind,
  also when the save fails or is cancelled.
- `vastgrid-duckdb` saves only when its host allows it (`saveFiles`), and `capabilities.save` is true for the CSV
  and TSV files that are not compressed. Files of other formats are never written: their `save` fails with
  `save_unsupported`.

### 7.6 Files that change on disk

Engines that read files follow the files of the tables that handles have open: the Node.js DuckDB engine watches
their folders, and checks the file again on `changes` and `open`. A file changes when its revision (its size,
modification time and first bytes) does; a save of the engine itself is not a change.

- A table without written values is read again: every handle open on it moves to the new table, which has a new
  revision, and gets a `changed` event (§8.5) once the new table's first rows can be read. Clients read `info`
  again, and the core applies §5.4: row-ID keys and the history belong to the old revision.
- A table with written values stays as it was read, so that they are not lost: its `TableInfo`, its `changed`
  event and `changes` carry `fileChanged: true`. Its handles read and write it as before, and `save` fails with
  `file_changed`. A file that is removed is the same, until it comes back.
- `reload` moves a handle to the file as it is now, with a new revision and without the written values, which
  stay with the other handles of the old table until the last one closes. When the file has not changed, it
  answers the handle's `TableInfo` and changes nothing.
- A write that waited for a table that its handles left fails with `revision_changed`.

## 8. Messages

[`messages.schema.json`](../packages/spec/schema/messages.schema.json) gives the form of every message.

### 8.1 Envelope

| Message | Form |
| --- | --- |
| Request | `{ "v": 2, "id": n, "op": name, …arguments }` |
| Response | `{ "v": 2, "id": n, "result": … }` |
| Error | `{ "v": 2, "id": n or null, "error": { "code", "message", "path"?, "reason"?, "details"? } }` |
| Event | `{ "v": 2, "event": name, … }` |

`id` is an integer from 0 to 2^53 − 1 that the client chooses, unique among its requests in flight; the
response carries it back. A message without a valid `id` (one that is not an object, or whose `id` is missing or
not such an integer) is answered with `invalid_request` and the `id` null, which no request has; only that error
has a null `id`. Messages hold no SQL, no paths of the server and no code.

Messages, with their plans, keys and values, hold names (of members) and strings of at most 1,000,000 code
points, nest at most 256 objects and lists (the message itself is the first), and have at most 1,000,000 items in
a list or members in an object. Errors follow these limits themselves, whatever the request holds: their
`message` has at most 1,000 code points and quotes names and values of the request shortened, and a `path` that
would be longer than a string may be (one to a name of 1,000,000 code points) is cut to the object that holds the
name. Paths are JSON Pointers (RFC 6901): `~` and `/` in names are written `~0` and `~1`.

A request that does not follow §8 is answered with `invalid_request`, with `path` (a JSON Pointer into the
request) and `reason`: `version` for a message whose `v` is not 2, `unknown_op` for an `op` that §8.2 does not
have, `limit` for one beyond a limit of §8, and `syntax` for anything else, members that the request does not
take included; a name beyond its limit fails with `limit` at the object that holds it. Clients check responses
and events in the same way; one that does not follow §8 is `invalid_response` for the client, which treats it as
an `internal` error.

### 8.2 Operations

| `op` | Arguments | Result |
| --- | --- | --- |
| `open` | `ref`: the host's name for what to open; `read`: `{ "sheet"?, "headerRow"?, "delimiter"?, "keepEmptyRows"?, "keepEmptyColumns"? }` | `TableInfo` |
| `info` | `table` | `TableInfo` |
| `rows` | `table`, `revision`, `plan`, `start`, `end`, `columns`; `textLimit`; `preview` | `{ "view", "start", "end", "rowIds", "block", "truncated"? }` |
| `summarize` | `table`, `revision`, `plan`, `ranges`: `[start, end)` pairs, `columns` | `{ "count", "numericCount", "sum", "min", "max", "average" }` |
| `find` | `table`, `revision`, `plan`, `text`, `columns`, `from`: `{ "row", "column" }`, `direction`: 1 or −1; `caseSensitive` | `{ "row", "column" }` or null |
| `locate` | `table`, `revision`, `plan`, `keys`: row keys; `rowKey`: a column name | `{ "rows": [position or null] }` |
| `write` | `table`, `revision`, `updates`: `[{ "key", "column", "value", "previous"? }]`; `rowKey` | `{ "updated", "edits" }` |
| `save` | `table` | `{ "records", "edits" }` |
| `export` | `table`, `revision`, `plan`, `format`; `target`, `columns`, `headers`, `numberFormats` | `{ "target", "rows", "data"? }` |
| `changes` | `table` | `{ "revision", "edits", "fileChanged"? }` |
| `reload` | `table` | `TableInfo` |
| `cancel` | `request`: an `id` | no response |
| `close` | `table` | `null` |

- `TableInfo` is `{ "table", "revision", "edits", "status", "progress", "rowCount", "readableRows",
  "columns", "capabilities", "format"?, "byteSize"?, "notes"?, "sheets"?, "sheet"?, "error"?, "fileChanged"? }`:
  `table` is an opaque id for later requests; `revision` a string or null; `edits` `{ "version", "cells" }`;
  `status` `loading`, `ready` or `error`; `progress` from 0 to 1 or null; `rowCount` null while the table loads;
  `readableRows` the rows that can be read now; `columns` §2.1; `capabilities` §4.10; `sheets`
  `[{ "name", "hidden"? }]` for workbooks; `fileChanged` true when the file changed on disk since the table,
  which has written values, was read (§7.6).
- For CSV and TSV files in `vastgrid-duckdb`, `read.headerRow` is the 1-based record holding column names
  (earlier records are skipped); `0` means no header, and omission keeps header detection. `read.delimiter`
  is tab or one printable ASCII character other than `"`; the default is comma for CSV and tab for TSV.
  Standard double quoting and doubled-quote escaping apply regardless of the sampled records. These options
  also apply when saving and reloading the file. Workbook options retain their workbook meanings.
- `rows` reads positions `[start, end)` of the plan's view: `columns` are names of the view's columns, at most
  1,000,000 rows and 1,000,000 cells. Positions beyond the view are left out: the answer's `end` is at most the
  view's row count, and a request whose `start` is at or beyond it is answered with no rows (`end` equal to
  `start`), since a client that reads a new view does not know its row count yet. `columns` may be empty, to
  learn a view whose columns the client does not know yet (those of a pivot, §4.6): the answer then has the
  view, the positions and the row IDs, and a block without columns. `view` is `{ "hash", "status",
  "rowCount", "rowCountExact", "readableRows", "columns", "edits", "partial"? }` (§9); `rowIds` lists the rows'
  row IDs, or is null for views without them; `block` holds the values (§8.4); `textLimit` is 1 to 1,000,000
  (default 2,000).
- `summarize` counts the cells of `ranges` × `columns` that are not blank (`count`, each cell once), and the
  numbers among them that are finite (`numericCount`), with their `sum`, `min`, `max` and `average` as floats
  (§2.2; a sum beyond the largest float is `"Infinity"`), null without numbers. At most 1,000 ranges. Engines
  MAY add in any order, MAY sum exact numbers exactly before the sum becomes a float (`vastgrid-js` answers
  `0.3` for `0.10 + 0.20`, where DuckDB's doubles give `0.30000000000000004`), and MAY answer a finite
  `average` when the sum is beyond the largest float.
- `find` searches the cells of the view row by row and, in a row, in the order of `columns` (at least one),
  from the cell after `from` (before it with −1), wrapping around at the ends and ending with `from` itself,
  for a value whose text form contains `text` (by `lower` unless `caseSensitive`, §3.4); null matches nothing,
  and an empty `text` finds nothing. `from.column` and the result's `column` are indexes into `columns`.
- The `columns` of `rows`, `summarize`, `find` and `export` name columns of the plan's view, and `rowKey` one of
  the table: a name that the view or the table does not have is `invalid_request` with the reason `syntax` and
  the `path` of the name (`/columns/1`, `/rowKey`). A name may repeat: `rows` and `export` give the column once
  for each time it is named, `find` searches it so, and `summarize` counts each cell once, as it does where
  ranges overlap.
- `locate` gives the positions in the plan's view of rows by key (`rowId`, or values of `rowKey`), null for
  keys that the view does not have. A value finds the values of `rowKey` equal to it by §3.1 (the key `"1.5"`
  finds the decimal(4, 2) `"1.50"`), and the first position in the view of the rows that have it. At most
  10,000 keys.
- `write` follows §7.2; `edits` is the table's new `{ "version", "cells" }`.
- `export` writes the view (§4.2) in `format` (`csv`, `tsv`, `parquet`, `json`, `xlsx`): `columns` are names
  (default all), `headers` replace their names in the header of CSV, TSV and xlsx, and `numberFormats` (one
  Excel format code or null per column) apply to xlsx; both have one item per column. An engine whose
  `capabilities.export.delivery` is `file` writes the file at `target` as the host resolves it and answers
  that `target`; without a `target`, it keeps the file where the host can serve it and answers a name for it as
  `target` (over HTTP, a `GET` of `exports/<target>` next to the requests' URL, §8.8). One whose delivery is
  `data` answers `data`, the file's bytes, as a block is carried (§8.8), and `target` null. `rows` is the view's
  row count. The rows are those of the whole view, in its order, with the written values (§7.2); a file is
  complete or not there: a failed or cancelled export leaves nothing behind. A `format` that
  `capabilities.export.formats` does not list is `invalid_request` at `/format` with the reason `syntax`, and a
  `target` sent to an engine whose delivery is `data` is `not_allowed`.

  | Format | Written as | Limits |
  | --- | --- | --- |
  | `csv`, `tsv` | a header line of `headers`, then the rows; values as their text, quoted when they need it | none |
  | `parquet` | the columns under their names, with their types | none |
  | `json` | an array of objects by column name; numbers as JSON numbers, with all their digits (floats as their text forms, §2.4, and those that are not finite as text: `"nan"`, `"inf"`); other values but booleans as text | none |
  | `xlsx` | one sheet: a bold, frozen header row of `headers`; numbers, booleans and dates as such cells, with `numberFormats` or a date format; text always as text, never a formula; numbers that a double cannot hold exactly as text | 1,048,575 rows and 16,384 columns (`export_too_large`), 32,767 characters a cell (cut), 4 GB |

### 8.3 Identity

Views have no handles. A request names the table, its revision and the plan. Engines MAY keep the views they
made, by table, revision, edits version and plan hash, and forget them at any time: a forgotten view is made
again from the same request. When the table's revision is not the request's, the request fails with
`revision_changed`, and the client reads `info` again.

### 8.4 Blocks

A block is an Apache Arrow IPC stream with one schema and one record batch (none for a block without
columns, whose positions the answer gives), without compression:

- one field per requested column, in order, named by the column, nullable, of the Arrow type of §2.1:
  `boolean` Bool; `integer` Int32; `bigint` Int64; `decimal` Decimal128(precision, scale); `float` Float32
  or Float64 by `bits`; `string` Utf8; `date` Date32; `time` Time64 in microseconds; `timestamp` Timestamp in
  its unit without a time zone; `timestamptz` Timestamp in microseconds with the time zone `UTC`; `interval`
  Interval MonthDayNano; `uuid` FixedSizeBinary(16), with the field metadata `ARROW:extension:name` set to
  `arrow.uuid`; `binary` Binary;
- the rows `start` to `end`, in order.

Writers MUST validate the ranges and text of §2.2 before packing values. A value that does not fit MUST
fail rather than wrap, overflow to infinity or acquire replacement characters. `encodeBlock` throws a
`BlockValueError` (a `TypeError`) with `reason: "type"` and a block-relative JSON Pointer
`/rows/{offset}/{columnIndex}`. A source value that fails this check is returned by the DuckDB engine as
`invalid_value` with the same path and reason; no partial block is returned. Write validation identifies
the request value at `/updates/{index}/value`.

Readers MUST accept Utf8, LargeUtf8 and Utf8View for strings, and MUST keep a U+FEFF that starts a string
(Appendix B). Strings longer than `textLimit` code points are cut to that length, and `truncated` maps the
column's name to the offsets, from `start`, of its cut values; the core shows that they go on.

### 8.5 Events

| `event` | Members | When |
| --- | --- | --- |
| `changed` | `table`, `revision`, `edits`, `fileChanged`? | the table's data changed (§7.2 writes included), or its file changed on disk (§7.6) |
| `progress` | `table`, `status`, `progress`, `readableRows`, `rowCount` | while a table loads |
| `view` | `table`, `hash`, `status`, `readableRows`, `rowCount`, `rowCountExact` | while a view builds (§9) |

Transports that cannot carry events poll `info`, `changes` and `rows` instead.

### 8.6 Cancellation

A client cancels a request in flight with `cancel`, or by the transport's own means (aborting an HTTP
request). An engine that stops the work answers the request with `cancelled`; it MAY also finish the work and
answer it. `cancel` itself has no response.

### 8.7 Errors

| `code` | When | HTTP |
| --- | --- | ---: |
| `invalid_request` | a message that does not follow §8, with `path` and `reason` (`syntax`, `unknown_op`, `version`, `limit`) | 400 |
| `invalid_plan` | §4.7, with `path` and `reason` | 400 |
| `table_not_found` | the table is closed or unknown | 404 |
| `not_ready` | the table is still loading and the request needs all of it | 409 |
| `revision_changed` | §7.2, §8.3 | 409 |
| `edit_conflict` | §7.2 | 409 |
| `file_changed` | §7.5, §7.6 | 409 |
| `read_only` | §7.2 | 403 |
| `not_allowed` | a `ref` or `target` outside what the host allows | 403 |
| `invalid_value` | §7.2, or a source value that cannot be represented in a block (§8.4) | 422 |
| `too_many_columns` | §4.6 | 422 |
| `save_unsupported` | §7.5 | 422 |
| `load_failed` | the table could not be read | 422 |
| `export_too_large` | a result that does not fit the export format (xlsx: 1,048,575 rows and 16,384 columns) | 413 |
| `cancelled` | §8.6 | 499 |
| `internal` | anything else | 500 |

Errors MAY carry `details`, an object; `invalid_request` and `invalid_plan` carry `path` and `reason`. An
operation that the engine does not offer (`summarize`, `find`, `locate` or `export` that its capabilities
leave out, §4.10) is `invalid_request` at `/op` with the reason `unknown_op`, as an operation that §8.2 does not
name is.

### 8.8 Transports

A message is the same on every transport; only blocks (and `export`'s `data`) differ:

| Encoding | A block is | Used by |
| --- | --- | --- |
| text | `{ "base64": "…" }`, the bytes in base64 (RFC 4648, with padding) | MCP App tool calls, text channels |
| structured | `{ "bytes": Uint8Array }` | function calls, Web Workers (the buffer transferred), VS Code webviews and notebook comms that carry buffers |
| attached | `{ "attached": m }`, the m bytes following the JSON | HTTP |

Over **HTTP**, a request is a `POST` with `content-type: application/json` and the request as its body. The
response is `application/json` with the text encoding, except that a client that sends
`accept: application/vnd.vastgrid.v2+arrow` MAY receive the response of `rows` and `export` as that type:
4 bytes with the length n of the JSON response (little-endian), the n bytes of the JSON response in UTF-8
with its block attached, then the block's bytes. Errors are `application/json`, with the HTTP status of
§8.7. Events go out as Server-Sent Events at a URL the host chooses.

An **MCP App** calls a tool of its server with the request in the tool's arguments; the tool result's
`structuredContent` is the response, with the text encoding. Tool calls carry no events: the server gives them in
the answers of a tool that the App calls again and again. [mcp-app.md](mcp-app.md) describes `vastgrid-mcp`'s
tools (`vastgrid_message`, `grid_sync`).

A **VS Code webview** and its extension carry the messages with `postMessage`, blocks as bytes (the structured
encoding): [vscode.md](vscode.md) describes `vastgrid-vscode`.

`vastgrid-spec` gives the three encodings (`toTextEncoding`, `toStructuredEncoding`, `frameAttached` and
`readAttached`) and the checks of §8 (`checkRequest`, `checkResponse` and `checkEvent`).

## 9. Progressive views

A `rows` request with `preview: true` MAY be answered before the whole view is made:

- `view.status` is `building`. `readableRows` positions from the start of the view can be read, in their
  final order. `rowCount` is the number of rows when `rowCountExact` is true, and otherwise the number known
  so far (a lower bound).
- The answer holds positions up to `readableRows`. The client asks again, or follows `view` events (§8.5),
  for the rest, and reads its cached blocks again when the view becomes `ready`.
- Engines choose how to get there: the first rows of a sort by a top-N query, then the full order, then (for
  large views) a sorted copy for faster reads. Clients see only `status`, `readableRows`, `rowCount` and the
  speed.

A table that is loading (`status: "loading"`) answers `rows` with the plan `{}` for its readable rows: that
view is `building`, with the readable rows as its `rowCount` (not exact), until the table has loaded, and
`view` events (§8.5) tell when it grows and when it is `ready`. Engines that report `partialViews` MAY also
answer other plans over the readable rows, with `view.partial: true`. Such a view is the plan's view of the
readable rows as if they were the whole table: `where` keeps those of them that pass it, groups and measures are
of them only, and `rowCount` is the view's rows, not exact; it is `building`, and its positions need not be those
of the view of the whole table. When the table has loaded, the view is made again over every row, and a `view`
event tells that it is `ready`; the client then reads its rows again. Requests that read every row of the view
(`summarize`, `find`, `export`) and writes wait until the table has loaded, and fail with `revision_changed` when
its revision changed meanwhile. A table whose whole file has other columns than its readable rows had gets another
revision when it has loaded, with a `changed` event.

The Node.js DuckDB engine implements these previews for large sorts, sharing the saved result between equivalent
requests. A non-preview read waits for a sorted view to finish; it also surfaces a failed background build to
clients without events. Its file-loading views support only `{}` (`partialViews: false`). The React store defers
other plans until the file is ready, and waits for a full view when moving an active row by key requires `locate`.
See [the engine's limits and cleanup](../packages/duckdb-engine/README.md#limits-and-cleanup). `vastgrid-js` opens
a text file larger than its `previewBytes` (4 MiB) with the rows that end in its first bytes, typed by what they
hold, and answers `{}` over them (`partialViews: false`) until the file is read whole.

## 10. Conformance

The corpus in [`packages/spec/conformance`](../packages/spec/conformance) has three parts, each a folder of JSON
files:

| Folder | Schema | A case gives | Runs on |
| --- | --- | --- | --- |
| `plans` | [`conformance.schema.json`](../packages/spec/schema/conformance.schema.json) | a table, a plan and what to read; the rows or the error expected | every engine |
| `commands` | [`commands.schema.json`](../packages/spec/schema/commands.schema.json) | a state, a context and commands; the state, requests and output expected, or the error | every core |
| `messages` | [`messages-corpus.schema.json`](../packages/spec/schema/messages-corpus.schema.json) | messages, and whether each follows §8 or the error it gets | every engine and client |

A plan case:

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

- A plan case runs one plan on one table and reads `read` (`start`, `end` and `columns`; by default the
  whole view and all its columns). `expect` gives `rowCount` and `rows` (typed JSON, §2.2), and optionally
  `columns` (names and types) and `rowIds`; or an `error` (`code`, and `reason` for `invalid_plan`).
  `tolerance` allows a relative difference for floats (§3.8). The row IDs of a case table are its row
  positions.
- A command case applies its `commands` in order, each to the state the one before gave, and compares the
  result of the last one: each of `document`, `session`, `requests` and `output` that `expect` gives is
  compared as JSON, or `expect` gives the `error` (`code`, `reason` and `path`, and `details` when it is
  given) that the last command fails with; every command before it succeeds. `state` and `context` are
  objects or the names of `states` and `contexts` of the file, and an object may name one to `extends`,
  taking the members it does not give from it. An item `{ "context": … }` among the commands changes the
  context of the commands after it (as when the core has read another view).
- A message case checks a request with `checkRequest`, a response to an operation with `checkResponse`, or
  an event with `checkEvent`, and `expect` gives `{ "valid": true }` or the `error` (`code`, `reason` and
  `path`).
- Expected results are written from this document. Plan cases are checked against DuckDB 2.0 through
  `vastgrid-sql`; a case on which DuckDB and this document disagree is a mistake in one of them, settled
  before the case is added.
- Every engine runs the plan cases, and every core runs the command cases. Beyond them, engines are compared
  with each other on generated tables and plans.

## 11. Versions and changes

This document specifies version `0.2`. Patch versions add
functions, measures, members and capabilities without changing the meaning of plans that were valid before,
and changes of meaning need a new minor version (0.3) while the major version is 0. A change to sections 2–4
comes with conformance cases checked against DuckDB, and the JS engine follows in the same change.

## 12. Open questions

[proposals.md](proposals.md) proposes an answer to each.

- Native nested types (lists, structs, maps) instead of their text, and measures that give them, such as a
  `histogram` that gives the counts of all the bins in one value.
- Collations and folding (reading order of Japanese, full-width and half-width forms) as capabilities.
- Dates and timestamps outside the years 0001 to 9999 (DuckDB has dates from 5877642 BC), and the forms
  that would write them (§2.2).

## Appendix A. From 0.1

| 0.1 | 0.2 |
| --- | --- |
| `TableSource.info` | `open`, `info` |
| `ViewQuery.sort` (column indexes) | `plan.sort` (names) |
| `filters`, `where` (`FilterNode`), `search` | `plan.where` (expressions, `search`) |
| `{ type: "values", values, exclude }` | `in`, with `coalesce` and `not`; blanks with `is_blank` |
| `{ type: "compare" }`, `between`, `text`, `blank` | comparisons; `contains`, `starts_with`, `ends_with` (with `lower` when letter case does not matter); `is_blank` |
| `formulas` (the formula language) | `plan.derive`, written as formulas (§4.11) |
| `group`, `pivot`, the totals row | `plan.aggregate` and `pivot`; totals are `aggregate` without keys |
| `GroupedSource` (sorting and filtering groups) | `having` and `sort` of an aggregated plan |
| `columnStats` | plans with `count`, `count_distinct`, `min`, `max`, `avg`, `stddev` and `quantile`; the histogram is `bin` in `derive`, then `count` in `aggregate` grouped by it |
| `distinctValues` | `aggregate` by the column with `count`, `sort`, then `rows` of the first n |
| `aggregate` (the selection summary) | `summarize` |
| `find` | `find` |
| `exportView` | `export` |
| `updateCells`, `saveEdits` | `write`, `save` |
| `subscribe`, `revision` | `changes`, events |
| view handles, `viewInfo` | the plan hash (§8.3), `view` in `rows` |
| `CellValue` (JSON, exact numbers as strings) | typed values: Arrow blocks and typed JSON |
| `RowBlock.rowIds` (positions) | `rowIds`, and row keys `{ rowId }` |
| `RowSelection` (`include`, `exclude` with `query`) | `checked` (`include`, `exclude` with `where`) |
| `GridState` (version 1) | the document (version 2) and the session |

0.1's filters migrate into expressions as follows (§5.6), where `c` is `{ "col": name }` and a literal takes
the column's type: digits of an exact column as a `bigint` or `decimal` literal, text of a date or time
column as a literal of that type.

| 0.1 filter | 0.2 expression |
| --- | --- |
| `{ type: "values", values }` | `in(c, values…)` for the values that are not null, `or`-ed with `is_blank(c)` when `values` holds null |
| `{ type: "values", values, exclude: true }` | `not(coalesce(e, false))`, where `e` is the expression above |
| `{ type: "compare", op, value }` | `op(c, value)` (`eq`, `ne`, `lt`, `le`, `gt`, `ge`) |
| `{ type: "between", min, max }` | `and(ge(c, min), le(c, max))`, or the one side that is given |
| `{ type: "text", op: "contains", value }` | `contains(lower(text(c)), lower(value))`; with `caseSensitive`, without `lower` |
| `{ type: "text", op: "startsWith" / "endsWith" / "equals" }` | `starts_with`, `ends_with` and `eq` in the same way |
| `{ type: "text", op: "notContains" / "notEquals" }` | `not(coalesce(e, false))` of `contains` or `eq` |
| `{ type: "blank", blank }` | `is_blank(c)`, or `not(is_blank(c))` |
| `{ type: "and" / "or", filters }` | `and` / `or` of the migrated filters; a group of one filter is that filter |

## Appendix B. DuckDB behavior this specification was checked against

DuckDB 2.0 through `@duckdb/node-api` 2.0.0-r.1, on 2026-10-27 (first checked with DuckDB 1.5 on 2026-10-24):

| Query | Result |
| --- | --- |
| `'NaN'::DOUBLE = 'NaN'::DOUBLE`, `'NaN'::DOUBLE > 'Infinity'::DOUBLE`, `-0.0::DOUBLE = 0.0::DOUBLE` | true, true, true |
| −Infinity, −1, 1, Infinity, NaN and NULL, ordered ascending and descending with `NULLS LAST` | −Infinity, −1, 1, Infinity, NaN, NULL; and NaN, Infinity, 1, −1, −Infinity, NULL |
| `1/0`, `0::DOUBLE/0`, `1 % 0` | Infinity, NaN, an error (NULL in `TRY()`; DuckDB 1.5: NULL) |
| `9223372036854775807::BIGINT + 1`, and the same in `TRY()` | an error, NULL |
| `sqrt(-1)`, `ln(0)`, `ln(-1)` | NULL (DuckDB 1.5: errors) |
| `exp(1000)`, `power(-8, 1/3)`, `power(0, -1)` | Infinity, NaN, Infinity |
| the types of `DECIMAL(10,2) + DECIMAL(5,3)`, of `*` and `/` on them, of `BIGINT + DECIMAL(3,1)`, `DECIMAL(3,1) % INTEGER` and `INTEGER / INTEGER` | DECIMAL(12,3), DECIMAL(15,5), DOUBLE, DECIMAL(21,1), DECIMAL(11,1), DOUBLE |
| the types of `sum(BIGINT)`, `sum(DECIMAL(10,2))` and `avg(DECIMAL(10,2))` | HUGEINT, DECIMAL(38,2), DOUBLE |
| `sum` and `avg` of `DECIMAL(38,4)` values whose sum has more than 38 digits | errors (DuckDB 1.5 gave the sum): `vastgrid-sql` sums the digits of wide decimals as a HUGEINT |
| `stddev_samp` of 1.7e308 and −1.7e308 | NaN (DuckDB 1.5: an error); `vastgrid-sql` gives null, as the JS engine does |
| `sum`, `min`, `max` and `avg` of NaN, 1 and Infinity | NaN, 1, NaN, NaN (0.2 leaves the values that are not finite out, §3.8) |
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
| `round(9223372036854775807::BIGINT, -1)`, `round(2147483647::INTEGER, -1)` | errors, null in `TRY()` (DuckDB 1.5 wrapped around to `-9223372036854775800` and `-2147483646`), so `vastgrid-sql` rounds integers in their own type (§3.6) |
| `TRY(sum(x))` | refused (`aggregates are not allowed inside the TRY expression`), so measures use `TRY_CAST` |
| `CAST(0.5::DECIMAL(1,1) AS VARCHAR)`, `CAST(-0.10::DECIMAL(2,2) AS VARCHAR)` | `.5`, `-.10`: decimals without whole digits lose the 0 of §2.4, which `vastgrid-sql` puts back (`textSql`) |
| `COPY (…) TO … (FORMAT csv)` of `0.5::DECIMAL(1,1)`; `(FORMAT json, ARRAY true)` of a column of `'NaN'::DOUBLE`, of `0.1::FLOAT`, of `12.50::DECIMAL(10,2)` | `.5`; `NaN` (not JSON), `0.10000000149011612`, `12.5`: `vastgrid-duckdb` selects such decimals with `textSql` for CSV and TSV, and writes JSON from the rows itself (`writeJson` of `vastgrid-spec/export`), as `vastgrid-js` does (§8.2) |
| `greatest(NULL, 0)`, `left('abc', NULL)` | 0, NULL: `greatest` leaves nulls out, so the counts of `left`, `right` and `substr` are not bounded with it (§3.6) |
| `INTERVAL '1 month -1 day' = INTERVAL '29 days'`, `INTERVAL '1 month' = INTERVAL '30 days'` | true, true: intervals compare by their length (DuckDB 1.5: false, true, §3.1) |
| `read_csv` with `null_padding=true` of a file with a line break in quotes | an error unless `parallel=false` (DuckDB 1.5 read it), and in one thread a load of 735 MB takes 3.4 s against 0.9 s in parallel without `null_padding`. The engines read such a file without `null_padding` when `sniff_csv` finds the same dialect, skipped lines, header and columns with and without it, and in one thread otherwise, or when a record has other fields than the header (`Expected Number of Columns`) |
| Preparing a read of 256 rows through the engine's views and its text cuts, then running it | about 2.6 ms (DuckDB 1.5: 1.2 ms); parsing alone takes 0.45 ms (0.04 ms). Run again as a prepared statement, it takes 1.2 ms: `vastgrid-duckdb` keeps the statements of its block reads prepared on each connection |

Two behaviors of `@duckdb/node-api` 2.0.0-r.1 (and 1.5.6-r.1) matter to engines built on it:

- It reads text with a `TextDecoder` that drops a U+FEFF at the start of a value: `SELECT chr(65279) || 'a'` reads
  as `"a"` in JavaScript, while its `length` is 2. Engines read such strings another way (the conformance tests
  of `vastgrid-sql` read strings with a character in front).
- It binds JavaScript numbers without a fraction as `BIGINT`, so binding `1e20` fails with
  `bigint out of int64 range`. `vastgrid-sql` binds floats as text (`floatParam`) and casts them.

`@uwdata/flechette` 2.6.0 decodes Utf8 values with a `TextDecoder` that drops a U+FEFF at the start of a
value in the same way. `vastgrid-spec`'s block reader decodes Utf8 and LargeUtf8 values from their bytes
with `ignoreBOM: true` instead (§8.4).
