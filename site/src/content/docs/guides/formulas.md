---
title: Formulas
description: Columns computed per row with a formula, the language and its functions, and formulas from code.
---

A formula column is computed for each row from other columns of the same row, for example `qty * price`. The
grid compiles the formula into an expression of the plan's `derive`, and the engine computes it over the whole
table, next to the data. So a formula column sorts, filters, groups, totals and exports like any other column, on
a table of any size. Formulas work row by row: they do not refer to other rows or cells.

Engines that compute them report `capabilities.plan.derive`. The memory engine and the DuckDB engine both do, with
the same results.

## The Formulas menu

The toolbar's **Formulas** menu lists each formula column with its name and formula, then a row for a new one:
"Column name", "Formula" and Add. Editing a row and choosing Apply changes its formula or its name; Remove
removes the column, and with it the formula columns, sorts, filters and groups that use it.

A formula may use the table's columns and the formula columns before it. One that does not compile is not
applied: the menu says why and selects the characters at fault. Formula columns are not writable; they follow the
cells they read when those are written.

## The language

- **Columns**: `price`, or in brackets when the name has spaces or other characters, or is a word of the language:
  `[unit price]`, `[and]`. Inside brackets, `]]` is a `]`.
- **Numbers** stay exact: `12` is an integer, `1.50` a decimal with two places, and only a number with an exponent
  (`1.5e3`) is a float. `0.1 + 0.2` is exactly `0.3`; a division gives a float.
- **Text** in single or double quotes, the quote doubled inside: `'it''s'`. Then `TRUE`, `FALSE` and `NULL`.
- **Literals of a type**: `DATE '2024-01-31'`, `TIMESTAMP '2024-01-31 12:00:00'`, `FLOAT 'nan'`, `DATE NULL`.
- **Calls**, in any letter case: `ROUND(price * 1.1, 0)`, `if(qty > 10, 'bulk', 'single')`.

Operators, from the lowest precedence:

| Operators | Meaning |
| --- | --- |
| `OR` | Either is true |
| `AND` | Both are true |
| `NOT` | Not |
| `=` (`==`), `<>` (`!=`), `<`, `<=`, `>`, `>=` | Comparisons |
| `&` | Joins as text: `first & ' ' & last` |
| `+`, `-` | Add, subtract |
| `*`, `/`, `%` | Multiply, divide, remainder |
| `-` before a value | Negative |

A function with a null argument gives null, except the logic, `COALESCE`, `IS_NULL`, `IS_BLANK`, `IF` (a null
condition takes the third argument), `LEAST`, `GREATEST` and `&`, where null counts as empty text. A computation
that fails for a row, such as a division by zero or `SQRT(-1)`, gives null for that row instead of an error.

`CONTAINS`, `STARTS_WITH`, `ENDS_WITH` and `=` respect letter case. To ignore it, lower both sides:
`CONTAINS(LOWER(name), 'tokyo')`.

## Functions

| Kind | Functions |
| --- | --- |
| Logic | `IF(cond, a, b)`, `COALESCE`, `IN(x, 'a', 'b', …)`, `IS_NULL`, `IS_BLANK`, `LEAST`, `GREATEST`, `NOT` |
| Numbers | `ABS`, `ROUND(x, digits)` (digits from −18 to 18, halves away from zero), `FLOOR`, `CEIL`, `BIN(x, width)` (the lower bound of x's bin: `BIN(-0.1, 0.25)` is −0.25), `SQRT`, `EXP`, `LN`, `LOG10`, `POWER`, `SIGN`, `TO_NUMBER(text)` |
| Text | `LENGTH`, `LOWER`, `UPPER`, `TRIM`, `LEFT`, `RIGHT`, `SUBSTR(s, start, n)` (from 1), `REPLACE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `TEXT(x)`, `CONCAT` |
| Dates | `TO_DATE(text)`, `TO_TIMESTAMP(text)`, `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`, `ISODOW` (Monday is 1), `DATE_DIFF_DAYS(start, end)`, `ADD_DAYS(d, n)` |

Each function takes the types in
[§4.4](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#44-functions) of the specification; another
mixture is a type error, shown in the menu. Where a function takes a date, text in quotes that reads as one is a
date (`YEAR('2024-03-01')`, `day > '2024-01-01'`), and a date where a timestamp is taken is its midnight.

0.1's names work too: `CEILING`, `LEN`, `MID`, `STARTSWITH`, `ENDSWITH`, `ADDDAYS`, `ISBLANK`, `WEEKDAY`,
`DAYS(end, start)`, `MIN` and `MAX` of values, `IF` with two arguments, `VALUE`, `DATE` and `DATETIME`. The grid
shows them with the names above.

## From code

Formula columns are `derive.add`, `derive.update` and `derive.remove` commands, whose expressions
`compileFormula` of `vastgrid-spec` makes from a formula (`npm install vastgrid-spec`):

```ts
import { compileFormula, FormulaError, formulaText } from "vastgrid-spec";

const columns = store.getSnapshot().table?.columns ?? [];
try {
  const { expr } = compileFormula("qty * [unit price]", columns);
  await store.dispatch({ command: "derive.add", name: "amount", expr });
} catch (error) {
  // reason: syntax, unknown_column, unknown_function, arity, type, literal, limit or unsupported
  if (error instanceof FormulaError) console.log(error.reason, error.start, error.end);
}

formulaText({ fn: "mul", args: [{ col: "qty" }, { col: "unit price" }] }); // "qty * [unit price]"
```

| Command | Arguments |
| --- | --- |
| `derive.add` | `name`, `expr`, and `before`: a formula column to put it before |
| `derive.update` | `name`, a new `expr`, and `rename` |
| `derive.remove` | `name`; also removes what uses the column |

`compileFormula(text, columns, options)` takes the columns the formula may use; its options are those of the
plan check, which `planOptions(capabilities)` gives for an engine. `formulaText` writes any expression back as a
formula. The document keeps the expressions, not the formulas ([State](/guides/state/)), and a formula column
in a document can also be written by hand:

```ts
import type { GridDocument } from "vastgrid";

const document: GridDocument = {
  kind: "vastgrid/document",
  version: 2,
  plan: { derive: [{ name: "amount", expr: { fn: "mul", args: [{ col: "qty" }, { col: "price" }] } }] },
};
```

## Limits and differences from 0.1

- A formula has at most 100,000 characters and 64 levels of nesting, and a plan at most 32 formula columns.
- 0.1 computed every number as a 64-bit float. 0.2 keeps exact numbers exact, so `ROUND(0.285, 2)` is `0.29`, not
  `0.28`, and a decimal of `1.50` times 2 is `3.00`.
- Text forms follow the specification: `TEXT(TRUE)` is `true`, a float of five is `5.0`, `TEXT(0.00001)` is
  `0.00001`.
- `LEFT('abc', NULL)` is null, not empty text; `VALUE('1_000')` and `DATE` of `2024-1-5` text are null.
- `ROUND(x, 400)` and `NULL = NULL` are refused as type errors.

The full list is in [§4.11](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#411-formulas).
