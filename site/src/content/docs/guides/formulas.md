---
title: Formula columns
description: Columns computed per row by an expression, which sort, filter, summarize and export like the others.
---

A formula column is computed for each row from the other columns of the same row, for example
`qty * price`. The source evaluates it, next to the data, so it works on tables of any size: it sorts,
filters (also in condition trees), shows statistics and selection summaries, and is exported like a
column of the file. Formulas are per row only; there are no references to other rows or cells.

| Source | Formula columns |
| --- | --- |
| `RemoteSource` + `vastgrid-duckdb` | Yes. Translated into SQL and run by DuckDB. |
| `ArraySource` | Yes. Evaluated in JavaScript, with the same results. |
| `BrowserSource` (`vastgrid-browser`) | Not yet (`capabilities.formulas` is false). |

Sources tell the grid with `capabilities.formulas`. Without it, the menu items are not shown and the grid
sends no formulas; formulas kept in a state wait (unshown) until a source that evaluates them is used.

## In the grid

The column menu has **Add formula column…**; on a formula column it also has **Edit formula…** and
**Delete formula column**. The editor checks the name and the formula as they are typed and shows what is
wrong (an unknown column, text multiplied by a number, a missing parenthesis, …) below the field, with
the type of the result when it is right. It lists the columns and functions to insert. A new column
appears after the column whose menu added it; sorts, filters and the column's settings follow it by name
when its formula changes. A column that other formulas use cannot be deleted or renamed until they change.

Formulas that cannot be evaluated, for example because the file no longer has a column they use, are not
shown as columns. They stay in the grid's formulas (and in its state), and the **Columns** panel lists them
under "Formula columns with errors" to fix them.

## From the app

```tsx
const [formulas, setFormulas] = useState<FormulaColumn[]>([
  { name: "total", expression: "qty * price" },
  { name: "with tax", expression: "ROUND(total * 1.1, 2)" },
]);

<DataGrid source={source} formulas={formulas} onFormulasChange={setFormulas} />;
```

- `formulas` is applied on start and whenever a different value is passed; `onFormulasChange` reports
  the user's changes. The handle has `getFormulas()` and `setFormulas()`.
- Formula `i` is schema column `info.columns.length + i` (after the table's columns) for as long as every
  formula before it can be evaluated. `controller.schema` lists the columns the grid shows, with
  `expression` on formula columns.
- `getState()` keeps the formulas in `formulas` (also the ones with errors), and `schema` lists their names,
  so that saved sorts and filters on formula columns apply again by name.
- The grid's query (`onQueryChange`, `getQuery()`) carries the formulas it sends to the source as
  `formulas`; `setQuery()` ignores them, since formulas are set with `formulas`.

## The language

### Columns and literals

- Columns by name: `price`, `単価`. Names with spaces or other signs go in brackets, `[unit price]`
  (`]]` is a `]`). Names that are words of the language (`and`, `not`, `null`, …) also go in brackets.
- Numbers: `12`, `1.5`, `.5`, `2e3`. Text in single or double quotes: `'it''s'`, `"a"` (a quote is
  written twice). `TRUE`, `FALSE` and `NULL` (blank).
- Formulas can use other formula columns by name; a formula cannot use itself, also not through others.

### Operators

From the lowest precedence to the highest:

| Operator | Meaning |
| --- | --- |
| `OR` | Either is true. |
| `AND` | Both are true. |
| `NOT` | Not true. |
| `=` (`==`), `<>` (`!=`), `<`, `<=`, `>`, `>=` | Comparisons of numbers, texts (by character code), booleans, dates and timestamps. |
| `&` | Joins texts; other values are turned into text, blanks into empty text. |
| `+`, `-` | Addition, subtraction. |
| `*`, `/`, `%` | Multiplication, division, remainder (with the sign of the dividend). |
| `-` | Negative sign. |

Parentheses group. A date or timestamp compared with text written in the formula reads the text as one:
`day >= '2024-01-01'`, `seen < '2024-06-30 12:00'`.

### Types and blanks

Values are numbers (64-bit floating point), text, booleans (`TRUE`/`FALSE`), dates and timestamps (a date
and a time without a time zone; timestamps with a zone count in UTC). Integer and decimal columns are
read as numbers, so digits beyond about 15 are rounded in arithmetic; `TEXT(column)` keeps their exact
digits. Columns of other types (UUIDs, lists, times, …) are read as their text.

Types are checked before anything runs: `price * name` (a number times text) is an error, and so is
`IF(ok, 1, 'a')`. `TEXT`, `VALUE`, `DATE` and `DATETIME` convert.

Most operations on a blank give a blank. `AND` and `OR` follow SQL (`FALSE AND NULL` is false), `&` and
`CONCAT` treat a blank as empty text, `IF` takes its second branch when the condition is blank, and
comparisons with a blank are blank (so the row does not match a filter on them). Division by zero, results
that are not finite numbers (out of range), square roots and logarithms of numbers they do not take, and
text that `VALUE`, `DATE` or `DATETIME` cannot read give a blank instead of an error.

### Functions

Function names are not case-sensitive.

| Function | Result |
| --- | --- |
| `ABS(x)`, `SIGN(x)` | The absolute value; -1, 0 or 1. |
| `ROUND(x)`, `ROUND(x, digits)` | Rounds half away from zero; `digits` may be negative (`ROUND(1234, -2)` is 1200). |
| `FLOOR(x)`, `CEILING(x)` (`CEIL`) | Down or up to a whole number. |
| `SQRT(x)`, `POWER(x, y)`, `EXP(x)`, `LN(x)`, `LOG10(x)` | Roots, powers and logarithms. |
| `MOD(x, y)` | The remainder, as `%`. |
| `MIN(a, b, …)`, `MAX(a, b, …)` | The smallest or largest value that is not blank (numbers, texts, dates or timestamps). |
| `LEN(t)` (`LENGTH`) | The number of characters. |
| `LOWER(t)`, `UPPER(t)`, `TRIM(t)` | Lower or upper case; without spaces at both ends. |
| `LEFT(t, n)`, `RIGHT(t, n)` | The first or last `n` characters. |
| `MID(t, start, n)` | `n` characters from the `start`th (1 is the first; less than 1 counts as 1). |
| `REPLACE(t, find, with)` | Every `find` replaced by `with`. |
| `CONTAINS(t, s)`, `STARTSWITH(t, s)`, `ENDSWITH(t, s)` | Whether `t` contains, starts or ends with `s` (case-sensitive). |
| `CONCAT(a, b, …)` | The values joined as text. |
| `TEXT(x)` | The value as text: numbers in their shortest form (`1.5`, `3`, `1e-05`), booleans as `TRUE`/`FALSE`, dates as `2024-01-31`. |
| `VALUE(t)` | The number in a text (`" 1_000.5 "` is 1000.5), or blank. |
| `DATE(x)`, `DATETIME(x)` | A date or timestamp from text (`YYYY-MM-DD`, optionally with ` HH:MM`, `:SS` and a fraction), a date or a timestamp. |
| `YEAR(d)`, `MONTH(d)`, `DAY(d)`, `WEEKDAY(d)` | Parts of a date or timestamp; `WEEKDAY` is 1 (Monday) to 7 (Sunday). |
| `HOUR(ts)`, `MINUTE(ts)`, `SECOND(ts)` | Parts of a timestamp. |
| `DAYS(end, start)` | Days from `start` to `end` (dates, or the dates of timestamps). |
| `ADDDAYS(d, n)` | The date or timestamp `n` days later. |
| `IF(condition, then, else)` | `then` when the condition is true, otherwise `else` (blank when left out). |
| `COALESCE(a, b, …)` | The first value that is not blank. |
| `ISBLANK(x)` | Whether the value is blank (or empty text). |

Examples:

```text
qty * price
ROUND(total * 1.1, 2)
IF(status = 'open' AND due < '2024-07-01', 'late', '')
UPPER(LEFT(region, 3)) & '-' & TEXT(id)
DAYS(shipped, ordered)
COALESCE(phone, email, '(none)')
```

### Limits

A grid has at most 32 formula columns (`MAX_FORMULAS`). A formula has at most 2,000 characters
(`MAX_FORMULA_LENGTH`) and 64 nested levels (`MAX_FORMULA_DEPTH`), and at most 1,000 operations once the
formula columns it uses are put in place (`MAX_FORMULA_NODES`). Names have at most 256 characters.

## Safety

Formulas are a language of their own, not JavaScript or SQL. They are parsed and checked in
`vastgrid-core`; nothing runs a formula's text as code. The DuckDB engine translates the checked formula
into SQL in which columns are quoted identifiers, every literal is a parameter, and only the listed
functions appear, each as a fixed SQL expression; a formula such as `1); DROP TABLE x` is a syntax error,
and `read_csv('…')` is an unknown function. The server checks every formula it receives again, with the
limits above.

## Same results everywhere

`ArraySource` and the DuckDB engine give the same values for the same data; the test suite compares them
for every function. Two exceptions: `LOWER` and `UPPER` may differ for a few letters with special case
rules (such as `ß`), and `EXP`, `LN`, `LOG10` and `POWER` may differ in the last digit, since each runtime
has its own math library. Sums in selection summaries and statistics may differ in the last digit, as
for any floating-point column.

## Custom sources

A source that evaluates formulas reports `capabilities.formulas` and handles `ViewQuery.formulas`:

```ts
import { formulaEvaluator, formulaSchema, queryFormulas } from "vastgrid-core";

const compiled = queryFormulas(info.columns, query); // throws invalid_request for an invalid formula
const columns = formulaSchema(info.columns, compiled); // the view's columns
const evaluate = compiled.map((formula) => formulaEvaluator(formula.tree!));
// value of formula i for a row: evaluate[i]((column) => valueOf(row, column))
```

A SQL engine can translate `CompiledFormula.tree` (a `FormulaExpression`) node by node, as
`vastgrid-duckdb` does in `formula.ts`.
